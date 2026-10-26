/** Per-field precedence and fresh empty layers for config composition. */

import {
	type AutoNavigatePartial,
	mergeAutoNavigatePartial,
} from "../auto/auto-navigate-config.ts";
import { mergeProposalOptions } from "../retrospective/proposal-options.ts";
import type { ParsedLayer } from "./config.ts";
import { type HintField, noModelOverridesProblems } from "./config-fields.ts";

function mergeAutoNavigateField(
	globalLayer: ParsedLayer,
	projectLayer: ParsedLayer,
): Pick<ParsedLayer, "autoNavigate" | "modelAutoNavigate"> {
	const global = globalLayer.autoNavigate;
	const project = projectLayer.autoNavigate;
	let autoNavigate: ParsedLayer["autoNavigate"];
	if (project?.kind === "invalid") autoNavigate = project;
	else if (global?.kind === "invalid") autoNavigate = global;
	else if (global?.kind === "ok" || project?.kind === "ok") {
		const merged = mergeAutoNavigatePartial(global?.value, project?.value);
		if (merged) autoNavigate = { kind: "ok", value: merged };
	}
	const mergedByModel = new Map<
		string,
		{ kind: "ok"; value: AutoNavigatePartial } | { kind: "invalid"; error: string }
	>();
	for (const [key, entry] of globalLayer.modelAutoNavigate ?? []) {
		mergedByModel.set(key, entry);
	}
	for (const [key, entry] of projectLayer.modelAutoNavigate ?? []) {
		const prev = mergedByModel.get(key);
		if (entry.kind === "invalid") {
			mergedByModel.set(key, entry);
		} else if (prev?.kind === "invalid") {
			mergedByModel.set(key, entry);
		} else if (prev?.kind === "ok") {
			const merged = mergeAutoNavigatePartial(prev.value, entry.value);
			if (merged) mergedByModel.set(key, { kind: "ok", value: merged });
		} else {
			mergedByModel.set(key, entry);
		}
	}
	return {
		...(autoNavigate ? { autoNavigate } : {}),
		...(mergedByModel.size > 0 ? { modelAutoNavigate: mergedByModel } : {}),
	};
}

function mergeProposalField(
	globalLayer: ParsedLayer,
	projectLayer: ParsedLayer,
): Pick<ParsedLayer, "proposal"> {
	const global = globalLayer.proposal;
	const project = projectLayer.proposal;
	if (project?.kind === "invalid") return { proposal: project };
	if (global?.kind === "invalid") return { proposal: global };
	if (!global && !project) return {};
	return {
		proposal: {
			kind: "ok",
			value: mergeProposalOptions(global?.value ?? { tools: {} }, project?.value ?? {}),
		},
	};
}

function mergeConsolidationField(
	globalLayer: ParsedLayer,
	projectLayer: ParsedLayer,
): Pick<ParsedLayer, "consolidation"> {
	const global = globalLayer.consolidation;
	const project = projectLayer.consolidation;
	if (!global && !project) return {};
	const absent = { kind: "absent" } as const;
	return {
		consolidation: {
			enabled: mergeFallbackField(global?.enabled ?? absent, project?.enabled ?? absent),
			maxHandoffs: mergeFallbackField(
				global?.maxHandoffs ?? absent,
				project?.maxHandoffs ?? absent,
			),
			maxWindowShare: mergeFallbackField(
				global?.maxWindowShare ?? absent,
				project?.maxWindowShare ?? absent,
			),
			keepNewest: mergeFallbackField(global?.keepNewest ?? absent, project?.keepNewest ?? absent),
			notObject: false,
		},
	};
}

function mergeContinuityField(
	globalLayer: ParsedLayer,
	projectLayer: ParsedLayer,
): Pick<ParsedLayer, "continuity"> {
	const global = globalLayer.continuity;
	const project = projectLayer.continuity;
	if (!global && !project) return {};
	const absent = { kind: "absent" } as const;
	return {
		continuity: {
			capture: mergeFallbackField(global?.capture ?? absent, project?.capture ?? absent),
			intentClassifier: mergeFallbackField(
				global?.intentClassifier ?? absent,
				project?.intentClassifier ?? absent,
			),
			notObject: false,
		},
	};
}

/**
 * Merge a single field. For the hint, `absent` is the only value that falls
 * through: a project layer that is absent (or file-level unusable, which
 * leaves every field absent) contributes nothing, while `ok`, `disabled`,
 * and field-level `invalid` all win — a present project key is the user's
 * explicit intent for this project.
 */
function mergeHintField(globalField: HintField, projectField: HintField): HintField {
	return projectField.kind === "absent" ? globalField : projectField;
}

/** Merge fields where invalid values fall through to the other valid layer. */
function mergeFallbackField<F extends { kind: "absent" | "ok" | "invalid" }>(
	globalField: F,
	projectField: F,
): F {
	if (projectField.kind === "ok") return projectField;
	if (projectField.kind === "invalid") {
		return globalField.kind === "ok" ? globalField : projectField;
	}
	return globalField;
}

/**
 * Merge the two layers field by field. File-level failures arrive as
 * all-absent layers (loadLayer maps them that way), so each field's
 * documented precedence applies independently.
 */
export function mergeTreeNavigatorConfig(
	globalLayer: ParsedLayer,
	projectLayer: ParsedLayer,
): ParsedLayer {
	return {
		hint: mergeHintField(globalLayer.hint, projectLayer.hint),
		startAnchor: mergeFallbackField(globalLayer.startAnchor, projectLayer.startAnchor),
		parentHandoffMode: mergeFallbackField(
			globalLayer.parentHandoffMode,
			projectLayer.parentHandoffMode,
		),
		// Per key, like the base hint field: a project entry wins.
		modelHints: new Map([...globalLayer.modelHints, ...projectLayer.modelHints]),
		modelOverridesProblems: noModelOverridesProblems(),
		...mergeProposalField(globalLayer, projectLayer),
		...mergeContinuityField(globalLayer, projectLayer),
		...mergeConsolidationField(globalLayer, projectLayer),
		...mergeAutoNavigateField(globalLayer, projectLayer),
	};
}

/** A fresh empty layer per use: `modelHints` is a mutable Map. */
export function absentLayer(): ParsedLayer {
	return {
		hint: { kind: "absent" },
		startAnchor: { kind: "absent" },
		parentHandoffMode: { kind: "absent" },
		modelHints: new Map(),
		modelOverridesProblems: noModelOverridesProblems(),
	};
}
