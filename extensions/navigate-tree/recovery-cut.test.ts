import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { recoveryCutOf } from "./index.ts";

function call(sm: SessionManager, id = "reused") {
  return sm.appendMessage(
    fauxAssistantMessage(
      [{ type: "toolCall", id, name: "read", arguments: {} }],
      { stopReason: "toolUse" },
    ),
  );
}

function result(sm: SessionManager, id = "reused") {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "real result" }],
    isError: false,
    timestamp: 1,
  });
}

function request(sm: SessionManager) {
  return sm.appendMessage({
    role: "user",
    content: "keep this exact request",
    timestamp: 1,
  });
}

describe("canonical recovery cuts", () => {
  it("ignores metadata and failed assistants after unanswered user/custom input without writes", () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const sm = SessionManager.inMemory();
      const work = sm.appendMessage(fauxAssistantMessage("completed work"));
      const input = request(sm);
      sm.appendCustomMessageEntry("other-extension", "new custom input", true);
      sm.appendLabelChange(input, "input-label");
      sm.appendModelChange("mock", "mock-model");
      sm.appendCustomEntry("navigate-tree-continuity-ops", {});
      sm.appendContextEdit(work, {
        content: [{ type: "text", text: "edited work" }],
      });
      sm.appendMessage(fauxAssistantMessage("failed answer", { stopReason }));
      const before = JSON.stringify(sm.getEntries());
      assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: work });
      assert.equal(JSON.stringify(sm.getEntries()), before);
    }
  });

  it("accepts completed reused IDs but cannot discharge unresolved reuse with an older result", () => {
    const sm = SessionManager.inMemory();
    call(sm);
    result(sm);
    call(sm);
    const completed = result(sm);
    assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: completed });
    call(sm);
    request(sm);
    assert.equal(recoveryCutOf(sm).ok, false);
    result(sm);
    request(sm);
    assert.equal(recoveryCutOf(sm).ok, false);
  });

  it("fails closed without writes when a result crosses unanswered user or custom input", () => {
    for (const custom of [false, true]) {
      const sm = SessionManager.inMemory();
      sm.appendMessage(fauxAssistantMessage("completed work"));
      call(sm);
      if (custom)
        sm.appendCustomMessageEntry("other", "keep exact custom", true);
      else request(sm);
      result(sm);
      const before = JSON.stringify(sm.getEntries());
      assert.equal(recoveryCutOf(sm).ok, false);
      assert.equal(JSON.stringify(sm.getEntries()), before);
    }
  });

  it("fails closed on overlapping IDs and orphan effective results", () => {
    const overlapping = SessionManager.inMemory();
    call(overlapping);
    call(overlapping);
    result(overlapping);
    assert.equal(recoveryCutOf(overlapping).ok, false);
    const orphan = SessionManager.inMemory();
    result(orphan);
    assert.equal(recoveryCutOf(orphan).ok, false);
  });

  it("uses context-edited envelopes instead of raw tool IDs", () => {
    const sm = SessionManager.inMemory();
    const work = sm.appendMessage(fauxAssistantMessage("completed"));
    const incomplete = call(sm);
    request(sm);
    sm.appendContextEdit(incomplete, null);
    assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: work });

    const missingResult = SessionManager.inMemory();
    call(missingResult);
    const completed = result(missingResult);
    request(missingResult);
    missingResult.appendContextEdit(completed, null);
    assert.equal(recoveryCutOf(missingResult).ok, false);
  });

  it("accepts a native summary's real archived completion, including nested summaries", () => {
    const sm = SessionManager.inMemory();
    const retained = call(sm);
    result(sm);
    const first = sm.branchWithSummary(retained, "native summary");
    request(sm);
    assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: first });
    const second = sm.branchWithSummary(retained, "nested native summary");
    request(sm);
    assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: second });
    call(sm);
    request(sm);
    assert.equal(
      recoveryCutOf(sm).ok,
      false,
      "archived completion belongs to the older occurrence",
    );
  });

  it("cannot borrow a real result from a sibling outside summary.fromId ancestry", () => {
    const sm = SessionManager.inMemory();
    const retained = call(sm);
    result(sm);
    sm.branch(retained);
    request(sm);
    sm.branchWithSummary(retained, "summary without a completed call");
    request(sm);
    assert.equal(recoveryCutOf(sm).ok, false);
  });

  it("does not treat native compaction as an answer to retained input", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(fauxAssistantMessage("completed work"));
    const input = request(sm);
    sm.appendCompaction("native summary", input, 1000);
    assert.equal(recoveryCutOf(sm).ok, false);
  });

  it("keeps native compaction projection and ignores archived incomplete envelopes", () => {
    const sm = SessionManager.inMemory();
    call(sm);
    const kept = sm.appendMessage(fauxAssistantMessage("kept completed work"));
    const compaction = sm.appendCompaction(
      "native compacted context",
      kept,
      1000,
    );
    request(sm);
    assert.deepEqual(recoveryCutOf(sm), { ok: true, foldPointId: compaction });
  });
});
