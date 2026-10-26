/**
 * Live parity check of the production milestone policy against the benchmark.
 *
 * Runs `evaluateMilestone` with the "recommended" policy on holdout milestone
 * cases through the metering registry of `parity.ts` (each call reserved in
 * the shared budget ledger before dispatch, no retries, settled from
 * OpenRouter's generation record). It checks that
 *
 * - the request each model received is byte-identical (SHA-256 of the body) to
 *   the recorded `#instructions` request of the same case, and
 * - the decision equals the benchmark's `confirm` combination of the same live
 *   answers, scored by `scoring.ts` exactly as `analyze.ts` scores a policy.
 *
 *   node scripts/classifier-eval/milestone-parity.ts --out .project/analyses/classifier-eval/runs/milestone-parity-2026-10-23 [--dry-run]
 *
 * Exit codes: 0 parity holds, 1 failure, 2 usage error, 3 budget stop, 4 parity
 * does not hold, 130 interrupted.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MilestoneInput } from "../../src/auto/milestone-classifier.ts";
import {
	evaluateMilestone,
	type MilestoneEvaluation,
	RECOMMENDED_MILESTONE_CLASSIFIER,
	resolveMilestonePolicy,
} from "../../src/auto/milestone-policy.ts";
import {
	CHAT_MAX_OUTPUT_TOKENS,
	chatCandidate,
	DECISION_MAX_OUTPUT_TOKENS,
	decisionsCandidate,
	parseChatAnswers,
	planRequest,
	safeMessage,
} from "./adapters.ts";
import { createBilling, worstCaseUsd } from "./billing.ts";
import { parseVariant, variantCase } from "./milestone-variants.ts";
import { type CallRecord, createMeter, type Deps, defaultDeps, openLedger } from "./parity.ts";
import { prepareCase } from "./prepare.ts";
import { scoreObservation } from "./scoring.ts";
import type { EvalCase, EvalObservation, PreparedCase } from "./types.ts";

const DEFAULT_LEDGER = ".project/analyses/classifier-eval/budget-ledger.jsonl";
const DEFAULT_BENCHMARK = ".project/analyses/classifier-eval/runs/holdout-v3-2026-10-23/milestone";
/** The benchmark's confidence gate for accepting an answer. */
export const GATE = 0.7;
const CASES_PER_TASK = 8;
export const HISTORIC_MILESTONE_MODELS = {
	provider: "openrouter",
	classifier: "typesafe/jev-1.14",
	confirmer: "openai/gpt-6-luna",
} as const;
export const HISTORIC_MILESTONE_POLICY_SETTING = JSON.stringify({
	preset: RECOMMENDED_MILESTONE_CLASSIFIER,
	classifier: {
		model: `${HISTORIC_MILESTONE_MODELS.provider}/${HISTORIC_MILESTONE_MODELS.classifier}`,
	},
	confirmer: {
		model: `${HISTORIC_MILESTONE_MODELS.provider}/${HISTORIC_MILESTONE_MODELS.confirmer}`,
	},
});
export const JEV_LABEL = `decisions:${HISTORIC_MILESTONE_MODELS.classifier}#instructions`;
export const LUNA_LABEL = `chat:${HISTORIC_MILESTONE_MODELS.confirmer}#instructions`;

/** A decision by question: the accepted choice, or undefined when the question abstained. */
export type Verdict = Record<string, string | undefined>;

/** The decision of the production policy as a verdict (`none` is the boundary choice). */
export function decisionVerdict(evaluation: MilestoneEvaluation): Verdict {
	const { status, boundary } = evaluation;
	return {
		status: status.kind === "accept" ? status.status : undefined,
		boundary:
			boundary.kind === "record"
				? boundary.recordId
				: boundary.kind === "none"
					? "none"
					: undefined,
	};
}

/**
 * The benchmark's `confirm(first + second)` on two observations of one case,
 * as `analyze.ts` combines them: a question stands when both observations are
 * accepted at `gate` by `scoring.ts` and give the same choice.
 */
export function harnessConfirm(
	prepared: PreparedCase,
	first: EvalObservation,
	second: EvalObservation,
	gate = GATE,
): Verdict {
	const a = scoreObservation(prepared, first, gate);
	const b = scoreObservation(prepared, second, gate);
	const verdict: Verdict = {};
	for (const question of Object.keys(prepared.expected)) {
		const choice = first.answers[question]?.choice;
		verdict[question] =
			a.answers.find((x) => x.question === question)?.accepted &&
			b.answers.find((x) => x.question === question)?.accepted &&
			choice === second.answers[question]?.choice
				? choice
				: undefined;
	}
	return verdict;
}

/** How a verdict fares against the case's reference answers. */
export function judge(prepared: PreparedCase, verdict: Verdict) {
	let accepted = 0;
	let unsafe = 0;
	let exact = true;
	for (const [question, expected] of Object.entries(prepared.expected)) {
		const choice = verdict[question];
		if (choice === undefined) {
			exact = false;
			continue;
		}
		accepted++;
		if (expected.unsafeChoices.includes(choice)) unsafe++;
		if (!expected.choices.includes(choice)) exact = false;
	}
	return { accepted, unsafe, acceptedExact: exact };
}

const sameVerdict = (a: Verdict, b: Verdict) =>
	[...new Set([...Object.keys(a), ...Object.keys(b)])].every(
		(question) => a[question] === b[question],
	);

const describeVerdict = (verdict: Verdict) =>
	Object.entries(verdict)
		.map(([question, choice]) => `${question}=${choice ?? "abstain"}`)
		.join(" ");

/** The milestone request the policy is asked about: the case's records, as the `#instructions` variant sends them. */
export function milestoneInput(prepared: PreparedCase): MilestoneInput {
	if (prepared.input.type !== "milestone")
		throw new Error(`${prepared.id}: parity needs a milestone case`);
	const { records, lastAnchor } = prepared.input;
	return { records, ...(lastAnchor !== undefined && { lastAnchor }) };
}

/** A paid call of the metering registry, read as the benchmark would have recorded it. */
export function liveObservation(
	prepared: PreparedCase,
	label: string,
	call: CallRecord | undefined,
): EvalObservation {
	const answers =
		call?.kind === "chat"
			? parseChatAnswers(call.text ?? "", prepared.questions).answers
			: (call?.answers ?? {});
	return {
		caseId: prepared.id,
		model: label,
		adapter: call?.kind === "chat" ? "chat" : "decisions",
		repetition: 0,
		status: call?.status ?? "error",
		answers,
		durationMs: call?.durationMs ?? 0,
		costUsd: call?.costUsd ?? null,
		costSource: call?.costSource === "pending" ? "unknown" : (call?.costSource ?? "unknown"),
		costBoundUsd: call?.costBoundUsd ?? 0,
		startedAt: "",
	};
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface CaseParity {
	caseId: string;
	task: EvalCase["task"];
	/** The live request body hash equals a recorded one; null when it cannot be compared. */
	requestMatches: { classifier: boolean | null; confirmer: boolean | null };
	production: Verdict;
	harness: Verdict;
	/** The production decision equals the benchmark's confirm of the same live answers. */
	consistent: boolean;
	/** The benchmark's confirm of each recorded repetition of the two models. */
	recorded: Verdict[];
	matchesRecorded: boolean;
	accepted: number;
	unsafeAccepted: number;
	acceptedExact: boolean;
	warnings: string[];
	ran: number;
}

/** Compare one live evaluation with the recorded benchmark observations of the same two models. */
export function compareCase(
	prepared: PreparedCase,
	evaluation: MilestoneEvaluation,
	calls: readonly CallRecord[],
	benchmark: readonly EvalObservation[],
): CaseParity {
	const jevCall = calls.find((call) => call.kind === "classify");
	const lunaCall = calls.find((call) => call.kind === "chat");
	const own = (label: string) =>
		benchmark
			.filter((o) => o.caseId === prepared.id && o.model === label)
			.sort((a, b) => a.repetition - b.repetition);
	const jev = own(JEV_LABEL);
	const luna = own(LUNA_LABEL);
	const matches = (call: CallRecord | undefined, recorded: EvalObservation[]) => {
		const hashes = recorded.flatMap((o) => o.requestSha256 ?? []);
		return call?.requestSha256 === undefined || hashes.length === 0
			? null
			: hashes.includes(call.requestSha256);
	};
	const production = decisionVerdict(evaluation);
	const harness = harnessConfirm(
		prepared,
		liveObservation(prepared, JEV_LABEL, jevCall),
		liveObservation(prepared, LUNA_LABEL, lunaCall),
	);
	const recorded = jev.flatMap((first) => {
		const second = luna.find((o) => o.repetition === first.repetition);
		return second ? [harnessConfirm(prepared, first, second)] : [];
	});
	const judged = judge(prepared, production);
	return {
		caseId: prepared.id,
		task: prepared.task,
		requestMatches: {
			classifier: matches(jevCall, jev),
			confirmer: matches(lunaCall, luna),
		},
		production,
		harness,
		consistent: sameVerdict(production, harness),
		recorded,
		matchesRecorded: recorded.some((verdict) => sameVerdict(verdict, production)),
		accepted: judged.accepted,
		unsafeAccepted: judged.unsafe,
		acceptedExact: judged.acceptedExact,
		warnings: evaluation.warnings,
		ran: evaluation.ran.length,
	};
}

/** Evenly spaced cases of each milestone task from the holdout split. */
export function selectCases(cases: readonly EvalCase[], perTask = CASES_PER_TASK): EvalCase[] {
	return (["milestone-status", "milestone-boundary"] as const).flatMap((task) => {
		const pool = cases.filter(
			(c) => c.task === task && c.split === "holdout" && c.input.type === "milestone",
		);
		return Array.from(
			{ length: Math.min(perTask, pool.length) },
			(_, i) => pool[Math.floor((i * pool.length) / perTask)] as EvalCase,
		);
	});
}

export interface Summary {
	cases: number;
	requestsMatching: string;
	consistent: string;
	matchesRecorded: string;
	accepted: number;
	unsafeAccepted: number;
	acceptedExact: number;
}

export function summarize(results: readonly CaseParity[]): Summary {
	const flags = results.flatMap((r) => [r.requestMatches.classifier, r.requestMatches.confirmer]);
	const known = flags.filter((flag): flag is boolean => flag !== null);
	return {
		cases: results.length,
		requestsMatching: `${known.filter(Boolean).length}/${known.length}`,
		consistent: `${results.filter((r) => r.consistent).length}/${results.length}`,
		matchesRecorded: `${results.filter((r) => r.matchesRecorded).length}/${results.length}`,
		accepted: results.reduce((sum, r) => sum + r.accepted, 0),
		unsafeAccepted: results.reduce((sum, r) => sum + r.unsafeAccepted, 0),
		acceptedExact: results.filter((r) => r.acceptedExact).length,
	};
}

/** Whether every claim of the parity check held. */
export function holds(results: readonly CaseParity[]): boolean {
	return results.every(
		(r) =>
			r.consistent &&
			r.unsafeAccepted === 0 &&
			r.requestMatches.classifier !== false &&
			r.requestMatches.confirmer !== false,
	);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

class UsageError extends Error {}

interface Options {
	out: string;
	ledger: string;
	cap: number;
	maxUsd: number;
	waitMinutes: number;
	benchmark: string;
	perTask: number;
	dryRun: boolean;
}

const USAGE = `usage: node scripts/classifier-eval/milestone-parity.ts --out <dir> [options]

  --out <dir>          evidence directory (must not exist)
  --ledger <path>      default ${DEFAULT_LEDGER}
  --cap <usd>          the ledger's recorded cap, default 25
  --max-usd <usd>      most this run may add to the ledger (reserved plus settled), default 0.4
  --per-task <n>       holdout cases per milestone task, default ${CASES_PER_TASK}
  --wait-minutes <n>   how long to wait for the ledger lock, default 30
  --benchmark <dir>    recorded run of the #instructions candidates (default ${DEFAULT_BENCHMARK})
  --dry-run            list the cases and worst-case reservations only; no network
`;

function parseOptions(argv: readonly string[]): Options | "help" {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		values = parseArgs({
			args: [...argv],
			strict: true,
			allowPositionals: false,
			options: {
				out: { type: "string" },
				ledger: { type: "string", default: DEFAULT_LEDGER },
				cap: { type: "string", default: "25" },
				"max-usd": { type: "string", default: "0.4" },
				"per-task": { type: "string", default: String(CASES_PER_TASK) },
				"wait-minutes": { type: "string", default: "30" },
				benchmark: { type: "string", default: DEFAULT_BENCHMARK },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		}).values;
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	if (values.help) return "help";
	const positive = (name: string) => {
		const value = Number(values[name]);
		if (!Number.isFinite(value) || value <= 0)
			throw new UsageError(`--${name} must be a positive number`);
		return value;
	};
	if (values.out === undefined && values["dry-run"] !== true)
		throw new UsageError("--out is required");
	return {
		out: String(values.out ?? ""),
		ledger: String(values.ledger),
		cap: positive("cap"),
		maxUsd: positive("max-usd"),
		waitMinutes: positive("wait-minutes"),
		benchmark: String(values.benchmark),
		perTask: Math.floor(positive("per-task")),
		dryRun: values["dry-run"] === true,
	};
}

function renderReport(
	meta: {
		runId: string;
		gitSha: string;
		calls: number;
		spentUsd: number;
		addedToLedgerUsd: number;
		ceilingUsd: number;
	},
	summary: Summary,
	results: readonly CaseParity[],
): string {
	const rows = results.map(
		(r) =>
			`| ${r.caseId} | ${r.task} | ${r.requestMatches.classifier ?? "n/a"} / ${r.requestMatches.confirmer ?? "n/a"} | ${describeVerdict(r.production)} | ${r.consistent ? "yes" : "NO"} | ${r.matchesRecorded ? "yes" : "no"} | ${r.unsafeAccepted} |`,
	);
	return [
		"# Parity of the production milestone policy with the benchmark",
		"",
		`Run \`${meta.runId}\` at \`${meta.gitSha}\`: ${meta.calls} paid calls, settled spend ${meta.spentUsd.toFixed(6)} USD; the shared ledger grew by ${meta.addedToLedgerUsd.toFixed(6)} USD (ceiling ${meta.ceilingUsd.toFixed(6)} USD of billed plus held).`,
		"",
		`- requests byte-identical to the recorded \`#instructions\` requests: ${summary.requestsMatching}`,
		`- decision equals the benchmark's confirm of the same live answers: ${summary.consistent}`,
		`- decision equals the benchmark's confirm of some recorded repetition: ${summary.matchesRecorded}`,
		`- accepted answers ${summary.accepted}, unsafe accepted ${summary.unsafeAccepted}, accepted-exact cases ${summary.acceptedExact}/${summary.cases}`,
		"",
		"| case | task | request (classifier / confirmer) | production decision | = confirm of live answers | = a recorded repetition | unsafe |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n");
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
	try {
		const options = parseOptions(argv);
		if (options === "help") {
			deps.stdout(USAGE);
			return 0;
		}
		return await run(options, deps);
	} catch (error) {
		if (error instanceof UsageError) {
			deps.stderr(`${error.message}\n\n${USAGE}`);
			return 2;
		}
		deps.stderr(`failed: ${safeMessage(error)}\n`);
		return 1;
	}
}

async function run(options: Options, deps: Deps): Promise<number> {
	const policy = resolveMilestonePolicy(HISTORIC_MILESTONE_POLICY_SETTING);
	if (!policy?.classifier || !policy.confirmer)
		throw new Error("the recommended milestone policy has no two models");
	const cases = selectCases(await deps.loadCases(), options.perTask).map(prepareCase);
	if (cases.length === 0) throw new UsageError("no holdout milestone cases");
	const outDir = resolve(options.out || ".");
	if (!options.dryRun && existsSync(outDir))
		throw new UsageError(`${outDir} already exists; use a new --out`);
	const scratch = mkdtempSync(join(tmpdir(), "milestone-parity-"));
	try {
		const base = await deps.createRegistry(join(scratch, "models-store.json"), options.dryRun);
		const table = deps.loadRoutePrices();
		if (options.dryRun) {
			const jev = base.getModelOfType(
				"classifier",
				HISTORIC_MILESTONE_MODELS.provider,
				HISTORIC_MILESTONE_MODELS.classifier,
			);
			const luna = base.getModelOfType(
				"chat",
				HISTORIC_MILESTONE_MODELS.provider,
				HISTORIC_MILESTONE_MODELS.confirmer,
			);
			if (!jev || !luna) throw new Error("the recommended models are not in the catalog");
			const jevCandidate = decisionsCandidate(jev, table);
			const lunaCandidate = chatCandidate(luna, table);
			let worstUsd = 0;
			for (const prepared of cases) {
				const sent = variantCase(prepared, parseVariant("instructions"));
				for (const candidate of [jevCandidate, lunaCandidate]) {
					const plan = planRequest(sent, candidate);
					if (plan.kind !== "request" || candidate.adapter === "heuristic")
						throw new Error(`${prepared.id}: ${candidate.label} cannot be planned`);
					worstUsd += worstCaseUsd(
						plan.bodyBytes,
						candidate.adapter === "decisions" ? DECISION_MAX_OUTPUT_TOKENS : CHAT_MAX_OUTPUT_TOKENS,
						candidate.pricing.rates,
					);
				}
			}
			deps.stdout(
				`dry run: ${cases.length} cases, ${cases.length * 2} calls; worst-case reservations ${worstUsd.toFixed(6)} USD; run ceiling ${options.maxUsd} USD\n`,
			);
			return 0;
		}
		const benchmark = (await deps.loadBenchmark([options.benchmark])).filter(
			(o) => o.model === JEV_LABEL || o.model === LUNA_LABEL,
		);
		const billing = createBilling({
			getApiKey: () => base.getApiKeyForProvider("openrouter"),
			fetch: deps.fetch,
			...(deps.billingDelaysMs && { delaysMs: deps.billingDelaysMs }),
		});
		const ledger = await openLedger(options, deps);
		mkdirSync(outDir, { recursive: true });
		const startedAt = deps.now();
		const runId = `milestone-parity-${startedAt.toISOString().replaceAll(":", "-")}`;
		const before = ledger.snapshot();
		const ceilingUsd = before.spentUsd + before.heldUsd + options.maxUsd;
		const meter = createMeter({
			ledger,
			billing,
			table,
			fetch: deps.fetch,
			sessionId: runId,
			maxRunUsd: options.maxUsd,
		});
		const registry = meter.registry(base);
		const results: CaseParity[] = [];
		let after = before;
		try {
			for (const prepared of cases) {
				if (meter.refused() !== undefined) break;
				meter.setCase(prepared.id);
				const calls = meter.calls.length;
				const evaluation = await evaluateMilestone({
					policy,
					registry,
					input: milestoneInput(prepared),
					signal: AbortSignal.timeout(60_000),
				});
				results.push(compareCase(prepared, evaluation, meter.calls.slice(calls), benchmark));
			}
		} finally {
			await meter.settled();
			after = ledger.snapshot();
			ledger.close();
		}
		const spentUsd = meter.calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
		const unknown = meter.calls.filter((call) => call.costUsd === null).length;
		const addedToLedgerUsd = after.spentUsd + after.heldUsd - (before.spentUsd + before.heldUsd);
		const git = deps.git();
		const summary = summarize(results);
		const settled = results.map((result) =>
			JSON.stringify({
				...result,
				calls: meter.calls.filter((call) => call.caseId === result.caseId),
			}),
		);
		writeFileSync(join(outDir, "observations.jsonl"), `${settled.join("\n")}\n`);
		writeFileSync(
			join(outDir, "run.json"),
			`${JSON.stringify(
				{
					runId,
					startedAt: startedAt.toISOString(),
					endedAt: deps.now().toISOString(),
					gitSha: git.sha,
					gitDirty: git.dirty,
					policy: RECOMMENDED_MILESTONE_CLASSIFIER,
					models: [JEV_LABEL, LUNA_LABEL],
					confidenceGate: GATE,
					cases: results.length,
					casesPlanned: cases.length,
					ledger: options.ledger,
					ledgerCapUsd: options.cap,
					ledgerBefore: before,
					ledgerAfter: after,
					ceilingUsd,
					addedToLedgerUsd,
					maxRunUsd: options.maxUsd,
					paidCalls: meter.calls.length,
					settledSpendUsd: spentUsd,
					callsWithUnknownCost: unknown,
					stopped: meter.refused() ?? null,
					benchmark: options.benchmark,
					summary,
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(outDir, "report.md"),
			renderReport(
				{
					runId,
					gitSha: git.sha,
					calls: meter.calls.length,
					spentUsd,
					addedToLedgerUsd,
					ceilingUsd,
				},
				summary,
				results,
			),
		);
		const overran = after.spentUsd + after.heldUsd > ceilingUsd;
		const ok = holds(results) && !overran;
		deps.stdout(
			`${outDir}: ${results.length}/${cases.length} cases, ${meter.calls.length} paid calls, settled ${spentUsd.toFixed(6)} USD, ledger +${addedToLedgerUsd.toFixed(6)} USD, ${unknown} unknown\nrequests ${summary.requestsMatching}, consistent ${summary.consistent}, unsafe accepted ${summary.unsafeAccepted}\n${meter.refused() ? `STOPPED: ${meter.refused()}\n` : ok ? "parity holds\n" : "PARITY DOES NOT HOLD\n"}`,
		);
		return meter.refused() ? 3 : ok ? 0 : 4;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
