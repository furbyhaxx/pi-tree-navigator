/** Active-branch wire projection and compaction carry-over. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type SessionEntry,
	type SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { handoffContext } from "../fold/handoff.ts";
import { invalidateStaleUsage, projectHandoffs } from "../fold/handoff-projection.ts";
import { LABEL_PREFIX } from "./helpers.ts";
import {
	collectLegacyRewindOutcomes,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
	withLegacyOutcome,
} from "./legacy-rewind.ts";
import { asInternals, findOwningSession } from "./pi-internals.ts";

/**
 * Project the session tree's active branch into the messages the next LLM
 * call should see — the public-API replacement for the deleted
 * `prepareNextTurn` double-wrap (which rebuilt `messages` from
 * `sessionManager.buildSessionContext()` between every turn).
 *
 * Registered as a `context` extension handler: pi fires the `context` event
 * inside `streamAssistantResponse` before EVERY LLM call (wired through
 * `Agent.transformContext` → `runner.emitContext`), so this projection is
 * applied at the wire boundary itself rather than at a turn-boundary
 * snapshot. The loop's own `currentContext.messages` is never mutated — the
 * handler only replaces the clone that `convertToLlm` consumes.
 *
 * Prefers the canonical `buildSessionProjection().messages` (>= 0.87.0): that
 * is exactly what pi itself treats as the model context, applying
 * `context_edit` omissions/replacements written by pi's own overflow recovery
 * and by extensions such as the fallback provider. Returning the raw
 * `buildContextEntries()` view would reintroduce edited-away messages into the
 * request. The entry walk remains only as a defensive fallback for structural
 * test doubles.
 *
 * The result is CONVERSATION-ONLY: the `context` event contract is "transform
 * conversation messages without prompt and tool system messages; Pi restores
 * that state afterward" (pi docs, `context` section), and `runner.emitContext`
 * hands handlers `currentMessages.filter(role !== "system")` and re-attaches
 * the current head via `restoreSystemMessages`. Returning the projection's
 * system entries would make that re-attach prepend the head to a list still
 * carrying the persisted system entry — a duplicated head on runs where
 * `forceSystemPrompt` is unset.
 *
 * We always replace (no leaf-gating): every `appendMessage` advances the
 * session leaf, so a "leaf changed since last turn" heuristic would fire on
 * essentially every call anyway — and always-replace is byte-for-byte the
 * behavior of the old wrapper (per-turn rebuild from the tree).
 *
 * The parameter is typed structurally because `ReadonlySessionManager` is
 * NOT re-exported from the package barrel (only `SessionManager` and
 * `sessionEntryToContextMessages` are public); `ctx.sessionManager` at the
 * event site is `ReadonlySessionManager`.
 */
export function buildContextMessages(
	sm: {
		buildContextEntries(): SessionEntry[];
		getBranch?(): SessionEntry[];
		getEntries?(): SessionEntry[];
		buildSessionProjection?(): {
			entries?: Array<{ sourceEntry: SessionEntry; messages: AgentMessage[] }>;
			messages: AgentMessage[];
			model?: { provider: string; modelId: string } | null;
		};
		getLabel?(id: string): string | undefined;
	},
	throughId?: string,
): ReturnType<typeof sessionEntryToContextMessages> {
	let entries: Array<{ sourceEntry: SessionEntry | null; messages: AgentMessage[] }> | undefined;
	let model: { provider: string; modelId: string } | null | undefined;
	try {
		if (throughId && typeof sm.getEntries === "function") {
			const projection = buildSessionProjection(sm.getEntries(), throughId);
			model = projection.model;
			entries = Array.isArray(projection.entries)
				? projection.entries
				: [{ sourceEntry: null, messages: projection.messages }];
		} else if (typeof sm.buildSessionProjection === "function") {
			const projection = sm.buildSessionProjection();
			model = projection.model;
			entries = Array.isArray(projection.entries)
				? projection.entries
				: [{ sourceEntry: null, messages: projection.messages }];
		}
	} catch {
		// Fall through to the raw entry projection — pi rewrites the context
		// handlers' output at the wire boundary anyway.
	}
	entries ??= sm.buildContextEntries().map((entry) => ({
		sourceEntry: entry,
		messages: sessionEntryToContextMessages(entry),
	}));
	let legacyOutcomes = new Map<string, string>();
	try {
		if (sm.getBranch) {
			legacyOutcomes = collectLegacyRewindOutcomes(sm.getBranch());
		}
	} catch {
		// Projection-only callers may not expose an active branch.
	}
	// Withholding can append edits after the entries a stale usage covers.
	entries = invalidateStaleUsage(entries, model);
	// Sessions written before the independent engine carry summary
	// instructions of the in-band turn; none is ever written now, and a stale
	// one must not reach the model.
	const messages = entries
		.filter(
			(e) =>
				!(
					e.sourceEntry?.type === "custom_message" &&
					e.sourceEntry.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE
				),
		)
		.flatMap((e) => {
			const legacyOwned =
				e.sourceEntry?.type === "branch_summary" &&
				e.sourceEntry.fromHook === true &&
				sm.getLabel?.(e.sourceEntry.id)?.startsWith(LABEL_PREFIX) === true;
			const messages = withLegacyOutcome(e.messages, legacyOutcomes.get(e.sourceEntry?.id ?? ""));
			return handoffContext(e.sourceEntry, messages, legacyOwned);
		});
	return messages.filter((message) => message.role !== "system");
}

export function findLabeledEntry(sm: SessionManager, fullLabel: string): string | null {
	const path = sm.getBranch();
	for (let i = path.length - 1; i >= 0; i--) {
		if (sm.getLabel(path[i].id) === fullLabel) return path[i].id;
	}
	return null;
}

/**
 * The latest compaction on `branch` that a fold to `targetId` carries
 * forward: the target lies inside its kept range (at or after
 * `firstKeptEntryId`, before the compaction). Branching there drops the
 * compaction from the ancestry, so the fold re-appends a copy.
 */
export function carriedCompaction(
	branch: readonly SessionEntry[],
	targetId: string,
): CompactionEntry | undefined {
	const at = branch.findIndex((entry) => entry.id === targetId);
	const compactionAt = branch.findLastIndex((e) => e.type === "compaction");
	if (at < 0 || compactionAt <= at) return undefined;
	const compaction = branch[compactionAt] as CompactionEntry;
	const keptAt = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	return keptAt >= 0 && keptAt <= at ? compaction : undefined;
}

/**
 * The system checkpoint `appendCompaction` stores on a compaction: projection
 * restarts at a compaction, so a preview without it prices no system prompt.
 */
export function systemCheckpoint(sm: SessionManager): {
	systemMessage?: CompactionEntry["systemMessage"];
} {
	const systemMessage = getCurrentSystemMessage(sm.buildSessionProjection().messages);
	return systemMessage ? { systemMessage } : {};
}

/** An unsaved copy of `compaction` under `parentId`, as `commitFold` appends it. */
export function compactionCopy(
	compaction: CompactionEntry,
	parentId: string,
	taken: ReadonlyMap<string, unknown>,
): CompactionEntry {
	let id = "tree-navigator-carried-compaction";
	while (taken.has(id)) id += "-";
	return {
		...compaction,
		id,
		parentId,
		details: carriedDetails(compaction),
	};
}

export function carriedDetails(compaction: CompactionEntry): unknown {
	const base =
		compaction.details && typeof compaction.details === "object"
			? (compaction.details as Record<string, unknown>)
			: {};
	return { ...base, carriedFrom: compaction.id };
}

/**
 * The messages a branch rooted at `entryId` would carry: what a fold to that
 * entry leaves behind before its handoff is added. `commitFold` projects
 * its preview the same way: a compaction whose kept range holds `entryId` is
 * carried forward, an earlier one only counts when `entryId` lies after it.
 */
export function projectAtEntry(
	entries: SessionEntry[],
	entryId: string,
	byId: Map<string, SessionEntry>,
	carry?: CompactionEntry,
): AgentMessage[] {
	if (!carry) {
		return projectHandoffs(buildSessionProjection(entries, entryId, byId), entries).messages;
	}
	const copy = compactionCopy(carry, entryId, byId);
	const withCopy = [...entries, copy];
	return projectHandoffs(buildSessionProjection(withCopy, copy.id), withCopy).messages;
}

/**
 * Whether `targetId` precedes the latest compaction's kept range on `branch`.
 * A fold there parents its summary before every entry the compaction kept,
 * so the copy cannot be carried and the summarized history would return.
 */
export function precedesLatestCompaction(
	branch: readonly SessionEntry[],
	targetId: string,
): boolean {
	const at = branch.findIndex((entry) => entry.id === targetId);
	return (
		at >= 0 &&
		at < branch.findLastIndex((e) => e.type === "compaction") &&
		!carriedCompaction(branch, targetId)
	);
}

/** The request `messages` as pi will send them: a forced system prompt replaces the head. */
export function effectiveRequestMessages(
	sm: SessionManager,
	messages: AgentMessage[],
): AgentMessage[] {
	const session = findOwningSession(sm);
	const forcedPrompt = session
		? asInternals(session)._runSystemPromptOptions?.forceSystemPrompt
		: undefined;
	if (forcedPrompt === undefined) return messages;
	const currentSystem = getCurrentSystemMessage(messages);
	return [
		{
			role: "system",
			content: forcedPrompt,
			...(currentSystem?.toolsAdded ? { toolsAdded: currentSystem.toolsAdded } : {}),
			timestamp: currentSystem?.timestamp ?? 0,
		},
		...messages.filter((message) => message.role !== "system"),
	];
}

/** The next request on the active branch under the effective system state. */
export function admissionMessages(sm: SessionManager): AgentMessage[] {
	const system = getCurrentSystemMessage(sm.buildSessionContext().messages);
	return effectiveRequestMessages(sm, [...(system ? [system] : []), ...buildContextMessages(sm)]);
}
