import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateContextTokens } from "./context-tokens.ts";
import { installHandoffProjection } from "./handoff-projection.ts";

const usage = {
  input: 100000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100010,
  cost: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, total: 7 },
};
test("native pre-request estimates and model context ignore old usage, while disk accounting and fresh usage survive", () => {
  const sm = SessionManager.inMemory();
  const id = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Retained tail" }],
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage,
    timestamp: 1,
  });
  sm.appendCustomEntry("tree-clone-provenance", {
    history: { sourceOrder: [id] },
  });
  assert.ok(estimateContextTokens(sm.buildSessionContext().messages) > 100000);
  const restore = installHandoffProjection();
  try {
    assert.ok(estimateContextTokens(sm.buildSessionContext().messages) < 100);
    const native = AgentSession.prototype.getContextUsage.call({
      _limitsModel: () => ({ contextWindow: 1000000 }),
      sessionManager: sm,
    } as unknown as AgentSession);
    assert.ok(native && native.tokens !== null && native.tokens < 100);
    const raw = sm.getEntry(id);
    assert.ok(raw?.type === "message" && raw.message.role === "assistant");
    assert.equal(raw.message.usage.totalTokens, 100010);
    assert.equal(raw.message.usage.cost.total, 7);
    sm.appendMessage({
      ...raw.message,
      usage: { ...usage, input: 40, output: 10, totalTokens: 50 },
      timestamp: 2,
    });
    assert.equal(estimateContextTokens(sm.buildSessionContext().messages), 50);
  } finally {
    restore();
  }
  assert.equal(estimateContextTokens(sm.buildSessionContext().messages), 50);
});
