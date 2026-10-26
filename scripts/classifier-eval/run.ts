/**
 * Live benchmark runner: sends production-shaped classifier requests to
 * candidate models under the durable budget ledger.
 *
 *   node scripts/classifier-eval/run.ts --models decisions:typesafe/jev-1.14,chat:google/gemini-2.5-flash-lite,heuristic \
 *     --split development --out .project/analyses/classifier-eval/run-1 [--dry-run]
 *   node scripts/classifier-eval/run.ts --models chat:openai/gpt-6-luna --variants base,granular+tree-luna \
 *     --tasks milestone-status,milestone-boundary --split development --out <dir>
 *
 * Every paid call reserves its worst case in the ledger before dispatch and
 * settles from OpenRouter billing after it. Exit codes: 0 complete, 1 failure,
 * 2 usage error, 3 budget stop or refused dry run, 130 interrupted.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FetchFn } from "../fetch.ts";
import {
	type AnswerOptions,
	answer,
	type Candidate,
	chatCandidate,
	type DraftObservation,
	decisionsCandidate,
	type EvalRegistry,
	HEURISTIC,
	planRequest,
	type RequestPlan,
	safeMessage,
} from "./adapters.ts";
import {
	type Billing,
	createBilling,
	type KeyUsage,
	loadRouteTable,
	mergeRouteTables,
	ROUTE_PRICES_URL,
	type RouteTable,
	type Settlement,
	worstCaseUsd,
} from "./billing.ts";
import { BudgetError, BudgetLedger, type BudgetSnapshot } from "./budget.ts";
import {
	addCarried,
	generateStructure,
	parseVariant,
	planVariant,
	STRUCTURE_MAX_OUTPUT_TOKENS,
	STRUCTURE_MODEL,
	type StructureObservation,
	structureRequest,
	type Variant,
	type VariantResult,
	variantCandidate,
} from "./milestone-variants.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalCase, EvalObservation, EvalTask, PreparedCase } from "./types.ts";

const TASKS: readonly EvalTask[] = [
	"intent",
	"supersession",
	"milestone-status",
	"milestone-boundary",
	"retirement-check",
];
const DEFAULT_LEDGER = ".project/analyses/classifier-eval/budget-ledger.jsonl";
const MAX_PENDING_PER_WORKER = 8;

export type RunRegistry = EvalRegistry &
	Pick<ModelRegistry, "getModelOfType" | "getModelsOfType" | "getApiKeyForProvider">;

/** Everything the runner touches outside its own process; tests replace it. */
export interface Deps {
	loadCases(path: string | undefined): Promise<readonly EvalCase[]>;
	createRegistry(options: { storePath: string; offline: boolean }): Promise<RunRegistry>;
	loadRoutePrices(): RouteTable;
	fetch: FetchFn;
	git(): { sha: string; dirty: boolean };
	stdout(text: string): void;
	stderr(text: string): void;
	billingDelaysMs?: readonly number[];
	handleSignals: boolean;
	/** Stops the run like Ctrl+C when it aborts. */
	interrupt?: AbortSignal;
}

interface Options {
	models: string[];
	uncatalogued: string[];
	split: "development" | "holdout" | "all";
	tasks: readonly EvalTask[];
	variants: Variant[];
	repetitions: number;
	concurrency: number;
	timeoutMs: number;
	dryRun: boolean;
	ledger: string;
	cap: number;
	out?: string;
	resume?: string;
	cases?: string;
	rates?: string;
}

class UsageError extends Error {}

const USAGE = `usage: node scripts/classifier-eval/run.ts --models <spec,...> (--out <dir> | --resume <dir> | --dry-run) [options]

  --models <a,b>          required, no default set. Each entry is one of:
                            decisions:<id> | chat:<id> | heuristic   (ids are OpenRouter ids)
                            all-decisions        every catalogued decision model with a positive price,
                                                 plus researched ones missing from the catalog
                            shortlist:<file>     one entry per line, # starts a comment
  --uncatalogued <id:promptUsdPerM:contextTokens>
                          decision model missing from the catalog; repeatable, implies a --models entry
  --rates <file>          route price table (same format as route-prices.json) whose entries replace
                          the committed ones; the catalog price still sets the floor
  --split <s>             development (or dev) | holdout | all (default all)
  --tasks <t,...>         ${TASKS.join(" | ")} (default all)
  --variants <v,...>      milestone request variants, each model runs once per variant as <model>#<variant>:
                            base | instructions | granular | tree-heuristic | tree-luna, or parts joined
                            with + (granular+tree-luna); tree-luna adds one ${STRUCTURE_MODEL} structure call per case
  --repetitions <n>       default 1
  --concurrency <n>       default 4
  --timeout-ms <n>        per request, default 60000
  --ledger <path>         default ${DEFAULT_LEDGER}
  --cap <usd>             ledger cap, default 25
  --out <dir>             new run directory (must not exist)
  --resume <dir>          continue a run directory, skipping finished work
  --dry-run               plan and price only; no network, nothing written
  --cases <file>          module exporting CASES (default ./cases.ts)
`;

function integer(value: string, name: string, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > max)
		throw new UsageError(`--${name} must be an integer from 1 to ${max}`);
	return number;
}

function parseOptions(argv: readonly string[]): Options | "help" {
	let parsed: ReturnType<typeof parseArgs>["values"];
	try {
		parsed = parseArgs({
			args: [...argv],
			strict: true,
			allowPositionals: false,
			options: {
				models: { type: "string" },
				uncatalogued: { type: "string", multiple: true },
				split: { type: "string", default: "all" },
				tasks: { type: "string" },
				variants: { type: "string" },
				repetitions: { type: "string", default: "1" },
				concurrency: { type: "string", default: "4" },
				"timeout-ms": { type: "string", default: "60000" },
				ledger: { type: "string", default: DEFAULT_LEDGER },
				cap: { type: "string", default: "25" },
				out: { type: "string" },
				resume: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				cases: { type: "string" },
				rates: { type: "string" },
				help: { type: "boolean", default: false },
			},
		}).values;
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	if (parsed.help) return "help";
	const split = parsed.split === "dev" ? "development" : String(parsed.split);
	if (split !== "development" && split !== "holdout" && split !== "all")
		throw new UsageError("--split must be development, holdout or all");
	const tasks =
		parsed.tasks === undefined
			? TASKS
			: String(parsed.tasks)
					.split(",")
					.map((task) => {
						if (!TASKS.includes(task as EvalTask)) throw new UsageError(`unknown task ${task}`);
						return task as EvalTask;
					});
	const variants: Variant[] = [];
	for (const spec of parsed.variants === undefined ? [] : String(parsed.variants).split(",")) {
		try {
			const variant = parseVariant(spec);
			if (!variants.some((known) => known.id === variant.id)) variants.push(variant);
		} catch (error) {
			throw new UsageError(error instanceof Error ? error.message : String(error));
		}
	}
	const cap = Number(parsed.cap);
	if (!Number.isFinite(cap) || cap <= 0) throw new UsageError("--cap must be a positive number");
	const uncatalogued = (parsed.uncatalogued as string[] | undefined) ?? [];
	const models = String(parsed.models ?? "")
		.split(",")
		.map((model) => model.trim())
		.filter(Boolean);
	if (models.length === 0 && uncatalogued.length === 0)
		throw new UsageError("--models is required");
	const dryRun = parsed["dry-run"] === true;
	const { out, resume } = parsed as { out?: string; resume?: string };
	if (!dryRun && (out === undefined) === (resume === undefined))
		throw new UsageError("a live run needs exactly one of --out and --resume");
	return {
		models,
		uncatalogued,
		split,
		tasks,
		variants,
		repetitions: integer(String(parsed.repetitions), "repetitions"),
		concurrency: integer(String(parsed.concurrency), "concurrency", 64),
		timeoutMs: integer(String(parsed["timeout-ms"]), "timeout-ms"),
		dryRun,
		ledger: String(parsed.ledger),
		cap,
		...(out !== undefined && { out }),
		...(resume !== undefined && { resume }),
		...(parsed.cases !== undefined && { cases: String(parsed.cases) }),
		...(parsed.rates !== undefined && { rates: String(parsed.rates) }),
	};
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const UNCATALOGUED = /^(.+\/[^:\s]+(?::[^:\s]+)*):(\d+(?:\.\d+)?(?:e[+-]?\d+)?):(\d+)$/iu;
const ALL_DECISIONS = "all-decisions";
const SHORTLIST = "shortlist:";

/** A model left out of the run, and whether the user named it. */
interface Exclusion {
	label: string;
	reason: string;
	explicit: boolean;
}

interface Resolution {
	candidates: Candidate[];
	excluded: Exclusion[];
}

/** Replaces each `shortlist:<file>` with the specs listed in the file. */
function expandSpecs(specs: readonly string[]): string[] {
	return specs.flatMap((spec) => {
		if (!spec.startsWith(SHORTLIST)) return [spec];
		const path = spec.slice(SHORTLIST.length);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			throw new UsageError(`cannot read shortlist ${path}`);
		}
		const listed = text
			.split("\n")
			.map((line) => line.replace(/#.*/u, "").trim())
			.filter(Boolean);
		if (listed.some((entry) => entry.startsWith(SHORTLIST)))
			throw new UsageError(`${path}: a shortlist cannot include another`);
		return listed;
	});
}

/** A decision model absent from the catalog, cloned from a catalogued template. */
function uncataloguedModel(
	template: ClassifierModel<ClassifierApi>,
	id: string,
	rates: { input: number; output: number },
	contextWindow: number,
): ClassifierModel<ClassifierApi> {
	return {
		...template,
		id,
		name: id,
		cost: { ...rates, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
	};
}

function resolveCandidates(
	specs: readonly string[],
	options: Options,
	registry: RunRegistry,
	table: RouteTable,
): Resolution {
	const template = registry
		.getModelsOfType("classifier", "openrouter")
		.find((model) => model.api === "typesafe-system-one");
	const catalog = new Map(
		registry.getModelsOfType("classifier", "openrouter").map((m) => [m.id, m]),
	);
	const flagged = new Map<string, ClassifierModel<ClassifierApi>>();
	for (const spec of options.uncatalogued) {
		const match = UNCATALOGUED.exec(spec);
		if (!match)
			throw new UsageError(`bad --uncatalogued ${spec}: expected id:promptUsdPerM:contextTokens`);
		const [, id = "", price = "", context = ""] = match;
		if (!template) throw new UsageError("no OpenRouter decision model to use as a template");
		if (catalog.has(id)) throw new UsageError(`${id} is in the catalog; drop --uncatalogued`);
		flagged.set(
			id,
			uncataloguedModel(template, id, { input: Number(price), output: 0 }, Number(context)),
		);
	}

	/** The route table's researched model for `id`, when its context is known. */
	const researched = (id: string) => {
		const entry = table.models[id];
		return template && entry?.kind === "decisions" && entry.contextTokens
			? uncataloguedModel(
					template,
					id,
					{ input: entry.promptUsdPerM, output: entry.completionUsdPerM },
					entry.contextTokens,
				)
			: undefined;
	};

	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	const excluded: Exclusion[] = [];
	const add = (candidate: Candidate, explicit: boolean, listAll = false) => {
		if (seen.has(candidate.label)) return;
		seen.add(candidate.label);
		if (candidate.adapter === "heuristic") {
			candidates.push(candidate);
			return;
		}
		const { refusal, free } = candidate.pricing;
		const reason =
			refusal ?? (listAll && free ? "free variant; name it explicitly to include it" : undefined);
		if (reason === undefined) candidates.push(candidate);
		else excluded.push({ label: candidate.label, reason, explicit });
	};

	for (const spec of [...specs, ...[...flagged.keys()].map((id) => `decisions:${id}`)]) {
		const match = /^(decisions|chat):(?:openrouter\/)?(.+)$/u.exec(spec);
		if (spec === "heuristic") {
			add(HEURISTIC, true);
		} else if (spec === ALL_DECISIONS) {
			for (const model of [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
				if (model.id.startsWith("~"))
					excluded.push({
						label: `decisions:${model.id}`,
						reason: "dynamic alias of a listed model with no route data",
						explicit: false,
					});
				else add(decisionsCandidate(model, table), false, true);
			}
			for (const [id, entry] of Object.entries(table.models)) {
				if (entry.kind !== "decisions" || catalog.has(id) || flagged.has(id)) continue;
				const model = researched(id);
				if (model) add(decisionsCandidate(model, table, true), false, true);
				else
					excluded.push({
						label: `decisions:${id}`,
						reason: "researched route lists no context limit",
						explicit: false,
					});
			}
		} else if (match?.[1] === "decisions") {
			const id = match[2] ?? "";
			const model = flagged.get(id) ?? catalog.get(id) ?? researched(id);
			if (!model)
				throw new UsageError(
					`model ${spec} is not in the catalog or the route table with a known context; pass --uncatalogued ${id}:<promptUsdPerM>:<contextTokens>`,
				);
			add(decisionsCandidate(model, table, !catalog.has(id)), true);
		} else if (match?.[1] === "chat") {
			const model = registry.getModelOfType("chat", "openrouter", match[2] ?? "");
			if (!model) throw new UsageError(`model ${spec} is not in the OpenRouter catalog`);
			add(chatCandidate(model, table), true);
		} else {
			throw new UsageError(
				`model ${spec} must be decisions:<id>, chat:<id>, heuristic, ${ALL_DECISIONS} or ${SHORTLIST}<file>`,
			);
		}
	}
	return { candidates, excluded };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlannedCall {
	prepared: PreparedCase;
	/** Labelled `<model>#<variant>` for a variant. */
	candidate: Candidate;
	variant?: Variant;
	repetition: number;
	plan: RequestPlan;
	reservationUsd: number;
	run(options: AnswerOptions): Promise<VariantResult>;
}

/** A model to run, once per variant when variants are selected. */
interface Contender {
	source: Candidate;
	/** The source candidate, relabelled for its variant. */
	candidate: Candidate;
	variant?: Variant;
}

function expandVariants(
	candidates: readonly Candidate[],
	variants: readonly Variant[],
): Contender[] {
	return variants.length === 0
		? candidates.map((candidate) => ({ source: candidate, candidate }))
		: candidates.flatMap((source) =>
				variants.map((variant) => ({
					source,
					candidate: variantCandidate(source, variant),
					variant,
				})),
			);
}

const reservationOf = (candidate: Candidate, plan: RequestPlan) =>
	plan.kind === "request" && candidate.adapter !== "heuristic"
		? worstCaseUsd(plan.bodyBytes, plan.maxOutputTokens, candidate.pricing.rates)
		: 0;

const workKey = (model: string, caseId: string, repetition: number) =>
	JSON.stringify([model, caseId, repetition]);

/** Calls in repetition-major order, so a partial run covers every model evenly. */
function planCalls(
	cases: readonly PreparedCase[],
	contenders: readonly Contender[],
	repetitions: number,
	completed: ReadonlySet<string>,
	structures: ReadonlyMap<string, StructureObservation>,
): { calls: PlannedCall[]; skipped: number } {
	const calls: PlannedCall[] = [];
	let skipped = 0;
	for (let repetition = 0; repetition < repetitions; repetition++)
		for (const prepared of cases)
			for (const { source, candidate, variant } of contenders) {
				if (completed.has(workKey(candidate.label, prepared.id, repetition))) {
					skipped++;
					continue;
				}
				const planned = variant ? planVariant(prepared, source, variant, structures) : undefined;
				const plan = planRequest(planned?.prepared ?? prepared, candidate);
				const reservationUsd = reservationOf(candidate, plan);
				if (plan.kind === "request" && !(reservationUsd > 0))
					throw new Error(
						`${candidate.label} on ${prepared.id} planned a request without a positive reservation`,
					);
				calls.push({
					prepared,
					candidate,
					...(variant && { variant }),
					repetition,
					plan,
					reservationUsd,
					run: planned?.run ?? ((options) => answer(prepared, candidate, options)),
				});
			}
	return { calls, skipped };
}

/** The chat model that writes structures, relabelled so its reservations never collide with a plain run of it. */
function structureCandidate(
	registry: RunRegistry,
	table: RouteTable,
): Extract<Candidate, { adapter: "chat" }> {
	const model = registry.getModelOfType("chat", "openrouter", STRUCTURE_MODEL);
	if (!model)
		throw new UsageError(
			`structure model chat:${STRUCTURE_MODEL} is not in the OpenRouter catalog`,
		);
	const candidate = chatCandidate(model, table);
	if (candidate.adapter !== "chat" || candidate.pricing.refusal !== undefined)
		throw new UsageError(
			`structure model chat:${STRUCTURE_MODEL} has no safe price: ${candidate.adapter === "chat" ? candidate.pricing.refusal : "not a chat model"}`,
		);
	return { ...candidate, label: `${candidate.label}#structure` };
}

/** The `tree-luna` structure calls still missing: one per case, shared by every model and repetition. */
function planStructureCalls(
	calls: readonly PlannedCall[],
	generator: Extract<Candidate, { adapter: "chat" }> | undefined,
	structures: ReadonlyMap<string, StructureObservation>,
): PlannedCall[] {
	const wanted = new Map(
		calls
			.filter((call) => call.variant?.tree === "luna")
			.map((call) => [call.prepared.id, call.prepared]),
	);
	if (wanted.size === 0) return [];
	if (!generator) throw new Error("no structure model was resolved");
	return [...wanted.values()]
		.filter((prepared) => !structures.get(prepared.id)?.structure)
		.map((prepared) => {
			const { bodyBytes } = structureRequest(prepared, generator);
			const plan: RequestPlan = {
				kind: "request",
				bodyBytes,
				maxOutputTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
			};
			return {
				prepared,
				candidate: generator,
				repetition: 0,
				plan,
				reservationUsd: reservationOf(generator, plan),
				run: (options) => generateStructure(prepared, generator, options),
			};
		});
}

function dryRunReport(
	calls: readonly PlannedCall[],
	skipped: number,
	budget: BudgetSnapshot,
	options: Options,
	resolution: Resolution,
	candidates: readonly Candidate[],
): { text: string; total: number; refused: boolean } {
	const rows = candidates.map((candidate) => {
		const own = calls.filter((call) => call.candidate.label === candidate.label);
		const rates =
			candidate.adapter === "heuristic"
				? ""
				: `, rates ${candidate.pricing.rates.promptUsdPerM}/${candidate.pricing.rates.completionUsdPerM} USD/M${candidate.pricing.routeData ? "" : " (catalog only)"}`;
		return {
			label: candidate.label,
			live: own.filter((call) => call.plan.kind === "request").length,
			local: own.filter((call) => call.plan.kind === "local").length,
			unsupported: own.filter((call) => call.plan.kind === "unsupported").length,
			usd: own.reduce((sum, call) => sum + call.reservationUsd, 0),
			rates,
		};
	});
	const total = rows.reduce((sum, row) => sum + row.usd, 0);
	const refused = resolution.excluded.some((entry) => entry.explicit);
	const lines = [
		`dry run: ${options.repetitions} repetition(s), split ${options.split}, tasks ${options.tasks.join(",")}`,
		...rows.map(
			(row) =>
				`  ${row.label}: ${row.live} live, ${row.local} local, ${row.unsupported} unsupported${row.rates}, reserve ${row.usd.toFixed(6)} USD`,
		),
		...resolution.excluded.map(
			(entry) => `  ${entry.explicit ? "REFUSED" : "excluded"} ${entry.label}: ${entry.reason}`,
		),
		`planned live calls: ${rows.reduce((sum, row) => sum + row.live, 0)} (already finished: ${skipped})`,
		`summed reservations: ${total.toFixed(6)} USD`,
		`ledger ${options.ledger}: cap ${budget.limitUsd}, spent ${budget.spentUsd}, held ${budget.heldUsd}, remaining ${budget.remainingUsd}`,
		refused
			? "REFUSED: a named model has no safe price; a live run would not start"
			: total > budget.remainingUsd
				? "REFUSED: summed reservations exceed the remaining budget"
				: "OK: summed reservations fit the remaining budget",
	];
	return { text: `${lines.join("\n")}\n`, total, refused };
}

function ledgerSnapshot(path: string, cap: number): BudgetSnapshot {
	if (!existsSync(path)) return { limitUsd: cap, spentUsd: 0, heldUsd: 0, remainingUsd: cap };
	const ledger = BudgetLedger.open(path, cap);
	try {
		return ledger.snapshot();
	} finally {
		ledger.close();
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Execution {
	calls: readonly PlannedCall[];
	ledger: BudgetLedger;
	billing: Billing;
	registry: EvalRegistry;
	fetch: FetchFn;
	timeoutMs: number;
	concurrency: number;
	signal: AbortSignal;
	sessionId: string;
	secrets: readonly string[];
	write(observation: EvalObservation): void;
}

interface Outcome {
	counts: Record<EvalObservation["status"], number>;
	/** Calls cut short by an interrupt: unrecorded, so a resume repeats them. */
	interrupted: number;
	stopped?: string;
	failure?: unknown;
}

async function execute(run: Execution): Promise<Outcome> {
	const outcome: Outcome = {
		counts: { ok: 0, error: 0, unsupported: 0 },
		interrupted: 0,
	};
	const pending = new Set<Promise<void>>();
	let next = 0;

	const halt = (reason: string) => {
		outcome.stopped ??= reason;
	};
	const record = (draft: DraftObservation, settlement: Settlement, bound: number) => {
		run.write({ ...draft, ...settlement, costBoundUsd: bound });
		outcome.counts[draft.status]++;
	};

	async function settle(call: PlannedCall, reservationId: string, result: VariantResult) {
		const settlement = addCarried(
			await run.billing.settle(result.evidence, run.signal),
			result.carried,
		);
		try {
			run.ledger.settle(reservationId, settlement.costUsd);
		} catch (error) {
			if (error instanceof BudgetError) halt(`${error.code}: ${error.message}`);
			else outcome.failure ??= error;
		}
		if (run.signal.aborted && result.observation.status === "error") outcome.interrupted++;
		else
			record(result.observation, settlement, call.reservationUsd + (result.carried?.boundUsd ?? 0));
	}

	async function worker() {
		while (!outcome.stopped && !outcome.failure && !run.signal.aborted) {
			while (pending.size >= run.concurrency * MAX_PENDING_PER_WORKER) await Promise.race(pending);
			const call = run.calls[next++];
			if (!call) return;
			const options = {
				registry: run.registry,
				repetition: call.repetition,
				timeoutMs: run.timeoutMs,
				signal: run.signal,
				fetch: run.fetch,
				secrets: run.secrets,
			};
			if (call.plan.kind !== "request") {
				const local = await call.run(options);
				record(local.observation, { costUsd: 0, costSource: "local" }, 0);
				continue;
			}
			const reservationId = `${run.sessionId}/${call.candidate.label}/${call.prepared.id}/${call.repetition}`;
			try {
				run.ledger.reserve(reservationId, call.reservationUsd);
			} catch (error) {
				if (!(error instanceof BudgetError)) throw error;
				halt(`${error.code}: ${error.message}`);
				return;
			}
			const result = await call.run(options);
			const settling: Promise<void> = settle(call, reservationId, result).finally(() => {
				pending.delete(settling);
			});
			pending.add(settling);
		}
	}

	await Promise.all(
		Array.from({ length: run.concurrency }, () =>
			worker().catch((error) => {
				outcome.failure ??= error;
			}),
		),
	);
	await Promise.all(pending);
	if (run.signal.aborted) halt("interrupted");
	return outcome;
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

interface ModelMeta {
	label: string;
	adapter: Candidate["adapter"];
	variant?: string;
	uncatalogued?: true;
	/** The effective rates: the higher of the catalog and the route table. */
	promptUsdPerM?: number;
	completionUsdPerM?: number;
	/** Whether the route table lists the model; false means the catalog price alone. */
	routeData?: boolean;
	free?: true;
	contextWindow?: number;
}

interface SessionMeta {
	id: string;
	startedAt: string;
	endedAt?: string;
	models: ModelMeta[];
	excluded: Array<Pick<Exclusion, "label" | "reason">>;
	split: Options["split"];
	tasks: readonly EvalTask[];
	variants?: string[];
	repetitions: number;
	concurrency: number;
	keyUsageBefore?: KeyUsage | { error: string };
	keyUsageAfter?: KeyUsage | { error: string };
	counts?: Outcome["counts"];
	/** Outcomes of the `tree-luna` structure calls, which are logged in structures.jsonl. */
	structureCounts?: Outcome["counts"];
	interrupted?: number;
	stopped?: string;
	ledgerAfter?: BudgetSnapshot;
}

interface RunMeta {
	runId: string;
	createdAt: string;
	gitSha: string;
	gitDirty: boolean;
	casesSha256: string;
	caseCount: number;
	ledgerPath: string;
	capUsd: number;
	routePrices: Pick<RouteTable, "retrievedAt" | "source">;
	models: ModelMeta[];
	sessions: SessionMeta[];
}

function modelMeta({ candidate, variant }: Contender): ModelMeta {
	if (candidate.adapter === "heuristic") return { label: candidate.label, adapter: "heuristic" };
	return {
		label: candidate.label,
		adapter: candidate.adapter,
		...(variant && { variant: variant.id }),
		...(candidate.adapter === "decisions" &&
			candidate.uncatalogued && { uncatalogued: true as const }),
		promptUsdPerM: candidate.pricing.rates.promptUsdPerM,
		completionUsdPerM: candidate.pricing.rates.completionUsdPerM,
		routeData: candidate.pricing.routeData,
		...(candidate.pricing.free && { free: true as const }),
		contextWindow: candidate.model.contextWindow,
	};
}

function writeJson(path: string, value: unknown) {
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temp, path);
}

function readObservations(path: string): EvalObservation[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line, index) => {
			try {
				return JSON.parse(line) as EvalObservation;
			} catch {
				throw new Error(`${path} line ${index + 1} is not valid JSON; repair it before resuming`);
			}
		});
}

/** Each recorded observation finishes its unit of work; analysis keeps one per key. */
const finishedKeys = (observations: readonly EvalObservation[]) =>
	new Set(observations.map((o) => workKey(o.model, o.caseId, o.repetition)));

function openLog(path: string) {
	const fd = openSync(path, "a");
	return {
		write(observation: EvalObservation) {
			writeSync(fd, `${JSON.stringify(observation)}\n`);
			fsyncSync(fd);
		},
		close: () => closeSync(fd),
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const usageOf = async (billing: Billing, secrets: readonly string[], signal?: AbortSignal) =>
	billing.keyUsage(signal).catch((error) => ({ error: safeMessage(error, secrets) }));

/** Runs the CLI against `deps` and resolves to the process exit code. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
	try {
		const options = parseOptions(argv);
		if (options === "help") {
			deps.stdout(USAGE);
			return 0;
		}
		return await runBenchmark(options, deps);
	} catch (error) {
		if (error instanceof UsageError) {
			deps.stderr(`${error.message}\n\n${USAGE}`);
			return 2;
		}
		deps.stderr(`failed: ${safeMessage(error)}\n`);
		return 1;
	}
}

async function runBenchmark(options: Options, deps: Deps): Promise<number> {
	const allCases = await deps.loadCases(options.cases);
	const prepared = allCases
		.filter(
			(fixture) =>
				(options.split === "all" || fixture.split === options.split) &&
				options.tasks.includes(fixture.task),
		)
		.map(prepareCase);
	if (prepared.length === 0) throw new UsageError("no cases match --split and --tasks");
	if (options.variants.length > 0 && prepared.some((fixture) => fixture.input.type !== "milestone"))
		throw new UsageError(
			"--variants applies to milestone cases only; pass --tasks milestone-status,milestone-boundary",
		);

	const outDir = resolve(options.resume ?? options.out ?? ".");
	const scratch = mkdtempSync(join(tmpdir(), "classifier-eval-"));
	try {
		let table = deps.loadRoutePrices();
		if (options.rates) {
			try {
				table = mergeRouteTables(table, loadRouteTable(options.rates));
			} catch (error) {
				throw new UsageError(`--rates: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const registry = await deps.createRegistry({
			storePath: join(scratch, "models-store.json"),
			offline: options.dryRun,
		});
		const resolution = resolveCandidates(expandSpecs(options.models), options, registry, table);
		if (
			options.variants.length > 0 &&
			resolution.candidates.some((candidate) => candidate.adapter === "heuristic")
		)
			throw new UsageError("the heuristic has no milestone variants");
		const contenders = expandVariants(resolution.candidates, options.variants);
		const existing = options.resume || (options.dryRun && options.out);
		const completed = finishedKeys(
			existing ? readObservations(join(outDir, "observations.jsonl")) : [],
		);
		const structures = new Map<string, StructureObservation>(
			(existing
				? (readObservations(join(outDir, "structures.jsonl")) as StructureObservation[])
				: []
			)
				.filter((entry) => entry.status === "ok" && entry.structure)
				.map((entry) => [entry.caseId, entry]),
		);
		const { calls, skipped } = planCalls(
			prepared,
			contenders,
			options.repetitions,
			completed,
			structures,
		);
		const generator = options.variants.some((variant) => variant.tree === "luna")
			? structureCandidate(registry, table)
			: undefined;
		const structureCalls = planStructureCalls(calls, generator, structures);
		if (options.dryRun) {
			const budget = ledgerSnapshot(options.ledger, options.cap);
			const report = dryRunReport(
				[...structureCalls, ...calls],
				skipped,
				budget,
				options,
				resolution,
				[
					...(generator && structureCalls.length > 0 ? [generator] : []),
					...contenders.map(({ candidate }) => candidate),
				],
			);
			deps.stdout(report.text);
			return report.refused || report.total > budget.remainingUsd ? 3 : 0;
		}
		const refused = resolution.excluded.filter((entry) => entry.explicit);
		if (refused.length > 0)
			throw new UsageError(
				`refused before any request: ${refused.map((entry) => `${entry.label} (${entry.reason})`).join("; ")}`,
			);
		if (resolution.candidates.length === 0) throw new UsageError("no model is left to run");
		if (options.resume) {
			if (!existsSync(join(outDir, "run.json")))
				throw new UsageError(`${outDir} has no run.json to resume`);
		} else {
			if (existsSync(outDir))
				throw new UsageError(`${outDir} already exists; use --resume or a new --out`);
			mkdirSync(dirname(outDir), { recursive: true });
			mkdirSync(outDir);
		}
		return await runLive({
			options,
			deps,
			registry,
			resolution,
			contenders,
			table,
			calls,
			structureCalls,
			structures,
			outDir,
			casesSha256: createHash("sha256").update(JSON.stringify(allCases)).digest("hex"),
			caseCount: allCases.length,
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

interface LiveRun {
	options: Options;
	deps: Deps;
	registry: RunRegistry;
	resolution: Resolution;
	contenders: readonly Contender[];
	table: RouteTable;
	calls: readonly PlannedCall[];
	structureCalls: readonly PlannedCall[];
	/** Generated structures by case id; the structure stage fills it before the calls that use it. */
	structures: Map<string, StructureObservation>;
	outDir: string;
	casesSha256: string;
	caseCount: number;
}

function newRunMeta(live: LiveRun, git: { sha: string; dirty: boolean }): RunMeta {
	const stamp = new Date().toISOString();
	return {
		runId: `run-${stamp.replaceAll(":", "-")}-${randomBytes(2).toString("hex")}`,
		createdAt: stamp,
		gitSha: git.sha,
		gitDirty: git.dirty,
		casesSha256: live.casesSha256,
		caseCount: live.caseCount,
		ledgerPath: live.options.ledger,
		capUsd: live.options.cap,
		routePrices: {
			retrievedAt: live.table.retrievedAt,
			source: live.table.source,
		},
		models: [],
		sessions: [],
	};
}

async function runLive(live: LiveRun): Promise<number> {
	const { options, deps, registry, resolution, calls, structureCalls, outDir } = live;
	const runMetaPath = join(outDir, "run.json");
	const billing = createBilling({
		getApiKey: () => registry.getApiKeyForProvider("openrouter"),
		fetch: deps.fetch,
		...(deps.billingDelaysMs && { delaysMs: deps.billingDelaysMs }),
	});
	const apiKey = await registry.getApiKeyForProvider("openrouter");
	if ([...structureCalls, ...calls].some((call) => call.plan.kind === "request") && !apiKey)
		throw new Error("no OpenRouter API key is configured");
	const secrets = apiKey ? [apiKey] : [];

	const meta: RunMeta = options.resume
		? (JSON.parse(readFileSync(runMetaPath, "utf8")) as RunMeta)
		: newRunMeta(live, deps.git());
	if (meta.casesSha256 !== live.casesSha256)
		throw new UsageError("the cases changed since this run started; start a new --out");
	const session: SessionMeta = {
		id: `${meta.runId}.s${meta.sessions.length + 1}`,
		startedAt: new Date().toISOString(),
		models: live.contenders.map(modelMeta),
		excluded: resolution.excluded.map(({ label, reason }) => ({
			label,
			reason,
		})),
		split: options.split,
		tasks: options.tasks,
		...(options.variants.length > 0 && {
			variants: options.variants.map((variant) => variant.id),
		}),
		repetitions: options.repetitions,
		concurrency: options.concurrency,
	};
	for (const model of session.models)
		if (!meta.models.some((known) => known.label === model.label)) meta.models.push(model);
	meta.sessions.push(session);

	const ledger = BudgetLedger.open(options.ledger, options.cap);
	const log = openLog(join(outDir, "observations.jsonl"));
	const structureLog =
		structureCalls.length > 0 ? openLog(join(outDir, "structures.jsonl")) : undefined;
	const controller = new AbortController();
	let interrupts = 0;
	const onSignal = () => {
		if (++interrupts > 1) {
			ledger.close();
			process.exit(130);
		}
		deps.stderr("interrupted: no new requests; in-flight calls settle as unknown\n");
		controller.abort();
	};
	if (deps.handleSignals) {
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	}
	deps.interrupt?.addEventListener("abort", onSignal, { once: true });
	try {
		writeJson(runMetaPath, meta);
		session.keyUsageBefore = await usageOf(billing, secrets, controller.signal);
		writeJson(runMetaPath, meta);
		const stage = (stageCalls: readonly PlannedCall[], write: Execution["write"]) =>
			execute({
				calls: stageCalls,
				ledger,
				billing,
				registry,
				fetch: deps.fetch,
				timeoutMs: options.timeoutMs,
				concurrency: options.concurrency,
				signal: controller.signal,
				sessionId: session.id,
				secrets,
				write,
			});
		const structured =
			structureCalls.length > 0
				? await stage(structureCalls, (observation) => {
						structureLog?.write(observation);
						const entry = observation as StructureObservation;
						if (entry.status === "ok" && entry.structure) live.structures.set(entry.caseId, entry);
					})
				: undefined;
		if (structured) session.structureCounts = structured.counts;
		const outcome =
			structured && (structured.stopped || structured.failure)
				? structured
				: await stage(calls, log.write);
		session.keyUsageAfter = await usageOf(billing, secrets);
		session.endedAt = new Date().toISOString();
		session.counts = outcome.counts;
		session.interrupted = outcome.interrupted;
		if (outcome.stopped) session.stopped = outcome.stopped;
		session.ledgerAfter = ledger.snapshot();
		writeJson(runMetaPath, meta);
		deps.stdout(summary(outDir, session, outcome));
		if (outcome.failure) throw outcome.failure;
		if (outcome.stopped === "interrupted") return 130;
		return outcome.stopped ? 3 : 0;
	} catch (error) {
		throw error instanceof UsageError ? error : new Error(safeMessage(error, secrets));
	} finally {
		if (deps.handleSignals) {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		}
		deps.interrupt?.removeEventListener("abort", onSignal);
		log.close();
		structureLog?.close();
		ledger.close();
	}
}

function summary(outDir: string, session: SessionMeta, outcome: Outcome): string {
	const { ok, error, unsupported } = outcome.counts;
	const before = session.keyUsageBefore;
	const after = session.keyUsageAfter;
	const usage =
		before &&
		after &&
		"usage" in before &&
		"usage" in after &&
		before.usage !== null &&
		after.usage !== null
			? `key usage ${before.usage} -> ${after.usage} (delta ${(after.usage - before.usage).toFixed(9)} USD)`
			: "key usage unavailable";
	const ledger = session.ledgerAfter;
	const structures = session.structureCounts;
	const lines = [
		`${outDir}: ${ok + error + unsupported} observations (ok ${ok}, error ${error}, unsupported ${unsupported})`,
		...(structures
			? [
					`structures: ${structures.ok + structures.error + structures.unsupported} calls (ok ${structures.ok}, error ${structures.error})`,
				]
			: []),
		...(ledger
			? [
					`ledger: cap ${ledger.limitUsd}, spent ${ledger.spentUsd}, held ${ledger.heldUsd}, remaining ${ledger.remainingUsd}`,
				]
			: []),
		...(outcome.interrupted > 0
			? [`${outcome.interrupted} interrupted call(s) unrecorded; a resume repeats them`]
			: []),
		usage,
		outcome.stopped ? `STOPPED: ${outcome.stopped}` : "complete",
	];
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** Loads the pi registry from the user's agent directory without writing there. */
async function createRegistry(options: {
	storePath: string;
	offline: boolean;
}): Promise<RunRegistry> {
	const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: options.storePath,
		signal: AbortSignal.timeout(60_000),
		...(options.offline && { refreshOnCreate: false }),
	});
	return new ModelRegistry(runtime);
}

const gitOutput = (...args: string[]) =>
	execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

const defaultDeps: Deps = {
	async loadCases(path) {
		const specifier = path
			? pathToFileURL(resolve(path)).href
			: new URL("./cases.ts", import.meta.url).href;
		const { CASES } = (await import(specifier)) as {
			CASES?: readonly EvalCase[];
		};
		if (!Array.isArray(CASES)) throw new Error(`${specifier} does not export CASES`);
		return CASES;
	},
	createRegistry,
	loadRoutePrices: () => loadRouteTable(ROUTE_PRICES_URL),
	fetch: (...args) => globalThis.fetch(...args),
	git: () => ({
		sha: gitOutput("rev-parse", "HEAD"),
		dirty: gitOutput("status", "--porcelain") !== "",
	}),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	handleSignals: true,
};

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
