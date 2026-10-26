/** Extension navigator renderers tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
} from "../../src/core/legacy-rewind.ts";
import { REWIND_CUSTOM_TYPE, wrapPlainLine } from "../../src/fold/fold-receipts.ts";
import { setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";

installHarnessHooks();

describe("rewind: TUI renderers", () => {
	it("wrapPlainLine word-wraps and hard-breaks long words", () => {
		assert.deepEqual(wrapPlainLine("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
		assert.deepEqual(wrapPlainLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
		assert.deepEqual(wrapPlainLine("short", 10), ["short"]);
	});

	it("wrapPlainLine wraps by terminal cells: CJK, emoji and tabs never exceed the width", () => {
		for (const text of [
			"保持用户指令并继续工作，直到完成所有任务为止。".repeat(3),
			"🚀🔥✅ emoji focus 🧪🧪🧪🧪🧪🧪🧪🧪🧪🧪",
			"\tTabbed\tfocus\twith\ttabs\teverywhere\t\t\t",
		]) {
			for (const width of [1, 2, 3, 5, 8, 13, 400]) {
				for (const line of wrapPlainLine(text, width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`${JSON.stringify(line)} is ${visibleWidth(line)} cells > ${width}`,
					);
					assert.ok(!line.includes("\t"), `${JSON.stringify(line)} has a tab`);
				}
			}
		}
	});

	it("registers compact historical rewind renderers and expands the old instruction", () => {
		const f = setup();
		const summaryRenderer = f.pi.messageRenderers.get(LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE) as (
			...args: unknown[]
		) => { render(width: number): string[] };
		const outcomeRenderer = f.pi.entryRenderers.get(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE) as (
			...args: unknown[]
		) => { render(width: number): string[] } | undefined;
		assert.ok(summaryRenderer);
		assert.ok(outcomeRenderer);
		const theme = {
			fg: (color: string, text: string) =>
				`\x1b[${color === "error" ? "31" : color === "warning" ? "33" : "36"}m${text}\x1b[39m`,
		};
		const instruction = `Summarize historical work only.\n${"Preserve the original instruction in full. ".repeat(8)}`;
		const message = {
			role: "custom",
			customType: LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
			content: `${instruction}\nDo not show this escape: \x1b[2J hidden.\x01`,
			display: true,
			details: {
				rewindTo: "a",
				newLabel: "b",
				contextBefore: 80_000,
				tokensAtTarget: 40_000,
				contextWindow: 100_000,
			},
			timestamp: 0,
		};
		for (const width of [60, 130]) {
			const collapsed = summaryRenderer(message, { expanded: false, outputPad: 1 }, theme).render(
				width,
			);
			assert.equal(collapsed.length, 1);
			assert.ok(visibleWidth(collapsed[0] ?? "") <= width);
			assert.match(stripVTControlCharacters(collapsed[0] ?? ""), /summary requested/);

			const expanded = summaryRenderer(message, { expanded: true, outputPad: 1 }, theme).render(
				width,
			);
			assert.ok(expanded.length > 1);
			assert.ok(expanded.every((line) => visibleWidth(line) <= width));
			const expandedText = stripVTControlCharacters(expanded.join("\n"));
			assert.ok(
				expandedText.replace(/\s+/gu, " ").includes(instruction.replace(/\s+/gu, " ")),
				`the full instruction is retained at ${width} columns`,
			);
			assert.ok(
				!expandedText.includes("[2J") && !expandedText.includes("\x01"),
				"historical escapes and controls are removed",
			);

			for (const [status, color] of [
				["failed", "31"],
				["aborted", "33"],
			] as const) {
				const rendered = outcomeRenderer(
					{
						data: {
							status,
							rewindTo: "a",
							newLabel: "b",
							reason: `branch failed \x1b[2J hidden`,
						},
					},
					{ expanded: false, outputPad: 1 },
					theme,
				);
				assert.ok(rendered);
				const row = rendered.render(width);
				assert.equal(row.length, 1);
				assert.ok(visibleWidth(row[0] ?? "") <= width);
				assert.ok(row[0]?.includes(`\x1b[${color}m`));
				assert.ok(!stripVTControlCharacters(row[0] ?? "").includes("[2J"));
			}
		}
	});

	it("renderers never emit a line wider than the terminal (pi-tui crashes on one)", async () => {
		const ansi = {
			fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
		};
		const f = setup();
		const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (...a: unknown[]) => {
			render(w: number): string[];
		};
		assert.ok(renderer);
		const failed = {
			role: "custom",
			customType: REWIND_CUSTOM_TYPE,
			content:
				"[navigate_tree] Fold to '开始' (collapse as '结束🚀') failed at the commit stage (commit-refused): the branch could not be written (磁盘已满 🚫\tdisk)\n\nNothing was collapsed.",
			display: true,
			details: { status: "failed" },
			timestamp: 0,
		};
		for (const width of [1, 2, 3, 7, 10, 17, 40, 400]) {
			for (const line of renderer(failed, { expanded: true, outputPad: 1 }, ansi).render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`${JSON.stringify(line)} is ${visibleWidth(line)} cells > ${width}`,
				);
				// Tabs are expanded to spaces: no raw tab reaches a row.
				assert.ok(!line.includes("\t"), `${JSON.stringify(line)} has a tab`);
			}
		}
	});
});

// =============================================================================
// extractSummaryText
// =============================================================================
