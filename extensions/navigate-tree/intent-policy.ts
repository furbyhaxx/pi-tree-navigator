/**
 * Policy of the intent classifier: which models judge a user message for the
 * continuity ledger and how a second model settles a doubtful supersession.
 *
 * `continuity.intentClassifier` is a `provider/id` model (one model, both
 * questions), the `"recommended"` preset, or an object that overrides the
 * preset field by field (see `IntentPolicySetting`). An object is validated
 * here and carried through the effective config as its canonical JSON text, so
 * a changed policy compares unequal as a plain string.
 *
 * No I/O of its own: requests go through the Pi model registry.
 */

import type {
  Api,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Config value that selects the benchmarked preset. */
export const RECOMMENDED_INTENT_CLASSIFIER = "recommended";

export const RECOMMENDED_POLICY = {
  provider: "openrouter",
  /** Decisions model: the intent kind, and the first answer to `contradicts`. */
  classifier: "microsoft/microsoft-decision-1",
  /** Chat model asked `contradicts` only when the classifier abstains on it. */
  escalation: "openai/gpt-6-luna",
} as const;

/** Evidence the user chose the preset on ("Split + chain", decided 2026-10-23). */
export const RECOMMENDED_POLICY_PROVENANCE = {
  decided: "2026-10-23",
  report:
    ".project/analyses/classifier-eval/reports/catalogued-2026-10-23/report.md",
  confidenceGate: 0.7,
  intentKind: {
    policy: "single(microsoft-decision-1)",
    holdoutCases: 8,
    holdoutUnsafeAccepted: 0,
    holdoutAcceptedExact: 0.75,
    developmentAcceptedExact: 0.8125,
    rejected: "escalating the kind to gpt-6-luna chat: 2 unsafe on holdout",
  },
  supersession: {
    policy: "chain(microsoft-decision-1 > gpt-6-luna chat)",
    holdoutCases: 8,
    holdoutUnsafeAccepted: 0,
    developmentUnsafeAccepted: 0,
    holdoutAcceptedExact: 0.875,
    developmentAcceptedExact: 0.9375,
    usdPer1000Decisions: 0.0368,
  },
} as const;

/** One stage of the object form; `model: null` switches the stage off. */
export interface IntentStageSetting {
  /** `provider/id` of a classifier or chat model in the Pi catalog, or null. */
  model?: string | null;
  /** Replaces the question wording the production builder sends. */
  instructions?: string;
}

/** The object form of `continuity.intentClassifier`; fields override the preset. */
export interface IntentPolicySetting {
  preset?: typeof RECOMMENDED_INTENT_CLASSIFIER;
  /** Heuristic classifier as kind source (when `kind.model` is null) and fallback. Default true. */
  heuristics?: boolean;
  /** A stage answer needs at least this confidence (0-1, exclusive of 0). Default 0.7. */
  minConfidence?: number;
  /** The intent kind. Never escalated. */
  kind?: IntentStageSetting;
  /** Which active item the message replaces. */
  supersession?: IntentStageSetting & {
    /** Asked only when `supersession` abstains (or is off). */
    escalation?: IntentStageSetting;
  };
}

interface StagePolicy {
  model: string | null;
  instructions?: string;
}

/** A policy with every default and preset value applied. */
export interface IntentPolicy {
  heuristics: boolean;
  minConfidence?: number;
  kind: StagePolicy;
  supersession: StagePolicy;
  escalation: StagePolicy;
}

const selector = (id: string) => `${RECOMMENDED_POLICY.provider}/${id}`;

const NO_MODELS: IntentPolicy = {
  heuristics: true,
  kind: { model: null },
  supersession: { model: null },
  escalation: { model: null },
};

const RECOMMENDED: IntentPolicy = {
  heuristics: true,
  kind: { model: selector(RECOMMENDED_POLICY.classifier) },
  supersession: { model: selector(RECOMMENDED_POLICY.classifier) },
  escalation: { model: selector(RECOMMENDED_POLICY.escalation) },
};

const MAX_INSTRUCTIONS_CHARS = 1_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Problems = string[];

function checkKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  problems: Problems,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}.${key} is not a field`);
  }
}

function stageOf(
  where: string,
  value: unknown,
  problems: Problems,
  extra: readonly string[] = [],
): IntentStageSetting | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  checkKeys(where, value, ["model", "instructions", ...extra], problems);
  const out: IntentStageSetting = {};
  if ("model" in value) {
    const model = value.model;
    if (model === null) out.model = null;
    else if (
      typeof model === "string" &&
      parseClassifierModel(model.trim()) !== undefined
    ) {
      out.model = model.trim();
    } else {
      problems.push(`${where}.model must be "provider/id" or null`);
    }
  }
  if ("instructions" in value) {
    const text = value.instructions;
    if (
      typeof text === "string" &&
      text.trim().length > 0 &&
      text.trim().length <= MAX_INSTRUCTIONS_CHARS
    ) {
      out.instructions = text.trim();
    } else {
      problems.push(
        `${where}.instructions must be a text of 1-${MAX_INSTRUCTIONS_CHARS} characters`,
      );
    }
  }
  return out;
}

/** Overrides applied to `base`; absent fields keep the base value. */
function overlay(base: StagePolicy, over: IntentStageSetting | undefined) {
  return {
    model: over?.model !== undefined ? over.model : base.model,
    ...((over?.instructions ?? base.instructions) !== undefined && {
      instructions: over?.instructions ?? base.instructions,
    }),
  } as StagePolicy;
}

function applySetting(
  setting: IntentPolicySetting,
  preset: IntentPolicy,
): IntentPolicy {
  return {
    heuristics: setting.heuristics ?? preset.heuristics,
    ...((setting.minConfidence ?? preset.minConfidence) !== undefined && {
      minConfidence: setting.minConfidence ?? preset.minConfidence,
    }),
    kind: overlay(preset.kind, setting.kind),
    supersession: overlay(preset.supersession, setting.supersession),
    escalation: overlay(preset.escalation, setting.supersession?.escalation),
  };
}

/**
 * Validate the object form strictly: unknown fields, wrong types and a policy
 * with no source for the kind are problems, each named by its field path.
 * On success `canonical` is the object's normalized JSON text.
 */
export function parseIntentPolicyObject(
  value: unknown,
):
  | { ok: true; canonical: string; setting: IntentPolicySetting }
  | { ok: false; problems: Problems } {
  const root = "continuity.intentClassifier";
  const problems: Problems = [];
  if (!isRecord(value)) {
    return { ok: false, problems: [`${root} must be an object`] };
  }
  checkKeys(
    root,
    value,
    ["preset", "heuristics", "minConfidence", "kind", "supersession"],
    problems,
  );
  const setting: IntentPolicySetting = {};
  if ("preset" in value) {
    if (value.preset === RECOMMENDED_INTENT_CLASSIFIER) {
      setting.preset = RECOMMENDED_INTENT_CLASSIFIER;
    } else {
      problems.push(
        `${root}.preset must be "${RECOMMENDED_INTENT_CLASSIFIER}"`,
      );
    }
  }
  if ("heuristics" in value) {
    if (typeof value.heuristics === "boolean") {
      setting.heuristics = value.heuristics;
    } else {
      problems.push(`${root}.heuristics must be true or false`);
    }
  }
  if ("minConfidence" in value) {
    const confidence = value.minConfidence;
    if (typeof confidence === "number" && confidence > 0 && confidence <= 1) {
      setting.minConfidence = confidence;
    } else {
      problems.push(`${root}.minConfidence must be a number above 0 up to 1`);
    }
  }
  const kind = stageOf(`${root}.kind`, value.kind, problems);
  if (kind) setting.kind = kind;
  const supersession = stageOf(
    `${root}.supersession`,
    value.supersession,
    problems,
    ["escalation"],
  );
  if (supersession) {
    const escalation = stageOf(
      `${root}.supersession.escalation`,
      isRecord(value.supersession) ? value.supersession.escalation : undefined,
      problems,
    );
    setting.supersession = {
      ...supersession,
      ...(escalation && { escalation }),
    };
  }
  if (problems.length > 0) return { ok: false, problems };
  const policy = applySetting(
    setting,
    setting.preset ? RECOMMENDED : NO_MODELS,
  );
  if (!policy.heuristics && policy.kind.model === null) {
    return {
      ok: false,
      problems: [
        `${root} has no source for the intent kind: set kind.model or leave heuristics on`,
      ],
    };
  }
  return { ok: true, canonical: JSON.stringify(setting), setting };
}

/**
 * The policy a `continuity.intentClassifier` string stands for: the preset, a
 * canonical object, or one `provider/id` model for both questions with the
 * heuristic as fallback. `undefined` when it is none of these.
 */
export function resolveIntentPolicy(setting: string): IntentPolicy | undefined {
  if (setting === RECOMMENDED_INTENT_CLASSIFIER) return RECOMMENDED;
  if (setting.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(setting);
    } catch {
      return undefined;
    }
    const checked = parseIntentPolicyObject(parsed);
    return checked.ok
      ? applySetting(
          checked.setting,
          checked.setting.preset ? RECOMMENDED : NO_MODELS,
        )
      : undefined;
  }
  return parseClassifierModel(setting)
    ? {
        ...NO_MODELS,
        kind: { model: setting },
        supersession: { model: setting },
      }
    : undefined;
}

// ---------------------------------------------------------------------------
// Stages: asking a classifier model or a chat model
// ---------------------------------------------------------------------------

/** A choice answer; `choice` may still be outside the question's offered choices. */
export interface StageAnswer {
  choice: string;
  confidence: number;
}

/**
 * Asks the questions in `context` and resolves to the choice answers it could
 * read, by question id; a missing id is an abstention. Rejects when the
 * request fails.
 */
export type StageAsk = (
  context: ClassifierContext,
  signal?: AbortSignal,
) => Promise<Record<string, StageAnswer>>;

export type PolicyRegistry = Pick<
  ModelRegistry,
  "getAvailableOfType" | "streamSimple" | "classify"
>;

/** Asks a registry classifier model. */
export function classifierAsk(
  registry: Pick<ModelRegistry, "classify">,
  model: ClassifierModel<ClassifierApi>,
): StageAsk {
  return async (context, signal) => {
    const result = await registry.classify(
      model,
      context,
      signal ? { signal } : undefined,
    );
    if (result.stopReason !== "stop") {
      throw new Error(result.errorMessage ?? result.stopReason);
    }
    const answers: Record<string, StageAnswer> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type === "choice") {
        answers[id] = { choice: answer.choice, confidence: answer.confidence };
      }
    }
    return answers;
  };
}

/** Output cap of a chat stage; the answer is one short JSON object. */
export const CHAT_MAX_OUTPUT_TOKENS = 1_024;

// The message sits inside the JSON state and the model is told to judge only
// that state, so the user's words are data to it, not instructions.
const CHAT_SYSTEM_PROMPT =
  "You classify structured state. For every question, choose exactly one choice key from its list and judge only the state provided. " +
  'Reply with a single JSON object and nothing else, shaped {"answers": {"<question id>": {"choice": "<choice key>", "confidence": <number from 0 to 1, your probability that the choice is correct>}}}. Answer every question.';

/** Offered choice keys by question id. */
type ChoiceKeys = Record<string, string[]>;

function choiceKeys(context: ClassifierContext): ChoiceKeys {
  return Object.fromEntries(
    Object.entries(context.questions).flatMap(([id, question]) =>
      question.type === "choice" ? [[id, Object.keys(question.criteria)]] : [],
    ),
  );
}

function chatPrompt(context: ClassifierContext): string {
  const questions = Object.entries(context.questions).flatMap(([id, q]) =>
    q.type === "choice"
      ? [
          `## ${id}\n${q.instructions}\nChoices:\n${Object.entries(q.criteria)
            .map(([key, description]) => `- ${key}: ${description}`)
            .join("\n")}`,
        ]
      : [],
  );
  return `State:\n${JSON.stringify(context.state)}\n\nQuestions:\n\n${questions.join("\n\n")}`;
}

/** Strict JSON schema of the chat answer; `choice` is limited to each question's keys. */
function answerSchema(questions: ChoiceKeys) {
  return {
    type: "object",
    properties: {
      answers: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(questions).map(([id, keys]) => [
            id,
            {
              type: "object",
              properties: {
                choice: { type: "string", enum: keys },
                confidence: { type: "number" },
              },
              required: ["choice", "confidence"],
              additionalProperties: false,
            },
          ]),
        ),
        required: Object.keys(questions),
        additionalProperties: false,
      },
    },
    required: ["answers"],
    additionalProperties: false,
  };
}

function parseChatAnswers(
  text: string,
  questions: ChoiceKeys,
): Record<string, StageAnswer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return {};
  }
  const raw = isRecord(parsed) ? parsed.answers : undefined;
  const answers: Record<string, StageAnswer> = {};
  if (!isRecord(raw)) return answers;
  for (const [id, keys] of Object.entries(questions)) {
    const entry = raw[id];
    if (
      isRecord(entry) &&
      typeof entry.choice === "string" &&
      keys.includes(entry.choice) &&
      typeof entry.confidence === "number" &&
      entry.confidence >= 0 &&
      entry.confidence <= 1
    ) {
      answers[id] = { choice: entry.choice, confidence: entry.confidence };
    }
  }
  return answers;
}

/**
 * Asks a registry chat model. Output that is not JSON, or a choice that was
 * not offered, leaves that question unanswered.
 */
export function chatAsk(
  registry: Pick<ModelRegistry, "streamSimple">,
  model: Model<Api>,
): StageAsk {
  return async (context, signal) => {
    const questions = choiceKeys(context);
    const responseFormat =
      model.api === "openai-completions"
        ? {
            type: "json_schema",
            json_schema: {
              name: "classifier_answers",
              strict: true,
              schema: answerSchema(questions),
            },
          }
        : undefined;
    const message = await registry
      .streamSimple(
        model,
        {
          systemPrompt: CHAT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: chatPrompt(context),
              timestamp: Date.now(),
            },
          ],
        },
        {
          toolChoice: "none",
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
          ...(signal && { signal }),
          onPayload: (payload) => {
            if (!isRecord(payload)) return undefined;
            // No tools are declared, and `tool_choice` without tools is rejected by some routes.
            const { tool_choice: _unused, ...rest } = payload;
            return {
              ...rest,
              ...(responseFormat && { response_format: responseFormat }),
            };
          },
        },
      )
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? message.stopReason);
    }
    return parseChatAnswers(
      message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(""),
      questions,
    );
  };
}

/**
 * Resolve each `provider/id` to a model in the Pi catalog with working
 * credentials, a classifier model first, else a chat model. Any selector that
 * resolves to neither makes the whole set unavailable.
 */
export async function resolveStageModels(
  registry: PolicyRegistry,
  selectors: readonly string[],
): Promise<
  { ok: true; asks: Map<string, StageAsk> } | { ok: false; reason: string }
> {
  const asks = new Map<string, StageAsk>();
  const missing: string[] = [];
  try {
    for (const text of new Set(selectors)) {
      const parsed = parseClassifierModel(text);
      const [classifiers, chats] = parsed
        ? await Promise.all([
            registry.getAvailableOfType("classifier", parsed.provider),
            registry.getAvailableOfType("chat", parsed.provider),
          ])
        : [[], []];
      const decisions = classifiers.find((model) => model.id === parsed?.id);
      const chat = chats.find((model) => model.id === parsed?.id);
      if (decisions) asks.set(text, classifierAsk(registry, decisions));
      else if (chat) asks.set(text, chatAsk(registry, chat));
      else missing.push(text);
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return missing.length > 0
    ? {
        ok: false,
        reason: `${missing.join(" and ")} not available with configured credentials`,
      }
    : { ok: true, asks };
}
