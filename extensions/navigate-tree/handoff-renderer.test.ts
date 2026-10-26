import { test } from "bun:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	BranchSummaryMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type SessionEntry,
	type Theme,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, visibleWidth } from "@earendil-works/pi-tui";
import { makeHandoff } from "./handoff.ts";
import {
	handoffRow,
	handoffView,
	installHandoffPatches,
	registerHandoffRenderer,
} from "./handoff-renderer.ts";

initTheme("dark", false);
const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { theme } = (await import(
	pathToFileURL(join(root, "modes/interactive/theme/theme.js")).href
)) as { theme: Theme };
const base = { timestamp: "2026-01-01T00:00:00Z", parentId: null };
const data = makeHandoff({
	name: "native-card",
	title: "Native handoff",
	report:
		"## Goal\nKeep the session readable\n\n## Outcome\nDelivered a compact card\n\n## Report\nFULL_STORED_REPORT",
	mode: "synthesized",
	children: ["child"],
	sourceEntries: [],
});
const summary: Extract<SessionEntry, { type: "branch_summary" }> = {
	...base,
	id: "summary",
	type: "branch_summary",
	fromId: "archived",
	summary: data.report,
	details: { treeNavigator: data },
};
const message = {
	role: "branchSummary" as const,
	fromId: summary.fromId,
	summary: summary.summary,
	timestamp: 1,
};
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

test("real native cards expand, fit narrow/wide widths, fall back, and clean up scoped hooks", () => {
	const prototype = BranchSummaryMessageComponent.prototype as unknown as Record<string, unknown>;
	const original = prototype.updateDisplay;
	const treePrototype = Object.getPrototypeOf(
		new TreeSelectorComponent(
			[],
			null,
			1,
			() => {},
			() => {},
		).getTreeList(),
	) as Record<string, unknown>;
	const originalTreeText = treePrototype.getEntryDisplayText;
	let current: SessionEntry[] = [summary];
	let warnings = 0;
	const options = {
		entries: () => current,
		theme: () => theme,
		warn: () => {
			warnings++;
		},
	};
	const first = installHandoffPatches(options);
	const second = installHandoffPatches(options);
	first();
	assert.notEqual(prototype.updateDisplay, original);
	try {
		const card = new BranchSummaryMessageComponent(message);
		const collapsed = plain(card.render(60));
		assert.match(collapsed, /Native handoff/);
		assert.match(collapsed, /Goal: Keep the session readable/);
		assert.match(collapsed, /Outcome: Delivered a compact card/);
		assert.match(collapsed, /recorded inclusive/);
		assert.doesNotMatch(collapsed, /FULL_STORED_REPORT/);
		const region = card.children[0];
		assert.ok(region instanceof MouseRegion);
		assert.deepEqual(
			region.handleMouse({
				type: "click",
				button: "left",
				x: 0,
				y: 0,
				screenX: 0,
				screenY: 0,
				width: 60,
				height: 8,
				shift: false,
				alt: false,
				ctrl: false,
			}),
			{ handled: true },
		);
		assert.match(plain(card.render(60)), /FULL_STORED_REPORT/);
		for (const expanded of [false, true]) {
			card.setExpanded(expanded);
			for (const width of [60, 130]) {
				const lines = card.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				if (expanded) {
					assert.match(plain(lines), /FULL_STORED_REPORT/);
					assert.match(plain(lines), /parent synthesis only/);
				}
			}
		}
		const selector = new TreeSelectorComponent(
			[],
			null,
			1,
			() => {},
			() => {},
		);
		const list = selector.getTreeList() as unknown as {
			getEntryDisplayText(node: unknown, selected: boolean): string;
		};
		assert.match(
			plain([list.getEntryDisplayText({ entry: summary }, false)]),
			/^Native handoff — Delivered/,
		);
		current = [];
		card.invalidate();
		assert.match(plain(card.render(60)), /Branch Summary/);
		card.setExpanded(false);
		assert.match(plain(card.render(60)), /Branch summary/);
		current = [summary, { ...summary, id: "ambiguous" }];
		card.invalidate();
		assert.match(plain(card.render(60)), /Branch summary/);
		assert.equal(warnings, 0);
	} finally {
		second();
	}
	assert.equal(prototype.updateDisplay, original);
	assert.equal(treePrototype.getEntryDisplayText, originalTreeText);
	second();
	assert.equal(prototype.updateDisplay, original);
});

test("legacy anchored handoffs trace archived ancestry and union nested sources", () => {
	const user: SessionEntry = {
		...base,
		id: "user",
		type: "message",
		message: { role: "user", content: "Work", timestamp: 1 },
	};
	const child = {
		...summary,
		id: "child",
		fromId: user.id,
		fromHook: true,
		details: undefined,
	};
	const parent = { ...child, id: "parent", fromId: child.id };
	const labels: SessionEntry[] = [child, parent].map((entry) => ({
		...base,
		id: `label-${entry.id}`,
		type: "label",
		targetId: entry.id,
		label: `anchor:${entry.id}-work`,
	}));
	const entries = [user, child, parent, ...labels];
	const view = handoffView(parent, entries);
	assert.ok(view);
	assert.equal(view.title, "parent work");
	assert.equal(view.stats.messages, 1);
	assert.deepEqual(new Set(view.sourceIds), new Set(["child", "user"]));
	assert.deepEqual(view.children, ["child"]);
	assert.equal(handoffView({ ...parent, fromHook: false }, entries), undefined);
	assert.match(handoffRow(view), /^parent work — Delivered/);
});

test("legacy retrospective ranges count physical sources and malformed metadata remains native", () => {
	const sources: SessionEntry[] = ["a", "b"].map((id) => ({
		...base,
		id,
		type: "message",
		message: { role: "user", content: id, timestamp: 1 },
	}));
	const legacy = {
		...summary,
		fromHook: true,
		details: { retrospective: true, firstEntryId: "a", lastEntryId: "b" },
	};
	const label: SessionEntry = {
		...base,
		id: "label",
		type: "label",
		targetId: legacy.id,
		label: "anchor:range",
	};
	assert.equal(handoffView(legacy, [...sources, legacy, label])?.stats.messages, 2);
	assert.equal(
		handoffView({ ...summary, details: { treeNavigator: { version: 99 } } }, [summary]),
		undefined,
	);
});

test("registration probes only UI sessions and uses fresh session context after reload", () => {
	const handlers = new Map<string, (_event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on(event: string, handler: (_event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const prototype = BranchSummaryMessageComponent.prototype as unknown as Record<string, unknown>;
	const original = prototype.updateDisplay;
	const ctx = {
		hasUI: false,
		mode: "tui",
		sessionManager: { getEntries: () => [summary] },
		ui: {
			theme,
			notify() {
				assert.fail("Unexpected compatibility warning");
			},
		},
	} as unknown as ExtensionContext;
	registerHandoffRenderer(pi);
	assert.equal(prototype.updateDisplay, original);
	handlers.get("session_start")?.({}, ctx);
	assert.equal(prototype.updateDisplay, original);
	try {
		handlers.get("session_start")?.({}, { ...ctx, hasUI: true });
		assert.match(plain(new BranchSummaryMessageComponent(message).render(60)), /Native handoff/);
		handlers.get("session_start")?.({}, {
			...ctx,
			hasUI: true,
			sessionManager: { getEntries: () => [] },
		} as unknown as ExtensionContext);
		assert.match(plain(new BranchSummaryMessageComponent(message).render(60)), /Branch summary/);
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
	}
	assert.equal(prototype.updateDisplay, original);
});

test("incompatible native shape warns once and preserves original method", () => {
	const prototype = BranchSummaryMessageComponent.prototype as unknown as Record<string, unknown>;
	const original = prototype.updateDisplay;
	let warnings = 0;
	const dispose = installHandoffPatches({
		entries: () => {
			throw new Error("unavailable");
		},
		theme: () => theme,
		warn: () => {
			warnings++;
		},
	});
	try {
		const card = new BranchSummaryMessageComponent(message);
		card.invalidate();
		assert.match(plain(card.render(60)), /Branch summary/);
		assert.equal(warnings, 1);
	} finally {
		dispose();
	}
	assert.equal(prototype.updateDisplay, original);
});
