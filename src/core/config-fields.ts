/** Config field outcomes and independent block parsers. */

import { parseAutoNavigatePartial } from "../auto/auto-navigate-config.ts";
import {
	parseClassifierModel,
	parseIntentPolicyObject,
	RECOMMENDED_INTENT_CLASSIFIER,
} from "../continuity/intent-policy.ts";
import type { HandoffMode } from "../fold/handoff.ts";
import { parseProposalOptions } from "../retrospective/proposal-options.ts";
import type { ConsolidationConfig, ParsedLayer } from "./config.ts";

/**
 * tree-navigator.json — two-layer config loader for the navigate-tree
 * extension.
 *
 * Pure parse/merge functions plus a thin loader with an injectable
 * `readFile`. No pi runtime imports: the caller computes `projectPath` from
 * `CONFIG_DIR_NAME` (so `.pi` stays rebrandable and `PI_CODING_AGENT_DIR`
 * stays honored), and the loader stays unit-testable without a session.
 *
 * Layers, in application order:
 *   - global:  join(agentDir, "tree-navigator.json")
 *   - project: join(cwd, CONFIG_DIR_NAME, "tree-navigator.json"), read only
 *     when the project is trusted (untrusted → ignored silently).
 *
 * Fields (each parsed and merged independently):
 *   - `rewindHintReserveTokens` (issues #44/#84): opt-in context-pressure
 *     hint, fired when the tokens left in the window drop to the reserve,
 *     or a disable sentinel. Replaces `rewindHintAtPercent` (removed in
 *     0.3.0): a present legacy key only warns and is otherwise ignored.
 *   - `anchorStartAfterTurns` (issue #55): turn bound for the automatic
 *     `anchor:start` write. Non-optional — an absent key still fires.
 *   - `parentHandoffMode`: child reports in parent context: `full` reports,
 *     `digest` index or `synthesized` parent only. Invalid values fall through like
 *     `anchorStartAfterTurns`, defaulting to `digest`.
 *   - `continuity` (`capture`, `intentClassifier`/`intent_classifier`): the
 *     session continuity ledger's capture of user intent. `capture` defaults to
 *     true; `intentClassifier` is `"recommended"` (the benchmarked preset of
 *     `intent-policy.ts`), an object policy that overrides the preset (strictly
 *     validated; the effective value is its canonical JSON text), a `provider/id`
 *     classifier model or a disable sentinel and defaults to off (heuristics
 *     only). Each key is parsed and
 *     merged on its own and, like `parentHandoffMode`, an invalid value warns
 *     and falls through to the other layer's valid value, else the default.
 *   - `modelOverrides` (issue #86): per-model `rewindHintReserveTokens`,
 *     keyed by exact `provider/modelId`, mirroring pi's
 *     `compaction.modelOverrides`. Layers merge per key (project entry over
 *     global entry), then a matching entry beats the base value — so a
 *     global model entry beats a project-wide base, as in pi. Entry values
 *     follow the base field's rules; an invalid entry disables the hint for
 *     that model. A non-object `modelOverrides` or entry warns and is
 *     ignored; an entry without `rewindHintReserveTokens` is ignored.
 *
 * Failure semantics (issues #44/#55; authoritative):
 *   - File-level problems (non-ENOENT read failure, invalid JSON, non-object
 *     root) make that layer contribute nothing — every field falls through
 *     to the OTHER layer, which still applies.
 *   - HINT field-level problems (`rewindHintReserveTokens` present but unusable)
 *     disable the hint for the session with NO cross-layer fallback: the
 *     user touched the field, so firing at the other layer's threshold would
 *     be an unintended rewind.
 *   - START-ANCHOR and parent-handoff field-level problems present but
 *     unusable warn and fall through to the other layer's valid value, else
 *     their defaults. An invalid parent handoff mode must not strand the
 *     session without a valid mode.
 *   - `modelOverrides` problems (#86) are scoped to the entry: an invalid
 *     entry value disables the hint for that model only (no fallback to the
 *     base, same reasoning as the base field); shape problems warn and drop
 *     the entry or the whole object, leaving the base value in force.
 *   - A missing file is the normal "not configured" state → silent. Warning
 *     on it would toast every session of every user without a config.
 *
 * Each invalid field emits its own warning, scoped to that field. These
 * helpers do not import pi or log: warnings are returned as strings so
 * `index.ts` can route them through `ctx.ui.notify` (gated on `hasUI`).
 */

/**
 * Per-field parse outcome for `rewindHintReserveTokens`.
 *
 *   - `absent`:   no key — contributes nothing (falls through).
 *   - `disabled`: explicit sentinel — wins the merge.
 *   - `ok`:       valid reserve — wins the merge.
 *   - `invalid`:  key present, value unusable — wins the merge (disables
 *                 the session; no cross-layer fallback).
 */
export type HintField =
	| { kind: "absent" }
	| { kind: "disabled" }
	| { kind: "ok"; value: number }
	| { kind: "invalid" };

/**
 * Per-field parse outcome for `anchorStartAfterTurns`.
 *
 *   - `absent`:   no key — contributes nothing (falls through to the other
 *                 layer, then the default).
 *   - `ok`:       valid turn bound — wins the merge.
 *   - `invalid`:  key present, value unusable — falls through to the other
 *                 layer's valid value, else the default (see merge/resolve).
 */
export type FallbackField<T> = { kind: "absent" } | { kind: "ok"; value: T } | { kind: "invalid" };

export type StartAnchorField = FallbackField<number>;

/** Per-field parse outcome for `parentHandoffMode`. */
export type ParentHandoffModeField = FallbackField<HandoffMode>;

export type ConsolidationLayer = {
	[K in keyof ConsolidationConfig]: FallbackField<ConsolidationConfig[K]>;
} & { notObject: boolean };

/** Per-field parse outcomes for the `continuity` block. */
export interface ContinuityLayer {
	capture: FallbackField<boolean>;
	/**
	 * `ok` with `null` is an explicit "off"; an object policy arrives as its
	 * canonical JSON text. An invalid object lists what is wrong with it.
	 */
	intentClassifier: FallbackField<string | null> | { kind: "invalid"; problems: readonly string[] };
	/** `continuity` is present but not an object; the loader warns and ignores it. */
	notObject: boolean;
}

/** `modelOverrides` shape problems; each one warns and is ignored. */
export interface ModelOverridesProblems {
	notObject: boolean;
	nonObjectEntries: string[];
}

export function noModelOverridesProblems(): ModelOverridesProblems {
	return { notObject: false, nonObjectEntries: [] };
}

/** Case-insensitive string sentinels that explicitly disable the hint. */
export const DISABLE_SENTINELS = new Set(["off", "disabled"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCaptureField(block: Record<string, unknown>): ContinuityLayer["capture"] {
	if (!("capture" in block)) return { kind: "absent" };
	return typeof block["capture"] === "boolean"
		? { kind: "ok", value: block["capture"] }
		: { kind: "invalid" };
}

function parseIntentClassifierField(
	block: Record<string, unknown>,
): ContinuityLayer["intentClassifier"] {
	const hasSnake = "intent_classifier" in block;
	if (!hasSnake && !("intentClassifier" in block)) return { kind: "absent" };
	const value = hasSnake ? block["intent_classifier"] : block["intentClassifier"];
	if (value === null || value === false) return { kind: "ok", value: null };
	if (isPlainObject(value)) {
		const checked = parseIntentPolicyObject(value);
		return checked.ok
			? { kind: "ok", value: checked.canonical }
			: { kind: "invalid", problems: checked.problems };
	}
	if (typeof value !== "string") return { kind: "invalid" };
	const trimmed = value.trim();
	if (DISABLE_SENTINELS.has(trimmed.toLowerCase())) {
		return { kind: "ok", value: null };
	}
	if (trimmed.toLowerCase() === RECOMMENDED_INTENT_CLASSIFIER) {
		return { kind: "ok", value: RECOMMENDED_INTENT_CLASSIFIER };
	}
	return parseClassifierModel(trimmed) && !trimmed.startsWith("{")
		? { kind: "ok", value: trimmed }
		: { kind: "invalid" };
}

export function parseConsolidationField(
	record: Record<string, unknown>,
): Pick<ParsedLayer, "consolidation"> {
	if (!("consolidation" in record)) return {};
	const block = record["consolidation"];
	const object = isPlainObject(block);
	const read = <T>(
		snake: string,
		camel: string,
		accepts: (value: unknown) => value is T,
	): FallbackField<T> => {
		if (!object || (!(snake in block) && !(camel in block))) return { kind: "absent" };
		const value = snake in block ? block[snake] : block[camel];
		return accepts(value) ? { kind: "ok", value } : { kind: "invalid" };
	};
	return {
		consolidation: {
			enabled: read("enabled", "enabled", (v): v is boolean => typeof v === "boolean"),
			maxHandoffs: read(
				"max_handoffs",
				"maxHandoffs",
				(v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100,
			),
			maxWindowShare: read(
				"max_window_share",
				"maxWindowShare",
				(v): v is number => typeof v === "number" && v > 0 && v <= 1,
			),
			keepNewest: read(
				"keep_newest",
				"keepNewest",
				(v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20,
			),
			notObject: !object,
		},
	};
}

export function parseContinuityField(
	record: Record<string, unknown>,
): Pick<ParsedLayer, "continuity"> {
	if (!("continuity" in record)) return {};
	const block = record["continuity"];
	if (!isPlainObject(block)) {
		return {
			continuity: {
				capture: { kind: "absent" },
				intentClassifier: { kind: "absent" },
				notObject: true,
			},
		};
	}
	return {
		continuity: {
			capture: parseCaptureField(block),
			intentClassifier: parseIntentClassifierField(block),
			notObject: false,
		},
	};
}

export function parseProposalField(record: Record<string, unknown>): Pick<ParsedLayer, "proposal"> {
	const hasSnake = "tree_proposal" in record;
	if (!hasSnake && !("treeProposal" in record)) return {};
	try {
		return {
			proposal: {
				kind: "ok",
				value: parseProposalOptions(hasSnake ? record["tree_proposal"] : record["treeProposal"]),
			},
		};
	} catch (error) {
		return {
			proposal: {
				kind: "invalid",
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export function parseAutoNavigateField(
	record: Record<string, unknown>,
): Pick<ParsedLayer, "autoNavigate"> {
	const hasSnake = "auto_navigate" in record;
	if (!hasSnake && !("autoNavigate" in record)) return {};
	try {
		return {
			autoNavigate: {
				kind: "ok",
				value: parseAutoNavigatePartial(
					hasSnake ? record["auto_navigate"] : record["autoNavigate"],
				),
			},
		};
	} catch (error) {
		return {
			autoNavigate: {
				kind: "invalid",
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
