/** Tests for the in-memory runtime config store. Node test runner. */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	clearRuntimeConfig,
	readAutomaticFoldingControl,
	readRuntimeConfig,
	setAutomaticFoldingPaused,
	writeRuntimeConfig,
} from "../../src/core/runtime-config.ts";

describe("runtime config store", () => {
	it("keeps pause session-local, independent of saved settings, and clears it on reset", () => {
		const first = readAutomaticFoldingControl("pause-a");
		assert.equal(first.paused, false);
		setAutomaticFoldingPaused("pause-a", true);
		const paused = readAutomaticFoldingControl("pause-a");
		assert.equal(paused.paused, true);
		assert.equal(readAutomaticFoldingControl("pause-b").paused, false);
		writeRuntimeConfig("pause-a", { auto_navigate: { enabled: true } });
		assert.equal(readAutomaticFoldingControl("pause-a"), paused);
		setAutomaticFoldingPaused("pause-a", false);
		assert.notEqual(readAutomaticFoldingControl("pause-a"), first);
		clearRuntimeConfig("pause-a");
		assert.equal(readAutomaticFoldingControl("pause-a").paused, false);
		assert.deepEqual(readRuntimeConfig("pause-a"), {});
	});

	it("returns an empty root for an unknown session", () => {
		assert.deepEqual(readRuntimeConfig("runtime-unknown"), {});
	});

	it("isolates sessions and clears only the named one", () => {
		writeRuntimeConfig("runtime-a", { anchorStartAfterTurns: 2 });
		writeRuntimeConfig("runtime-b", { anchorStartAfterTurns: 9 });
		assert.deepEqual(readRuntimeConfig("runtime-a"), {
			anchorStartAfterTurns: 2,
		});
		assert.deepEqual(readRuntimeConfig("runtime-b"), {
			anchorStartAfterTurns: 9,
		});
		clearRuntimeConfig("runtime-a");
		assert.deepEqual(readRuntimeConfig("runtime-a"), {});
		assert.deepEqual(readRuntimeConfig("runtime-b"), {
			anchorStartAfterTurns: 9,
		});
		clearRuntimeConfig("runtime-b");
	});

	it("replaces the previous root on write", () => {
		writeRuntimeConfig("runtime-replace", { parentHandoffMode: "full" });
		writeRuntimeConfig("runtime-replace", { continuity: { capture: false } });
		assert.deepEqual(readRuntimeConfig("runtime-replace"), {
			continuity: { capture: false },
		});
		clearRuntimeConfig("runtime-replace");
	});

	it("clones on write and on read so callers cannot mutate the store", () => {
		const written = { treeProposal: { tools: { read: "omit" } } };
		writeRuntimeConfig("runtime-clone", written);
		written.treeProposal.tools.read = "full";
		const first = readRuntimeConfig("runtime-clone");
		assert.deepEqual(first, { treeProposal: { tools: { read: "omit" } } });
		(first.treeProposal as { tools: Record<string, string> }).tools["bash"] = "full";
		assert.deepEqual(readRuntimeConfig("runtime-clone"), {
			treeProposal: { tools: { read: "omit" } },
		});
		assert.notEqual(readRuntimeConfig("runtime-clone"), first);
		clearRuntimeConfig("runtime-clone");
	});
});
