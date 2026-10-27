/**
 * Editor-replacing frame list, input controller and screen selection for `/anchor`.
 *
 * Ported from pi-bolt-subagents' `FrameList`, extended with a fuzzy search
 * row, a right-hand badge in the top rule and a per-row detail line.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	type Keybinding,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	type FrameLayout,
	type FrameOptions,
	frameContent,
	measureFrame,
	rowLines,
} from "./frame-rendering.ts";
import { cleanTerminalText, printable, singleLine } from "./frame-text.ts";

/** Semantic theme subset the frame draws with. */
export type FrameTheme = Pick<Theme, "fg" | "bold" | "italic">;

/** Theme colour tokens a row value may use. */
export type FrameTone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

/** One list entry. Every string is untrusted text; the frame styles it. */
export interface FrameRow {
	label: string;
	/** Dim suffix after the label, e.g. `(auto)`. */
	labelHint?: string | undefined;
	/** Right column, aligned across the whole unfiltered list. */
	value?: string;
	/** Colour of `value`. */
	tone?: FrameTone;
	/** One line shown under the row while it is selected. */
	detail?: string | undefined;
	/** Help shown in the description slot while the row is selected. */
	description?: string | undefined;
}

/** Hint-bar survival order on narrow terminals: essential hints are dropped last. */
export type FrameKeybindingPriority = "essential" | "navigation" | "optional";

/** Visible key/action pair in the hint bar. */
export interface FrameKeybinding {
	key: string;
	action: string;
	/** Default `optional`. */
	priority?: FrameKeybindingPriority | undefined;
}

/** Strip terminal escape sequences and control characters; tab and newline survive. */
export function sanitizeTerminalText(text: string): string {
	return cleanTerminalText(text);
}

/** Render exactly the measured height, with every line bounded by visible columns. */
export function renderFrame(options: FrameOptions): string[] {
	return frameContent(options).lines;
}

/** Structural subset of the TUI injected by `ctx.ui.custom`. */
export interface FrameHost {
	terminal: { rows: number; columns: number };
	requestRender(): void;
}

/** Action on a row; `index` addresses the original `rows` array, not the filtered view. */
export type FrameAction = (row: FrameRow, index: number) => void;

/** Resolve screen mnemonics to left-Alt actions without consuming printable filter text. */
export function frameShortcutKey(key: KeyId): KeyId {
	// de-CH reserves AltGr+E for €; use I (inspect) for edit actions.
	if (key === "e") return Key.alt("i");
	const mnemonic = (
		[
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
			"j",
			"k",
			"l",
			"m",
			"n",
			"o",
			"p",
			"q",
			"r",
			"s",
			"t",
			"u",
			"v",
			"w",
			"x",
			"y",
			"z",
		] as const
	).find((letter) => letter === key);
	return mnemonic ? Key.alt(mnemonic) : key;
}

/** A row action; single-letter mnemonics use Alt and remain active during filtering. */
export interface FrameShortcut {
	key: KeyId;
	priority?: FrameKeybindingPriority | undefined;
	/** Hint-bar label; a function is resolved for the selected row. */
	action: string | ((row: FrameRow, index: number) => string);
	/** Hidden and ignored on rows where this returns false. */
	enabled?: (row: FrameRow, index: number) => boolean;
	onPress: FrameAction;
}

/** Controller inputs. */
export interface FrameListOptions {
	tui: FrameHost;
	theme: FrameTheme;
	breadcrumbs: readonly string[];
	rows: readonly FrameRow[];
	rightBadge?: string | undefined;
	placeholder?: string;
	/** Hint-bar label for Enter. Default `select`. */
	enterAction?: string;
	/** Hint-bar label for Escape in list focus. Default `back`. */
	cancelAction?: string;
	keyboard?: KeybindingsManager | undefined;
	/** Initial row index. */
	cursor?: number;
	/** Restore a filter when a wrapper rebuilds the list on resize. */
	query?: string | undefined;
	onSelect?: FrameAction;
	onCancel?: () => void;
	shortcuts?: readonly FrameShortcut[] | undefined;
}

/**
 * Fixed-height list with a fuzzy search row.
 *
 * Printable input, including `/`, filters; Alt mnemonics activate row actions.
 * Space toggles in list focus, but separates terms in an active filter.
 * Escape clears the filter first, then cancels.
 */
export class FrameList implements Component, Focusable {
	private readonly input = new Input({ prompt: "" });
	private query = "";
	private visible: number[];
	private position: number;
	private offset = 0;
	private width: number;
	private layout?: FrameLayout;
	private focus: "list" | "search" = "list";
	private hasFocus = false;
	private mouseRows = new Map<number, number>();

	private readonly options: FrameListOptions;

	constructor(options: FrameListOptions) {
		this.options = options;
		this.visible = options.rows.map((_, index) => index);
		this.position = Math.min(
			Math.max(0, options.cursor ?? 0),
			Math.max(0, this.visible.length - 1),
		);
		this.width = options.tui.terminal.columns;
		if (options.query) {
			this.input.handleInput(`\x1b[200~${options.query}\x1b[201~`);
			this.setQuery(options.query);
			this.enterSearch();
		}
	}

	/** Original index of the selected row, or -1 when the filter matches nothing. */
	get cursor(): number {
		return this.visible[this.position] ?? -1;
	}

	/** The active search text. */
	get search(): string {
		return this.query;
	}

	/** Whether keyboard input is editing the filter rather than selecting a row. */
	get isSearching(): boolean {
		return this.focus === "search";
	}

	/** Propagates focus to the search input for hardware-cursor positioning. */
	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.input.focused = value && this.focus === "search";
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		this.width = Math.max(0, Math.floor(width));
		this.ensureVisible();
		const { lines, mouseRows } = frameContent(this.renderOptions());
		this.mouseRows = mouseRows;
		return lines;
	}

	/** Select or activate rendered rows, focus search, or navigate with the wheel. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.x < 0 ||
			event.x >= this.width ||
			event.y < 0 ||
			event.y >= (this.layout?.height ?? 0)
		)
			return undefined;
		if (event.type === "wheel" && event.wheelDelta && this.visible.length > 0) {
			const previous = this.position;
			this.move(this.position + Math.sign(event.wheelDelta));
			return { handled: true, render: previous !== this.position };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click"))
			return undefined;
		const index = this.mouseRows.get(event.y);
		if (event.y !== 1 && index === undefined) return undefined;
		// Claim the press so Pi synthesizes a click without starting text selection.
		if (event.type === "press") return { handled: true, render: false };
		if (event.y === 1) {
			this.enterSearch();
		} else if (index !== undefined) {
			const position = this.visible.indexOf(index);
			if (position < 0) return undefined;
			this.focus = "list";
			this.input.focused = false;
			const row = this.options.rows[index];
			if (index === this.cursor && row) this.options.onSelect?.(row, index);
			else this.move(position);
		}
		return { handled: true, focus: true, render: true };
	}

	handleInput(data: string): void {
		this.ensureVisible();
		if (matchesKey(data, Key.ctrl("c"))) {
			this.options.onCancel?.();
			return;
		}
		const matches = (id: Keybinding, fallback: KeyId) =>
			this.options.keyboard ? this.options.keyboard.matches(data, id) : matchesKey(data, fallback);
		const page = this.layout?.listRows ?? 1;
		const row = this.options.rows[this.cursor];

		if (matches("tui.select.up", Key.up)) this.move(this.position - 1);
		else if (matches("tui.select.down", Key.down)) this.move(this.position + 1);
		else if (matches("tui.select.pageUp", Key.pageUp)) this.move(this.position - page);
		else if (matches("tui.select.pageDown", Key.pageDown)) this.move(this.position + page);
		else if (matches("tui.select.confirm", Key.enter)) {
			if (row) this.options.onSelect?.(row, this.cursor);
		} else if (matches("tui.select.cancel", Key.escape)) {
			if (this.focus === "search" || this.query) this.leaveSearch();
			else this.options.onCancel?.();
		} else if (this.handleShortcut(data, row)) {
			// Row actions remain available while narrowing the list.
		} else if (matchesKey(data, Key.space) && !this.query) {
			return;
		} else if (this.focus === "search") {
			this.input.handleInput(data);
			this.setQuery(this.input.getValue());
		} else if (matchesKey(data, Key.home)) this.move(0);
		else if (matchesKey(data, Key.end)) this.move(this.visible.length - 1);
		else this.handleListKey(data);
		this.options.tui.requestRender();
	}

	private handleShortcut(data: string, row: FrameRow | undefined): boolean {
		if (this.query && matchesKey(data, Key.space)) return false;
		if (this.focus === "search" && matchesKey(data, Key.backspace)) return false;
		const shortcut = this.options.shortcuts?.find((candidate) =>
			matchesKey(data, frameShortcutKey(candidate.key)),
		);
		if (!shortcut) return false;
		if (row && (shortcut.enabled?.(row, this.cursor) ?? true)) shortcut.onPress(row, this.cursor);
		return true;
	}

	private handleListKey(data: string): void {
		if (printable(data) !== undefined) {
			this.enterSearch();
			this.input.handleInput(data);
			this.setQuery(this.input.getValue());
		}
	}

	private enterSearch(): void {
		this.focus = "search";
		this.input.focused = this.hasFocus;
	}

	private leaveSearch(): void {
		this.focus = "list";
		this.input.focused = false;
		this.input.setValue("");
		const selected = this.cursor;
		this.setQuery("");
		this.position = Math.max(0, selected);
	}

	private setQuery(query: string): void {
		if (query === this.query) return;
		this.query = query;
		const all = this.options.rows.map((_, index) => index);
		this.visible = query ? fuzzyFilter(all, query, (index) => this.searchText(index)) : all;
		this.position = 0;
		this.offset = 0;
	}

	private searchText(index: number): string {
		const row = this.options.rows[index];
		if (!row) return "";
		const { label, labelHint, value, detail, description } = row;
		return [label, labelHint, value, detail, description]
			.filter((part): part is string => Boolean(part))
			.map(singleLine)
			.join(" ");
	}

	private move(position: number): void {
		this.position = Math.min(Math.max(0, position), Math.max(0, this.visible.length - 1));
		this.ensureVisible();
	}

	private keybindings(): FrameKeybinding[] {
		const enter = {
			key: "enter",
			action: this.options.enterAction ?? "select",
			priority: "navigation" as const,
		};
		const navigate = {
			key: "↑↓",
			action: "navigate",
			priority: "navigation" as const,
		};
		const row = this.options.rows[this.cursor];
		const shortcuts = row
			? (this.options.shortcuts ?? [])
					.filter(
						(shortcut) =>
							!(shortcut.key === "space" && this.query) &&
							!(shortcut.key === "backspace" && this.focus === "search") &&
							(shortcut.enabled?.(row, this.cursor) ?? true),
					)
					.map(({ key, action, priority }) => ({
						key: frameShortcutKey(key),
						priority,
						action: typeof action === "function" ? action(row, this.cursor) : action,
					}))
			: [];
		return [
			navigate,
			enter,
			...shortcuts,
			{ key: "type", action: "filter", priority: "essential" },
			{
				key: "esc",
				action:
					this.focus === "search" || this.query ? "clear" : (this.options.cancelAction ?? "back"),
				priority: "essential",
			},
		];
	}

	private renderOptions(): FrameOptions {
		const searchInput =
			this.focus === "search" ? this.input.render(Math.max(0, this.width - 3))[0] : undefined;
		return {
			width: this.width,
			terminalRows: this.options.tui.terminal.rows,
			breadcrumbs: this.options.breadcrumbs,
			rightBadge: this.options.rightBadge,
			rows: this.options.rows,
			visible: this.visible,
			query: this.query,
			placeholder: this.options.placeholder,
			searchInput,
			cursor: this.position,
			scrollOffset: this.offset,
			keybindings: this.keybindings(),
			theme: this.options.theme,
			layout: this.layout,
		};
	}

	private ensureLayout(): FrameLayout {
		const rows = this.options.tui.terminal.rows;
		if (!this.layout || this.layout.width !== this.width || this.layout.terminalRows !== rows) {
			this.layout = measureFrame(this.renderOptions());
		}
		return this.layout;
	}

	private ensureVisible(): void {
		const layout = this.ensureLayout();
		this.offset = Math.min(this.offset, this.position);
		const { rows, theme } = this.options;
		const heights = this.visible.map((index, position) =>
			rows[index]
				? rowLines(rows[index], position === this.position, this.width, layout.valueColumn, theme)
						.length
				: 0,
		);
		let used = heights
			.slice(this.offset, this.position + 1)
			.reduce((sum, height) => sum + height, 0);
		while (this.offset < this.position && used > layout.listRows)
			used -= heights[this.offset++] ?? 0;
	}
}

/** Outcome of `selectFrame`: the chosen row's original index and the shortcut that chose it. */
export interface FrameChoice {
	index: number;
	/** Absent when chosen with Enter. */
	key?: KeyId;
}

/** Screen description for `selectFrame`. */
export interface FrameScreen {
	breadcrumbs: readonly string[];
	rows: readonly FrameRow[];
	rightBadge?: string | undefined;
	placeholder?: string;
	enterAction?: string;
	cancelAction?: string;
	cursor?: number;
	shortcuts?: readonly Pick<FrameShortcut, "key" | "action" | "enabled" | "priority">[];
}

/** Show a frame in place of the editor and resolve with the user's choice, or undefined when cancelled. */
export function selectFrame(
	ctx: ExtensionCommandContext,
	screen: FrameScreen,
): Promise<FrameChoice | undefined> {
	return ctx.ui.custom<FrameChoice | undefined>(
		(tui, theme, keyboard, done) =>
			new FrameList({
				...screen,
				tui,
				theme,
				keyboard,
				onSelect: (_row, index) => done({ index }),
				onCancel: () => done(undefined),
				shortcuts: screen.shortcuts?.map((shortcut) => ({
					...shortcut,
					onPress: (_row, index) => done({ index, key: shortcut.key }),
				})),
			}),
	);
}
