/** Branch scanning and translation of captured intent into ledger operations. */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isValidName, LABEL_PREFIX } from "../core/helpers.ts";
import type { CapturedOp, IntentKind, IntentVerdict } from "./continuity-capture.ts";
import {
	capText,
	type LedgerItem,
	MAX_ITEM_TEXT_CHARS,
	type NewItem,
	normalizeText,
	type OpContext,
	TRUNCATION_MARKER,
} from "./continuity-ledger-model.ts";

export interface CaptureResult {
	ops: CapturedOp[];
	/** Id of the last scanned entry; pass it back on the next call. */
	watermark: string | undefined;
	/** Number of user messages handed to the classifier. */
	classified: number;
	warnings: string[];
}

export const CLASSIFY_CONCURRENCY = 4;
const ASK_ANSWER_MAX_CHARS = 300;
export const SUPERSEDABLE_KINDS: ReadonlySet<string> = new Set([
	"objective",
	"sub-goal",
	"rule",
	"decision",
	"steering",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const nonBlank = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function scanStart(branch: readonly SessionEntry[], watermark: string | undefined): number {
	if (watermark !== undefined) {
		const at = branch.findIndex((entry) => entry.id === watermark);
		if (at >= 0) return at + 1;
	}
	// Entries before the latest fold were captured into the ledger it carries.
	return branch.findLastIndex((entry) => entry.type === "branch_summary") + 1;
}

/** Anchor name in force at each branch index: the latest `anchor:` label target strictly before it. */
export function anchorAt(branch: readonly SessionEntry[]): (index: number) => string | undefined {
	const positions = new Map(branch.map((entry, i) => [entry.id, i] as const));
	const labels = new Map<string, string | undefined>();
	for (const entry of branch) {
		if (entry.type === "label") labels.set(entry.targetId, entry.label);
	}
	const anchors: { index: number; name: string }[] = [];
	for (const [targetId, label] of labels) {
		const index = positions.get(targetId);
		const name = label?.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : undefined;
		if (index !== undefined && isValidName(name)) anchors.push({ index, name });
	}
	anchors.sort((a, b) => a.index - b.index);
	return (index) => anchors.findLast((anchor) => anchor.index < index)?.name;
}

const ASK_PREFIX = "Q: ";
const ASK_JOINER = " → A: ";

function askQuestionText(question: string, answer: string): string {
	const budget = MAX_ITEM_TEXT_CHARS - ASK_PREFIX.length - ASK_JOINER.length - answer.length;
	return `${ASK_PREFIX}${capText(question, budget)}${ASK_JOINER}${answer}`;
}

/** Whether `item` is a captured `ask_user` answer to the question with this full text. */
function isAnswerTo(item: LedgerItem, question: string): boolean {
	if (
		item.kind !== "decision" ||
		item.source.origin !== "ask_user" ||
		!item.text.startsWith(ASK_PREFIX)
	) {
		return false;
	}
	const stored = item.text.slice(ASK_PREFIX.length);
	if (stored.startsWith(question + ASK_JOINER)) return true;
	// A long question was cut to fit: its stored head is a prefix of the full one.
	const cut = stored.indexOf(TRUNCATION_MARKER + ASK_JOINER);
	return cut >= 0 && question.length > cut && question.startsWith(stored.slice(0, cut));
}

export interface AskAnswer {
	entryId: string;
	/** Full question text, one line. */
	question: string;
	text: string;
	quote: string;
}

/** One answer per answered question of a submitted `ask_user` result. */
export function askUserAnswers(entry: SessionEntry): AskAnswer[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult") {
		return [];
	}
	const { toolName, isError } = entry.message;
	const details: unknown = entry.message.details;
	if (toolName !== "ask_user" || isError || !isRecord(details)) return [];
	if (
		details.cancelled !== false ||
		details.error !== undefined ||
		details.mode !== "submit" ||
		!Array.isArray(details.questions) ||
		!isRecord(details.answers)
	) {
		return [];
	}
	const answers: AskAnswer[] = [];
	for (const question of details.questions) {
		if (!isRecord(question) || typeof question.id !== "string") continue;
		const answer = details.answers[question.id];
		if (!isRecord(answer) || !Array.isArray(answer.labels)) continue;
		const labels = answer.labels
			.map(nonBlank)
			.filter((label): label is string => label !== undefined);
		if (labels.length === 0) continue;
		const chosen = labels.join(", ");
		const note = nonBlank(answer.note);
		const answerText = capText(
			oneLine(note ? `${chosen} (note: ${note})` : chosen),
			ASK_ANSWER_MAX_CHARS,
		);
		const prompt = nonBlank(question.prompt) ?? nonBlank(question.label);
		const questionText = oneLine(prompt ?? question.id);
		answers.push({
			entryId: entry.id,
			question: questionText,
			text: askQuestionText(questionText, answerText),
			quote: chosen,
		});
	}
	return answers;
}

export interface Candidate {
	entryId: string;
	index: number;
	text: string;
}

export async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) {
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Ledger state the translation of one scan tracks, since its ops are not applied yet. */
export interface ScanState {
	objective: { id?: string; text: string } | undefined;
	superseded: Set<string>;
}

/**
 * A `decision` for an answered question. A later answer to a question that
 * already has an active answer replaces it, citing the new answer's entry; the
 * ledger accepts that as a user-origin self citation.
 */
export function askOp(
	answer: AskAnswer,
	active: ReadonlyMap<string, LedgerItem>,
	state: ScanState,
): CapturedOp {
	const item: NewItem = {
		kind: "decision",
		text: answer.text,
		quote: answer.quote,
	};
	const ctx: OpContext = { origin: "ask_user", entryId: answer.entryId };
	const earlier = [...active.values()].filter(
		(old) => !state.superseded.has(old.id) && isAnswerTo(old, answer.question),
	);
	const unchanged = earlier.some((old) => normalizeText(old.text) === normalizeText(answer.text));
	if (earlier.length === 0 || unchanged) return { op: { op: "add", ...item }, ctx };
	for (const old of earlier) state.superseded.add(old.id);
	return {
		op: {
			op: "supersede",
			ids: earlier.map((old) => old.id),
			with: item,
			citedEntryId: answer.entryId,
		},
		ctx,
	};
}

export function excerptOps(
	verdict: IntentVerdict,
	entryId: string,
	userEntryIndex: OpContext["userEntryIndex"],
): CapturedOp[] {
	return (verdict.excerpts ?? []).map(({ kind, text }) => ({
		op: { op: "add", kind, text, quote: text },
		ctx: { origin: "user", entryId, userEntryIndex },
	}));
}

export function userOp(
	verdict: IntentVerdict,
	candidate: Candidate,
	anchor: string | undefined,
	active: ReadonlyMap<string, LedgerItem>,
	state: ScanState,
	userEntryIndex: OpContext["userEntryIndex"],
): CapturedOp | undefined {
	const { kind } = verdict;
	if (kind === "ephemeral" || (kind === "steering" && anchor === undefined)) {
		return undefined;
	}
	const { text, entryId } = candidate;
	let target: Exclude<IntentKind, "ephemeral"> = kind;
	const named = (verdict.supersedes ?? []).filter((id) => {
		const item = active.get(id);
		return item?.kind === kind && !state.superseded.has(id);
	});
	let ids = named;
	if (kind === "objective" && state.objective && !named.includes(state.objective.id ?? "")) {
		// Only one objective may be active, and only the classifier may replace it.
		if (normalizeText(state.objective.text) === normalizeText(text)) {
			return undefined;
		}
		target = "sub-goal";
		ids = [];
	}
	for (const id of ids) state.superseded.add(id);
	if (target === "objective") state.objective = { text };
	const item: NewItem = {
		kind: target,
		text,
		quote: text,
		...(target === "steering" && { scopeAnchor: anchor }),
	};
	return {
		op:
			ids.length > 0
				? { op: "supersede", ids, with: item, citedEntryId: entryId }
				: { op: "add", ...item },
		ctx: { origin: "user", entryId, userEntryIndex },
	};
}
