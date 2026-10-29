import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as AuthSessionManager } from "../../../../../pi-auth-plus/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { createTokenEngine } from "../../../../../pi-auth-plus/src/tokens/engine/index.ts";
import { correctSyntheticRequestUsage } from "../../../../../pi-auth-plus/src/families/synthetic/usage.ts";
import { estimateRequestTokens } from "../../../../src/core/context-tokens.ts";
import { projectHandoffs } from "../../../../src/fold/handoff-projection.ts";

const unavailable = async () => undefined;
const engine = createTokenEngine({
	families: [],
	deps: {
		auth: unavailable,
		fetch: async () => { throw new Error("Network prohibited in this reproduction"); },
		tokenizers: { peek: () => undefined, load: unavailable },
	},
	tools: () => [],
});

const sm = SessionManager.inMemory("/tmp");
sm.appendMessage({
	role: "toolResult", toolCallId: "synthetic-call", toolName: "read",
	content: [{ type: "text", text: JSON.stringify({ values: Array.from({ length: 1000 }, (_, i) => ({ i, value: `record-${i}` })) }) }],
	isError: false, timestamp: 1,
});
const report = await engine.context({
	model: { provider: "test", id: "synthetic-fixture", contextWindow: 100000 },
	sessionManager: sm,
	getSystemPrompt: () => "",
	getContextUsage: () => undefined,
});
assert.ok(report);
const nav = estimateRequestTokens(sm.buildSessionProjection().messages);
assert.notEqual(nav, report.tokens.tokens);
console.log(JSON.stringify({ case: "same-json-tail-default-estimates", navigator: nav, authPlus: report.tokens, qualifier: "Both are estimates; this is not a tokenizer accuracy comparison. Standalone toolResult isolates message counting." }));

const persisted = SessionManager.inMemory("/tmp");
persisted.appendMessage({ role: "system", content: "tiny", timestamp: 1 });
persisted.appendMessage({ role: "user", content: "hi", timestamp: 2 });
const forcedSystem = "x".repeat(4000);
const persistedReport = await engine.context({
	model: { provider: "test", id: "synthetic-fixture", contextWindow: 100000 },
	sessionManager: persisted,
	getSystemPrompt: () => forcedSystem,
	getContextUsage: () => undefined,
});
assert.ok(persistedReport);
assert.equal(persistedReport.tokens.tokens, 2);
const requestTokens = estimateRequestTokens([
	{ role: "system", content: forcedSystem, timestamp: 1 },
	{ role: "user", content: "hi", timestamp: 2 },
]);
assert.ok(requestTokens > 1000);
console.log(JSON.stringify({ case: "persisted-report-is-not-effective-request", authPlusPersisted: persistedReport.tokens, navigatorEffectiveRequest: requestTokens, qualifier: "Synthetic forced prompt supplied to getSystemPrompt; engine deliberately prefers persisted system state. No real request was dispatched." }));

const model = "hf:fixture/count-model";
const message: AssistantMessage = {
	role: "assistant", api: "anthropic-messages", provider: "synthetic", model,
	content: [{ type: "text", text: "reply" }], stopReason: "stop", timestamp: 2,
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 100, totalTokens: 220,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const tokenizer = { id: "synthetic-test-tokenizer", count: (text: string) => text.length };
const corrected = correctSyntheticRequestUsage(message,
	{ model, messages: [{ role: "user", content: "x".repeat(1000) }] },
	{ peek: () => tokenizer, load: async () => tokenizer },
);
assert.ok(corrected);
assert.equal(corrected.usage.totalTokens, 1020);
assert.equal(estimateRequestTokens([corrected]), 1020);
console.log(JSON.stringify({ case: "corrected-usage-is-consumed", before: estimateRequestTokens([message]), correctedUsage: corrected.usage.totalTokens, navigator: estimateRequestTokens([corrected]), qualifier: "Injected tokenizer establishes plumbing, not provider accuracy." }));

const switchedSession = AuthSessionManager.inMemory("/tmp");
switchedSession.appendModelChange("synthetic", model);
switchedSession.appendMessage({ role: "user", content: "hello", timestamp: 1 });
switchedSession.appendMessage(message);
switchedSession.appendModelChange("synthetic", "hf:fixture/other");
const switchContext = {
	model: { provider: "synthetic", id: "hf:fixture/other", contextWindow: 100000 },
	sessionManager: switchedSession,
	getSystemPrompt: () => "",
	getContextUsage: () => undefined,
};
const staleModelReport = await engine.context(switchContext);
assert.equal(staleModelReport?.anchor?.tokens, 220);
const protectedModelReport = await engine.context({
	...switchContext,
	sessionManager: {
		getBranch: () => switchedSession.getBranch(),
		buildSessionProjection: () => projectHandoffs(switchedSession.buildSessionProjection(), switchedSession.getEntries()),
	},
});
assert.equal(protectedModelReport?.anchor, undefined);
console.log(JSON.stringify({ case: "real-session-model-switch", oldModel: model, selectedModel: switchContext.model.id, authPlusUnpatchedAnchor: staleModelReport?.anchor, withNavigatorProjectionAnchor: protectedModelReport?.anchor ?? null, qualifier: "Real auth-plus Pi 1.4 SessionManager. Navigator projection invalidation masks this standalone auth-plus defect when active on the shared host." }));

const edited = SessionManager.inMemory("/tmp");
edited.appendModelChange("synthetic", model);
const userId = edited.appendMessage({ role: "user", content: "x".repeat(1000), timestamp: 1 });
edited.appendMessage(corrected);
edited.appendContextEdit(userId, null);
const projection = projectHandoffs(edited.buildSessionProjection(), edited.getEntries());
const remainingUsage = projection.messages.find((entry) => entry.role === "assistant")?.usage?.totalTokens;
assert.equal(remainingUsage, 0);
console.log(JSON.stringify({ case: "edited-context-invalidates-corrected-baseline", remainingUsage, navigator: estimateRequestTokens(projection.messages), qualifier: "Invalidation is correct: the old measurement no longer measures this projection. A recount service is needed to retain better counting." }));
