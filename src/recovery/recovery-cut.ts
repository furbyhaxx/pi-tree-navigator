/** Safe recovery cuts and preservation of input arriving during a fold. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection,
	type SessionEntry,
	type SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { REWIND_HINT_CUSTOM_TYPE } from "../core/rewind-hint.ts";
import { REWIND_CUSTOM_TYPE } from "../fold/fold-receipts.ts";

/**
 * Why a fold no longer matches the active branch, or `null`. The fold point
 * (`afterEntryId`) must still be on the branch, and no compaction may have
 * landed after it: one landing during the summary would leave the summarized
 * evidence out of step with the raw segment.
 */
export function rewindStaleReason(sm: SessionManager, afterEntryId: string): string | null {
	let branch: SessionEntry[];
	try {
		branch = sm.getBranch();
	} catch {
		return null;
	}
	const start = branch.findIndex((e) => e.id === afterEntryId);
	if (start < 0) return "the folded work is no longer on the active branch";
	return branch.slice(start + 1).some((e) => e.type === "compaction")
		? "the context was compacted"
		: null;
}

/**
 * Entries that arrived on the active branch after `afterEntryId` (the fold
 * point) from outside the conversation's own
 * turns: user messages (steers drained at the rewind turn's boundary) and
 * other extensions' custom messages (subagent results, timers). Oldest
 * first; this extension's own rewind and rewind-hint messages are excluded
 * (a pre-rewind rewind hint is stale once it lands).
 */
export type LateEntry =
	| {
			kind: "user" | "assistant";
			message: Extract<SessionEntry, { type: "message" }>["message"];
	  }
	| {
			kind: "custom";
			customType: string;
			content: Extract<SessionEntry, { type: "custom_message" }>["content"];
			display: boolean;
			details: unknown;
	  };

function isPreservedLateEntry(entry: SessionEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user") return true;
	return (
		entry.type === "custom_message" &&
		entry.customType !== REWIND_CUSTOM_TYPE &&
		entry.customType !== REWIND_HINT_CUSTOM_TYPE
	);
}

function toolEnvelopeIds(message: AgentMessage): {
	calls: string[];
	result?: string;
} {
	if (message.role === "toolResult") {
		return { calls: [], result: message.toolCallId };
	}
	if (message.role !== "assistant") return { calls: [] };
	return {
		calls: message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
	};
}

/** Read-only fold boundary in the current canonical context, preserving unanswered input. */
export function recoveryCutOf(
	sm: SessionManager,
	incompleteReplyId?: string,
): { ok: true; foldPointId: string } | { ok: false; detail: string } {
	try {
		const allEntries = sm.getEntries();
		const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
		const order = new Map(allEntries.map((entry, index) => [entry.id, index]));
		const projection = buildSessionProjection(allEntries, sm.getLeafId(), byId);
		const occurrence = (entryId: string, callId: string) => JSON.stringify([entryId, callId]);
		const archived = new Map<string, Set<string>>();
		const visiting = new Set<string>();
		// A summary can discharge only the exact occurrence completed on its fromId ancestry.
		const completedThrough = (leafId: string): Set<string> => {
			const cached = archived.get(leafId);
			if (cached) return cached;
			if (visiting.has(leafId)) throw new Error("cyclic summary history");
			visiting.add(leafId);
			const path: SessionEntry[] = [];
			const seen = new Set<string>();
			let id: string | null = leafId;
			while (id !== null) {
				if (seen.has(id)) throw new Error("cyclic session history");
				seen.add(id);
				const entry = byId.get(id);
				if (!entry) throw new Error("missing summary history");
				path.push(entry);
				id = entry.parentId;
			}
			const pending = new Map<string, string>();
			const completed = new Set<string>();
			for (const entry of path.reverse()) {
				if (entry.type === "branch_summary" && entry.fromId !== "root") {
					const evidence = completedThrough(entry.fromId);
					for (const [callId, key] of pending) {
						if (!evidence.has(key)) continue;
						pending.delete(callId);
						completed.add(key);
					}
				}
				for (const message of sessionEntryToContextMessages(entry)) {
					const envelope = toolEnvelopeIds(message);
					for (const callId of envelope.calls) {
						if (pending.has(callId)) throw new Error("duplicate outstanding archived tool call");
						pending.set(callId, occurrence(entry.id, callId));
					}
					if (envelope.result !== undefined) {
						const key = pending.get(envelope.result);
						if (!key) throw new Error("orphan archived tool result");
						pending.delete(envelope.result);
						completed.add(key);
					}
				}
			}
			visiting.delete(leafId);
			archived.set(leafId, completed);
			return completed;
		};

		const pending = new Map<string, string>();
		let foldPointId: string | undefined;
		let unansweredInput = false;
		// Native projection places the compaction before its older retained messages.
		const chronological = projection.entries.toSorted(
			(a, b) => (order.get(a.sourceEntry.id) ?? -1) - (order.get(b.sourceEntry.id) ?? -1),
		);
		for (const { sourceEntry, messages } of chronological) {
			if (messages.length === 0 || sourceEntry.id === incompleteReplyId) continue;
			if (isPreservedLateEntry(sourceEntry)) unansweredInput = true;
			if (
				pending.size > 0 &&
				sourceEntry.type === "branch_summary" &&
				sourceEntry.fromId !== "root"
			) {
				const evidence = completedThrough(sourceEntry.fromId);
				for (const [callId, key] of pending) {
					if (evidence.has(key)) pending.delete(callId);
				}
			}
			for (const message of messages) {
				const envelope = toolEnvelopeIds(message);
				for (const callId of envelope.calls) {
					if (pending.has(callId)) throw new Error("duplicate outstanding tool call");
					pending.set(callId, occurrence(sourceEntry.id, callId));
				}
				if (envelope.result !== undefined) {
					if (unansweredInput) throw new Error("tool result crosses unanswered input");
					if (!pending.delete(envelope.result)) throw new Error("tool result without its call");
				}
				if (
					(message.role === "assistant" &&
						message.stopReason !== "error" &&
						message.stopReason !== "aborted") ||
					message.role === "toolResult" ||
					sourceEntry.type === "branch_summary"
				) {
					foldPointId = sourceEntry.id;
					unansweredInput = false;
				} else if (sourceEntry.type === "compaction" && !unansweredInput) {
					foldPointId = sourceEntry.id;
				}
			}
		}
		if (pending.size) throw new Error("tool call without its result");
		if (!foldPointId) {
			return {
				ok: false,
				detail: "the active context has no completed work to fold",
			};
		}
		return { ok: true, foldPointId };
	} catch (error) {
		return {
			ok: false,
			detail: `the recovery cut is unsafe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function collectLateEntries(
	sm: SessionManager,
	afterEntryId: string,
	recoveryEvidenceId?: string,
): LateEntry[] {
	let branch: SessionEntry[];
	try {
		branch = sm.getBranch();
	} catch {
		return [];
	}
	const start = branch.findIndex((e) => e.id === afterEntryId);
	if (start < 0) return [];
	const late: LateEntry[] = [];
	for (const entry of branch.slice(start + 1)) {
		if (
			entry.id === recoveryEvidenceId &&
			entry.type === "message" &&
			entry.message.role === "assistant"
		) {
			// Replayed evidence is neither a fresh usage baseline nor a second billed call.
			late.push({
				kind: "assistant",
				message: {
					...entry.message,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				},
			});
			continue;
		}
		if (!isPreservedLateEntry(entry)) continue;
		if (entry.type === "message" && entry.message.role === "user") {
			late.push({ kind: "user", message: entry.message });
		} else if (entry.type === "custom_message") {
			late.push({
				kind: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
			});
		}
	}
	return late;
}
