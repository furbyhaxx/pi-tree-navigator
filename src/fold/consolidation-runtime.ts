/** Background handoff consolidation at unused turn boundaries. */

import type {
	CompactionEntry,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { estimateContentTokens } from "../core/context-tokens.ts";
import { formatWindow, TOOL_NAME, toOneLine } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { emitSessionCompact, refreshAgentMessages } from "../core/pi-internals.ts";
import { systemCheckpoint } from "../core/projection.ts";
import { estimateAdmissionTokens, tokenFactorOf } from "../core/request-accounting.ts";
import { trySessionWrite } from "../core/session-write.ts";
import { planConsolidation } from "./consolidation-planner.ts";
import type { FoldHost } from "./fold-api.ts";
import { unrestoredFoldCursors } from "./fold-commit.ts";
import { buildConsolidationSegment, buildFoldProjection } from "./fold-inputs.ts";
import { foldAdmission } from "./fold-pricing.ts";
import { createFoldSummaryRunner, summarizeFold } from "./fold-summarizer.ts";
import { buildConsolidationRequestText } from "./summary-prompt.ts";

/** The consolidation prompt asks for about 6,000 characters. */
const CONSOLIDATION_SUMMARY_TOKENS = Math.ceil(6000 / 3.5);

/** Consolidation state, savings floor, receipt type and the live fold host adapter. */
export interface ConsolidationDeps {
	state: Pick<NavigatorState, "config" | "activity" | "folds">;
	minRewindSavingsTokens: number;
	consolidationCustomType: string;
	foldHostOf(ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry">): FoldHost;
}

/** Creates consolidation operations without registering handlers or starting work. */
export function createConsolidationController({
	state,
	minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
	consolidationCustomType: CONSOLIDATION_CUSTOM_TYPE,
	foldHostOf,
}: ConsolidationDeps) {
	/**
	 * Background handoff consolidation at a turn boundary nothing else used:
	 * merge every projected entry before the oldest of the newest handoffs into
	 * one native compaction. Pi projects that compaction followed by the kept
	 * entries; later folds carry it forward (`carriedCompaction`). Returns the
	 * receipt or warning to append, or nothing when no check was due.
	 */
	async function maybeConsolidate(
		sm: SessionManager,
		sessionId: string,
		message: { stopReason?: string },
		ctx: ExtensionContext,
	): Promise<SessionBoundaryDraft[] | undefined> {
		const config = state.config.consolidation;
		if (
			!config.enabled ||
			(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			state.folds.queuedFolds.has(sessionId) ||
			state.folds.runningFolds.has(sessionId) ||
			unrestoredFoldCursors.has(sm)
		)
			return;
		let host: FoldHost;
		let signal: AbortSignal | undefined;
		let notify: ((text: string) => void) | undefined;
		try {
			host = foldHostOf(ctx);
			signal = ctx.signal;
			const ui = ctx.hasUI ? ctx.ui : undefined;
			notify = ui ? (text) => ui.notify(text, "warning") : undefined;
			if (host.sm !== sm || sm.getSessionId() !== sessionId) return;
		} catch {
			return;
		}
		const { model, registry } = host;
		const leafId = sm.getLeafId();
		if (!model || !leafId || signal?.aborted) return;
		const contextWindow = model.contextWindow ?? 0;
		const entries = sm.getEntries();
		const projected = buildFoldProjection(entries, leafId).entries;
		const handoffs: {
			entryId: string;
			tokens: number;
			prefixTokens: number;
		}[] = [];
		let prefixTokens = 0;
		for (const entry of projected) {
			const messages = entry.messages.filter((m) => m.role !== "system");
			const tokens = estimateContentTokens(messages);
			if (entry.sourceEntry.type === "branch_summary")
				handoffs.push({ entryId: entry.sourceEntry.id, tokens, prefixTokens });
			prefixTokens += tokens;
		}
		const plan = planConsolidation({
			limits: config,
			handoffs,
			contextWindow,
			summaryTokens: CONSOLIDATION_SUMMARY_TOKENS,
			minSavingTokens: MIN_REWIND_SAVINGS_TOKENS,
		});
		if (plan.kind === "skip") return;
		const warn = (reason: string): SessionBoundaryDraft[] => {
			const text = `[${TOOL_NAME} consolidation] ${plan.merged} older handoffs (~${formatWindow(plan.prefixTokens)} tokens) were not consolidated: ${toOneLine(reason, 400) ?? "unknown reason"}`;
			try {
				notify?.(text);
			} catch {
				/* A stale UI must not block the receipt. */
			}
			return [
				{
					type: "custom_message",
					customType: "navigate-tree-auto-warning",
					content: text,
					display: true,
				},
			];
		};
		const cutAt = projected.findIndex((entry) => entry.sourceEntry.id === plan.firstKeptEntryId);
		const prefixCalls = new Set<string>();
		for (const entry of projected.slice(0, cutAt))
			for (const m of entry.messages)
				if (m.role === "assistant")
					for (const block of m.content) if (block.type === "toolCall") prefixCalls.add(block.id);
		const split = projected
			.slice(cutAt)
			.some((entry) =>
				entry.messages.some((m) => m.role === "toolResult" && prefixCalls.has(m.toolCallId)),
			);
		if (split) return warn("a tool call before the cut has its result after it");
		const records = buildConsolidationSegment(entries, leafId, plan.firstKeptEntryId);
		if (!records.length) return;
		if (!registry.hasConfiguredAuth(model))
			return warn(`no authentication is configured for ${model.provider}/${model.id}`);
		const isCurrent = () => {
			try {
				return (
					!signal?.aborted &&
					ctx.signal === signal &&
					ctx.sessionManager === sm &&
					sm.getSessionId() === sessionId &&
					sm.getLeafId() === leafId &&
					!state.folds.queuedFolds.has(sessionId) &&
					!unrestoredFoldCursors.has(sm)
				);
			} catch {
				return false;
			}
		};
		state.folds.runningFolds.add(sessionId);
		try {
			const summary = await summarizeFold({
				runner: createFoldSummaryRunner({
					registry,
					model,
					thinking: host.thinking,
					sessionId,
				}),
				focus:
					"The consolidated project history: goals, constraints, delivered work, decisions, open items and standing authorization.",
				instruction: buildConsolidationRequestText,
				segment: { background: "", records },
				admit: foldAdmission(contextWindow, tokenFactorOf(sm)),
				signal,
			});
			if (!isCurrent()) return;
			if (!summary.ok) return warn(`${summary.reason}: ${summary.detail}`);
			const text = summary.text;
			const tokensBefore = estimateAdmissionTokens(sm);
			const details = {
				navigateTree: {
					consolidation: {
						merged: plan.merged,
						trigger: plan.trigger,
						strategy: summary.strategy,
						calls: summary.calls,
					},
				},
			};
			// Deterministic gate: the compaction must free context as Pi will project it.
			const all = sm.getEntries();
			const preview = {
				type: "compaction",
				id: "tree-navigator-consolidation-preview",
				parentId: leafId,
				timestamp: new Date().toISOString(),
				summary: text,
				firstKeptEntryId: plan.firstKeptEntryId,
				tokensBefore,
				details,
				fromHook: true,
				...systemCheckpoint(sm),
			} satisfies CompactionEntry;
			const before = estimateContentTokens(buildFoldProjection(all, leafId).messages);
			const after = estimateContentTokens(
				buildFoldProjection([...all, preview], preview.id).messages,
			);
			if (before - after < MIN_REWIND_SAVINGS_TOKENS)
				return warn(
					`the consolidated history does not free enough context (estimated ${before} -> ${after} tokens); original history was kept`,
				);
			const written = trySessionWrite(sm, () =>
				sm.appendCompaction(text, plan.firstKeptEntryId, tokensBefore, details, true),
			);
			if (!written.ok) {
				if (!written.cursorRestored) unrestoredFoldCursors.add(sm);
				return warn(
					`the compaction could not be written (${written.error instanceof Error ? written.error.message : String(written.error)}); ${written.cursorRestored ? "the session cursor was restored" : "persistence is uncertain, reload the session before folding again"}`,
				);
			}
			refreshAgentMessages(sm);
			await emitSessionCompact(sm, written.value);
			return [
				{
					type: "custom_message",
					customType: CONSOLIDATION_CUSTOM_TYPE,
					content: `[${TOOL_NAME} consolidation] Merged ${plan.merged} older handoffs into the project history: context ~${formatWindow(before)} -> ~${formatWindow(after)} tokens. The newest ${config.keepNewest} handoffs stay verbatim; the original entries remain in the session file.`,
					display: true,
					details: {
						compactionId: written.value,
						merged: plan.merged,
						trigger: plan.trigger,
						before,
						after,
						calls: summary.calls,
					},
				},
			];
		} catch (error) {
			return warn(error instanceof Error ? error.message : String(error));
		} finally {
			state.folds.runningFolds.delete(sessionId);
		}
	}

	return { maybeConsolidate };
}
