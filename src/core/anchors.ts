/** Active anchors, label hints and pinned-file helpers. */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { sha256 } from "../retrospective/retrospective-plan.ts";
import {
	type AnchorTableRow,
	extractTextContent,
	formatAnchorTable,
	formatPct1,
	isValidName,
	LABEL_PREFIX,
	MAX_NAME_LENGTH,
	stripBranchSummaryBoilerplate,
	toOneLine,
} from "./helpers.ts";
import { findLabeledEntry, precedesLatestCompaction } from "./projection.ts";
import { estimateAtEntry } from "./request-accounting.ts";

// Cap on parentId chain walks in `findLabelHint` (UX preview only;
// no need to walk to the root for a 50-char snippet).
export const MAX_HINT_WALK_DEPTH = 50;

// Hint length cap for the per-row hint shown in `list` output. 50 chars
// fits one terminal column without wrapping in typical 80-column TUIs.
const LIST_HINT_MAX_LENGTH = 50;

/** Larger files are pinned without a hash rather than read whole. */
const PIN_HASH_MAX_BYTES = 2 * 1024 * 1024;

/** The anchors on the active branch, root → leaf, with the context footprint at each. */
export function collectActiveAnchors(sm: SessionManager): {
	name: string;
	tokens: number;
	beforeCompaction: boolean;
	hint: string | null;
}[] {
	const path = sm.getBranch();
	const allEntries = sm.getEntries();
	const byId = new Map<string, SessionEntry>();
	for (const e of allEntries) byId.set(e.id, e);
	const anchors: ReturnType<typeof collectActiveAnchors> = [];
	for (const e of path) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		anchors.push({
			name: lbl.slice(LABEL_PREFIX.length),
			tokens: estimateAtEntry(sm, allEntries, e.id, byId),
			beforeCompaction: precedesLatestCompaction(path, e.id),
			hint: findLabelHint(sm, e.id, LIST_HINT_MAX_LENGTH),
		});
	}
	return anchors;
}

/** Anchor names on the active branch, root → leaf, as `list` shows them. */
export function activeAnchorNames(sm: SessionManager): string[] {
	const names: string[] = [];
	for (const e of sm.getBranch()) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		const name = lbl.slice(LABEL_PREFIX.length);
		if (isValidName(name)) names.push(name);
	}
	return names;
}

export const isFilled = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

/** sha256 of a pinned file; undefined when it is unreadable or too large. */
export async function hashPinnedFile(cwd: string, path: string): Promise<string | undefined> {
	try {
		const file = resolve(cwd, path);
		if ((await stat(file)).size > PIN_HASH_MAX_BYTES) return undefined;
		return sha256(await readFile(file));
	} catch {
		return undefined;
	}
}

/** What stops a new anchor: shared by the tool's `anchor` action and `/anchor`. */
export type AnchorTarget =
	| { ok: true; leafId: string; fullLabel: string }
	| { ok: false; problem: "invalid-name" | "no-leaf" | "duplicate" };

export function resolveAnchorTarget(sm: SessionManager, name: unknown): AnchorTarget {
	if (!isValidName(name)) return { ok: false, problem: "invalid-name" };
	const leafId = sm.getLeafId();
	if (!leafId) return { ok: false, problem: "no-leaf" };
	// Labels are unique on the active branch (issue #55, C8): an
	// existing label is never moved or overwritten, and the caller
	// must pick a fresh name. Manual `/tree` duplicates are the only
	// duplicate path; move-on-collision is retired for both writers.
	const fullLabel = LABEL_PREFIX + name;
	if (findLabeledEntry(sm, fullLabel)) return { ok: false, problem: "duplicate" };
	return { ok: true, leafId, fullLabel };
}

/** A fresh `newLabel` suggestion for folding to `anchorName`. */
export function suggestFoldLabel(sm: SessionManager, anchorName: string): string {
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? "-folded" : `-folded-${n}`;
		const base = anchorName.slice(0, MAX_NAME_LENGTH - suffix.length);
		const candidate = base.replace(/-+$/, "") + suffix;
		if (!findLabeledEntry(sm, LABEL_PREFIX + candidate)) return candidate;
	}
}

/**
 * Every active anchor — chronological root→leaf, same walk order as `list`
 * — with its cumulative context percentage, rendered as the shared anchor
 * table (#101, D19). Shared by min-savings rejections and rewind hints.
 * A manual
 * `/tree` label `anchor:x` CAN put the same name on two entries —
 * duplicates print twice, exactly as `list` prints them. Names `rewindTo`
 * would reject (e.g. an empty `anchor:` label) are skipped: both callers
 * point the model at rewind targets.
 */
export function formatActiveAnchors(
	sm: SessionManager,
	cw: number,
	allEntries: SessionEntry[],
	byId: Map<string, SessionEntry>,
): { names: string[]; text: string } {
	const names: string[] = [];
	const rows: AnchorTableRow[] = [];
	const branch = sm.getBranch();
	for (const e of branch) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		const name = lbl.slice(LABEL_PREFIX.length);
		if (!isValidName(name)) continue;
		names.push(name);
		rows.push({
			pct: formatPct1(estimateAtEntry(sm, allEntries, e.id, byId), cw),
			name,
		});
	}
	// cw=0 → percents fall back to formatPct1's k-format and the header
	// drops the window, mirroring `list`.
	return { names, text: formatAnchorTable(rows, cw) };
}

/**
 * Rejection copy for the rewind min-savings floor (#21). Reports the
 * apparent savings plus every active anchor (including rewindTo itself)
 * with its cumulative context percentage, so the agent can pick a
 * genuinely earlier anchor or keep working.
 *
 * Deliberately does NOT print the floor value anywhere: an agent-visible
 * numeric bar invites grinding up to it instead of doing real work.
 */
export function buildMinSavingsRejection(
	rewindTo: string,
	newLabel: string,
	apparentSavings: number,
	sm: SessionManager,
	cw: number,
	allEntries: SessionEntry[],
	byId: Map<string, SessionEntry>,
	beforeCompaction: boolean,
): string {
	const anchors = formatActiveAnchors(sm, cw, allEntries, byId);
	if (beforeCompaction) {
		const outcome =
			apparentSavings > 0
				? `free only ~${formatPct1(apparentSavings, 0)} tokens`
				: "not free any context";
		return `Rewinding to '${rewindTo}' (as '${newLabel}') would ${outcome}: '${rewindTo}' lies before the latest compaction, so a fold there restores the compacted history. Rewind to an anchor created after the compaction, or keep working.\n${anchors.text}`;
	}
	const guidance =
		anchors.names[0] === rewindTo
			? "No earlier anchors — keep working and rewind later once more has accumulated above it."
			: "Rewind further back to actually free context, or keep working.";
	return `Rewinding to '${rewindTo}' (as '${newLabel}') would free only ~${formatPct1(apparentSavings, 0)} tokens. ${guidance}\n${anchors.text}`;
}

/**
 * Walk parentId chain back from `fromId` and return a one-line preview of
 * the first entry that has meaningful text content. Branch summaries are
 * prefixed with `summary:` so the source is clear; user/assistant text is
 * shown as-is.
 */
export function findLabelHint(sm: SessionManager, fromId: string, maxLen: number): string | null {
	let cur: string | null | undefined = fromId;
	let depth = 0;
	while (cur && depth < MAX_HINT_WALK_DEPTH) {
		const e = sm.getEntry(cur);
		if (!e) break;
		let text = "";
		let prefix = "";
		if (e.type === "branch_summary" && e.summary) {
			text = stripBranchSummaryBoilerplate(e.summary);
			prefix = "summary: ";
		} else if (e.type === "message") {
			const role = e.message.role;
			if (role === "user" || role === "assistant") {
				text = extractTextContent(e.message.content);
			}
		} else if (e.type === "custom_message") {
			text = extractTextContent(e.content);
		}
		const oneLine = toOneLine(text, maxLen - prefix.length);
		if (oneLine) return prefix + oneLine;
		cur = e.parentId;
		depth++;
	}
	return null;
}
