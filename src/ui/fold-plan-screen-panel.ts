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
} from "@earendil-works/pi-tui";
import { formatPct1, formatWindow, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type {
	FoldPlan,
	FoldPlanCandidate,
	FoldPlanDeps,
	FoldPlanResult,
} from "./fold-plan-screen.ts";
import {
	candidateRow,
	describeResult,
	EMPTY_ROW,
	formatTokens,
	INDENT,
	labelOf,
	type Message,
	type Mode,
	NO_ANCHORS,
	NO_REASON,
	oneLine,
	type PanelExit,
	type PlanState,
	packSegments,
	padTo,
	SEARCH_ENTER,
	SEARCH_PLACEHOLDER,
	STATUS_ROWS,
	wrapClamp,
} from "./fold-plan-screen-state.ts";
import {
	type FrameHost,
	type FrameKeybinding,
	FrameList,
	type FrameTheme,
	frameShortcutKey,
	renderFrame,
} from "./frame.ts";

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
export class FoldPlanPanel implements Component, Focusable {
	private mode: Mode = { kind: "plan" };
	private status: Message | undefined;
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
		const lines = [...frame.slice(0, 2), ...block, ...frame.slice(3)];
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
		return lines.at(-2) ?? "";
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
		const edit: FrameKeybinding = {
			key: frameShortcutKey("e"),
			action: "edit label/focus",
			priority: "navigation",
		};
		if (this.list.isSearching) {
			return [
				{ key: "type", action: "to filter", priority: "essential" },
				choose,
				...(this.selected()?.valid ? [edit] : []),
				{ key: "esc", action: "clear search", priority: "essential" },
			];
		}
		const leave: FrameKeybinding = {
			key: "esc",
			action: this.list.search ? "clear search" : "back",
			priority: "essential",
		};
		const search: FrameKeybinding = {
			key: "type",
			action: "filter",
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
			edit,
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
