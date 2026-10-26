/**
 * Read-only compatibility with sessions written by the removed in-band rewind.
 *
 * Those sessions carry summary-request custom messages and rewind-outcome custom
 * entries. Nothing writes either type any more; this module only projects and
 * renders what is already on disk.
 */
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatPct1, formatWindow } from "./helpers.ts";

/** The summary instruction of the in-band turn; hidden from the model, rendered as one row. */
export const LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE = "navigate-tree-summary-request";

/** How an in-band rewind failed or was aborted; it rewrote its tool result. */
export const LEGACY_REWIND_OUTCOME_CUSTOM_TYPE = "navigate-tree-rewind-outcome";

export function sanitizeLegacyText(text: string): string {
	return stripVTControlCharacters(text).replace(/\p{Cc}/gu, (control) =>
		control === "\n" ? "\n" : " ",
	);
}

const oneLine = (value: unknown, fallback: string): string =>
	sanitizeLegacyText(String(value ?? fallback))
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();

const rowPrefix = (rewindTo: unknown, newLabel: unknown): string =>
	`[rewind to '${oneLine(rewindTo, "?")}' · collapse as '${oneLine(newLabel, "?")}']`;

const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** The one-line row of a historical summary request. */
export function legacySummaryRequestRow(details: unknown): string {
	const d = (details ?? {}) as Record<string, unknown>;
	const before = count(d.contextBefore);
	const target = count(d.tokensAtTarget);
	const window = count(d.contextWindow);
	const delta =
		window > 0
			? `context ${formatPct1(before, window)} → ~${formatPct1(target, window)} of ${formatWindow(window)}`
			: `tokens ${before} → ~${target}`;
	return `${rowPrefix(d.rewindTo, d.newLabel)} · summary requested · ${delta}`;
}

/** The one-line row of a historical failed or aborted rewind, or undefined for any other data. */
export function legacyRewindOutcomeRow(data: unknown): string | undefined {
	const d = (data ?? {}) as Record<string, unknown>;
	if (d.status !== "failed" && d.status !== "aborted") return undefined;
	const middle = d.status === "aborted" ? "aborted" : `failed: ${oneLine(d.reason, "")}`;
	return `${rowPrefix(d.rewindTo, d.newLabel)} · ${middle} · nothing collapsed`;
}

/** Tool-result entry id → the text its failed or aborted rewind left, for the active branch. */
export function collectLegacyRewindOutcomes(branch: readonly SessionEntry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== LEGACY_REWIND_OUTCOME_CUSTOM_TYPE) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (
			typeof data?.toolResultEntryId === "string" &&
			typeof data.text === "string" &&
			(data.status === "failed" || data.status === "aborted")
		)
			out.set(data.toolResultEntryId, data.text);
	}
	return out;
}

/**
 * A failed historical rewind reads as a failed tool call. `context_edit` already
 * replaced its content on disk, but `isError` is not editable, so the projection
 * sets it on a copy and never mutates the session's own message.
 */
export function withLegacyOutcome(
	messages: AgentMessage[],
	text: string | undefined,
): AgentMessage[] {
	if (text === undefined) return messages;
	return messages.map((message) =>
		message.role === "toolResult"
			? {
					...message,
					content: [{ type: "text" as const, text }],
					isError: true,
				}
			: message,
	);
}
