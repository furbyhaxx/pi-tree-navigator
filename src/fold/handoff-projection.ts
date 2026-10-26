import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	calculateContextTokens,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { handoffContext } from "./handoff.ts";

/** A projection entry; `sourceEntry` is null for message groups without session provenance. */
export interface UsageEntry {
	readonly sourceEntry: SessionEntry | null;
	readonly messages: AgentMessage[];
}

const BOUNDARY_ENTRIES: ReadonlySet<string> = new Set(["compaction", "model_change"]);

/** A clone of `message` whose assistant usage no longer counts as a context measurement. */
function withoutUsage(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !message.usage || calculateContextTokens(message.usage) === 0)
		return message;
	return {
		...message,
		usage: {
			...message.usage,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		},
	};
}

/** Indices in conversation order; a compaction is listed first but follows the entries it kept. */
function conversationOrder(entries: readonly UsageEntry[]): number[] {
	const order = entries.map((_, index) => index);
	const compaction = entries[0]?.sourceEntry;
	if (compaction?.type !== "compaction") return order;
	const resumed = entries.findIndex(
		(entry, index) => index > 0 && entry.sourceEntry?.parentId === compaction.id,
	);
	const keptEnd = resumed < 0 ? entries.length : resumed;
	return [...order.slice(1, keptEnd), 0, ...order.slice(keptEnd)];
}

/** Per entry: whether it lies from an edited entry (inclusive) up to the context edit that changed it. */
function editedBeforeApplied(entries: readonly UsageEntry[], order: readonly number[]): boolean[] {
	const rank: number[] = [];
	for (const [at, index] of order.entries()) rank[index] = at;
	const position = new Map<string, number>();
	for (const [index, { sourceEntry }] of entries.entries())
		if (sourceEntry && !position.has(sourceEntry.id)) position.set(sourceEntry.id, index);
	const delta = order.map(() => 0);
	delta.push(0);
	for (const [index, { sourceEntry }] of entries.entries()) {
		if (sourceEntry?.type !== "context_edit") continue;
		const target = position.get(sourceEntry.targetId);
		if (target === undefined) continue;
		const from = rank[target];
		const to = Math.max(rank[index], from + 1);
		delta[from]++;
		delta[to]--;
	}
	let open = 0;
	const stale = entries.map(() => false);
	for (const [at, index] of order.entries()) {
		open += delta[at];
		stale[index] = open > 0;
	}
	return stale;
}

/**
 * Zero recorded assistant usage that no longer measures the current context:
 * anything before a later compaction, model change or system message; the span
 * from an edited entry up to its context edit (the edited entry included); and
 * any assistant from another provider/model than `model`. Usage before the edited
 * entry stays exact. Only changed messages are cloned, so persisted usage and
 * cost stay unchanged.
 */
export function invalidateStaleUsage<T extends UsageEntry>(
	entries: readonly T[],
	model?: SessionProjection["model"],
): T[] {
	const order = conversationOrder(entries);
	const edited = editedBeforeApplied(entries, order);
	const result = [...entries];
	let boundaryFollows = false;
	for (const index of order.reverse()) {
		const entry = entries[index];
		const source = entry.sourceEntry;
		if (source && BOUNDARY_ENTRIES.has(source.type)) boundaryFollows = true;
		let messages: AgentMessage[] | undefined;
		for (let i = entry.messages.length - 1; i >= 0; i--) {
			const message = entry.messages[i];
			if (message.role === "system") boundaryFollows = true;
			else if (
				message.role === "assistant" &&
				(boundaryFollows ||
					edited[index] ||
					(model && (message.provider !== model.provider || message.model !== model.modelId)))
			) {
				const cleared = withoutUsage(message);
				if (cleared === message) continue;
				messages ??= [...entry.messages];
				messages[i] = cleared;
			}
		}
		if (messages) result[index] = { ...entry, messages };
	}
	return result;
}

/** Project work handoffs and invalidate stale context measurements without changing accounting. */
export function projectHandoffs(
	projection: SessionProjection,
	entries: readonly SessionEntry[],
): SessionProjection {
	const provenance = entries.findLast(
		(entry) => entry.type === "custom" && entry.customType === "tree-clone-provenance",
	);
	let originalIds: readonly unknown[] = [];
	if (
		provenance?.type === "custom" &&
		typeof provenance.data === "object" &&
		provenance.data !== null &&
		"history" in provenance.data
	) {
		const history = provenance.data.history;
		if (
			typeof history === "object" &&
			history !== null &&
			"sourceOrder" in history &&
			Array.isArray(history.sourceOrder)
		)
			originalIds = history.sourceOrder;
	}
	const historical = new Set(originalIds);
	const projected = invalidateStaleUsage(
		projection.entries.map((entry) => {
			const messages = handoffContext(entry.sourceEntry, entry.messages);
			return {
				...entry,
				messages: historical.has(entry.sourceEntry.id) ? messages.map(withoutUsage) : messages,
			};
		}),
		projection.model,
	);
	return {
		...projection,
		entries: projected,
		messages: projected.flatMap((entry) => entry.messages),
	};
}

const originalKey = Symbol.for("pi-tree-navigator.session-projection.original");
type ProjectionMethod = SessionManager["buildSessionProjection"] & {
	[originalKey]?: SessionManager["buildSessionProjection"];
};

/** Patch the shared host manager so native pre-request estimation sees the same safe projection. */
export function installHandoffProjection(): () => void {
	const previous: ProjectionMethod = SessionManager.prototype.buildSessionProjection;
	const original = previous[originalKey] ?? previous;
	const replacement: ProjectionMethod = function (this: SessionManager) {
		return projectHandoffs(original.call(this), this.getEntries());
	};
	replacement[originalKey] = original;
	SessionManager.prototype.buildSessionProjection = replacement;
	return () => {
		if (SessionManager.prototype.buildSessionProjection === replacement)
			SessionManager.prototype.buildSessionProjection = original;
	};
}

/** Restore the host's unpatched projection, whichever installation is current. */
export function resetHandoffProjection(): void {
	const current: ProjectionMethod = SessionManager.prototype.buildSessionProjection;
	SessionManager.prototype.buildSessionProjection = current[originalKey] ?? current;
}
