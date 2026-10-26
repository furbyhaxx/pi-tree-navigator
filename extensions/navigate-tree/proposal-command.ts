import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	BorderedLoader,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { showView } from "./clone-screen.ts";
import { entryIndex, formatPlanOutline, type OutlineInfo, outlineBadge } from "./clone-views.ts";
import { loadTreeNavigatorConfig, TREE_NAVIGATOR_CONFIG_FILENAME } from "./config.ts";
import { proposeTree, type TreeProposal } from "./proposal-engine.ts";
import { createProposalModelRunner, resolveProposalModel } from "./proposal-model.ts";
import {
	mergeProposalOptions,
	type ProposalOptions,
	type ProposalToolMode,
	parseProposalModel,
} from "./proposal-options.ts";
import { buildHeuristicPlan } from "./proposal-source.ts";
import { validateRetrospectivePlan } from "./retrospective.ts";
import {
	parseRetrospectivePlan,
	type RetrospectivePlan,
	readSessionSnapshot,
	type SessionSnapshot,
	sha256,
	validateCompleteToolCalls,
} from "./retrospective-plan.ts";
import { readRuntimeConfig } from "./runtime-config.ts";

/** Explicit opt-in to remote analysis; tool rules apply to this proposal only. */
export interface ProposalArguments {
	readonly source?: string;
	readonly output?: string;
	readonly llm: boolean;
	readonly input: Partial<ProposalOptions>;
}

function words(raw: string): string[] {
	const result: string[] = [];
	let word = "";
	let quote: string | undefined;
	let started = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index];
		if (character === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && (character === '"' || character === "'")) {
			quote = character;
			started = true;
			continue;
		}
		if (!quote && /\s/.test(character)) {
			if (started) result.push(word);
			word = "";
			started = false;
			continue;
		}
		if (
			character === "\\" &&
			quote !== "'" &&
			index + 1 < raw.length &&
			/[\s"'\\]/.test(raw[index + 1])
		)
			word += raw[++index];
		else word += character;
		started = true;
	}
	if (quote) throw new Error("Path quotes must match");
	if (started) result.push(word);
	return result;
}

/** Parse the same proposal flags for Pi commands and the offline CLI. */
export function parseProposalArguments(raw: string | readonly string[]): ProposalArguments {
	const args = typeof raw === "string" ? words(raw) : [...raw];
	let source: string | undefined;
	let output: string | undefined;
	let model: string | undefined;
	let llm = false;
	let positional = false;
	const tools: Record<string, ProposalToolMode> = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--" && !positional) {
			positional = true;
			continue;
		}
		if (!positional && arg === "--llm") {
			llm = true;
			continue;
		}
		if (!positional && arg.startsWith("--")) {
			const equal = arg.indexOf("=");
			const flag = equal < 0 ? arg : arg.slice(0, equal);
			const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
			if (
				!["--model", "--output", "--omit-tool", "--calls-only-tool", "--full-tool"].includes(flag)
			)
				throw new Error(`Unknown proposal flag: ${flag}`);
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			if (flag === "--model") {
				parseProposalModel(value);
				model = value;
				llm = true;
			} else if (flag === "--output") output = value;
			else
				Object.defineProperty(tools, value, {
					value:
						flag === "--omit-tool" ? "omit" : flag === "--calls-only-tool" ? "calls-only" : "full",
					enumerable: true,
					configurable: true,
				});
			continue;
		}
		if (source !== undefined || !arg)
			throw new Error("Provide one session path; quote paths containing spaces");
		source = arg;
	}
	return {
		source,
		output,
		llm,
		input: { ...(model === undefined ? {} : { model }), tools },
	};
}

/** Reject unsafe model ranges and fall back explicitly to local graph annotations. */
export function validateTreeProposal(
	snapshot: SessionSnapshot,
	proposal: TreeProposal,
): TreeProposal {
	try {
		const plan = parseRetrospectivePlan(proposal.plan);
		if (plan.source !== snapshot.path) throw new Error("Proposal source path changed");
		validateRetrospectivePlan(snapshot, plan);
		return { ...proposal, plan };
	} catch (error) {
		if (proposal.method === "heuristic") throw error;
		const warnings = [...proposal.warnings];
		const plan = parseRetrospectivePlan(
			buildHeuristicPlan(snapshot, (message) => warnings.push(message)),
		);
		validateRetrospectivePlan(snapshot, plan);
		warnings.push(
			`Model plan failed graph-safety validation; using the heuristic proposal: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { ...proposal, plan, method: "heuristic", warnings };
	}
}

function checkPlanAgainstSource(
	snapshot: SessionSnapshot,
	plan: RetrospectivePlan,
): RetrospectivePlan {
	if (plan.source !== snapshot.path || plan.sourceSha256 !== snapshot.sha256)
		throw new Error("A proposal must retain the inspected source path and hash");
	const parsed = parseRetrospectivePlan(plan);
	validateRetrospectivePlan(snapshot, parsed);
	return parsed;
}

/** Validate a proposal against its immutable source before saving a new private plan. */
export async function saveTreeProposal(
	snapshot: SessionSnapshot,
	plan: RetrospectivePlan,
	output?: string,
): Promise<string> {
	const parsed = checkPlanAgainstSource(snapshot, plan);
	if (sha256(await readFile(snapshot.path)) !== snapshot.sha256)
		throw new Error(
			"Source changed while deriving the tree; inspect and propose again. No plan was saved.",
		);
	const path = output ?? join(dirname(snapshot.path), ".tree-clone-plans", `${randomUUID()}.json`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return path;
}

/** Format a compact chronological outline without including source transcript text. */
export function formatProposalOutline(plan: RetrospectivePlan): string {
	const lines: string[] = [];
	function visit(groups: RetrospectivePlan["groups"], depth: number) {
		for (const group of groups) {
			lines.push(
				`${"  ".repeat(depth)}[${group.state}] ${group.title ?? group.name} (${group.firstEntryId}..${group.lastEntryId})`.replace(
					/\p{Cc}/gu,
					" ",
				),
			);
			visit(group.children, depth + 1);
		}
	}
	visit(plan.groups, 0);
	return lines.join("\n");
}

/** The outline screen: `s` (or Enter) saves, `e` edits the raw JSON plan, Escape cancels. Edits are validated before the outline shows them. */
async function reviewProposal(
	ctx: ExtensionCommandContext,
	snapshot: SessionSnapshot,
	proposal: TreeProposal,
): Promise<RetrospectivePlan | undefined> {
	let plan = proposal.plan;
	const index = entryIndex(snapshot.entries);
	const info: OutlineInfo = {
		sessionName: snapshot.name,
		entries: snapshot.entries.length,
		method: proposal.method,
		calls: proposal.calls,
		cost: proposal.usage.reduce((sum, usage) => sum + usage.cost.total, 0),
		warnings: proposal.warnings,
	};
	while (true) {
		const key = await showView(ctx, {
			breadcrumbs: ["Anchor", "Clone", "Propose"],
			rightBadge: outlineBadge(plan, info),
			enterAction: "save",
			cancelAction: "cancel",
			shortcuts: [
				{ key: "e", action: "edit plan" },
				{ key: "s", action: "save" },
			],
			lines: (width) => formatPlanOutline(plan, info, width, { entryIndex: index }),
		});
		if (key === undefined) return undefined;
		if (key !== "e") return plan;
		const edited = await ctx.ui.editor(
			"Review and save tree plan (original session stays untouched)",
			JSON.stringify(plan, null, 2),
		);
		if (edited === undefined) continue;
		try {
			plan = checkPlanAgainstSource(snapshot, parseRetrospectivePlan(JSON.parse(edited)));
		} catch (error) {
			ctx.ui.notify(
				`The edited plan was not applied: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}
}

async function modelProposal(
	snapshot: SessionSnapshot,
	input: ProposalOptions,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<TreeProposal | undefined> {
	if (!ctx.hasUI)
		throw new Error(
			"Model proposals require UI confirmation here. Use the CLI propose --llm for an explicit noninteractive model request.",
		);
	if (!ctx.isIdle())
		throw new Error("Wait until Pi is idle before requesting a model-assisted tree proposal");
	const selected = resolveProposalModel({
		registry: ctx.modelRegistry,
		currentModel: ctx.model,
		currentThinking: pi.getThinkingLevel(),
		selector: input.model,
	});
	const runner = createProposalModelRunner({
		registry: ctx.modelRegistry,
		...selected,
	});
	const rules =
		Object.entries(input.tools)
			.map(([name, mode]) => `${name}: ${mode}`)
			.join(", ") || "none (full tool calls and results)";
	const confirmed = await ctx.ui.confirm(
		`Analyze session with ${runner.name}?`,
		`Send the full textual history of "${snapshot.name}" across all branches to this model. Tool rules: ${rules}. Binary data is omitted. Large histories require multiple requests and incur provider charges. No session is changed; the resulting plan must be reviewed before cloning.`,
	);
	if (!confirmed) return undefined;
	type Result =
		| { kind: "ok"; proposal: TreeProposal }
		| { kind: "error"; error: unknown }
		| { kind: "cancelled" };
	const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
		const loader = new BorderedLoader(tui, theme, `Deriving session tree with ${runner.name}`);
		let settled = false;
		const finish = (result: Result) => {
			if (!settled) {
				settled = true;
				done(result);
			}
		};
		loader.onAbort = () => finish({ kind: "cancelled" });
		void (async () => {
			try {
				const proposal = await proposeTree(snapshot, {
					input,
					model: runner,
					signal: loader.signal,
					onProgress: (message) => {
						if (!loader.signal.aborted) ctx.ui.setStatus("tree-proposal", message);
					},
				});
				if (loader.signal.aborted) finish({ kind: "cancelled" });
				else finish({ kind: "ok", proposal });
			} catch (error) {
				finish(loader.signal.aborted ? { kind: "cancelled" } : { kind: "error", error });
			} finally {
				loader.dispose();
				ctx.ui.setStatus("tree-proposal", undefined);
			}
		})();
		return loader;
	});
	if (result.kind === "error") throw result.error;
	return result.kind === "ok" ? result.proposal : undefined;
}

/** Derive, review and save a plan without creating or switching a session. */
export async function handleTreeProposal(
	raw: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const args = parseProposalArguments(raw);
	const source = args.source ?? ctx.sessionManager.getSessionFile();
	if (!source) throw new Error("No session file is available; provide a session.jsonl path");
	const snapshot = await readSessionSnapshot(resolve(ctx.cwd, source));
	validateCompleteToolCalls(snapshot);
	const loaded = await loadTreeNavigatorConfig({
		agentDir: getAgentDir(),
		projectPath: join(ctx.cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME),
		projectTrusted: ctx.isProjectTrusted(),
		runtime: readRuntimeConfig(ctx.sessionManager.getSessionId()),
	});
	for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
	if (args.llm && loaded.config.proposalError) throw new Error(loaded.config.proposalError);
	const input = mergeProposalOptions(loaded.config.proposal ?? { tools: {} }, args.input);
	const generated = args.llm
		? await modelProposal(snapshot, input, ctx, pi)
		: await proposeTree(snapshot, { input });
	if (!generated) {
		ctx.ui.notify("Tree proposal cancelled; no files were written.", "info");
		return;
	}
	const proposal = validateTreeProposal(snapshot, generated);
	let plan = proposal.plan;
	if (ctx.hasUI) {
		const reviewed = await reviewProposal(ctx, snapshot, proposal);
		if (!reviewed) {
			ctx.ui.notify("Tree proposal cancelled; no plan was saved.", "info");
			return;
		}
		plan = reviewed;
	}
	const path = await saveTreeProposal(
		snapshot,
		plan,
		args.output ? resolve(ctx.cwd, args.output) : undefined,
	);
	ctx.ui.notify(
		`Saved ${proposal.method} tree proposal at ${path}. Review with /anchor clone preview "${path}", then /anchor clone create "${path}". No session was created or switched.${proposal.warnings.length ? ` ${proposal.warnings.join(" ")}` : ""}`,
		proposal.warnings.length ? "warning" : "info",
	);
}
