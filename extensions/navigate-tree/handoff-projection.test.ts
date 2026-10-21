import assert from "node:assert/strict";
import { test } from "node:test";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  AgentSession,
  convertToLlm,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { estimateContextTokens } from "./context-tokens.ts";
import {
  installHandoffProjection,
  invalidateStaleUsage,
} from "./handoff-projection.ts";

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

const WINDOW = 200_000;
const REQUEST_CAP = 32_768;
const FRESH = 180_000;
const STALE = 199_000;
const model = { provider: "fixture", modelId: "fixture" };
const nextTimestamp = (() => {
  let last = 0;
  return () => {
    last = Math.max(last + 1, Date.now());
    return last;
  };
})();

function user(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: nextTimestamp(),
  };
}

function assistant(text: string, total: number, who = model) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "fixture",
    provider: who.provider,
    model: who.modelId,
    stopReason: "stop" as const,
    usage: {
      input: total,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: total,
      cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
    },
    timestamp: nextTimestamp(),
  };
}

function observe(sm: SessionManager) {
  const native = AgentSession.prototype.getContextUsage.call({
    _limitsModel: () => ({ contextWindow: WINDOW }),
    sessionManager: sm,
  } as unknown as AgentSession);
  return {
    local: estimateContextTokens(sm.buildSessionContext().messages),
    native: native?.tokens,
    request: clampMaxTokensToContext(
      { contextWindow: WINDOW } as never,
      { messages: convertToLlm(sm.buildSessionProjection().messages) } as never,
      REQUEST_CAP,
    ),
  };
}

function compare(sm: SessionManager) {
  const raw = observe(sm);
  const restore = installHandoffProjection();
  try {
    return { raw, safe: observe(sm) };
  } finally {
    restore();
  }
}

function persistedUsage(sm: SessionManager, id: string) {
  const entry = sm.getEntry(id);
  assert.ok(entry?.type === "message" && entry.message.role === "assistant");
  return entry.message.usage;
}

test("an edit of the assistant baseline invalidates its usage in every estimate path", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("question"));
  const baseline = sm.appendMessage(assistant("long answer", STALE));
  sm.appendContextEdit(baseline, { content: "short" });
  const { raw, safe } = compare(sm);
  assert.ok(raw.local >= STALE);
  assert.equal(raw.request, 1);
  assert.ok(safe.local < 100);
  assert.ok(safe.native !== undefined && safe.native !== null);
  assert.ok(safe.native < 100);
  assert.equal(safe.request, REQUEST_CAP);
  const usage = persistedUsage(sm, baseline);
  assert.equal(usage.totalTokens, STALE);
  assert.equal(usage.cost.total, 3);
});

test("an edit appended after the baseline invalidates it even when it targets older content, and fresh usage then wins", () => {
  const sm = SessionManager.inMemory();
  const first = sm.appendMessage(user("question"));
  sm.appendMessage(assistant("answer", STALE));
  sm.appendContextEdit(first, { content: "short" });
  const stale = compare(sm);
  assert.ok(stale.raw.local >= STALE);
  assert.ok(stale.safe.local < 100);
  sm.appendMessage(assistant("fresh", FRESH));
  const fresh = compare(sm);
  assert.equal(fresh.safe.local, FRESH);
  assert.equal(fresh.safe.native, FRESH);
  assert.equal(fresh.safe.request, WINDOW - FRESH - 4096);
});

test("usage measured before the edited entry stays exact", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("question"));
  sm.appendMessage(assistant("first", 50_000));
  const edited = sm.appendMessage(user("large paste"));
  sm.appendMessage(assistant("second", STALE));
  sm.appendContextEdit(edited, { content: "short" });
  const { raw, safe } = compare(sm);
  assert.ok(raw.local >= STALE);
  assert.ok(safe.local >= 50_000 && safe.local < 50_100);
  assert.ok(safe.native !== undefined && safe.native !== null);
  assert.ok(safe.native < 50_100);
  assert.ok(safe.request > REQUEST_CAP - 1);
});

test("retained pre-compaction assistants stay invalid although the projection lists them after the compaction", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("old"));
  sm.appendMessage(assistant("old answer", 90_000));
  const kept = sm.appendMessage(user("kept question"));
  const retained = sm.appendMessage(assistant("kept answer", STALE));
  sm.appendCompaction("summary", kept, STALE);
  const projected = sm.buildSessionProjection();
  assert.equal(projected.entries[0].sourceEntry.type, "compaction");
  assert.equal(projected.entries[2].sourceEntry.id, retained);
  const stale = compare(sm);
  assert.ok(stale.raw.local >= STALE);
  assert.ok(stale.safe.local < 200);
  assert.equal(stale.safe.native, null);
  sm.appendMessage(user("next"));
  sm.appendMessage(assistant("fresh", FRESH));
  const fresh = compare(sm);
  assert.equal(fresh.safe.local, FRESH);
  assert.equal(fresh.safe.native, FRESH);
  assert.equal(fresh.safe.request, WINDOW - FRESH - 4096);
  assert.equal(persistedUsage(sm, retained).totalTokens, STALE);
});

test("edits on an abandoned branch do not invalidate the active branch baseline", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("question"));
  const baseline = sm.appendMessage(assistant("answer", FRESH));
  const abandoned = sm.appendContextEdit(baseline, { content: "short" });
  assert.ok(compare(sm).safe.local < 100);
  sm.branch(baseline);
  sm.appendMessage(user("follow-up"));
  const active = compare(sm);
  assert.ok(active.safe.local > FRESH);
  assert.equal(active.safe.local, active.raw.local);
  assert.equal(active.safe.native, active.raw.native);
  sm.branch(abandoned);
  assert.ok(compare(sm).safe.local < 100);
});

test("a model change or a different active model rejects older usage, while matching fresh usage survives", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("question"));
  sm.appendMessage(assistant("answer", STALE));
  sm.appendModelChange("other", "other-model");
  sm.appendMessage(user("next"));
  const changed = compare(sm);
  assert.ok(changed.raw.local >= STALE);
  assert.ok(changed.raw.native !== undefined && changed.raw.native !== null);
  assert.ok(changed.raw.native >= STALE);
  assert.equal(changed.raw.request, 1);
  assert.ok(changed.safe.local < 100);
  assert.ok(changed.safe.native !== undefined && changed.safe.native !== null);
  assert.ok(changed.safe.native < 100);
  assert.equal(changed.safe.request, REQUEST_CAP);
  sm.appendMessage(
    assistant("fresh", FRESH, { provider: "other", modelId: "other-model" }),
  );
  const fresh = compare(sm);
  assert.equal(fresh.safe.local, FRESH);
  assert.equal(fresh.safe.native, FRESH);
  assert.equal(fresh.safe.request, WINDOW - FRESH - 4096);
});

for (const active of [
  { provider: "other", modelId: model.modelId },
  { provider: model.provider, modelId: "other" },
]) {
  test(`usage from ${model.provider}/${model.modelId} is rejected once ${active.provider}/${active.modelId} is the active model`, () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(user("question"));
    sm.appendMessage(assistant("answer", STALE));
    sm.appendMessage(user("retry elsewhere"));
    sm.appendMessage({
      ...assistant("failed", 0, active),
      stopReason: "error",
    });
    const { raw, safe } = compare(sm);
    assert.ok(raw.local >= STALE);
    assert.equal(raw.request, 1);
    assert.ok(safe.local < 100);
    assert.equal(safe.request, REQUEST_CAP);
  });
}

test("a later system message invalidates earlier usage", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(user("question"));
  sm.appendMessage(assistant("answer", STALE));
  sm.appendMessage({
    role: "system",
    content: "tools changed",
    timestamp: nextTimestamp(),
  });
  const { raw, safe } = compare(sm);
  assert.ok(raw.local >= STALE);
  assert.ok(safe.local < 100);
  assert.ok(safe.native !== undefined && safe.native !== null);
  assert.ok(safe.native < 100);
});

test("invalidateStaleUsage works on flat entries without sources", () => {
  const clean = assistant("a", 10);
  const flat = [
    {
      sourceEntry: null,
      messages: [
        assistant("old", 100),
        { role: "system" as const, content: "x", timestamp: nextTimestamp() },
        clean,
      ],
    },
  ];
  const [result] = invalidateStaleUsage(flat, model);
  const [old, , kept] = result.messages;
  assert.ok(old.role === "assistant" && old.usage.totalTokens === 0);
  assert.equal(kept, clean);
  assert.equal(
    flat[0].messages[0].role === "assistant" &&
      flat[0].messages[0].usage.totalTokens,
    100,
  );
});
