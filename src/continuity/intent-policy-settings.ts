/** Policy setting shapes, structural checks, and effective-stage overlays. */

import type { RECOMMENDED_INTENT_CLASSIFIER } from "./intent-policy.ts";

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
		/** Confirms a retirement named by escalation. `model: null` skips the check. */
		verification?: IntentStageSetting;
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
	/** Asked only about a retirement the escalation stage named. */
	verification: StagePolicy;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export type Problems = string[];

export function checkKeys(
	where: string,
	value: Record<string, unknown>,
	allowed: readonly string[],
	problems: Problems,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) problems.push(`${where}.${key} is not a field`);
	}
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

export function applySetting(setting: IntentPolicySetting, preset: IntentPolicy): IntentPolicy {
	return {
		heuristics: setting.heuristics ?? preset.heuristics,
		...((setting.minConfidence ?? preset.minConfidence) !== undefined && {
			minConfidence: setting.minConfidence ?? preset.minConfidence,
		}),
		kind: overlay(preset.kind, setting.kind),
		supersession: overlay(preset.supersession, setting.supersession),
		escalation: overlay(preset.escalation, setting.supersession?.escalation),
		verification: overlay(preset.verification, setting.supersession?.verification),
	};
}
