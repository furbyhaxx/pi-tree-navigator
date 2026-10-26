/** Read-only fold materialization and admission preview. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection,
	type CompactionEntry,
	collectEntriesForBranchSummary,
	prepareBranchEntries,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { LEDGER_DETAILS_KEY } from "../continuity/continuity-ledger-model.ts";
import { type FoldContinuity, reconcileFoldContinuity } from "../continuity/continuity-store.ts";
import {
	collectOpenUserRequests,
	type OpenUserRequest,
	renderOpenUserRequests,
} from "../continuity/open-user-requests.ts";
import { estimateContentTokens } from "../core/context-tokens.ts";
import { LABEL_PREFIX } from "../core/helpers.ts";
import { REFLECTION_BOOTSTRAP_WARNING_REWIND } from "../core/pi-internals.ts";
import {
	carriedCompaction,
	compactionCopy,
	findLabeledEntry,
	precedesLatestCompaction,
	projectAtEntry,
} from "../core/projection.ts";
import { requestAccounting } from "../core/request-accounting.ts";
import { collectLateEntries, type LateEntry, rewindStaleReason } from "../recovery/recovery-cut.ts";
import { RECOVERY_HEADROOM_TOKENS, RECOVERY_MIN_OUTPUT_TOKENS } from "./fold-policy.ts";
import { buildLateEntriesNote, REWIND_CUSTOM_TYPE } from "./fold-receipts.ts";
import { getHandoff, type HandoffMode, makeHandoff, materializeHandoff } from "./handoff.ts";
import { projectHandoffs } from "./handoff-projection.ts";
import {
	appendContinuityBriefing,
	computeFileLists,
	formatFileOperations,
	stripContinuityBriefing,
} from "./summary-prompt.ts";

/** What the preview stage of a fold needs: a commit's input without its session writes. */
export interface FoldPreviewInput {
	/** The anchor entry the new branch starts from. */
	targetId: string;
	/** The anchor name that must still resolve to `targetId`. */
	rewindTo: string;
	/** The summary's label; must still be free. */
	newLabel: string;
	/** The model's summary, continuity delta included. */
	summaryText: string;
	handoffMode: HandoffMode;
	/** Tokens; 0 skips the headroom gate. */
	contextWindow: number;
	/** The last folded entry: input after it is late, kept out of the fold and re-appended after it. */
	foldPointId: string;
	/** Successful overflow evidence retained after the pending input. */
	recoveryEvidenceId?: string;
	/** Gets the `branch:<newLabel>` completion marker before the branch is written. */
	branchLabelEntryId?: string;
	/** The continuation's lead text for a post-fold request of `afterTokens`. */
	continuationText(afterTokens: number): string;
}

/** Everything a fold writes, prepared from session reads alone. */
export interface FoldMaterialization {
	/** The leaf the fold abandons. */
	oldLeafId: string | null;
	/** The `branch_summary` text: handoff, full child reports and the continuity briefing. */
	materialized: string;
	/** The `branch_summary` details: file lists, handoff metadata and the ledger snapshot. */
	details: Record<string, unknown>;
	/** The entries between the target and the leaf. */
	collapsedEntries: number;
	readFiles: string[];
	modifiedFiles: string[];
	/** Input after the fold point, re-appended after the summary. */
	lateEntries: LateEntry[];
	continuity: FoldContinuity;
	/** Open collapsed user instructions, separate from generated narrative. */
	openUserRequests: OpenUserRequest[];
	/** The latest compaction, re-appended after the summary because its kept range holds the target. */
	carriedCompaction?: CompactionEntry;
}

/** `ok: false` is the reason `commitFold` would refuse for; nothing was written either way. */
export type FoldPreview =
	| { ok: false; reason: string }
	| ({
			ok: true;
			/** The admission estimate of the first request after the fold, continuation included. */
			projectedAfterTokens: number;
			foldEstimateBefore: number;
			foldEstimateAfter: number;
	  } & FoldMaterialization);

/**
 * Everything a fold commit decides, from session reads alone: revalidate the
 * target, collect the span and the late input, reconcile the continuity
 * ledger, materialize the handoff, project the branch it leaves (full child
 * handoffs, briefing, late input and continuation included) and gate it on
 * reducing context and on the request headroom. `commitFold` lands exactly
 * this; candidate pricing reuses it with a placeholder `summaryText`.
 * A session read failing during the target checks throws; any later one is a
 * refusal.
 */
export function previewFoldCommit(sm: SessionManager, input: FoldPreviewInput): FoldPreview {
	const { targetId, rewindTo, newLabel, foldPointId } = input;
	const refuse = (reason: string): FoldPreview => ({ ok: false, reason });
	// A compaction or tree move since the summary was requested invalidates the
	// fold: the anchor must still be the same labeled entry on the active
	// branch, and the new label must still be free.
	if (findLabeledEntry(sm, LABEL_PREFIX + rewindTo) !== targetId) {
		return refuse(`'${rewindTo}' is no longer on the active branch`);
	}
	if (findLabeledEntry(sm, LABEL_PREFIX + newLabel)) {
		return refuse(`a label '${newLabel}' now exists on the active branch`);
	}
	const staleReason = rewindStaleReason(sm, foldPointId);
	if (staleReason) return refuse(staleReason);
	const oldLeafId = sm.getLeafId();
	// Input that arrived after the fold point (user steers drained at the
	// rewind turn's boundary, other extensions' messages) sits on the segment
	// about to be abandoned. It is new input, not collapsed work: it is
	// re-appended onto the new branch, in order, ahead of the continuation
	// (which flags it as unanswered).
	const lateEntries = collectLateEntries(sm, foldPointId, input.recoveryEvidenceId);
	try {
		const { entries } = collectEntriesForBranchSummary(sm, oldLeafId, targetId);
		const { fileOps } = prepareBranchEntries(entries, Number.MAX_SAFE_INTEGER);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		const children = entries.filter((entry) => entry.type === "branch_summary");
		const all = new Map(sm.getEntries().map((entry) => [entry.id, entry]));
		const sourceIds = new Set(
			entries.filter((entry) => entry.type !== "branch_summary").map((entry) => entry.id),
		);
		for (const child of children) {
			sourceIds.add(child.id);
			const metadata = getHandoff(child);
			if (metadata) for (const id of metadata.sourceIds) sourceIds.add(id);
			else if (child.type === "branch_summary") {
				const path = sm.getBranch(child.fromId);
				const at = path.findIndex((entry) => entry.id === child.parentId);
				for (const entry of path.slice(at + 1)) sourceIds.add(entry.id);
			}
		}
		// Pure: the ledger only changes through the branch_summary a commit
		// writes, so every failure ending before it leaves the ledger untouched.
		const continuity = reconcileFoldContinuity(sm.getBranch(), input.summaryText, rewindTo);
		const handoff = makeHandoff({
			name: newLabel,
			report: continuity.summaryText + formatFileOperations(readFiles, modifiedFiles),
			mode: input.handoffMode,
			children: children.map((child) => child.id),
			sourceEntries: [...sourceIds].flatMap((id) => {
				const entry = all.get(id);
				return entry ? [entry] : [];
			}),
		});
		// A child's own briefing is stale in its parent: only this fold's stays.
		const handoffText = materializeHandoff(
			handoff,
			children.flatMap((child) =>
				child.type === "branch_summary"
					? [
							{
								id: child.id,
								summary: stripContinuityBriefing(child.summary),
								handoff: getHandoff(child),
							},
						]
					: [],
			),
		);
		const materialized =
			continuity.briefing === undefined
				? handoffText
				: appendContinuityBriefing(handoffText, continuity.briefing);
		const details = {
			readFiles,
			modifiedFiles,
			treeNavigator: handoff,
			...(continuity.snapshot && {
				[LEDGER_DETAILS_KEY]: continuity.snapshot,
			}),
		};
		let previewId = "tree-navigator-fold-preview";
		while (all.has(previewId)) previewId += "-";
		const preview: SessionEntry = {
			type: "branch_summary",
			id: previewId,
			parentId: targetId,
			timestamp: new Date().toISOString(),
			fromId: oldLeafId ?? foldPointId,
			summary: materialized,
			details,
			fromHook: true,
		};
		const carry = carriedCompaction(sm.getBranch(), targetId);
		const prospectiveEntries: SessionEntry[] = [...all.values(), preview];
		let prospectiveLeaf = previewId;
		if (carry) {
			const copy = compactionCopy(
				carry,
				previewId,
				new Map(prospectiveEntries.map((entry) => [entry.id, entry])),
			);
			prospectiveEntries.push(copy);
			prospectiveLeaf = copy.id;
		}
		const prospective = projectHandoffs(
			buildSessionProjection(prospectiveEntries, prospectiveLeaf),
			prospectiveEntries,
		).messages;
		const lateMessages: AgentMessage[] = lateEntries.map((late) =>
			late.kind !== "custom"
				? late.message
				: {
						role: "custom",
						customType: late.customType,
						content: late.content,
						display: late.display,
						details: late.details,
						timestamp: Date.now(),
					},
		);
		prospective.push(...lateMessages);
		const currentEntries = sm.buildSessionProjection().entries;
		const foldPointAt = currentEntries.findIndex((entry) => entry.sourceEntry.id === foldPointId);
		if (foldPointAt < 0) return refuse("the folded work is no longer in the projected context");
		const retainedIds = new Set(
			buildSessionProjection(sm.getEntries(), targetId).entries.map(
				(entry) => entry.sourceEntry.id,
			),
		);
		const openUserRequests = collectOpenUserRequests(
			currentEntries,
			foldPointId,
			retainedIds,
			REWIND_CUSTOM_TYPE,
		);
		const foldEstimateBefore = estimateContentTokens([
			...currentEntries.slice(0, foldPointAt + 1).flatMap((entry) => entry.messages),
			...lateMessages,
		]);
		prospective.push({
			role: "custom" as const,
			customType: REWIND_CUSTOM_TYPE,
			content:
				input.continuationText(requestAccounting(sm, prospective).tokens) +
				renderOpenUserRequests(openUserRequests) +
				(continuity.notice ? `\n\n${continuity.notice}` : "") +
				(lateEntries.length ? `\n\n${buildLateEntriesNote(lateEntries.length)}` : "") +
				`\n\n${REFLECTION_BOOTSTRAP_WARNING_REWIND}`,
			display: true,
			timestamp: Date.now(),
		});
		const foldEstimateAfter = estimateContentTokens(prospective);
		if (foldEstimateAfter >= foldEstimateBefore) {
			const restoresCompacted =
				precedesLatestCompaction(sm.getBranch(), targetId) &&
				estimateContentTokens(projectAtEntry(sm.getEntries(), targetId, all)) >= foldEstimateBefore;
			return refuse(
				restoresCompacted
					? `'${rewindTo}' lies before the latest compaction, so folding to it restores the compacted history instead of reducing projected context (estimated ${foldEstimateBefore} -> ${foldEstimateAfter} tokens); original history was kept`
					: `the materialized handoff does not reduce projected context (estimated ${foldEstimateBefore} -> ${foldEstimateAfter} tokens); original history was kept`,
			);
		}
		const projectedAfterTokens = requestAccounting(sm, prospective).tokens;
		if (
			input.contextWindow > 0 &&
			projectedAfterTokens + RECOVERY_MIN_OUTPUT_TOKENS + RECOVERY_HEADROOM_TOKENS >
				input.contextWindow
		) {
			return refuse(
				"the materialized handoff leaves insufficient request headroom; original history was kept",
			);
		}
		return {
			ok: true,
			projectedAfterTokens,
			foldEstimateBefore,
			foldEstimateAfter,
			oldLeafId,
			materialized,
			details,
			collapsedEntries: entries.length,
			readFiles,
			modifiedFiles,
			lateEntries,
			continuity,
			openUserRequests,
			...(carry && { carriedCompaction: carry }),
		};
	} catch (err) {
		return refuse(
			`the fold could not be prepared (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}
