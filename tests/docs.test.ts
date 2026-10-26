/** Extension docs tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installHarnessHooks } from "./support/harness-hooks.ts";

installHarnessHooks();

describe("docs: history-mirroring providers", () => {
	const readme = readFileSync(new URL("../docs/how-it-works.md", import.meta.url), "utf8");

	it("does not claim the summary is the paused Claude Code query", () => {
		assert.doesNotMatch(readme, /paused Claude Code query/);
	});

	it("marks independent summary calls as untested on mirroring providers", () => {
		assert.match(
			readme,
			/Independent summary calls\.\*\* Registry side requests and chunked evidence are unverified on this history-mirroring provider/,
		);
	});
});

describe("docs: independent overflow recovery", () => {
	const readme = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");

	it("documents recovery without forced rewinds or withheld tool results", () => {
		assert.match(readme, /### Independent overflow recovery/);
		assert.doesNotMatch(readme, /rewind-driven compaction/);
		assert.doesNotMatch(readme, /withheld notice/);
		assert.doesNotMatch(readme, /only rewind is allowed until it lands/);
	});

	it("documents the failure receipt instead of a forced-rewind gate", () => {
		assert.ok(readme.includes("Request stopped before generation: estimated input"));
		assert.match(readme, /up to three\s+times per request/);
	});
});

// =============================================================================
// Rewind-driven compaction (#101)
//
// The overflow turns are simulated: the overflowed assistant is appended as
// pi persists it, then the boundaries fire in pi's order (`turn_end`,
// `agent_end`, `agent_before_settle`, `agent_settled`). Window 100k, hint
// reserve 20k, pi's compaction off with its default reserve (16384), so the
// target is 83 616 tokens.
// =============================================================================
