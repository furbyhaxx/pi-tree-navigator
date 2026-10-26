/** Fold commits, overflow recovery and receipt settlement at turn boundaries. */

import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	AgentSession,
	AgentSettledEvent,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	SessionManager,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { createAutomaticFoldController } from "../auto/automatic-fold.ts";
import type { createContinuityRuntime } from "../continuity/continuity-runtime.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import type { createPiCompactionController } from "../core/pi-compaction.ts";
import { findOwningSession, refreshAgentMessages } from "../core/pi-internals.ts";
import {
	estimateAdmissionTokens,
	noteRequestUsage,
	overflowed,
} from "../core/request-accounting.ts";
import type { createConsolidationController } from "../fold/consolidation-runtime.ts";
import type { createFoldAdaptersController } from "../fold/fold-adapters.ts";
import { hideDrafts, keepValidDrafts } from "../fold/fold-receipts.ts";
import type { createIndependentRecoveryController } from "./independent-recovery.ts";

/** Boundary state and operations for folding, continuity and independent recovery. */
export interface TurnBoundaryDeps {
	state: Pick<NavigatorState, "activity" | "folds" | "recovery" | "turns">;
	piCompaction: ReturnType<typeof createPiCompactionController>["piCompaction"];
	foldHostOf: ReturnType<typeof createFoldAdaptersController>["foldHostOf"];
	runQueuedFold: ReturnType<typeof createFoldAdaptersController>["runQueuedFold"];
	appendFoldMessage: ReturnType<typeof createFoldAdaptersController>["appendFoldMessage"];
	recoverIndependently: ReturnType<
		typeof createIndependentRecoveryController
	>["recoverIndependently"];
	holdRecoveryReceipt: ReturnType<
		typeof createIndependentRecoveryController
	>["holdRecoveryReceipt"];
	receiptOnBranch: ReturnType<typeof createIndependentRecoveryController>["receiptOnBranch"];
	requestBudgetFailureDraft: ReturnType<
		typeof createIndependentRecoveryController
	>["requestBudgetFailureDraft"];
	captureContinuity: ReturnType<typeof createContinuityRuntime>["captureContinuity"];
	continueNudgeDraft: ReturnType<typeof createContinuityRuntime>["continueNudgeDraft"];
	maybeRunAutomaticFold: ReturnType<typeof createAutomaticFoldController>["maybeRunAutomaticFold"];
	maybeConsolidate: ReturnType<typeof createConsolidationController>["maybeConsolidate"];
}

/** Creates boundary handlers without registering handlers or starting work. */
export function createTurnBoundary({
	state,
	piCompaction,
	foldHostOf,
	runQueuedFold,
	appendFoldMessage,
	recoverIndependently,
	holdRecoveryReceipt,
	receiptOnBranch,
	requestBudgetFailureDraft,
	captureContinuity,
	continueNudgeDraft,
	maybeRunAutomaticFold,
	maybeConsolidate,
}: TurnBoundaryDeps) {
	// Fold and recovery commits precede hint / start-anchor context measurements.
	async function onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		// Every return keeps other handlers' entries (pi replaces the list per
		// handler) and drops `context_edit`s whose target left the branch, ours
		// included (one invalid draft makes pi drop the whole list).
		const deliverRaw = (drafts: SessionBoundaryDraft[], cont: boolean) => ({
			entries: keepValidDrafts(sm, [...(event.entries ?? []), ...drafts]),
			continue: cont,
		});
		const message = event.message as {
			role?: string;
			content?: unknown;
			stopReason?: string;
		};
		if (message?.role !== "assistant") return;
		const operatingWindow = ctx.model?.contextWindow ?? 0;
		noteRequestUsage(sessionId, message, operatingWindow);
		const usage = (message as Partial<AssistantMessage>).usage;
		// The recovered request generated within the window: a later overflow in
		// this run is a new request and may recover again. Only a recovery that
		// did not let the next request through is final. A tool call the provider
		// accepted beyond the operating window did not fit either.
		if (
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			!overflowed(message, ctx.model) &&
			!(operatingWindow > 0 && (usage?.input ?? 0) + (usage?.cacheRead ?? 0) > operatingWindow)
		)
			state.recovery.recoveryAttempts.delete(sessionId);
		const messageEntryId = typeof event.messageEntryId === "string" ? event.messageEntryId : "";
		const turnIds = messageEntryId
			? [
					messageEntryId,
					...(event.toolResultEntryIds ?? []).filter((id): id is string => typeof id === "string"),
				]
			: [];
		const budgetFailure = state.recovery.requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			return deliverRaw([...hideDrafts(turnIds), requestBudgetFailureDraft(budgetFailure)], false);
		}
		// The queued fold (E12), after this turn's tool results are committed. It
		// waits across an error turn pi retries.
		const queuedFold = state.folds.queuedFolds.get(sessionId);
		if (queuedFold && message.stopReason !== "error") {
			const folded = await runQueuedFold(sm, sessionId, queuedFold, message, event, ctx);
			if (folded) return folded;
		}
		// Another extension's continuation owns this boundary.
		if (!event.continue && messageEntryId && overflowed(message, ctx.model)) {
			state.turns.overflowedTurns.add(message);
			if (message.stopReason === "error") return;
			if (
				ctx.signal?.aborted ||
				state.recovery.nativeRetryOwned.has(sessionId) ||
				(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) ===
					false ||
				piCompaction(sm, ctx.model)?.enabled !== false
			)
				return;
			state.turns.rewindTurns.add(message);
			// A truncated tool envelope must not enter the next request.
			if (message.stopReason === "length") {
				for (const id of turnIds) sm.appendContextEdit(id, null);
				refreshAgentMessages(sm);
			}
			const host = foldHostOf(ctx);
			if (message.stopReason === "stop") host.recoveryEvidenceId = messageEntryId;
			const outcome = await recoverIndependently(ctx, host, ctx.signal);
			if (ctx.signal?.aborted || outcome.status === "cancelled") return;
			if (outcome.status === "failed") {
				const failure = {
					inputEstimate: estimateAdmissionTokens(sm),
					contextWindow: host.model?.contextWindow ?? 0,
					receiptId: randomUUID(),
					detail: outcome.detail,
					providerOverflow: true,
				};
				state.recovery.requestBudgetFailures.set(sessionId, failure);
				return deliverRaw([requestBudgetFailureDraft(failure)], false);
			}
			refreshAgentMessages(sm);
			return deliverRaw([holdRecoveryReceipt(sessionId, outcome.draft)], true);
		}
		if (!state.turns.rewindTurns.has(message) && !state.turns.overflowedTurns.has(message)) {
			await captureContinuity(sm, sessionId, ctx, message);
		}
		const auto = await maybeRunAutomaticFold(sm, sessionId, message, event, ctx);
		if (auto) return auto;
		if (!state.turns.rewindTurns.has(message) && !state.turns.overflowedTurns.has(message)) {
			const consolidated = await maybeConsolidate(sm, sessionId, message, ctx);
			if (consolidated) return deliverRaw(consolidated, event.continue);
		}
		let signal: AbortSignal | undefined;
		try {
			signal = ctx.signal;
		} catch {
			return;
		}
		const nudge = continueNudgeDraft(sm, sessionId, message, event, signal);
		return nudge ? deliverRaw([nudge], true) : undefined;
	}

	// Explicit provider errors end the loop before turn_end can continue it.
	async function onAgentBeforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		// Rewind-driven compaction (#101, D2): an explicit overflow error ended
		// the loop; pi did not retry (overflow) or compact (off). Recover in the
		// same run. Another extension's `continue` owns the recovery.
		if (event.outcome === "error" && !event.continue) {
			let last: SessionEntry | undefined;
			try {
				last = sm
					.getBranch()
					.findLast((e) => e.type === "message" && e.message.role === "assistant");
			} catch {
				last = undefined;
			}
			const failed = last?.type === "message" ? last.message : undefined;
			if (
				last &&
				(failed as { stopReason?: string } | undefined)?.stopReason === "error" &&
				overflowed(failed, ctx.model)
			) {
				const signal = ctx.signal;
				if (
					signal?.aborted ||
					(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) ===
						false ||
					piCompaction(sm, ctx.model)?.enabled !== false ||
					state.recovery.nativeRetryOwned.has(sessionId)
				)
					return;
				const host = foldHostOf(ctx);
				// The SDK has no agent signal between runs at before-settlement.
				const session = findOwningSession(sm);
				const cancellation = new AbortController();
				const originalAbort = session?.abort;
				const recoveryAbort =
					session && originalAbort
						? function (this: AgentSession) {
								cancellation.abort();
								return originalAbort.call(this);
							}
						: undefined;
				if (session && recoveryAbort) session.abort = recoveryAbort;
				let outcome: Awaited<ReturnType<typeof recoverIndependently>>;
				try {
					outcome = await recoverIndependently(
						ctx,
						host,
						signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal,
					);
				} finally {
					if (session && originalAbort && session.abort === recoveryAbort)
						session.abort = originalAbort;
				}
				if (signal?.aborted || cancellation.signal.aborted || outcome.status === "cancelled")
					return;
				if (outcome.status === "failed") {
					const failure = {
						inputEstimate: estimateAdmissionTokens(sm),
						contextWindow: host.model?.contextWindow ?? 0,
						receiptId: randomUUID(),
						detail: outcome.detail,
						providerOverflow: true,
					};
					state.recovery.requestBudgetFailures.set(sessionId, failure);
					return {
						entries: keepValidDrafts(sm, [
							...(event.entries ?? []),
							requestBudgetFailureDraft(failure),
						]),
						continue: false,
					};
				}
				refreshAgentMessages(sm);
				return {
					entries: keepValidDrafts(sm, [
						...(event.entries ?? []),
						holdRecoveryReceipt(sessionId, outcome.draft),
					]),
					continue: true,
				};
			}
		}
		return undefined;
	}

	function onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext) {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		state.recovery.recoveryAttempts.delete(sessionId);
		state.recovery.nativeRetryOwned.delete(sessionId);
		// A rewind the run never reached a boundary for would fold at an
		// unrelated later turn, and block every rewind until then.
		if (state.folds.queuedFolds.get(sessionId)?.origin === "agent")
			state.folds.queuedFolds.delete(sessionId);
		for (const draft of state.recovery.recoveryReceipts.get(sessionId) ?? [])
			if (!receiptOnBranch(sm, draft.details["receiptId"])) appendFoldMessage(sm, draft);
		state.recovery.recoveryReceipts.delete(sessionId);
		const budgetFailure = state.recovery.requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			if (!receiptOnBranch(sm, budgetFailure.receiptId))
				appendFoldMessage(sm, requestBudgetFailureDraft(budgetFailure));
			state.recovery.requestBudgetFailures.delete(sessionId);
			return;
		}
	}

	return { onTurnEnd, onAgentBeforeSettle, onAgentSettled };
}
