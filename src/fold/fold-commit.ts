/** Fold persistence, rollback and shared cursor safety state. */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FoldContinuity } from "../continuity/continuity-store.ts";
import { type OpenUserRequest, renderOpenUserRequests } from "../continuity/open-user-requests.ts";
import { BRANCH_LABEL_PREFIX, LABEL_PREFIX } from "../core/helpers.ts";
import {
	emitSessionTree,
	REFLECTION_BOOTSTRAP_WARNING_REWIND,
	refreshAgentMessages,
} from "../core/pi-internals.ts";
import { carriedDetails } from "../core/projection.ts";
import { estimateAdmissionTokens } from "../core/request-accounting.ts";
import { persistedOnDisk, trySessionWrite } from "../core/session-write.ts";
import { type FoldPreviewInput, previewFoldCommit } from "./fold-preview.ts";
import { buildLateEntriesNote } from "./fold-receipts.ts";

/** What the commit stage of a fold needs; the caller owns the summary and its own bookkeeping. */
export interface FoldCommitInput extends FoldPreviewInput {
	/** Synchronous label write; false when it failed. */
	writeLabel(entryId: string, label: string | undefined): boolean;
}

/** `ok: false` writes nothing; the session is as the caller found it. */
export type FoldCommitOutcome =
	| { ok: false; reason: string }
	| {
			ok: true;
			summaryId: string;
			oldLeafId: string | null;
			collapsedEntries: number;
			afterTokens: number;
			foldEstimateBefore: number;
			foldEstimateAfter: number;
			/** Late entries re-appended after the summary. */
			reappended: number;
			refreshed: boolean;
			historyRewriteNotified: boolean;
			readFiles: string[];
			modifiedFiles: string[];
			/** The message that tells the model the fold landed. */
			continuation: string;
			openUserRequests: OpenUserRequest[];
			continuityNotice?: string;
			continuityReport?: FoldContinuity["report"];
	  };

export const unrestoredFoldCursors = new WeakSet<SessionManager>();

/**
 * The commit stage of a fold: preview it (`previewFoldCommit`), then branch
 * from the target, label, re-append late input, refresh the agent and emit
 * `session_tree`. Throws only before anything is written; every step after the
 * branch is guarded.
 */
export async function commitFold(
	sm: SessionManager,
	input: FoldCommitInput,
): Promise<FoldCommitOutcome> {
	if (unrestoredFoldCursors.has(sm)) {
		return {
			ok: false,
			reason:
				"A previous fold could not restore the session cursor. Persistence remains uncertain; reload the session before another fold.",
		};
	}
	const preview = previewFoldCommit(sm, input);
	if (!preview.ok) return preview;
	const {
		oldLeafId,
		materialized,
		details,
		collapsedEntries,
		readFiles,
		modifiedFiles,
		lateEntries,
		continuity,
		openUserRequests,
		foldEstimateBefore,
		foldEstimateAfter,
		carriedCompaction: carry,
	} = preview;
	const { targetId, newLabel, branchLabelEntryId } = input;
	const previousLabel = branchLabelEntryId ? sm.getLabel(branchLabelEntryId) : undefined;
	const labelWrite = (entryId: string, label: string | undefined) =>
		trySessionWrite(sm, () => {
			if (!input.writeLabel(entryId, label)) {
				throw new Error("label write failed");
			}
		});
	const refuseWrite = (step: string, error: unknown): FoldCommitOutcome => {
		let cursorRestored = false;
		try {
			if (oldLeafId === null) sm.resetLeaf();
			else sm.branch(oldLeafId);
			cursorRestored = sm.getLeafId() === oldLeafId;
		} catch {
			// No append is safe until the original cursor has been restored.
		}
		let restorationAppended = false;
		if (cursorRestored) {
			const restoration = branchLabelEntryId
				? labelWrite(branchLabelEntryId, previousLabel)
				: trySessionWrite(sm, () =>
						sm.appendCustomEntry("navigate-tree-fold-restoration", {
							oldLeafId,
							newLabel,
						}),
					);
			restorationAppended = restoration.ok;
			cursorRestored = restoration.ok || restoration.cursorRestored;
		}
		if (cursorRestored) unrestoredFoldCursors.delete(sm);
		else unrestoredFoldCursors.add(sm);
		refreshAgentMessages(sm);
		return {
			ok: false,
			reason: `${step} (${error instanceof Error ? error.message : String(error)}). ${
				cursorRestored
					? "Original active branch restored in memory."
					: "Original active branch could not be restored in memory."
			} ${
				restorationAppended
					? "A restoration append succeeded."
					: "No restoration append succeeded; durable rollback and completion-marker restoration are not confirmed."
			} Persistence remains uncertain after the write failure; original archived entries were retained. Stop and inspect the session before continuing.`,
		};
	};
	// An unrelated existing label must remain addressable on the archived branch.
	if (branchLabelEntryId && previousLabel === undefined) {
		const marker = labelWrite(branchLabelEntryId, BRANCH_LABEL_PREFIX + newLabel);
		if (!marker.ok) return refuseWrite("the completion marker could not be written", marker.error);
	}
	const branch = trySessionWrite(sm, () =>
		sm.branchWithSummary(targetId, materialized, details, true),
	);
	if (!branch.ok) return refuseWrite("the branch could not be written", branch.error);
	const summaryId = branch.value;
	const label = labelWrite(summaryId, LABEL_PREFIX + newLabel);
	if (!label.ok) return refuseWrite("the summary label could not be written", label.error);
	if (carry) {
		const carried = trySessionWrite(sm, () =>
			sm.appendCompaction(
				carry.summary,
				carry.firstKeptEntryId,
				carry.tokensBefore,
				carriedDetails(carry),
				carry.fromHook,
			),
		);
		if (!carried.ok)
			return refuseWrite("the carried compaction could not be written", carried.error);
	}
	// Direct appends, not the steer queue: no second pass through other
	// extensions' input handlers, and anything still queued is delivered
	// after these, keeping the original order.
	let reappended = 0;
	for (const late of lateEntries) {
		const appended = trySessionWrite(sm, () => {
			if (late.kind !== "custom") {
				sm.appendMessage(late.message as Parameters<SessionManager["appendMessage"]>[0]);
			} else {
				sm.appendCustomMessageEntry(
					late.customType,
					late.content as Parameters<SessionManager["appendCustomMessageEntry"]>[1],
					late.display,
					late.details,
				);
			}
		});
		if (!appended.ok) {
			// Another wrapper can throw after this append reached the file. Keep a
			// write that is durably there; refuse one that only reached memory.
			const matched = (appended.appended ?? []).filter((entry) =>
				late.kind === "custom"
					? entry.type === "custom_message" && entry.customType === late.customType
					: entry.type === "message" &&
						entry.message.role === (late.message as { role?: string }).role,
			);
			const landed =
				matched.length > 0 &&
				persistedOnDisk(
					sm,
					matched.map((entry) => entry.id),
				);
			if (!landed) return refuseWrite("late input could not be written", appended.error);
			// Re-branch to the landed entry: the restored cursor would drop it.
			const keep = appended.appended.at(-1)?.id;
			try {
				if (keep) sm.branch(keep);
			} catch {
				return refuseWrite("late input could not be kept", appended.error);
			}
		}
		reappended++;
	}
	// The branch has landed: every step below is guarded so the
	// continuation always reaches the model.
	let afterTokens = 0;
	try {
		afterTokens = estimateAdmissionTokens(sm);
	} catch {
		afterTokens = 0;
	}
	const refreshed = refreshAgentMessages(sm);
	const historyRewriteNotified = await emitSessionTree(sm, oldLeafId, summaryId);
	return {
		ok: true,
		summaryId,
		oldLeafId,
		collapsedEntries,
		afterTokens,
		foldEstimateBefore,
		foldEstimateAfter,
		reappended,
		refreshed,
		historyRewriteNotified,
		readFiles,
		modifiedFiles,
		openUserRequests,
		continuation:
			input.continuationText(afterTokens) +
			renderOpenUserRequests(openUserRequests) +
			(continuity.notice ? `\n\n${continuity.notice}` : "") +
			(reappended > 0 ? `\n\n${buildLateEntriesNote(reappended)}` : "") +
			(refreshed ? "" : `\n\n${REFLECTION_BOOTSTRAP_WARNING_REWIND}`),
		...(continuity.notice && { continuityNotice: continuity.notice }),
		...(continuity.report && { continuityReport: continuity.report }),
	};
}
