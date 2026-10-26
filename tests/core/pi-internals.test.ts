/** Extension pi internals tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { MAX_HINT_WALK_DEPTH } from "../../src/core/anchors.ts";
import { MAX_SESSION_REFS } from "../../src/core/pi-internals.ts";
import { __testHooks } from "../../src/index.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { makeFakeSession } from "../support/session-fakes.ts";
import { appendTurn } from "../support/session-messages.ts";

installHarnessHooks();

describe("refreshAgentMessages", () => {
	it("returns false when no session was captured", () => {
		const sm = SessionManager.inMemory("/tmp");
		assert.equal(__testHooks.refreshAgentMessages(sm), false);
	});

	it("returns false when agent.state is missing", () => {
		const sm = SessionManager.inMemory("/tmp");
		const fake = {
			sessionManager: sm,
			// agent present but state missing
			agent: { state: undefined, prepareNextTurn: undefined },
		};
		__testHooks.captureSession(fake as unknown as AgentSession);
		assert.equal(__testHooks.refreshAgentMessages(sm), false);
	});

	it("mutates agent.state.messages on success", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		} as never);
		const fake = makeFakeSession(sm);
		__testHooks.captureSession(fake as unknown as AgentSession);
		assert.equal(fake.agent.state.messages.length, 0);
		assert.equal(__testHooks.refreshAgentMessages(sm), true);
		assert.deepEqual(fake.agent.state.messages, sm.buildSessionContext().messages);
	});
});

// =============================================================================
// captureSession reaping
// =============================================================================

describe("captureSession reaping", () => {
	it("deduplicates the same session and bounds growth across many distinct sessions", () => {
		// Register a batch of short-lived sessions well above
		// MAX_SESSION_REFS so the reaper has work to do; the seenSessions
		// WeakSet dedupes within the same identity, and the sessionInstances
		// array gets reaped once length exceeds MAX_SESSION_REFS.
		//
		// Since WeakRef GC timing is non-deterministic, the bounded
		// assertion is the contract: the array doesn't grow proportional to
		// the number of pushes. (`Bun.gc(true)` is best-effort; if the
		// runtime doesn't expose it, we still get the dedupe + reap
		// bookkeeping.)
		const pushes = MAX_SESSION_REFS * 6 + 4; // comfortably above the cap
		for (let i = 0; i < pushes; i++) {
			const sm = SessionManager.inMemory("/tmp");
			const fake = makeFakeSession(sm);
			__testHooks.captureSession(fake as unknown as AgentSession);
			// Drop our reference each iteration so the WeakRef can be reaped.
		}
		// Best-effort GC nudge.
		const g = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun;
		if (typeof g?.gc === "function") g.gc(true);
		// Force the reaper to run by capturing one more session. The reaper
		// is gated inside `captureSession` on `length > MAX_SESSION_REFS` \u2014
		// it only runs at push time, never externally.
		const trailerSm = SessionManager.inMemory("/tmp");
		const trailerFake = makeFakeSession(trailerSm);
		__testHooks.captureSession(trailerFake as unknown as AgentSession);

		const refs = __testHooks.sessionRefCount();
		// Loose bound: the array shouldn't grow proportional to the number
		// of pushes once the reaper has fired.
		assert.ok(refs <= pushes + 1, `sessionRefCount=${refs} grew unbounded`);
		// Tighter bound when GC ran: post-reap, only live ref(s) remain.
		// (most of the prior pushes were dead, plus the trailer = at most
		// a few \u2014 well under MAX_SESSION_REFS.)
		if (typeof g?.gc === "function") {
			assert.ok(
				refs <= MAX_SESSION_REFS,
				`sessionRefCount=${refs}; expected the reaper to bound it at MAX_SESSION_REFS=${MAX_SESSION_REFS}`,
			);
		}
	});

	it("dedupes the same session on repeated capture", () => {
		const sm = SessionManager.inMemory("/tmp");
		const fake = makeFakeSession(sm);
		const before = __testHooks.sessionRefCount();
		__testHooks.captureSession(fake as unknown as AgentSession);
		const afterFirst = __testHooks.sessionRefCount();
		__testHooks.captureSession(fake as unknown as AgentSession);
		__testHooks.captureSession(fake as unknown as AgentSession);
		const afterRepeats = __testHooks.sessionRefCount();
		assert.equal(afterFirst - before, 1);
		assert.equal(afterRepeats, afterFirst);
	});

	it("resetPrototype clears seenSessions so a re-captured identity isn't deduped", () => {
		// Pre-reset: capturing the same identity twice dedupes (afterRepeat
		// === afterFirst). Post-reset: the SAME identity captures freshly,
		// proving the WeakSet was rebound. WeakSet has no .clear() so this
		// pins the rebind contract — a regression that drops the rebind in
		// resetPrototype would silently observe stale dedupe across tests.
		const sm = SessionManager.inMemory("/tmp");
		const fake = makeFakeSession(sm);
		__testHooks.captureSession(fake as unknown as AgentSession);
		const afterFirst = __testHooks.sessionRefCount();
		__testHooks.captureSession(fake as unknown as AgentSession);
		const afterRepeat = __testHooks.sessionRefCount();
		assert.equal(afterRepeat, afterFirst, "pre-reset: dedupe is active");

		__testHooks.resetPrototype();
		// After reset, sessionInstances is drained and seenSessions is fresh.
		assert.equal(__testHooks.sessionRefCount(), 0);
		// Re-capturing the SAME identity must succeed (count goes from 0 → 1).
		__testHooks.captureSession(fake as unknown as AgentSession);
		assert.equal(__testHooks.sessionRefCount(), 1);
	});

	it("captureSession tolerates a session with no agent internals", () => {
		// The deleted installPrepareNextTurn hook (which read agent.state.*
		// at prompt time) had an early-exit for sessions with no agent; the
		// replacement context-event refresh captures sessions for
		// refreshAgentMessages only, so a session without agent internals
		// must be capturable without throwing — findOwningSession just won't
		// match it.
		const sm = SessionManager.inMemory("/tmp");
		const ghost = { sessionManager: sm }; // no `agent` field at all
		const before = __testHooks.sessionRefCount();
		assert.doesNotThrow(() => __testHooks.captureSession(ghost as unknown as AgentSession));
		// The ghost is captured (ref count advanced) but findOwningSession
		// still resolves nothing for it (it has no agent.state.messages to
		// refresh — refreshAgentMessages returns false).
		assert.equal(__testHooks.sessionRefCount(), before + 1);
		assert.equal(__testHooks.refreshAgentMessages(sm), false);
	});
});

// =============================================================================
// findLabelHint depth limit
// =============================================================================

describe("findLabelHint", () => {
	it("returns null when no text is found within MAX_HINT_WALK_DEPTH", () => {
		// Build a chain whose head is a custom_message with no text content,
		// followed by user-text entries beyond the walker's reach \u2014 the
		// walker should give up at depth MAX_HINT_WALK_DEPTH and never
		// reach the texts.
		const sm = SessionManager.inMemory("/tmp");
		// First push the deep texts (positioned beyond the walker's reach).
		for (let i = 0; i < 100; i++) {
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: `deep ${i}` }],
			} as never);
		}
		// Now push thinking-only assistant messages on top so the walk
		// bottoms out before reaching the user texts. We need at least
		// MAX_HINT_WALK_DEPTH thinking entries; use +10 for safety margin.
		for (let i = 0; i < MAX_HINT_WALK_DEPTH + 10; i++) {
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "thinking", thinking: "..." }],
				api: "anthropic",
				provider: "claude",
				model: "claude-sonnet-4-5",
				stopReason: "endTurn",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as never);
		}
		const leafId = sm.getLeafId();
		assert.ok(leafId);
		const hint = __testHooks.findLabelHint(sm, leafId, 50);
		assert.equal(hint, null);
	});

	it("returns a preview when text is within the depth limit", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "the user's instruction" }],
		} as never);
		// 5 thinking entries on top \u2014 well within the 50-step cap.
		for (let i = 0; i < 5; i++) {
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "thinking", thinking: "..." }],
				api: "anthropic",
				provider: "claude",
				model: "claude-sonnet-4-5",
				stopReason: "endTurn",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as never);
		}
		const leafId = sm.getLeafId();
		assert.ok(leafId);
		const hint = __testHooks.findLabelHint(sm, leafId, 50);
		assert.ok(hint);
		if (hint) assert.match(hint, /the user's instruction/);
	});

	it("branch_summary entry: returns 'summary: <stripped lead-in>'", () => {
		// findLabelHint walks the parent chain; when it lands on a
		// branch_summary entry, the hint should be prefixed with 'summary: '
		// and stripBranchSummaryBoilerplate should remove pi's prelude. A
		// regression that drops the prefix or the strip call would surface
		// here.
		const sm = SessionManager.inMemory("/tmp");
		appendTurn(sm, "u1", "a1");
		const leafId = sm.getLeafId();
		assert.ok(leafId);
		const summaryId = sm.branchWithSummary(
			leafId,
			"This is the summary content of the rewound branch.",
		);
		const hint = __testHooks.findLabelHint(sm, summaryId, 80);
		assert.ok(hint, "branch_summary entry should produce a hint");
		if (hint) {
			assert.match(hint, /^summary: /);
			assert.match(hint, /summary content of the rewound branch/);
		}
	});

	it("custom_message entry: hint extracts the content text", () => {
		// findLabelHint also walks into `custom_message` entries (e.g. the
		// `/tree` view's label entries). Pin: the text content lands
		// in the hint, no prefix.
		const sm = SessionManager.inMemory("/tmp");
		sm.appendCustomMessageEntry(
			"some-custom-type",
			[{ type: "text", text: "custom message content" }],
			true,
		);
		const leafId = sm.getLeafId();
		assert.ok(leafId);
		const hint = __testHooks.findLabelHint(sm, leafId, 80);
		assert.ok(hint, "custom_message entry should produce a hint");
		if (hint) assert.match(hint, /custom message content/);
	});
});

// =============================================================================
// findLabeledEntry
// =============================================================================

describe("findLabeledEntry", () => {
	it("returns null when the label isn't on the active branch", () => {
		const sm = SessionManager.inMemory("/tmp");
		appendTurn(sm, "u", "a");
		assert.equal(__testHooks.findLabeledEntry(sm, "anchor:nope"), null);
	});

	it("returns the entry id when the label is set", () => {
		const sm = SessionManager.inMemory("/tmp");
		const t = appendTurn(sm, "u", "a");
		sm.appendLabelChange(t.assistantId, "anchor:found");
		assert.equal(__testHooks.findLabeledEntry(sm, "anchor:found"), t.assistantId);
	});
});

// =============================================================================
// adversarial inputs
// =============================================================================
