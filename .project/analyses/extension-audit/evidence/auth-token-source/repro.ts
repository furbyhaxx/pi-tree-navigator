import { strict as assert } from "node:assert";
import { createEventBus } from "../../../../../../pi-auth-plus/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { queryTokens } from "../../../../../../pi-auth-plus/src/bus/tokens.ts";
import { createSyntheticFamily } from "../../../../../../pi-auth-plus/src/families/synthetic/index.ts";
import { registerTokenBus } from "../../../../../../pi-auth-plus/src/tokens/bus.ts";
import { createTokenEngine } from "../../../../../../pi-auth-plus/src/tokens/engine/index.ts";
import { createTokenTracker } from "../../../../../../pi-auth-plus/src/tokens/tracker/index.ts";

let loaded = false;
const tokenizer = { id: "example/model@fixture", count: (text: string) => text.length };
const tokenizers = { peek: () => (loaded ? tokenizer : undefined), load: async () => undefined };
const engine = createTokenEngine({
  families: [createSyntheticFamily({})],
  deps: { auth: async () => undefined, fetch: async () => { throw new Error("network forbidden"); }, tokenizers },
  tools: () => [],
});
const assistant = {
  role: "assistant", content: [], api: "anthropic-messages", provider: "synthetic",
  model: "hf:example/model", stopReason: "stop", timestamp: 0,
  usage: { input: 180, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 200,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const entry = { type: "message", id: "a", parentId: null, timestamp: "", message: assistant };
const projection = { entries: [{ sourceEntry: entry, messages: [assistant] }], messages: [assistant], thinkingLevel: "off", model: null };
const ctx = {
  model: { provider: "synthetic", id: assistant.model, contextWindow: 1000 },
  sessionManager: { buildSessionProjection: () => projection, getBranch: () => [entry] },
  getSystemPrompt: () => "", getContextUsage: () => undefined,
};
const before = await engine.context(ctx as never);
loaded = true;
const after = await engine.context(ctx as never);
assert.deepEqual(before?.anchor, { tokens: 200, source: "provider" });
assert.deepEqual(after?.anchor, { tokens: 200, source: "tokenizer" });
console.log("tokenizer load alone: unchanged 200-token stored usage source provider -> tokenizer");

loaded = false;
const switched = await engine.context({ ...ctx, model: { ...ctx.model, id: "hf:example/other" } } as never);
assert.equal(switched?.model, "hf:example/other");
assert.deepEqual(switched?.anchor, { tokens: 200, source: "provider" });
console.log("model switch: current hf:example/other reused hf:example/model's 200-token anchor");

const handlers = new Map<string, (event: unknown, context: unknown) => void>();
const pi = { on(name: string, handler: (event: unknown, context: unknown) => void) { handlers.set(name, handler); return () => handlers.delete(name); } };
let leaf = "before";
let count = 100;
const trackerCtx = { model: { provider: "synthetic", id: "m" }, sessionManager: { getSessionId: () => "s", getLeafId: () => leaf } };
const tracker = createTokenTracker(pi as never, {
  debounceMs: 60_000,
  engine: {
    context: async () => ({ provider: "synthetic", model: "m", contextWindow: 1000,
      tokens: { tokens: count, source: "estimate" }, percent: count / 10, anchor: undefined,
      tail: { tokens: count, source: "estimate" }, tailMessages: 1, pi: undefined, computedAt: 42 }),
    breakdown: async () => [], counterFor: () => { throw new Error("unused"); },
  } as never,
});
const emit = (event: string) => handlers.get(event)?.({ type: event }, trackerCtx);
const events = createEventBus();
const stop = registerTokenBus(events, tracker);
try {
  emit("session_start");
  await tracker.refresh();
  leaf = "compacted";
  count = 20;
  emit("session_compact");
  const cached = await queryTokens(events);
  const refreshed = await queryTokens(events, { refresh: true });
  assert.equal(cached.report?.tokens.tokens, 100);
  assert.equal(refreshed.report?.tokens.tokens, 20);
  console.log("post-compaction bus: cached=100, refresh=20 for changed leaf");
} finally {
  stop();
  tracker.dispose();
}
