/** Fold boundary drafts, continuation text and operation receipts. */

import type { SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatContextDelta, TOOL_NAME } from "../core/helpers.ts";
import type { FoldResult } from "./fold-api.ts";
import type { FoldRequest } from "./fold-engine.ts";

// =============================================================================
// Helpers (extension-internal; pure helpers in ./helpers.ts)
// =============================================================================

// =============================================================================
// Extension
// =============================================================================

/**
 * Earlier handlers' boundary drafts that still apply after a rewind moved the
 * branch. A `context_edit` draft can target an entry the rewind just
 * abandoned; pi validates the whole list in a preview (`appendContextEdit`
 * throws for a target off the active branch) and drops ALL of it, ours
 * included, when one draft fails — so such drafts are dropped here instead.
 * Every other draft passes through: pi never validates a compaction's
 * `firstKeptEntryId` (`null` is a valid self-retaining compaction).
 */
export function keepValidDrafts<T>(sm: SessionManager, drafts: readonly T[]): T[] {
	let onBranch: Set<string>;
	try {
		onBranch = new Set(sm.getBranch().map((e) => e.id));
	} catch {
		return [...drafts];
	}
	return drafts.filter((draft) => {
		const d = draft as { type?: string; targetId?: string };
		if (d?.type === "context_edit") return onBranch.has(d.targetId ?? "");
		return true;
	});
}

/** A `navigate-tree-rewind` message, delivered as a `turn_end` boundary entry. */
export interface RewindMessageDraft {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

export function rewindMessageDraft(
	content: string,
	details: Record<string, unknown>,
): RewindMessageDraft {
	return {
		type: "custom_message",
		customType: REWIND_CUSTOM_TYPE,
		content,
		display: true,
		details,
	};
}

/** `context_edit` drafts hiding `ids` (a failed attempt). */
export function hideDrafts(ids: readonly string[]): SessionBoundaryDraft[] {
	return ids.map((targetId) => ({
		type: "context_edit",
		targetId,
		replacement: null,
	}));
}

/** customType of the rewind continuation and receipt messages. */
export const REWIND_CUSTOM_TYPE = "navigate-tree-rewind";

/** The rewind's tool result: the fold is queued and lands after this turn's tool results. */
export function buildRewindAcceptedText(rewindTo: string, newLabel: string): string {
	return `[${TOOL_NAME}] Rewind to '${rewindTo}' accepted (collapse as '${newLabel}'). The fold runs after this turn's tool results; the continuation follows in the same run.`;
}

export function buildRewindDoneText(
	fold: {
		rewindTo: string;
		newLabel: string;
		beforeTokens: number;
		contextWindow: number;
	},
	afterTokens: number,
): string {
	return (
		`[rewind to '${fold.rewindTo}' · collapsed as '${fold.newLabel}'] · ${formatContextDelta(fold.beforeTokens, afterTokens, fold.contextWindow)}\n\n` +
		`A branch_summary of the collapsed work has been appended to your context. It is the newest branch_summary, the current state; earlier branch_summary messages, if present, are older collapsed segments. Items under '### Done' are complete. Items under '### In Progress', '### Blocked', or '## Next Steps' are the resume point: continue the latest branch_summary's work without re-confirming with the user.\n\n` +
		`A branch_summary marks a milestone, not the end of the task. Your authority, highest first: the user's standing instruction retained above (including any authorization to work autonomously until the task is complete or a real blocker appears), the authorized plan or todo list, then this summary's open items. If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope. Retained user messages already answered above are historical — do not re-answer them; their standing instructions still apply.`
	);
}

/** Sent once when the first turn after a fold ends text-only with work still open. */
export const CONTINUE_NUDGE_TEXT =
	"[navigate_tree] You ended the turn immediately after a rewind. Its branch_summary is a milestone summary, not a stop condition: if the user's standing instruction or the authorized plan still has open work, continue with it now, in this turn. End the turn only when the authorized scope is done and verified, or a real blocker needs the user — and say which.";

export const CONTINUE_NUDGE_STATUS = "continue-nudge";

export function buildLateEntriesNote(count: number): string {
	return count === 1
		? "The message between the branch_summary and this one arrived while the rewind was pending — it is new and still unanswered; handle it now."
		: `The ${count} messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.`;
}

/** The receipt of a fold that landed: the continuation text plus the fold's figures. */
export function foldDoneDraft(
	request: FoldRequest,
	done: Extract<FoldResult, { status: "done" }>,
): RewindMessageDraft {
	const landed = done.commit;
	return rewindMessageDraft(landed.continuation, {
		status: "done",
		rewindTo: request.rewindTo,
		newLabel: request.newLabel,
		targetId: landed.targetId,
		summaryId: landed.summaryId,
		collapsedEntries: landed.collapsedEntries,
		contextBefore: landed.contextBefore,
		contextAfter: landed.afterTokens,
		contextWindow: landed.contextWindow,
		origin: request.origin,
		summaryStrategy: done.strategy,
		summaryCalls: done.calls,
		foldEstimateBefore: landed.foldEstimateBefore,
		foldEstimateAfter: landed.foldEstimateAfter,
		agentMessagesRefreshed: landed.refreshed,
		historyRewriteNotified: landed.historyRewriteNotified,
		readFiles: landed.readFiles,
		modifiedFiles: landed.modifiedFiles,
		reappendedLateMessages: landed.reappended,
		openUserRequests: landed.openUserRequests,
		...(landed.continuityReport && { continuity: landed.continuityReport }),
	});
}

/** The receipt of a fold that did not finish, including uncertain commit writes. */
export function foldFailedDraft(
	request: FoldRequest,
	outcome: Exclude<FoldResult, { status: "done" }>,
): RewindMessageDraft {
	const head = `[${TOOL_NAME}] Fold to '${request.rewindTo}' (collapse as '${request.newLabel}')`;
	const base = {
		status: "failed",
		rewindTo: request.rewindTo,
		newLabel: request.newLabel,
		origin: request.origin,
		...(request.toolCallId && { toolCallId: request.toolCallId }),
	};
	if (outcome.status === "failed") {
		return rewindMessageDraft(
			`${head} failed at the ${outcome.stage} stage (${outcome.reason}): ${outcome.detail}${outcome.stage === "commit" ? "" : "\n\nNothing was collapsed."}`,
			{
				...base,
				stage: outcome.stage,
				reason: outcome.reason,
				detail: outcome.detail,
			},
		);
	}
	const reason = outcome.status === "busy" ? "busy" : "cancelled";
	return rewindMessageDraft(
		outcome.status === "busy"
			? `${head} was not started: another fold is running for this session. Nothing was collapsed.`
			: `${head} was cancelled. Nothing was collapsed.`,
		{ ...base, reason },
	);
}

/**
 * Minimal TUI component (pi-tui's `Component` shape) rendering plain lines,
 * word-wrapped to the width in terminal cells and styled per line. pi-tui
 * throws on any rendered line wider than the terminal, so every line is
 * measured and wrapped with pi-tui's own helpers (pi's extension loader
 * aliases `@earendil-works/pi-tui` to its bundled copy at runtime).
 */
export class StyledLines {
	private readonly lines: string[];
	private readonly style: (line: string) => string;
	private readonly padX: number;
	private readonly wrap: boolean;

	constructor(lines: string[], style: (line: string) => string, padX = 1, wrap = true) {
		this.lines = lines;
		this.style = style;
		this.padX = padX;
		this.wrap = wrap;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2 * this.padX);
		const pad = " ".repeat(Math.max(0, Math.min(this.padX, width - 1)));
		const out: string[] = [];
		for (const line of this.lines) {
			const pieces = this.wrap ? wrapPlainLine(line, inner) : [truncateToWidth(line, inner, "…")];
			for (const piece of pieces) {
				const row = pad + this.style(piece);
				// Final guard: pi-tui throws on a line wider than the terminal.
				out.push(visibleWidth(row) <= width ? row : truncateToWidth(row, Math.max(0, width), ""));
			}
		}
		return out;
	}

	invalidate(): void {}
}

/**
 * Word-wrap one plain-text line to `width` terminal cells (hard-break words
 * longer than the width). Cells, not code points: `summaryFocus` and error
 * reasons can carry wide characters (CJK, emoji) and tabs. Tabs are
 * expanded first (pi-tui measures one as 3 cells); every piece is then
 * truncated to the width as a final guard (a 2-cell character cannot fit a
 * 1-cell width).
 */
export function wrapPlainLine(line: string, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const text = line.replace(/\t/g, "   ");
	if (visibleWidth(text) <= w) return [text];
	return wrapTextWithAnsi(text, w).map((piece) =>
		visibleWidth(piece) <= w ? piece : truncateToWidth(piece, w, ""),
	);
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function toolError(text: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text }],
		// `isError` is a statement of intent only: pi-agent-core ignores the flag
		// on a *returned* result (only a thrown `execute()` is finalized as
		// failed), so without the `refusal` marker below the host records this
		// as a successful call and the TUI paints the row with `toolSuccessBg`.
		// The `tool_result` handler in the factory promotes the marker into the
		// host's real error channel.
		details: { ...details, refusal: true },
		isError: true,
	};
}
