/** Layered config catalog, parsing entry point, loading and effective model resolution. */

import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AutoNavigateConfig,
	type AutoNavigatePartial,
	matchesModelPattern,
	materializeAutoNavigateConfig,
	mergeAutoNavigatePartial,
	modelPatternSpecificity,
	parseAutoNavigatePartial,
} from "../auto/auto-navigate-config.ts";
import type { HandoffMode } from "../fold/handoff.ts";
import type { ProposalOptions } from "../retrospective/proposal-options.ts";
import {
	type ConsolidationLayer,
	type ContinuityLayer,
	DISABLE_SENTINELS,
	type HintField,
	isPlainObject,
	type ModelOverridesProblems,
	noModelOverridesProblems,
	type ParentHandoffModeField,
	parseAutoNavigateField,
	parseConsolidationField,
	parseContinuityField,
	parseProposalField,
	type StartAnchorField,
} from "./config-fields.ts";
import { configFieldWarnings, type LayerLoadResult, loadLayer } from "./config-layers.ts";
import { absentLayer, mergeTreeNavigatorConfig } from "./config-merge.ts";

export const TREE_NAVIGATOR_CONFIG_FILENAME = "tree-navigator.json";
export const REWIND_HINT_MIN_RESERVE = 1_000;
export const REWIND_HINT_MAX_RESERVE = 1_000_000;
export const START_ANCHOR_MIN_TURNS = 1;
export const START_ANCHOR_MAX_TURNS = 50;
export const PARENT_HANDOFF_MODE_DEFAULT: HandoffMode = "digest";
export const CONTINUITY_CAPTURE_DEFAULT = true;
/**
 * Effective turn bound when `anchorStartAfterTurns` is absent everywhere
 * (or invalid in every layer that touched it). Unlike the hint, the start
 * anchor is non-optional: a missing config file still fires at this default.
 */
export const START_ANCHOR_DEFAULT_TURNS = 2;

/** Controls background consolidation of older fold handoffs. */
export interface ConsolidationConfig {
	enabled: boolean;
	maxHandoffs: number;
	maxWindowShare: number;
	keepNewest: number;
}

/** Default consolidation thresholds and number of handoffs retained verbatim. */
export const CONSOLIDATION_DEFAULTS: ConsolidationConfig = {
	enabled: true,
	maxHandoffs: 4,
	maxWindowShare: 0.1,
	keepNewest: 2,
};

/** One config layer's parsed fields (file-level failures are all-absent). */
export interface ParsedLayer {
	hint: HintField;
	startAnchor: StartAnchorField;
	parentHandoffMode: ParentHandoffModeField;
	/** Invalid disclosure settings block model proposals rather than falling back. */
	proposal?: { kind: "ok"; value: ProposalOptions } | { kind: "invalid"; error: string };
	continuity?: ContinuityLayer;
	consolidation?: ConsolidationLayer;
	/** Sidecar auto-navigation policy (`auto_navigate`). */
	autoNavigate?: { kind: "ok"; value: AutoNavigatePartial } | { kind: "invalid"; error: string };
	/**
	 * Per-model hint fields (#86), keyed by exact `provider/modelId` or wildcard.
	 * Only entries that set `rewindHintReserveTokens` (or `rewind_hint_reserve_tokens`)
	 * are present.
	 */
	modelHints: Map<string, HintField>;
	/** Per-model `auto_navigate` overrides keyed by exact `provider/modelId` or wildcard. */
	modelAutoNavigate?: Map<
		string,
		{ kind: "ok"; value: AutoNavigatePartial } | { kind: "invalid"; error: string }
	>;
	/** Shape problems for the loader to warn about (each is ignored). */
	modelOverridesProblems: ModelOverridesProblems;
}

/**
 * Root parse result. A non-object root (null, array, primitive) is a
 * file-level failure so the other layer can still apply every field.
 */
export type ParsedRoot = { kind: "unusable" } | { kind: "fields"; layer: ParsedLayer };

function parseHintReserve(n: number): HintField {
	return Number.isInteger(n) && n >= REWIND_HINT_MIN_RESERVE && n <= REWIND_HINT_MAX_RESERVE
		? { kind: "ok", value: n }
		: { kind: "invalid" };
}

function parseStartTurns(n: number): StartAnchorField {
	return Number.isInteger(n) && n >= START_ANCHOR_MIN_TURNS && n <= START_ANCHOR_MAX_TURNS
		? { kind: "ok", value: n }
		: { kind: "invalid" };
}

function parseModelOverrides(
	record: Record<string, unknown>,
): Pick<ParsedLayer, "modelHints" | "modelAutoNavigate" | "modelOverridesProblems"> {
	const modelHints = new Map<string, HintField>();
	const modelAutoNavigate = new Map<
		string,
		{ kind: "ok"; value: AutoNavigatePartial } | { kind: "invalid"; error: string }
	>();
	const problems = noModelOverridesProblems();
	const hasCamel = "modelOverrides" in record;
	const hasSnake = "model_overrides" in record;
	if (!hasCamel && !hasSnake) {
		return { modelHints, modelOverridesProblems: problems };
	}
	const overrides = hasSnake ? record.model_overrides : record.modelOverrides;
	if (!isPlainObject(overrides)) {
		problems.notObject = true;
		return { modelHints, modelOverridesProblems: problems };
	}
	for (const [key, entry] of Object.entries(overrides)) {
		if (!isPlainObject(entry)) {
			problems.nonObjectEntries.push(key);
			continue;
		}
		const hint = parseHintField(entry);
		if (hint.kind !== "absent") modelHints.set(key, hint);
		if ("auto_navigate" in entry || "autoNavigate" in entry) {
			const rawAuto = "auto_navigate" in entry ? entry.auto_navigate : entry.autoNavigate;
			try {
				modelAutoNavigate.set(key, {
					kind: "ok",
					value: parseAutoNavigatePartial(
						rawAuto,
						`modelOverrides[${JSON.stringify(key)}].auto_navigate`,
					),
				});
			} catch (error) {
				modelAutoNavigate.set(key, {
					kind: "invalid",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return {
		modelHints,
		...(modelAutoNavigate.size > 0 ? { modelAutoNavigate } : {}),
		modelOverridesProblems: problems,
	};
}

function parseHintField(record: Record<string, unknown>): HintField {
	const hasSnake = "rewind_hint_reserve_tokens" in record;
	if (!hasSnake && !("rewindHintReserveTokens" in record)) {
		return { kind: "absent" };
	}
	const value = hasSnake ? record.rewind_hint_reserve_tokens : record.rewindHintReserveTokens;
	if (value === null || value === false) return { kind: "disabled" };
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (DISABLE_SENTINELS.has(trimmed.toLowerCase())) {
			return { kind: "disabled" };
		}
		// Digits only: decimals, signs, exponents, and empty strings reject.
		return /^\d+$/.test(trimmed) ? parseHintReserve(Number(trimmed)) : { kind: "invalid" };
	}
	if (typeof value === "number") return parseHintReserve(value);
	return { kind: "invalid" };
}

function parseStartAnchorField(record: Record<string, unknown>): StartAnchorField {
	const hasSnake = "anchor_start_after_turns" in record;
	if (!hasSnake && !("anchorStartAfterTurns" in record)) {
		return { kind: "absent" };
	}
	const value = hasSnake ? record.anchor_start_after_turns : record.anchorStartAfterTurns;
	if (typeof value === "string") {
		const trimmed = value.trim();
		// Digits only, mirroring the hint's string tolerance. There are no
		// disable sentinels for this field (non-optional), so null/false fall
		// through to `invalid` below.
		return /^\d+$/.test(trimmed) ? parseStartTurns(Number(trimmed)) : { kind: "invalid" };
	}
	if (typeof value === "number") return parseStartTurns(value);
	return { kind: "invalid" };
}

function parseParentHandoffModeField(record: Record<string, unknown>): ParentHandoffModeField {
	const hasSnake = "parent_handoff_mode" in record;
	if (!hasSnake && !("parentHandoffMode" in record)) return { kind: "absent" };
	const value = hasSnake ? record.parent_handoff_mode : record.parentHandoffMode;
	return value === "full" || value === "synthesized" || value === "digest"
		? { kind: "ok", value }
		: { kind: "invalid" };
}

/**
 * Parse one already-JSON.parsed config root. A non-object root (null, array,
 * primitive) is `unusable` — a file-level failure so the other layer can
 * still apply. Fields are parsed independently: an invalid hint does not
 * affect the start anchor, and vice versa.
 */
export function parseTreeNavigatorConfig(raw: unknown): ParsedRoot {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "unusable" };
	}
	const record = raw as Record<string, unknown>;
	return {
		kind: "fields",
		layer: {
			hint: parseHintField(record),
			startAnchor: parseStartAnchorField(record),
			parentHandoffMode: parseParentHandoffModeField(record),
			...parseModelOverrides(record),
			...parseProposalField(record),
			...parseContinuityField(record),
			...parseConsolidationField(record),
			...parseAutoNavigateField(record),
		},
	};
}

/** Effective hint reserve: a number, or `null` (off). */
function hintReserve(field: HintField): number | null {
	return field.kind === "ok" ? field.value : null;
}

function bestPatternEntry<T>(
	byModel: ReadonlyMap<string, T>,
	modelKey: string,
): [string, T] | undefined {
	if (byModel.has(modelKey)) {
		return [modelKey, byModel.get(modelKey) as T];
	}
	let bestKey: string | undefined;
	let bestVal: T | undefined;
	let bestScore = -1;
	for (const [pattern, val] of byModel) {
		if (!matchesModelPattern(pattern, modelKey)) continue;
		const score = modelPatternSpecificity(pattern, modelKey);
		if (score >= bestScore) {
			bestScore = score;
			bestKey = pattern;
			bestVal = val;
		}
	}
	return bestKey !== undefined ? [bestKey, bestVal as T] : undefined;
}

/**
 * The reserve for `modelKey` (`provider/modelId`, #86): a matching
 * `modelOverrides` entry (exact or wildcard) wins (including `null` from a
 * sentinel or an invalid entry), else the base `rewindHintReserveTokens`.
 */
export function resolveRewindHintReserve(
	config: {
		rewindHintReserveTokens: number | null;
		rewindHintModelReserveTokens: ReadonlyMap<string, number | null>;
	},
	modelKey: string | undefined,
): number | null {
	if (modelKey !== undefined) {
		const matched = bestPatternEntry(config.rewindHintModelReserveTokens, modelKey);
		if (matched) return matched[1];
	}
	return config.rewindHintReserveTokens;
}

/**
 * Resolve the effective `AutoNavigateConfig` for `modelKey` (`provider/modelId`),
 * applying base `auto_navigate` and any matching wildcard or exact
 * `model_overrides` entry (ordered from least specific to most specific so
 * fields inherit cleanly while specific patterns win).
 */
export function resolveAutoNavigateConfig(
	config: {
		autoNavigate?: AutoNavigatePartial;
		autoNavigateByModel?: ReadonlyMap<string, AutoNavigatePartial | null>;
		proposal?: ProposalOptions;
	},
	modelKey: string | undefined,
): AutoNavigateConfig {
	let effective = config.autoNavigate;
	if (modelKey !== undefined && config.autoNavigateByModel) {
		const matches: Array<{
			pattern: string;
			partial: AutoNavigatePartial | null;
			score: number;
		}> = [];
		for (const [pattern, partial] of config.autoNavigateByModel) {
			if (!matchesModelPattern(pattern, modelKey)) continue;
			matches.push({
				pattern,
				partial,
				score: modelPatternSpecificity(pattern, modelKey),
			});
		}
		matches.sort((a, b) => a.score - b.score);
		for (const match of matches) {
			if (match.partial === null) {
				return materializeAutoNavigateConfig({ ...effective, enabled: false }, config.proposal);
			}
			effective = mergeAutoNavigatePartial(effective, match.partial);
		}
	}
	return materializeAutoNavigateConfig(effective, config.proposal);
}

/** Parse one layer's root and describe every field-level problem; `where` names the layer in warnings. */
function parseLayerRoot(where: string, root: unknown): LayerLoadResult {
	const parsed = parseTreeNavigatorConfig(root);
	if (parsed.kind === "unusable") {
		return {
			layer: absentLayer(),
			warnings: [`navigate_tree: ${where} must be a JSON object — that layer was ignored.`],
		};
	}
	return {
		layer: parsed.layer,
		warnings: configFieldWarnings(where, root, parsed, {
			REWIND_HINT_MIN_RESERVE,
			REWIND_HINT_MAX_RESERVE,
			START_ANCHOR_MIN_TURNS,
			START_ANCHOR_MAX_TURNS,
			START_ANCHOR_DEFAULT_TURNS,
			PARENT_HANDOFF_MODE_DEFAULT,
			CONTINUITY_CAPTURE_DEFAULT,
			CONSOLIDATION_DEFAULTS,
		}),
	};
}

/**
 * Load and merge both config layers.
 *
 * `projectPath` is passed in rather than derived from `cwd` so this module
 * needs no `CONFIG_DIR_NAME` import (the no-pi-imports constraint; the
 * caller computes `join(cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME)`).
 * Warnings are ordered global-then-project-then-runtime; each invalid field
 * contributes its own scoped warning.
 *
 * `runtime` is an in-memory session layer (same shape as a config file) that
 * is parsed with the same parsers and merged after the effective
 * global/project result, so it wins per key without dropping lower keys. It
 * applies regardless of project trust; invalid fields fail closed exactly as
 * in a file layer.
 */
export async function loadTreeNavigatorConfig(opts: {
	agentDir: string;
	projectPath: string;
	projectTrusted: boolean;
	runtime?: Record<string, unknown>;
	readFile?: (path: string) => Promise<string>;
}): Promise<{
	config: {
		rewindHintReserveTokens: number | null;
		rewindHintModelReserveTokens: Map<string, number | null>;
		anchorStartAfterTurns: number;
		parentHandoffMode: HandoffMode;
		consolidation: ConsolidationConfig;
		continuity: {
			capture: boolean;
			/** `"recommended"`, an object policy's canonical JSON text, `provider/id` of a classifier model, or null for heuristics only. */
			intentClassifier: string | null;
		};
		proposal?: ProposalOptions;
		proposalError?: string;
		autoNavigate?: AutoNavigatePartial;
		autoNavigateByModel?: Map<string, AutoNavigatePartial | null>;
	};
	warnings: string[];
}> {
	const readFile = opts.readFile ?? ((path: string) => fsReadFile(path, "utf8"));

	const warnings: string[] = [];
	const globalResult = await loadLayer(
		"global",
		join(opts.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME),
		readFile,
		parseLayerRoot,
	);
	warnings.push(...globalResult.warnings);

	let projectLayer: ParsedLayer = absentLayer();
	if (opts.projectTrusted) {
		const projectResult = await loadLayer("project", opts.projectPath, readFile, parseLayerRoot);
		warnings.push(...projectResult.warnings);
		projectLayer = projectResult.layer;
	}

	let effective = mergeTreeNavigatorConfig(globalResult.layer, projectLayer);
	if (opts.runtime !== undefined) {
		const runtimeResult = parseLayerRoot("runtime config", opts.runtime);
		warnings.push(...runtimeResult.warnings);
		effective = mergeTreeNavigatorConfig(effective, runtimeResult.layer);
	}
	return {
		config: {
			rewindHintReserveTokens: hintReserve(effective.hint),
			rewindHintModelReserveTokens: new Map(
				[...effective.modelHints].map(([key, field]) => [key, hintReserve(field)]),
			),
			anchorStartAfterTurns:
				effective.startAnchor.kind === "ok"
					? effective.startAnchor.value
					: START_ANCHOR_DEFAULT_TURNS,
			parentHandoffMode:
				effective.parentHandoffMode.kind === "ok"
					? effective.parentHandoffMode.value
					: PARENT_HANDOFF_MODE_DEFAULT,
			consolidation: {
				enabled:
					effective.consolidation?.enabled.kind === "ok"
						? effective.consolidation.enabled.value
						: CONSOLIDATION_DEFAULTS.enabled,
				maxHandoffs:
					effective.consolidation?.maxHandoffs.kind === "ok"
						? effective.consolidation.maxHandoffs.value
						: CONSOLIDATION_DEFAULTS.maxHandoffs,
				maxWindowShare:
					effective.consolidation?.maxWindowShare.kind === "ok"
						? effective.consolidation.maxWindowShare.value
						: CONSOLIDATION_DEFAULTS.maxWindowShare,
				keepNewest:
					effective.consolidation?.keepNewest.kind === "ok"
						? effective.consolidation.keepNewest.value
						: CONSOLIDATION_DEFAULTS.keepNewest,
			},
			continuity: {
				capture:
					effective.continuity?.capture.kind === "ok"
						? effective.continuity.capture.value
						: CONTINUITY_CAPTURE_DEFAULT,
				intentClassifier:
					effective.continuity?.intentClassifier.kind === "ok"
						? effective.continuity.intentClassifier.value
						: null,
			},
			...(effective.proposal?.kind === "ok" ? { proposal: effective.proposal.value } : {}),
			...(effective.proposal?.kind === "invalid"
				? { proposalError: effective.proposal.error }
				: {}),
			...(effective.autoNavigate?.kind === "ok"
				? { autoNavigate: effective.autoNavigate.value }
				: effective.autoNavigate?.kind === "invalid"
					? { autoNavigate: { enabled: false } }
					: {}),
			...(effective.modelAutoNavigate && effective.modelAutoNavigate.size > 0
				? {
						autoNavigateByModel: new Map(
							[...effective.modelAutoNavigate].map(([key, field]) => [
								key,
								field.kind === "ok" ? field.value : null,
							]),
						),
					}
				: {}),
		},
		warnings,
	};
}
