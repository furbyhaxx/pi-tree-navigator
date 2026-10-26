/**
 * Rendering for the Session Continuity Ledger: the model-facing briefing, the
 * fold-time capture request with its `<continuity-delta>` schema, and a compact
 * UI summary.
 *
 * No I/O and no pi runtime imports.
 */

import {
	type ContinuityDelta,
	ContinuityError,
	capText,
	type ItemKind,
	isUserOrigin,
	type Ledger,
	type LedgerItem,
} from "./continuity-ledger-model.ts";
import { parseDelta } from "./continuity-ledger-parser.ts";

export const CONTINUITY_DELTA_TAG = "continuity-delta";
const DELTA_OPEN = `<${CONTINUITY_DELTA_TAG}>`;
const DELTA_CLOSE = `</${CONTINUITY_DELTA_TAG}>`;

export const estimateBriefingTokens = (text: string): number => Math.ceil(text.length / 4);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const idNumber = (item: LedgerItem): number => Number(item.id.slice(1));
const byId = (a: LedgerItem, b: LedgerItem): number => idNumber(a) - idNumber(b);

const SECTIONS: readonly { kind: ItemKind; title: string }[] = [
	{ kind: "objective", title: "Objective" },
	{ kind: "sub-goal", title: "Active goals" },
	{ kind: "rule", title: "Binding rules" },
	{ kind: "decision", title: "Decisions" },
	{ kind: "steering", title: "Active steering" },
	{ kind: "fact", title: "Facts" },
	{ kind: "file", title: "Files" },
];

// Dropped oldest-first in this order. Objective, goals, rules, decisions and
// stale file pointers are never dropped.
const DROP_ORDER = ["fact", "file", "steering"] as const;
type Droppable = (typeof DROP_ORDER)[number];

export const isVisible = (item: LedgerItem): boolean =>
	item.status === "active" || (item.kind === "file" && item.status === "stale");

function renderItem(item: LedgerItem): string {
	if (item.kind === "file" && item.file) {
		const stale = item.status === "stale" ? " [STALE: file changed since it was pinned]" : "";
		return `${item.id} ${item.text} — ${oneLine(item.file.why)}${stale}`;
	}
	const tags = [
		item.scopeAnchor !== undefined && `@${item.scopeAnchor}`,
		// Items the user did not author are not binding on their own.
		(item.kind === "objective" || item.kind === "rule" || item.kind === "decision") &&
			!isUserOrigin(item.source.origin) &&
			!item.pinned &&
			item.source.origin,
	].filter((tag): tag is string => typeof tag === "string");
	const prefix = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
	const quote =
		item.quote !== undefined && (item.kind === "rule" || item.kind === "decision")
			? `\n  > "${oneLine(item.quote)}"`
			: "";
	return `${item.id}${prefix} ${oneLine(item.text)}${quote}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function omissionNote(omitted: Record<Droppable, number>): string | undefined {
	const parts = [
		omitted.fact > 0 && plural(omitted.fact, "fact"),
		omitted.file > 0 && plural(omitted.file, "file pointer"),
		omitted.steering > 0 && `${omitted.steering} steering`,
	].filter((part): part is string => typeof part === "string");
	return parts.length > 0 ? `[omitted for budget: ${parts.join(", ")}]` : undefined;
}

export interface BriefingOptions {
	readonly maxTokens: number;
}

export interface Briefing {
	readonly text: string;
	readonly estimatedTokens: number;
	/** True when the never-dropped items alone exceed `maxTokens`; they are returned anyway. */
	readonly overBudget: boolean;
	readonly omitted: Readonly<Record<Droppable, number>>;
}

function compose(
	ledger: Ledger,
	items: readonly LedgerItem[],
	omitted: Record<Droppable, number>,
): string {
	const lines = [`[navigate_tree continuity ledger rev ${ledger.rev}]`];
	for (const { kind, title } of SECTIONS) {
		const section = items.filter((item) => item.kind === kind).sort(byId);
		if (section.length === 0) continue;
		lines.push("", `${title}:`, ...section.map(renderItem));
	}
	if (items.length === 0) lines.push("", "(no active items)");
	const note = omissionNote(omitted);
	if (note) lines.push("", note);
	return lines.join("\n");
}

/**
 * Model-facing briefing, deterministic in kind order then id. Superseded, completed
 * and archived items are not rendered. Over budget, facts, then file pointers, then
 * steering are dropped oldest-first and the omission is stated in the text.
 */
export function renderBriefing(ledger: Ledger, { maxTokens }: BriefingOptions): Briefing {
	let shown = ledger.items.filter(isVisible);
	const omitted: Record<Droppable, number> = { fact: 0, file: 0, steering: 0 };
	let text = compose(ledger, shown, omitted);
	for (const kind of DROP_ORDER) {
		const candidates = shown
			.filter((item) => item.kind === kind && item.status !== "stale")
			.sort(byId);
		for (const victim of candidates) {
			if (estimateBriefingTokens(text) <= maxTokens) break;
			shown = shown.filter((item) => item !== victim);
			omitted[kind] += 1;
			text = compose(ledger, shown, omitted);
		}
	}
	const estimatedTokens = estimateBriefingTokens(text);
	return {
		text,
		estimatedTokens,
		overBudget: estimatedTokens > maxTokens,
		omitted,
	};
}

/** A user message the model may cite when it reports a supersession. */
export interface UserEntryRef {
	readonly id: string;
	readonly preview: string;
}

const MAX_USER_ENTRY_REFS = 40;
const USER_REF_PREVIEW_CHARS = 160;

const DELTA_SCHEMA = `${DELTA_OPEN}
{
  "completed": ["S2"],
  "ratified": [
    { "kind": "decision", "text": "Use sqlite for the index", "quote": "go with sqlite" }
  ],
  "superseded": [
    { "ids": ["R3"], "with": { "kind": "rule", "text": "Use tabs", "quote": "actually, tabs" }, "citedEntryId": "<id of the later user message>" }
  ],
  "expiredSteering": ["T5"]
}
${DELTA_CLOSE}`;

/**
 * Block for the fold's in-band summary request: what is still binding or scoped to
 * the span being folded, and how to report changes as a `<continuity-delta>`.
 */
export function renderFoldCaptureSection(
	ledger: Ledger,
	anchorName: string,
	userEntries: readonly UserEntryRef[] = [],
): string {
	const active = ledger.items.filter((item) => item.status === "active");
	const section = (title: string, items: readonly LedgerItem[]): string[] =>
		items.length === 0 ? [] : ["", `${title}:`, ...[...items].sort(byId).map(renderItem)];
	const inSpan = (item: LedgerItem): boolean =>
		item.scopeAnchor === undefined || item.scopeAnchor === anchorName;
	return [
		...(active.length > 0
			? [
					`Continuity ledger rev ${ledger.rev}. These items stay in force across this fold and are carried outside your prose summary; do not restate them.`,
				]
			: []),
		...section(
			"Binding rules",
			active.filter((item) => item.kind === "rule"),
		),
		...section(
			"Decisions",
			active.filter((item) => item.kind === "decision"),
		),
		...section(
			"Open goals",
			active.filter((item) => item.kind === "sub-goal" && inSpan(item)),
		),
		...section(
			`Steering scoped to ${anchorName} (archived by this fold)`,
			active.filter((item) => item.kind === "steering" && item.scopeAnchor === anchorName),
		),
		...(userEntries.length > 0
			? [
					"",
					"User messages in the folded span (cite an id as citedEntryId when one of them changed an earlier rule or decision):",
					...userEntries
						.slice(-MAX_USER_ENTRY_REFS)
						.map((ref) => `- ${ref.id}: ${capText(ref.preview, USER_REF_PREVIEW_CHARS)}`),
				]
			: []),
		"",
		`After the summary, append at most one continuity-delta block: JSON between the tags shown below, empty keys omitted.`,
		"- completed: ids of goals finished in the folded span.",
		"- ratified: new durable rules, decisions or facts. Give quote as the user's exact words where they exist; scopeAnchor only for steering and goals.",
		"- superseded: only when the user later changed their mind; citedEntryId must name that user message.",
		"- expiredSteering: ids of steering no longer relevant.",
		"User rules, decisions and the objective cannot be removed, rewritten or completed this way; such entries are rejected and reported.",
		DELTA_SCHEMA,
	].join("\n");
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * Extract and strictly validate the `<continuity-delta>` block from model output.
 * Returns undefined when the text has no block; throws `ContinuityError`
 * (`invalid_delta`) for a malformed, duplicated or unclosed one.
 */
export function parseContinuityDelta(text: string): ContinuityDelta | undefined {
	const opens = count(text, DELTA_OPEN);
	const closes = count(text, DELTA_CLOSE);
	if (opens === 0 && closes === 0) return undefined;
	const start = text.indexOf(DELTA_OPEN) + DELTA_OPEN.length;
	const end = text.indexOf(DELTA_CLOSE);
	if (opens !== 1 || closes !== 1 || end < start) {
		throw new ContinuityError(
			"invalid_delta",
			`expected exactly one ${DELTA_OPEN}...${DELTA_CLOSE} block`,
		);
	}
	const body = text.slice(start, end).trim();
	let json: unknown;
	try {
		json = JSON.parse(FENCE_RE.exec(body)?.[1] ?? body);
	} catch (error) {
		throw new ContinuityError(
			"invalid_delta",
			`${CONTINUITY_DELTA_TAG} is not valid JSON: ${(error as Error).message}`,
		);
	}
	return parseDelta(json);
}

export interface ExtractedDelta {
	/** The model's reply with a complete delta block removed. */
	readonly text: string;
	readonly delta?: ContinuityDelta;
	/** Set when a complete block was present but unusable; nothing was applied. */
	readonly error?: ContinuityError;
}

/**
 * Non-throwing variant for the fold path: a stray tag in prose is ignored, a
 * single complete block is parsed and stripped from the text, and anything
 * unusable is reported in `error` so a fold never fails because of it.
 */
export function extractContinuityDelta(text: string): ExtractedDelta {
	const start = text.indexOf(DELTA_OPEN);
	const end = start < 0 ? -1 : text.indexOf(DELTA_CLOSE, start + DELTA_OPEN.length);
	if (start < 0 || end < 0) return { text };
	const stripped = `${text.slice(0, start)}${text.slice(end + DELTA_CLOSE.length)}`
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
	if (count(text, DELTA_OPEN) !== 1 || count(text, DELTA_CLOSE) !== 1) {
		return {
			text,
			error: new ContinuityError(
				"invalid_delta",
				`expected exactly one ${DELTA_OPEN}...${DELTA_CLOSE} block`,
			),
		};
	}
	try {
		const delta = parseContinuityDelta(text);
		return delta ? { text: stripped, delta } : { text };
	} catch (error) {
		if (!(error instanceof ContinuityError)) throw error;
		return { text: stripped, error };
	}
}

export interface LedgerUiSummary {
	readonly goals: number;
	readonly tasks: number;
	readonly rules: number;
	readonly decisions: number;
	readonly steering: number;
	readonly facts: number;
	readonly files: number;
	readonly staleFiles: number;
	readonly rev: number;
	/** e.g. `1 goal · 4 rules · 2 tasks · rev 14`; zero counts are omitted. */
	readonly line: string;
}

/** Counts of active items (tasks are active sub-goals; goals are the objective) for the /anchor hub badge. */
export function summarizeLedgerForUi(ledger: Ledger): LedgerUiSummary {
	const countOf = (kind: ItemKind, status: LedgerItem["status"] = "active") =>
		ledger.items.filter((i) => i.kind === kind && i.status === status).length;
	const counts = {
		goals: countOf("objective"),
		tasks: countOf("sub-goal"),
		rules: countOf("rule"),
		decisions: countOf("decision"),
		steering: countOf("steering"),
		facts: countOf("fact"),
		files: countOf("file"),
		staleFiles: countOf("file", "stale"),
	};
	const parts = [
		counts.goals > 0 && plural(counts.goals, "goal"),
		counts.rules > 0 && plural(counts.rules, "rule"),
		counts.tasks > 0 && plural(counts.tasks, "task"),
		counts.decisions > 0 && plural(counts.decisions, "decision"),
		counts.steering > 0 && `${counts.steering} steering`,
		counts.staleFiles > 0 && `${counts.staleFiles} stale`,
	].filter((part): part is string => typeof part === "string");
	if (parts.length === 0) parts.push("empty");
	parts.push(`rev ${ledger.rev}`);
	return { ...counts, rev: ledger.rev, line: parts.join(" · ") };
}
