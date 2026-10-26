/**
 * `/anchor fold` plan contracts and entry points for interactive and headless confirmation.
 * The host supplies every session and engine access through `FoldPlanDeps`.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isValidName, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type { FoldOutcome } from "../fold/fold-engine.ts";
import type { FoldSummaryProgress } from "../fold/fold-summarizer.ts";
import { FoldPlanPanel } from "./fold-plan-screen-panel.ts";
import {
	describeResult,
	editPlan,
	formatTokens,
	NO_ANCHORS,
	NO_REASON,
	oneLine,
	openState,
	type PanelExit,
} from "./fold-plan-screen-state.ts";

/** One anchor a fold could target; the host lists them root to leaf. */
export interface FoldPlanCandidate {
	name: string;
	/** Written by the extension itself rather than by the agent or the user. */
	auto?: boolean;
	afterPreview?: string;
	/** False when a fold to this anchor is refused; `reason` says why. */
	valid: boolean;
	reason?: string;
	beforeTokens: number;
	projectedAfterTokens: number;
	/** 0 when unknown. */
	contextWindow: number;
	/** What the summarizer will use for this anchor. */
	strategy: "in-context" | "chunked";
	/** A fresh kebab-case label for the summary of a fold to this anchor. */
	suggestedLabel: string;
}

/** What the user confirmed. An absent focus uses the latest request and open work. */
export interface FoldPlan {
	anchor: string;
	label: string;
	focus?: string;
}

/** How a fold ended, as the screen reports it. */
export type FoldPlanResult =
	| {
			status: "done";
			label: string;
			beforeTokens: number;
			afterTokens: number;
			strategy: "in-context" | "chunked";
			calls: number;
	  }
	| {
			status: "failed";
			stage: "gate" | "summary" | "commit";
			reason: string;
			detail: string;
	  }
	| { status: "cancelled" }
	| { status: "busy" };

/** Session and engine access the screen needs; supplied by the extension entry point. */
export interface FoldPlanDeps {
	/** Anchors on the active branch, root to leaf; recomputed each time the screen opens. */
	candidates(ctx: ExtensionCommandContext): FoldPlanCandidate[];
	/** Index into `candidates` of the anchor to preselect, if any. */
	recommend(candidates: readonly FoldPlanCandidate[]): number | undefined;
	isAgentRunning(ctx: ExtensionCommandContext): boolean;
	/** The model that writes the summary, e.g. `openai/gpt-6-luna:low`. */
	summaryModel(ctx: ExtensionCommandContext): string;
	/** Shortest focus accepted after trimming. */
	minFocusLength: number;
	/** Fold now; the host aborts at `signal` and reports each summary call through `onProgress`. */
	start(
		ctx: ExtensionCommandContext,
		plan: FoldPlan,
		options: {
			signal: AbortSignal;
			onProgress(progress: FoldSummaryProgress): void;
		},
	): Promise<FoldPlanResult>;
	/** The agent is running: fold at its next turn boundary instead. */
	queue(ctx: ExtensionCommandContext, plan: FoldPlan): { ok: true } | { ok: false; reason: string };
}

/** A fold engine outcome as the screen shows it; the commit does not carry the token figures, so the host passes them. */
export function foldPlanResult(
	outcome: FoldOutcome,
	done: { label: string; beforeTokens: number; afterTokens: number },
): FoldPlanResult {
	switch (outcome.status) {
		case "done":
			return {
				status: "done",
				...done,
				strategy: outcome.strategy,
				calls: outcome.calls,
			};
		case "failed":
			return {
				status: "failed",
				stage: outcome.stage,
				reason: outcome.reason,
				detail: outcome.detail,
			};
		case "cancelled":
			return { status: "cancelled" };
		case "busy":
			return { status: "busy" };
	}
}

const HEADLESS_USAGE =
	"Run /anchor fold <anchor|recommended> [new-label] to fold; the default label is suggested from the anchor.";

/**
 * `/anchor fold` without a UI. No argument prints the plan; `<anchor|recommended> [label]`
 * is the explicit confirmation and folds now, or at the next turn boundary while the agent runs.
 */
export async function runFoldWithoutUi(
	ctx: ExtensionCommandContext,
	deps: FoldPlanDeps,
	args: string,
): Promise<void> {
	const state = openState(ctx, deps);
	const [anchorArg, labelArg, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	if (!anchorArg) {
		const rows = state.candidates.map((candidate) => {
			const value = candidate.valid
				? `−${formatTokens(Math.max(0, candidate.beforeTokens - candidate.projectedAfterTokens))} tok · ${candidate.strategy}${candidate.name === state.recommended ? " · recommended" : ""}`
				: `not foldable: ${oneLine(candidate.reason ?? NO_REASON)}`;
			return `  ◆ ${candidate.name}  ${value}`;
		});
		ctx.ui.notify(
			rows.length
				? [
						`Fold plan (newest first) · summary by ${deps.summaryModel(ctx)}`,
						...rows,
						HEADLESS_USAGE,
					].join("\n")
				: NO_ANCHORS,
			"info",
		);
		return;
	}
	if (extra.length) {
		ctx.ui.notify(`Too many arguments. ${HEADLESS_USAGE}`, "warning");
		return;
	}
	const name = anchorArg === "recommended" ? state.recommended : anchorArg;
	const candidate = state.candidates.find((entry) => entry.name === name);
	if (!candidate) {
		ctx.ui.notify(
			name
				? `No anchor '${name}' on the active branch. Run /anchor fold to see the plan.`
				: "No anchor fits the recommendation budget. Run /anchor fold to see the plan and name an anchor.",
			"warning",
		);
		return;
	}
	if (!candidate.valid) {
		ctx.ui.notify(
			`'${candidate.name}' cannot be folded: ${oneLine(candidate.reason ?? NO_REASON)}`,
			"warning",
		);
		return;
	}
	const label = labelArg ?? candidate.suggestedLabel;
	if (!isValidName(label)) {
		ctx.ui.notify(
			`'${label}' cannot be a label: use lowercase kebab-case, at most ${MAX_NAME_LENGTH} characters (e.g. '${candidate.suggestedLabel}').`,
			"warning",
		);
		return;
	}
	if (state.candidates.some((entry) => entry.name === label)) {
		ctx.ui.notify(
			`An anchor named '${label}' already exists on this branch; pick a fresh name (e.g. '${candidate.suggestedLabel}').`,
			"warning",
		);
		return;
	}
	const plan: FoldPlan = { anchor: candidate.name, label };
	if (deps.isAgentRunning(ctx)) {
		const queued = deps.queue(ctx, plan);
		ctx.ui.notify(
			queued.ok
				? `Fold to '${plan.anchor}' as '${label}' queued; it runs at the next turn boundary.`
				: `Fold not queued: ${queued.reason}`,
			queued.ok ? "info" : "warning",
		);
		return;
	}
	const result = await deps.start(ctx, plan, {
		signal: new AbortController().signal,
		onProgress() {},
	});
	const finished = describeResult(result);
	ctx.ui.notify(finished.text, finished.tone === "success" ? "info" : "warning");
}

/**
 * Show the fold plan until a fold finished or was queued ("done") or the user left ("back").
 * Edits happen between two renders of the panel, because dialogs replace the screen.
 */
export async function openFoldPlanScreen(
	ctx: ExtensionCommandContext,
	deps: FoldPlanDeps,
): Promise<"back" | "done"> {
	const state = openState(ctx, deps);
	while (true) {
		const model = deps.summaryModel(ctx);
		const exit = await ctx.ui.custom<PanelExit | undefined>(
			(tui, theme, keyboard, done) =>
				new FoldPlanPanel({
					ctx,
					deps,
					state,
					model,
					tui,
					theme,
					keyboard,
					done,
				}),
		);
		if (exit?.kind !== "edit") return exit?.result ?? "back";
		await editPlan(ctx, deps, state);
	}
}
