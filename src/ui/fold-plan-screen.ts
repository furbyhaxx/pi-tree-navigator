/**
 * `/anchor fold`: one screen with a recommended fold plan.
 *
 * The plan names the target anchor, the summary label, the projected result and the
 * summary strategy. Enter folds, `e` edits label and focus, the arrows, the wheel and
 * a click pick another anchor (a second click folds), `/` filters anchors and previews,
 * Esc clears the filter, then leaves (or cancels a running fold). The host supplies
 * every session and engine access through `FoldPlanDeps`; this module imports neither.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	type Keybinding,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatPct1, formatWindow, isValidName, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type { FoldOutcome } from "../fold/fold-engine.ts";
import type { FoldSummaryProgress } from "../fold/fold-summarizer.ts";
import {
	type FrameHost,
	type FrameKeybinding,
	FrameList,
	type FrameRow,
	type FrameTheme,
	type FrameTone,
	renderFrame,
	sanitizeTerminalText,
} from "./frame.ts";

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

const INDENT = " ".repeat(3);
const SEPARATOR = " · ";
const STATUS_ROWS = 2;
const NO_REASON = "This anchor cannot be folded.";
const NO_ANCHORS = "There is no anchor to fold to. Run /anchor list and press n to set one.";
const SEARCH_PLACEHOLDER = "Press / to search anchors and previews…";
const SEARCH_ENTER =
	"enter does not fold while searching · esc clears the search, then enter folds the selected anchor";

const formatTokens = (tokens: number): string =>
	tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

const oneLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

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

function candidateRow(candidate: FoldPlanCandidate, recommended: boolean): FrameRow {
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

const EMPTY_ROW: FrameRow = {
	label: "",
	labelHint: "No anchors yet.",
	tone: "muted",
	description:
		"Run /anchor list and press n to anchor the current leaf; a fold collapses the work since an anchor.",
};

/** Wrapped to `rows` lines; the last one ends in an ellipsis when text is lost. */
function wrapClamp(text: string, width: number, rows: number): string[] {
	const lines = wrapTextWithAnsi(text, Math.max(1, width));
	if (lines.length <= rows) return lines;
	const kept = lines.slice(0, rows);
	kept[rows - 1] = `${truncateToWidth(kept[rows - 1], Math.max(0, width - 1), "")}…`;
	return kept;
}

/** Greedy line packing: whole segments share a line when they fit, so a fact is never split. */
function packSegments(segments: readonly string[], width: number, theme: FrameTheme): string[] {
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

const padTo = (lines: readonly string[], rows: number): string[] => [
	...lines,
	...Array<string>(Math.max(0, rows - lines.length)).fill(""),
];

/** Screen state that survives the dialogs `e` opens between two renders of the panel. */
interface PlanState {
	/** Newest first. */
	candidates: FoldPlanCandidate[];
	recommended?: string;
	selected: number;
	/** Labels the user typed, per anchor; every other anchor shows its suggestion. */
	labels: Map<string, string>;
	/** Kept while switching anchors; absent when the host supplies the default. */
	focus?: string;
}

function openState(ctx: ExtensionCommandContext, deps: FoldPlanDeps): PlanState {
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

const labelOf = (state: PlanState, candidate: FoldPlanCandidate): string =>
	state.labels.get(candidate.name) ?? candidate.suggestedLabel;

type PanelExit = { kind: "close"; result: "back" | "done" } | { kind: "edit" };

type Mode =
	| { kind: "plan" }
	| { kind: "running"; progress?: FoldSummaryProgress; cancelling: boolean }
	| { kind: "finished"; tone: FrameTone; text: string; exit: "back" | "done" };

interface Message {
	tone: FrameTone;
	text: string;
}

function describeResult(result: FoldPlanResult): Extract<Mode, { kind: "finished" }> {
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

interface PanelOptions {
	ctx: ExtensionCommandContext;
	deps: FoldPlanDeps;
	state: PlanState;
	model: string;
	tui: FrameHost;
	theme: FrameTheme;
	keyboard?: KeybindingsManager;
	done(exit: PanelExit): void;
}

/**
 * The frame with the plan between the search row and the list. The list owns search,
 * selection and the mouse; every state renders the same number of lines.
 */
class FoldPlanPanel implements Component, Focusable {
	private mode: Mode = { kind: "plan" };
	private status?: Message;
	private controller?: AbortController;
	private frozen?: { width: number; terminalRows: number };
	private planRows = 1;
	/** Lines the plan block adds to the frame; the mouse rows below it shift by this. */
	private extraRows = 0;
	private readonly list: FrameList;
	private readonly options: PanelOptions;

	constructor(options: PanelOptions) {
		this.options = options;
		const { candidates, recommended, selected } = options.state;
		const badge = () => this.badge();
		this.list = new FrameList({
			tui: options.tui,
			theme: options.theme,
			keyboard: options.keyboard,
			breadcrumbs: ["Anchor", "Fold"],
			rows: candidates.length
				? candidates.map((candidate) => candidateRow(candidate, candidate.name === recommended))
				: [EMPTY_ROW],
			cursor: selected,
			placeholder: SEARCH_PLACEHOLDER,
			get rightBadge() {
				return badge();
			},
			onSelect: (_row, index) => this.fold(index),
			onCancel: () => options.done({ kind: "close", result: "back" }),
			shortcuts: [
				{
					key: "e",
					action: "edit label/focus",
					enabled: (_row, index) => candidates[index]?.valid === true,
					onPress: () => options.done({ kind: "edit" }),
				},
			],
		});
	}

	get focused(): boolean {
		return this.list.focused;
	}

	set focused(value: boolean) {
		this.list.focused = value;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const columns = Math.max(0, Math.floor(width));
		const frame = this.list.render(columns);
		this.freeze(columns);
		const block = this.block(columns);
		// The block takes the place of the frame's blank row under the search row.
		this.extraRows = block.length - 1;
		const lines = [frame[0], frame[1], ...block, ...frame.slice(3)];
		lines[lines.length - 2] = this.hintLine(columns);
		return lines;
	}

	handleInput(data: string): void {
		const { mode } = this;
		const leaving =
			matchesKey(data, Key.ctrl("c")) || this.matches(data, "tui.select.cancel", Key.escape);
		if (mode.kind === "running") {
			if (leaving && !mode.cancelling) {
				mode.cancelling = true;
				this.controller?.abort();
			}
		} else if (mode.kind === "finished") {
			const confirm = this.matches(data, "tui.select.confirm", Key.enter);
			if (confirm && mode.exit === "back") {
				// Back to the plan with the outcome kept: retry, or pick another anchor.
				this.status = { tone: mode.tone, text: mode.text };
				this.mode = { kind: "plan" };
			} else if (leaving || confirm) {
				this.options.done({ kind: "close", result: mode.exit });
			}
		} else if (this.matches(data, "tui.select.confirm", Key.enter) && this.list.isSearching) {
			this.status = { tone: "muted", text: SEARCH_ENTER };
		} else {
			this.track(() => this.list.handleInput(data));
		}
		this.options.tui.requestRender();
	}

	/** Mouse rows are the list's own once the plan block above them is taken out. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.mode.kind !== "plan") return undefined;
		const y = event.y <= 1 ? event.y : Math.max(2, event.y - this.extraRows);
		let result: TuiMouseEventResult | undefined;
		this.track(() => {
			result = this.list.handleMouse({ ...event, y });
		});
		return result;
	}

	private matches(data: string, id: Keybinding, fallback: KeyId): boolean {
		const { keyboard } = this.options;
		return keyboard ? keyboard.matches(data, id) : matchesKey(data, fallback);
	}

	/** Runs a list interaction; the chosen anchor outlives the panel, and a new choice drops an old status. */
	private track(act: () => void): void {
		const { cursor, search } = this.list;
		act();
		if (this.list.cursor !== cursor || this.list.search !== search) this.status = undefined;
		if (this.list.cursor >= 0) this.options.state.selected = this.list.cursor;
	}

	private selected(): FoldPlanCandidate | undefined {
		return this.options.state.candidates[this.list.cursor];
	}

	private agentRunning(): boolean {
		return this.options.deps.isAgentRunning(this.options.ctx);
	}

	/** `index` addresses the unfiltered candidates, whatever the list shows. */
	private fold(index: number): void {
		if (this.mode.kind !== "plan") return;
		const { ctx, deps, state } = this.options;
		const candidate = state.candidates[index];
		if (!candidate) {
			this.status = { tone: "warning", text: NO_ANCHORS };
			return;
		}
		if (!candidate.valid) {
			this.status = {
				tone: "warning",
				text: `✗ ${oneLine(candidate.reason ?? NO_REASON)}`,
			};
			return;
		}
		const plan: FoldPlan = {
			anchor: candidate.name,
			label: labelOf(state, candidate),
			...(state.focus !== undefined && { focus: state.focus }),
		};
		if (!this.agentRunning()) {
			void this.run(plan);
			return;
		}
		const queued = deps.queue(ctx, plan);
		if (queued.ok) {
			this.mode = {
				kind: "finished",
				tone: "success",
				exit: "done",
				text: "✓ queued — folds at the next turn boundary",
			};
		} else {
			this.status = { tone: "warning", text: `✗ ${oneLine(queued.reason)}` };
		}
	}

	private async run(plan: FoldPlan): Promise<void> {
		const { ctx, deps, tui } = this.options;
		const controller = new AbortController();
		const running: Extract<Mode, { kind: "running" }> = {
			kind: "running",
			cancelling: false,
		};
		this.controller = controller;
		this.mode = running;
		let result: FoldPlanResult;
		try {
			result = await deps.start(ctx, plan, {
				signal: controller.signal,
				onProgress: (progress) => {
					running.progress = progress;
					tui.requestRender();
				},
			});
		} catch (error) {
			result = {
				status: "failed",
				stage: "gate",
				reason: "exception",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		this.mode = describeResult(result);
		tui.requestRender();
	}

	/** Plan rows are frozen on the first render and again when the width or the terminal height changes. */
	private freeze(width: number): void {
		const terminalRows = this.options.tui.terminal.rows;
		if (this.frozen?.width === width && this.frozen.terminalRows === terminalRows) return;
		this.frozen = { width, terminalRows };
		const longest = "x".repeat(MAX_NAME_LENGTH);
		const available = Math.max(1, width - INDENT.length);
		this.planRows = Math.max(
			1,
			...this.options.state.candidates
				.filter((candidate) => candidate.valid)
				.map(
					(candidate) =>
						packSegments(this.segments(candidate, longest), available, this.options.theme).length,
				),
		);
	}

	private badge(): string | undefined {
		const { candidates } = this.options.state;
		if (this.mode.kind === "running") return "folding";
		if (!candidates.length) return undefined;
		const foldable = `${candidates.filter(({ valid }) => valid).length} of ${candidates.length} foldable`;
		return this.mode.kind === "plan" && this.agentRunning()
			? `agent working · ${foldable}`
			: foldable;
	}

	/** The list draws its own hints; they know nothing of the fold states, so the frame draws these instead. */
	private hintLine(width: number): string {
		const lines = renderFrame({
			width,
			terminalRows: this.options.tui.terminal.rows,
			breadcrumbs: [],
			rows: [],
			cursor: 0,
			scrollOffset: 0,
			keybindings: this.keybindings(),
			theme: this.options.theme,
		});
		return lines[lines.length - 2];
	}

	private keybindings(): FrameKeybinding[] {
		const { mode } = this;
		if (mode.kind === "running") {
			return mode.cancelling
				? [{ key: "…", action: "cancelling", priority: "essential" }]
				: [{ key: "esc", action: "cancel", priority: "essential" }];
		}
		if (mode.kind === "finished")
			return mode.exit === "back"
				? [
						{ key: "enter", action: "back to plan", priority: "essential" },
						{ key: "esc", action: "close", priority: "essential" },
					]
				: [{ key: "enter/esc", action: "close", priority: "essential" }];
		const choose: FrameKeybinding = {
			key: "↑↓",
			action: "choose anchor",
			priority: "navigation",
		};
		if (this.list.isSearching) {
			return [
				{ key: "type", action: "to filter" },
				choose,
				{ key: "esc", action: "clear search", priority: "essential" },
			];
		}
		const leave: FrameKeybinding = {
			key: "esc",
			action: this.list.search ? "clear search" : "back",
			priority: "essential",
		};
		const search: FrameKeybinding = {
			key: "/",
			action: "search",
			priority: "essential",
		};
		if (!this.selected()?.valid) return [choose, search, leave];
		return [
			choose,
			{
				key: "enter",
				action: this.agentRunning() ? "queue fold" : "fold",
				priority: "essential",
			},
			{ key: "e", action: "edit label/focus", priority: "navigation" },
			search,
			leave,
		];
	}

	private segments(candidate: FoldPlanCandidate, label: string): string[] {
		const { theme, model } = this.options;
		const window = formatWindow(candidate.contextWindow);
		const size = `~${formatTokens(candidate.beforeTokens)} → ~${formatTokens(candidate.projectedAfterTokens)} tok`;
		return [
			theme.fg("muted", "rewind to ") + theme.bold(candidate.name),
			`${theme.fg("muted", "label ")}${label}`,
			window
				? `${size} of ${window} (${formatPct1(candidate.projectedAfterTokens, candidate.contextWindow)})`
				: size,
			`${candidate.strategy} ${theme.fg("muted", "via")} ${oneLine(model)}`,
		];
	}

	private message(): Message | undefined {
		const { mode } = this;
		if (mode.kind === "finished") return mode;
		if (mode.kind === "running") {
			const { progress } = mode;
			if (mode.cancelling) return { tone: "warning", text: "⠋ cancelling the fold…" };
			return {
				tone: "accent",
				text: progress
					? `⠋ folding · ${progress.phase} · call ${progress.call}/${progress.plannedCalls}`
					: "⠋ folding · preparing the summary…",
			};
		}
		if (this.status) return this.status;
		return this.selected()?.valid && this.agentRunning()
			? {
					tone: "warning",
					text: "⚠ agent working · folds at the next turn boundary",
				}
			: undefined;
	}

	/** Plan, focus and status rows; their count does not depend on the state. */
	private block(width: number): string[] {
		const { state, theme } = this.options;
		const available = Math.max(1, width - INDENT.length);
		const candidate = this.selected();
		let plan: string[];
		let focus = "";
		if (!candidate) {
			plan = [
				theme.fg(
					"muted",
					state.candidates.length
						? `No plan: no anchor matches “${oneLine(this.list.search)}”.`
						: "No plan: there is no anchor to fold to.",
				),
			];
		} else if (!candidate.valid) {
			plan = [theme.fg("warning", `✗ cannot fold to ${candidate.name}`)];
		} else {
			plan = packSegments(this.segments(candidate, labelOf(state, candidate)), available, theme);
			focus =
				theme.fg("muted", "focus: ") +
				(state.focus === undefined ? "latest request and open work" : `“${oneLine(state.focus)}”`);
		}
		const message = this.message();
		const status = message
			? wrapClamp(message.text, available, STATUS_ROWS).map((line) => theme.fg(message.tone, line))
			: [];
		return [
			...padTo(plan.slice(0, this.planRows), this.planRows),
			focus,
			...padTo(status, STATUS_ROWS),
			"",
		].map((line) => truncateToWidth(line && INDENT + line, Math.max(0, width), "…"));
	}
}

/** Ask for the label, then the focus, of the selected anchor; Esc leaves what was not yet answered. */
async function editPlan(
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
