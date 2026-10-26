/**
 * Structured editor for continuity and milestone classifier policies.
 *
 * Returns a value for the settings screen to stage. It writes nothing and
 * never calls a provider. Preset and off are the strings and null the files
 * already store; custom edits must pass the production policy parser.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type FrameRow, selectFrame } from "./frame.ts";
import {
	parseClassifierModel,
	parseIntentPolicyObject,
	RECOMMENDED_INTENT_CLASSIFIER,
	RECOMMENDED_POLICY,
	RECOMMENDED_POLICY_PROVENANCE,
} from "./intent-policy.ts";
import {
	parseMilestonePolicyObject,
	RECOMMENDED_MILESTONE_POLICY,
	RECOMMENDED_MILESTONE_PROVENANCE,
} from "./milestone-policy.ts";
import { pickSettingsModel } from "./settings-model-picker.ts";

export type PolicyKind = "intent" | "milestone";

/** null disables, `"recommended"` selects the preset, an object is custom. */
export type PolicyValue = null | "recommended" | Record<string, unknown>;

const MAX_INSTRUCTIONS = 1_000;
const INTENT_CLASSIFIER = RECOMMENDED_POLICY.classifier;
const INTENT_ESCALATION = RECOMMENDED_POLICY.escalation;
const MILESTONE_CLASSIFIER = RECOMMENDED_MILESTONE_POLICY.classifier;
const MILESTONE_CONFIRMER = RECOMMENDED_MILESTONE_POLICY.confirmer;
const SINGLE_MODEL_WARNING =
	"Single-model mode: no confirmer. One model alone accepted unsafe answers on holdout.";

type Mode = "recommended" | "off" | "custom";

interface StageSpec {
	id: string;
	label: string;
	modelPath?: readonly string[];
	promptPath?: readonly string[];
	modelHelp: string;
	promptHelp: string;
}

const INTENT_STAGES: readonly StageSpec[] = [
	{
		id: "kind",
		label: "kind",
		modelPath: ["kind", "model"],
		promptPath: ["kind", "instructions"],
		modelHelp: "Model for the intent kind. off uses heuristics when they are on.",
		promptHelp: "Replaces the kind question. Empty clears the override.",
	},
	{
		id: "supersession",
		label: "supersession",
		modelPath: ["supersession", "model"],
		promptPath: ["supersession", "instructions"],
		modelHelp: "Model that names which active item a message replaces.",
		promptHelp: "Replaces the supersession question. Empty clears the override.",
	},
	{
		id: "escalation",
		label: "escalation",
		modelPath: ["supersession", "escalation", "model"],
		promptPath: ["supersession", "escalation", "instructions"],
		modelHelp: "Asked only when supersession abstains. off skips the escalation.",
		promptHelp: "Replaces the escalation question. Empty clears the override.",
	},
	{
		id: "verification",
		label: "verification",
		modelPath: ["supersession", "verification", "model"],
		promptPath: ["supersession", "verification", "instructions"],
		modelHelp:
			"Confirms a retirement the escalation stage named. The preset uses the recommended verifier. off skips the check.",
		promptHelp: "Replaces the verification question. Empty clears the override.",
	},
];

const MILESTONE_STAGES: readonly StageSpec[] = [
	{
		id: "classifier",
		label: "classifier",
		modelPath: ["classifier", "model"],
		promptPath: undefined,
		modelHelp: "First model. off disables the milestone policy.",
		promptHelp: "",
	},
	{
		id: "confirmer",
		label: "confirmer",
		modelPath: ["confirmer", "model"],
		promptPath: undefined,
		modelHelp:
			"Must repeat the classifier's choice. off is single-model mode and is not safe on holdout.",
		promptHelp: "",
	},
	{
		id: "status",
		label: "status",
		promptPath: ["status", "instructions"],
		modelHelp: "",
		promptHelp: "Replaces the status question. Empty clears the override.",
	},
	{
		id: "boundary",
		label: "boundary",
		promptPath: ["boundary", "instructions"],
		modelHelp: "",
		promptHelp: "Replaces the boundary question. Empty clears the override.",
	},
];

type RowSpec =
	| { kind: "mode" }
	| { kind: "gate" }
	| { kind: "heuristics" }
	| { kind: "apply" }
	| { kind: "model"; stage: StageSpec }
	| { kind: "prompt"; stage: StageSpec };

interface State {
	mode: Mode;
	draft: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stagesOf = (kind: PolicyKind): readonly StageSpec[] =>
	kind === "intent" ? INTENT_STAGES : MILESTONE_STAGES;

const rootOf = (kind: PolicyKind): string =>
	kind === "intent" ? "continuity.intentClassifier" : "autoNavigate.milestone";

function parsePolicy(kind: PolicyKind, value: unknown) {
	return kind === "intent" ? parseIntentPolicyObject(value) : parseMilestonePolicyObject(value);
}

function getPath(root: Record<string, unknown>, path: readonly string[]): unknown {
	let node: unknown = root;
	for (const key of path) {
		if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let node = root;
	for (const key of path.slice(0, -1)) {
		const child = node[key];
		if (!isRecord(child)) {
			const next: Record<string, unknown> = {};
			node[key] = next;
			node = next;
		} else {
			node = child;
		}
	}
	const leaf = path[path.length - 1];
	if (leaf === undefined) return;
	if (value === undefined) delete node[leaf];
	else node[leaf] = value;
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): boolean {
	const parents: Record<string, unknown>[] = [];
	let node: unknown = root;
	for (const key of path.slice(0, -1)) {
		if (!isRecord(node) || !isRecord(node[key])) return false;
		parents.push(node);
		node = node[key];
	}
	const leaf = path[path.length - 1];
	if (!isRecord(node) || leaf === undefined || !Object.hasOwn(node, leaf)) {
		return false;
	}
	delete node[leaf];
	for (let index = path.length - 2; index >= 0; index--) {
		const parent = parents[index];
		const key = path[index];
		if (!parent || key === undefined) break;
		const child = parent[key];
		if (!isRecord(child) || Object.keys(child).length > 0) break;
		delete parent[key];
	}
	return true;
}

type Unwrapped =
	| { kind: "off" }
	| { kind: "recommended" }
	| { kind: "single"; model: string }
	| { kind: "object"; object: Record<string, unknown> }
	| { kind: "invalid" };

function unwrap(kind: PolicyKind, value: unknown): Unwrapped {
	if (value === null || value === undefined || value === false) return { kind: "off" };
	if (typeof value === "string") {
		const text = value.trim();
		if (!text || /^(off|disabled|disable|none|null)$/i.test(text)) {
			return { kind: "off" };
		}
		if (text.toLowerCase() === RECOMMENDED_INTENT_CLASSIFIER) {
			return { kind: "recommended" };
		}
		if (text.startsWith("{")) {
			try {
				const parsed: unknown = JSON.parse(text);
				return isRecord(parsed) ? { kind: "object", object: parsed } : { kind: "invalid" };
			} catch {
				return { kind: "invalid" };
			}
		}
		return kind === "intent" && parseClassifierModel(text)
			? { kind: "single", model: text }
			: { kind: "invalid" };
	}
	return isRecord(value) ? { kind: "object", object: value } : { kind: "invalid" };
}

function readCurrent(kind: PolicyKind, current: unknown): State {
	const value = unwrap(kind, current);
	if (value.kind === "off" || value.kind === "invalid") {
		return { mode: "off", draft: {} };
	}
	if (value.kind === "recommended") {
		return { mode: "recommended", draft: { preset: "recommended" } };
	}
	if (value.kind === "single") {
		return {
			mode: "custom",
			draft: {
				kind: { model: value.model },
				supersession: { model: value.model },
			},
		};
	}
	const draft = structuredClone(value.object);
	const onlyPreset = Object.keys(draft).length === 1 && draft.preset === "recommended";
	return { mode: onlyPreset ? "recommended" : "custom", draft };
}

function presetModel(kind: PolicyKind, id: string): string | null {
	if (kind === "milestone") {
		if (id === "classifier") return MILESTONE_CLASSIFIER;
		if (id === "confirmer") return MILESTONE_CONFIRMER;
		return null;
	}
	if (id === "escalation") return INTENT_ESCALATION;
	if (id === "kind" || id === "supersession" || id === "verification") {
		return INTENT_CLASSIFIER;
	}
	return null;
}

function usesPreset(state: State): boolean {
	return (
		state.mode === "recommended" ||
		(state.mode === "custom" && state.draft.preset === "recommended")
	);
}

function explicitModel(
	state: State,
	path: readonly string[] | undefined,
): string | null | undefined {
	if (!path || state.mode !== "custom") return undefined;
	const value = getPath(state.draft, path);
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function effectiveModel(kind: PolicyKind, state: State, stage: StageSpec): string | null {
	if (state.mode === "off") return null;
	const explicit = explicitModel(state, stage.modelPath);
	if (explicit !== undefined) return explicit;
	return usesPreset(state) ? presetModel(kind, stage.id) : null;
}

function explicitPrompt(state: State, stage: StageSpec): string | undefined {
	if (state.mode !== "custom" || !stage.promptPath) return undefined;
	const value = getPath(state.draft, stage.promptPath);
	return typeof value === "string" ? value : undefined;
}

function singleModel(kind: PolicyKind, state: State): boolean {
	if (kind !== "milestone" || state.mode === "off") return false;
	const classifier = stagesOf(kind).find((stage) => stage.id === "classifier");
	const confirmer = stagesOf(kind).find((stage) => stage.id === "confirmer");
	if (!classifier || !confirmer) return false;
	return (
		effectiveModel(kind, state, classifier) !== null &&
		effectiveModel(kind, state, confirmer) === null
	);
}

function defaultGate(kind: PolicyKind): number {
	return kind === "intent"
		? RECOMMENDED_POLICY_PROVENANCE.confidenceGate
		: RECOMMENDED_MILESTONE_PROVENANCE.confidenceGate;
}

function gateOf(kind: PolicyKind, state: State): number {
	if (state.mode === "custom" && typeof state.draft.minConfidence === "number") {
		return state.draft.minConfidence;
	}
	return defaultGate(kind);
}

function heuristicsOf(state: State): boolean {
	if (state.mode === "custom" && typeof state.draft.heuristics === "boolean") {
		return state.draft.heuristics;
	}
	return true;
}

function knownProblems(kind: PolicyKind, value: Record<string, unknown>): string[] {
	const parsed = parsePolicy(kind, value);
	return parsed.ok ? [] : [...parsed.problems];
}

function promote(state: State): void {
	if (state.mode === "custom") return;
	state.draft = state.mode === "recommended" ? { preset: "recommended" } : {};
	state.mode = "custom";
}

function confidenceProblem(kind: PolicyKind, value: number): string | undefined {
	const parsed = parsePolicy(kind, { minConfidence: value });
	if (parsed.ok) return undefined;
	return parsed.problems.find((problem) => problem.includes("minConfidence")) ?? parsed.problems[0];
}

function instructionsProblem(text: string, where: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length >= 1 && trimmed.length <= MAX_INSTRUCTIONS) return undefined;
	return `${where} must be a text of 1-${MAX_INSTRUCTIONS} characters`;
}

function clip(text: string, max = 28): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function rowsFor(kind: PolicyKind): RowSpec[] {
	const rows: RowSpec[] = [{ kind: "mode" }, { kind: "gate" }];
	if (kind === "intent") rows.push({ kind: "heuristics" });
	for (const stage of stagesOf(kind)) {
		if (stage.modelPath) rows.push({ kind: "model", stage });
		if (stage.promptPath) rows.push({ kind: "prompt", stage });
	}
	rows.push({ kind: "apply" });
	return rows;
}

function frameRow(kind: PolicyKind, row: RowSpec, state: State): FrameRow {
	if (row.kind === "mode") {
		return {
			label: "mode",
			value: state.mode,
			description:
				"recommended keeps the preset. off disables the policy. custom edits stages without turning the others off.",
		};
	}
	if (row.kind === "gate") {
		const explicit = state.mode === "custom" && typeof state.draft.minConfidence === "number";
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

const adjustable = (row: RowSpec | undefined): boolean =>
	row?.kind === "mode" || row?.kind === "heuristics";

function cycleMode(state: State, direction: -1 | 1): void {
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
	probe.heuristics = false;
	const problem = knownProblems("intent", probe).find((item) => item.includes("no source"));
	if (!problem) return false;
	ctx.ui.notify(problem, "warning");
	return true;
}

function setHeuristics(ctx: ExtensionCommandContext, state: State, next: boolean): void {
	if (heuristicsOf(state) === next) return;
	if (refuseHeuristics(ctx, state, next)) return;
	promote(state);
	state.draft.heuristics = next;
}

async function pickMode(
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

async function editGate(
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
		if (state.mode === "custom") delete state.draft.minConfidence;
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
	state.draft.minConfidence = value;
}

async function editModel(
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

async function editPrompt(
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

function commit(
	ctx: ExtensionCommandContext,
	kind: PolicyKind,
	state: State,
): PolicyValue | undefined {
	if (state.mode === "recommended") return "recommended";
	if (state.mode === "off") return null;
	if (Object.keys(state.draft).length === 0) return null;
	if (Object.keys(state.draft).length === 1 && state.draft.preset === "recommended") {
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
	if (typeof object.minConfidence === "number") {
		bits.push(`gate ${object.minConfidence}`);
	}
	if (kind === "intent" && object.heuristics === false) bits.push("heuristics off");
	const preset = object.preset === "recommended";
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
	const preset = unwrapped.object.preset === "recommended";
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
