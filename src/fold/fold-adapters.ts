/** Manual and queued fold entry points and their live context adapters. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { createContinuityRuntime } from "../continuity/continuity-runtime.ts";
import { suggestFoldLabel } from "../core/anchors.ts";
import { PARENT_HANDOFF_MODE_DEFAULT, resolveRewindHintReserve } from "../core/config.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { estimateAdmissionTokens } from "../core/request-accounting.ts";
import { trySessionWrite } from "../core/session-write.ts";
import {
	type FoldPlan,
	type FoldPlanCandidate,
	type FoldPlanDeps,
	foldPlanResult,
	openFoldPlanScreen,
} from "../ui/fold-plan-screen.ts";
import type { FoldHost, FoldRequestInput, FoldResult } from "./fold-api.ts";
import { unrestoredFoldCursors } from "./fold-commit.ts";
import type { FoldRequest, FoldRunOptions } from "./fold-engine.ts";
import { MIN_SUMMARY_FOCUS_LENGTH } from "./fold-policy.ts";
import {
	defaultFoldFocus,
	foldRecommendationBudget,
	priceFoldCandidates,
	recommendFoldIndex,
} from "./fold-pricing.ts";
import {
	foldDoneDraft,
	foldFailedDraft,
	keepValidDrafts,
	type RewindMessageDraft,
} from "./fold-receipts.ts";

/** Fold state and the independent run and continuity operations. */
export interface FoldAdaptersDeps {
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "sendMessage">;
	state: Pick<NavigatorState, "config" | "folds" | "turns">;
	runFold(host: FoldHost, request: FoldRequest, options?: FoldRunOptions): Promise<FoldResult>;
	captureContinuity: ReturnType<typeof createContinuityRuntime>["captureContinuity"];
}

/** Creates fold adapters without registering handlers or starting work. */
export function createFoldAdaptersController({
	pi,
	state,
	runFold,
	captureContinuity,
}: FoldAdaptersDeps) {
	/** What a fold reads from the live context; read before the first await (stale-ctx contract). */
	function foldHostOf(
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry">,
	): FoldHost {
		return {
			sm: ctx.sessionManager as SessionManager,
			model: ctx.model,
			registry: ctx.modelRegistry,
			thinking: summaryThinking(),
		};
	}

	/** Fold summaries are extraction and one write-up: reasoning above low adds latency and cost, not fidelity. */
	function summaryThinking(): ThinkingLevel | "off" {
		const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
		return level === "off" || level === "minimal" || level === "low" ? level : "low";
	}

	const gateFailed = (reason: string, detail: string): FoldResult => ({
		status: "failed",
		stage: "gate",
		reason,
		detail,
		usage: [],
	});

	/**
	 * A fold for the session's next `turn_end` (a running agent). One fold per
	 * session is queued or running at a time.
	 */
	function queueFold(
		sessionId: string,
		request: FoldRequestInput,
	): { ok: true } | { ok: false; reason: string } {
		if (state.folds.queuedFolds.has(sessionId) || state.folds.runningFolds.has(sessionId)) {
			return {
				ok: false,
				reason: "a fold is already queued or running for this session",
			};
		}
		state.folds.queuedFolds.set(sessionId, { ...request, sessionId });
		return { ok: true };
	}

	/** Persist a fold's receipt as a message that starts no turn; the session is idle. */
	function appendFoldMessage(sm: SessionManager, draft: RewindMessageDraft): void {
		if (unrestoredFoldCursors.has(sm)) return;
		const primary = trySessionWrite(sm, () =>
			pi.sendMessage(
				{
					customType: draft.customType,
					content: draft.content,
					display: draft.display,
					details: draft.details,
				},
				{ triggerTurn: false },
			),
		);
		if (primary.ok || !primary.cursorRestored) return;
		trySessionWrite(sm, () =>
			sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details),
		);
	}

	/** Fold an idle session now: nothing is written before the commit, then the continuation is appended. */
	async function runFoldNow(
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "isIdle">,
		request: FoldRequestInput,
		options: FoldRunOptions = {},
	): Promise<FoldResult> {
		let host: FoldHost;
		let full: FoldRequest;
		try {
			host = foldHostOf(ctx);
			host.isIdle = () => ctx.isIdle();
			full = { ...request, sessionId: host.sm.getSessionId() };
		} catch (error) {
			return gateFailed("exception", error instanceof Error ? error.message : String(error));
		}
		const outcome = await runFold(host, full, options);
		if (outcome.status === "done") appendFoldMessage(host.sm, foldDoneDraft(full, outcome));
		return outcome;
	}

	function foldBudget(ctx: ExtensionCommandContext): number {
		const model = ctx.model;
		return foldRecommendationBudget(
			model?.contextWindow ?? 0,
			resolveRewindHintReserve(
				{
					rewindHintReserveTokens: state.config.rewindHintReserveTokens,
					rewindHintModelReserveTokens: state.config.hintByModel,
				},
				model ? `${model.provider}/${model.id}` : undefined,
			),
		);
	}

	function manualFocus(plan: FoldPlan, sm: SessionManager): string {
		const typed = plan.focus?.trim();
		return typed && typed.length >= MIN_SUMMARY_FOCUS_LENGTH ? typed : defaultFoldFocus(sm);
	}

	/** Plan and engine access for a manual fold. `preselect` wraps the recommendation so list `r` lands on that anchor. */
	function manualFoldDeps(ctx: ExtensionCommandContext, preselect?: string): FoldPlanDeps {
		const recommend = (candidates: readonly FoldPlanCandidate[]) => {
			if (preselect) {
				const at = candidates.findIndex((candidate) => candidate.name === preselect);
				if (at >= 0) return at;
			}
			return recommendFoldIndex(candidates, foldBudget(ctx));
		};
		return {
			candidates(commandCtx) {
				const sm = commandCtx.sessionManager as SessionManager;
				const sessionId = sm.getSessionId();
				return priceFoldCandidates(sm, {
					model: commandCtx.model,
					handoffMode: state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT,
					captured: state.folds.capturedSystems.get(sessionId),
					focus: defaultFoldFocus(sm),
					suggestLabel: (name) => suggestFoldLabel(sm, name),
					thinking: foldHostOf(commandCtx).thinking,
				});
			},
			recommend,
			isAgentRunning: (commandCtx) => !commandCtx.isIdle(),
			summaryModel(commandCtx) {
				const model = commandCtx.model;
				if (!model) return "no model selected";
				return `${model.provider}/${model.id}:${summaryThinking()}`;
			},
			minFocusLength: MIN_SUMMARY_FOCUS_LENGTH,
			async start(commandCtx, plan, options) {
				const sm = commandCtx.sessionManager as SessionManager;
				const before = estimateAdmissionTokens(sm);
				const outcome = await runFoldNow(
					commandCtx,
					{
						origin: "manual",
						rewindTo: plan.anchor,
						newLabel: plan.label,
						focus: manualFocus(plan, sm),
					},
					{ signal: options.signal, onProgress: options.onProgress },
				);
				const landed = outcome.status === "done" ? outcome.commit : undefined;
				return foldPlanResult(outcome, {
					label: plan.label,
					beforeTokens: landed?.contextBefore ?? before,
					afterTokens: landed?.afterTokens ?? before,
				});
			},
			queue(commandCtx, plan) {
				try {
					const sm = commandCtx.sessionManager as SessionManager;
					return queueFold(sm.getSessionId(), {
						origin: "manual",
						rewindTo: plan.anchor,
						newLabel: plan.label,
						focus: manualFocus(plan, sm),
					});
				} catch (error) {
					return {
						ok: false,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			},
		};
	}

	function openManualFold(
		ctx: ExtensionCommandContext,
		preselect?: string,
	): Promise<"back" | "done"> {
		return openFoldPlanScreen(ctx, manualFoldDeps(ctx, preselect));
	}

	/**
	 * The queued fold at a `turn_end` boundary, after this turn's tool results
	 * are on the branch: its receipt is a boundary draft. Esc cancels it; a
	 * landed fold continues the run; a precommit failure continues only when
	 * the model asked for it and the run was not cancelled. Undefined when the ctx
	 * is stale (the fold stays queued).
	 */
	async function runQueuedFold(
		sm: SessionManager,
		sessionId: string,
		request: FoldRequest,
		message: { stopReason?: string },
		event: { entries?: SessionBoundaryDraft[] },
		ctx: ExtensionContext,
	): Promise<{ entries: SessionBoundaryDraft[]; continue?: boolean } | undefined> {
		let host: FoldHost;
		let signal: AbortSignal | undefined;
		try {
			host = foldHostOf(ctx);
			signal = ctx.signal;
		} catch {
			return undefined;
		}
		state.folds.queuedFolds.delete(sessionId);
		state.turns.rewindTurns.add(message);
		const deliver = (draft: RewindMessageDraft, cont: boolean) => ({
			entries: keepValidDrafts<SessionBoundaryDraft>(sm, [...(event.entries ?? []), draft]),
			continue: cont,
		});
		const notLanded = (outcome: Exclude<FoldResult, { status: "done" }>) => {
			const draft = foldFailedDraft(request, outcome);
			if (unrestoredFoldCursors.has(sm)) {
				try {
					if (ctx.hasUI) ctx.ui.notify(String(draft.content), "error");
				} catch {
					// A stale UI cannot make a receipt append safe.
				}
				return { entries: [], continue: false };
			}
			return deliver(
				draft,
				request.origin === "agent" &&
					outcome.status !== "cancelled" &&
					!(outcome.status === "failed" && outcome.stage === "commit"),
			);
		};
		if (signal?.aborted || message.stopReason === "aborted") {
			return notLanded({ status: "cancelled", usage: [] });
		}
		let outcome: FoldResult;
		try {
			// The folded span's user input belongs in the ledger the fold starts from.
			await captureContinuity(sm, sessionId, ctx, message);
			outcome = await runFold(host, request, { signal });
		} catch (error) {
			outcome = gateFailed("exception", error instanceof Error ? error.message : String(error));
		}
		if (outcome.status !== "done") return notLanded(outcome);
		return deliver(foldDoneDraft(request, outcome), true);
	}

	return {
		foldHostOf,
		gateFailed,
		queueFold,
		appendFoldMessage,
		runFoldNow,
		manualFoldDeps,
		openManualFold,
		runQueuedFold,
	};
}
