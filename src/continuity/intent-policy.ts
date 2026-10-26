/** Intent classifier presets, policy validation, and Pi registry stage adapters. */

import type {
	Api,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	answerSchema,
	CHAT_SYSTEM_PROMPT,
	chatPrompt,
	choiceKeys,
	parseChatAnswers,
} from "./intent-policy-chat.ts";
import {
	applySetting,
	checkKeys,
	type IntentPolicy,
	type IntentPolicySetting,
	type IntentStageSetting,
	isRecord,
	type Problems,
} from "./intent-policy-settings.ts";

/** Config value that selects the benchmarked preset. */
export const RECOMMENDED_INTENT_CLASSIFIER = "recommended";

export const RECOMMENDED_POLICY = {
	/** Decisions model: the intent kind, and the first answer to `contradicts`. */
	classifier: "openrouter/microsoft/microsoft-decision-1",
	/** Chat model asked `contradicts` only when the classifier abstains on it. */
	escalation: "openai/gpt-6-luna",
} as const;

/**
 * Evidence for the preset. Holdout v3 capture is 32 cases repeated 3 times
 * (96 decisions). Retirement negatives are 134 cases repeated 3 times (402
 * decisions); those repeats are not independent observations. Printed rates
 * are observed fractions, not a bound or a guarantee.
 */
export const RECOMMENDED_POLICY_PROVENANCE = {
	decided: "2026-10-23",
	reports: {
		holdout: ".project/analyses/classifier-eval/reports/holdout-v3-2026-10-23/summary.md",
		retirement: ".project/analyses/classifier-eval/reports/retirement-check-2026-10-23/summary.md",
	},
	confidenceGate: 0.7,
	intentKind: {
		policy: "single(microsoft-decision-1)",
		holdoutCases: 32,
		repetitions: 3,
		holdoutDecisions: 96,
		holdoutUnsafeAccepted: 0,
		holdoutAcceptedExact: 0.781,
		developmentAcceptedExact: 0.813,
		usdPer1000Decisions: 0.01,
		rejected: "escalating the kind to gpt-6-luna chat: 2 unsafe accepted in 96 holdout decisions",
	},
	supersession: {
		policy: "chain(microsoft-decision-1 > gpt-6-luna chat)",
		holdoutCases: 32,
		repetitions: 3,
		holdoutDecisions: 96,
		holdoutUnsafeAccepted: 1,
		developmentUnsafeAccepted: 0,
		holdoutAcceptedExact: 0.927,
		developmentAcceptedExact: 0.938,
		replayUsdPer1000Decisions: 0.0418,
		summaryUsdPer1000Range: [0.022, 0.042],
	},
	retirementVerification: {
		policy: "verify escalated retirements with microsoft-decision-1",
		verifier: "openrouter/microsoft/microsoft-decision-1",
		gate: 0.7,
		holdoutCases: 152,
		holdoutPositives: 13,
		holdoutNegatives: 134,
		holdoutAmbiguous: 5,
		repetitions: 3,
		repeatedNegativeDecisions: 402,
		repeatedPositiveDecisions: 39,
		repeatsAreIndependent: false,
		holdoutUnsafeYes: 0,
		holdoutPositivesAccepted: 39,
		developmentNegatives: 120,
		developmentUnsafeYes: 0,
		developmentPositivesAccepted: 14,
		replay: {
			decisions: 96,
			unsafeBefore: 1,
			unsafeAfter: 0,
			checked: 4,
			confirmed: 0,
			rejected: 4,
			unsafeStopped: 1,
			positivesBlocked: 0,
			ambiguousRejected: 3,
			acceptedExactIfRejectionKeepsItem: 0.938,
			addedUsdPer1000Decisions: 0.0005,
			addedP95Ms: 341,
		},
	},
} as const;

const NO_MODELS: IntentPolicy = {
	heuristics: true,
	kind: { model: null },
	supersession: { model: null },
	escalation: { model: null },
	verification: { model: null },
};

const RECOMMENDED: IntentPolicy = {
	heuristics: true,
	kind: { model: RECOMMENDED_POLICY.classifier },
	supersession: { model: RECOMMENDED_POLICY.classifier },
	escalation: { model: RECOMMENDED_POLICY.escalation },
	verification: { model: RECOMMENDED_POLICY.classifier },
};

const MAX_INSTRUCTIONS_CHARS = 1_000;

/** Split `provider/id` at the first slash (ids may contain slashes). */
export function parseClassifierModel(value: string): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) {
		return undefined;
	}
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
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
		const model = value["model"];
		if (model === null) out.model = null;
		else if (typeof model === "string" && parseClassifierModel(model.trim()) !== undefined) {
			out.model = model.trim();
		} else {
			problems.push(`${where}.model must be "provider/id" or null`);
		}
	}
	if ("instructions" in value) {
		const text = value["instructions"];
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

const SUPERSESSION_STAGES = ["escalation", "verification"] as const;

function nestedStages(
	where: string,
	parent: unknown,
	problems: Problems,
): Partial<Record<(typeof SUPERSESSION_STAGES)[number], IntentStageSetting>> {
	const record = isRecord(parent) ? parent : undefined;
	const out: Partial<Record<(typeof SUPERSESSION_STAGES)[number], IntentStageSetting>> = {};
	for (const key of SUPERSESSION_STAGES) {
		const stage = stageOf(`${where}.${key}`, record?.[key], problems);
		if (stage) out[key] = stage;
	}
	return out;
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
		if (value["preset"] === RECOMMENDED_INTENT_CLASSIFIER) {
			setting.preset = RECOMMENDED_INTENT_CLASSIFIER;
		} else {
			problems.push(`${root}.preset must be "${RECOMMENDED_INTENT_CLASSIFIER}"`);
		}
	}
	if ("heuristics" in value) {
		if (typeof value["heuristics"] === "boolean") {
			setting.heuristics = value["heuristics"];
		} else {
			problems.push(`${root}.heuristics must be true or false`);
		}
	}
	if ("minConfidence" in value) {
		const confidence = value["minConfidence"];
		if (typeof confidence === "number" && confidence > 0 && confidence <= 1) {
			setting.minConfidence = confidence;
		} else {
			problems.push(`${root}.minConfidence must be a number above 0 up to 1`);
		}
	}
	const kind = stageOf(`${root}.kind`, value["kind"], problems);
	if (kind) setting.kind = kind;
	const supersession = stageOf(
		`${root}.supersession`,
		value["supersession"],
		problems,
		SUPERSESSION_STAGES,
	);
	if (supersession) {
		setting.supersession = {
			...supersession,
			...nestedStages(`${root}.supersession`, value["supersession"], problems),
		};
	}
	if (problems.length > 0) return { ok: false, problems };
	const policy = applySetting(setting, setting.preset ? RECOMMENDED : NO_MODELS);
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
			? applySetting(checked.setting, checked.setting.preset ? RECOMMENDED : NO_MODELS)
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
		const result = await registry.classify(model, context, signal ? { signal } : undefined);
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
			message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
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
): Promise<{ ok: true; asks: Map<string, StageAsk> } | { ok: false; reason: string }> {
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
