/** Captured agent-session fakes and rewindable branch builders. */
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { __testHooks } from "../../src/index.ts";
import type { FakePi } from "./extension-harness.ts";
import { capturedFakes } from "./harness-hooks.ts";
import { appendTurn, usageOf } from "./session-messages.ts";

/**
 * Build a fake AgentSession-shaped object with the mutable `agent.state`
 * surface the reflection bootstrap touches. Cast through unknown so the test
 * doesn't depend on every field of the real class.
 */
export interface FakeAgentSession {
	sessionManager: SessionManager;
	agent: {
		state: { systemPrompt: string; messages: unknown[]; tools: unknown[] };
		prepareNextTurn?: unknown;
		prepareNextTurnWithContext?: unknown;
	};
	/** Plain field on `AgentSession`; the rewind emits `session_tree` on it (#79). */
	_extensionRunner?: { emit?: (event: unknown) => Promise<unknown> | unknown };
}

export function makeFakeSession(sm: SessionManager): FakeAgentSession {
	return {
		sessionManager: sm,
		agent: {
			state: { systemPrompt: "SYSTEM", messages: [], tools: [] },
			prepareNextTurn: undefined,
			prepareNextTurnWithContext: undefined,
		},
	};
}

/**
 * Build the canonical rewindable fixture: an anchored first assistant turn
 * plus N follow-up turns (default 3) whose cumulative usage totals grow well
 * past MIN_REWIND_SAVINGS_TOKENS above the anchor (the #21 floor rejects
 * sub-floor rewinds, so every successful-rewind fixture must clear it),
 * optionally with a captured AgentSession so the reflection bootstrap finds
 * it.
 */
export function setupRewindable(
	sm: SessionManager,
	pi: FakePi,
	opts: {
		capture?: boolean;
		turnsAfter?: number;
		rewindToName?: string;
		tokenCounts?: number[];
	} = {},
): { fake?: FakeAgentSession; anchorId: string } {
	const rewindToName = opts.rewindToName ?? "start";
	const turnsAfter = opts.turnsAfter ?? 3;
	const tokenCounts = opts.tokenCounts ?? [6_000, 12_000, 18_000, 24_000, 30_000];
	const t1 = appendTurn(sm, "u1", "a1", tokenCounts[0]);
	pi.pi.setLabel(t1.assistantId, `anchor:${rewindToName}`);
	for (let i = 0; i < turnsAfter; i++) {
		appendTurn(sm, `u${i + 2}`, `a${i + 2}`, tokenCounts[i + 1] ?? 100, true);
	}
	if (opts.capture) {
		const fake = makeFakeSession(sm);
		capturedFakes.push(fake);
		__testHooks.captureSession(fake as unknown as AgentSession);
		return { fake, anchorId: t1.assistantId };
	}
	return { anchorId: t1.assistantId };
}

/**
 * `setupRewindable` with a folded span of assistant turns only: no user
 * message between the anchor and the leaf (autonomous work).
 */
export function setupAutonomousSpan(
	sm: SessionManager,
	pi: FakePi,
	tokenCounts = [12_000, 18_000, 24_000],
): { anchorId: string } {
	const first = appendTurn(sm, "u1", "a1", 6_000);
	pi.pi.setLabel(first.assistantId, "anchor:start");
	for (const totalTokens of tokenCounts) {
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Recorded work and evidence.\n".repeat(1200) }],
			api: "anthropic",
			provider: "claude",
			model: "claude-sonnet-4-5",
			stopReason: "endTurn",
			timestamp: Date.now(),
			usage: usageOf(totalTokens),
		} as never);
	}
	return { anchorId: first.assistantId };
}
