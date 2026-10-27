import { test } from "bun:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
	renderContinuityOps,
	renderToolCall,
	renderToolResult,
	type ToolRowState,
} from "../../src/ui/tool-renderer.ts";

initTheme("dark", false);
const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { theme } = (await import(
	pathToFileURL(join(root, "modes/interactive/theme/theme.js")).href
)) as { theme: Theme };

const WIDTHS = [40, 80, 130];
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

/** Renders at every width; collapsed rows must be exactly one line that fits. */
function oneLinePerWidth(component: Component | undefined): string[] {
	assert.ok(component);
	return WIDTHS.map((width) => {
		const lines = component.render(width);
		assert.equal(lines.length, 1, `one line at ${width}`);
		assert.ok(visibleWidth(lines[0] ?? "") <= width, `fits ${width}`);
		return plain(lines);
	});
}

const text = (body: string) => ({ content: [{ type: "text", text: body }] });
const collapsed = { expanded: false };
const expanded = { expanded: true };

const calls: Record<string, unknown> = {
	anchor: { action: "anchor", name: "impl-start" },
	rewind: {
		action: "rewind",
		rewindTo: "impl-start",
		newLabel: "impl-done",
		summaryFocus: "x".repeat(300),
	},
	list: { action: "list" },
	pin: { action: "pin", kind: "decision", text: "d".repeat(600) },
	"pin multi-line": { action: "pin", kind: "fact", text: "a\nb\t\x1b[2Jc" },
	"pin file": {
		action: "pin",
		kind: "file",
		path: "src/some/deep/path/to/a/module.ts",
		lines: "10-40",
		why: "entry point",
	},
};

test("call rows are one line at every width", () => {
	for (const args of Object.values(calls)) {
		oneLinePerWidth(renderToolCall(args, theme, false));
	}
});

test("partial args are guarded and control characters never reach the terminal", () => {
	for (const args of [null, undefined, {}, 42, [], { action: "pin", text: {} }]) {
		assert.doesNotThrow(() => renderToolCall(args, theme, false).render(80));
	}
	const row = renderToolCall({ action: "anchor", name: "a\n\x1b[2Jb" }, theme, false).render(80);
	assert.equal(row.join("").includes("\x1b[2J"), false);
	assert.match(plain(row), /anchor "a \[2Jb"/);
});

test("headers use the documented grammar for pending and running actions", () => {
	for (const args of Object.values(calls)) {
		for (const executionStarted of [false, true]) {
			const context = { state: {}, executionStarted, outputPad: 0 };
			const component = renderToolCall(args, theme, false, context);
			for (const width of [36, 57, 80, 130, 140]) {
				const lines = component.render(width);
				assert.equal(lines.length, 1);
				assert.ok(visibleWidth(lines[0] ?? "") <= width);
				assert.match(plain(lines), executionStarted ? /^⠋ navigate_tree/ : /^○ navigate_tree/);
			}
		}
	}
});

test("rewind and refused anchor settle lazily with metrics and indented bodies", () => {
	for (const refused of [false, true]) {
		const state: ToolRowState = {};
		const context = { state, executionStarted: true, outputPad: 0 };
		const args = refused ? calls["anchor"] : calls["rewind"];
		const result = refused
			? {
					...text("A label 'impl-start' already exists. Use action='list'."),
					details: { refusal: true },
				}
			: {
					...text("[navigate_tree] Rewind to 'impl-start' accepted (collapse as 'impl-done')."),
					details: { status: "queued" },
				};
		for (const isExpanded of [false, true]) {
			const call = renderToolCall(args, theme, isExpanded, context);
			const body = renderToolResult(result, { expanded: isExpanded }, theme, false, context);
			const lines = [...call.render(80), ...body.render(80)];
			assert.match(
				plain(lines),
				refused
					? /^● navigate_tree anchor "impl-start" · refused\n {2}⎿ {2}A label/
					: /^● navigate_tree rewind → "impl-start" as "impl-done" · accepted/,
			);
			assert.ok(lines.every((line) => visibleWidth(line) <= 80));
			assert.match(plain(body.render(80)), /^ {2}⎿ {2}/);
			assert.doesNotMatch(plain(lines), /\[navigate_tree\]/);
		}
	}
});

test("expanded list output preserves content and collapsed output offers the bound key", () => {
	const result = text(
		`[list] · 8 labels\n${Array.from({ length: 8 }, (_, i) => `label-${i}`).join("\n")}`,
	);
	const small = plain(
		renderToolResult({ ...result, details: { count: 8 } }, collapsed, theme, false).render(80),
	);
	const full = plain(
		renderToolResult({ ...result, details: { count: 8 } }, expanded, theme, false).render(80),
	);
	assert.match(small, /more lines · .*expand/);
	assert.doesNotMatch(small, /label-7/);
	assert.match(full, / {5}label-7/);
});

test("aborted, partial and malformed results fit every width", () => {
	const state: ToolRowState = {};
	const context = { state, executionStarted: true, outputPad: 1 };
	renderToolResult(text("Operation aborted"), collapsed, theme, true, context);
	assert.equal(state.outcome, "warning");
	renderToolResult(
		text("late progress"),
		{ expanded: false, isPartial: true },
		theme,
		false,
		context,
	);
	assert.equal(state.outcome, "warning");
	for (const result of [undefined, null, {}, { content: [null] }, text("x".repeat(800))]) {
		for (const options of [collapsed, expanded]) {
			for (const width of [1, 2, 36, 57, 80, 140]) {
				assert.ok(
					renderToolResult(result, options, theme, true, context)
						.render(width)
						.every((line) => visibleWidth(line) <= width),
				);
			}
		}
	}
});

for (const [details, expected] of [
	[{ count: 3, contextTokens: 120000, contextWindow: 1000000 }, "3 labels · ctx 12.0% of 1.0M"],
	[{ id: "D4", kind: "decision", effect: "added" }, "D4 decision recorded"],
	[{ id: "D4", kind: "decision", effect: "duplicate" }, "already recorded as D4"],
	[{ status: "summary-requested" }, "accepted"],
] as const) {
	test(`reported header metrics: ${expected}`, () => {
		const state: ToolRowState = {};
		renderToolResult({ ...text("result"), details }, collapsed, theme, false, {
			state,
			executionStarted: true,
			outputPad: 0,
		});
		assert.equal(state.metrics, expected);
		assert.equal(state.outcome, "success");
		const header = renderToolCall({ action: "list" }, theme, false, {
			state,
			executionStarted: true,
			outputPad: 0,
		}).render(130);
		assert.equal(header.length, 1);
		assert.ok(plain(header).endsWith(` · ${expected}`));
	});
}

test("expanded results show the full label text the model received", () => {
	const rows = Array.from(
		{ length: 8 },
		(_, index) => `${index + 1}.0%  label-${index} · after preview-${index}`,
	);
	const result = { ...text(`[list] · 8 labels\n\n${rows.join("\n")}`), details: { count: 8 } };
	for (const width of [57, 130]) {
		const full = plain(renderToolResult(result, expanded, theme, false).render(width));
		for (const row of rows) assert.ok(full.includes(row));
		assert.doesNotMatch(full, /8 labels/);
		const small = plain(renderToolResult(result, collapsed, theme, false).render(width));
		assert.doesNotMatch(small, /label-7/);
		assert.match(small, /more lines · .*expand/);
	}
});

test("an error result shows its first line in the error colour", () => {
	const result = { ...text("Duplicate label.\nUse action='list'."), details: { refusal: true } };
	for (const options of [collapsed, expanded]) {
		const lines = renderToolResult(result, options, theme, false).render(80);
		assert.match(plain(lines), /^ {2}⎿ {2}Duplicate label\./);
		assert.ok(lines[0]?.includes(theme.getFgAnsi("error")));
		assert.match(plain(lines), /Use action='list'/);
	}
});

test("garbage results render without throwing", () => {
	for (const result of [
		null,
		undefined,
		7,
		{},
		{ content: null },
		{ content: [null, 3, { type: "text" }] },
		{ details: "x" },
		{ details: { count: "3", label: 1 } },
	]) {
		for (const options of [collapsed, expanded]) {
			for (const isError of [false, true]) {
				const lines = renderToolResult(result, options, theme, isError).render(57);
				assert.ok(lines.every((line) => visibleWidth(line) <= 57));
			}
		}
	}
});

test("anchor preview and queued focus add information with one body marker", () => {
	const anchor = {
		...text("[anchor 'a'] set at 1.0% of 1.0M"),
		details: { label: "a", contextTokens: 10000, labelHint: "reviewed parser" },
	};
	assert.equal(
		plain(renderToolResult(anchor, collapsed, theme, false).render(80)),
		'  ⎿  Anchored after "reviewed parser"',
	);
	const context = { state: {}, executionStarted: true, outputPad: 0 };
	const call = renderToolCall(
		{ action: "rewind", summaryFocus: "Keep the parser contract." },
		theme,
		true,
		context,
	);
	const body = renderToolResult(
		{ ...text("Rewind accepted"), details: { status: "queued" } },
		expanded,
		theme,
		false,
		context,
	);
	const output = plain([...call.render(80), ...body.render(80)]);
	assert.equal(output.split("⎿").length - 1, 1);
	assert.match(output, /Folding after this turn\.\n {5}summaryFocus: Keep the parser contract\./);
	assert.equal(output.split("accepted").length - 1, 1);
});

const user = { origin: "user", entryId: "e1" };
const ledgerOps = [
	{
		op: {
			op: "add",
			kind: "rule",
			text: "From now on always answer in German",
			quote: "From now on always answer in German",
		},
		ctx: user,
	},
	{
		op: {
			op: "add",
			kind: "decision",
			text: "Use Postgres for storage",
			quote: "let us go with postgres",
		},
		ctx: user,
	},
];

test("ledger entry is one dim row naming kind and text", () => {
	const rows = oneLinePerWidth(renderContinuityOps({ data: { ops: ledgerOps } }, collapsed, theme));
	assert.equal(
		rows[2]?.trim(),
		'ledger · +rule "From now on always answer in German" · +decision "Use Postgres for storage"',
	);
	assert.match(rows[0] ?? "", /^ ledger · \+rule "From now on/);
	const raw = renderContinuityOps({ data: { ops: ledgerOps } }, collapsed, theme)?.render(130)[0];
	assert.ok(raw?.includes(theme.getFgAnsi("dim")));
});

test("ledger entry with many ops stays one line and counts the rest", () => {
	const ops = Array.from({ length: 10 }, (_, i) => ({
		op: { op: "add", kind: "fact", text: `fact number ${i} ${"z".repeat(60)}` },
		ctx: { origin: "agent" },
	}));
	const rows = oneLinePerWidth(renderContinuityOps({ data: { ops } }, collapsed, theme));
	for (const row of rows) assert.match(row, /\+\d+ more$|…$/);
	assert.match(rows[2] ?? "", /\+fact\(agent\) "fact number 0/);
	assert.match(rows[2] ?? "", /\+9 more$|\+8 more$/);
});

test("ledger entry keeps '+N more' when the first op alone overflows", () => {
	const ops = [
		{ op: { op: "add", kind: "rule", text: "r".repeat(300) }, ctx: user },
		{ op: { op: "archive", id: "D1" }, ctx: user },
	];
	const rows = oneLinePerWidth(renderContinuityOps({ data: { ops } }, collapsed, theme));
	for (const row of rows) assert.match(row, /…\s*· \+1 more$/);
});

test("expanded ledger entry lists every op with full quotes", () => {
	const ops = [
		...ledgerOps,
		{
			op: {
				op: "supersede",
				ids: ["D1", "D2"],
				with: {
					kind: "decision",
					text: "Use SQLite",
					quote: "actually sqlite",
				},
			},
			ctx: user,
		},
		{ op: { op: "archive", id: "T1" }, ctx: { origin: "agent" } },
		{ op: { op: "complete", id: "S2" }, ctx: user },
		{
			op: {
				op: "add",
				kind: "file",
				file: { path: "a.ts", lines: "1-5", why: "entry" },
			},
			ctx: { origin: "agent" },
		},
		{ op: { op: "update", id: "R1", text: "Answer in French" }, ctx: user },
	];
	const lines = renderContinuityOps({ data: { ops } }, expanded, theme)?.render(60);
	assert.ok(lines?.every((line) => visibleWidth(line) <= 60));
	const out = plain(lines ?? [])
		.split("\n")
		.map((line) => line.trim());
	assert.equal(out[0], "ledger · 7 ops");
	for (const expectedLine of [
		'+rule "From now on always answer in German"',
		'+decision "Use Postgres for storage"',
		'said "let us go with postgres"',
		'~decision "Use SQLite"',
		"replaces D1, D2",
		'said "actually sqlite"',
		"-T1(agent)",
		"done S2",
		"+file(agent) a.ts:1-5",
		"why: entry",
		'~R1 "Answer in French"',
	]) {
		assert.ok(out.includes(expectedLine), `missing: ${expectedLine}`);
	}
});

test("watermark-only and malformed ledger entries render nothing and never throw", () => {
	const unusable: unknown[] = [
		undefined,
		null,
		"ops",
		42,
		[],
		{},
		{ watermark: "e9" },
		{ ops: [], watermark: "e9" },
		{ ops: "x" },
		{ ops: [null, 1, "x", {}, { op: 3 }, { op: { op: 7 } }] },
	];
	for (const data of unusable) {
		for (const options of [collapsed, expanded]) {
			assert.equal(renderContinuityOps({ data }, options, theme), undefined);
		}
	}
	const garbageButRenderable = [
		{ op: { op: "add" }, ctx: 5 },
		{ op: { op: "supersede", ids: 3, with: 9 } },
		{ op: { op: "update" }, ctx: { origin: {} } },
		{ op: { op: "weird", id: { x: 1 } } },
	];
	for (const options of [collapsed, expanded]) {
		const component = renderContinuityOps({ data: { ops: garbageButRenderable } }, options, theme);
		assert.ok(component);
		for (const width of [1, 2, ...WIDTHS]) {
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (!options.expanded) assert.ok(lines.length <= 1);
		}
	}
});
