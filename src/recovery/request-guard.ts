/** Request projection, admission recovery, tool gating and refusal results. */

import { randomUUID } from "node:crypto";
import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ContextWithSystemEvent,
	ExtensionContext,
	SessionManager,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import type { createPiCompactionController } from "../core/pi-compaction.ts";
import { refreshAgentMessages } from "../core/pi-internals.ts";
import { buildContextMessages, effectiveRequestMessages } from "../core/projection.ts";
import {
	ANCHOR_MANDATE,
	noteOutgoingRequest,
	type OverflowModel,
	requestAccounting,
} from "../core/request-accounting.ts";
import { trySessionWrite } from "../core/session-write.ts";
import type { createFoldAdaptersController } from "../fold/fold-adapters.ts";
import type { FoldHost } from "../fold/fold-api.ts";
import { unrestoredFoldCursors } from "../fold/fold-commit.ts";
import { RECOVERY_HEADROOM_TOKENS, RECOVERY_MIN_OUTPUT_TOKENS } from "../fold/fold-policy.ts";
import type { createFoldRuntime } from "../fold/fold-runtime.ts";
import type { createIndependentRecoveryController } from "./independent-recovery.ts";

/** Request gates and the fold operations used to recover an oversized request. */
export interface RequestGuardDeps {
	state: Pick<NavigatorState, "activity" | "recovery">;
	piCompaction: ReturnType<typeof createPiCompactionController>["piCompaction"];
	foldHostOf: ReturnType<typeof createFoldAdaptersController>["foldHostOf"];
	captureSystemHead: ReturnType<typeof createFoldRuntime>["captureSystemHead"];
	recoverIndependently: ReturnType<
		typeof createIndependentRecoveryController
	>["recoverIndependently"];
}

/** Creates request handlers without registering handlers or starting work. */
export function createRequestGuard({
	state,
	piCompaction,
	foldHostOf,
	captureSystemHead,
	recoverIndependently,
}: RequestGuardDeps) {
	// Public context event: replace the wire messages with the session-tree
	// projection before every LLM call. This is the public-API replacement for
	// the deleted `agent.prepareNextTurnWithContext` per-turn refresh — it
	// fires inside `streamAssistantResponse` (via `Agent.transformContext` →
	// `runner.emitContext`), before EVERY LLM call including the turn right
	// after a mid-loop rewind, so the rewound chain (branch_summary +
	// continuation message) reaches the next API call.
	//
	const onContext = (_event: ContextEvent, ctx: ExtensionContext) => ({
		messages: buildContextMessages(ctx.sessionManager as SessionManager),
	});

	async function onContextWithSystem(event: ContextWithSystemEvent, ctx: ExtensionContext) {
		let sm: SessionManager;
		let sessionId: string;
		let model: OverflowModel | undefined;
		let signal: AbortSignal | undefined;
		let host: FoldHost;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
			model = ctx.model;
			signal = ctx.signal;
			host = foldHostOf(ctx);
		} catch {
			return;
		}
		// Captured before any await: Strategy A and the returned request share it.
		const systemHead = effectiveRequestMessages(sm, event.messages).filter(
			(message) => message.role === "system",
		);
		captureSystemHead(sm, sessionId, model, event.messages);
		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		if (modelKey)
			noteOutgoingRequest(sessionId, modelKey, effectiveRequestMessages(sm, event.messages));
		if (signal?.aborted) return;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (state.recovery.nativeRetryOwned.has(sessionId)) {
			state.recovery.nativeRetryOwned.delete(sessionId);
			return;
		}
		if (!model?.contextWindow || model.contextWindow <= 0) return;
		// Native auto-compaction owns recovery when it is enabled (single owner).
		if (piCompaction(sm, model)?.enabled !== false) return;
		const contextWindow = model.contextWindow;
		const inputEstimate = requestAccounting(sm, event.messages).tokens;
		const reserve = RECOVERY_MIN_OUTPUT_TOKENS + RECOVERY_HEADROOM_TOKENS;
		if (inputEstimate + reserve <= contextWindow) return;
		const refuse = (detail?: string) => {
			state.recovery.requestBudgetFailures.set(sessionId, {
				inputEstimate,
				contextWindow,
				receiptId: randomUUID(),
				...(detail ? { detail } : {}),
			});
			try {
				ctx.abort();
			} catch {
				// Stale ctx: settlement still persists the receipt.
			}
		};
		try {
			const outcome = await recoverIndependently(ctx, host, signal);
			if (outcome.status === "cancelled") return;
			if (outcome.status === "failed") {
				refuse(outcome.detail);
				return;
			}
			const { draft } = outcome;
			// Contain the receipt write: an unpersisted receipt must not become the
			// parent of the next main-agent reply.
			const receipt = trySessionWrite(sm, () =>
				sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details),
			);
			if (!receipt.ok && !receipt.cursorRestored) {
				unrestoredFoldCursors.add(sm);
				refuse("the fold landed but its receipt could not be written, so persistence is uncertain");
				return;
			}
			refreshAgentMessages(sm);
			try {
				const recovered = [...systemHead, ...buildContextMessages(sm)];
				if (modelKey) noteOutgoingRequest(sessionId, modelKey, recovered);
				return { messages: recovered };
			} catch {
				refuse("the recovered projection could not be built");
				return;
			}
		} catch (error) {
			refuse(
				`independent recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	}

	// Anchor mandate (#31): a before_agent_start append lands at the END of
	// the system prompt — stronger than the mid-prompt Guidelines block, and
	// re-applied on every prompt instead of living in the conversation. Skip
	// only when the tool is verifiably absent from the active set; fail-open
	// when `selectedTools` is undefined (this extension always registers it).
	// The same check gates the rewind hint (#44): an inactive tool must not
	// fire `turn_end` nudges the model can't act on.
	async function onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
		const selected = event.systemPromptOptions?.selectedTools;
		state.activity.toolActive = !Array.isArray(selected) || selected.includes(TOOL_NAME);
		// Per-session copy of the gate (#55): the shared `toolActive` above
		// drives the hint, but an in-process sibling session must not clear this
		// session's auto-anchor gate.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			state.recovery.requestBudgetFailures.delete(sessionId);
			state.recovery.recoveryReceipts.delete(sessionId);
			state.recovery.recoveryAttempts.delete(sessionId);
			state.recovery.nativeRetryOwned.delete(sessionId);
			state.activity.toolActiveBySession.set(sessionId, state.activity.toolActive);
		} catch {
			// Fail-open: the per-session gate stays absent.
		}
		if (!state.activity.toolActive) return {};
		return { systemPrompt: `${event.systemPrompt}\n\n${ANCHOR_MANDATE}` };
	}

	// Refusals must render (and be recorded) as failed tool calls. A returned
	// `isError: true` never reaches the host's error channel — pi-agent-core
	// only finalizes a call as failed when `execute()` throws, overwriting the
	// flag with its own boolean — so `toolError` tags its details with
	// `refusal: true` and this handler flips the host's `isError`, which drives
	// the TUI's `toolErrorBg` shell, the transcript entry, and any other
	// extension's `tool_result` view. Content is left untouched, so the model
	// still reads the refusal copy.
	function onToolResult(event: ToolResultEvent) {
		if (event.toolName !== TOOL_NAME) return undefined;
		const details = event.details as { refusal?: boolean } | undefined;
		if (details?.refusal === true) {
			return { isError: true };
		}
		return undefined;
	}

	return { onContext, onContextWithSystem, onBeforeAgentStart, onToolResult };
}
