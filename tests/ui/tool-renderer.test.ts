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

test("call rows read as the brief specifies", () => {
	const row = (args: unknown) => oneLinePerWidth(renderToolCall(args, theme, false))[2];
	assert.equal(row(calls["anchor"]), "anchor impl-start");
	assert.equal(row(calls["rewind"]), "rewind impl-start → impl-done");
	assert.equal(row(calls["list"]), "list");
	assert.equal(
		row({ action: "pin", kind: "rule", text: "Always answer in German" }),
		"pin rule: Always answer in German",
	);
	assert.equal(row(calls["pin file"]), "pin file: src/some/deep/path/to/a/module.ts:10-40");
	assert.equal(row(calls["pin multi-line"]), "pin fact: a b [2Jc");
	const raw = renderToolCall(calls["pin multi-line"], theme, false).render(80);
	assert.ok(!raw.join("").includes("\x1b[2J"));
	assert.equal(row({ action: "rewind", rewindTo: "a" }), "rewind a");
	assert.equal(row({ action: "pin", kind: "fact" }), "pin fact");
	assert.equal(row({ action: "pin" }), "pin");
});

test("streaming and garbage args render without throwing", () => {
	const garbage = [
		undefined,
		null,
		{},
		42,
		"anchor",
		[],
		{ action: 5 },
		{ action: "nope" },
		{ action: "anchor", name: { deep: 1 } },
		{ action: "pin", kind: 3, text: 9, path: [], lines: {} },
		{ action: "rewind", rewindTo: 1, newLabel: null },
	];
	for (const args of garbage) {
		for (const isExpanded of [false, true]) {
			for (const width of WIDTHS) {
				const lines = renderToolCall(args, theme, isExpanded).render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				if (!isExpanded) assert.ok(lines.length <= 1);
			}
		}
	}
	assert.equal(oneLinePerWidth(renderToolCall({}, theme, false))[2], "navigate_tree");
});

test("expanded call wraps the full text and adds detail", () => {
	const lines = renderToolCall(calls["pin"], theme, true).render(40);
	assert.ok(lines.length > 10);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.match(plain(renderToolCall(calls["rewind"], theme, true).render(80)), /focus:\s+x{20}/);
	assert.match(
		plain(renderToolCall(calls["pin file"], theme, true).render(80)),
		/why: entry point/,
	);
});

const results = {
	anchor: {
		...text(
			"[anchor 'ctx'] set at 4.1% of 1.0M (after: “read the repo”)\n\nOnce real work has accumulated after this anchor, collapse it.",
		),
		details: {
			label: "ctx",
			entryId: "e1",
			contextTokens: 41000,
			labelHint: "read the repo",
		},
	},
	list: {
		...text("[list] · 3 labels · ctx 12.0% of 1.0M\n\n 4.1%  ctx\n 9.0%  b"),
		details: {
			count: 3,
			contextTokens: 120000,
			contextWindow: 1_000_000,
			reflectionOk: true,
		},
	},
	pin: {
		...text("[pin] D4 decision recorded"),
		details: { id: "D4", kind: "decision", effect: "added", rev: 3 },
	},
	duplicate: {
		...text("[pin] D4 already records this decision; nothing added."),
		details: { id: "D4", kind: "decision", effect: "duplicate", rev: 3 },
	},
	rewind: {
		...text("Rewind accepted. Write the summary now."),
		details: {
			status: "summary-requested",
			rewindTo: "a",
			newLabel: "b",
		},
	},
	queuedRewind: {
		...text("Rewind accepted; folding after this turn."),
		details: { status: "queued", rewindTo: "a", newLabel: "b" },
	},
};

test("result rows summarize each action in one line", () => {
	const row = (result: unknown) =>
		oneLinePerWidth(renderToolResult(result, collapsed, theme, false))[2];
	assert.equal(row(results.anchor), "set at 4.1% of 1.0M");
	assert.equal(row(results.list), "3 labels · ctx 12.0% of 1.0M");
	assert.equal(row(results.pin), "D4 decision recorded");
	assert.equal(row(results.duplicate), "already recorded as D4");
	assert.equal(row(results.rewind), "accepted · summarizing");
	assert.equal(row(results.queuedRewind), "accepted · folding after this turn");
	assert.equal(
		row({ ...results.list, details: { count: 1, contextTokens: 5000 } }),
		"1 label · ctx 5.0k",
	);
});

test("an error result shows its first line in the error colour", () => {
	const message = `No label 'x' on the active branch. ${"y".repeat(200)}\nUse action='list'.`;
	const failure = { ...text(message), details: { refusal: true } };
	const rows = oneLinePerWidth(renderToolResult(failure, collapsed, theme, true));
	assert.match(rows[2] ?? "", /^No label 'x' on the active branch\. y+…?$/);
	assert.doesNotMatch(rows[2] ?? "", /Use action/);
	const raw = renderToolResult(failure, collapsed, theme, true).render(80)[0];
	assert.ok(raw?.startsWith(theme.getFgAnsi("error")));
	// The refusal marker alone is enough when the host has not promoted it yet.
	oneLinePerWidth(renderToolResult(failure, collapsed, theme, false));
	const full = renderToolResult(failure, expanded, theme, true).render(130);
	assert.match(plain(full), /Use action='list'\./);
});

test("expanded results show the full text the model received", () => {
	const lines = renderToolResult(results.list, expanded, theme, false).render(80);
	assert.match(plain(lines), /\[list\] · 3 labels[\s\S]*4\.1% {2}ctx[\s\S]*9\.0% {2}b/);
	assert.ok(lines.length > 1);
});

test("garbage results render without throwing", () => {
	const garbage = [
		undefined,
		null,
		{},
		7,
		{ content: null },
		{ content: [null, 3, { type: "text" }] },
		{ details: "x" },
		{ details: { count: "3", id: 4, label: 1 } },
		{ content: [{ type: "text", text: "\x1b[31mhi\x1b[0m" }], details: [] },
	];
	for (const result of garbage) {
		for (const isError of [false, true]) {
			for (const options of [collapsed, expanded]) {
				for (const width of WIDTHS) {
					const lines = renderToolResult(result, options, theme, isError).render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
					if (!options.expanded) assert.ok(lines.length <= 1);
				}
			}
		}
	}
	const escaped = renderToolResult(garbage[8], collapsed, theme, false);
	assert.equal(plain(escaped.render(80)), "[31mhi [0m");
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
