/** Fold plan state, dialog edits and presentation shared by the panel and text entry points. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isValidName, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type { FoldSummaryProgress } from "../fold/fold-summarizer.ts";
import type { FoldPlanCandidate, FoldPlanDeps, FoldPlanResult } from "./fold-plan-screen.ts";
import { type FrameRow, type FrameTheme, type FrameTone, sanitizeTerminalText } from "./frame.ts";

export const INDENT = " ".repeat(3);
const SEPARATOR = " · ";
export const STATUS_ROWS = 2;
export const NO_REASON = "This anchor cannot be folded.";
export const NO_ANCHORS =
	'There is no anchor to fold to. Run /anchor list and select "+ Set new anchor at current leaf…" with Enter.';
export const SEARCH_PLACEHOLDER = "Type to filter anchors and previews…";
export const SEARCH_ENTER =
	"enter does not fold while searching · esc clears the search, then enter folds the selected anchor";

export const formatTokens = (tokens: number): string =>
	tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

export const oneLine = (text: string): string =>
	sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Lowercase kebab-case from whatever was typed; accents drop, other symbols become hyphens. */
function toKebab(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function candidateRow(candidate: FoldPlanCandidate, recommended: boolean): FrameRow {
	// The value column is never clipped by long anchor names, so the recommendation lives there.
	return {
		label: `◆ ${candidate.name}`,
		labelHint: candidate.auto ? "(auto)" : undefined,
		value: candidate.valid
			? `−${formatTokens(Math.max(0, candidate.beforeTokens - candidate.projectedAfterTokens))} tok${recommended ? " · recommended" : ""}`
			: "not foldable",
		tone: candidate.valid ? (recommended ? "accent" : "text") : "muted",
		detail: candidate.afterPreview ? `after: “${candidate.afterPreview}”` : undefined,
		// Only refusals carry a description: boilerplate would match every search.
		description: candidate.valid ? undefined : (candidate.reason ?? NO_REASON),
	};
}

export const EMPTY_ROW: FrameRow = {
	label: "",
	labelHint: "No anchors yet.",
	tone: "muted",
	description:
		'Run /anchor list and select "+ Set new anchor at current leaf…" with Enter; a fold collapses the work since an anchor.',
};

/** Wrapped to `rows` lines; the last one ends in an ellipsis when text is lost. */
export function wrapClamp(text: string, width: number, rows: number): string[] {
	const lines = wrapTextWithAnsi(text, Math.max(1, width));
	if (lines.length <= rows) return lines;
	const kept = lines.slice(0, rows);
	kept[rows - 1] = `${truncateToWidth(kept[rows - 1] ?? "", Math.max(0, width - 1), "")}…`;
	return kept;
}

/** Greedy line packing: whole segments share a line when they fit, so a fact is never split. */
export function packSegments(
	segments: readonly string[],
	width: number,
	theme: FrameTheme,
): string[] {
	const lines: string[] = [];
	let line = "";
	for (const segment of segments) {
		const part = truncateToWidth(segment, width, "…");
		if (line && visibleWidth(line) + SEPARATOR.length + visibleWidth(part) <= width) {
			line += theme.fg("dim", SEPARATOR) + part;
		} else {
			if (line) lines.push(line);
			line = part;
		}
	}
	if (line) lines.push(line);
	return lines;
}

export const padTo = (lines: readonly string[], rows: number): string[] => [
	...lines,
	...Array<string>(Math.max(0, rows - lines.length)).fill(""),
];

/** Screen state that survives the edit dialogs between two renders of the panel. */
export interface PlanState {
	/** Newest first. */
	candidates: FoldPlanCandidate[];
	recommended?: string | undefined;
	selected: number;
	/** Labels the user typed, per anchor; every other anchor shows its suggestion. */
	labels: Map<string, string>;
	/** Kept while switching anchors; absent when the host supplies the default. */
	focus?: string | undefined;
}

export function openState(ctx: ExtensionCommandContext, deps: FoldPlanDeps): PlanState {
	const chronological = deps.candidates(ctx);
	const index = deps.recommend(chronological);
	const recommended =
		index !== undefined && chronological[index]?.valid ? chronological[index] : undefined;
	const candidates = [...chronological].reverse();
	const pick = recommended
		? candidates.indexOf(recommended)
		: candidates.findIndex((candidate) => candidate.valid);
	return {
		candidates,
		recommended: recommended?.name,
		selected: Math.max(0, pick),
		labels: new Map(),
	};
}

export const labelOf = (state: PlanState, candidate: FoldPlanCandidate): string =>
	state.labels.get(candidate.name) ?? candidate.suggestedLabel;

export type PanelExit = { kind: "close"; result: "back" | "done" } | { kind: "edit" };

export type Mode =
	| { kind: "plan" }
	| { kind: "running"; progress?: FoldSummaryProgress; cancelling: boolean }
	| { kind: "finished"; tone: FrameTone; text: string; exit: "back" | "done" };

export interface Message {
	tone: FrameTone;
	text: string;
}

export function describeResult(result: FoldPlanResult): Extract<Mode, { kind: "finished" }> {
	switch (result.status) {
		case "done":
			return {
				kind: "finished",
				tone: "success",
				exit: "done",
				text: `✓ folded as '${result.label}' · freed ~${formatTokens(Math.max(0, result.beforeTokens - result.afterTokens))} tok (now ~${formatTokens(result.afterTokens)}) · ${result.strategy} · ${plural(result.calls, "call")}`,
			};
		case "failed":
			return {
				kind: "finished",
				tone: "error",
				exit: "back",
				text: `✗ failed at ${result.stage}: ${oneLine(result.detail) || result.reason}`,
			};
		case "cancelled":
			return {
				kind: "finished",
				tone: "warning",
				exit: "back",
				text: "■ cancelled — nothing was changed",
			};
		case "busy":
			return {
				kind: "finished",
				tone: "warning",
				exit: "back",
				text: "⚠ another fold is already running for this session",
			};
	}
}

/** Ask for the label, then the focus, of the selected anchor; Esc leaves what was not yet answered. */
export async function editPlan(
	ctx: ExtensionCommandContext,
	deps: FoldPlanDeps,
	state: PlanState,
): Promise<void> {
	const candidate = state.candidates[state.selected];
	if (!candidate) return;
	const current = labelOf(state, candidate);
	while (true) {
		const input = await ctx.ui.input(
			`Name the summary (kebab-case, at most ${MAX_NAME_LENGTH} characters; Enter keeps '${current}')`,
			current,
		);
		if (input === undefined) return;
		const typed = input.trim();
		const label = typed ? toKebab(typed) : current;
		if (!isValidName(label)) {
			ctx.ui.notify(
				`'${typed}' cannot be a label: use lowercase kebab-case, at most ${MAX_NAME_LENGTH} characters (e.g. '${candidate.suggestedLabel}').`,
				"warning",
			);
		} else if (label !== current && state.candidates.some(({ name }) => name === label)) {
			ctx.ui.notify(
				`An anchor named '${label}' already exists on this branch; pick a fresh name (e.g. '${candidate.suggestedLabel}').`,
				"warning",
			);
		} else {
			state.labels.set(candidate.name, label);
			break;
		}
	}
	let text = state.focus ?? "";
	while (true) {
		const raw = await ctx.ui.editor(
			"Summary focus: latest instruction, what is done, what remains (empty: use default)",
			text,
		);
		if (raw === undefined) return;
		const focus = sanitizeTerminalText(raw).trim();
		if (focus.length >= deps.minFocusLength || !focus) {
			state.focus = focus || undefined;
			return;
		}
		ctx.ui.notify(
			`That focus has ${focus.length} characters; it needs at least ${deps.minFocusLength}. Add detail, or clear it to use the latest request and open work.`,
			"warning",
		);
		text = raw;
	}
}
