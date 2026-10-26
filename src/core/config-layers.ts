/** Config layer file failures and field-scoped diagnostics. */

import type { HandoffMode } from "../fold/handoff.ts";
import type { ConsolidationConfig, ParsedLayer } from "./config.ts";
import { absentLayer } from "./config-merge.ts";

export interface ConfigWarningDefaults {
	REWIND_HINT_MIN_RESERVE: number;
	REWIND_HINT_MAX_RESERVE: number;
	START_ANCHOR_MIN_TURNS: number;
	START_ANCHOR_MAX_TURNS: number;
	START_ANCHOR_DEFAULT_TURNS: number;
	PARENT_HANDOFF_MODE_DEFAULT: HandoffMode;
	CONTINUITY_CAPTURE_DEFAULT: boolean;
	CONSOLIDATION_DEFAULTS: ConsolidationConfig;
}

export function configFieldWarnings(
	where: string,
	root: unknown,
	parsed: { layer: ParsedLayer },
	{
		REWIND_HINT_MIN_RESERVE,
		REWIND_HINT_MAX_RESERVE,
		START_ANCHOR_MIN_TURNS,
		START_ANCHOR_MAX_TURNS,
		START_ANCHOR_DEFAULT_TURNS,
		PARENT_HANDOFF_MODE_DEFAULT,
		CONTINUITY_CAPTURE_DEFAULT,
		CONSOLIDATION_DEFAULTS,
	}: ConfigWarningDefaults,
): string[] {
	const warnings: string[] = [];
	if ("rewindHintAtPercent" in (root as Record<string, unknown>)) {
		warnings.push(
			`navigate_tree: rewindHintAtPercent in ${where} was removed in 0.3.0 and is ignored — use rewindHintReserveTokens (tokens left in the window when the hint fires, e.g. 50000).`,
		);
	}
	const hintExpectation = `expected integer ${REWIND_HINT_MIN_RESERVE}-${REWIND_HINT_MAX_RESERVE} or a disable sentinel (null, false, "off", "disabled")`;
	if (parsed.layer.hint.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid rewindHintReserveTokens in ${where} — ${hintExpectation}; rewind hint disabled for this session.`,
		);
	}
	if (parsed.layer.modelOverridesProblems.notObject) {
		warnings.push(
			`navigate_tree: modelOverrides in ${where} must be an object keyed by "provider/modelId" — ignored.`,
		);
	}
	for (const key of parsed.layer.modelOverridesProblems.nonObjectEntries) {
		warnings.push(
			`navigate_tree: modelOverrides[${JSON.stringify(key)}] in ${where} must be an object — ignored.`,
		);
	}
	for (const [key, field] of parsed.layer.modelHints) {
		if (field.kind !== "invalid") continue;
		warnings.push(
			`navigate_tree: invalid modelOverrides[${JSON.stringify(key)}].rewindHintReserveTokens in ${where} — ${hintExpectation}; rewind hint disabled for that model.`,
		);
	}
	if (parsed.layer.startAnchor.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid anchorStartAfterTurns in ${where} — expected integer ${START_ANCHOR_MIN_TURNS}-${START_ANCHOR_MAX_TURNS}; falling back to the other layer's valid value, else the default ${START_ANCHOR_DEFAULT_TURNS}.`,
		);
	}
	if (parsed.layer.parentHandoffMode.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid parentHandoffMode in ${where} — expected "full", "synthesized" or "digest"; falling back to the other layer's valid value, else the default "${PARENT_HANDOFF_MODE_DEFAULT}".`,
		);
	}
	const consolidation = parsed.layer.consolidation;
	if (consolidation?.notObject)
		warnings.push(`navigate_tree: consolidation in ${where} must be an object — ignored.`);
	if (consolidation?.enabled.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid consolidation.enabled in ${where} — expected true or false; falling back to the other layer's valid value, else the default ${CONSOLIDATION_DEFAULTS.enabled}.`,
		);
	}
	if (consolidation?.maxHandoffs.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid consolidation.max_handoffs in ${where} — expected integer 1-100; falling back to the other layer's valid value, else the default ${CONSOLIDATION_DEFAULTS.maxHandoffs}.`,
		);
	}
	if (consolidation?.maxWindowShare.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid consolidation.max_window_share in ${where} — expected number greater than 0 and at most 1; falling back to the other layer's valid value, else the default ${CONSOLIDATION_DEFAULTS.maxWindowShare}.`,
		);
	}
	if (consolidation?.keepNewest.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid consolidation.keep_newest in ${where} — expected integer 1-20; falling back to the other layer's valid value, else the default ${CONSOLIDATION_DEFAULTS.keepNewest}.`,
		);
	}
	const continuity = parsed.layer.continuity;
	if (continuity?.notObject) {
		warnings.push(`navigate_tree: continuity in ${where} must be an object — ignored.`);
	}
	if (continuity?.capture.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid continuity.capture in ${where} — expected true or false; falling back to the other layer's valid value, else the default ${CONTINUITY_CAPTURE_DEFAULT}.`,
		);
	}
	const classifier = continuity?.intentClassifier;
	if (classifier?.kind === "invalid") {
		const expected =
			"problems" in classifier
				? classifier.problems.join("; ")
				: 'expected "recommended", "provider/id" of a classifier model, an object policy or a disable sentinel (null, false, "off", "disabled")';
		warnings.push(
			`navigate_tree: invalid continuity.intentClassifier in ${where} — ${expected}; falling back to the other layer's valid value, else off (heuristics only).`,
		);
	}
	if (parsed.layer.proposal?.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid treeProposal in ${where} — ${parsed.layer.proposal.error}; model proposals are blocked until this is corrected.`,
		);
	}
	const autoRoot =
		(root as Record<string, unknown>)["auto_navigate"] ??
		(root as Record<string, unknown>)["autoNavigate"];
	if (
		typeof autoRoot === "object" &&
		autoRoot !== null &&
		"controller_model" in (autoRoot as Record<string, unknown>)
	)
		warnings.push(
			`navigate_tree: auto_navigate.controller_model in ${where} was removed and is ignored — set auto_navigate.milestone to "recommended" or explicit classifier/confirmer stages.`,
		);
	if (parsed.layer.autoNavigate?.kind === "invalid") {
		warnings.push(
			`navigate_tree: invalid auto_navigate in ${where} — ${parsed.layer.autoNavigate.error}; auto_navigate is disabled for this session.`,
		);
	}
	for (const [key, field] of parsed.layer.modelAutoNavigate ?? []) {
		if (field.kind !== "invalid") continue;
		warnings.push(
			`navigate_tree: invalid modelOverrides[${JSON.stringify(key)}].auto_navigate in ${where} — ${field.error}; auto_navigate is disabled for that model pattern.`,
		);
	}
	return warnings;
}

type LayerName = "global" | "project";

export interface LayerLoadResult {
	layer: ParsedLayer;
	warnings: string[];
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export async function loadLayer(
	layer: LayerName,
	path: string,
	readFile: (path: string) => Promise<string>,
	parseLayerRoot: (where: string, root: unknown) => LayerLoadResult,
): Promise<LayerLoadResult> {
	const fileWarning = (message: string): LayerLoadResult => ({
		layer: absentLayer(),
		warnings: [message],
	});
	let text: string;
	try {
		text = await readFile(path);
	} catch (err) {
		if (isEnoent(err)) return { layer: absentLayer(), warnings: [] };
		return fileWarning(
			`navigate_tree: could not read ${layer} config at ${path} — that layer was ignored.`,
		);
	}
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return fileWarning(
			`navigate_tree: invalid JSON in ${layer} config at ${path} — that layer was ignored.`,
		);
	}
	return parseLayerRoot(`${layer} config at ${path}`, root);
}
