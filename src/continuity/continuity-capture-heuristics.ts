/** Marker and sentence heuristics for durable user intent. */

import type { IntentExcerpt, IntentKind } from "./continuity-capture.ts";
import { MAX_QUOTE_CHARS, normalizeText } from "./continuity-ledger.ts";

// Explicit durable-rule wording. `must always` and `must never` are covered by
// the bare words. False positives become protected ledger items, so the lists
// stay short and literal.
export const RULE_MARKERS: readonly RegExp[] = [
	/\balways\b/i,
	/\bnever\b/i,
	/\bfrom now on\b/i,
	/\bgoing forward\b/i,
	/\bdon'?t ever\b/i,
	/\bdo not ever\b/i,
	/\bremember:/i,
	/\brule:/i,
	/\bprefer\b/i,
];

export const DECISION_MARKERS: readonly RegExp[] = [
	/\blet'?s go with\b/i,
	/\bwe decided\b/i,
	/\bdecision:/i,
	/\bgo with option\b/i,
];

export const OBJECTIVE_MARKERS: readonly RegExp[] = [
	/\bgoal:/i,
	/\bobjective:/i,
	/\bthe goal is\b/i,
];

// "never mind" is dismissal, not a rule.
const NON_MARKER_PHRASES = /\bnever ?mind\b/gi;

// Longer messages are pasted content or mixed requests, and the ledger would
// keep only a truncated quote of them. Only a model classifier judges those as
// a whole; the heuristic only lifts out sentences that carry a marker.
export const HEURISTIC_MAX_CHARS = MAX_QUOTE_CHARS;
export const MIN_MESSAGE_CHARS = 12;
const MAX_EXCERPTS = 3;
const SENTENCE_BREAK = /(?<=[.!?\u3002\uff01\uff1f])\s+/;
const CODE_FENCE_RE = /^\s*(```|~~~)/;
// Blockquotes and indented code are other people's words or pasted source.
const QUOTED_LINE_RE = /^(\s*>| {4}|\t)/;

const matchesAny = (markers: readonly RegExp[], text: string): boolean =>
	markers.some((marker) => marker.test(text));

export function heuristicKind(rawText: string): IntentKind {
	const text = rawText
		.trim()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(NON_MARKER_PHRASES, " ");
	if (text.length === 0 || text.length > HEURISTIC_MAX_CHARS) {
		return "ephemeral";
	}
	if (/[?？]$/.test(text)) return "ephemeral";
	if (matchesAny(OBJECTIVE_MARKERS, text)) return "objective";
	if (matchesAny(DECISION_MARKERS, text)) return "decision";
	if (matchesAny(RULE_MARKERS, text)) return "rule";
	return "ephemeral";
}

function proseSentences(text: string): string[] {
	const sentences: string[] = [];
	let fenced = false;
	for (const line of text.split(/\r?\n/)) {
		if (CODE_FENCE_RE.test(line)) {
			fenced = !fenced;
		} else if (!fenced && !QUOTED_LINE_RE.test(line)) {
			sentences.push(...line.split(SENTENCE_BREAK).map((s) => s.trim()));
		}
	}
	return sentences;
}

// Bare "always", "never" and "prefer" are everyday words in pasted logs, docs
// and specs; inside a long message only explicit durable-rule wording counts.
const BARE_RULE_MARKERS: readonly RegExp[] = [/\balways\b/i, /\bnever\b/i, /\bprefer\b/i];
const EXPLICIT_RULE_MARKERS = RULE_MARKERS.filter(
	(marker) => !BARE_RULE_MARKERS.some((bare) => bare.source === marker.source),
);

// The short-message marker rules applied sentence by sentence; a rule sentence
// needs explicit wording.
export function heuristicExcerpts(text: string): IntentExcerpt[] {
	const excerpts: IntentExcerpt[] = [];
	const seen = new Set<string>();
	for (const sentence of proseSentences(text)) {
		if (sentence.length < MIN_MESSAGE_CHARS || sentence.length > HEURISTIC_MAX_CHARS) {
			continue;
		}
		const kind = heuristicKind(sentence);
		if (kind !== "rule" && kind !== "decision") continue;
		if (
			kind === "rule" &&
			!matchesAny(
				EXPLICIT_RULE_MARKERS,
				sentence.replace(/[\u2018\u2019]/g, "'").replace(NON_MARKER_PHRASES, " "),
			)
		) {
			continue;
		}
		if (seen.has(normalizeText(sentence))) continue;
		seen.add(normalizeText(sentence));
		excerpts.push({ kind, text: sentence });
		if (excerpts.length === MAX_EXCERPTS) break;
	}
	return excerpts;
}
