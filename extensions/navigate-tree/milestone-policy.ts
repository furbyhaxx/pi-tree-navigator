/**
 * Policy of the milestone classifier: which models judge whether the newest
 * work finished a phase, and how two models settle one decision.
 *
 * The preset is the benchmarked `confirm(jev-1.14 + gpt-6-luna chat)` pair (user
 * decision E17): a question is decided only when both models answer it with
 * the same choice at or above the confidence gate; anything else abstains.
 * Both models see the same request, the benchmarked "instructions" wording of
 * `milestone-classifier.ts`, and are asked in parallel.
 *
 * A policy is the `"recommended"` preset or an object that overrides it field
 * by field (see `MilestonePolicySetting`). An object is validated here and
 * carried as its canonical JSON text, so a changed policy compares unequal as
 * a plain string.
 *
 * The result only judges semantics. Whether a fold is safe is decided by the
 * engine's deterministic checks. No I/O of its own: requests go through the Pi
 * model registry, and a failed request abstains with a warning.
 */

import type {
  AssistantMessageEventStream,
  ClassifierContext,
  Usage,
} from "@earendil-works/pi-ai";
import {
  type PolicyRegistry,
  parseClassifierModel,
  resolveStageModels,
  type StageAnswer,
} from "./intent-policy.ts";
import {
  buildMilestoneClassifierContext,
  instructedWording,
  MILESTONE_STATUSES,
  type MilestoneInput,
  type MilestoneStatus,
  NO_BOUNDARY,
} from "./milestone-classifier.ts";

/** Config value that selects the benchmarked preset. */
export const RECOMMENDED_MILESTONE_CLASSIFIER = "recommended";

export const RECOMMENDED_MILESTONE_POLICY = {
  provider: "openrouter",
  /** Decisions model: answers first; its accepted choice is what the confirmer must repeat. */
  classifier: "typesafe/jev-1.14",
  /** Chat model that must give the same choice. */
  confirmer: "openai/gpt-6-luna",
} as const;

/** Evidence the user chose the preset on (E17, decided 2026-10-23). */
export const RECOMMENDED_MILESTONE_PROVENANCE = {
  decided: "2026-10-23",
  report:
    ".project/analyses/classifier-eval/reports/holdout-v3-2026-10-23/summary.md",
  policy: "confirm(jev-1.14#instructions + gpt-6-luna chat#instructions)",
  confidenceGate: 0.7,
  status: {
    holdoutUnsafeAccepted: 0,
    holdoutAcceptedExact: 0.646,
    developmentUnsafeAccepted: 0,
    developmentAcceptedExact: 0.813,
  },
  boundary: {
    holdoutUnsafeAccepted: 0,
    holdoutAcceptedExact: 0.76,
    developmentUnsafeAccepted: 0,
    developmentAcceptedExact: 0.75,
  },
  usdPer1000Decisions: 0.147,
  p95Seconds: { from: 4, to: 8 },
} as const;

const DEFAULT_MIN_CONFIDENCE = RECOMMENDED_MILESTONE_PROVENANCE.confidenceGate;
const MAX_INSTRUCTIONS_CHARS = 1_000;

/** The object form of a milestone policy; fields override the preset. */
export interface MilestonePolicySetting {
  preset?: typeof RECOMMENDED_MILESTONE_CLASSIFIER;
  /** An answer needs at least this confidence (0-1, exclusive of 0). Default 0.7. */
  minConfidence?: number;
  /** `model: null` switches the whole policy off; nothing is asked. */
  classifier?: { model?: string | null };
  /**
   * `model: null` drops the confirmation: the classifier then decides alone.
   * Single models were not safe on holdout: gpt-6-luna chat alone accepted 3
   * unsafe status and 5 unsafe boundary answers in 96 decisions each.
   */
  confirmer?: { model?: string | null };
  /** Replaces the wording of the status question. */
  status?: { instructions?: string };
  /** Replaces the wording of the boundary question. */
  boundary?: { instructions?: string };
}

/** A policy with every default and preset value applied. */
export interface MilestonePolicy {
  minConfidence: number;
  /** `provider/id`; null means the policy is off. */
  classifier: string | null;
  /** `provider/id`; null means the classifier decides alone. */
  confirmer: string | null;
  instructions: { status?: string; boundary?: string };
}

const selector = (id: string) =>
  `${RECOMMENDED_MILESTONE_POLICY.provider}/${id}`;

const OFF: MilestonePolicy = {
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  classifier: null,
  confirmer: null,
  instructions: {},
};

const RECOMMENDED: MilestonePolicy = {
  ...OFF,
  classifier: selector(RECOMMENDED_MILESTONE_POLICY.classifier),
  confirmer: selector(RECOMMENDED_MILESTONE_POLICY.confirmer),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Problems = string[];

function checkKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  problems: Problems,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) problems.push(`${where}.${key} is not a field`);
}

function modelStage(
  where: string,
  value: unknown,
  problems: Problems,
): { model?: string | null } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  checkKeys(where, value, ["model"], problems);
  if (!("model" in value)) return {};
  const model = value.model;
  if (model === null) return { model: null };
  if (
    typeof model === "string" &&
    parseClassifierModel(model.trim()) !== undefined
  )
    return { model: model.trim() };
  problems.push(`${where}.model must be "provider/id" or null`);
  return undefined;
}

function questionStage(
  where: string,
  value: unknown,
  problems: Problems,
): { instructions?: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  checkKeys(where, value, ["instructions"], problems);
  if (!("instructions" in value)) return {};
  const text = value.instructions;
  if (
    typeof text === "string" &&
    text.trim().length > 0 &&
    text.trim().length <= MAX_INSTRUCTIONS_CHARS
  )
    return { instructions: text.trim() };
  problems.push(
    `${where}.instructions must be a text of 1-${MAX_INSTRUCTIONS_CHARS} characters`,
  );
  return undefined;
}

function applySetting(setting: MilestonePolicySetting): MilestonePolicy {
  const base = setting.preset ? RECOMMENDED : OFF;
  return {
    minConfidence: setting.minConfidence ?? base.minConfidence,
    classifier:
      setting.classifier?.model !== undefined
        ? setting.classifier.model
        : base.classifier,
    confirmer:
      setting.confirmer?.model !== undefined
        ? setting.confirmer.model
        : base.confirmer,
    instructions: {
      ...(setting.status?.instructions !== undefined && {
        status: setting.status.instructions,
      }),
      ...(setting.boundary?.instructions !== undefined && {
        boundary: setting.boundary.instructions,
      }),
    },
  };
}

/**
 * Validate the object form strictly: unknown fields and wrong types are
 * problems, each named by its field path. On success `canonical` is the
 * object's normalized JSON text.
 */
export function parseMilestonePolicyObject(
  value: unknown,
):
  | { ok: true; canonical: string; setting: MilestonePolicySetting }
  | { ok: false; problems: Problems } {
  const root = "autoNavigate.milestone";
  const problems: Problems = [];
  if (!isRecord(value))
    return { ok: false, problems: [`${root} must be an object`] };
  checkKeys(
    root,
    value,
    [
      "preset",
      "minConfidence",
      "classifier",
      "confirmer",
      "status",
      "boundary",
    ],
    problems,
  );
  const setting: MilestonePolicySetting = {};
  if ("preset" in value) {
    if (value.preset === RECOMMENDED_MILESTONE_CLASSIFIER)
      setting.preset = RECOMMENDED_MILESTONE_CLASSIFIER;
    else
      problems.push(
        `${root}.preset must be "${RECOMMENDED_MILESTONE_CLASSIFIER}"`,
      );
  }
  if ("minConfidence" in value) {
    const confidence = value.minConfidence;
    if (typeof confidence === "number" && confidence > 0 && confidence <= 1)
      setting.minConfidence = confidence;
    else
      problems.push(`${root}.minConfidence must be a number above 0 up to 1`);
  }
  const classifier = modelStage(
    `${root}.classifier`,
    value.classifier,
    problems,
  );
  if (classifier) setting.classifier = classifier;
  const confirmer = modelStage(`${root}.confirmer`, value.confirmer, problems);
  if (confirmer) setting.confirmer = confirmer;
  const status = questionStage(`${root}.status`, value.status, problems);
  if (status) setting.status = status;
  const boundary = questionStage(`${root}.boundary`, value.boundary, problems);
  if (boundary) setting.boundary = boundary;
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, canonical: JSON.stringify(setting), setting };
}

/**
 * The policy a setting string stands for: the preset or the canonical text of
 * an object. `undefined` when it is neither.
 */
export function resolveMilestonePolicy(
  setting: string,
): MilestonePolicy | undefined {
  if (setting === RECOMMENDED_MILESTONE_CLASSIFIER) return RECOMMENDED;
  if (!setting.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(setting);
  } catch {
    return undefined;
  }
  const checked = parseMilestonePolicyObject(parsed);
  return checked.ok ? applySetting(checked.setting) : undefined;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What the classifier concluded about the state of the work. */
export type StatusDecision =
  | { kind: "accept"; status: MilestoneStatus }
  | { kind: "abstain" };

/** What the classifier concluded about the end of the finished phase. */
export type BoundaryDecision =
  | { kind: "record"; recordId: string }
  | { kind: "none" }
  | { kind: "abstain" };

/** Tokens and catalog-priced cost a stage reported; absent parts were not reported. */
export interface MilestoneUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MilestoneStageRun {
  stage: "classifier" | "confirmer";
  /** `provider/id` of the model that was asked. */
  model: string;
  /** False when the request failed. */
  answered: boolean;
  usage?: MilestoneUsage;
}

export interface MilestoneEvaluation {
  status: StatusDecision;
  boundary: BoundaryDecision;
  /** The stages that were asked, classifier first. Empty when nothing was asked. */
  ran: MilestoneStageRun[];
  /** The sum over the stages that reported usage. */
  usage: MilestoneUsage;
  warnings: string[];
}

const noUsage = (): MilestoneUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

const addUsage = (total: MilestoneUsage, part: MilestoneUsage): void => {
  total.inputTokens += part.inputTokens;
  total.outputTokens += part.outputTokens;
  total.costUsd += part.costUsd;
};

/** A registry that adds the usage of every request it forwards to `sink`. */
function reportingUsage(
  registry: PolicyRegistry,
  sink: MilestoneUsage,
  reported: { any: boolean },
): PolicyRegistry {
  const record = (usage: Usage | undefined) => {
    if (!usage) return;
    reported.any = true;
    addUsage(sink, {
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: usage.cost.total,
    });
  };
  return {
    getAvailableOfType: (...args) => registry.getAvailableOfType(...args),
    classify: async (...args) => {
      const result = await registry.classify(...args);
      record(result.usage);
      return result;
    },
    // The asks read only `.result()`; the stream itself is never consumed.
    streamSimple: (...args) => {
      const stream = registry.streamSimple(...args);
      return {
        result: async () => {
          const message = await stream.result();
          record(message.usage);
          return message;
        },
      } as unknown as AssistantMessageEventStream;
    },
  };
}

/** The choice each question was answered with, when the answer may stand. */
type Accepted = Record<string, string | undefined>;

/**
 * An answer stands when it is for an offered choice with a confidence in
 * [0,1] at or above the gate. An answer to a question that was not asked makes
 * the whole response unusable.
 */
function gate(
  answers: Record<string, StageAnswer>,
  context: ClassifierContext,
  minConfidence: number,
): { accepted: Accepted; problems: string[] } {
  const accepted: Accepted = {};
  const problems: string[] = [];
  const unknown = Object.keys(answers).filter(
    (id) => !Object.hasOwn(context.questions, id),
  );
  if (unknown.length > 0)
    return {
      accepted,
      problems: [`answered unknown question ${unknown.join(", ")}`],
    };
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = answers[id];
    if (
      question.type !== "choice" ||
      answer === undefined ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      problems.push(`no usable answer to ${id}`);
      continue;
    }
    if (answer.confidence >= minConfidence) accepted[id] = answer.choice;
  }
  return { accepted, problems };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Ask the policy's models about the newest records and combine their answers.
 *
 * A question is decided when the classifier's answer clears the confidence
 * gate and the confirmer, asked the same request in parallel, clears it with
 * the same choice; without a confirmer the classifier decides alone. Every
 * other outcome abstains: low confidence, a disagreement, a choice that was
 * not offered, an unusable answer, an unavailable model or a failed request.
 * Failures add a warning and never produce a decision. Never throws.
 */
export async function evaluateMilestone(args: {
  policy: MilestonePolicy;
  registry: PolicyRegistry;
  input: MilestoneInput;
  signal?: AbortSignal;
}): Promise<MilestoneEvaluation> {
  const { policy, registry, input, signal } = args;
  const result: MilestoneEvaluation = {
    status: { kind: "abstain" },
    boundary: { kind: "abstain" },
    ran: [],
    usage: noUsage(),
    warnings: [],
  };
  if (
    policy.classifier === null ||
    input.records.length === 0 ||
    signal?.aborted
  )
    return result;

  const stages = [
    { stage: "classifier" as const, model: policy.classifier },
    ...(policy.confirmer !== null
      ? [{ stage: "confirmer" as const, model: policy.confirmer }]
      : []),
  ];
  const { context } = buildMilestoneClassifierContext(
    input,
    instructedWording(policy.instructions),
  );

  const prepared = await Promise.all(
    stages.map(async (stage) => {
      const usage = noUsage();
      const reported = { any: false };
      const resolved = await resolveStageModels(
        reportingUsage(registry, usage, reported),
        [stage.model],
      );
      const ask = resolved.ok ? resolved.asks.get(stage.model) : undefined;
      return {
        ...stage,
        usage,
        reported,
        ...(ask
          ? { ask }
          : { reason: resolved.ok ? "not available" : resolved.reason }),
      };
    }),
  );
  const ready = prepared.flatMap((stage) =>
    "ask" in stage ? [{ ...stage, ask: stage.ask }] : [],
  );
  if (ready.length < prepared.length) {
    const reasons = prepared.flatMap((stage) =>
      "reason" in stage ? [stage.reason] : [],
    );
    result.warnings.push(
      `navigate_tree: milestone classifier unavailable (${reasons.join("; ")}); no milestone decision.`,
    );
    return result;
  }

  const asked = await Promise.all(
    ready.map(async (stage) => {
      try {
        return { stage, answers: await stage.ask(context, signal) };
      } catch (error) {
        return { stage, error: errorText(error) };
      }
    }),
  );

  const accepted: Accepted[] = [];
  for (const outcome of asked) {
    const { stage } = outcome;
    const gated = outcome.answers
      ? gate(outcome.answers, context, policy.minConfidence)
      : { accepted: {}, problems: [`failed (${outcome.error})`] };
    accepted.push(gated.accepted);
    result.ran.push({
      stage: stage.stage,
      model: stage.model,
      answered: outcome.answers !== undefined,
      ...(stage.reported.any && { usage: stage.usage }),
    });
    if (stage.reported.any) addUsage(result.usage, stage.usage);
    if (!signal?.aborted && gated.problems.length > 0)
      result.warnings.push(
        `navigate_tree: milestone ${stage.stage} ${stage.model}: ${gated.problems.join("; ")}; those answers do not count.`,
      );
  }
  if (signal?.aborted) return result;

  const [first, second] = accepted;
  const decided = (question: string): string | undefined => {
    const choice = first?.[question];
    return choice !== undefined &&
      (policy.confirmer === null || second?.[question] === choice)
      ? choice
      : undefined;
  };
  const status = decided("status");
  const boundary = decided("boundary");
  if (status !== undefined && isStatus(status))
    result.status = { kind: "accept", status };
  if (boundary !== undefined)
    result.boundary =
      boundary === NO_BOUNDARY
        ? { kind: "none" }
        : { kind: "record", recordId: boundary };
  return result;
}

const isStatus = (value: string): value is MilestoneStatus =>
  (MILESTONE_STATUSES as readonly string[]).includes(value);
