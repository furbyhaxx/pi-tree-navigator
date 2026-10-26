/** Fail-open continuity capture and one-shot post-fold nudges. */

import type { ExtensionAPI, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import {
	CONTINUE_NUDGE_STATUS,
	CONTINUE_NUDGE_TEXT,
	REWIND_CUSTOM_TYPE,
	type RewindMessageDraft,
	rewindMessageDraft,
} from "../fold/fold-receipts.ts";
import { hasOpenWork } from "../fold/summary-prompt.ts";
import {
	captureIntent,
	createModelClassifier,
	heuristicClassifier,
	type IntentClassifier,
} from "./continuity-capture.ts";
import { appendOpsEntry, type BranchLedger, readBranchLedger } from "./continuity-store.ts";
import { resolveIntentPolicy } from "./intent-policy.ts";

/** Wall-clock bound on one continuity capture pass: a slow classifier must not stall a turn. */
const CONTINUITY_CAPTURE_TIMEOUT_MS = 15_000;

/** Whether the latest assistant message on `branch` still lacks tool results. */
function endsInOpenToolBatch(branch: readonly SessionEntry[]): boolean {
	const at = branch.findLastIndex(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const entry = branch[at];
	if (entry?.type !== "message" || entry.message.role !== "assistant") {
		return false;
	}
	const calls = entry.message.content.filter((block) => block.type === "toolCall").length;
	const results = branch
		.slice(at + 1)
		.filter((e) => e.type === "message" && e.message.role === "toolResult").length;
	return results < calls;
}

/** Capture persistence and the state groups read by capture and nudge gates. */
export interface ContinuityRuntimeDeps {
	pi: Pick<ExtensionAPI, "appendEntry">;
	state: Pick<NavigatorState, "config" | "activity" | "continuity" | "turns">;
}

/** Creates continuity operations without registering handlers or starting work. */
export function createContinuityRuntime({ pi, state }: ContinuityRuntimeDeps) {
	// Runs at a `turn_end` boundary, where the assistant and all its tool
	// results are already on the branch, so the entry cannot land inside a tool
	// batch (`endsInOpenToolBatch` guards the rest). A plain `appendEntry` is
	// safe there: pi previews every handler's drafts against the live branch.
	// Fail-open and time-bounded; never throws into the turn.
	async function captureContinuity(
		sm: SessionManager,
		sessionId: string,
		ctx: {
			hasUI: boolean;
			ui: { notify(message: string, type?: "warning"): void };
			modelRegistry?: Parameters<typeof createModelClassifier>[0];
			signal?: AbortSignal;
		},
		message: { stopReason?: string },
	): Promise<void> {
		if (!state.config.continuity.capture) return;
		const captureConfig = state.config.continuity;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return;
		}
		// Every ctx getter is read before the first await (stale-ctx contract).
		let notify: ((text: string) => void) | undefined;
		let registry: typeof ctx.modelRegistry;
		let parentSignal: AbortSignal | undefined;
		let branch: SessionEntry[];
		let leafId: string | null;
		let base: BranchLedger;
		try {
			if (ctx.hasUI) {
				const ui = ctx.ui;
				notify = (text) => ui.notify(text, "warning");
			}
			registry = ctx.modelRegistry;
			parentSignal = ctx.signal;
			branch = sm.getBranch();
			leafId = sm.getLeafId();
			if (endsInOpenToolBatch(branch)) return;
			base = readBranchLedger(branch);
		} catch {
			return;
		}
		if (parentSignal?.aborted) return;
		const warned = state.continuity.continuityWarned.get(sessionId) ?? new Set<string>();
		state.continuity.continuityWarned.set(sessionId, warned);
		const warn = (text: string) => {
			if (state.config.continuity !== captureConfig || parentSignal?.aborted || warned.has(text))
				return;
			warned.add(text);
			try {
				notify?.(text);
			} catch {
				// Stale ctx: nothing left to surface with.
			}
		};
		const model = state.continuity.classifierTimedOut.has(sessionId)
			? null
			: state.config.continuity.intentClassifier;
		const controller = new AbortController();
		const abort = () => controller.abort();
		parentSignal?.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve("timeout");
			}, CONTINUITY_CAPTURE_TIMEOUT_MS);
		});
		const { ledger, watermark } = base;
		const run = (async () => {
			const classifier: IntentClassifier =
				(model !== null && registry
					? await createModelClassifier(registry, model, { onWarning: warn })
					: undefined) ?? heuristicClassifier;
			return {
				usedModel: classifier !== heuristicClassifier,
				result: await captureIntent(branch, watermark, ledger, classifier, {
					signal: controller.signal,
				}),
			};
		})().catch(() => undefined);
		let outcome: Awaited<typeof run> | "timeout";
		try {
			outcome = await Promise.race([run, deadline]);
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abort);
		}
		if (state.config.continuity !== captureConfig || parentSignal?.aborted) return;
		if (outcome === "timeout") {
			if (model === null) return;
			state.continuity.classifierTimedOut.add(sessionId);
			warn(
				`${TOOL_NAME}: continuity classifier ${model.startsWith("{") ? (resolveIntentPolicy(model)?.kind.model ?? "configured policy") : model} did not answer within ${CONTINUITY_CAPTURE_TIMEOUT_MS / 1000} s; capture uses heuristics for the rest of this session.`,
			);
			return await captureContinuity(sm, sessionId, ctx, message);
		}
		try {
			// A moved leaf or an abort during the await: the scan is stale.
			if (
				!outcome ||
				parentSignal?.aborted ||
				sm.getLeafId() !== leafId ||
				state.config.continuity !== captureConfig
			)
				return;
			const { result, usedModel } = outcome;
			for (const text of result.warnings) warn(text);
			// Heuristic verdicts are free to recompute; only a model's are worth a
			// watermark of their own.
			if (result.ops.length === 0 && !(usedModel && result.classified > 0)) {
				return;
			}
			appendOpsEntry(pi, result.ops, result.watermark);
		} catch {
			// Fail-open: the next turn rescans from the same watermark.
		}
	}

	// Folds (by summary entry id) whose first post-fold turn was already
	// nudged: at most one nudge per fold, even if pi dropped its draft.

	// The first assistant turn after a delivered fold continuation ended
	// text-only while the fold's summary still lists open work: one steer, so
	// the milestone summary is not read as a stop condition. No user turn may
	// sit between the continuation and the turn, and a fold that carried late
	// user input answers that input, so neither is nudged. A fold forced by a
	// context overflow is not nudged either.
	function continueNudgeDraft(
		sm: SessionManager,
		sessionId: string,
		message: { content?: unknown; stopReason?: string },
		event: { messageEntryId?: unknown; continue?: boolean },
		signal: AbortSignal | undefined,
	): RewindMessageDraft | undefined {
		if (event.continue || signal?.aborted) return;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.stopReason === "length" ||
			state.turns.rewindTurns.has(message) ||
			state.turns.overflowedTurns.has(message)
		) {
			return;
		}
		if (Array.isArray(message.content) && message.content.some((b) => b?.type === "toolCall")) {
			return;
		}
		try {
			const branch = sm.getBranch();
			const at =
				typeof event.messageEntryId === "string" && event.messageEntryId
					? branch.findIndex((e) => e.id === event.messageEntryId)
					: branch.length - 1;
			for (let i = at - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry === undefined) continue;
				if (
					entry.type === "message" ||
					entry.type === "branch_summary" ||
					entry.type === "compaction"
				) {
					return;
				}
				if (entry.type !== "custom_message" || entry.customType !== REWIND_CUSTOM_TYPE) {
					continue;
				}
				const d = entry.details as
					| {
							status?: unknown;
							summaryId?: unknown;
							reappendedLateMessages?: unknown;
							forced?: unknown;
					  }
					| undefined;
				if (
					d?.status !== "done" ||
					typeof d.summaryId !== "string" ||
					d.forced === true ||
					Number(d.reappendedLateMessages) > 0 ||
					state.continuity.nudgedFolds.has(d.summaryId)
				) {
					return;
				}
				const fold = sm.getEntry(d.summaryId);
				if (fold?.type !== "branch_summary" || !hasOpenWork(fold.summary)) return;
				state.continuity.nudgedFolds.add(d.summaryId);
				return rewindMessageDraft(CONTINUE_NUDGE_TEXT, {
					status: CONTINUE_NUDGE_STATUS,
					summaryId: d.summaryId,
				});
			}
		} catch {
			// Fail-open: no nudge.
		}
		return undefined;
	}

	return { captureContinuity, continueNudgeDraft };
}
