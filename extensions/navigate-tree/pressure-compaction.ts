/**
 * Where a tail-keeping pressure compaction cuts the projection.
 *
 * Pure: the host measures the projected entries and decides whether the
 * compaction it writes frees enough context. The cut keeps at least
 * `keepRecentTokens` of the newest projected work verbatim and never separates
 * a tool call from its result.
 */

/** One projected entry, in projection order (a previous compaction summary first). */
export interface PressureCutEntry {
	entryId: string;
	/** Estimated tokens of this entry as projected, system messages excluded. */
	tokens: number;
	/** Roles of its projected messages in order; empty for entries without messages. */
	roles: readonly string[];
	toolCallIds: readonly string[];
	toolResultIds: readonly string[];
}

export type PressureCut =
	| {
			kind: "cut";
			/** First entry kept verbatim: the compaction's `firstKeptEntryId`. */
			firstKeptEntryId: string;
			keptTokens: number;
			/** Tokens the compaction summarizes. */
			prefixTokens: number;
	  }
	| {
			kind: "skip";
			reason: "within-recent" | "no-safe-cut";
			detail: string;
	  };

/** Pick the newest safe cut that keeps at least `keepRecentTokens` verbatim. */
export function planPressureCut(input: {
	entries: readonly PressureCutEntry[];
	keepRecentTokens: number;
}): PressureCut {
	const { entries, keepRecentTokens } = input;
	const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
	let suffix = 0;
	let want = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix += entries[i].tokens;
		if (suffix >= keepRecentTokens) {
			want = i;
			break;
		}
	}
	if (want <= 0)
		return {
			kind: "skip",
			reason: "within-recent",
			detail: `the ${total}-token conversation is within the ${keepRecentTokens} tokens kept verbatim`,
		};

	// A result at r answering a call at c < r forbids every cut in (c, r].
	const callAt = new Map<string, number>();
	entries.forEach((entry, index) => {
		for (const id of entry.toolCallIds) if (!callAt.has(id)) callAt.set(id, index);
	});
	const split = new Array<number>(entries.length + 1).fill(0);
	entries.forEach((entry, r) => {
		for (const id of entry.toolResultIds) {
			const c = callAt.get(id);
			if (c === undefined || c >= r) continue;
			split[c + 1] += 1;
			split[r + 1] -= 1;
		}
	});
	let open = 0;
	const separates = split.slice(0, entries.length).map((delta) => {
		open += delta;
		return open > 0;
	});

	for (let j = want; j >= 1; j--) {
		const first = entries[j].roles[0];
		if (first === undefined || first === "toolResult" || separates[j]) continue;
		const keptTokens = entries.slice(j).reduce((sum, entry) => sum + entry.tokens, 0);
		return {
			kind: "cut",
			firstKeptEntryId: entries[j].entryId,
			keptTokens,
			prefixTokens: total - keptTokens,
		};
	}
	return {
		kind: "skip",
		reason: "no-safe-cut",
		detail: `no message boundary older than the newest ${keepRecentTokens} tokens keeps every tool call with its result`,
	};
}
