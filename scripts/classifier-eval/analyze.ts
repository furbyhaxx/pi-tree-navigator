/**
 * Offline analysis of recorded classifier benchmark observations.
 *
 * Reads run directories (`observations.jsonl`, `run.json`), scores every
 * observation with the shared scoring contract and writes `report.json` and
 * `report.md`: per model/task/split results, confidence threshold sweeps,
 * offline pipelines (chains, confirm-chains, votes, the shipped model plus
 * heuristic fallback) replayed from recorded answers, and a ranking. No
 * provider is ever called.
 *
 *   node scripts/classifier-eval/analyze.ts --runs a,b --out report-dir
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createModelClassifier,
  DEFAULT_MIN_CONFIDENCE,
  heuristicClassifier,
  type IntentInput,
  type IntentVerdict,
} from "../../extensions/navigate-tree/continuity-capture.ts";
import { prepareCase } from "./prepare.ts";
import { scoreObservation, summarizeScores } from "./scoring.ts";
import type {
  AnswerScore,
  CaseScore,
  CostSource,
  EvalAdapter,
  EvalCase,
  EvalObservation,
  EvalTask,
  PreparedCase,
} from "./types.ts";

type Split = EvalCase["split"];
type Summary = ReturnType<typeof summarizeScores>;

const SPLITS: readonly Split[] = ["development", "holdout"];
const TASKS: readonly EvalTask[] = [
  "intent",
  "supersession",
  "milestone-status",
  "milestone-boundary",
];
const ADAPTERS: readonly string[] = ["decisions", "chat", "heuristic"];
const STATUSES: readonly string[] = ["ok", "error", "unsupported"];
const COST_SOURCES: readonly CostSource[] = [
  "generation",
  "response",
  "local",
  "subscription",
  "unknown",
];

/** A task result with fewer distinct cases than this is marked insufficient. */
export const MIN_CASES = 8;
/** Confidence gates swept per model and question: 0.50, 0.55 ... 0.95. */
export const THRESHOLDS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => (50 + 5 * i) / 100,
);
export const DEFAULT_TOP = 4;
const NO_CONTRADICTION = "none";
const REPLAY_MODEL = "replay/recorded";

export const RANKING_RULE: readonly string[] = [
  "sufficient evidence (holdout n >= minimum) before insufficient",
  "fewer unsafe accepted decisions on holdout (zero first)",
  "higher accepted-exact rate on holdout",
  "lower cost per 1,000 decisions (actual where known, bound otherwise)",
  "lower p95 latency",
];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Provenance of one loaded run directory; `meta` keeps only top-level scalars of run.json. */
export interface RunInfo {
  dir: string;
  observations: number;
  meta: Record<string, string | number | boolean> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObservation(value: unknown, where: string): EvalObservation {
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (!isRecord(value)) return fail("observation is not an object");
  const finite = (key: string) =>
    typeof value[key] === "number" && Number.isFinite(value[key]);
  if (typeof value.caseId !== "string" || value.caseId === "")
    fail("caseId must be a non-empty string");
  if (typeof value.model !== "string" || value.model === "")
    fail("model must be a non-empty string");
  if (typeof value.adapter !== "string" || !ADAPTERS.includes(value.adapter))
    fail("adapter must be decisions, chat or heuristic");
  if (!Number.isInteger(value.repetition) || (value.repetition as number) < 0)
    fail("repetition must be a nonnegative integer");
  if (typeof value.status !== "string" || !STATUSES.includes(value.status))
    fail("status must be ok, error or unsupported");
  if (!finite("durationMs") || (value.durationMs as number) < 0)
    fail("durationMs must be a nonnegative number");
  if (value.costUsd !== null && !finite("costUsd"))
    fail("costUsd must be a number or null");
  if (
    typeof value.costSource !== "string" ||
    !COST_SOURCES.includes(value.costSource as CostSource)
  )
    fail("costSource is not recognised");
  if (!finite("costBoundUsd") || (value.costBoundUsd as number) < 0)
    fail("costBoundUsd must be a nonnegative number");
  if (!isRecord(value.answers)) fail("answers must be an object");
  for (const [question, answer] of Object.entries(
    value.answers as Record<string, unknown>,
  ))
    if (!isRecord(answer) || typeof answer.choice !== "string")
      fail(`answer ${question} has no string choice`);
  return value as unknown as EvalObservation;
}

/** Parse one observations.jsonl body; blank lines are ignored, malformed lines throw. */
export function parseObservations(
  text: string,
  source: string,
): EvalObservation[] {
  const out: EvalObservation[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `${source}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${where}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    out.push(parseObservation(parsed, where));
  });
  return out;
}

/** Load one run directory. */
export async function loadRun(
  dir: string,
): Promise<{ info: RunInfo; observations: EvalObservation[] }> {
  const observations = parseObservations(
    await readFile(join(dir, "observations.jsonl"), "utf8"),
    join(dir, "observations.jsonl"),
  );
  let meta: RunInfo["meta"] = null;
  try {
    const run: unknown = JSON.parse(
      await readFile(join(dir, "run.json"), "utf8"),
    );
    if (isRecord(run))
      meta = Object.fromEntries(
        Object.entries(run).filter(
          (entry): entry is [string, string | number | boolean] =>
            ["string", "number", "boolean"].includes(typeof entry[1]),
        ),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    info: { dir, observations: observations.length, meta },
    observations,
  };
}

async function loadCases(): Promise<PreparedCase[]> {
  // cases.ts is only needed by the CLI; tests inject their own cases.
  const module: { CASES?: readonly EvalCase[] } = await import(
    new URL("./cases.ts", import.meta.url).href
  );
  if (!Array.isArray(module.CASES))
    throw new Error("cases.ts does not export CASES");
  return module.CASES.map((fixture) => prepareCase(fixture));
}

// ---------------------------------------------------------------------------
// Metrics shared by models and pipelines
// ---------------------------------------------------------------------------

/** Cost per 1,000 decisions; `basis` says how much of it is a bound rather than a recorded cost. */
export interface CostPer1000 {
  usd: number | null;
  basis: "actual" | "mixed" | "bound";
  /** Decisions with at least one call of unknown cost (priced at its reserved bound). */
  unknownDecisions: number;
}

/** Decision-level measurements of one model or pipeline on one task and split. */
export interface Metrics {
  /** Scored decisions plus one failed decision per missing case and repetition. */
  decisions: number;
  /** Distinct cases scored. */
  cases: number;
  /** Scored decisions that were not errors or unsupported. */
  okDecisions: number;
  expectedCases: number;
  missingCases: number;
  questions: number;
  accepted: number;
  coverage: number | null;
  selectiveAccuracy: number | null;
  unsafeAccepted: number;
  acceptedExactCases: number;
  /** Accepted-exact decisions over `decisions`. */
  acceptedExactRate: number | null;
  errors: number;
  unsupported: number;
  costPer1000: CostPer1000;
  latency: Summary["latency"];
  callsPerDecision?: number;
  escalationReasons?: Record<EscalationReason, number>;
  /** Replay only: verdicts produced by the heuristic fallback rather than the model. */
  fallbackVerdicts?: number;
}

function costPer1000(summary: Summary, decisions: number): CostPer1000 {
  const { unknownCalls, boundUsd } = summary.cost;
  return {
    usd: decisions === 0 ? null : (boundUsd / decisions) * 1000,
    basis:
      unknownCalls === 0
        ? "actual"
        : unknownCalls === decisions
          ? "bound"
          : "mixed",
    unknownDecisions: unknownCalls,
  };
}

function metricsFrom(
  scores: readonly CaseScore[],
  expectedCases: number,
  summary: Summary = summarizeScores(scores),
): Metrics | null {
  if (expectedCases === 0 && scores.length === 0) return null;
  const cases = new Set(scores.map((score) => score.caseId)).size;
  const missingCases = Math.max(0, expectedCases - cases);
  const repetitions =
    cases === 0 ? 1 : Math.max(1, Math.round(scores.length / cases));
  const decisions = scores.length + missingCases * repetitions;
  return {
    decisions,
    cases,
    okDecisions: scores.filter((score) => score.status === "ok").length,
    expectedCases,
    missingCases,
    questions: summary.questions,
    accepted: summary.accepted,
    coverage: summary.coverage,
    selectiveAccuracy: summary.selectiveAccuracy,
    unsafeAccepted: summary.unsafeAccepted,
    acceptedExactCases: summary.acceptedExactCases,
    acceptedExactRate:
      decisions === 0 ? null : summary.acceptedExactCases / decisions,
    errors: summary.errors,
    unsupported: summary.unsupported,
    costPer1000: costPer1000(summary, scores.length),
    latency: summary.latency,
  };
}

interface Ordered {
  unsafeAccepted: number;
  acceptedExactRate: number | null;
  costUsd: number | null;
  p95Ms: number | null;
  id: string;
}

const orderKey = (metrics: Metrics | null, id: string): Ordered => ({
  unsafeAccepted: metrics?.unsafeAccepted ?? Number.POSITIVE_INFINITY,
  acceptedExactRate: metrics?.acceptedExactRate ?? null,
  costUsd: metrics?.costPer1000.usd ?? null,
  p95Ms: metrics?.latency.p95Ms ?? null,
  id,
});

const ascNullLast = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/** The lexicographic rule after the evidence check: unsafe, accepted-exact, cost, p95, id. */
function compareOrdered(a: Ordered, b: Ordered): number {
  return (
    (a.unsafeAccepted === b.unsafeAccepted
      ? 0
      : a.unsafeAccepted < b.unsafeAccepted
        ? -1
        : 1) ||
    ascNullLast(
      a.acceptedExactRate === null ? null : -a.acceptedExactRate,
      b.acceptedExactRate === null ? null : -b.acceptedExactRate,
    ) ||
    ascNullLast(a.costUsd, b.costUsd) ||
    ascNullLast(a.p95Ms, b.p95Ms) ||
    a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// Observations as decision attempts
// ---------------------------------------------------------------------------

interface Vote {
  valid: boolean;
  accepted: boolean;
  correct: boolean;
  unsafe: boolean;
  choice?: string;
}

interface Call {
  status: EvalObservation["status"];
  durationMs: number;
  costUsd: number | null;
  costBoundUsd: number;
}

interface Attempt {
  call: Call;
  votes: ReadonlyMap<string, Vote>;
}

interface Scored {
  prepared: PreparedCase;
  observation: EvalObservation;
  score: CaseScore;
  attempt: Attempt;
}

const NO_VOTE: Vote = {
  valid: false,
  accepted: false,
  correct: false,
  unsafe: false,
};

const keyOf = (caseId: string, repetition: number) =>
  `${caseId}\u0000${repetition}`;

function scoreAttempt(
  prepared: PreparedCase,
  observation: EvalObservation,
  minConfidence: number,
): Scored {
  const score = scoreObservation(prepared, observation, minConfidence);
  const votes = new Map<string, Vote>();
  for (const answer of score.answers)
    votes.set(answer.question, {
      valid: answer.valid,
      accepted: answer.accepted,
      correct: answer.correct,
      unsafe: answer.unsafe,
      ...(answer.valid && {
        choice: observation.answers[answer.question]?.choice,
      }),
    });
  return {
    prepared,
    observation,
    score,
    attempt: {
      call: {
        status: observation.status,
        durationMs: observation.durationMs,
        costUsd: observation.costUsd,
        costBoundUsd: observation.costBoundUsd,
      },
      votes,
    },
  };
}

// ---------------------------------------------------------------------------
// Offline policies
// ---------------------------------------------------------------------------

export type PolicyKind =
  | "single"
  | "replay"
  | "chain"
  | "confirm"
  | "vote"
  | "baseline";
/** What each pipeline kind does, as replayed from recorded answers. */
export const POLICY_KINDS: Record<PolicyKind, string> = {
  single: "One model behind the confidence gate; abstentions make no decision.",
  chain:
    "A then B: B is consulted only for questions A did not accept (abstained, invalid, error or unsupported); cost adds up and latency sums.",
  confirm:
    "A's accepted answer stands only when B accepts the same choice; B is consulted only when A accepted something.",
  vote: "Three models in parallel (latency is the slowest); an answer stands when at least two accept the same choice.",
  replay:
    "The shipped createModelClassifier fed the recorded answers: abstention or failure falls back to the heuristic, which never supersedes; every verdict commits.",
  baseline:
    "No classifier model configured: the shipped heuristic alone decides.",
};
export type EscalationReason = "abstain" | "invalid" | "error" | "unsupported";

interface Final {
  question: string;
  valid: boolean;
  accepted: boolean;
  correct: boolean;
  unsafe: boolean;
}

interface Outcome {
  finals: Final[];
  /** Indexes of the members whose recorded call this decision paid for. */
  consulted: number[];
  escalation?: EscalationReason;
}

interface PolicyInfo {
  id: string;
  kind: PolicyKind;
  members: string[];
  /** The decisions include the shipped heuristic fallback. */
  fallback: boolean;
}

/** A policy that combines recorded attempts of its members. */
interface Policy extends PolicyInfo {
  /** Escalating chains run members one after another; a vote runs them in parallel. */
  latency: "sum" | "max";
  combine: (
    attempts: readonly Attempt[],
    questions: readonly string[],
  ) => Outcome;
}

const vote = (attempt: Attempt, question: string): Vote =>
  attempt.votes.get(question) ?? NO_VOTE;

const take = (question: string, v: Vote): Final => ({
  question,
  valid: true,
  accepted: true,
  correct: v.correct,
  unsafe: v.unsafe,
});

// An abstained or failed question: `valid` keeps invalid output apart from abstention.
const withhold = (question: string, valid: boolean): Final => ({
  question,
  valid,
  accepted: false,
  correct: false,
  unsafe: false,
});

function whyNotAccepted(
  attempt: Attempt,
  questions: readonly string[],
): EscalationReason | undefined {
  if (questions.every((q) => vote(attempt, q).accepted)) return undefined;
  if (attempt.call.status === "error") return "error";
  if (attempt.call.status === "unsupported") return "unsupported";
  return questions.some((q) => !vote(attempt, q).valid) ? "invalid" : "abstain";
}

const singleInfo = (model: string): PolicyInfo => ({
  id: `single(${model})`,
  kind: "single",
  members: [model],
  fallback: false,
});

const chain = (first: string, second: string): Policy => ({
  id: `chain(${first} > ${second})`,
  kind: "chain",
  fallback: false,
  members: [first, second],
  latency: "sum",
  combine: ([a, b], questions) => {
    const escalation = whyNotAccepted(a, questions);
    return {
      finals: questions.map((q) => {
        const va = vote(a, q);
        if (va.accepted) return take(q, va);
        const vb = vote(b, q);
        return vb.accepted ? take(q, vb) : withhold(q, va.valid || vb.valid);
      }),
      consulted: escalation === undefined ? [0] : [0, 1],
      ...(escalation !== undefined && { escalation }),
    };
  },
});

const confirm = (first: string, second: string): Policy => ({
  id: `confirm(${first} + ${second})`,
  kind: "confirm",
  fallback: false,
  members: [first, second],
  latency: "sum",
  combine: ([a, b], questions) => {
    if (!questions.some((q) => vote(a, q).accepted))
      return {
        finals: questions.map((q) => withhold(q, vote(a, q).valid)),
        consulted: [0],
      };
    return {
      finals: questions.map((q) => {
        const va = vote(a, q);
        const vb = vote(b, q);
        return va.accepted && vb.accepted && va.choice === vb.choice
          ? take(q, va)
          : withhold(q, va.valid || vb.valid);
      }),
      consulted: [0, 1],
    };
  },
});

const majority = (models: string[]): Policy => ({
  id: `vote(${models.join(", ")})`,
  kind: "vote",
  fallback: false,
  members: models,
  latency: "max",
  combine: (attempts, questions) => ({
    finals: questions.map((q) => {
      const votes = attempts.map((a) => vote(a, q));
      for (const v of votes)
        if (
          v.accepted &&
          votes.filter((o) => o.accepted && o.choice === v.choice).length >=
            Math.floor(votes.length / 2) + 1
        )
          return take(q, v);
      return withhold(
        q,
        votes.some((v) => v.valid),
      );
    }),
    consulted: attempts.map((_, index) => index),
  }),
});

function sumCalls(calls: readonly Call[], latency: Policy["latency"]) {
  const times = calls.map((call) => call.durationMs);
  return {
    durationMs:
      latency === "sum"
        ? times.reduce((a, b) => a + b, 0)
        : Math.max(0, ...times),
    costUsd: calls.some((call) => call.costUsd === null)
      ? null
      : calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
    costBoundUsd: calls.reduce(
      (sum, call) => sum + (call.costUsd ?? call.costBoundUsd),
      0,
    ),
  };
}

function callsStatus(calls: readonly Call[]): CaseScore["status"] {
  if (calls.some((call) => call.status === "ok")) return "ok";
  return calls.some((call) => call.status === "error")
    ? "error"
    : "unsupported";
}

function policyScore(
  prepared: PreparedCase,
  policy: Pick<Policy, "id" | "latency">,
  repetition: number,
  finals: readonly Final[],
  calls: readonly Call[],
): CaseScore {
  const answers: AnswerScore[] = finals.map((final) => ({ ...final }));
  const acceptedExact =
    answers.length > 0 && answers.every((a) => a.correct && a.accepted);
  return {
    caseId: prepared.id,
    task: prepared.task,
    split: prepared.split,
    model: policy.id,
    repetition,
    status: callsStatus(calls),
    answers,
    exact: acceptedExact,
    acceptedExact,
    unsafeAccepted: answers.filter((a) => a.unsafe && a.accepted).length,
    ...sumCalls(calls, policy.latency),
  };
}

/** What one policy produced on one set of cases. */
interface PolicyRun {
  scores: CaseScore[];
  calls: number;
  escalationReasons: Record<EscalationReason, number>;
  /** Replay only: verdicts the heuristic fallback produced. */
  fallbackVerdicts?: number;
}

const noReasons = (): Record<EscalationReason, number> => ({
  abstain: 0,
  invalid: 0,
  error: 0,
  unsupported: 0,
});

/** Run a policy over the (case, repetition) pairs every member recorded. */
function runPolicy(
  policy: Policy,
  cases: readonly PreparedCase[],
  attempts: ReadonlyMap<string, ReadonlyMap<string, Attempt>>,
): PolicyRun {
  const run: PolicyRun = {
    scores: [],
    calls: 0,
    escalationReasons: noReasons(),
  };
  const lead = attempts.get(policy.members[0]);
  if (!lead) return run;
  for (const prepared of cases) {
    const questions = Object.keys(prepared.expected);
    for (const key of lead.keys()) {
      if (!key.startsWith(`${prepared.id}\u0000`)) continue;
      const members = policy.members.map((model) =>
        attempts.get(model)?.get(key),
      );
      if (members.some((m) => m === undefined)) continue;
      const chosen = members as Attempt[];
      const outcome = policy.combine(chosen, questions);
      const calls = outcome.consulted.map((index) => chosen[index].call);
      const repetition = Number(key.slice(prepared.id.length + 1));
      run.scores.push(
        policyScore(prepared, policy, repetition, outcome.finals, calls),
      );
      run.calls += calls.length;
      if (outcome.escalation) run.escalationReasons[outcome.escalation]++;
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Production replay: recorded answers through the shipped classifier
// ---------------------------------------------------------------------------

function intentInput(prepared: PreparedCase): IntentInput {
  if (prepared.input.type !== "intent")
    throw new Error(`${prepared.id}: replay needs an intent case`);
  const { message, activeAnchor, activeItems } = prepared.input;
  return {
    entryId: prepared.id,
    text: message,
    ...(activeAnchor !== undefined && { activeAnchor }),
    activeItems,
  };
}

// Invalid recorded answers are left out, so the shipped code sees them as unusable.
function recordedResult(
  prepared: PreparedCase,
  observation: EvalObservation,
): ClassifierResult {
  const answers: Record<string, unknown> = {};
  if (observation.status === "ok")
    for (const answer of scoreObservation(prepared, observation).answers) {
      const recorded = observation.answers[answer.question];
      if (answer.valid && recorded)
        answers[answer.question] = {
          type: "choice",
          choice: recorded.choice,
          probabilities: {},
          confidence: recorded.confidence ?? 0,
        };
    }
  return {
    api: "recorded",
    provider: "replay",
    model: "recorded",
    answers,
    stopReason: observation.status === "ok" ? "stop" : "error",
    ...(observation.status !== "ok" && {
      errorMessage: observation.error ?? observation.status,
    }),
    timestamp: 0,
  } as unknown as ClassifierResult;
}

/**
 * The verdict the shipped `createModelClassifier` reaches for one recorded
 * observation: its confidence gate, abstention handling and heuristic
 * fallback, with a fresh instance per decision. An unsupported model is an
 * unknown registry model, so capture uses the heuristic classifier alone.
 */
export async function replayVerdict(
  prepared: PreparedCase,
  observation: EvalObservation,
  minConfidence: number,
): Promise<IntentVerdict> {
  const registry = {
    getModelOfType: (_type: string, provider: string, id: string) =>
      observation.status === "unsupported" ? undefined : { provider, id },
    classify: async () => recordedResult(prepared, observation),
  } as unknown as Pick<ModelRegistry, "getModelOfType" | "classify">;
  const classifier =
    (await createModelClassifier(registry, REPLAY_MODEL, {
      minConfidence,
      onWarning: () => {},
    })) ?? heuristicClassifier;
  return classifier(intentInput(prepared));
}

// A verdict always commits, so every scored answer counts as accepted.
function verdictScore(
  prepared: PreparedCase,
  verdict: IntentVerdict,
  policy: Pick<Policy, "id" | "latency">,
  repetition: number,
  calls: readonly Call[],
): CaseScore {
  const chosen: Record<string, string> = {
    kind: verdict.kind,
    contradicts: verdict.supersedes?.[0] ?? NO_CONTRADICTION,
  };
  const finals = Object.entries(prepared.expected).map(
    ([question, expected]) => {
      const choice = chosen[question];
      if (choice === undefined)
        throw new Error(
          `${prepared.id}: replay cannot score question ${question}`,
        );
      return {
        question,
        valid: true,
        accepted: true,
        correct: expected.choices.includes(choice),
        unsafe: expected.unsafeChoices.includes(choice),
      };
    },
  );
  return policyScore(prepared, policy, repetition, finals, calls);
}

const replayInfo = (model: string): PolicyInfo => ({
  id: `replay(${model})`,
  kind: "replay",
  members: [model],
  fallback: true,
});

const heuristicInfo: PolicyInfo = {
  id: "heuristic-only",
  kind: "baseline",
  members: [],
  fallback: true,
};

const LOCAL_CALL: Call = {
  status: "ok",
  durationMs: 0,
  costUsd: 0,
  costBoundUsd: 0,
};

/** Replay the intent cases through the shipped classifier; no `model` means the heuristic alone. */
async function runReplay(
  info: PolicyInfo,
  model: string | undefined,
  cases: readonly PreparedCase[],
  observations: ReadonlyMap<string, ReadonlyMap<string, EvalObservation>>,
  minConfidence: number,
): Promise<PolicyRun> {
  const policy = { id: info.id, latency: "sum" } as const;
  const run: PolicyRun = {
    scores: [],
    calls: 0,
    escalationReasons: noReasons(),
    fallbackVerdicts: 0,
  };
  for (const prepared of cases) {
    if (prepared.input.type !== "intent") continue;
    if (model === undefined) {
      const verdict = await heuristicClassifier(intentInput(prepared));
      run.scores.push(verdictScore(prepared, verdict, policy, 0, [LOCAL_CALL]));
      continue;
    }
    for (const [key, observation] of observations.get(model) ?? []) {
      if (!key.startsWith(`${prepared.id}\u0000`)) continue;
      const verdict = await replayVerdict(prepared, observation, minConfidence);
      const call: Call = {
        status: observation.status,
        durationMs: observation.durationMs,
        costUsd: observation.costUsd,
        costBoundUsd: observation.costBoundUsd,
      };
      run.scores.push(
        verdictScore(prepared, verdict, policy, observation.repetition, [call]),
      );
      run.calls++;
      if (verdict.by === "heuristic")
        run.fallbackVerdicts = (run.fallbackVerdicts ?? 0) + 1;
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Per-model detail
// ---------------------------------------------------------------------------

/** Counts for one question; abstained means valid but below the gate, never invalid. */
export interface QuestionStats {
  questions: number;
  valid: number;
  invalid: number;
  accepted: number;
  abstained: number;
  rawCorrect: number;
  acceptedCorrect: number;
  unsafeRaw: number;
  unsafeAccepted: number;
}

const emptyStats = (): QuestionStats => ({
  questions: 0,
  valid: 0,
  invalid: 0,
  accepted: 0,
  abstained: 0,
  rawCorrect: 0,
  acceptedCorrect: 0,
  unsafeRaw: 0,
  unsafeAccepted: 0,
});

function questionStats(
  scores: readonly CaseScore[],
): Record<string, QuestionStats> {
  const stats: Record<string, QuestionStats> = {};
  for (const score of scores)
    for (const answer of score.answers) {
      const s = stats[answer.question] ?? emptyStats();
      stats[answer.question] = s;
      s.questions++;
      if (answer.valid) s.valid++;
      else s.invalid++;
      if (answer.accepted) s.accepted++;
      if (answer.valid && !answer.accepted) s.abstained++;
      if (answer.correct) s.rawCorrect++;
      if (answer.correct && answer.accepted) s.acceptedCorrect++;
      if (answer.unsafe) s.unsafeRaw++;
      if (answer.unsafe && answer.accepted) s.unsafeAccepted++;
    }
  return stats;
}

/** Agreement across repetitions of the same case; only cases with two or more count. */
export interface Consistency {
  casesWithRepeats: number;
  fullyAgreeingCases: number;
  agreementRate: number | null;
  /** Share of repetition pairs that gave the same answer to a question (invalid = its own answer). */
  pairwiseQuestionAgreement: number | null;
}

function consistency(items: readonly Scored[]): Consistency {
  const byCase = new Map<string, Scored[]>();
  for (const item of items)
    byCase.set(item.prepared.id, [
      ...(byCase.get(item.prepared.id) ?? []),
      item,
    ]);
  let casesWithRepeats = 0;
  let fullyAgreeingCases = 0;
  let pairs = 0;
  let agreeing = 0;
  for (const group of byCase.values()) {
    if (group.length < 2) continue;
    casesWithRepeats++;
    const signatures = group.map((item) =>
      Object.keys(item.prepared.expected).map((q) =>
        item.attempt.votes.get(q)?.valid
          ? (item.attempt.votes.get(q)?.choice ?? "")
          : "\u0000invalid",
      ),
    );
    if (
      signatures.every((s) => s.join("\u0001") === signatures[0].join("\u0001"))
    )
      fullyAgreeingCases++;
    for (let i = 0; i < signatures.length; i++)
      for (let j = i + 1; j < signatures.length; j++)
        signatures[i].forEach((choice, q) => {
          pairs++;
          if (choice === signatures[j][q]) agreeing++;
        });
  }
  return {
    casesWithRepeats,
    fullyAgreeingCases,
    agreementRate:
      casesWithRepeats === 0 ? null : fullyAgreeingCases / casesWithRepeats,
    pairwiseQuestionAgreement: pairs === 0 ? null : agreeing / pairs,
  };
}

/** One model on one task and split at the analysis confidence gate. */
export interface ModelSplitRow {
  metrics: Metrics;
  summary: Summary;
  perQuestion: Record<string, QuestionStats>;
  abstentionRate: number | null;
  invalidRate: number | null;
  costSources: Record<CostSource, number>;
  consistency: Consistency;
  insufficient: boolean;
}

function modelSplitRow(
  items: readonly Scored[],
  expectedCases: number,
  minCases: number,
): ModelSplitRow | null {
  const scores = items.map((item) => item.score);
  const summary = summarizeScores(scores);
  const metrics = metricsFrom(scores, expectedCases, summary);
  if (metrics === null) return null;
  const perQuestion = questionStats(scores);
  const totals = Object.values(perQuestion).reduce(
    (sum, s) => ({
      questions: sum.questions + s.questions,
      abstained: sum.abstained + s.abstained,
      invalid: sum.invalid + s.invalid,
    }),
    { questions: 0, abstained: 0, invalid: 0 },
  );
  const costSources = Object.fromEntries(
    COST_SOURCES.map((source) => [
      source,
      items.filter((item) => item.observation.costSource === source).length,
    ]),
  ) as Record<CostSource, number>;
  return {
    metrics,
    summary,
    perQuestion,
    abstentionRate:
      totals.questions === 0 ? null : totals.abstained / totals.questions,
    invalidRate:
      totals.questions === 0 ? null : totals.invalid / totals.questions,
    costSources,
    consistency: consistency(items),
    insufficient: metrics.cases < minCases,
  };
}

// ---------------------------------------------------------------------------
// Threshold sweeps
// ---------------------------------------------------------------------------

/** Gate outcome for one question, pooled over the cases of a split. */
export interface SweepMetrics {
  answers: number;
  accepted: number;
  coverage: number | null;
  selectiveAccuracy: number | null;
  unsafeAccepted: number;
}

/** The development-selected gate and how it fares, untouched, on holdout. */
export interface SweepSelection {
  threshold: number | null;
  reason: string;
  /** No development answer chose an unsafe option, so the gate was never tested. */
  vacuous: boolean;
  insufficient: boolean;
  development: SweepMetrics | null;
  holdout: SweepMetrics | null;
}

export interface SweepRow {
  model: string;
  question: string;
  cases: Record<Split, number>;
  unsafeRaw: Record<Split, number>;
  points: {
    threshold: number;
    development: SweepMetrics | null;
    holdout: SweepMetrics | null;
  }[];
  selected: SweepSelection;
}

function onlyQuestion(
  score: CaseScore,
  question: string,
): CaseScore | undefined {
  const answers = score.answers.filter((a) => a.question === question);
  if (answers.length === 0) return undefined;
  const acceptedExact = answers.every((a) => a.correct && a.accepted);
  return {
    ...score,
    answers,
    exact: answers.every((a) => a.correct),
    acceptedExact,
    unsafeAccepted: answers.filter((a) => a.unsafe && a.accepted).length,
  };
}

function sweepRow(
  model: string,
  question: string,
  items: readonly Scored[],
  minCases: number,
): SweepRow {
  const relevant = items.filter((item) => question in item.prepared.expected);
  const at = (threshold: number, split: Split): SweepMetrics | null => {
    const scores = relevant
      .filter((item) => item.prepared.split === split)
      .flatMap((item) => {
        const scored = onlyQuestion(
          scoreObservation(item.prepared, item.observation, threshold),
          question,
        );
        return scored ? [scored] : [];
      });
    if (scores.length === 0) return null;
    const summary = summarizeScores(scores);
    return {
      answers: summary.questions,
      accepted: summary.accepted,
      coverage: summary.coverage,
      selectiveAccuracy: summary.selectiveAccuracy,
      unsafeAccepted: summary.unsafeAccepted,
    };
  };
  const points = THRESHOLDS.map((threshold) => ({
    threshold,
    development: at(threshold, "development"),
    holdout: at(threshold, "holdout"),
  }));
  const countCases = (split: Split) =>
    new Set(
      relevant
        .filter((i) => i.prepared.split === split)
        .map((i) => i.prepared.id),
    ).size;
  const unsafeRaw = (split: Split) =>
    relevant
      .filter((i) => i.prepared.split === split)
      .reduce(
        (sum, i) => sum + (i.attempt.votes.get(question)?.unsafe ? 1 : 0),
        0,
      );
  const cases = {
    development: countCases("development"),
    holdout: countCases("holdout"),
  };
  // Only development decides the gate; holdout is read off the chosen point.
  const chosen = points.find((p) => p.development?.unsafeAccepted === 0);
  const hasDevelopment = points.some((p) => p.development !== null);
  const selected: SweepSelection = {
    threshold: chosen?.threshold ?? null,
    reason: !hasDevelopment
      ? "no development data"
      : chosen
        ? "lowest threshold with zero unsafe accepted on development"
        : `no threshold up to ${THRESHOLDS[THRESHOLDS.length - 1]} reaches zero unsafe accepted on development`,
    vacuous: hasDevelopment && unsafeRaw("development") === 0,
    insufficient: cases.development < minCases,
    development: chosen?.development ?? null,
    holdout: chosen?.holdout ?? null,
  };
  return {
    model,
    question,
    cases,
    unsafeRaw: {
      development: unsafeRaw("development"),
      holdout: unsafeRaw("holdout"),
    },
    points,
    selected,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** A model or pipeline on one task, with both splits side by side. */
export interface RankRow {
  id: string;
  kind: PolicyKind;
  members: string[];
  /** The row's decisions include the shipped heuristic fallback. */
  fallback: boolean;
  development: Metrics | null;
  holdout: Metrics | null;
  /** Distinct holdout cases scored. */
  n: number;
  insufficient: boolean;
  insufficientReason?: string;
  rank: number;
}

function rankRows(rows: Omit<RankRow, "rank">[]): RankRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      Number(a.insufficient) - Number(b.insufficient) ||
      compareOrdered(orderKey(a.holdout, a.id), orderKey(b.holdout, b.id)),
  );
  return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
}

function rankRow(
  base: PolicyInfo,
  development: Metrics | null,
  holdout: Metrics | null,
  minCases: number,
): Omit<RankRow, "rank"> {
  const n = holdout?.cases ?? 0;
  return {
    ...base,
    development,
    holdout,
    n,
    insufficient: n < minCases,
    ...(n < minCases && {
      insufficientReason: `holdout n=${n} < ${minCases}`,
    }),
  };
}

/** A pick from a ranking; `status` says whether it clears the safety bar. */
export interface Recommendation {
  status:
    | "recommended"
    | "no-safe-candidate"
    | "insufficient-evidence"
    | "no-data";
  /** Id of the picked row in `ranking`; null when there is nothing to pick. */
  id: string | null;
  note: string;
}

function recommend(rows: readonly RankRow[]): Recommendation {
  const best = rows.find((row) => !row.insufficient);
  if (best) {
    const unsafe = best.holdout?.unsafeAccepted ?? 0;
    return unsafe === 0
      ? {
          status: "recommended",
          id: best.id,
          note: "Best sufficient row; zero unsafe accepted on holdout.",
        }
      : {
          status: "no-safe-candidate",
          id: best.id,
          note: `No sufficient row has zero unsafe accepted on holdout; fewest is ${unsafe}.`,
        };
  }
  return rows.length === 0
    ? { status: "no-data", id: null, note: "No observations for this task." }
    : {
        status: "insufficient-evidence",
        id: rows[0].id,
        note: "Every row has too few holdout cases; the first row is provisional.",
      };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Candidate {
  info: PolicyInfo;
  run: (cases: readonly PreparedCase[]) => Promise<PolicyRun>;
}

export interface AnalyzeOptions {
  /** Confidence gate for rankings and policies; defaults to the shipped gate. */
  minConfidence?: number;
  /** Single models kept per task for policy enumeration. */
  top?: number;
  minCases?: number;
}

export interface TaskReport {
  cases: Record<Split, number>;
  models: {
    model: string;
    adapter: EvalAdapter;
    development: ModelSplitRow | null;
    holdout: ModelSplitRow | null;
  }[];
  sweeps: SweepRow[];
  selection: {
    criterion: string;
    top: number;
    included: string[];
    excluded: { model: string; reason: string }[];
    notes: string[];
  };
  ranking: { singles: RankRow[]; pipelines: RankRow[] };
  recommendation: { single: Recommendation; pipeline: Recommendation };
}

export interface Report {
  version: 1;
  config: {
    minConfidence: number;
    top: number;
    minCases: number;
    thresholds: readonly number[];
    rankingRule: readonly string[];
    policyKinds: Record<PolicyKind, string>;
  };
  runs: RunInfo[];
  dataQuality: {
    observations: number;
    models: string[];
    unknownCaseObservations: number;
    unknownCaseIds: string[];
    duplicateObservations: number;
    duplicateCostUsd: number;
  };
  tasks: Partial<Record<EvalTask, TaskReport>>;
  limitations: string[];
}

const SELECTION_CRITERION =
  "the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted";

function selectModels(
  models: readonly string[],
  development: ReadonlyMap<string, Metrics | null>,
  top: number,
  minCases: number,
) {
  const usable = (model: string) => {
    const metrics = development.get(model);
    return (metrics?.cases ?? 0) >= minCases && (metrics?.okDecisions ?? 0) > 0;
  };
  const eligible = models
    .filter(usable)
    .sort((a, b) =>
      compareOrdered(
        orderKey(development.get(a) ?? null, a),
        orderKey(development.get(b) ?? null, b),
      ),
    );
  const included = eligible.slice(0, top);
  const excluded = models.flatMap((model) => {
    if (included.includes(model)) return [];
    const cases = development.get(model)?.cases ?? 0;
    const reason =
      cases === 0
        ? "no development observations for this task"
        : cases < minCases
          ? `development n=${cases} < ${minCases} (insufficient)`
          : !usable(model)
            ? "no successful development call (every call was an error or unsupported)"
            : `ranked ${eligible.indexOf(model) + 1} of ${eligible.length} on development; only the top ${top} are enumerated`;
    return [{ model, reason }];
  });
  return { included, excluded };
}

function triples<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      for (let k = j + 1; k < items.length; k++)
        out.push([items[i], items[j], items[k]]);
  return out;
}

/** Analyze recorded observations against prepared cases. */
export async function analyze(
  input: {
    cases: readonly PreparedCase[];
    observations: readonly EvalObservation[];
    runs?: RunInfo[];
  },
  options: AnalyzeOptions = {},
): Promise<Report> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const top = options.top ?? DEFAULT_TOP;
  const minCases = options.minCases ?? MIN_CASES;
  const caseById = new Map(input.cases.map((c) => [c.id, c]));

  const observationsBy = new Map<string, Map<string, EvalObservation>>();
  const unknownIds = new Set<string>();
  let unknownCaseObservations = 0;
  let duplicateObservations = 0;
  let duplicateCostUsd = 0;
  const adapterOf = new Map<string, EvalAdapter>();
  for (const observation of input.observations) {
    if (!caseById.has(observation.caseId)) {
      unknownCaseObservations++;
      unknownIds.add(observation.caseId);
      continue;
    }
    adapterOf.set(observation.model, observation.adapter);
    const recorded = observationsBy.get(observation.model) ?? new Map();
    observationsBy.set(observation.model, recorded);
    const key = keyOf(observation.caseId, observation.repetition);
    if (recorded.has(key)) {
      duplicateObservations++;
      duplicateCostUsd += observation.costUsd ?? observation.costBoundUsd;
    } else recorded.set(key, observation);
  }
  const models = [...new Set(input.observations.map((o) => o.model))].sort();

  const scoredBy = new Map<string, Scored[]>();
  const attempts = new Map<string, Map<string, Attempt>>();
  for (const [model, recorded] of observationsBy) {
    const list: Scored[] = [];
    const byKey = new Map<string, Attempt>();
    for (const [key, observation] of recorded) {
      const scored = scoreAttempt(
        caseById.get(observation.caseId) as PreparedCase,
        observation,
        minConfidence,
      );
      list.push(scored);
      byKey.set(key, scored.attempt);
    }
    scoredBy.set(model, list);
    attempts.set(model, byKey);
  }

  const tasks: Partial<Record<EvalTask, TaskReport>> = {};
  for (const task of TASKS) {
    const taskCases = input.cases.filter((c) => c.task === task);
    if (taskCases.length === 0) continue;
    const casesBySplit = Object.fromEntries(
      SPLITS.map((split) => [
        split,
        taskCases.filter((c) => c.split === split),
      ]),
    ) as Record<Split, PreparedCase[]>;
    const counts = {
      development: casesBySplit.development.length,
      holdout: casesBySplit.holdout.length,
    };
    const itemsOf = (model: string, split?: Split) =>
      (scoredBy.get(model) ?? []).filter(
        (item) =>
          item.prepared.task === task &&
          (split === undefined || item.prepared.split === split),
      );
    const taskModels = models.filter((model) => itemsOf(model).length > 0);

    const modelRows = taskModels.map((model) => ({
      model,
      adapter: adapterOf.get(model) as EvalAdapter,
      development: modelSplitRow(
        itemsOf(model, "development"),
        counts.development,
        minCases,
      ),
      holdout: modelSplitRow(
        itemsOf(model, "holdout"),
        counts.holdout,
        minCases,
      ),
    }));

    const questions = [
      ...new Set(taskCases.flatMap((c) => Object.keys(c.expected))),
    ];
    const sweeps = taskModels.flatMap((model) =>
      questions.map((question) =>
        sweepRow(model, question, itemsOf(model), minCases),
      ),
    );

    const singleRow = (model: string) => {
      const row = modelRows.find((r) => r.model === model);
      const withCalls = (metrics: Metrics | undefined) =>
        metrics && { ...metrics, callsPerDecision: 1 };
      return rankRow(
        singleInfo(model),
        withCalls(row?.development?.metrics) ?? null,
        withCalls(row?.holdout?.metrics) ?? null,
        minCases,
      );
    };
    const singles = rankRows(taskModels.map(singleRow));

    const developmentMetrics = new Map(
      modelRows.map((r) => [r.model, r.development?.metrics ?? null]),
    );
    const { included, excluded } = selectModels(
      taskModels,
      developmentMetrics,
      top,
      minCases,
    );
    const unseen = models
      .filter((model) => !taskModels.includes(model))
      .map((model) => ({ model, reason: "no observations for this task" }));

    // Cheapest first: the chain order the brief calls "cheap model first".
    const cheapFirst = [...included].sort(
      (a, b) =>
        ascNullLast(
          developmentMetrics.get(a)?.costPer1000.usd ?? null,
          developmentMetrics.get(b)?.costPer1000.usd ?? null,
        ) ||
        ascNullLast(
          developmentMetrics.get(a)?.latency.p50Ms ?? null,
          developmentMetrics.get(b)?.latency.p50Ms ?? null,
        ) ||
        a.localeCompare(b),
    );
    const intentTask = taskCases.every((c) => c.input.type === "intent");
    const candidates: Candidate[] = [];
    const combined = (policy: Policy) =>
      candidates.push({
        info: policy,
        run: async (cases) => runPolicy(policy, cases, attempts),
      });
    for (let i = 0; i < cheapFirst.length; i++)
      for (let j = i + 1; j < cheapFirst.length; j++) {
        combined(chain(cheapFirst[i], cheapFirst[j]));
        combined(confirm(cheapFirst[i], cheapFirst[j]));
      }
    for (const members of triples(cheapFirst)) combined(majority(members));
    const notes: string[] = [
      "Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated.",
    ];
    if (included.length < 3)
      notes.push(
        "Fewer than three eligible models: no majority vote enumerated.",
      );
    if (intentTask) {
      candidates.push({
        info: heuristicInfo,
        run: (cases) =>
          runReplay(
            heuristicInfo,
            undefined,
            cases,
            observationsBy,
            minConfidence,
          ),
      });
      for (const model of included) {
        const info = replayInfo(model);
        candidates.push({
          info,
          run: (cases) =>
            runReplay(info, model, cases, observationsBy, minConfidence),
        });
      }
    } else
      notes.push(
        "Replay of the shipped heuristic fallback applies to intent tasks only.",
      );

    const policyRows: Omit<RankRow, "rank">[] = [];
    for (const { info, run } of candidates) {
      const metrics = {} as Record<Split, Metrics | null>;
      for (const split of SPLITS) {
        const result = await run(casesBySplit[split]);
        const base = metricsFrom(result.scores, counts[split]);
        metrics[split] = base && {
          ...base,
          callsPerDecision:
            result.scores.length === 0
              ? 0
              : result.calls / result.scores.length,
          ...(info.kind === "chain" && {
            escalationReasons: result.escalationReasons,
          }),
          ...(result.fallbackVerdicts !== undefined && {
            fallbackVerdicts: result.fallbackVerdicts,
          }),
        };
      }
      policyRows.push(
        rankRow(info, metrics.development, metrics.holdout, minCases),
      );
    }
    const pipelines = rankRows([...included.map(singleRow), ...policyRows]);

    tasks[task] = {
      cases: counts,
      models: modelRows,
      sweeps,
      selection: {
        criterion: SELECTION_CRITERION,
        top,
        included,
        excluded: [...excluded, ...unseen],
        notes,
      },
      ranking: { singles, pipelines },
      recommendation: {
        single: recommend(singles),
        pipeline: recommend(pipelines),
      },
    };
  }

  return {
    version: 1,
    config: {
      minConfidence,
      top,
      minCases,
      thresholds: THRESHOLDS,
      rankingRule: RANKING_RULE,
      policyKinds: POLICY_KINDS,
    },
    runs: input.runs ?? [],
    dataQuality: {
      observations: input.observations.length,
      models,
      unknownCaseObservations,
      unknownCaseIds: [...unknownIds].sort().slice(0, 20),
      duplicateObservations,
      duplicateCostUsd,
    },
    tasks,
    limitations: limitations(tasks, input.observations, minCases),
  };
}

function limitations(
  tasks: Report["tasks"],
  observations: readonly EvalObservation[],
  minCases: number,
): string[] {
  const sources = Object.fromEntries(
    COST_SOURCES.map((source) => [
      source,
      observations.filter((o) => o.costSource === source).length,
    ]),
  ) as Record<CostSource, number>;
  const insufficient = Object.values(tasks).reduce(
    (sum, task) =>
      sum + task.ranking.singles.filter((row) => row.insufficient).length,
    0,
  );
  return [
    "Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.",
    `Samples are small: results with fewer than ${minCases} holdout cases per task are marked insufficient (${insufficient} single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.`,
    `Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: ${COST_SOURCES.map((s) => `${s} ${sources[s]}`).join(", ")}.`,
    "Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.",
    "The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.",
    "Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.",
    "Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).",
  ];
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const pct = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined
    ? "-"
    : `${(value * 100).toFixed(digits)}%`;
const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : String(Math.round(value));
const cell = (value: string) => value.replaceAll("|", "\\|");

function usd(cost: CostPer1000 | undefined): string {
  if (!cost || cost.usd === null) return "-";
  const text = `$${cost.usd.toFixed(cost.usd < 1 ? 4 : 2)}`;
  return cost.basis === "actual"
    ? text
    : `${text} (${cost.basis === "bound" ? "b" : "m"})`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => " --- ").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

const rowCells = (row: RankRow): string[] => {
  const h = row.holdout;
  const d = row.development;
  return [
    String(row.rank),
    `\`${row.id}\``,
    String(row.n),
    h ? String(h.unsafeAccepted) : "-",
    pct(h?.acceptedExactRate),
    pct(h?.coverage),
    pct(h?.selectiveAccuracy),
    d ? String(d.unsafeAccepted) : "-",
    pct(d?.acceptedExactRate),
    h?.callsPerDecision === undefined ? "-" : h.callsPerDecision.toFixed(2),
    h ? `${h.errors}/${h.unsupported}` : "-",
    usd(h?.costPer1000),
    ms(h?.latency.p95Ms),
    [
      row.insufficient ? `insufficient (${row.insufficientReason})` : "",
      row.fallback ? "fallback" : "",
      h && h.missingCases > 0 ? `${h.missingCases} missing` : "",
    ]
      .filter(Boolean)
      .join("; "),
  ];
};

const RANK_HEADERS = [
  "#",
  "candidate",
  "n",
  "unsafe",
  "acc-exact",
  "cov",
  "sel-acc",
  "dev unsafe",
  "dev acc-exact",
  "calls",
  "err/unsup",
  "$/1k",
  "p95 ms",
  "flags",
];

function evidence(row: RankRow): string {
  const h = row.holdout;
  const d = row.development;
  return `holdout n=${row.n}: unsafe accepted ${h?.unsafeAccepted ?? "-"}, accepted-exact ${pct(h?.acceptedExactRate)}, coverage ${pct(h?.coverage)}, ${usd(h?.costPer1000)} per 1,000, p95 ${ms(h?.latency.p95Ms)} ms, errors/unsupported ${h?.errors ?? 0}/${h?.unsupported ?? 0}; development: unsafe accepted ${d?.unsafeAccepted ?? "-"}, accepted-exact ${pct(d?.acceptedExactRate)}`;
}

function recommendationLine(
  label: string,
  rec: Recommendation,
  rows: readonly RankRow[],
): string {
  const row = rows.find((r) => r.id === rec.id);
  return row
    ? `- **${label}:** \`${row.id}\` [${rec.status}] - ${evidence(row)}. ${rec.note}`
    : `- **${label}:** none (${rec.note})`;
}

const pick = (rec: Recommendation) =>
  rec.id === null ? "none" : `\`${rec.id}\` (${rec.status})`;

/** Render the report as compact Markdown tables per task. */
export function renderMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(
    "# Classifier evaluation report",
    "",
    `Gate (minimum confidence): ${report.config.minConfidence}. Runs: ${report.runs.map((r) => `\`${r.dir}\` (${r.observations})`).join(", ") || "-"}. Observations: ${report.dataQuality.observations}, models: ${report.dataQuality.models.length}.`,
    "",
    "Ranking rule (lexicographic):",
    ...report.config.rankingRule.map((rule, i) => `${i + 1}. ${rule}`),
    "",
    "Pipelines:",
    ...Object.entries(report.config.policyKinds).map(
      ([kind, text]) => `- \`${kind}\`: ${text}`,
    ),
    "",
    "`$/1k` is cost per 1,000 decisions: actual where known, `(m)` partly and `(b)` fully priced at the reserved bound. `n` is distinct holdout cases. Unsafe, acc-exact, cov and sel-acc are measured on holdout; accepted-exact counts decisions whose every question is correct and accepted.",
    "",
  );
  const dq = report.dataQuality;
  if (dq.unknownCaseObservations > 0 || dq.duplicateObservations > 0)
    out.push(
      `Data quality: ${dq.unknownCaseObservations} observations for unknown cases were not scored (${dq.unknownCaseIds.join(", ")}); ${dq.duplicateObservations} duplicate observations were ignored (spend $${dq.duplicateCostUsd.toFixed(4)}).`,
      "",
    );
  out.push("## Recommendations", "");
  out.push(
    table(
      ["task", "single model", "pipeline"],
      Object.entries(report.tasks).map(([task, t]) => [
        task,
        pick(t.recommendation.single),
        pick(t.recommendation.pipeline),
      ]),
    ),
    "",
  );
  for (const [task, t] of Object.entries(report.tasks)) {
    out.push(
      `## ${task}`,
      "",
      `Cases: development ${t.cases.development}, holdout ${t.cases.holdout}.`,
      "",
      recommendationLine(
        "Recommended single model",
        t.recommendation.single,
        t.ranking.singles,
      ),
      recommendationLine(
        "Recommended pipeline",
        t.recommendation.pipeline,
        t.ranking.pipelines,
      ),
      "",
      "### Single models",
      "",
      table(
        RANK_HEADERS,
        t.ranking.singles.map((row) => rowCells(row)),
      ),
      "",
      "### Models in detail",
      "",
      table(
        [
          "model",
          "split",
          "cases",
          "abstain",
          "invalid",
          "first-attempt acc (95% CI)",
          "brier",
          "ece",
          "p50 ms",
          "consistency",
          "cost sources",
        ],
        t.models.flatMap((m) =>
          SPLITS.flatMap((split) => {
            const r = m[split];
            if (!r) return [];
            const ci = r.summary.firstAttemptAccuracyInterval;
            return [
              [
                `\`${m.model}\``,
                split,
                String(r.metrics.cases),
                pct(r.abstentionRate),
                pct(r.invalidRate),
                ci.low === null
                  ? "-"
                  : `${pct(ci.low)}-${pct(ci.high)} (n=${ci.n} answers)`,
                r.summary.reportedConfidenceBrier?.toFixed(3) ?? "-",
                r.summary.reportedConfidenceEce?.toFixed(3) ?? "-",
                ms(r.metrics.latency.p50Ms),
                r.consistency.agreementRate === null
                  ? "-"
                  : `${pct(r.consistency.agreementRate, 0)} of ${r.consistency.casesWithRepeats}`,
                COST_SOURCES.filter((s) => r.costSources[s] > 0)
                  .map((s) => `${s} ${r.costSources[s]}`)
                  .join(", "),
              ],
            ];
          }),
        ),
      ),
      "",
      "### Confidence gate chosen on development",
      "",
      "The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.",
      "",
      table(
        [
          "model",
          "question",
          "gate",
          "dev cov",
          "dev unsafe raw",
          "holdout cov",
          "holdout sel-acc",
          "holdout unsafe",
          "note",
        ],
        t.sweeps.map((s) => [
          `\`${s.model}\``,
          s.question,
          s.selected.threshold === null
            ? "none"
            : s.selected.threshold.toFixed(2),
          pct(s.selected.development?.coverage),
          String(s.unsafeRaw.development),
          pct(s.selected.holdout?.coverage),
          pct(s.selected.holdout?.selectiveAccuracy),
          s.selected.holdout ? String(s.selected.holdout.unsafeAccepted) : "-",
          [
            s.selected.threshold === null ? s.selected.reason : "",
            s.selected.vacuous ? "vacuous: no unsafe development answer" : "",
            s.selected.insufficient ? "insufficient" : "",
          ]
            .filter(Boolean)
            .join("; "),
        ]),
      ),
      "",
      `### Pipelines (top ${Math.min(10, t.ranking.pipelines.length)} of ${t.ranking.pipelines.length})`,
      "",
      table(
        RANK_HEADERS,
        t.ranking.pipelines.slice(0, 10).map((row) => rowCells(row)),
      ),
      "",
      `Enumerated over: ${t.selection.included.map((m) => `\`${m}\``).join(", ") || "no model"} (top ${t.selection.top}, chosen by ${t.selection.criterion}). ${t.selection.notes.join(" ")}`,
      "",
    );
    if (t.selection.excluded.length > 0)
      out.push(
        "Excluded from pipeline enumeration:",
        "",
        ...t.selection.excluded.map((e) => `- \`${e.model}\`: ${e.reason}`),
        "",
      );
  }
  out.push(
    "## Limitations",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Write report.json and report.md into `dir`. */
export async function writeReport(report: Report, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(join(dir, "report.md"), renderMarkdown(report));
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      runs: { type: "string" },
      out: { type: "string" },
      "min-confidence": { type: "string" },
      top: { type: "string" },
    },
    strict: true,
  });
  if (!values.runs || !values.out)
    throw new Error(
      "usage: analyze.ts --runs <dir[,dir...]> --out <dir> [--min-confidence 0.7] [--top 4]",
    );
  const minConfidence =
    values["min-confidence"] === undefined
      ? undefined
      : Number(values["min-confidence"]);
  if (
    minConfidence !== undefined &&
    !(minConfidence >= 0 && minConfidence <= 1)
  )
    throw new Error("--min-confidence must be between zero and one");
  const top = values.top === undefined ? undefined : Number(values.top);
  if (top !== undefined && !(Number.isInteger(top) && top >= 1))
    throw new Error("--top must be a positive integer");
  const loaded = await Promise.all(
    values.runs
      .split(",")
      .filter((dir) => dir !== "")
      .map((dir) => loadRun(resolve(dir))),
  );
  const report = await analyze(
    {
      cases: await loadCases(),
      observations: loaded.flatMap((run) => run.observations),
      runs: loaded.map((run) => run.info),
    },
    {
      ...(minConfidence !== undefined && { minConfidence }),
      ...(top !== undefined && { top }),
    },
  );
  await writeReport(report, resolve(values.out));
  console.log(
    `wrote ${join(resolve(values.out), "report.json")} and report.md`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
