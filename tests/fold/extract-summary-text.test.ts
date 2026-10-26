/** Extension extract summary text tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { extractSummaryText } from "../../src/fold/summary-prompt.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { SUMMARY_TEXT } from "../support/model-registry.ts";

installHarnessHooks();

describe("extractSummaryText", () => {
	it("returns the text from the '## Goal' heading on, trimmed", () => {
		assert.equal(extractSummaryText(`${SUMMARY_TEXT}\n\n`), SUMMARY_TEXT);
	});

	it("drops a preamble before the heading", () => {
		assert.equal(extractSummaryText(`Here you go:\n\n${SUMMARY_TEXT}`), SUMMARY_TEXT);
	});

	it("returns null without a line-start '## Goal' heading", () => {
		for (const text of [
			"",
			"Okay, summarizing.",
			"### Goal\nx",
			"## Goals\nx",
			"text ## Goal inline",
			"## goal\nlowercase",
		]) {
			assert.equal(extractSummaryText(text), null, JSON.stringify(text));
		}
	});

	it("refuses a bare heading line: the body after it must be non-empty", () => {
		assert.equal(extractSummaryText("## Goal"), null);
		assert.equal(extractSummaryText("## Goal: ship"), null);
		assert.equal(extractSummaryText("preamble\n## Goal   \n\n  "), null);
		assert.equal(extractSummaryText("## Goal\nx"), "## Goal\nx");
		assert.equal(extractSummaryText("## Goal: ship\nx"), "## Goal: ship\nx");
	});
});
// =============================================================================
// fold summary blocks and late-entry re-append (#80)
// =============================================================================
