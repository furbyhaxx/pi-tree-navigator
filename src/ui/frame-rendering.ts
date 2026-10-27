/** Frozen frame geometry, row drawing, chrome and mouse hit rows. */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FrameKeybinding, FrameKeybindingPriority, FrameRow, FrameTheme } from "./frame.ts";
import { cleanTerminalText, singleLine } from "./frame-text.ts";
import { contextBadgeText, middleTruncate } from "./styled-lines.ts";

/** Frozen geometry; measured on open and again only when the terminal resizes. */
export interface FrameLayout {
	width: number;
	terminalRows: number;
	height: number;
	descriptionRows: number;
	listRows: number;
	valueColumn: number;
}

/** Inputs to the pure renderer. `rows` is always the full, unfiltered list. */
export interface FrameOptions {
	width: number;
	terminalRows: number;
	breadcrumbs: readonly string[];
	/** Muted badge right-aligned in the top rule. */
	rightBadge?: string | undefined;
	rows: readonly FrameRow[];
	/** Indices into `rows` that pass the filter, in display order; all rows when omitted. */
	visible?: readonly number[];
	query?: string;
	placeholder?: string | undefined;
	/** Pre-rendered search input (with its cursor); replaces the query/placeholder text. */
	searchInput?: string | undefined;
	/** Position within `visible`. */
	cursor: number;
	/** First visible position within `visible`. */
	scrollOffset: number;
	keybindings: readonly FrameKeybinding[];
	theme: FrameTheme;
	layout?: FrameLayout | undefined;
}

const CURSOR_PREFIX = 3;
const DETAIL_INDENT = "      ";
const CHROME_ROWS = 5;
const MIN_HEIGHT = 10;
const MAX_DESCRIPTION_ROWS = 2;
const DEFAULT_PLACEHOLDER = "Type to search…";
const HINT_ORDER: readonly FrameKeybindingPriority[] = ["essential", "navigation", "optional"];
const HINT_SEPARATOR = "  ";

/** Anchor names and setting keys keep both ends so suffix-distinct identities stay distinct. */
function identityLabel(row: FrameRow): boolean {
	return row.label.includes("◆") || (!row.labelHint && !/\s/.test(singleLine(row.label)));
}

function labelText(row: FrameRow, theme: FrameTheme): string {
	const hint = row.labelHint ? ` ${theme.fg("dim", singleLine(row.labelHint))}` : "";
	return singleLine(row.label) + hint;
}

function computeValueColumn(rows: readonly FrameRow[], width: number, theme: FrameTheme): number {
	const longest = rows.reduce((max, row) => Math.max(max, visibleWidth(labelText(row, theme))), 0);
	return Math.min(width, CURSOR_PREFIX + Math.min(longest, Math.floor(width * 0.45)) + 2);
}

function descriptionLines(row: FrameRow | undefined, width: number): string[] {
	if (!row?.description) return [];
	const text = cleanTerminalText(row.description).replace(/\t/g, "    ");
	return wrapTextWithAnsi(text, Math.max(1, width - CURSOR_PREFIX)).map(
		(line) => " ".repeat(CURSOR_PREFIX) + line,
	);
}

export function rowLines(
	row: FrameRow,
	selected: boolean,
	width: number,
	column: number,
	theme: FrameTheme,
): string[] {
	const label = labelText(row, theme);
	let main = label;
	if (row.value !== undefined) {
		const budget = Math.max(0, column - CURSOR_PREFIX - 2);
		const clipped =
			identityLabel(row) && visibleWidth(label) > budget
				? middleTruncate(singleLine(row.label), budget)
				: truncateToWidth(label, budget, "…");
		const gap = " ".repeat(Math.max(0, column - CURSOR_PREFIX - visibleWidth(clipped)));
		main = clipped + gap + theme.fg(row.tone ?? "text", singleLine(row.value));
	}
	const prefix = selected ? ` ${theme.fg("accent", "→")} ` : " ".repeat(CURSOR_PREFIX);
	const lines = [truncateToWidth(prefix + main, width, "…")];
	if (selected && row.detail) {
		lines.push(
			truncateToWidth(
				`${DETAIL_INDENT}${theme.fg("dim", "↳")} ${theme.fg("muted", singleLine(row.detail))}`,
				width,
				"…",
			),
		);
	}
	return lines;
}

/** Height is reserved for the tallest description and one detail line, so filtering never resizes the frame. */
export function measureFrame(options: FrameOptions): FrameLayout {
	const width = Math.max(0, Math.floor(options.width));
	const cap = Math.max(MIN_HEIGHT, Math.floor(options.terminalRows / 2));
	const maxDescription = options.rows.reduce(
		(max, row) => Math.max(max, descriptionLines(row, width).length),
		0,
	);
	const descriptionRows = Math.min(maxDescription, MAX_DESCRIPTION_ROWS);
	const detailRows = options.rows.some((row) => row.detail) ? 1 : 0;
	const chrome = CHROME_ROWS + (descriptionRows > 0 ? 1 + descriptionRows : 0);
	const height = Math.min(cap, chrome + Math.max(1, options.rows.length + detailRows));
	return {
		width,
		terminalRows: options.terminalRows,
		height,
		descriptionRows,
		listRows: height - chrome,
		valueColumn: computeValueColumn(options.rows, width, options.theme),
	};
}

function breadcrumbText(segments: readonly string[], budget: number, theme: FrameTheme): string {
	const last = segments.at(-1);
	if (last === undefined || budget <= 0) return "";
	const root = singleLine(segments[0] ?? "");
	const path = segments.map(singleLine).join("/");
	if (visibleWidth(path) <= budget) {
		const parents = segments.slice(0, -1).map(singleLine).join("/");
		return parents
			? `${theme.fg("muted", parents)}/${theme.bold(singleLine(last))}`
			: theme.bold(singleLine(last));
	}
	const rootWidth = visibleWidth(root);
	if (budget <= rootWidth + 1) return theme.fg("muted", truncateToWidth(root, budget, "…"));
	const leafBudget = budget - rootWidth - 1;
	const leaf = segments.length > 2 ? `…/${singleLine(last)}` : singleLine(last);
	return `${theme.fg("muted", root)}/${theme.bold(middleTruncate(leaf, leafBudget))}`;
}

function topRule(
	width: number,
	hidden: number,
	breadcrumbs: readonly string[],
	badge: string | undefined,
	theme: FrameTheme,
): string {
	const rule = (count: number) => theme.fg("borderAccent", "─".repeat(Math.max(0, count)));
	const titleRoom = Math.min(
		visibleWidth(breadcrumbs.map(singleLine).join("/")),
		Math.floor(width * 0.4),
	);
	const indicatorText = hidden > 0 ? truncateToWidth(` ↑ ${hidden} more `, width, "") : "";
	const indicator =
		Math.floor((width - visibleWidth(indicatorText)) / 2) >= titleRoom + 3 ? indicatorText : "";
	const indicatorWidth = visibleWidth(indicator);
	const indicatorStart = indicator ? Math.floor((width - indicatorWidth) / 2) : width;
	const indicatorEnd = indicator ? indicatorStart + indicatorWidth : 0;

	// The badge sits right of the indicator, keeping one rule cell on each side of it.
	const badgeRoom = Math.min(
		Math.max(0, width - indicatorEnd - 4),
		Math.max(0, width - titleRoom - 6),
		Math.floor(width * 0.6),
	);
	const badgeText = badge && badgeRoom >= 3 ? contextBadgeText(singleLine(badge), badgeRoom) : "";
	const rightWidth = badgeText ? visibleWidth(badgeText) + 3 : 0;

	const leftBudget = (indicator ? indicatorStart : width - rightWidth) - 3;
	const title = breadcrumbText(breadcrumbs, leftBudget, theme);
	const left = title ? `${theme.fg("borderAccent", "─ ")}${title} ` : "";
	const leftWidth = visibleWidth(left);

	let line = left;
	if (indicator) {
		line += rule(indicatorStart - leftWidth) + theme.fg("dim", indicator);
		line += rule(width - indicatorEnd - rightWidth);
	} else {
		line += rule(width - leftWidth - rightWidth);
	}
	if (badgeText) line += ` ${theme.fg("muted", badgeText)} ${rule(1)}`;
	return truncateToWidth(line, width, "");
}

function bottomRule(width: number, hidden: number, theme: FrameTheme): string {
	const indicator = hidden > 0 ? truncateToWidth(` ↓ ${hidden} more `, width, "") : "";
	const start = indicator ? Math.floor((width - visibleWidth(indicator)) / 2) : width;
	const rule = (count: number) => theme.fg("borderAccent", "─".repeat(Math.max(0, count)));
	const line = rule(start) + theme.fg("dim", indicator);
	return line + rule(width - visibleWidth(line));
}

function searchLine(options: FrameOptions): string {
	const { theme } = options;
	let content = options.searchInput;
	if (content === undefined) {
		content = options.query
			? singleLine(options.query)
			: theme.fg("dim", theme.italic(singleLine(options.placeholder ?? DEFAULT_PLACEHOLDER)));
	}
	return ` ${theme.fg("accent", "❯")} ${content}`;
}

/** One hint-bar line that never wraps: whole hints are dropped by priority, last first, and an ellipsis marks the loss. */
function hintLine(
	keybindings: readonly FrameKeybinding[],
	width: number,
	theme: FrameTheme,
): string {
	const hints = keybindings.map(
		({ key, action }) => `${theme.bold(singleLine(key))} ${theme.fg("dim", singleLine(action))}`,
	);
	const widths = hints.map(visibleWidth);
	const join = (shown: readonly number[]) =>
		` ${shown.map((index) => hints[index]).join(HINT_SEPARATOR)}`;
	const all = hints.map((_, index) => index);
	const lineWidth = (shown: readonly number[]) =>
		1 +
		shown.reduce((sum, index) => sum + (widths[index] ?? 0), 0) +
		HINT_SEPARATOR.length * Math.max(0, shown.length - 1);
	if (lineWidth(all) <= width) return join(all);

	const ellipsis = HINT_SEPARATOR.length + 1;
	const tier = (index: number) => HINT_ORDER.indexOf(keybindings[index]?.priority ?? "optional");
	const byPriority = [...all].sort((a, b) => tier(a) - tier(b) || a - b);
	const shown: number[] = [];
	for (const index of byPriority) {
		if (shown.length > 0 && lineWidth([...shown, index]) + ellipsis > width) break;
		shown.push(index);
	}
	shown.sort((a, b) => a - b);
	return `${join(shown)}${HINT_SEPARATOR}${theme.fg("dim", "…")}`;
}

export function frameContent(options: FrameOptions): {
	lines: string[];
	mouseRows: Map<number, number>;
} {
	const layout =
		options.layout &&
		options.layout.width === options.width &&
		options.layout.terminalRows === options.terminalRows
			? options.layout
			: measureFrame(options);
	const { width } = layout;
	const { theme, rows } = options;
	const visible = options.visible ?? rows.map((_, index) => index);
	const start = Math.max(
		0,
		Math.min(Math.floor(options.scrollOffset), Math.max(0, visible.length - 1)),
	);

	const header = [
		topRule(width, start, options.breadcrumbs, options.rightBadge, theme),
		searchLine(options),
		"",
	];
	const body: string[] = [];
	const mouseRows = new Map<number, number>();
	let end = start;
	while (end < visible.length && body.length < layout.listRows) {
		const selected = end === options.cursor;
		const index = visible[end];
		const row = index === undefined ? undefined : rows[index];
		if (index === undefined || row === undefined) break;
		const lines = rowLines(row, selected, width, layout.valueColumn, theme);
		if (body.length > 0 && lines.length > layout.listRows - body.length) break;
		for (const line of lines.slice(0, layout.listRows - body.length)) {
			mouseRows.set(header.length + body.length, index);
			body.push(line);
		}
		end++;
	}
	if (visible.length === 0) {
		const empty =
			rows.length === 0 ? "Nothing to show" : `No matches for “${singleLine(options.query ?? "")}”`;
		body.push(" ".repeat(CURSOR_PREFIX) + theme.fg("dim", theme.italic(empty)));
	}
	while (body.length < layout.listRows) body.push("");

	const lines = [...header, ...body];
	if (layout.descriptionRows > 0) {
		lines.push("");
		const selectedIndex = visible[options.cursor];
		const selectedRow = selectedIndex === undefined ? undefined : rows[selectedIndex];
		const description = descriptionLines(selectedRow, width);
		for (let n = 0; n < layout.descriptionRows; n++) {
			let line = description[n] ?? "";
			if (n === layout.descriptionRows - 1 && description.length > layout.descriptionRows) {
				line = `${truncateToWidth(line, Math.max(0, width - 1), "")}…`;
			}
			lines.push(theme.fg("dim", line));
		}
	}
	lines.push(hintLine(options.keybindings, width, theme));
	lines.push(bottomRule(width, Math.max(0, visible.length - end), theme));
	return {
		lines: lines.map((line) => truncateToWidth(line, width, "…")),
		mouseRows,
	};
}
