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

import type {
  ClassifierContext,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
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

export type IntentClassifier = (
  input: IntentInput,
  signal?: AbortSignal,
) => Promise<IntentVerdict>;

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

// The same marker rules as a short message, applied sentence by sentence.
function heuristicExcerpts(text: string): IntentExcerpt[] {
  const excerpts: IntentExcerpt[] = [];
  const seen = new Set<string>();
  for (const sentence of proseSentences(text)) {
    if (
      sentence.length < MIN_MESSAGE_CHARS ||
      sentence.length > HEURISTIC_MAX_CHARS
    ) {
      continue;
    }
    const kind = heuristicKind(sentence);
    if (kind !== "rule" && kind !== "decision") continue;
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
  "sub-goal":
    "Assigns a concrete deliverable or task that should be tracked until it is done",
  rule: "A standing instruction for all later work: always, never, prefer, conventions",
  decision:
    "Picks or confirms one option among alternatives, a choice that should not be reopened",
  steering:
    "A correction or direction that only applies to the work currently in progress",
  ephemeral:
    "Anything else: questions, one-off action requests, acknowledgements, status chatter, pasted content",
};

const isIntentKind = (value: string): value is IntentKind =>
  (INTENT_KINDS as readonly string[]).includes(value);

/** Split `provider/id` at the first slash (ids may contain slashes). */
export function parseClassifierModel(
  value: string,
): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) {
    return undefined;
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

const KIND_PRIORITY: Readonly<Record<string, number>> = {
  rule: 0,
  decision: 0,
  objective: 1,
  "sub-goal": 1,
  steering: 2,
};

const idNumber = (id: string): number => Number(id.slice(1));

// Rules and decisions first, newest first within a group.
function pickItems(
  items: IntentInput["activeItems"],
): IntentInput["activeItems"] {
  return [...items]
    .sort(
      (a, b) =>
        (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3) ||
        idNumber(b.id) - idNumber(a.id),
    )
    .slice(0, MAX_CLASSIFIER_ITEMS);
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

function verdictFrom(
  result: ClassifierResult,
  items: IntentInput["activeItems"],
  minConfidence: number,
): IntentVerdict {
  const kind = result.answers.kind;
  if (
    kind?.type !== "choice" ||
    kind.confidence < minConfidence ||
    !isIntentKind(kind.choice) ||
    kind.choice === "ephemeral"
  ) {
    return ephemeral();
  }
  const contradicts = result.answers.contradicts;
  const named =
    contradicts?.type === "choice" &&
    contradicts.confidence >= minConfidence &&
    items.some((item) => item.id === contradicts.choice)
      ? contradicts.choice
      : undefined;
  return {
    kind: kind.choice,
    by: "classifier",
    ...(named !== undefined && { supersedes: [named] }),
  };
}

/**
 * Classify with a registry classifier model, one call per message. Resolves to
 * `undefined` (after `opts.onWarning`) when `model` is malformed or unknown;
 * never throws. A low-confidence or malformed answer is ephemeral. After the
 * first provider error the instance stops calling the model, returns ephemeral
 * and reports the failure once through `IntentVerdict.warning`; create a new
 * instance to retry.
 */
export async function createModelClassifier(
  registry: Pick<ModelRegistry, "getModelOfType" | "classify">,
  model: string,
  opts: { minConfidence?: number; onWarning?: (message: string) => void } = {},
): Promise<IntentClassifier | undefined> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const parsed = parseClassifierModel(model);
  const classifierModel = parsed
    ? registry.getModelOfType("classifier", parsed.provider, parsed.id)
    : undefined;
  if (!classifierModel) {
    opts.onWarning?.(
      `navigate_tree: continuity classifier model ${JSON.stringify(model)} is not a known classifier model (expected "provider/id"); capture uses heuristics only.`,
    );
    return undefined;
  }
  let failed = false;
  return async (input, signal) => {
    if (failed || signal?.aborted) return ephemeral();
    const items = pickItems(input.activeItems);
    let result: ClassifierResult | undefined;
    let reason: string | undefined;
    try {
      result = await registry.classify(
        classifierModel,
        classifierContext(input, items),
        signal ? { signal } : undefined,
      );
      if (result.stopReason !== "stop") {
        reason = result.errorMessage ?? result.stopReason;
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (signal?.aborted) return ephemeral();
    if (!result || reason !== undefined) {
      const first = !failed;
      failed = true;
      return ephemeral(
        first
          ? `navigate_tree: continuity classifier ${model} failed (${reason}); user instructions were not classified this pass.`
          : undefined,
      );
    }
    return verdictFrom(result, items, minConfidence);
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
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

function scanStart(
  branch: readonly SessionEntry[],
  watermark: string | undefined,
): number {
  if (watermark !== undefined) {
    const at = branch.findIndex((entry) => entry.id === watermark);
    if (at >= 0) return at + 1;
  }
  // Entries before the latest fold were captured into the ledger it carries.
  return branch.findLastIndex((entry) => entry.type === "branch_summary") + 1;
}

/** Anchor name in force at each branch index: the latest `anchor:` label target strictly before it. */
function anchorAt(
  branch: readonly SessionEntry[],
): (index: number) => string | undefined {
  const positions = new Map(branch.map((entry, i) => [entry.id, i] as const));
  const labels = new Map<string, string | undefined>();
  for (const entry of branch) {
    if (entry.type === "label") labels.set(entry.targetId, entry.label);
  }
  const anchors: { index: number; name: string }[] = [];
  for (const [targetId, label] of labels) {
    const index = positions.get(targetId);
    const name = label?.startsWith(LABEL_PREFIX)
      ? label.slice(LABEL_PREFIX.length)
      : undefined;
    if (index !== undefined && isValidName(name)) anchors.push({ index, name });
  }
  anchors.sort((a, b) => a.index - b.index);
  return (index) => anchors.findLast((anchor) => anchor.index < index)?.name;
}

const ASK_PREFIX = "Q: ";
const ASK_JOINER = " → A: ";

function askQuestionText(question: string, answer: string): string {
  const budget =
    MAX_ITEM_TEXT_CHARS - ASK_PREFIX.length - ASK_JOINER.length - answer.length;
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
  return (
    cut >= 0 &&
    question.length > cut &&
    question.startsWith(stored.slice(0, cut))
  );
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

function userCandidate(
  entry: SessionEntry,
  index: number,
): Candidate | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return undefined;
  }
  const text = extractTextContent(entry.message.content).trim();
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
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
  const unchanged = earlier.some(
    (old) => normalizeText(old.text) === normalizeText(answer.text),
  );
  if (earlier.length === 0 || unchanged)
    return { op: { op: "add", ...item }, ctx };
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
  if (
    kind === "objective" &&
    state.objective &&
    !named.includes(state.objective.id ?? "")
  ) {
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
    const candidate = captured.has(entry.id)
      ? undefined
      : userCandidate(entry, index);
    return candidate ? [candidate] : [];
  });

  const active = new Map(
    ledger.items
      .filter(
        (item) => item.status === "active" && SUPERSEDABLE_KINDS.has(item.kind),
      )
      .map((item) => [item.id, item] as const),
  );
  const activeItems = [...active.values()].map(({ id, kind, text }) => ({
    id,
    kind,
    text,
  }));
  const anchorFor = anchorAt(branch);
  const verdicts = await mapPool(
    candidates,
    CLASSIFY_CONCURRENCY,
    async (c) => {
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
    },
  );
  if (opts.signal?.aborted) return { ...done([], 0), watermark };

  for (const verdict of verdicts) {
    if (verdict?.warning !== undefined) warnings.add(verdict.warning);
  }
  const classified = new Map(
    candidates.map((c, i) => [
      c.entryId,
      { candidate: c, verdict: verdicts[i] },
    ]),
  );
  const userEntries = new Map(
    branch.flatMap((entry, i) =>
      entry.type === "message" && entry.message.role === "user"
        ? [[entry.id, i] as const]
        : [],
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
  const answers = new Map(
    fresh.map(({ entry }) => [entry.id, askUserAnswers(entry)] as const),
  );
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
    const op = userOp(
      hit.verdict,
      hit.candidate,
      anchorFor(index),
      active,
      state,
      userEntryIndex,
    );
    if (op) ops.push(op);
  }
  return done(ops, candidates.length);
}
