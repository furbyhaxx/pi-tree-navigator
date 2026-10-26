/** Bounded classifier requests, answer validation, and model resolution. */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
	IntentInput,
	IntentKind,
	IntentRegistry,
	IntentVerdict,
} from "./continuity-capture.ts";
import { capText } from "./continuity-ledger-model.ts";
import {
	classifierAsk,
	parseClassifierModel,
	RECOMMENDED_INTENT_CLASSIFIER,
	resolveStageModels,
	type StageAnswer,
	type StageAsk,
} from "./intent-policy.ts";

export const INTENT_KINDS = [
	"objective",
	"sub-goal",
	"rule",
	"decision",
	"steering",
	"ephemeral",
] as const;

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
export function pickItems(items: IntentInput["activeItems"]): IntentInput["activeItems"] {
	return [...items]
		.sort(
			(a, b) =>
				(KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3) ||
				idNumber(b.id) - idNumber(a.id),
		)
		.slice(0, MAX_CLASSIFIER_ITEMS);
}

export function classifierContext(
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

export const ephemeral = (warning?: string): IntentVerdict => ({
	kind: "ephemeral",
	by: "classifier",
	...(warning !== undefined && { warning }),
});

export type Answers = Record<string, StageAnswer> | undefined;

// `undefined` is an abstention: low confidence, or no usable kind answer.
export function acceptedKind(answers: Answers, minConfidence: number): IntentKind | undefined {
	const kind = answers?.kind;
	return kind !== undefined && kind.confidence >= minConfidence && isIntentKind(kind.choice)
		? kind.choice
		: undefined;
}

// An answer to `contradicts` that names an offered choice with enough confidence.
export function acceptedContradiction(
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

type PolicyRegistry = IntentRegistry &
	Required<Pick<ModelRegistry, "getAvailableOfType" | "streamSimple">>;

const hasPolicyApi = (registry: IntentRegistry): registry is PolicyRegistry =>
	typeof registry.getAvailableOfType === "function" && typeof registry.streamSimple === "function";

export const unknownModel = (setting: string) =>
	`navigate_tree: continuity classifier model ${JSON.stringify(setting)} is not a known classifier model (expected "provider/id"); capture uses heuristics only.`;

/** Every stage model of `policy`, resolved to something that can answer. */
export async function resolveAsks(
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
