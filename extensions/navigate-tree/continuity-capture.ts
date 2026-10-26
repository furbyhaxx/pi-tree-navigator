/**
 * Capture side of the Session Continuity Ledger: turns user messages and
 * `ask_user` answers on the active branch into ledger ops.
 *
 * Capture is deterministic first. `ask_user` answers need no model, and user
 * messages go through an `IntentClassifier` that only decides what a message
 * is: the stored text is always the user's verbatim words, never a rewrite.
 * Ops are returned, not applied; the ledger enforces every invariant.
 *
 * No I/O. Pi runtime imports are type-only.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	capText,
	type Ledger,
	type LedgerItem,
	type LedgerOp,
	MAX_ITEM_TEXT_CHARS,
	MAX_QUOTE_CHARS,
	type NewItem,
	normalizeText,
	type OpContext,
	TRUNCATION_MARKER,
} from "./continuity-ledger.ts";
import { extractTextContent, isValidName, LABEL_PREFIX } from "./helpers.ts";
import {
	classifierAsk,
	parseClassifierModel,
	RECOMMENDED_INTENT_CLASSIFIER,
	resolveIntentPolicy,
	resolveStageModels,
	type StageAnswer,
	type StageAsk,
} from "./intent-policy.ts";
import {
	buildRetirementCheckContext,
	RETIREMENT_QUESTION,
	retirementConfirmed,
} from "./retirement-check.ts";
import { userAuthoredText } from "./skill-blocks.ts";

export const INTENT_KINDS = [
	"objective",
	"sub-goal",
	"rule",
	"decision",
	"steering",
	"ephemeral",
] as const;

export type IntentKind = (typeof INTENT_KINDS)[number];

export interface IntentInput {
	entryId: string;
	text: string;
	/** Anchor the message falls under (latest `anchor:` label before it), if any. */
	activeAnchor?: string;
	activeItems: readonly { id: string; kind: string; text: string }[];
}

/** One sentence of a message that states a rule or decision on its own. */
export interface IntentExcerpt {
	kind: "rule" | "decision";
	/** The sentence, verbatim as the user wrote it. */
	text: string;
}

export interface IntentVerdict {
	kind: IntentKind;
	/** Ids of active ledger items the message replaces or reverses. */
	supersedes?: readonly string[];
	/** Sentences captured on their own, for a message too long to judge as a whole. */
	excerpts?: readonly IntentExcerpt[];
	by: "heuristic" | "classifier";
	/** Set once per classifier instance when its model failed; surfaced in `CaptureResult.warnings`. */
	warning?: string;
}

export type IntentClassifier = (input: IntentInput, signal?: AbortSignal) => Promise<IntentVerdict>;

export interface CapturedOp {
	op: LedgerOp;
	ctx: OpContext;
}

export interface CaptureResult {
	ops: CapturedOp[];
	/** Id of the last scanned entry; pass it back on the next call. */
	watermark: string | undefined;
	/** Number of user messages handed to the classifier. */
	classified: number;
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Heuristic classifier
// ---------------------------------------------------------------------------

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
const HEURISTIC_MAX_CHARS = MAX_QUOTE_CHARS;
const MIN_MESSAGE_CHARS = 12;
const MAX_EXCERPTS = 3;
const SENTENCE_BREAK = /(?<=[.!?\u3002\uff01\uff1f])\s+/;
const CODE_FENCE_RE = /^\s*(```|~~~)/;
// Blockquotes and indented code are other people's words or pasted source.
const QUOTED_LINE_RE = /^(\s*>| {4}|\t)/;

const matchesAny = (markers: readonly RegExp[], text: string): boolean =>
	markers.some((marker) => marker.test(text));

function heuristicKind(rawText: string): IntentKind {
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
function heuristicExcerpts(text: string): IntentExcerpt[] {
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

/**
 * Marker-based classifier: no I/O, never supersedes, misses anything phrased
 * without an explicit marker ("drop X and only keep Y" is ephemeral to it).
 * A message over the length limit is ephemeral as a whole, but up to three of
 * its rule or decision sentences come back as `excerpts`.
 */
export const heuristicClassifier: IntentClassifier = async (input) => {
	const kind = heuristicKind(input.text);
	const excerpts =
		kind === "ephemeral" && input.text.trim().length > HEURISTIC_MAX_CHARS
			? heuristicExcerpts(input.text.trim())
			: [];
	return {
		kind,
		by: "heuristic",
		...(excerpts.length > 0 && { excerpts }),
	};
};

// ---------------------------------------------------------------------------
// Model classifier
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const MAX_CLASSIFIER_ITEMS = 30;
export const MAX_CLASSIFIER_MESSAGE_CHARS = 4_000;
const MAX_CLASSIFIER_ITEM_CHARS = 200;
const NO_CONTRADICTION = "none";

const KIND_CRITERIA: Record<IntentKind, string> = {
	objective: "States the overall goal of the whole session or project",
	"sub-goal": "Assigns a concrete deliverable or task that should be tracked until it is done",
	rule: "A standing instruction for all later work: always, never, prefer, conventions",
	decision: "Picks or confirms one option among alternatives, a choice that should not be reopened",
	steering: "A correction or direction that only applies to the work currently in progress",
	ephemeral:
		"Anything else: questions, one-off action requests, acknowledgements, status chatter, pasted content",
};

const isIntentKind = (value: string): value is IntentKind =>
	(INTENT_KINDS as readonly string[]).includes(value);

const KIND_PRIORITY: Readonly<Record<string, number>> = {
	rule: 0,
	decision: 0,
	objective: 1,
	"sub-goal": 1,
	steering: 2,
};

const idNumber = (id: string): number => Number(id.slice(1));

// Rules and decisions first, newest first within a group.
function pickItems(items: IntentInput["activeItems"]): IntentInput["activeItems"] {
	return [...items]
		.sort(
			(a, b) =>
				(KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3) ||
				idNumber(b.id) - idNumber(a.id),
		)
		.slice(0, MAX_CLASSIFIER_ITEMS);
}

/** The exact classifier request for one user message; items are the bounded active subset. */
export function buildIntentClassifierContext(input: IntentInput): {
	context: ClassifierContext;
	items: IntentInput["activeItems"];
} {
	const items = pickItems(input.activeItems);
	return { context: classifierContext(input, items), items };
}

function classifierContext(
	input: IntentInput,
	items: IntentInput["activeItems"],
): ClassifierContext {
	const oneLine = (text: string) =>
		capText(text.replace(/\s+/g, " ").trim(), MAX_CLASSIFIER_ITEM_CHARS);
	return {
		state: {
			message: capText(input.text, MAX_CLASSIFIER_MESSAGE_CHARS),
			activeAnchor: input.activeAnchor ?? null,
			activeItems: items.map(({ id, kind, text }) => ({
				id,
				kind,
				text: oneLine(text),
			})),
		},
		questions: {
			kind: {
				type: "choice",
				instructions:
					"What kind of instruction is the user's message? Judge only the message, not the items.",
				criteria: KIND_CRITERIA,
			},
			...(items.length > 0 && {
				contradicts: {
					type: "choice" as const,
					instructions:
						"Which active item, if any, does the message explicitly replace, reverse or contradict?",
					criteria: {
						...Object.fromEntries(items.map((i) => [i.id, oneLine(i.text)])),
						[NO_CONTRADICTION]: "The message changes none of the items",
					},
				},
			}),
		},
	};
}

const ephemeral = (warning?: string): IntentVerdict => ({
	kind: "ephemeral",
	by: "classifier",
	...(warning !== undefined && { warning }),
});

type Answers = Record<string, StageAnswer> | undefined;

// `undefined` is an abstention: low confidence, or no usable kind answer.
function acceptedKind(answers: Answers, minConfidence: number): IntentKind | undefined {
	const kind = answers?.kind;
	return kind !== undefined && kind.confidence >= minConfidence && isIntentKind(kind.choice)
		? kind.choice
		: undefined;
}

// An answer to `contradicts` that names an offered choice with enough confidence.
function acceptedContradiction(
	answers: Answers,
	items: IntentInput["activeItems"],
	minConfidence: number,
): string | undefined {
	const contradicts = answers?.contradicts;
	return contradicts !== undefined &&
		contradicts.confidence >= minConfidence &&
		(contradicts.choice === NO_CONTRADICTION ||
			items.some((item) => item.id === contradicts.choice))
		? contradicts.choice
		: undefined;
}

// An abstaining model must not hide an explicit marker or excerpt: keep what
// the heuristic found, as the heuristic's own verdict, never a supersession.
async function abstentionVerdict(
	input: IntentInput,
	signal: AbortSignal | undefined,
	heuristics: boolean,
): Promise<IntentVerdict> {
	if (!heuristics) return ephemeral();
	const heuristic = await heuristicClassifier(input, signal);
	return heuristic.kind !== "ephemeral" || heuristic.excerpts !== undefined
		? heuristic
		: ephemeral();
}

/** What `createModelClassifier` needs; a policy with catalog models also uses the optional methods. */
export type IntentRegistry = Pick<ModelRegistry, "getModelOfType" | "classify"> &
	Partial<Pick<ModelRegistry, "getAvailableOfType" | "streamSimple">>;

type PolicyRegistry = IntentRegistry &
	Required<Pick<ModelRegistry, "getAvailableOfType" | "streamSimple">>;

const hasPolicyApi = (registry: IntentRegistry): registry is PolicyRegistry =>
	typeof registry.getAvailableOfType === "function" && typeof registry.streamSimple === "function";

const unknownModel = (setting: string) =>
	`navigate_tree: continuity classifier model ${JSON.stringify(setting)} is not a known classifier model (expected "provider/id"); capture uses heuristics only.`;

/** Every stage model of `policy`, resolved to something that can answer. */
async function resolveAsks(
	registry: IntentRegistry,
	setting: string,
	selectors: readonly string[],
): Promise<Map<string, StageAsk> | { problem: string }> {
	const unavailable = (reason: string) => ({
		problem: `navigate_tree: continuity classifier ${JSON.stringify(setting.startsWith("{") ? "custom policy" : setting)} is unavailable (${reason}); capture uses heuristics only.`,
	});
	if (setting === RECOMMENDED_INTENT_CLASSIFIER || setting.startsWith("{")) {
		if (!hasPolicyApi(registry)) {
			return unavailable("the model registry cannot list models");
		}
		const resolved = await resolveStageModels(registry, selectors);
		return resolved.ok ? resolved.asks : unavailable(resolved.reason);
	}
	const parsed = parseClassifierModel(setting);
	const model = parsed
		? registry.getModelOfType("classifier", parsed.provider, parsed.id)
		: undefined;
	return model
		? new Map([[setting, classifierAsk(registry, model)]])
		: { problem: unknownModel(setting) };
}

/**
 * Classify with registry models, one pass per message. `model` is a
 * `continuity.intentClassifier` value: `provider/id` (one classifier model
 * answers both questions), `"recommended"` or the canonical text of an object
 * policy (see `intent-policy.ts`). Resolves to `undefined` (after
 * `opts.onWarning`) when a model is malformed, unknown or has no credentials,
 * and silently when the policy uses no model at all; never throws.
 *
 * The kind is judged by its stage alone and never escalated; without a kind
 * model the heuristic judges it. A message that is not ephemeral then gets the
 * `contradicts` answer of the supersession stage and, if that stage abstains,
 * of the escalation stage. A model abstains on low confidence or an answer it
 * did not offer. When the kind stage abstains the heuristic verdict stands if
 * it found a rule, decision, objective or excerpts, else the message is
 * ephemeral; an abstention never supersedes. A retirement named by escalation
 * applies only when the verification stage confirms that one item; a primary
 * acceptance and a confident `none` are not re-checked. A no, low-confidence,
 * malformed, missing, cancelled or failed check keeps the item and the
 * captured kind. After a stage model's first error the instance stops calling
 * it and reports the failure once through `IntentVerdict.warning`; a failed
 * kind stage answers with the heuristic classifier so no explicit rule is lost
 * during an outage. A failed verification stage stops confirming retirements
 * and leaves them unapplied, without disabling the other stages. Create a new
 * instance to retry.
 */
export async function createModelClassifier(
	registry: IntentRegistry,
	model: string,
	opts: { minConfidence?: number; onWarning?: (message: string) => void } = {},
): Promise<IntentClassifier | undefined> {
	const policy = resolveIntentPolicy(model);
	if (!policy) {
		opts.onWarning?.(unknownModel(model));
		return undefined;
	}
	const selectors = [
		...new Set(
			[
				policy.kind.model,
				policy.supersession.model,
				policy.escalation.model,
				policy.verification.model,
			].filter((selector) => selector !== null),
		),
	];
	if (selectors.length === 0) return undefined;
	const resolved = await resolveAsks(registry, model, selectors);
	if ("problem" in resolved) {
		opts.onWarning?.(resolved.problem);
		return undefined;
	}
	const minConfidence = opts.minConfidence ?? policy.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
	const failed = new Set<string>();
	const verificationDown = new Set<string>();
	const kindModel = policy.kind.model;

	const ask = async (
		selector: string,
		context: ClassifierContext,
		signal: AbortSignal | undefined,
	): Promise<{ answers: Answers } | { error: string }> => {
		try {
			return { answers: await resolved.get(selector)?.(context, signal) };
		} catch (error) {
			failed.add(selector);
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};

	return async (input, signal) => {
		if (signal?.aborted) return ephemeral();
		const outage = async (): Promise<IntentVerdict> =>
			policy.heuristics ? heuristicClassifier(input, signal) : ephemeral();
		const { context, items } = buildIntentClassifierContext(input);
		const questions = (
			ids: readonly string[],
			instructions: Record<string, string | undefined>,
		): ClassifierContext => ({
			state: context.state,
			questions: Object.fromEntries(
				ids.flatMap((id) => {
					const question = context.questions[id];
					const text = instructions[id];
					return question
						? [[id, text === undefined ? question : { ...question, instructions: text }]]
						: [];
				}),
			),
		});
		const supersession = items.length > 0 ? policy.supersession.model : null;
		const sameModel = kindModel !== null && kindModel === supersession;
		const warnings: string[] = [];

		let base: IntentVerdict;
		let shared: Answers;
		if (kindModel === null) {
			base = await heuristicClassifier(input, signal);
			if (base.kind === "ephemeral") return base;
		} else {
			if (failed.has(kindModel)) return outage();
			const out = await ask(
				kindModel,
				questions(sameModel ? ["kind", "contradicts"] : ["kind"], {
					kind: policy.kind.instructions,
					contradicts: policy.supersession.instructions,
				}),
				signal,
			);
			if (signal?.aborted) return ephemeral();
			if ("error" in out) {
				return {
					...(await outage()),
					warning: `navigate_tree: continuity classifier ${kindModel} failed (${out.error}); user instructions are ${policy.heuristics ? "captured by heuristics instead" : "not captured until it answers again"}.`,
				};
			}
			const kind = acceptedKind(out.answers, minConfidence);
			if (kind === undefined) {
				return abstentionVerdict(input, signal, policy.heuristics);
			}
			if (kind === "ephemeral") return ephemeral();
			base = { kind, by: "classifier" };
			if (sameModel) shared = out.answers;
		}

		// The answer of one model to `contradicts`, or undefined when it abstains or fails.
		const askContradicts = async (model: string | null, instructions: string | undefined) => {
			if (model === null || failed.has(model)) return undefined;
			const out = await ask(
				model,
				questions(["contradicts"], { contradicts: instructions }),
				signal,
			);
			if ("error" in out) {
				warnings.push(
					`navigate_tree: continuity classifier ${model} failed (${out.error}); replacements of earlier items by it are skipped.`,
				);
				return undefined;
			}
			return acceptedContradiction(out.answers, items, minConfidence);
		};
		const confirmRetirement = async (
			model: string,
			item: (typeof items)[number],
		): Promise<boolean> => {
			if (verificationDown.has(model) || signal?.aborted) return false;
			const asker = resolved.get(model);
			if (asker === undefined) {
				verificationDown.add(model);
				warnings.push(
					`navigate_tree: continuity classifier ${model} is not available; the proposed retirement is not applied.`,
				);
				return false;
			}
			const { context } = buildRetirementCheckContext({
				message: input.text,
				item,
				otherItems: items.filter((other) => other.id !== item.id),
			});
			const text = policy.verification.instructions;
			const question = context.questions[RETIREMENT_QUESTION];
			const asked =
				text === undefined || question === undefined
					? context
					: {
							...context,
							questions: {
								...context.questions,
								[RETIREMENT_QUESTION]: { ...question, instructions: text },
							},
						};
			try {
				const answers = await asker(asked, signal);
				if (signal?.aborted) return false;
				return retirementConfirmed(answers, minConfidence);
			} catch (error) {
				if (signal?.aborted) return false;
				verificationDown.add(model);
				const reason = error instanceof Error ? error.message : String(error);
				warnings.push(
					`navigate_tree: continuity classifier ${model} failed (${reason}); the proposed retirement is not applied.`,
				);
				return false;
			}
		};
		let contradicts: string | undefined;
		let escalated = false;
		if (items.length > 0) {
			const primary = shared
				? acceptedContradiction(shared, items, minConfidence)
				: await askContradicts(supersession, policy.supersession.instructions);
			if (primary !== undefined) {
				contradicts = primary;
			} else {
				contradicts = await askContradicts(policy.escalation.model, policy.escalation.instructions);
				escalated = contradicts !== undefined;
			}
			if (signal?.aborted) return ephemeral();
		}
		const named = items.some((item) => item.id === contradicts) ? contradicts : undefined;
		const finish = (supersedes?: string): IntentVerdict => ({
			...base,
			...(supersedes !== undefined && { supersedes: [supersedes] }),
			...(warnings.length > 0 && { warning: warnings.join(" ") }),
		});
		const proposed =
			named === undefined ? undefined : items.find((candidate) => candidate.id === named);
		const verifier = policy.verification.model;
		if (!escalated || proposed === undefined || verifier === null) {
			return finish(named);
		}
		if (!(await confirmRetirement(verifier, proposed))) return finish();
		return finish(named);
	};
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const CLASSIFY_CONCURRENCY = 4;
// Slash commands that reach the model are expanded text, not user intent; the
// `[navigate_tree` prefix is this extension's own injected user messages.
const SLASH_COMMAND_RE = /^\/[\w:.-]+(\s|$)/;
const OWN_MESSAGE_PREFIX = "[navigate_tree";

/** The user message `/anchor` injects to request a fold: machine-generated, never intent. */
export const FOLD_REQUEST_RE =
	/^Please fold the work since the '[^']*' anchor: call navigate_tree\(action='rewind'/;
const ASK_ANSWER_MAX_CHARS = 300;
const SUPERSEDABLE_KINDS: ReadonlySet<string> = new Set([
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

function scanStart(branch: readonly SessionEntry[], watermark: string | undefined): number {
	if (watermark !== undefined) {
		const at = branch.findIndex((entry) => entry.id === watermark);
		if (at >= 0) return at + 1;
	}
	// Entries before the latest fold were captured into the ledger it carries.
	return branch.findLastIndex((entry) => entry.type === "branch_summary") + 1;
}

/** Anchor name in force at each branch index: the latest `anchor:` label target strictly before it. */
function anchorAt(branch: readonly SessionEntry[]): (index: number) => string | undefined {
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

interface AskAnswer {
	entryId: string;
	/** Full question text, one line. */
	question: string;
	text: string;
	quote: string;
}

/** One answer per answered question of a submitted `ask_user` result. */
function askUserAnswers(entry: SessionEntry): AskAnswer[] {
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

interface Candidate {
	entryId: string;
	index: number;
	text: string;
}

function userCandidate(entry: SessionEntry, index: number): Candidate | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") {
		return undefined;
	}
	const text = userAuthoredText(extractTextContent(entry.message.content)).text.trim();
	if (
		text.length < MIN_MESSAGE_CHARS ||
		SLASH_COMMAND_RE.test(text) ||
		text.startsWith(OWN_MESSAGE_PREFIX) ||
		FOLD_REQUEST_RE.test(text)
	) {
		return undefined;
	}
	return { entryId: entry.id, index, text };
}

async function mapPool<T, R>(
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
interface ScanState {
	objective: { id?: string; text: string } | undefined;
	superseded: Set<string>;
}

/**
 * A `decision` for an answered question. A later answer to a question that
 * already has an active answer replaces it, citing the new answer's entry; the
 * ledger accepts that as a user-origin self citation.
 */
function askOp(
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

function excerptOps(
	verdict: IntentVerdict,
	entryId: string,
	userEntryIndex: OpContext["userEntryIndex"],
): CapturedOp[] {
	return (verdict.excerpts ?? []).map(({ kind, text }) => ({
		op: { op: "add", kind, text, quote: text },
		ctx: { origin: "user", entryId, userEntryIndex },
	}));
}

function userOp(
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

/**
 * Turn the entries after `watermark` into ledger ops.
 *
 * `branch` is root-to-leaf (`sm.getBranch()`). Scanning starts after the
 * watermark entry, or after the latest `branch_summary` when the watermark is
 * missing or off the branch. Entries that already sourced a ledger item are
 * skipped so a lost watermark cannot resurrect superseded items; anything else
 * re-captured is a ledger `duplicate`. If `opts.signal` aborts, no ops are
 * returned and the watermark does not move.
 */
export async function captureIntent(
	branch: readonly SessionEntry[],
	watermark: string | undefined,
	ledger: Ledger,
	classifier: IntentClassifier,
	opts: { signal?: AbortSignal } = {},
): Promise<CaptureResult> {
	const scanned = branch.slice(scanStart(branch, watermark));
	const warnings = new Set<string>();
	const done = (ops: CapturedOp[], classified: number): CaptureResult => ({
		ops,
		watermark: scanned.length > 0 ? scanned[scanned.length - 1]?.id : watermark,
		classified,
		warnings: [...warnings],
	});
	if (scanned.length === 0) return done([], 0);

	const captured = new Set(
		ledger.items.flatMap((item) =>
			item.source.entryId === undefined ? [] : [item.source.entryId],
		),
	);
	const offset = branch.length - scanned.length;
	const fresh = scanned.map((entry, i) => ({ entry, index: offset + i }));
	const candidates = fresh.flatMap(({ entry, index }) => {
		const candidate = captured.has(entry.id) ? undefined : userCandidate(entry, index);
		return candidate ? [candidate] : [];
	});

	const active = new Map(
		ledger.items
			.filter((item) => item.status === "active" && SUPERSEDABLE_KINDS.has(item.kind))
			.map((item) => [item.id, item] as const),
	);
	const activeItems = [...active.values()].map(({ id, kind, text }) => ({
		id,
		kind,
		text,
	}));
	const anchorFor = anchorAt(branch);
	const verdicts = await mapPool(candidates, CLASSIFY_CONCURRENCY, async (c) => {
		if (opts.signal?.aborted) return undefined;
		const anchor = anchorFor(c.index);
		try {
			return await classifier(
				{
					entryId: c.entryId,
					text: c.text,
					...(anchor !== undefined && { activeAnchor: anchor }),
					activeItems,
				},
				opts.signal,
			);
		} catch (error) {
			if (opts.signal?.aborted) return undefined;
			warnings.add(
				`navigate_tree: continuity intent classifier failed (${error instanceof Error ? error.message : String(error)}); the message was not captured.`,
			);
			return undefined;
		}
	});
	if (opts.signal?.aborted) return { ...done([], 0), watermark };

	for (const verdict of verdicts) {
		if (verdict?.warning !== undefined) warnings.add(verdict.warning);
	}
	const classified = new Map(
		candidates.map((c, i) => [c.entryId, { candidate: c, verdict: verdicts[i] }]),
	);
	const userEntries = new Map(
		branch.flatMap((entry, i) =>
			entry.type === "message" && entry.message.role === "user" ? [[entry.id, i] as const] : [],
		),
	);
	const userEntryIndex = (id: string) => userEntries.get(id);
	const state: ScanState = {
		objective: ledger.items
			.filter((item) => item.kind === "objective" && item.status === "active")
			.map((item) => ({ id: item.id, text: item.text }))[0],
		superseded: new Set(),
	};

	// Answers to one question are judged across the whole scan, including entries
	// already captured, so only the newest one is emitted and a lost watermark
	// cannot bring back an answer a later one replaced.
	const answers = new Map(fresh.map(({ entry }) => [entry.id, askUserAnswers(entry)] as const));
	const newest = new Map<string, AskAnswer>();
	for (const list of answers.values()) {
		for (const answer of list) newest.set(answer.question, answer);
	}

	const ops: CapturedOp[] = [];
	for (const { entry, index } of fresh) {
		if (captured.has(entry.id)) continue;
		for (const answer of answers.get(entry.id) ?? []) {
			if (newest.get(answer.question) === answer) {
				ops.push(askOp(answer, active, state));
			}
		}
		const hit = classified.get(entry.id);
		if (!hit?.verdict) continue;
		ops.push(...excerptOps(hit.verdict, entry.id, userEntryIndex));
		const op = userOp(hit.verdict, hit.candidate, anchorFor(index), active, state, userEntryIndex);
		if (op) ops.push(op);
	}
	return done(ops, candidates.length);
}
