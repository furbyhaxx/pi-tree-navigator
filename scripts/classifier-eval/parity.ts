/**
 * Live parity check of the shipped "recommended" intent policy against the
 * benchmark.
 *
 * Runs the product classifier (`createModelClassifier(registry, "recommended")`)
 * on the intent and supersession cases, through a registry wrapper that
 * reserves each call's worst case in the shared budget ledger before dispatch,
 * sends no retries and settles from OpenRouter's generation record. Its
 * answers are compared with the recorded benchmark observations of the same two
 * models, replayed through the same shipped code.
 *
 *   node scripts/classifier-eval/parity.ts --out .project/analyses/classifier-eval/runs/parity-2026-10-23 [--dry-run]
 *
 * Exit codes: 0 complete, 1 failure, 2 usage error, 3 budget stop, 130 interrupted.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ClassifierApi,
  ClassifierModel,
  ClassifierResult,
  Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FetchFn } from "../fetch.ts";
import {
  buildIntentClassifierContext,
  createModelClassifier,
  DEFAULT_MIN_CONFIDENCE,
  type IntentInput,
  type IntentVerdict,
} from "../../extensions/navigate-tree/continuity-capture.ts";
import {
  RECOMMENDED_INTENT_CLASSIFIER,
  resolveStageModels,
} from "../../extensions/navigate-tree/intent-policy.ts";
import {
  createRecorder,
  DECISION_MAX_OUTPUT_TOKENS,
  safeMessage,
} from "./adapters.ts";
import { loadRun } from "./analyze.ts";
import {
  type Billing,
  createBilling,
  loadRouteTable,
  maxPriceOf,
  PROMPT_MARGIN_BYTES,
  pricingFor,
  ROUTE_PRICES_URL,
  type RouteTable,
  worstCaseUsd,
} from "./billing.ts";
import { BudgetError, BudgetLedger } from "./budget.ts";
import { prepareCase } from "./prepare.ts";
import type {
  CostSource,
  EvalAnswer,
  EvalCase,
  EvalObservation,
  PreparedCase,
} from "./types.ts";

const DEFAULT_LEDGER = ".project/analyses/classifier-eval/budget-ledger.jsonl";
const DEFAULT_BENCHMARK = [
  ".project/analyses/classifier-eval/runs-catalogued-2026-10-23/dev-screen-2026-10-23",
  ".project/analyses/classifier-eval/runs-catalogued-2026-10-23/holdout-2026-10-23",
];
const HISTORIC_INTENT_POLICY = JSON.stringify({
  preset: RECOMMENDED_INTENT_CLASSIFIER,
  kind: { model: "openrouter/microsoft/microsoft-decision-1" },
  supersession: {
    model: "openrouter/microsoft/microsoft-decision-1",
    escalation: { model: "openrouter/openai/gpt-6-luna" },
    verification: { model: "openrouter/microsoft/microsoft-decision-1" },
  },
});
const MICROSOFT_LABEL = "decisions:microsoft/microsoft-decision-1";
const LUNA_LABEL = "chat:openai/gpt-6-luna";
const CHAT_RESERVED_OUTPUT_TOKENS = 1_024;
const PROBE_SUFFIX = "#luna-probe";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Metering registry
// ---------------------------------------------------------------------------

/** One paid call the product made, with what billing settled for it. */
export interface CallRecord {
  seq: number;
  caseId: string;
  kind: "classify" | "chat";
  model: string;
  status: "ok" | "error";
  /** Choice answers of a classify call. */
  answers?: Record<string, EvalAnswer>;
  /** Raw text of a chat reply (the answer JSON only). */
  text?: string;
  error?: string;
  requestSha256?: string;
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  costBoundUsd: number;
  costUsd: number | null;
  costSource: CostSource | "pending";
}

export type BaseRegistry = Pick<
  ModelRegistry,
  | "getModelOfType"
  | "getAvailableOfType"
  | "classify"
  | "streamSimple"
  | "getApiKeyForProvider"
>;

export interface MeterOptions {
  ledger: Pick<BudgetLedger, "reserve" | "settle">;
  billing: Billing;
  table: RouteTable;
  fetch: FetchFn;
  /** Prefix of every reservation id. */
  sessionId: string;
  /** This run's own ceiling on reserved plus settled USD. */
  maxRunUsd: number;
}

/** Raised before a call that would break a ceiling; nothing is sent. */
export class MeterRefusal extends Error {}

/** Wraps a registry so every paid call is reserved, bounded, recorded and settled. */
export function createMeter(options: MeterOptions) {
  const { ledger, billing, table } = options;
  const calls: CallRecord[] = [];
  const pending = new Set<Promise<void>>();
  let currentCase = "";
  let committedUsd = 0;
  let refused: string | undefined;

  async function dispatch<T>(
    spec: {
      kind: CallRecord["kind"];
      model: { id: string; cost: Model<Api>["cost"] };
      bodyBytes: number;
      maxOutputTokens: number;
    },
    send: (fetch: typeof globalThis.fetch, maxPrice: object) => Promise<T>,
    describe: (out: T) => Partial<CallRecord> & { responseId?: string },
  ): Promise<T> {
    const pricing = pricingFor(
      spec.model,
      table,
      spec.kind === "classify" ? "decisions" : "chat",
    );
    if (pricing.refusal !== undefined) {
      throw new MeterRefusal(`refused before dispatch: ${pricing.refusal}`);
    }
    const reservationUsd = worstCaseUsd(
      spec.bodyBytes,
      spec.maxOutputTokens,
      pricing.rates,
    );
    if (committedUsd + reservationUsd > options.maxRunUsd) {
      refused = `run ceiling of ${options.maxRunUsd} USD would be exceeded`;
      throw new MeterRefusal(refused);
    }
    const seq = calls.length + 1;
    const id = `${options.sessionId}/${seq}/${spec.kind}:${spec.model.id}/${currentCase}`;
    try {
      ledger.reserve(id, reservationUsd);
    } catch (error) {
      if (error instanceof BudgetError) refused = error.message;
      throw error;
    }
    committedUsd += reservationUsd;
    const recorder = createRecorder(
      options.fetch,
      spec.bodyBytes + PROMPT_MARGIN_BYTES,
    );
    const started = performance.now();
    let out: T | undefined;
    let thrown: unknown;
    try {
      out = await send(recorder.fetch, {
        max_price: maxPriceOf(pricing.rates),
      });
    } catch (error) {
      thrown = error;
    }
    const durationMs = performance.now() - started;
    const transport = await recorder.finish();
    const described = out === undefined ? {} : describe(out);
    const generationId = transport.generationId ?? described.responseId;
    const record: CallRecord = {
      seq,
      caseId: currentCase,
      kind: spec.kind,
      model: spec.model.id,
      status: thrown === undefined ? "ok" : "error",
      ...(thrown !== undefined && { error: safeMessage(thrown) }),
      ...(transport.requestSha256 !== undefined && {
        requestSha256: transport.requestSha256,
      }),
      ...(generationId !== undefined && { generationId }),
      ...(transport.inputTokens !== undefined && {
        inputTokens: transport.inputTokens,
      }),
      ...(transport.outputTokens !== undefined && {
        outputTokens: transport.outputTokens,
      }),
      durationMs,
      costBoundUsd: reservationUsd,
      costUsd: null,
      costSource: "pending",
      ...described,
    };
    delete (record as { responseId?: string }).responseId;
    calls.push(record);
    const settling: Promise<void> = (async () => {
      const settlement = await billing.settle({
        dispatched: transport.dispatched,
        ...(transport.httpStatus !== undefined && {
          httpStatus: transport.httpStatus,
        }),
        ...(generationId !== undefined && { generationId }),
        ...(transport.costUsd !== undefined && {
          responseCostUsd: transport.costUsd,
        }),
      });
      record.costUsd = settlement.costUsd;
      record.costSource = settlement.costSource;
      committedUsd += (settlement.costUsd ?? reservationUsd) - reservationUsd;
      ledger.settle(id, settlement.costUsd);
    })()
      .catch((error: unknown) => {
        refused ??= safeMessage(error);
      })
      .finally(() => pending.delete(settling));
    pending.add(settling);
    if (thrown !== undefined) throw thrown;
    return out as T;
  }

  const registry = (base: BaseRegistry): BaseRegistry => ({
    getModelOfType: (...args) => base.getModelOfType(...args),
    getAvailableOfType: (...args) => base.getAvailableOfType(...args),
    getApiKeyForProvider: (provider) => base.getApiKeyForProvider(provider),
    classify: (model: ClassifierModel<ClassifierApi>, context, opts) => {
      const maxPrice = maxPriceOf(pricingFor(model, table, "decisions").rates);
      const bodyBytes = Buffer.byteLength(
        JSON.stringify({
          model: model.id,
          state: context.state,
          questions: context.questions,
          provider: { max_price: maxPrice },
        }),
      );
      return dispatch(
        {
          kind: "classify",
          model,
          bodyBytes,
          maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS,
        },
        (fetch, provider) =>
          base.classify(model, context, {
            ...opts,
            maxRetries: 0,
            fetch,
            onPayload: (payload) =>
              isRecord(payload) ? { ...payload, provider } : undefined,
          }),
        (result: ClassifierResult) => {
          const answers: Record<string, EvalAnswer> = {};
          for (const [id, answer] of Object.entries(result.answers)) {
            if (answer.type === "choice") {
              answers[id] = {
                choice: answer.choice,
                confidence: answer.confidence,
              };
            }
          }
          return {
            answers,
            ...(result.stopReason !== "stop" && {
              status: "error" as const,
              error: safeMessage(result.errorMessage ?? result.stopReason),
            }),
          };
        },
      ) as Promise<ClassifierResult>;
    },
    streamSimple: (model, context, opts) => {
      const maxPrice = maxPriceOf(pricingFor(model, table, "chat").rates);
      const bodyBytes = Buffer.byteLength(
        JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: context.systemPrompt },
            ...context.messages,
          ],
          provider: { max_price: maxPrice },
        }),
      );
      const settled = dispatch(
        {
          kind: "chat",
          model,
          bodyBytes,
          maxOutputTokens: opts?.maxTokens ?? CHAT_RESERVED_OUTPUT_TOKENS,
        },
        (fetch, provider) =>
          base
            .streamSimple(model, context, {
              ...opts,
              maxRetries: 0,
              fetch,
              onPayload: async (payload, forModel) => {
                const own = await opts?.onPayload?.(payload, forModel);
                const next = own ?? payload;
                return isRecord(next) ? { ...next, provider } : undefined;
              },
            })
            .result(),
        (message: AssistantMessage) => ({
          responseId: message.responseId,
          text: message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
          ...(message.stopReason === "error" && {
            status: "error" as const,
            error: safeMessage(message.errorMessage ?? "chat request failed"),
          }),
        }),
      );
      // The product only reads `.result()`; the call is reserved and sent when the stream is created.
      return {
        result: () => settled,
      } as unknown as AssistantMessageEventStream;
    },
  });

  return {
    registry,
    calls,
    setCase: (id: string) => {
      currentCase = id;
    },
    /** Resolves once every settlement has been written to the ledger. */
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    refused: () => refused,
    committedUsd: () => committedUsd,
  };
}

// ---------------------------------------------------------------------------
// Comparison with the benchmark
// ---------------------------------------------------------------------------

const GATE = DEFAULT_MIN_CONFIDENCE;

/** The answer a question settles on at the gate; `abstain` when it is unusable or doubtful. */
function effective(
  prepared: PreparedCase,
  question: string,
  answer: EvalAnswer | undefined,
): string {
  const offered = prepared.questions[question]?.choices ?? {};
  return answer !== undefined &&
    Object.hasOwn(offered, answer.choice) &&
    (answer.confidence ?? 0) >= GATE
    ? answer.choice
    : "abstain";
}

export function intentInput(prepared: PreparedCase): IntentInput {
  if (prepared.input.type !== "intent")
    throw new Error(`${prepared.id}: parity needs an intent case`);
  const { message, activeAnchor, activeItems } = prepared.input;
  return {
    entryId: prepared.id,
    text: message,
    ...(activeAnchor !== undefined && { activeAnchor }),
    activeItems,
  };
}

/** The verdict the shipped policy reaches from one recorded pair of benchmark observations. */
export async function replayVerdict(
  prepared: PreparedCase,
  micro: EvalObservation,
  luna: EvalObservation | undefined,
): Promise<IntentVerdict> {
  const answers: Record<string, unknown> = {};
  if (micro.status === "ok") {
    for (const [question, answer] of Object.entries(micro.answers)) {
      if (
        Object.hasOwn(
          prepared.questions[question]?.choices ?? {},
          answer.choice,
        )
      ) {
        answers[question] = {
          type: "choice",
          choice: answer.choice,
          probabilities: {},
          confidence: answer.confidence ?? 0,
        };
      }
    }
  }
  const contradicts =
    luna?.status === "ok" ? luna.answers.contradicts : undefined;
  const registry = {
    getModelOfType: () => undefined,
    getAvailableOfType: async (type: string) => [
      {
        provider: "openrouter",
        id:
          type === "classifier"
            ? "microsoft/microsoft-decision-1"
            : "openai/gpt-6-luna",
        api: "openai-completions",
      },
    ],
    classify: async () => ({
      answers,
      stopReason: micro.status === "ok" ? "stop" : "error",
      errorMessage: micro.error ?? micro.status,
    }),
    streamSimple: () => ({
      result: async () =>
        contradicts === undefined
          ? {
              stopReason: "error",
              content: [],
              errorMessage: "no recorded answer",
            }
          : {
              stopReason: "stop",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ answers: { contradicts } }),
                },
              ],
            },
    }),
  } as unknown as Parameters<typeof createModelClassifier>[0];
  const classifier = await createModelClassifier(
    registry,
    HISTORIC_INTENT_POLICY,
  );
  if (!classifier) throw new Error("replay registry rejected the preset");
  return classifier(intentInput(prepared));
}

const decisionOf = (verdict: IntentVerdict) =>
  `${verdict.kind}|${verdict.supersedes?.[0] ?? "none"}`;

function modal(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** What the live product did on a case, for comparison. */
export interface LiveCase {
  caseId: string;
  verdict: Pick<IntentVerdict, "kind" | "by" | "supersedes" | "warning">;
  calls: readonly CallRecord[];
}

export interface CaseParity {
  caseId: string;
  split: EvalCase["split"];
  task: EvalCase["task"];
  live: LiveCase["verdict"];
  benchmarkRepetitions: number;
  benchmarkVerdicts: string[];
  /** Null where the question was not comparable (not asked, or no benchmark answer). */
  agreement: {
    requestSha256: boolean | null;
    microsoftKind: boolean | null;
    microsoftContradicts: boolean | null;
    lunaContradicts: boolean | null;
    verdictModal: boolean;
    verdictAnyRepetition: boolean;
  };
  /** Wrong answers that passed the gate (the benchmark's "unsafe accepted"); the live count and the sum over benchmark repetitions. */
  liveUnsafeAccepted: number;
  benchmarkUnsafeAccepted: number;
  /** Committed verdicts that are unsafe, abstentions kept as ephemeral included. */
  liveUnsafe: number;
  benchmarkUnsafe: number;
  /** Luna asked the contradicts question alone, against its recorded two-question answers. */
  lunaProbe: boolean | null;
  liveExact: boolean;
  benchmarkExactRepetitions: number;
}

function judge(prepared: PreparedCase, verdict: IntentVerdict) {
  const { kind, contradicts } = prepared.expected;
  const chosen = verdict.supersedes?.[0] ?? "none";
  const unsafe =
    Number(kind?.unsafeChoices.includes(verdict.kind) ?? false) +
    Number(contradicts?.unsafeChoices.includes(chosen) ?? false);
  const exact =
    (kind?.choices.includes(verdict.kind) ?? true) &&
    (contradicts?.choices.includes(chosen) ?? true);
  return { unsafe, exact };
}

const same = (
  prepared: PreparedCase,
  question: string,
  live: EvalAnswer | undefined,
  recorded: readonly (EvalObservation | undefined)[],
): boolean | null => {
  const seen = recorded.flatMap((observation) =>
    observation?.status === "ok"
      ? [effective(prepared, question, observation.answers[question])]
      : [],
  );
  const expected = modal(seen);
  return live === undefined || expected === undefined
    ? null
    : effective(prepared, question, live) === expected;
};

/** Wrong answers that passed the gate, by the benchmark's chain rule: the decisions model's accepted `contradicts`, else the chat model's. */
function acceptedUnsafe(
  prepared: PreparedCase,
  answers: {
    kind?: EvalAnswer;
    contradicts?: EvalAnswer;
    lunaContradicts?: EvalAnswer;
  },
): number {
  const unsafe = (question: string, answer: EvalAnswer | undefined) => {
    const choice = effective(prepared, question, answer);
    return choice !== "abstain" &&
      prepared.expected[question]?.unsafeChoices.includes(choice)
      ? 1
      : 0;
  };
  const decided =
    effective(prepared, "contradicts", answers.contradicts) !== "abstain"
      ? answers.contradicts
      : answers.lunaContradicts;
  return unsafe("kind", answers.kind) + unsafe("contradicts", decided);
}

/** Whether Luna, asked `contradicts` alone, settles on what it settled on in the benchmark. */
export function compareLunaProbe(
  prepared: PreparedCase,
  probe: CallRecord,
  benchmark: readonly EvalObservation[],
): boolean | null {
  return same(
    prepared,
    "contradicts",
    lunaAnswer(probe),
    benchmark.filter((o) => o.caseId === prepared.id && o.model === LUNA_LABEL),
  );
}

/** Compare one live case with the benchmark observations of the same two models. */
export async function compareCase(
  prepared: PreparedCase,
  live: LiveCase,
  benchmark: readonly EvalObservation[],
): Promise<CaseParity> {
  const own = benchmark.filter((o) => o.caseId === prepared.id);
  const micro = own
    .filter((o) => o.model === MICROSOFT_LABEL)
    .sort((a, b) => a.repetition - b.repetition);
  const luna = own.filter((o) => o.model === LUNA_LABEL);
  const verdicts: IntentVerdict[] = [];
  for (const observation of micro) {
    verdicts.push(
      await replayVerdict(
        prepared,
        observation,
        luna.find((o) => o.repetition === observation.repetition),
      ),
    );
  }
  const decisions = verdicts.map(decisionOf);
  const liveDecision = decisionOf(live.verdict as IntentVerdict);
  const liveMicro = live.calls.find((call) => call.kind === "classify");
  const liveLuna = live.calls.find((call) => call.kind === "chat");
  const hashes = micro.flatMap((o) =>
    o.requestSha256 === undefined ? [] : [o.requestSha256],
  );
  const judged = verdicts.map((verdict) => judge(prepared, verdict));
  const liveJudged = judge(prepared, live.verdict as IntentVerdict);
  return {
    caseId: prepared.id,
    split: prepared.split,
    task: prepared.task,
    live: live.verdict,
    benchmarkRepetitions: micro.length,
    benchmarkVerdicts: decisions,
    agreement: {
      requestSha256:
        liveMicro?.requestSha256 === undefined || hashes.length === 0
          ? null
          : hashes.includes(liveMicro.requestSha256),
      microsoftKind: same(prepared, "kind", liveMicro?.answers?.kind, micro),
      microsoftContradicts: same(
        prepared,
        "contradicts",
        liveMicro?.answers?.contradicts,
        micro,
      ),
      lunaContradicts:
        liveLuna === undefined
          ? null
          : same(prepared, "contradicts", lunaAnswer(liveLuna), luna),
      verdictModal: liveDecision === modal(decisions),
      verdictAnyRepetition: decisions.includes(liveDecision),
    },
    liveUnsafeAccepted: acceptedUnsafe(prepared, {
      kind: liveMicro?.answers?.kind,
      contradicts: liveMicro?.answers?.contradicts,
      lunaContradicts: liveLuna && lunaAnswer(liveLuna),
    }),
    benchmarkUnsafeAccepted: micro.reduce(
      (sum, o) =>
        sum +
        acceptedUnsafe(prepared, {
          kind: o.answers.kind,
          contradicts: o.answers.contradicts,
          lunaContradicts: luna.find((l) => l.repetition === o.repetition)
            ?.answers.contradicts,
        }),
      0,
    ),
    liveUnsafe: liveJudged.unsafe,
    benchmarkUnsafe: judged.reduce((sum, j) => sum + j.unsafe, 0),
    lunaProbe: null,
    liveExact: liveJudged.exact,
    benchmarkExactRepetitions: judged.filter((j) => j.exact).length,
  };
}

function lunaAnswer(call: CallRecord): EvalAnswer | undefined {
  try {
    const parsed: unknown = JSON.parse(call.text ?? "");
    const entry =
      isRecord(parsed) && isRecord(parsed.answers)
        ? parsed.answers.contradicts
        : undefined;
    return isRecord(entry) && typeof entry.choice === "string"
      ? {
          choice: entry.choice,
          ...(typeof entry.confidence === "number" && {
            confidence: entry.confidence,
          }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface GroupSummary {
  task: string;
  split: string;
  cases: number;
  requestSha256: string;
  microsoftKind: string;
  microsoftContradicts: string;
  lunaContradicts: string;
  verdictModal: string;
  verdictAnyRepetition: string;
  liveExact: number;
  benchmarkExactRate: string;
  lunaProbe: string;
  liveUnsafeAccepted: number;
  benchmarkUnsafeAcceptedRepetitions: number;
  liveUnsafe: number;
  benchmarkUnsafeRepetitions: number;
}

const ratio = (flags: readonly (boolean | null)[]) => {
  const known = flags.filter((flag): flag is boolean => flag !== null);
  return `${known.filter(Boolean).length}/${known.length}`;
};

export function summarize(results: readonly CaseParity[]): GroupSummary[] {
  const groups = new Map<string, CaseParity[]>();
  for (const result of results) {
    const key = `${result.task}\u0000${result.split}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups].sort().map(([key, items]) => {
    const [task = "", split = ""] = key.split("\u0000");
    const reps = items.reduce((sum, i) => sum + i.benchmarkRepetitions, 0);
    const exactReps = items.reduce(
      (sum, i) => sum + i.benchmarkExactRepetitions,
      0,
    );
    return {
      task,
      split,
      cases: items.length,
      requestSha256: ratio(items.map((i) => i.agreement.requestSha256)),
      microsoftKind: ratio(items.map((i) => i.agreement.microsoftKind)),
      microsoftContradicts: ratio(
        items.map((i) => i.agreement.microsoftContradicts),
      ),
      lunaContradicts: ratio(items.map((i) => i.agreement.lunaContradicts)),
      verdictModal: ratio(items.map((i) => i.agreement.verdictModal)),
      verdictAnyRepetition: ratio(
        items.map((i) => i.agreement.verdictAnyRepetition),
      ),
      liveExact: items.filter((i) => i.liveExact).length,
      benchmarkExactRate: `${exactReps}/${reps}`,
      lunaProbe: ratio(items.map((i) => i.lunaProbe)),
      liveUnsafeAccepted: items.reduce(
        (sum, i) => sum + i.liveUnsafeAccepted,
        0,
      ),
      benchmarkUnsafeAcceptedRepetitions: items.reduce(
        (sum, i) => sum + i.benchmarkUnsafeAccepted,
        0,
      ),
      liveUnsafe: items.reduce((sum, i) => sum + i.liveUnsafe, 0),
      benchmarkUnsafeRepetitions: items.reduce(
        (sum, i) => sum + i.benchmarkUnsafe,
        0,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Everything the CLI touches outside its own process; tests replace it. */
export interface Deps {
  loadCases(): Promise<readonly EvalCase[]>;
  loadBenchmark(dirs: readonly string[]): Promise<EvalObservation[]>;
  createRegistry(storePath: string, offline: boolean): Promise<BaseRegistry>;
  loadRoutePrices(): RouteTable;
  fetch: FetchFn;
  git(): { sha: string; dirty: boolean };
  sleep(ms: number): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  billingDelaysMs?: readonly number[];
  now(): Date;
}

class UsageError extends Error {}

interface Options {
  out: string;
  split: "development" | "holdout" | "all";
  ledger: string;
  cap: number;
  maxUsd: number;
  waitMinutes: number;
  benchmark: string[];
  dryRun: boolean;
}

const USAGE = `usage: node scripts/classifier-eval/parity.ts --out <dir> [options]

  --out <dir>          evidence directory (must not exist)
  --split <s>          development | holdout | all (default all)
  --ledger <path>      default ${DEFAULT_LEDGER}
  --cap <usd>          ledger cap, default 25
  --max-usd <usd>      ceiling of this run's reserved plus settled spend, default 1
  --wait-minutes <n>   how long to wait for the ledger lock, default 30
  --benchmark <dir>    recorded run to compare with; repeatable (default: the catalogued runs)
  --dry-run            list the cases and reservations only; no network
`;

function parseOptions(argv: readonly string[]): Options | "help" {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        out: { type: "string" },
        split: { type: "string", default: "all" },
        ledger: { type: "string", default: DEFAULT_LEDGER },
        cap: { type: "string", default: "25" },
        "max-usd": { type: "string", default: "1" },
        "wait-minutes": { type: "string", default: "30" },
        benchmark: { type: "string", multiple: true },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (values.help) return "help";
  const split = String(values.split);
  if (split !== "development" && split !== "holdout" && split !== "all")
    throw new UsageError("--split must be development, holdout or all");
  const positive = (name: string) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value <= 0)
      throw new UsageError(`--${name} must be a positive number`);
    return value;
  };
  if (values.out === undefined && values["dry-run"] !== true)
    throw new UsageError("--out is required");
  return {
    out: String(values.out ?? ""),
    split,
    ledger: String(values.ledger),
    cap: positive("cap"),
    maxUsd: positive("max-usd"),
    waitMinutes: positive("wait-minutes"),
    benchmark: (values.benchmark as string[] | undefined) ?? DEFAULT_BENCHMARK,
    dryRun: values["dry-run"] === true,
  };
}

/** Opens the shared ledger, waiting while another owner holds its lock; a lock is never removed. */
export async function openLedger(
  options: Pick<Options, "ledger" | "cap" | "waitMinutes">,
  deps: Pick<Deps, "now" | "stderr" | "sleep">,
): Promise<BudgetLedger> {
  const deadline = deps.now().getTime() + options.waitMinutes * 60_000;
  for (;;) {
    try {
      return BudgetLedger.open(options.ledger, options.cap);
    } catch (error) {
      if (!(error instanceof BudgetError) || error.code !== "locked")
        throw error;
      if (deps.now().getTime() >= deadline)
        throw new Error(
          `budget ledger stayed locked for ${options.waitMinutes} minutes: ${error.message}`,
        );
      deps.stderr("budget ledger is locked by another owner; waiting\n");
      await deps.sleep(10_000);
    }
  }
}

function renderReport(
  meta: { runId: string; gitSha: string; spentUsd: number; calls: number },
  summary: readonly GroupSummary[],
  disagreements: readonly CaseParity[],
): string {
  const rows = summary.map(
    (s) =>
      `| ${s.task} | ${s.split} | ${s.cases} | ${s.requestSha256} | ${s.microsoftKind} | ${s.microsoftContradicts} | ${s.lunaContradicts} | ${s.lunaProbe} | ${s.verdictModal} | ${s.verdictAnyRepetition} | ${s.liveExact} (benchmark ${s.benchmarkExactRate} reps) | ${s.liveUnsafeAccepted} (benchmark ${s.benchmarkUnsafeAcceptedRepetitions} over reps) | ${s.liveUnsafe} (benchmark ${s.benchmarkUnsafeRepetitions} over reps) |`,
  );
  return [
    "# Parity of the recommended intent policy with the benchmark",
    "",
    `Run \`${meta.runId}\` at \`${meta.gitSha}\`: ${meta.calls} paid calls, settled spend ${meta.spentUsd.toFixed(6)} USD.`,
    "",
    "Each cell is agreements/comparable cases. `requests` counts live decisions-model requests whose body hash equals a recorded benchmark request. `luna contradicts` is the live escalation, which runs only when the decisions model abstains on a replacement; `luna probe` asks Luna the contradicts question alone for every case with active items. `verdict` compares the live (kind, supersedes) with the benchmark replayed through the shipped code: against its most common repetition, and against any repetition. `unsafe accepted` counts wrong answers that passed the 0.7 gate (the benchmark's safety measure); `unsafe verdicts` also counts abstentions that left an explicit rule uncaptured.",
    "",
    "| task | split | cases | requests | microsoft kind | microsoft contradicts | luna contradicts | luna probe | verdict (modal) | verdict (any rep) | live exact | unsafe accepted | unsafe verdicts |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Cases where the live verdict differs from every benchmark repetition",
    "",
    ...(disagreements.length === 0
      ? ["none"]
      : disagreements.map(
          (d) =>
            `- \`${d.caseId}\`: live ${d.live.kind}|${d.live.supersedes?.[0] ?? "none"} (${d.live.by}), benchmark ${d.benchmarkVerdicts.join(", ")}`,
        )),
    "",
  ].join("\n");
}

export async function main(
  argv: readonly string[],
  deps: Deps,
): Promise<number> {
  try {
    const options = parseOptions(argv);
    if (options === "help") {
      deps.stdout(USAGE);
      return 0;
    }
    return await run(options, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    deps.stderr(`failed: ${safeMessage(error)}\n`);
    return 1;
  }
}

async function run(options: Options, deps: Deps): Promise<number> {
  const cases = (await deps.loadCases())
    .filter(
      (fixture) =>
        (fixture.task === "intent" || fixture.task === "supersession") &&
        (options.split === "all" || fixture.split === options.split),
    )
    .map(prepareCase);
  if (cases.length === 0) throw new UsageError("no cases match --split");
  const outDir = resolve(options.out || ".");
  if (!options.dryRun && existsSync(outDir))
    throw new UsageError(`${outDir} already exists; use a new --out`);
  const scratch = mkdtempSync(join(tmpdir(), "classifier-parity-"));
  try {
    const base = await deps.createRegistry(
      join(scratch, "models-store.json"),
      options.dryRun,
    );
    const table = deps.loadRoutePrices();
    const probe = await createModelClassifier(base, HISTORIC_INTENT_POLICY, {
      onWarning: (message) => deps.stderr(`${message}\n`),
    });
    if (!probe) throw new Error("the recommended policy is unavailable here");
    if (options.dryRun) {
      deps.stdout(
        `dry run: ${cases.length} cases (${options.split}); at most ${cases.length} decisions calls and ${cases.filter((c) => c.input.type === "intent" && c.input.activeItems.length > 0).length} chat calls; ceiling ${options.maxUsd} USD\n`,
      );
      return 0;
    }
    const benchmark = await deps.loadBenchmark(options.benchmark);
    const billing = createBilling({
      getApiKey: () => base.getApiKeyForProvider("openrouter"),
      fetch: deps.fetch,
      ...(deps.billingDelaysMs && { delaysMs: deps.billingDelaysMs }),
    });
    const ledger = await openLedger(options, deps);
    mkdirSync(outDir, { recursive: true });
    const startedAt = deps.now();
    const runId = `parity-${startedAt.toISOString().replaceAll(":", "-")}`;
    const meter = createMeter({
      ledger,
      billing,
      table,
      fetch: deps.fetch,
      sessionId: runId,
      maxRunUsd: options.maxUsd,
    });
    const registry = meter.registry(base);
    const lunaSelector = "openrouter/openai/gpt-6-luna";
    const luna = await resolveStageModels(registry, [lunaSelector]);
    const lunaAsk = luna.ok ? luna.asks.get(lunaSelector) : undefined;
    if (!lunaAsk) throw new Error("the escalation model is unavailable here");
    const results: CaseParity[] = [];
    try {
      for (const prepared of cases) {
        if (meter.refused() !== undefined) break;
        meter.setCase(prepared.id);
        const warnings: string[] = [];
        const classifier = await createModelClassifier(
          registry,
          HISTORIC_INTENT_POLICY,
          { onWarning: (message) => warnings.push(message) },
        );
        if (!classifier)
          throw new Error(warnings.join("; ") || "policy unavailable");
        const before = meter.calls.length;
        const verdict = await classifier(
          intentInput(prepared),
          AbortSignal.timeout(60_000),
        );
        const live: LiveCase = {
          caseId: prepared.id,
          verdict: {
            kind: verdict.kind,
            by: verdict.by,
            ...(verdict.supersedes && { supersedes: verdict.supersedes }),
            ...(verdict.warning && { warning: verdict.warning }),
          },
          calls: meter.calls.slice(before),
        };
        let result = await compareCase(prepared, live, benchmark);
        if (
          prepared.input.type === "intent" &&
          prepared.input.activeItems.length > 0
        ) {
          // The same question the escalation asks, alone, for every case that has active items.
          meter.setCase(`${prepared.id}${PROBE_SUFFIX}`);
          const { context } = buildIntentClassifierContext(
            intentInput(prepared),
          );
          const contradicts = context.questions.contradicts;
          if (contradicts) {
            await lunaAsk(
              { state: context.state, questions: { contradicts } },
              AbortSignal.timeout(60_000),
            ).catch(() => undefined);
          }
          const probe = meter.calls.find(
            (call) => call.caseId === `${prepared.id}${PROBE_SUFFIX}`,
          );
          result = {
            ...result,
            lunaProbe: probe
              ? compareLunaProbe(prepared, probe, benchmark)
              : null,
          };
        }
        results.push(result);
      }
      await meter.settled();
    } finally {
      await meter.settled();
      ledger.close();
    }
    const spentUsd = meter.calls.reduce(
      (sum, call) => sum + (call.costUsd ?? 0),
      0,
    );
    const unknown = meter.calls.filter((call) => call.costUsd === null).length;
    const git = deps.git();
    const summary = summarize(results);
    const settledLines = results.map((result) =>
      JSON.stringify({
        ...result,
        calls: meter.calls.filter(
          (call) =>
            call.caseId === result.caseId ||
            call.caseId === `${result.caseId}${PROBE_SUFFIX}`,
        ),
      }),
    );
    writeFileSync(
      join(outDir, "observations.jsonl"),
      `${settledLines.join("\n")}\n`,
    );
    writeFileSync(
      join(outDir, "run.json"),
      `${JSON.stringify(
        {
          runId,
          startedAt: startedAt.toISOString(),
          endedAt: deps.now().toISOString(),
          gitSha: git.sha,
          gitDirty: git.dirty,
          policy: RECOMMENDED_INTENT_CLASSIFIER,
          models: [MICROSOFT_LABEL, LUNA_LABEL],
          confidenceGate: GATE,
          split: options.split,
          cases: results.length,
          casesPlanned: cases.length,
          ledger: options.ledger,
          capUsd: options.cap,
          maxRunUsd: options.maxUsd,
          paidCalls: meter.calls.length,
          settledSpendUsd: spentUsd,
          callsWithUnknownCost: unknown,
          stopped: meter.refused() ?? null,
          benchmark: options.benchmark,
          summary,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(outDir, "report.md"),
      renderReport(
        { runId, gitSha: git.sha, spentUsd, calls: meter.calls.length },
        summary,
        results.filter((r) => !r.agreement.verdictAnyRepetition),
      ),
    );
    deps.stdout(
      `${outDir}: ${results.length}/${cases.length} cases, ${meter.calls.length} paid calls, settled spend ${spentUsd.toFixed(6)} USD, ${unknown} unknown\n${meter.refused() ? `STOPPED: ${meter.refused()}\n` : "complete\n"}`,
    );
    return meter.refused() ? 3 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../..");

async function createRegistry(
  storePath: string,
  offline: boolean,
): Promise<BaseRegistry> {
  const { ModelRegistry, ModelRuntime } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: storePath,
    signal: AbortSignal.timeout(60_000),
    ...(offline && { refreshOnCreate: false }),
  });
  return new ModelRegistry(runtime);
}

const gitOutput = (...args: string[]) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

export const defaultDeps: Deps = {
  async loadCases() {
    const { CASES } = (await import(
      pathToFileURL(resolve(import.meta.dirname, "cases.ts")).href
    )) as { CASES?: readonly EvalCase[] };
    if (!Array.isArray(CASES))
      throw new Error("cases.ts does not export CASES");
    return CASES;
  },
  async loadBenchmark(dirs) {
    return (
      await Promise.all(dirs.map((dir) => loadRun(resolve(dir))))
    ).flatMap((run) => run.observations);
  },
  createRegistry,
  loadRoutePrices: () => loadRouteTable(ROUTE_PRICES_URL),
  fetch: (...args) => globalThis.fetch(...args),
  git: () => ({
    sha: gitOutput("rev-parse", "HEAD"),
    dirty: gitOutput("status", "--porcelain") !== "",
  }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  now: () => new Date(),
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
