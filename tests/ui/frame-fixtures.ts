/** Shared frame rows, theme and rendering inputs for frame tests. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { FrameRow, FrameTheme } from "../../src/ui/frame.ts";
import type { FrameOptions } from "../../src/ui/frame-rendering.ts";

export const CODES: Record<string, number> = {
	text: 37,
	muted: 90,
	dim: 2,
	accent: 36,
	success: 32,
	warning: 33,
	error: 31,
	borderAccent: 34,
};
export const theme: FrameTheme = {
	fg: (color, text) => `\x1b[${CODES[color] ?? 99}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => `\x1b[3m${text}\x1b[23m`,
};

export const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);

export function makeRows(count: number): FrameRow[] {
	return Array.from({ length: count }, (_, index) => ({
		label: `row ${index + 1}`,
		value: `value ${index + 1}`,
		detail: `detail line ${index + 1}`,
		description: `Description for row ${index + 1}.`,
	}));
}

export function options(
	rows: readonly FrameRow[],
	width: number,
	overrides: Partial<FrameOptions> = {},
): FrameOptions {
	return {
		width,
		terminalRows: 40,
		breadcrumbs: ["Anchor", "List"],
		rows,
		cursor: 0,
		scrollOffset: 0,
		keybindings: [
			{ key: "↑↓", action: "navigate" },
			{ key: "enter", action: "select" },
			{ key: "esc", action: "back" },
		],
		theme,
		...overrides,
	};
}
