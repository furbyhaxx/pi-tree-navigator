/** Independent overflow relief and durable settlement receipts. */

import { randomUUID } from "node:crypto";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { suggestFoldLabel } from "../core/anchors.ts";
import {
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
} from "../core/config.ts";
import { formatWindow, TOOL_NAME, toOneLine } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { effectiveRequestMessages } from "../core/projection.ts";
import {
	accountRequest,
	estimateAdmissionTokens,
	tokenFactorOf,
} from "../core/request-accounting.ts";
import type { FoldHost, FoldResult } from "../fold/fold-api.ts";
import { unrestoredFoldCursors } from "../fold/fold-commit.ts";
import { type FoldRequest, type FoldRunOptions, selectFoldTarget } from "../fold/fold-engine.ts";
import { RECOVERY_HEADROOM_TOKENS, RECOVERY_MIN_OUTPUT_TOKENS } from "../fold/fold-policy.ts";
import {
	defaultFoldFocus,
	foldRecommendationBudget,
	priceFoldCandidates,
} from "../fold/fold-pricing.ts";
import {
	foldDoneDraft,
	type RewindMessageDraft,
	rewindMessageDraft,
} from "../fold/fold-receipts.ts";
import type { createPressureCompactionController } from "./pressure-compaction.ts";
import { recoveryCutOf } from "./recovery-cut.ts";

/** Recoveries one request may get; each must start from less context than the last. */
const MAX_RECOVERY_ATTEMPTS = 3;

/** Recovery state and the independent fold and pressure relief operations. */
export interface IndependentRecoveryDeps {
	state: Pick<NavigatorState, "config" | "folds" | "recovery">;
	runFold(host: FoldHost, request: FoldRequest, options?: FoldRunOptions): Promise<FoldResult>;
	compactUnderPressure: ReturnType<
		typeof createPressureCompactionController
	>["compactUnderPressure"];
}

/** Creates recovery operations without registering handlers or starting work. */
export function createIndependentRecoveryController({
	state,
	runFold,
	compactUnderPressure,
}: IndependentRecoveryDeps) {
	const holdRecoveryReceipt = (sessionId: string, draft: RewindMessageDraft) => {
		draft.details["receiptId"] = randomUUID();
		state.recovery.recoveryReceipts.set(sessionId, [
			...(state.recovery.recoveryReceipts.get(sessionId) ?? []),
			draft,
		]);
		return draft;
	};
	const receiptOnBranch = (sm: SessionManager, receiptId: unknown) =>
		sm
			.getBranch()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					typeof entry.details === "object" &&
					entry.details !== null &&
					"receiptId" in entry.details &&
					entry.details.receiptId === receiptId,
			);
	const requestBudgetFailureDraft = (failure: {
		inputEstimate: number;
		contextWindow: number;
		receiptId: string;
		detail?: string;
		providerOverflow?: boolean;
	}) =>
		rewindMessageDraft(
			`[${TOOL_NAME}] ${failure.providerOverflow ? "Provider context overflow recovery failed." : `Request stopped before generation: estimated input ${failure.inputEstimate} tokens leaves fewer than ${RECOVERY_MIN_OUTPUT_TOKENS} output tokens plus ${RECOVERY_HEADROOM_TOKENS} headroom in the ${failure.contextWindow}-token operating window.`} No tool results were withheld.${failure.detail ? ` ${failure.detail}` : ""} Reduce context with /tree or /compact, or select a larger operating window.`,
			{
				status: "failed",
				reason: failure.providerOverflow
					? "provider context overflow"
					: "insufficient request headroom",
				inputEstimate: failure.inputEstimate,
				contextWindow: failure.contextWindow,
				appliedWithheld: 0,
				receiptId: failure.receiptId,
				...(failure.detail ? { detail: failure.detail } : {}),
			},
		);

	async function recoverIndependently(
		ctx: ExtensionContext,
		host: FoldHost,
		signal: AbortSignal | undefined,
	): Promise<
		| { status: "done"; draft: RewindMessageDraft }
		| { status: "failed"; detail: string }
		| { status: "cancelled" }
	> {
		const { sm, model } = host;
		const sessionId = sm.getSessionId();
		const contextWindow = model?.contextWindow ?? 0;
		const runSignal = ctx.signal;
		if (signal?.aborted) return { status: "cancelled" };
		// Factor-free, so a calibration the overflow taught does not read as growth.
		const heuristicTokens = Math.round(estimateAdmissionTokens(sm) / tokenFactorOf(sm));
		const prior = state.recovery.recoveryAttempts.get(sessionId);
		if (prior && prior.attempts >= MAX_RECOVERY_ATTEMPTS)
			return {
				status: "failed",
				detail: `${prior.attempts} recoveries for this request did not bring it under the window`,
			};
		if (prior && heuristicTokens >= prior.heuristicTokens)
			return {
				status: "failed",
				detail: `the previous recovery for this request did not reduce context (~${formatWindow(prior.heuristicTokens)} -> ~${formatWindow(heuristicTokens)} heuristic tokens)`,
			};
		state.recovery.recoveryAttempts.set(sessionId, {
			attempts: (prior?.attempts ?? 0) + 1,
			heuristicTokens,
		});
		if (!model || contextWindow <= 0)
			return { status: "failed", detail: "no operating window is available" };
		const captured = state.folds.capturedSystems.get(sessionId);
		const systemHead = effectiveRequestMessages(
			sm,
			captured?.messages ?? sm.buildSessionContext().messages,
		).filter((message) => message.role === "system");
		const modelKey = `${model.provider}/${model.id}`;
		if (
			accountRequest(systemHead, tokenFactorOf(sm)).tokens +
				RECOVERY_MIN_OUTPUT_TOKENS +
				RECOVERY_HEADROOM_TOKENS >
			contextWindow
		)
			return {
				status: "failed",
				detail: "the system prompt alone leaves no room for a recovered request",
			};
		host.isIdle = () =>
			!signal?.aborted &&
			ctx.signal === runSignal &&
			ctx.sessionManager === sm &&
			ctx.sessionManager.getSessionId() === sessionId &&
			`${ctx.model?.provider}/${ctx.model?.id}` === modelKey &&
			ctx.model?.contextWindow === contextWindow &&
			state.folds.capturedSystems.get(sessionId) === captured;
		const handoffMode = state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT;
		const budget = foldRecommendationBudget(
			contextWindow,
			resolveRewindHintReserve(
				{
					rewindHintReserveTokens: state.config.rewindHintReserveTokens,
					rewindHintModelReserveTokens: state.config.hintByModel,
				},
				modelKey,
			),
		);
		// Without a usable fold, a tail-keeping compaction is the next relief.
		const compactInstead = async (
			why: string,
		): Promise<
			| { status: "done"; draft: RewindMessageDraft }
			| { status: "failed"; detail: string }
			| { status: "cancelled" }
		> => {
			if (signal?.aborted) return { status: "cancelled" };
			// A changed model or session is not a size problem; nothing may write.
			if (host.isIdle?.() === false) return { status: "failed", detail: why };
			const config = resolveAutoNavigateConfig(
				{
					...(state.config.autoNavigateBase === undefined
						? {}
						: { autoNavigate: state.config.autoNavigateBase }),
					autoNavigateByModel: state.config.autoNavigateByModel,
					...(state.config.proposalConfig === undefined
						? {}
						: { proposal: state.config.proposalConfig }),
				},
				modelKey,
			);
			const before = estimateAdmissionTokens(sm);
			let compacted: Awaited<ReturnType<typeof compactUnderPressure>>;
			try {
				compacted = await compactUnderPressure({
					sm,
					sessionId,
					host,
					budget,
					keepRecentTokens: Math.min(config.rewindAtTokens, budget) * config.keepRecentShare,
					trigger: `The next request (~${formatWindow(before)} tokens) does not fit the ${formatWindow(contextWindow)} operating window and no fold could relieve it (${toOneLine(why, 200) ?? "no target"})`,
					origin: "recovery",
					activeTokens: before,
					captured: state.folds.capturedSystems.get(sessionId),
					handoffMode,
					signal,
					isCurrent: () => host.isIdle?.() ?? false,
				});
			} catch (error) {
				compacted = {
					kind: "skip",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			if (signal?.aborted || compacted.kind === "stale") return { status: "cancelled" };
			if (compacted.kind === "done") return { status: "done", draft: compacted.draft };
			return {
				status: "failed",
				detail: `${why}; a compaction did not help either: ${compacted.reason}`,
			};
		};
		const cut = recoveryCutOf(sm, host.recoveryEvidenceId);
		// A malformed tool envelope is not a size problem; nothing may rewrite it.
		if (!cut.ok) return { status: "failed", detail: cut.detail };
		try {
			const focus = defaultFoldFocus(sm);
			const candidates = priceFoldCandidates(sm, {
				model,
				handoffMode,
				captured: state.folds.capturedSystems.get(sessionId),
				focus,
				suggestLabel: (name) => suggestFoldLabel(sm, name),
				foldPointId: cut.foldPointId,
				thinking: host.thinking,
			});
			const selected = selectFoldTarget(candidates, budget);
			if (!selected.ok) return compactInstead(selected.reasons.join("; "));
			const request: FoldRequest = {
				sessionId,
				origin: "recovery",
				rewindTo: selected.candidate.name,
				newLabel: selected.candidate.suggestedLabel,
				focus,
			};
			state.recovery.recoveryCuts.set(sessionId, cut.foldPointId);
			let outcome: FoldResult;
			try {
				outcome = await runFold(host, request, { signal });
			} finally {
				state.recovery.recoveryCuts.delete(sessionId);
			}
			if (signal?.aborted || outcome.status === "cancelled") return { status: "cancelled" };
			if (outcome.status !== "done") {
				const detail =
					outcome.status === "failed" ? `${outcome.reason}: ${outcome.detail}` : outcome.status;
				// A fold whose write left the cursor uncertain must not be followed by another write.
				return unrestoredFoldCursors.has(sm)
					? { status: "failed", detail }
					: compactInstead(`the fold to '${request.rewindTo}' failed: ${detail}`);
			}
			return { status: "done", draft: foldDoneDraft(request, outcome) };
		} catch (error) {
			return {
				status: "failed",
				detail: `independent recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return { recoverIndependently, holdRecoveryReceipt, receiptOnBranch, requestBudgetFailureDraft };
}
