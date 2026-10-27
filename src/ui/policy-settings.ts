/**
 * Structured editor for continuity and milestone classifier policies.
 *
 * Returns a value for the settings screen to stage. It writes nothing and
 * never calls a provider. Preset and off are the strings and null the files
 * already store; custom edits must pass the production policy parser.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	parseClassifierModel,
	RECOMMENDED_INTENT_CLASSIFIER,
} from "../continuity/intent-policy.ts";
import { selectFrame } from "./frame.ts";
import {
	adjustable,
	cycleMode,
	editGate,
	editModel,
	editPrompt,
	frameRow,
	pickMode,
	rowsFor,
	setHeuristics,
} from "./policy-settings-fields.ts";
import {
	getPath,
	heuristicsOf,
	isRecord,
	parsePolicy,
	readCurrent,
	SINGLE_MODEL_WARNING,
	type State,
	singleModel,
	stagesOf,
	unwrap,
} from "./policy-settings-state.ts";

export type PolicyKind = "intent" | "milestone";

/** null disables, `"recommended"` selects the preset, an object is custom. */
export type PolicyValue = null | "recommended" | Record<string, unknown>;

function commit(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	state: State,
): PolicyValue | undefined {
	if (state.mode === "recommended") return "recommended";
	if (state.mode === "off") return null;
	if (Object.keys(state.draft).length === 0) return null;
	if (Object.keys(state.draft).length === 1 && state.draft["preset"] === "recommended") {
		return "recommended";
	}
	const parsed = parsePolicy(kind, state.draft);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.problems.join("; "), "warning");
		return undefined;
	}
	return { ...parsed.setting };
}

function overrideBits(kind: PolicyKind, object: Record<string, unknown>): string[] {
	const bits: string[] = [];
	if (typeof object["minConfidence"] === "number") {
		bits.push(`gate ${object["minConfidence"]}`);
	}
	if (kind === "intent" && object["heuristics"] === false) bits.push("heuristics off");
	const preset = object["preset"] === "recommended";
	for (const stage of stagesOf(kind)) {
		if (stage.modelPath) {
			const model = getPath(object, stage.modelPath);
			if (model === null) bits.push(`${stage.label} off`);
			else if (typeof model === "string") bits.push(`${stage.label} ${model}`);
		}
		if (
			stage.promptPath &&
			typeof getPath(object, stage.promptPath) === "string" &&
			(stage.modelPath === undefined || getPath(object, stage.modelPath) === undefined)
		) {
			bits.push(`${stage.label} prompt`);
		}
	}
	if (kind === "milestone") {
		const classifier = getPath(object, ["classifier", "model"]);
		const confirmer = getPath(object, ["confirmer", "model"]);
		const classifierOn = classifier === undefined ? preset : typeof classifier === "string";
		const confirmerOn = confirmer === undefined ? preset : typeof confirmer === "string";
		if (classifierOn && !confirmerOn && confirmer !== null) {
			bits.push("single model");
		}
	}
	return bits;
}

/** Concise value for a settings row. Never canonical JSON. */
export function summarizePolicy(kind: PolicyKind, value: unknown): string {
	const unwrapped = unwrap(kind, value);
	if (unwrapped.kind === "off") return "off";
	if (unwrapped.kind === "recommended") return "recommended";
	if (unwrapped.kind === "single") return unwrapped.model;
	if (unwrapped.kind === "invalid") return "invalid";
	const preset = unwrapped.object["preset"] === "recommended";
	const bits = overrideBits(kind, unwrapped.object);
	if (preset && bits.length === 0) return "recommended";
	return [preset ? "recommended" : "custom", ...bits].join(" · ");
}

/** Visible warning for milestone single-model mode, or undefined. */
export function policyWarning(kind: PolicyKind, value: unknown): string | undefined {
	if (kind !== "milestone") return undefined;
	const unwrapped = unwrap(kind, value);
	if (unwrapped.kind !== "object") return undefined;
	const state: State = { mode: "custom", draft: unwrapped.object };
	return singleModel(kind, state) ? SINGLE_MODEL_WARNING : undefined;
}

/** True only when the production parser accepts the complete value. */
export function policyAccepted(kind: PolicyKind, value: unknown): boolean {
	if (value === null || value === RECOMMENDED_INTENT_CLASSIFIER) return true;
	if (
		kind === "intent" &&
		typeof value === "string" &&
		parseClassifierModel(value.trim()) !== undefined
	) {
		return true;
	}
	if (!isRecord(value)) return false;
	return parsePolicy(kind, value).ok;
}

/**
 * Edit a classifier policy. Resolves with null, `"recommended"`, a validated
 * object, or undefined when cancelled. Does not write config or call a provider.
 */
export async function editPolicy(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	current: unknown,
): Promise<PolicyValue | undefined> {
	const state = readCurrent(kind, current);
	const rows = rowsFor(kind);
	const crumb = kind === "intent" ? "Intent" : "Milestone";
	let cursor = 0;
	while (true) {
		const choice = await selectFrame(ctx, {
			breadcrumbs: ["Anchor", "Settings", crumb],
			rows: rows.map((row) => frameRow(kind, row, state)),
			cursor,
			placeholder: "Filter policy fields…",
			enterAction: "edit",
			cancelAction: "cancel",
			...(singleModel(kind, state) ? { rightBadge: "⚠ single model" } : {}),
			shortcuts: [
				{
					key: "space",
					action: "toggle",
					enabled: (_row, index) => rows[index]?.kind === "heuristics",
				},
				{
					key: "left",
					action: "decrease",
					enabled: (_row, index) => adjustable(rows[index]),
				},
				{
					key: "right",
					action: "increase",
					enabled: (_row, index) => adjustable(rows[index]),
				},
				{ key: "a", action: "apply", priority: "essential" },
			],
		});
		if (!choice) return undefined;
		cursor = choice.index;
		const row = rows[cursor];
		if (!row) continue;
		if (choice.key === "a" || (row.kind === "apply" && choice.key === undefined)) {
			const result = commit(ctx, kind, state);
			if (result !== undefined) return result;
			continue;
		}
		if (choice.key === "left" || choice.key === "right") {
			const direction = choice.key === "right" ? 1 : -1;
			if (row.kind === "mode") cycleMode(state, direction);
			else if (row.kind === "heuristics") setHeuristics(ctx, state, direction === 1);
			continue;
		}
		if (row.kind === "mode") await pickMode(ctx, kind, state);
		else if (row.kind === "gate") await editGate(ctx, kind, state);
		else if (row.kind === "heuristics") setHeuristics(ctx, state, !heuristicsOf(state));
		else if (row.kind === "model") await editModel(ctx, kind, state, row.stage);
		else if (row.kind === "prompt") await editPrompt(ctx, state, row.stage);
	}
}
