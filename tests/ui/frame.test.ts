import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { CURSOR_MARKER, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import {
	FrameList,
	type FrameListOptions,
	type FrameRow,
	frameShortcutKey,
} from "../../src/ui/frame.ts";
import { makeRows, plain, theme } from "./frame-fixtures.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

function list(rows: readonly FrameRow[], extra: Partial<FrameListOptions> = {}) {
	const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
	const events: string[] = [];
	const frame = new FrameList({
		tui,
		theme,
		breadcrumbs: ["Anchor"],
		rows,
		onSelect: (row, index) => events.push(`select:${row.label}:${index}`),
		onCancel: () => events.push("cancel"),
		...extra,
	});
	return { frame, events, tui };
}

describe("FrameList", () => {
	it("filters printable mnemonics and dispatches Alt actions with either terminal encoding", () => {
		let switches = 0;
		const { frame } = list([{ label: "treeProposal.tools" }, { label: "other" }], {
			shortcuts: [{ key: "t", action: "layer", onPress: () => switches++ }],
		});
		for (const key of "treeProposal.tools") frame.handleInput(key);
		assert.equal(frame.search, "treeProposal.tools");
		assert.equal(frame.cursor, 0);
		assert.equal(switches, 0);
		for (const key of ["\x1bt", "\x1b[116;3u"]) frame.handleInput(key);
		assert.equal(switches, 2);
		assert.equal(frame.search, "treeProposal.tools");
	});

	it("toggles on initial Space and keeps spaces and slashes in multi-term filters", () => {
		let toggles = 0;
		const { frame } = list([{ label: "alpha beta" }], {
			shortcuts: [{ key: "space", action: "toggle", onPress: () => toggles++ }],
		});
		frame.handleInput(" ");
		assert.equal(toggles, 1);
		assert.equal(frame.search, "");
		assert.equal(frame.isSearching, false);
		for (const key of "beta alpha/") frame.handleInput(key);
		assert.equal(frame.search, "beta alpha/");
		assert.equal(frame.cursor, 0);
		assert.equal(toggles, 1);
	});
	const mouse = (
		width: number,
		height: number,
		overrides: Partial<TuiMouseEvent> = {},
	): TuiMouseEvent => ({
		type: "click",
		button: "left",
		x: width - 1,
		y: 3,
		screenX: 150,
		screenY: 50,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	});

	for (const width of [36, 57, 60, 80, 130, 140]) {
		it(`maps filtered, scrolled clicks and selected detail rows at ${width} columns`, () => {
			const rows = Array.from({ length: 80 }, (_, index) => ({
				label: `${index % 2 === 0 ? "keep" : "skip"} ${index}`,
				detail: `detail ${index}`,
			}));
			const { frame, events } = list(rows);
			const height = frame.render(width).length;
			frame.handleInput("keep");
			for (let n = 0; n < 20; n++) frame.handleInput("\x1b[B");
			const scrolled = plain(frame.render(width));
			assert.match(required(scrolled[0]), /↑ \d+ more/);
			const first = Number(/keep (\d+)/.exec(required(scrolled[3]))?.[1]);
			assert.ok(first > 0);
			const click = (y: number) => {
				for (const type of ["press", "release", "click"] as const) {
					const result = frame.handleMouse(mouse(width, height, { type, y }));
					if (type === "press") assert.equal(result?.handled, true);
					const lines = frame.render(width);
					assert.equal(lines.length, height);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
			};
			click(3);
			assert.equal(frame.cursor, first);
			const expanded = plain(frame.render(width));
			assert.match(required(expanded[4]), new RegExp(`detail ${first}$`));
			assert.match(required(expanded[5]), new RegExp(`keep ${first + 2}$`));
			click(5);
			assert.equal(frame.cursor, first + 2);
			assert.deepEqual(events, []);
			assert.equal(frame.search, "keep");
			assert.match(plain(frame.render(width)).at(-2) ?? "", /esc clear/);
			assert.match(required(plain(frame.render(width))[5]), /↳ detail/);
			click(5);
			assert.deepEqual(events, [`select:keep ${first + 2}:${first + 2}`]);
			frame.handleInput("\x1b");
			assert.equal(frame.search, "");
			assert.equal(events.length, 1);
		});
	}

	it("focuses search on click and moves selection one row per wheel event", () => {
		const { frame } = list([
			{ label: "keep first" },
			{ label: "skip" },
			{ label: "keep second" },
			{ label: "keep third" },
		]);
		frame.focused = true;
		const height = frame.render(60).length;
		const event = (overrides: Partial<TuiMouseEvent>) => mouse(60, height, overrides);
		const result = frame.handleMouse(event({ y: 1 }));
		assert.equal(result?.focus, true);
		assert.equal(result?.handled, true);
		assert.ok(required(frame.render(60)[1]).includes(CURSOR_MARKER));
		assert.match(plain(frame.render(60)).at(-2) ?? "", /esc clear/);
		frame.handleInput("keep");
		assert.equal(frame.search, "keep");
		frame.render(60);
		const wheel = (wheelDelta: number) =>
			frame.handleMouse(event({ type: "wheel", button: "none", wheelDelta }));
		assert.equal(wheel(3)?.handled, true);
		assert.equal(frame.cursor, 2);
		wheel(3);
		assert.equal(frame.cursor, 3);
		wheel(3);
		assert.equal(frame.cursor, 3);
		wheel(-3);
		assert.equal(frame.cursor, 2);
		wheel(0);
		assert.equal(frame.cursor, 2);
		assert.equal(frame.search, "keep");
		frame.handleInput("\x1b[A");
		assert.equal(frame.cursor, 0);
	});

	it("ignores hover, non-left clicks, padding, chrome and out-of-bounds cells", () => {
		const { frame, events } = list(makeRows(8));
		const height = frame.render(60).length;
		for (const overrides of [
			{ type: "move", y: 5 },
			{ type: "press", y: 5 },
			{ type: "release", y: 5 },
			{ type: "drag", y: 5 },
			{ button: "right", y: 3 },
			{ y: 0 },
			{ y: height - 2 },
			{ y: height - 1 },
			{ y: height },
			{ y: -1 },
			{ x: -1 },
			{ x: 60 },
		] satisfies Partial<TuiMouseEvent>[]) {
			frame.handleMouse(mouse(60, height, overrides));
			assert.equal(frame.cursor, 0);
			assert.deepEqual(events, []);
		}
		frame.handleInput("row 1");
		frame.render(60);
		frame.handleMouse(mouse(60, height, { y: 5 }));
		assert.deepEqual(events, []);
		frame.handleInput("zzz");
		frame.render(60);
		frame.handleMouse(mouse(60, height));
		assert.equal(frame.cursor, -1);
		assert.deepEqual(events, []);
	});

	it("never changes height while filtering or moving the cursor", () => {
		const { frame } = list(makeRows(20));
		const heights = new Set<number>();
		const feed = (data: string) => {
			frame.handleInput(data);
			heights.add(frame.render(80).length);
		};
		heights.add(frame.render(80).length);
		for (const key of [
			"\x1b[B",
			"\x1b[B",
			"\x1b[6~",
			"/",
			"r",
			"o",
			"w",
			" ",
			"1",
			"\x1b[A",
			"z",
			"z",
			"z",
			"\x1b",
			"\x1b[B",
		])
			feed(key);
		assert.equal(heights.size, 1);
	});

	it("filters fuzzily and reports original indices", () => {
		const rows: FrameRow[] = [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }];
		const { frame, events } = list(rows);
		frame.render(80);
		for (const key of "gam") frame.handleInput(key);
		assert.equal(frame.search, "gam");
		frame.handleInput("\r");
		assert.deepEqual(events, ["select:gamma:2"]);
		assert.match(plain(frame.render(80)).join("\n"), /enter select {2}type filter {2}esc clear/);
	});

	it("clears a non-empty search on the first escape and cancels on the next", () => {
		const { frame, events } = list(makeRows(5));
		frame.render(80);
		frame.handleInput("/");
		frame.handleInput("x");
		frame.handleInput("\x1b");
		assert.equal(frame.search, "");
		assert.deepEqual(events, []);
		assert.match(required(plain(frame.render(80))[1]), /Type to search/);
		frame.handleInput("\x1b");
		assert.deepEqual(events, ["cancel"]);
	});

	it("keeps the selected row selected when the search is cleared", () => {
		const rows: FrameRow[] = [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }];
		const { frame, events } = list(rows);
		frame.render(80);
		for (const key of "gam") frame.handleInput(key);
		frame.handleInput("\x1b");
		assert.equal(frame.cursor, 2);
		frame.handleInput("\r");
		assert.deepEqual(events, ["select:gamma:2"]);
	});

	it("does not start a search from control keys", () => {
		const { frame } = list(makeRows(3));
		frame.render(80);
		for (const key of ["\t", "\x1b[C", "\x1b[D"]) frame.handleInput(key);
		assert.match(required(plain(frame.render(80))[1]), /Type to search/);
		assert.ok(!plain(frame.render(80)).at(-2)?.includes("to filter"));
	});

	it("cancels on ctrl+c from either focus", () => {
		const { frame, events } = list(makeRows(2));
		frame.render(80);
		frame.handleInput("\x03");
		frame.handleInput("a");
		frame.handleInput("\x03");
		assert.deepEqual(events, ["cancel", "cancel"]);
	});

	it("dispatches shortcuts only on rows where they are enabled and typing otherwise searches", () => {
		const pressed: string[] = [];
		const rows: FrameRow[] = [{ label: "anchor" }, { label: "new" }];
		const { frame } = list(rows, {
			shortcuts: [
				{
					key: "r",
					action: "fold",
					enabled: (_row, index) => index === 0,
					onPress: (row) => pressed.push(row.label),
				},
			],
		});
		frame.render(80);
		assert.match(plain(frame.render(80)).at(-2) ?? "", /alt\+r fold/);
		frame.handleInput("\x1br");
		frame.handleInput("\x1b[B");
		assert.ok(!(plain(frame.render(80)).at(-2) ?? "").includes("alt+r fold"));
		frame.handleInput("\x1br");
		assert.deepEqual(pressed, ["anchor"]);
		assert.equal(frame.search, "");
		frame.handleInput("n");
		assert.equal(frame.search, "n");
	});

	it("re-measures only when the terminal size changes", () => {
		const { frame, tui } = list(makeRows(30));
		const small = frame.render(80).length;
		tui.terminal.rows = 100;
		assert.ok(frame.render(80).length > small);
	});

	describe("hint bar", () => {
		const shortcuts = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(
			(action, index) => ({
				key: String.fromCharCode(97 + index) as "a",
				action,
				onPress: () => {},
			}),
		);
		const footer = (width: number) => {
			const { frame } = list(makeRows(4), { shortcuts });
			const lines = frame.render(width);
			const reference = list(makeRows(4)).frame.render(width);
			assert.equal(lines.length, reference.length);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, line);
			return plain(lines).at(-2) ?? "";
		};

		it("keeps esc and search whole at 60 columns and drops optional actions with an ellipsis", () => {
			const text = footer(60);
			assert.match(text, /type filter/);
			assert.match(text, /esc back/);
			assert.match(text, /↑↓ navigate {2}enter select/);
			assert.ok(text.endsWith("…"), text);
			const shown = shortcuts.filter(({ action }) => text.includes(action));
			assert.ok(shown.length < shortcuts.length, text);
			for (const { key, action } of shown)
				assert.ok(text.includes(`${frameShortcutKey(key)} ${action}`), text);
		});

		it("shows every hint without an ellipsis when they fit", () => {
			const text = footer(130);
			for (const { key, action } of shortcuts)
				assert.ok(text.includes(`${frameShortcutKey(key)} ${action}`), text);
			assert.ok(!text.includes("…"));
		});

		it("resolves shortcut actions per row", () => {
			const { frame } = list(makeRows(2), {
				shortcuts: [
					{
						key: "p",
						action: (_row, index) => (index === 0 ? "unpin" : "pin"),
						onPress: () => {},
					},
				],
			});
			frame.render(80);
			assert.match(plain(frame.render(80)).at(-2) ?? "", /p unpin/);
			frame.handleInput("\x1b[B");
			assert.match(plain(frame.render(80)).at(-2) ?? "", /p pin/);
		});
	});
});
