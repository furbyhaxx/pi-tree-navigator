/** Policy field rows and interactive draft edits. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type FrameRow, selectFrame } from "./frame.ts";
import {
	confidenceProblem,
	defaultGate,
	deletePath,
	effectiveModel,
	explicitPrompt,
	gateOf,
	heuristicsOf,
	instructionsProblem,
	knownProblems,
	type Mode,
	promote,
	rootOf,
	SINGLE_MODEL_WARNING,
	type StageSpec,
	type State,
	setPath,
	singleModel,
	stagesOf,
} from "./policy-settings-state.ts";
import { pickSettingsModel } from "./settings-model-picker.ts";

type PolicyKind = Parameters<typeof stagesOf>[0];

type RowSpec =
	| { kind: "mode" }
	| { kind: "gate" }
	| { kind: "heuristics" }
	| { kind: "apply" }
	| { kind: "model"; stage: StageSpec }
	| { kind: "prompt"; stage: StageSpec };

function clip(text: string, max = 28): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function rowsFor(kind: PolicyKind): RowSpec[] {
	const rows: RowSpec[] = [{ kind: "mode" }, { kind: "gate" }];
	if (kind === "intent") rows.push({ kind: "heuristics" });
	for (const stage of stagesOf(kind)) {
		if (stage.modelPath) rows.push({ kind: "model", stage });
		if (stage.promptPath) rows.push({ kind: "prompt", stage });
	}
	rows.push({ kind: "apply" });
	return rows;
}

export function frameRow(kind: PolicyKind, row: RowSpec, state: State): FrameRow {
	if (row.kind === "mode") {
		return {
			label: "mode",
			value: state.mode,
			description:
				"recommended keeps the preset. off disables the policy. custom edits stages without turning the others off.",
		};
	}
	if (row.kind === "gate") {
		const explicit = state.mode === "custom" && typeof state.draft["minConfidence"] === "number";
		return {
			label: "gate",
			value: String(gateOf(kind, state)),
			tone: explicit ? "text" : "muted",
			description: `Minimum confidence, above 0 up to 1. Default ${defaultGate(kind)}. Empty clears an override.`,
		};
	}
	if (row.kind === "heuristics") {
		const on = heuristicsOf(state);
		return {
			label: "heuristics",
			value: on ? "on" : "off",
			tone: on ? "success" : "muted",
			description: "Heuristic classifier as a kind source and fallback. Left off, right on.",
		};
	}
	if (row.kind === "apply") {
		return {
			label: "apply",
			value: "use this policy",
			description: "Return this draft. Esc discards it. Nothing is written until you save a scope.",
		};
	}
	const stage = row.stage;
	if (row.kind === "model") {
		const model = effectiveModel(kind, state, stage);
		const warn = stage.id === "confirmer" && singleModel(kind, state);
		return {
			label: `${stage.label} model`,
			value: warn ? "off · single model" : (model ?? "off"),
			tone: warn ? "warning" : model ? "text" : "muted",
			description: warn ? SINGLE_MODEL_WARNING : stage.modelHelp,
		};
	}
	const prompt = explicitPrompt(state, stage);
	return {
		label: `${stage.label} prompt`,
		value: prompt ? clip(prompt) : "default",
		tone: prompt ? "text" : "muted",
		description: stage.promptHelp,
	};
}

export const adjustable = (row: RowSpec | undefined): boolean =>
	row?.kind === "mode" || row?.kind === "heuristics";

export function cycleMode(state: State, direction: -1 | 1): void {
	const order: readonly Mode[] = ["recommended", "off", "custom"];
	const index = order.indexOf(state.mode);
	state.mode = order[(index + direction + order.length) % order.length] ?? state.mode;
}

function draftForProbe(state: State): Record<string, unknown> {
	if (state.mode === "custom") return structuredClone(state.draft);
	return state.mode === "recommended" ? { preset: "recommended" } : {};
}

function refuseHeuristics(ctx: ExtensionCommandContext, state: State, next: boolean): boolean {
	if (next) return false;
	const probe = draftForProbe(state);
	probe["heuristics"] = false;
	const problem = knownProblems("intent", probe).find((item) => item.includes("no source"));
	if (!problem) return false;
	ctx.ui.notify(problem, "warning");
	return true;
}

export function setHeuristics(ctx: ExtensionCommandContext, state: State, next: boolean): void {
	if (heuristicsOf(state) === next) return;
	if (refuseHeuristics(ctx, state, next)) return;
	promote(state);
	state.draft["heuristics"] = next;
}

export async function pickMode(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	state: State,
): Promise<void> {
	const order: readonly Mode[] = ["recommended", "off", "custom"];
	const choice = await selectFrame(ctx, {
		breadcrumbs: ["Anchor", "Settings", kind === "intent" ? "Intent" : "Milestone", "Mode"],
		cursor: Math.max(0, order.indexOf(state.mode)),
		cancelAction: "back",
		rows: [
			{
				label: "recommended",
				description: "Benchmarked preset. Unspecified stages keep these models.",
			},
			{ label: "off", description: "Disable this policy." },
			{
				label: "custom",
				description: "Edit the gate, models, and prompts without disabling unspecified stages.",
			},
		],
	});
	if (!choice) return;
	state.mode = order[choice.index] ?? state.mode;
}

export async function editGate(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	state: State,
): Promise<void> {
	const text = await ctx.ui.input(
		"Minimum confidence",
		`now ${gateOf(kind, state)} · above 0 up to 1 · empty clears`,
	);
	if (text === undefined) return;
	const trimmed = text.trim();
	if (!trimmed) {
		if (state.mode === "custom") delete state.draft["minConfidence"];
		return;
	}
	const value = Number(trimmed);
	const problem = Number.isFinite(value)
		? confidenceProblem(kind, value)
		: confidenceProblem(kind, Number.NaN);
	if (problem || !Number.isFinite(value)) {
		ctx.ui.notify(
			problem ?? `${rootOf(kind)}.minConfidence must be a number above 0 up to 1`,
			"warning",
		);
		return;
	}
	promote(state);
	state.draft["minConfidence"] = value;
}

export async function editModel(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	state: State,
	stage: StageSpec,
): Promise<void> {
	if (!stage.modelPath) return;
	const picked = await pickSettingsModel(ctx, {
		kind: "stage",
		current: effectiveModel(kind, state, stage),
	});
	if (picked === undefined) return;
	if (kind === "intent" && stage.id === "kind" && picked === null) {
		const probe = draftForProbe(state);
		setPath(probe, stage.modelPath, null);
		const problem = knownProblems("intent", probe).find((item) => item.includes("no source"));
		if (problem) {
			ctx.ui.notify(problem, "warning");
			return;
		}
	}
	promote(state);
	setPath(state.draft, stage.modelPath, picked);
}

export async function editPrompt(
	ctx: ExtensionCommandContext,
	state: State,
	stage: StageSpec,
): Promise<void> {
	if (!stage.promptPath) return;
	const where = stage.promptPath.join(".");
	const current = explicitPrompt(state, stage) ?? "";
	const raw = await ctx.ui.editor(`${stage.label} prompt`, current);
	if (raw === undefined) return;
	if (!raw.trim()) {
		if (state.mode === "custom") deletePath(state.draft, stage.promptPath);
		return;
	}
	const problem = instructionsProblem(raw, where);
	if (problem) {
		ctx.ui.notify(problem, "warning");
		return;
	}
	promote(state);
	setPath(state.draft, stage.promptPath, raw.trim());
}
