import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type FrameRow, renderFrame, sanitizeTerminalText } from "../../src/ui/frame.ts";
import { measureFrame } from "../../src/ui/frame-rendering.ts";
import { CODES, makeRows, options, plain } from "./frame-fixtures.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

describe("renderFrame", () => {
	for (const width of [60, 130]) {
		it(`bounds every line to ${width} columns and renders exactly the measured height`, () => {
			const rows = makeRows(30);
			const opts = options(rows, width, {
				rightBadge: "38.4% of 372k (auto)",
				scrollOffset: 4,
				cursor: 6,
			});
			const layout = measureFrame(opts);
			const lines = renderFrame({ ...opts, layout });
			assert.equal(lines.length, layout.height);
			for (const line of lines)
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
			const text = plain(lines);
			assert.match(required(text[0]), /^─ Anchor\/List ─+ ↑ 4 more ─+ 38\.4% of 372k \(auto\) ─$/);
			assert.equal(visibleWidth(required(text[0])), width);
			assert.match(text.at(-1) ?? "", /^─+ ↓ \d+ more ─+$/);
		});
	}

	it("lays out search, rows, selected detail, description and hint bar", () => {
		const rows = makeRows(3);
		const lines = plain(renderFrame(options(rows, 60, { cursor: 1 })));
		assert.equal(lines[1], " ❯ Type to search…");
		assert.equal(lines[2], "");
		assert.match(required(lines[3]), /^ {3}row 1 {2,}value 1$/);
		assert.match(required(lines[4]), /^ → row 2 {2,}value 2$/);
		assert.match(required(lines[5]), /^ {6}↳ detail line 2$/);
		assert.match(required(lines[6]), /^ {3}row 3 {2,}value 3$/);
		assert.ok(lines.includes("   Description for row 2."));
		assert.equal(lines.at(-2), " ↑↓ navigate  enter select  esc back");
		assert.ok(!lines.some((line) => line.includes("detail line 1")));
	});

	it("aligns the value column to the full list, not the visible rows", () => {
		const rows: FrameRow[] = [
			{ label: "a", value: "one" },
			{ label: "a considerably longer label", value: "two" },
		];
		const opts = options(rows, 80);
		const layout = measureFrame(opts);
		const all = plain(renderFrame({ ...opts, layout }));
		const filtered = plain(renderFrame({ ...opts, layout, visible: [0] }));
		const column = (lines: string[]) => lines.find((line) => line.includes("one"))?.indexOf("one");
		assert.equal(column(all), column(filtered));
		assert.ok((column(filtered) ?? 0) > 20);
	});

	it("keeps the height when the filter leaves fewer or no rows", () => {
		const rows = makeRows(12);
		const opts = options(rows, 80);
		const layout = measureFrame(opts);
		const full = renderFrame({ ...opts, layout });
		const few = renderFrame({ ...opts, layout, visible: [3, 5], query: "row" });
		const none = renderFrame({ ...opts, layout, visible: [], query: "zzz" });
		assert.equal(few.length, full.length);
		assert.equal(none.length, full.length);
		assert.ok(plain(none).some((line) => line.includes("No matches for “zzz”")));
		assert.ok(
			plain(renderFrame({ ...opts, rows: [] })).some((line) => line.includes("Nothing to show")),
		);
	});

	it("shows overflow counts in both rules", () => {
		const rows = makeRows(30);
		const opts = options(rows, 80);
		const layout = measureFrame(opts);
		const top = plain(renderFrame({ ...opts, layout }));
		assert.ok(!required(top[0]).includes("more"));
		assert.match(top.at(-1) ?? "", /↓ \d+ more/);
		const scrolled = plain(renderFrame({ ...opts, layout, scrollOffset: 5, cursor: 5 }));
		assert.match(required(scrolled[0]), /↑ 5 more/);
	});

	it("clips the badge and breadcrumbs instead of overflowing narrow terminals", () => {
		const opts = options(makeRows(30), 24, {
			rightBadge: "a very long context badge text",
			scrollOffset: 3,
			cursor: 3,
		});
		for (const line of renderFrame(opts)) assert.ok(visibleWidth(line) <= 24, line);
	});

	it("styles through the theme only and strips escape sequences from row text", () => {
		const rows: FrameRow[] = [
			{
				label: "evil\x1b[31m red\x1b]0;title\x07",
				value: "v\u0000al",
				description: "x\x1b[2Jy",
			},
		];
		const lines = renderFrame(options(rows, 60));
		const known = new Set(Object.values(CODES).map(String).concat(["39", "1", "22", "3", "23"]));
		for (const line of lines) {
			for (const part of line.split("\x1b").slice(1)) {
				const code = /^\[(\d+)m/.exec(part)?.[1];
				assert.ok(code !== undefined && known.has(code), `raw escape in ${JSON.stringify(line)}`);
			}
		}
		const text = plain(lines).join("\n");
		assert.ok(text.includes("evil red"));
		assert.ok(text.includes("xy"));
		assert.equal(sanitizeTerminalText("a\tb\nc\r\u0007d"), "a\tb\ncd");
	});
});

describe("hint bar", () => {
	it("keeps whole hints in display order and drops lowest priority first", () => {
		const keybindings = [
			{ key: "a", action: "optional", priority: "optional" as const },
			{ key: "enter", action: "select", priority: "navigation" as const },
			{ key: "/", action: "search", priority: "essential" as const },
		];
		const hint = (width: number) =>
			plain(renderFrame(options(makeRows(2), width, { keybindings }))).at(-2);
		assert.equal(hint(80), " a optional  enter select  / search");
		assert.equal(hint(26), " enter select  / search  …");
		assert.equal(hint(25), " / search  …");
		assert.equal(hint(14), " / search  …");
	});
});
