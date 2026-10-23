import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { trySessionWrite } from "./session-write.ts";

test("a failed persisted append cannot become the parent of the next write", () => {
  const dir = mkdtempSync(join(tmpdir(), "navigator-write-"));
  try {
    const sm = SessionManager.create(dir, dir);
    const original = sm.appendMessage(fauxAssistantMessage("original"));
    const internals = sm as unknown as {
      _persist: (...args: unknown[]) => void;
    };
    const persist = internals._persist;
    internals._persist = () => {
      throw new Error("injected disk failure");
    };
    const failed = trySessionWrite(sm, () =>
      sm.appendMessage({
        role: "user",
        content: "not persisted",
        timestamp: 1,
      }),
    );
    internals._persist = persist;
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.cursorRestored, true);
    assert.equal(sm.getLeafId(), original);
    const receipt = trySessionWrite(sm, () =>
      sm.appendCustomEntry("receipt", {}),
    );
    assert.equal(receipt.ok, true);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.deepEqual(
      reopened.getBranch().map((e) => e.id),
      sm.getBranch().map((e) => e.id),
    );
    assert.equal(reopened.getBranch().at(-1)?.parentId, original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed append from an empty session restores the null cursor", () => {
  const sm = SessionManager.inMemory();
  const result = trySessionWrite(sm, () => {
    sm.appendMessage(fauxAssistantMessage("uncommitted"));
    throw new Error("failure after memory mutation");
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cursorRestored, true);
  assert.equal(sm.getLeafId(), null);
});

test("reports inability to restore the cursor instead of masking it", () => {
  let leaf: string | null = "before";
  const sm = {
    getLeafId: () => leaf,
    branch: () => {
      throw new Error("cannot restore");
    },
    resetLeaf: () => {
      leaf = null;
    },
  };
  const result = trySessionWrite(sm, () => {
    leaf = "unpersisted";
    throw new Error("write failed");
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cursorRestored, false);
});
