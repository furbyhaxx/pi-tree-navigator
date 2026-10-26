/** Policy draft state, stage definitions, and production-parser validation. */
import {
	parseMilestonePolicyObject,
	RECOMMENDED_MILESTONE_POLICY,
	RECOMMENDED_MILESTONE_PROVENANCE,
} from "../auto/milestone-policy.ts";
import {
	parseClassifierModel,
	parseIntentPolicyObject,
	RECOMMENDED_INTENT_CLASSIFIER,
	RECOMMENDED_POLICY,
	RECOMMENDED_POLICY_PROVENANCE,
} from "../continuity/intent-policy.ts";

type PolicyKind = "intent" | "milestone";

const MAX_INSTRUCTIONS = 1_000;
const INTENT_CLASSIFIER = RECOMMENDED_POLICY.classifier;
const INTENT_ESCALATION = RECOMMENDED_POLICY.escalation;
const MILESTONE_CLASSIFIER = RECOMMENDED_MILESTONE_POLICY.classifier;
const MILESTONE_CONFIRMER = RECOMMENDED_MILESTONE_POLICY.confirmer;
export const SINGLE_MODEL_WARNING =
	"Single-model mode: no confirmer. One model alone accepted unsafe answers on holdout.";

export type Mode = "recommended" | "off" | "custom";

export interface StageSpec {
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

export interface State {
	mode: Mode;
	draft: Record<string, unknown>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const stagesOf = (kind: PolicyKind): readonly StageSpec[] =>
	kind === "intent" ? INTENT_STAGES : MILESTONE_STAGES;

export const rootOf = (kind: PolicyKind): string =>
	kind === "intent" ? "continuity.intentClassifier" : "autoNavigate.milestone";

export function parsePolicy(kind: PolicyKind, value: unknown) {
	return kind === "intent" ? parseIntentPolicyObject(value) : parseMilestonePolicyObject(value);
}

export function getPath(root: Record<string, unknown>, path: readonly string[]): unknown {
	let node: unknown = root;
	for (const key of path) {
		if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

export function setPath(
	root: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): void {
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

export function deletePath(root: Record<string, unknown>, path: readonly string[]): boolean {
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

export function unwrap(kind: PolicyKind, value: unknown): Unwrapped {
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

export function readCurrent(kind: PolicyKind, current: unknown): State {
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

export function effectiveModel(kind: PolicyKind, state: State, stage: StageSpec): string | null {
	if (state.mode === "off") return null;
	const explicit = explicitModel(state, stage.modelPath);
	if (explicit !== undefined) return explicit;
	return usesPreset(state) ? presetModel(kind, stage.id) : null;
}

export function explicitPrompt(state: State, stage: StageSpec): string | undefined {
	if (state.mode !== "custom" || !stage.promptPath) return undefined;
	const value = getPath(state.draft, stage.promptPath);
	return typeof value === "string" ? value : undefined;
}

export function singleModel(kind: PolicyKind, state: State): boolean {
	if (kind !== "milestone" || state.mode === "off") return false;
	const classifier = stagesOf(kind).find((stage) => stage.id === "classifier");
	const confirmer = stagesOf(kind).find((stage) => stage.id === "confirmer");
	if (!classifier || !confirmer) return false;
	return (
		effectiveModel(kind, state, classifier) !== null &&
		effectiveModel(kind, state, confirmer) === null
	);
}

export function defaultGate(kind: PolicyKind): number {
	return kind === "intent"
		? RECOMMENDED_POLICY_PROVENANCE.confidenceGate
		: RECOMMENDED_MILESTONE_PROVENANCE.confidenceGate;
}

export function gateOf(kind: PolicyKind, state: State): number {
	if (state.mode === "custom" && typeof state.draft.minConfidence === "number") {
		return state.draft.minConfidence;
	}
	return defaultGate(kind);
}

export function heuristicsOf(state: State): boolean {
	if (state.mode === "custom" && typeof state.draft.heuristics === "boolean") {
		return state.draft.heuristics;
	}
	return true;
}

export function knownProblems(kind: PolicyKind, value: Record<string, unknown>): string[] {
	const parsed = parsePolicy(kind, value);
	return parsed.ok ? [] : [...parsed.problems];
}

export function promote(state: State): void {
	if (state.mode === "custom") return;
	state.draft = state.mode === "recommended" ? { preset: "recommended" } : {};
	state.mode = "custom";
}

export function confidenceProblem(kind: PolicyKind, value: number): string | undefined {
	const parsed = parsePolicy(kind, { minConfidence: value });
	if (parsed.ok) return undefined;
	return parsed.problems.find((problem) => problem.includes("minConfidence")) ?? parsed.problems[0];
}

export function instructionsProblem(text: string, where: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length >= 1 && trimmed.length <= MAX_INSTRUCTIONS) return undefined;
	return `${where} must be a text of 1-${MAX_INSTRUCTIONS} characters`;
}
