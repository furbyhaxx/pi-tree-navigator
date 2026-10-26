import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { RECOMMENDED_MILESTONE_POLICY } from "../../src/auto/milestone-policy.ts";
import { parseClassifierModel } from "../../src/continuity/intent-policy.ts";
import navigateTree, {
	__testHooks,
	estimateAdmissionTokens,
	PRESSURE_COMPACTION_CUSTOM_TYPE,
	REWIND_CUSTOM_TYPE,
} from "../../src/index.ts";
import { safeMessage } from "../classifier-eval/adapters.ts";
import {
	type Billing,
	createBilling,
	loadRouteTable,
	ROUTE_PRICES_URL,
} from "../classifier-eval/billing.ts";
import { BudgetLedger } from "../classifier-eval/budget.ts";
import {
	AUTOMATIC_CONFIG,
	AUTOMATIC_REQUEST,
	buildCorpus,
	buildDenseCorpus,
	corpusManifest,
	FACTS,
	PRESSURE_CONFIG,
	PRESSURE_REQUEST,
	seedCorpus,
} from "./fixture.ts";
import { createBudgetedTransport, type NativeEndpoint, type PricedModel } from "./transport.ts";

/**
 * Acceptance scenarios for manual, recovery, tool-driven and automatic engine
 * folds, pressure compaction, the anchorless recovery compaction (`fallback`),
 * recovery when the heuristic undercounts dense text (`undercount`), and a second
 * recovery when the first one still overflows (`rerecover`).
 */
export type Scenario =
	| "manual"
	| "preflight"
	| "agent"
	| "automatic"
	| "pressure"
	| "fallback"
	| "undercount"
	| "rerecover";
const SCENARIOS: readonly Scenario[] = [
	"manual",
	"preflight",
	"agent",
	"automatic",
	"pressure",
	"fallback",
	"undercount",
	"rerecover",
];
/** Options contain no credentials; they are safe to persist with the result. */
export interface RunOptions {
	scenario: Scenario;
	model: string;
	window: number;
	blocks: number;
	out: string;
	ledger: string;
	authDir: string;
	dryRun: boolean;
}

const REQUEST =
	"UNANSWERED-ACCEPTANCE-7d9a: Reply with ACCEPTANCE-CONTINUED and the audit's remaining work. Do not deploy or change any files.";
const textOf = (message: { role?: string; content?: unknown }): string =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content
					.flatMap((part: { type?: string; text?: string }) =>
						part.type === "text" ? [part.text ?? ""] : [],
					)
					.join("\n")
			: "";

const branchesFolded = (sm: SessionManager): boolean =>
	sm.getBranch().some((entry) => entry.type === "branch_summary");

/** Require successful same-run work after folding and fulfillment of the authored request. */
export function verifyAutomaticContinuation(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[],
): void {
	const summaryAt = branch.findIndex((entry) => entry.type === "branch_summary");
	assert.ok(summaryAt >= 0, "automatic engine must create a handoff");
	assert.ok(
		branch
			.slice(summaryAt + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "stop" &&
					textOf(entry.message).trim().length > 0,
			),
		"automatic fold must continue in the same prompt run after the handoff",
	);
	assert.ok(
		entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.stopReason === "stop" &&
				textOf(entry.message).includes("ACCEPTANCE-CONTINUED"),
		),
		"main model must fulfill the authored finalization request",
	);
}

/** Require a tail-keeping compaction mid-run and a final answer written after it. */
export function verifyPressureCompaction(
	branch: readonly SessionEntry[],
	getLabel: (id: string) => string | undefined,
): void {
	const at = branch.findIndex(
		(entry) =>
			entry.type === "compaction" &&
			typeof (entry.details as { navigateTree?: { pressure?: unknown } })?.navigateTree
				?.pressure === "object",
	);
	assert.ok(at >= 0, "pressure relief must write a native compaction");
	assert.match(getLabel(branch[at].id) ?? "", /^anchor:compacted/);
	assert.ok(
		!branch.some((entry) => entry.type === "branch_summary"),
		"pressure compaction must not fold",
	);
	assert.ok(
		branch
			.slice(at + 1)
			.some(
				(entry) =>
					entry.type === "custom_message" && entry.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
			),
		"pressure compaction must leave a visible receipt",
	);
	assert.ok(
		branch
			.slice(at + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "stop" &&
					textOf(entry.message).includes("ACCEPTANCE-CONTINUED"),
			),
		"the agent must answer in the same run after the compaction",
	);
}

const receiptsOf = (
	entries: readonly SessionEntry[],
	customType: string,
): Record<string, unknown>[] =>
	entries.flatMap((entry) =>
		entry.type === "custom_message" &&
		entry.customType === customType &&
		typeof entry.details === "object" &&
		entry.details !== null
			? [entry.details as Record<string, unknown>]
			: [],
	);

/** Require an anchorless recovery to compact before the first main request and keep the request. */
export function verifyRecoveryCompaction(branch: readonly SessionEntry[], request: string): void {
	const at = branch.findIndex((entry) => entry.type === "compaction");
	assert.ok(at >= 0, "recovery without an anchor must write a compaction");
	assert.ok(
		!branch.some((entry) => entry.type === "branch_summary"),
		"recovery without an anchor cannot fold",
	);
	assert.ok(
		receiptsOf(branch.slice(at + 1), PRESSURE_COMPACTION_CUSTOM_TYPE).some(
			(details) => details.origin === "recovery",
		),
		"the recovery compaction must leave a receipt with origin recovery",
	);
	const compaction = branch[at];
	const keptFrom = branch.findIndex(
		(entry) => compaction.type === "compaction" && entry.id === compaction.firstKeptEntryId,
	);
	assert.ok(
		branch
			.slice(keptFrom >= 0 ? keptFrom : at + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					textOf(entry.message) === request,
			),
		"unanswered request must stay verbatim in the kept tail or after the compaction",
	);
	assert.ok(
		branch
			.slice(at + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "stop" &&
					textOf(entry.message).includes("ACCEPTANCE-CONTINUED"),
			),
		"the agent must answer in the same run after the compaction",
	);
}

/**
 * Require at least `minRecoveries` recoveries in one run, none refused, and a
 * final answer whose reported input fits the operating window.
 */
export function verifyRepeatedRecovery(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	contextWindow: number,
	minRecoveries: number,
): void {
	const recoveries = [
		...receiptsOf(entries, REWIND_CUSTOM_TYPE),
		...receiptsOf(entries, PRESSURE_COMPACTION_CUSTOM_TYPE),
	].filter((details) => details.origin === "recovery");
	assert.ok(
		!recoveries.some((details) => details.status === "failed"),
		"no recovery may be refused or fail",
	);
	assert.ok(
		!receiptsOf(entries, REWIND_CUSTOM_TYPE).some((details) => details.providerOverflow === true),
		"the run must not end in a request-budget failure",
	);
	assert.ok(
		recoveries.length >= minRecoveries,
		`expected at least ${minRecoveries} recoveries (saw ${recoveries.length})`,
	);
	const final = branch.findLast(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	assert.ok(
		final?.type === "message" &&
			final.message.role === "assistant" &&
			final.message.stopReason === "stop" &&
			textOf(final.message).includes("ACCEPTANCE-CONTINUED"),
		"main model must answer after the recoveries",
	);
	const usage = (final.message as { usage?: { input?: number; cacheRead?: number } }).usage;
	assert.ok(
		(usage?.input ?? 0) + (usage?.cacheRead ?? 0) <= contextWindow,
		"the final request must fit the operating window",
	);
}

/**
 * Split a Pi `provider/modelId` selector. A model id may itself contain
 * slashes, e.g. `openrouter/openai/gpt-6-luna`.
 */
export function parseModelSelector(value: string): {
	provider: string;
	modelId: string;
} {
	const at = value.indexOf("/");
	const provider = at > 0 ? value.slice(0, at) : "";
	const modelId = at > 0 ? value.slice(at + 1) : "";
	if (provider === "" || modelId === "")
		throw new Error("--model must be a provider/modelId selector, e.g. openai/gpt-6-luna");
	return { provider, modelId };
}

/** Parse explicit run controls; no request is sent by parsing. */
export function parseOptions(args: string[]): RunOptions {
	const { values } = parseArgs({
		args,
		options: {
			scenario: { type: "string", default: "manual" },
			model: { type: "string", default: "openai/gpt-6-luna" },
			window: { type: "string" },
			blocks: { type: "string" },
			out: { type: "string" },
			ledger: {
				type: "string",
				default: ".project/analyses/classifier-eval/budget-ledger.jsonl",
			},
			"auth-dir": {
				type: "string",
				default: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
			},
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.out) throw new Error("--out is required and must be a new directory");
	if (!SCENARIOS.includes(values.scenario as Scenario))
		throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
	if (
		(values.scenario === "automatic" || values.scenario === "pressure") &&
		!values["dry-run"] &&
		((!args.includes("--ledger") && !args.some((arg) => arg.startsWith("--ledger="))) ||
			!isAbsolute(values.ledger))
	)
		throw new Error(
			"automatic and pressure live runs require an explicit absolute --ledger path to the shared ledger",
		);
	const window = Number(values.window ?? (values.scenario === "undercount" ? "32000" : "96000")),
		blocks = Number(
			values.blocks ??
				(values.scenario === "automatic"
					? "8"
					: values.scenario === "pressure"
						? "16"
						: values.scenario === "agent"
							? "15"
							: values.scenario === "undercount"
								? "10"
								: values.scenario === "rerecover"
									? "14"
									: "24"),
		);
	if (!Number.isInteger(window) || window < 32000)
		throw new Error("--window must be an integer >=32000");
	parseModelSelector(values.model);
	corpusFor(values.scenario as Scenario, blocks);
	return {
		scenario: values.scenario as Scenario,
		model: values.model,
		window,
		blocks,
		out: resolve(values.out),
		ledger: resolve(values.ledger),
		authDir: resolve(values["auth-dir"]),
		dryRun: values["dry-run"],
	};
}

const corpusFor = (scenario: Scenario, blocks: number): string[] =>
	scenario === "undercount"
		? buildDenseCorpus(blocks)
		: scenario === "rerecover"
			? // Dense evidence before audit-mid, light after: the averaged ratio makes
				// audit-mid look like it fits while its retained prefix alone overflows.
				[...buildDenseCorpus(4, 15000), ...buildCorpus(blocks)]
			: buildCorpus(blocks);

/** Settle native calls from reported costs or a configured subscription. */
export function nativeBilling(subscription: boolean): Billing {
	return {
		async settle(evidence) {
			if (!evidence.dispatched) return { costUsd: 0, costSource: "local" };
			if (evidence.responseCostUsd !== undefined)
				return { costUsd: evidence.responseCostUsd, costSource: "response" };
			return subscription
				? { costUsd: 0, costSource: "subscription" }
				: { costUsd: null, costSource: "unknown" };
		},
		async keyUsage() {
			throw new Error("native billing has no key usage endpoint");
		},
	};
}

/** Intercept both runtime APIs; all paid requests share one budgeted transport. */
export function interceptRuntime(
	runtime: ModelRuntime,
	fetch: typeof globalThis.fetch,
	record: (call: {
		api: "chat" | "decisions";
		side: boolean;
		model: string;
		messages: number;
		startedAt: string;
	}) => void,
): void {
	const originalStream = runtime.streamSimple.bind(runtime);
	const originalClassify = runtime.classify.bind(runtime);
	runtime.streamSimple = ((selected, context, options) => {
		record({
			api: "chat",
			side: options?.toolChoice === "none",
			model: `${selected.provider}/${selected.id}`,
			messages: context.messages.length,
			startedAt: new Date().toISOString(),
		});
		return originalStream(selected, context, {
			...options,
			fetch,
			maxRetries: 0,
		});
	}) as typeof runtime.streamSimple;
	runtime.classify = ((selected, context, options) => {
		record({
			api: "decisions",
			side: true,
			model: `${selected.provider}/${selected.id}`,
			messages: 0,
			startedAt: new Date().toISOString(),
		});
		return originalClassify(selected, context, {
			...options,
			fetch,
			maxRetries: 0,
		});
	}) as typeof runtime.classify;
}

/** Run only synthetic history through the production extension and budgeted real transport. */
export async function runAcceptance(
	options: RunOptions,
	createRuntime: typeof ModelRuntime.create = (opts) => ModelRuntime.create(opts),
): Promise<void> {
	const corpus = corpusFor(options.scenario, options.blocks);
	const request =
		options.scenario === "automatic"
			? AUTOMATIC_REQUEST
			: options.scenario === "pressure"
				? PRESSURE_REQUEST
				: REQUEST;
	const navigatorConfig =
		options.scenario === "automatic"
			? AUTOMATIC_CONFIG
			: options.scenario === "pressure"
				? PRESSURE_CONFIG
				: undefined;
	mkdirSync(dirname(options.out), { recursive: true });
	mkdirSync(options.out);
	const save = (name: string, value: unknown) =>
		writeFileSync(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	save("fixture.json", { facts: FACTS, request, corpus });
	if (navigatorConfig) save("auto-config.json", navigatorConfig);
	save("manifest.json", corpusManifest(corpus));
	const { authDir: _authDir, ...publicOptions } = options;
	save("invocation.json", {
		...publicOptions,
		startedAt: new Date().toISOString(),
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
		dirtyPaths: execFileSync(
			"git",
			[
				"status",
				"--porcelain",
				"--",
				"src",
				"scripts",
				"README.md",
				"docs",
				"package.json",
				"tsconfig.json",
			],
			{
				encoding: "utf8",
			},
		)
			.trim()
			.split("\n")
			.filter(Boolean),
	});
	if (options.dryRun) {
		save("result.json", {
			dryRun: true,
			dispatched: 0,
			sourceBytes: corpus.reduce((n, s) => n + Buffer.byteLength(s), 0),
		});
		console.log("Dry run: fixture written; zero provider calls and no ledger changes.");
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), "independent-fold-acceptance-"));
	const agentDir = join(scratch, "agent"),
		cwd = join(scratch, "work");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	if (navigatorConfig)
		writeFileSync(join(agentDir, "tree-navigator.json"), JSON.stringify(navigatorConfig));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	let ledger: BudgetLedger | undefined;
	let transport: ReturnType<typeof createBudgetedTransport> | undefined;
	let dispose: (() => void) | undefined;
	let failure: unknown;
	try {
		const runtime = await createRuntime({
			authPath: join(options.authDir, "auth.json"),
			modelsPath: join(options.authDir, "models.json"),
			modelsStorePath: join(options.authDir, "models-store.json"),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const selector = parseModelSelector(options.model);
		const catalogModel = registry.find(selector.provider, selector.modelId);
		if (!catalogModel) throw new Error(`Selected model ${options.model} is unavailable`);
		if (!registry.hasConfiguredAuth(catalogModel))
			throw new Error(`Provider ${selector.provider} has no auth configured`);
		if (options.window > catalogModel.contextWindow)
			throw new Error("Fixture window cannot exceed the catalogued operating window");
		const model: Model<Api> = {
			...catalogModel,
			contextWindow: options.window,
			maxTokens: Math.min(catalogModel.maxTokens, 8192),
		};
		const natives: NativeEndpoint[] = [];
		const addNative = (provider: string, baseUrl: string): void => {
			if (provider === "openrouter") return;
			if (natives.some((entry) => entry.provider === provider)) return;
			natives.push({ provider, baseUrl });
		};
		addNative(model.provider, model.baseUrl);
		const pricedModels: PricedModel[] = [
			{
				id: model.id,
				kind: "chat",
				cost: model.cost,
				...(model.provider === "openrouter" ? {} : { maxOutputTokens: catalogModel.maxTokens }),
			},
		];
		if (options.scenario === "automatic") {
			for (const [kind, selector] of [
				["decisions", RECOMMENDED_MILESTONE_POLICY.classifier],
				["chat", RECOMMENDED_MILESTONE_POLICY.confirmer],
			] as const) {
				const parsed = parseClassifierModel(selector);
				assert.ok(parsed, `Invalid policy selector: ${selector}`);
				const selected =
					kind === "decisions"
						? registry.findOfType("classifier", parsed.provider, parsed.id)
						: registry.find(parsed.provider, parsed.id);
				assert.ok(selected, `Policy catalog model unavailable: ${selector}`);
				addNative(selected.provider, selected.baseUrl);
				if (!pricedModels.some((entry) => entry.id === parsed.id))
					pricedModels.push({ id: parsed.id, kind, cost: selected.cost });
			}
		}
		ledger = BudgetLedger.open(options.ledger, 25);
		const beforeBudget = ledger.snapshot();
		const billing = createBilling({
			getApiKey: () => registry.getApiKeyForProvider("openrouter"),
		});
		transport = createBudgetedTransport({
			fetch: globalThis.fetch,
			ledger,
			models: {
				routes: loadRouteTable(ROUTE_PRICES_URL),
				models: pricedModels,
			},
			billing,
			natives,
			billingFor: (provider) =>
				provider === "openrouter" ? billing : nativeBilling(runtime.isUsingSubscription(provider)),
			record: (record) =>
				appendFileSync(join(options.out, "wire.jsonl"), `${JSON.stringify(record)}\n`),
		});
		const calls: Parameters<Parameters<typeof interceptRuntime>[2]>[0][] = [];
		interceptRuntime(runtime, transport.fetch, (call) => {
			calls.push(call);
			appendFileSync(join(options.out, "calls.jsonl"), `${JSON.stringify(call)}\n`);
		});
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
			defaultThinkingLevel: "off",
		});
		const sm = SessionManager.create(cwd, join(options.out, "sessions"));
		let pi: ExtensionAPI | undefined;
		let extensionContext: ExtensionContext | undefined;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			extensionFactories: [
				(api) => {
					pi = api;
					navigateTree(api);
					api.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
				},
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				options.scenario === "pressure"
					? "You are evaluating a synthetic service audit. Preserve explicit constraints and remaining work. Follow the latest request without modifying files. Use navigate_tree only as the request says; context management is automatic."
					: options.scenario === "automatic"
						? // The tool must stay active for automatic folding to run; the model
							// is told to leave navigation to the controller so the classifier
							// pair is the only source of anchors and folds.
							"You are evaluating a synthetic service audit. Preserve explicit constraints and remaining work. Follow the latest request without modifying files. Do not call navigate_tree: anchors and folding are handled automatically."
						: "You are evaluating a synthetic service audit. Preserve explicit constraints and remaining work. Follow the latest request without modifying files. When asked to fold, invoke navigate_tree rewind, then answer the remaining request after the handoff.",
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: "off",
			tools: ["navigate_tree"],
			resourceLoader: loader,
			sessionManager: sm,
			settingsManager: settings,
		});
		dispose = () => session.dispose();
		await session.bindExtensions({
			mode: "json",
			abortHandler: () => {
				void session.abort();
			},
		});
		// Seeded sessions represent an existing run whose prompt bootstrap already ran.
		__testHooks.captureSession(session);
		seedCorpus(sm, corpus, {
			completedReview: options.scenario === "automatic",
			anchor: options.scenario !== "fallback",
			...(options.scenario === "undercount" && {
				midAnchorAfter: Math.floor(corpus.length * 0.3) - 1,
			}),
			...(options.scenario === "rerecover" && { midAnchorAfter: 3 }),
		});
		const initialTokens = estimateAdmissionTokens(sm);
		if (options.scenario === "undercount" || options.scenario === "rerecover")
			assert.ok(
				initialTokens + 5120 < model.contextWindow,
				"undercount fixture must pass admission by the heuristic",
			);
		if (options.scenario === "preflight" || options.scenario === "fallback")
			assert.ok(
				initialTokens + 5120 > model.contextWindow,
				"fixture must exceed admission before any main request",
			);
		if (
			options.scenario === "agent" ||
			options.scenario === "automatic" ||
			options.scenario === "pressure"
		)
			assert.ok(
				initialTokens + 16384 < model.contextWindow,
				"agent scenario must start with room to call the tool",
			);
		if (options.scenario === "pressure")
			assert.ok(
				initialTokens > PRESSURE_CONFIG.auto_navigate.rewind_at_tokens,
				"pressure fixture must start above rewind_at_tokens",
			);
		assert.ok(pi && extensionContext, "production extension did not initialize");
		const api = __testHooks.foldApi(pi);
		assert.ok(api, "independent fold entrypoint is unavailable");
		if (options.scenario === "manual") {
			const outcome = await api.runFoldNow(extensionContext, {
				origin: "manual",
				rewindTo: "audit-start",
				newLabel: "audit-folded",
				focus: `Preserve all five audit facts verbatim, including the no-deployment rule and remaining comparison work. ${FACTS.join(" ")}`,
			});
			save("fold-outcome.json", outcome);
			assert.equal(outcome.status, "done");
			assert.ok(
				calls.length > 0 && calls.every((call) => call.side),
				"manual folding must make only independent summary calls",
			);
			await session.prompt(REQUEST);
		} else if (options.scenario === "agent") {
			await session.prompt(
				`Call navigate_tree with action rewind, rewindTo audit-start, newLabel audit-folded, summaryFocus 'Preserve audit constraints and remaining comparison work, then answer the latest request'. After it completes: ${REQUEST}`,
			);
		} else {
			await session.prompt(request);
		}
		await session.waitForIdle();
		if (
			options.scenario === "pressure" ||
			options.scenario === "fallback" ||
			options.scenario === "undercount" ||
			options.scenario === "rerecover"
		) {
			const branch = sm.getBranch();
			save("session-evidence.json", {
				receipts: sm
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							(entry.customType === REWIND_CUSTOM_TYPE ||
								entry.customType === PRESSURE_COMPACTION_CUSTOM_TYPE),
					),
				mainReplies: sm.getEntries().flatMap((entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.provider !== "fixture"
						? [
								{
									id: entry.id,
									stopReason: entry.message.stopReason,
									usage: entry.message.usage,
									text: textOf(entry.message).slice(0, 2000),
								},
							]
						: [],
				),
			});
			if (options.scenario === "pressure")
				verifyPressureCompaction(branch, (id) => sm.getLabel(id));
			else if (options.scenario === "fallback") {
				assert.ok(calls[0]?.side, "recovery must precede the first main dispatch");
				verifyRecoveryCompaction(branch, request);
			} else
				verifyRepeatedRecovery(
					branch,
					sm.getEntries(),
					model.contextWindow,
					options.scenario === "rerecover" ? 2 : 1,
				);
			const afterTokens = estimateAdmissionTokens(sm);
			assert.ok(afterTokens < initialTokens, "relief must reduce projected context");
			await transport.drain();
			save("result.json", {
				passed: true,
				scenario: options.scenario,
				sessionFile: sm.getSessionFile(),
				initialTokens,
				afterTokens,
				compaction: branch.find((entry) => entry.type === "compaction"),
				calls,
				scratch,
				beforeBudget,
				afterBudget: ledger.snapshot(),
				completedAt: new Date().toISOString(),
			});
			console.log(
				`${options.scenario}: PASS; ${initialTokens} -> ${afterTokens} estimated tokens; ${calls.length} requests.`,
			);
			return;
		}
		if (options.scenario === "automatic") {
			const entries = sm.getEntries();
			const receipts = entries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === "navigate-tree-rewind",
			);
			save("automatic-evidence.json", { calls, receipts });
			assert.ok(
				calls.some(
					(call) =>
						call.api === "decisions" && call.model === RECOMMENDED_MILESTONE_POLICY.classifier,
				),
				"automatic acceptance requires an actual Decisions classifier call; host auto-engine wiring may be missing",
			);
			assert.ok(
				calls.some(
					(call) =>
						call.api === "chat" &&
						call.model === RECOMMENDED_MILESTONE_POLICY.confirmer &&
						call.side,
				),
				"automatic acceptance requires chat confirmation",
			);
			assert.ok(
				!entries.some(
					(entry) =>
						entry.type === "custom_message" &&
						(entry.customType === "navigate-tree-auto-rewind" ||
							/call[^\n]*rewind/i.test(textOf(entry))),
				),
				"automatic folding must not inject a call-rewind steer",
			);
			assert.ok(
				!entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						Array.isArray(entry.message.content) &&
						entry.message.content.some(
							(part) =>
								part.type === "toolCall" &&
								part.name === "navigate_tree" &&
								(part.arguments as { action?: string }).action === "rewind",
						),
				),
				"automatic folding must use the engine directly, without a main-model rewind tool call",
			);
		}
		if (options.scenario === "automatic" && !branchesFolded(sm)) {
			// The pair ran and did not accept a milestone: no fold is the safe outcome.
			await transport.drain();
			save("abstained.json", {
				abstained: true,
				reason: "the recommended classifier pair ran and did not accept a milestone",
				calls,
				budget: ledger.snapshot(),
			});
			console.log("automatic: policy ran and abstained; no fold claimed (see abstained.json).");
			return;
		}
		const branch = sm.getBranch();
		const summaryAt = branch.findIndex((entry) => entry.type === "branch_summary");
		assert.ok(summaryAt >= 0, "production engine must write a branch summary");
		if (options.scenario === "automatic") verifyAutomaticContinuation(branch, sm.getEntries());
		const final = branch.findLast(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		assert.ok(
			final?.type === "message" &&
				final.message.role === "assistant" &&
				final.message.stopReason === "stop" &&
				(options.scenario === "automatic" ||
					textOf(final.message).includes("ACCEPTANCE-CONTINUED")),
			"main model must answer after the fold",
		);
		if (options.scenario === "preflight") {
			assert.ok(calls[0]?.side, "recovery must precede the first main dispatch");
			assert.ok(
				branch
					.slice(summaryAt + 1)
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							textOf(entry.message) === REQUEST,
					),
				"unanswered request must survive verbatim after the handoff",
			);
		}
		const afterTokens = estimateAdmissionTokens(sm);
		assert.ok(afterTokens < initialTokens, "fold must reduce projected context");
		await transport.drain();
		save("result.json", {
			passed: true,
			scenario: options.scenario,
			sessionFile: sm.getSessionFile(),
			initialTokens,
			afterTokens,
			calls,
			beforeBudget,
			afterBudget: ledger.snapshot(),
			completedAt: new Date().toISOString(),
			scratch,
			isolatedAgentDir: getAgentDir(),
		});
		console.log(
			`${options.scenario}: PASS; ${initialTokens} -> ${afterTokens} estimated tokens; ${calls.length} requests.`,
		);
	} catch (error) {
		failure = error;
		save("failure.json", {
			error: safeMessage(error),
			at: new Date().toISOString(),
		});
	} finally {
		try {
			await transport?.drain();
		} catch (error) {
			failure ??= error;
		}
		try {
			dispose?.();
		} finally {
			ledger?.close();
			rmSync(scratch, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
	}
	if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		await runAcceptance(parseOptions(process.argv.slice(2)));
	} catch (error) {
		console.error(safeMessage(error));
		process.exitCode = 1;
	}
}
