/**
 * Branch-local persistence of the Session Continuity Ledger.
 *
 * Between folds the ledger is the replay of `navigate-tree-continuity-ops`
 * custom entries on the active branch (never sent to the model). A fold stores
 * the reconciled snapshot on `branch_summary.details[LEDGER_DETAILS_KEY]`; the
 * snapshot already includes everything from the abandoned span, so on replay it
 * replaces the running ledger. Ops entries on an abandoned branch are not on
 * the active one, which is why the snapshot is the carrier.
 *
 * Pure functions over session entries, except `appendOpsEntry`.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	extractContinuityDelta,
	isVisible,
	renderBriefing,
	type UserEntryRef,
} from "./continuity-briefing.ts";
import {
	applyOps,
	type ContinuityDelta,
	capText,
	createLedger,
	ITEM_ORIGINS,
	type ItemOrigin,
	LEDGER_DETAILS_KEY,
	type Ledger,
	type LedgerOp,
	parseLedger,
	reconcileFold,
	serializeLedger,
} from "./continuity-ledger.ts";

export const CONTINUITY_OPS_CUSTOM_TYPE = "navigate-tree-continuity-ops";

/** Token budget of the briefing embedded in a fold's handoff. */
export const FOLD_BRIEFING_MAX_TOKENS = 2500;

/** An op as persisted; the context keeps only its serializable fields. */
export interface StoredOp {
	readonly op: LedgerOp;
	readonly ctx: { readonly origin: ItemOrigin; readonly entryId?: string };
}

/** `data` of a `navigate-tree-continuity-ops` entry. */
export interface ContinuityOpsData {
	readonly ops: readonly StoredOp[];
	/** Capture cursor: the last session entry the ops were derived from. */
	readonly watermark?: string;
}

export interface BranchLedger {
	readonly ledger: Ledger;
	/** Last watermark in an ops entry after the last snapshot. */
	readonly watermark?: string;
	/** Entries that could not be applied; the previous ledger was kept. */
	readonly warnings: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isUserMessage = (entry: SessionEntry): boolean =>
	entry.type === "message" && entry.message.role === "user";

/**
 * Resolver the ledger's citation check needs: the position of a user message
 * entry on `branch`, or undefined for a non-user or unknown id.
 */
export function userEntryIndexOf(
	branch: readonly SessionEntry[],
): (entryId: string) => number | undefined {
	const positions = new Map<string, number>();
	branch.forEach((entry, index) => {
		if (isUserMessage(entry)) positions.set(entry.id, index);
	});
	return (entryId) => positions.get(entryId);
}

function parseOpsData(data: unknown): ContinuityOpsData {
	if (!isRecord(data) || !Array.isArray(data.ops)) {
		throw new Error("expected { ops: [...] }");
	}
	if (data.watermark !== undefined && typeof data.watermark !== "string") {
		throw new Error("watermark must be a string");
	}
	for (const stored of data.ops as unknown[]) {
		if (
			!isRecord(stored) ||
			!isRecord(stored.op) ||
			typeof stored.op.op !== "string" ||
			!isRecord(stored.ctx) ||
			!ITEM_ORIGINS.includes(stored.ctx.origin as ItemOrigin) ||
			(stored.ctx.entryId !== undefined && typeof stored.ctx.entryId !== "string")
		) {
			throw new Error("malformed op");
		}
	}
	return data as unknown as ContinuityOpsData;
}

/**
 * Replay the ledger of a branch, root to leaf. Ops entries run through
 * `applyOps` (consecutive ops with one context are one revision); a snapshot on a
 * branch_summary replaces the running ledger. An unusable entry is reported in
 * `warnings` and skipped, never reset to an empty ledger.
 */
export function readBranchLedger(branch: readonly SessionEntry[]): BranchLedger {
	const userEntryIndex = userEntryIndexOf(branch);
	const warnings: string[] = [];
	let ledger = createLedger();
	let watermark: string | undefined;
	for (const entry of branch) {
		if (entry.type === "branch_summary") {
			if (!isRecord(entry.details) || !(LEDGER_DETAILS_KEY in entry.details)) {
				continue;
			}
			try {
				ledger = parseLedger(entry.details[LEDGER_DETAILS_KEY]);
				watermark = undefined;
			} catch (error) {
				warnings.push(`branch_summary ${entry.id}: ledger snapshot ignored (${messageOf(error)})`);
			}
		} else if (entry.type === "custom" && entry.customType === CONTINUITY_OPS_CUSTOM_TYPE) {
			try {
				const data = parseOpsData(entry.data);
				let next = ledger;
				for (const group of groupByContext(data.ops)) {
					next = applyOps(next, group.ops, {
						...group.ctx,
						userEntryIndex,
					}).ledger;
				}
				ledger = next;
				if (data.watermark !== undefined) watermark = data.watermark;
			} catch (error) {
				warnings.push(`custom entry ${entry.id}: ops ignored (${messageOf(error)})`);
			}
		}
	}
	return { ledger, ...(watermark !== undefined && { watermark }), warnings };
}

function groupByContext(ops: readonly StoredOp[]): { ctx: StoredOp["ctx"]; ops: LedgerOp[] }[] {
	const groups: { ctx: StoredOp["ctx"]; ops: LedgerOp[] }[] = [];
	for (const stored of ops) {
		const last = groups.at(-1);
		if (last && last.ctx.origin === stored.ctx.origin && last.ctx.entryId === stored.ctx.entryId) {
			last.ops.push(stored.op);
		} else {
			groups.push({ ctx: stored.ctx, ops: [stored.op] });
		}
	}
	return groups;
}

/** Persist ops on the active branch. Nothing is written when there is nothing to record. */
export function appendOpsEntry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ops: readonly StoredOp[],
	watermark?: string,
): void {
	if (ops.length === 0 && watermark === undefined) return;
	const data: ContinuityOpsData = {
		ops: ops.map(({ op, ctx }) => ({
			op,
			ctx: {
				origin: ctx.origin,
				...(ctx.entryId !== undefined && { entryId: ctx.entryId }),
			},
		})),
		...(watermark !== undefined && { watermark }),
	};
	pi.appendEntry(CONTINUITY_OPS_CUSTOM_TYPE, data);
}

const PREVIEW_SOURCE_CHARS = 400;

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join(" ");
}

/** User messages after `afterEntryId` on `branch`, with one-line previews the model can cite. */
export function spanUserEntryRefs(
	branch: readonly SessionEntry[],
	afterEntryId: string,
): UserEntryRef[] {
	const start = branch.findIndex((entry) => entry.id === afterEntryId);
	if (start < 0) return [];
	return branch.slice(start + 1).flatMap((entry) =>
		entry.type === "message" && entry.message.role === "user"
			? [
					{
						id: entry.id,
						preview: userText(entry.message.content)
							.slice(0, PREVIEW_SOURCE_CHARS)
							.replace(/\s+/g, " ")
							.trim(),
					},
				]
			: [],
	);
}

/** What a fold did to the ledger, for the continuation message's `details.continuity`. */
export interface FoldContinuityReport {
	readonly rev: number;
	readonly applied: number;
	readonly rejected: readonly { id?: string; reason: string }[];
	readonly evicted: readonly string[];
	readonly deltaError?: string;
	readonly warnings?: readonly string[];
}

export interface FoldContinuity {
	/** The model's summary with its `<continuity-delta>` block removed. */
	readonly summaryText: string;
	readonly ledger: Ledger;
	/** Rendered briefing; absent when nothing in the ledger is in force. */
	readonly briefing?: string;
	/** Validated plain-JSON ledger for `branch_summary.details`; absent for an empty ledger. */
	readonly snapshot?: Ledger;
	/** Absent when the ledger was empty and the model proposed nothing. */
	readonly report?: FoldContinuityReport;
	/** One visible line for the continuation, only when something was refused or evicted. */
	readonly notice?: string;
}

const MAX_NOTICE_REASONS = 3;
const NOTICE_REASON_CHARS = 160;

function noticeOf(report: FoldContinuityReport, rejected: readonly string[]): string | undefined {
	const parts: string[] = [];
	if (rejected.length > 0) {
		const shown = rejected.slice(0, MAX_NOTICE_REASONS).join("; ");
		const more = rejected.length > MAX_NOTICE_REASONS ? "; ..." : "";
		parts.push(
			`${rejected.length} delta op${rejected.length === 1 ? "" : "s"} rejected (${shown}${more})`,
		);
	}
	if (report.evicted.length > 0) {
		parts.push(
			`${report.evicted.length} finished item${report.evicted.length === 1 ? "" : "s"} evicted at the ledger cap`,
		);
	}
	if (report.deltaError !== undefined) {
		parts.push(`delta ignored (${report.deltaError})`);
	}
	return parts.length > 0 ? `Continuity: ${parts.join("; ")}.`.replace(/\s+/g, " ") : undefined;
}

/**
 * Continuity for a pressure compaction: no anchor is folded and no snapshot is
 * stored, so the ledger is rendered exactly as the branch holds it. Steering
 * stays active and a stray `<continuity-delta>` is dropped from the summary
 * without being applied, because nothing would persist it.
 */
export function compactionContinuity(
	branch: readonly SessionEntry[],
	summaryText: string,
): { summaryText: string; briefing?: string } {
	const { ledger } = readBranchLedger(branch);
	const text = extractContinuityDelta(summaryText).text;
	return ledger.items.some(isVisible)
		? {
				summaryText: text,
				briefing: renderBriefing(ledger, {
					maxTokens: FOLD_BRIEFING_MAX_TOKENS,
				}).text,
			}
		: { summaryText: text };
}

/**
 * Fold-time reconciliation, with no model call: strip the model's optional
 * `<continuity-delta>` from its summary, apply it as an agent proposal (user
 * rules, decisions and the objective stay protected), archive the anchor's
 * steering, and render the briefing. A malformed delta is reported and nothing
 * from it is applied. `branch` is the active branch before the fold.
 */
export function reconcileFoldContinuity(
	branch: readonly SessionEntry[],
	summaryText: string,
	anchorName: string,
): FoldContinuity {
	const base = readBranchLedger(branch);
	const extracted = extractContinuityDelta(summaryText);
	if (
		base.ledger.items.length === 0 &&
		extracted.delta === undefined &&
		extracted.error === undefined &&
		base.warnings.length === 0
	) {
		return { summaryText: extracted.text, ledger: base.ledger };
	}
	const delta: ContinuityDelta = extracted.delta ?? {};
	const result = reconcileFold(base.ledger, delta, {
		anchorName,
		origin: "agent",
		userEntryIndex: userEntryIndexOf(branch),
	});
	const reasons = result.rejected.map(({ reason }) => capText(reason.message, NOTICE_REASON_CHARS));
	const report: FoldContinuityReport = {
		rev: result.ledger.rev,
		applied: result.applied.length,
		rejected: result.rejected.map(({ reason }) => ({
			...(reason.itemId !== undefined && { id: reason.itemId }),
			reason: reason.message,
		})),
		evicted: result.evicted,
		...(extracted.error !== undefined && {
			deltaError: extracted.error.message,
		}),
		...(base.warnings.length > 0 && { warnings: base.warnings }),
	};
	const ledger = result.ledger;
	const notice = noticeOf(report, reasons);
	return {
		summaryText: extracted.text,
		ledger,
		...(ledger.items.some(isVisible) && {
			briefing: renderBriefing(ledger, { maxTokens: FOLD_BRIEFING_MAX_TOKENS }).text,
		}),
		...(ledger.items.length > 0 && { snapshot: serializeLedger(ledger) }),
		report,
		...(notice !== undefined && { notice }),
	};
}
