/** Tests for the in-memory runtime config store. Node test runner. */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearRuntimeConfig,
  readRuntimeConfig,
  writeRuntimeConfig,
} from "./runtime-config.ts";

describe("runtime config store", () => {
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
    (first.treeProposal as { tools: Record<string, string> }).tools.bash =
      "full";
    assert.deepEqual(readRuntimeConfig("runtime-clone"), {
      treeProposal: { tools: { read: "omit" } },
    });
    assert.notEqual(readRuntimeConfig("runtime-clone"), first);
    clearRuntimeConfig("runtime-clone");
  });
});
