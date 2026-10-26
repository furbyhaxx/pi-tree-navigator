/** Tail-keeping pressure compaction, summary admission and recovery receipts. */

import type { Message } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { planPressureCut } from "../auto/pressure-compaction.ts";
import { compactionContinuity } from "../continuity/continuity-store.ts";
import { collectOpenUserRequests } from "../continuity/open-user-requests.ts";
import { estimateContentTokens } from "../core/context-tokens.ts";
import { formatWindow, LABEL_PREFIX, TOOL_NAME } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { emitSessionCompact, refreshAgentMessages } from "../core/pi-internals.ts";
import { findLabeledEntry, systemCheckpoint } from "../core/projection.ts";
import { requestAccounting, tokenFactorOf } from "../core/request-accounting.ts";
import { trySessionWrite } from "../core/session-write.ts";
import type { FoldHost } from "../fold/fold-api.ts";
import { unrestoredFoldCursors } from "../fold/fold-commit.ts";
import { buildConsolidationSegment, buildFoldProjection } from "../fold/fold-inputs.ts";
import {
	defaultFoldFocus,
	foldAdmission,
	foldPlaceholderSummary,
	preparedInContext,
	summarizerReduceTokens,
} from "../fold/fold-pricing.ts";
import { REWIND_CUSTOM_TYPE, type RewindMessageDraft } from "../fold/fold-receipts.ts";
import { createFoldSummaryRunner, summarizeFold } from "../fold/fold-summarizer.ts";
import type { HandoffMode } from "../fold/handoff.ts";
import { projectHandoffs } from "../fold/handoff-projection.ts";
import { appendContinuityBriefing } from "../fold/summary-prompt.ts";

/** The smallest kept tail a pressure compaction shrinks to, as a share of `keep_recent_share`. */
const MIN_KEPT_SHARE_OF_CONFIGURED = 0.25;

/** Pressure-run state, savings floor, receipt type and best-effort label writer. */
export interface PressureCompactionDeps {
	state: Pick<NavigatorState, "folds">;
	minRewindSavingsTokens: number;
	pressureCompactionCustomType: string;
	writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean;
}

/** Creates pressure compaction operations without registering handlers or starting work. */
export function createPressureCompactionController({
	state,
	minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
	pressureCompactionCustomType: PRESSURE_COMPACTION_CUSTOM_TYPE,
	writeLabel,
}: PressureCompactionDeps) {
	/**
	 * Tail-keeping pressure relief: summarize the projected work older than the
	 * newest `keep_recent_share` of rewind_at_tokens into a native compaction and
	 * keep the recent tool turns verbatim, so the agent does not re-read them.
	 * Open user requests and the continuity briefing ride along verbatim; the
	 * compaction entry gets an anchor, the floor later folds and recovery use.
	 */
	async function compactUnderPressure(input: {
		sm: SessionManager;
		sessionId: string;
		host: FoldHost;
		/** Tokens the compacted request should land under; a guide, not a gate. */
		budget: number;
		keepRecentTokens: number;
		/** Receipt lead, e.g. "Context ~150k crossed rewind_at_tokens 200k". */
		trigger: string;
		origin: "pressure" | "recovery";
		activeTokens: number;
		captured: { modelKey: string; messages: Message[] } | undefined;
		handoffMode: HandoffMode;
		signal: AbortSignal | undefined;
		isCurrent(): boolean;
	}): Promise<
		| { kind: "done"; draft: RewindMessageDraft }
		| { kind: "skip"; reason: string }
		| { kind: "stale" }
	> {
		const { sm, sessionId, host, budget, activeTokens, signal } = input;
		const { model, registry } = host;
		const leafId = sm.getLeafId();
		if (!model || !leafId) return { kind: "stale" };
		const all = sm.getEntries();
		const projected = buildFoldProjection(all, leafId).entries;
		if (!registry.hasConfiguredAuth(model))
			return {
				kind: "skip",
				reason: `no authentication is configured for ${model.provider}/${model.id}`,
			};
		const cutEntries = projected.map((entry) => {
			const messages = entry.messages.filter((m) => m.role !== "system");
			return {
				entryId: entry.sourceEntry.id,
				tokens: estimateContentTokens(messages),
				roles: messages.map((m) => m.role),
				toolCallIds: messages.flatMap((m) =>
					m.role === "assistant"
						? m.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
						: [],
				),
				toolResultIds: messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
			};
		});
		// One candidate cut: its records, open requests and the priced request a
		// compaction with a full-size summary would leave.
		const planAt = (keepRecentTokens: number) => {
			const cut = planPressureCut({ keepRecentTokens, entries: cutEntries });
			if (cut.kind === "skip") return { kind: "skip" as const, reason: cut.detail };
			const cutAt = projected.findIndex((entry) => entry.sourceEntry.id === cut.firstKeptEntryId);
			const records = buildConsolidationSegment(all, leafId, cut.firstKeptEntryId);
			if (cutAt < 0 || !records.length)
				return {
					kind: "skip" as const,
					reason: "the cut is no longer in the projected context",
				};
			const requests = collectOpenUserRequests(
				projected,
				leafId,
				new Set(projected.slice(cutAt).map((entry) => entry.sourceEntry.id)),
				REWIND_CUSTOM_TYPE,
			);
			const quoted = requests.length
				? "\n\n## Open user requests\nThe work above was compacted to free context. The user request(s) below are still open and quoted verbatim; continue them.\n" +
					requests
						.map(
							(request) =>
								`\nQuoted user request (source entry ID: ${request.sourceEntryId}):\n<archived-user-request>\n${request.text}\n</archived-user-request>`,
						)
						.join("\n")
				: "";
			const details = (summary?: { strategy: string; calls: number }) => ({
				navigateTree: {
					pressure: {
						keptTokens: Math.round(cut.keptTokens * tokenFactorOf(sm)),
						prefixTokens: cut.prefixTokens,
						...(summary && {
							strategy: summary.strategy,
							calls: summary.calls,
						}),
						openUserRequests: requests,
					},
				},
			});
			const compactionText = (summaryText: string) => {
				const continuity = compactionContinuity(sm.getBranch(), summaryText);
				return continuity.briefing === undefined
					? continuity.summaryText + quoted
					: appendContinuityBriefing(continuity.summaryText + quoted, continuity.briefing);
			};
			const previewOf = (summary: string, info?: object): CompactionEntry => {
				const { systemMessage } = systemCheckpoint(sm);
				return {
					type: "compaction",
					id: "tree-navigator-pressure-preview",
					parentId: leafId,
					timestamp: new Date().toISOString(),
					summary,
					firstKeptEntryId: cut.firstKeptEntryId,
					tokensBefore: activeTokens,
					...(info === undefined ? {} : { details: info }),
					fromHook: true,
					...(systemMessage === undefined ? {} : { systemMessage }),
				};
			};
			// The request after the compaction, priced as the request guard prices it,
			// including the effective system state and the model-visible receipt.
			const admissionAfter = (preview: CompactionEntry, receipt: string) => {
				const withPreview = [...sm.getEntries(), preview];
				return requestAccounting(sm, [
					...projectHandoffs(buildSessionProjection(withPreview, preview.id), withPreview).messages,
					{
						role: "custom",
						customType: PRESSURE_COMPACTION_CUSTOM_TYPE,
						content: receipt,
						display: true,
						timestamp: Date.now(),
					},
				]).tokens;
			};
			const receiptText = (after: number, anchor?: string) =>
				`[${TOOL_NAME} ${input.origin === "pressure" ? "auto_navigate" : "recovery"}] ${input.trigger}: older work was compacted, context ~${formatWindow(activeTokens)} -> ~${formatWindow(after)} tokens${after > budget ? `, above the ~${formatWindow(budget)} target (the system prompt, tools, kept work and summary leave no smaller result)` : ""}. The newest ~${formatWindow(cut.keptTokens)} tokens of work stay verbatim${requests.length ? `; ${requests.length} open request(s) are quoted in the summary` : ""}.${anchor ? ` Anchor '${anchor}' marks the compaction.` : ""} The original entries remain in the session file.`;
			const floor = admissionAfter(
				previewOf(compactionText(foldPlaceholderSummary(summarizerReduceTokens(model))), details()),
				receiptText(activeTokens, "compacted-00"),
			);
			return {
				kind: "plan" as const,
				cut,
				cutAt,
				records,
				requests,
				details,
				compactionText,
				previewOf,
				admissionAfter,
				receiptText,
				floor,
			};
		};
		// The newest work stays verbatim, but a kept tail too large to land under
		// the budget shrinks first, down to a quarter of the configured share.
		// Cut entries are raw heuristic tokens; the configured tail is calibrated.
		const configuredKeep = Math.floor(input.keepRecentTokens / tokenFactorOf(sm));
		const minKeep = Math.ceil(configuredKeep * MIN_KEPT_SHARE_OF_CONFIGURED);
		let plan = planAt(configuredKeep);
		for (let tries = 0; tries < 4; tries++) {
			if (plan.kind !== "plan" || plan.floor <= budget) break;
			const next =
				Math.min(configuredKeep, plan.cut.keptTokens) -
				Math.ceil(((plan.floor - budget) / tokenFactorOf(sm)) * 1.05);
			if (next < minKeep) break;
			const smaller = planAt(next);
			if (smaller.kind !== "plan" || smaller.cut.keptTokens >= plan.cut.keptTokens) break;
			plan = smaller;
		}
		// Over budget is still relief: the compaction runs with the smallest tail
		// tried, and only a compaction that frees too little is skipped.
		if (plan.kind !== "plan") return plan;
		const {
			cut,
			cutAt,
			records,
			requests,
			details,
			compactionText,
			previewOf,
			admissionAfter,
			receiptText,
		} = plan;
		state.folds.runningFolds.add(sessionId);
		try {
			const summary = await summarizeFold({
				runner: createFoldSummaryRunner({
					registry,
					model,
					thinking: host.thinking,
					sessionId,
				}),
				focus: `${defaultFoldFocus(sm)} The newest ~${formatWindow(cut.keptTokens)} tokens of work stay verbatim after this summary; record the state of the work in progress and what comes next.`,
				parent: {
					mode: input.handoffMode,
					childCount: projected
						.slice(0, cutAt)
						.filter((entry) => entry.sourceEntry.type === "branch_summary").length,
				},
				inContext: preparedInContext(sm, undefined, leafId, input.captured, model),
				segment: { background: "", records },
				admit: foldAdmission(model.contextWindow ?? 0, tokenFactorOf(sm)),
				signal,
			});
			if (!input.isCurrent()) return { kind: "stale" };
			if (!summary.ok) return { kind: "skip", reason: `${summary.reason}: ${summary.detail}` };
			const text = compactionText(summary.text);
			const info = details(summary);
			const preview = previewOf(text, info);
			const now = sm.getEntries();
			const before = estimateContentTokens(buildFoldProjection(now, leafId).messages);
			const after = estimateContentTokens(
				buildFoldProjection([...now, preview], preview.id).messages,
			);
			const projectedAfter = admissionAfter(preview, receiptText(activeTokens, "compacted-00"));
			if ((before - after) * tokenFactorOf(sm) < MIN_REWIND_SAVINGS_TOKENS)
				return {
					kind: "skip",
					reason: `the compaction does not free enough context (estimated ${before} -> ${after} tokens); original history was kept`,
				};
			const written = trySessionWrite(sm, () =>
				sm.appendCompaction(text, cut.firstKeptEntryId, activeTokens, info, true),
			);
			if (!written.ok) {
				if (!written.cursorRestored) unrestoredFoldCursors.add(sm);
				return {
					kind: "skip",
					reason: `the compaction could not be written (${written.error instanceof Error ? written.error.message : String(written.error)}); ${written.cursorRestored ? "the session cursor was restored" : "persistence is uncertain, reload the session before folding again"}`,
				};
			}
			let name = "compacted";
			for (let n = 2; findLabeledEntry(sm, LABEL_PREFIX + name); n++) name = `compacted-${n}`;
			const anchored = writeLabel(sm, written.value, LABEL_PREFIX + name);
			refreshAgentMessages(sm);
			await emitSessionCompact(sm, written.value);
			return {
				kind: "done",
				draft: {
					type: "custom_message",
					customType: PRESSURE_COMPACTION_CUSTOM_TYPE,
					content: receiptText(projectedAfter, anchored ? name : undefined),
					display: true,
					details: {
						origin: input.origin,
						compactionId: written.value,
						anchor: anchored ? name : undefined,
						before: activeTokens,
						after: projectedAfter,
						target: budget,
						aboveTarget: projectedAfter > budget,
						keptTokens: cut.keptTokens,
						strategy: summary.strategy,
						calls: summary.calls,
						openUserRequests: requests.length,
					},
				},
			};
		} catch (error) {
			return {
				kind: "skip",
				reason: error instanceof Error ? error.message : String(error),
			};
		} finally {
			state.folds.runningFolds.delete(sessionId);
		}
	}

	return { compactUnderPressure };
}
