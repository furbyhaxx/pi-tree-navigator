/** Keyed tool policies and per-model setting definitions. */

import type { AutoNavigatePartial } from "../auto/auto-navigate-config.ts";
import type { ParsedLayer } from "../core/config.ts";
import type { ProposalToolMode } from "../retrospective/proposal-options.ts";
import { autoRead, fieldStatus, SETTINGS } from "./settings-screen-catalog.ts";
import {
	ABSENT,
	AUTO_NAVIGATE,
	type KeyName,
	type Loaded,
	name,
	SET,
	type SettingDef,
	type Target,
	TREE_PROPOSAL,
} from "./settings-screen-types.ts";

// --- Keyed maps: tool policies and model overrides ------------------------------

/** A key that is data (a tool name, a model pattern), spelled one way only. */
const exact = (key: string): KeyName => ({ camel: key, snake: key });
const TOOLS = name("tools");
export const MODEL_OVERRIDES = name("modelOverrides", "model_overrides");
export const TOOL_MODES: readonly ProposalToolMode[] = ["full", "calls-only", "omit"];
const TOOL_HELP =
	"full: calls and results sent. calls-only: results withheld. omit: both withheld. Unlisted: full.";

/** The README's spelling of one override entry, e.g. `model_overrides["gpt-*"]`. */
const quoted = (pattern: string): string => `${MODEL_OVERRIDES.snake}[${JSON.stringify(pattern)}]`;

const AUTO_FIELD: Record<string, keyof AutoNavigatePartial> = {
	enabled: "enabled",
	mode: "mode",
	milestone: "milestonePolicy",
	check_every_turns: "checkEveryTurns",
	min_tokens_since_anchor: "minTokensSinceAnchor",
	rewind_at_tokens: "rewindAtTokens",
	pressure: "pressure",
	keep_recent_share: "keepRecentShare",
};
export const BASE_RESERVE = SETTINGS.filter((def) => def.key === "rewindHintReserveTokens")[0];
const BASE_AUTO = SETTINGS.filter((def) => def.path[0] === AUTO_NAVIGATE);

type ToolsPolicy = Readonly<Record<string, ProposalToolMode>>;
type Policy = { kind: "ok"; tools: ToolsPolicy } | { kind: "invalid"; error: string };

/** A keyed map the screen opens as a submenu. */
export interface Group {
	/** Identity, as for a setting. */
	key: string;
	/** Row label and breadcrumb when it differs from the identity. */
	label?: string;
	path: readonly KeyName[];
	unit: readonly [singular: string, plural: string];
	description: string;
	/** The group whose policy applies to a tool this one does not list. */
	fallback?: ToolsGroup;
	/** Why a layer's copy of this map is unusable, when it is. */
	problem(layer: ParsedLayer): string | undefined;
}

export interface ToolsGroup extends Group {
	policy(layer: ParsedLayer): Policy | undefined;
	/** What the loaded config applies; undefined while a layer blocks it. */
	effective(config: Loaded): ToolsPolicy | undefined;
}

export type Item = { def: SettingDef } | { group: Group };

export const mapTarget = (group: Group): Target => ({
	key: group.key,
	path: group.path,
	kind: "map",
	structured: true,
});

const policyOf = (
	block:
		| { kind: "ok"; value: { tools?: ToolsPolicy } }
		| { kind: "invalid"; error: string }
		| undefined,
): Policy | undefined =>
	block === undefined
		? undefined
		: block.kind === "ok"
			? { kind: "ok", tools: block.value.tools ?? {} }
			: block;

function toolsGroup(
	spec: Pick<
		ToolsGroup,
		"key" | "label" | "path" | "description" | "fallback" | "policy" | "effective"
	>,
): ToolsGroup {
	const group: ToolsGroup = {
		...spec,
		unit: ["tool", "tools"],
		problem: (layer) => {
			const policy = spec.policy(layer);
			return policy?.kind === "invalid" ? policy.error : undefined;
		},
	};
	return group;
}

export const PROPOSAL_TOOLS = toolsGroup({
	key: "treeProposal.tools",
	path: [TREE_PROPOSAL, TOOLS],
	description: "Tools a tree-proposal model may see, by exact name. Enter opens the list.",
	policy: (layer) => policyOf(layer.proposal),
	effective: (config) =>
		config.proposalError === undefined ? (config.proposal?.tools ?? {}) : undefined,
});

export const AUTO_TOOLS = toolsGroup({
	key: "auto_navigate.tools",
	path: [AUTO_NAVIGATE, TOOLS],
	fallback: PROPOSAL_TOOLS,
	description:
		"Tools the controller may see; unlisted ones follow treeProposal.tools. Enter opens the list.",
	policy: (layer) => policyOf(layer.autoNavigate),
	effective: (config) => autoRead(config).tools,
});

export const overrideTools = (pattern: string): ToolsGroup =>
	toolsGroup({
		key: `${quoted(pattern)}.auto_navigate.tools`,
		label: "auto_navigate.tools",
		path: [MODEL_OVERRIDES, exact(pattern), AUTO_NAVIGATE, TOOLS],
		fallback: AUTO_TOOLS,
		description:
			"Tools the controller may see for these models; unlisted ones follow auto_navigate.tools.",
		policy: (layer) => policyOf(layer.modelAutoNavigate?.get(pattern)),
		effective: (config) => {
			const own = config.autoNavigateByModel?.get(pattern);
			const base = AUTO_TOOLS.effective(config);
			return own === null || base === undefined ? undefined : { ...base, ...own?.tools };
		},
	});

/** One tool's mode in a policy map. */
export function toolDef(group: ToolsGroup, tool: string): SettingDef {
	return {
		key: `${group.key}[${JSON.stringify(tool)}]`,
		label: tool,
		path: [...group.path, exact(tool)],
		kind: "choice",
		choices: TOOL_MODES,
		structured: true,
		onInvalid: "blocks",
		expects: "full, calls-only or omit",
		description: TOOL_HELP,
		fallback: group.fallback && toolDef(group.fallback, tool),
		status: (layer) => {
			const policy = group.policy(layer);
			if (!policy) return ABSENT;
			if (policy.kind === "invalid") {
				return { kind: "invalid", error: policy.error };
			}
			return Object.hasOwn(policy.tools, tool) ? SET : ABSENT;
		},
		read: (config) => {
			const effective = group.effective(config);
			if (effective === undefined) return undefined;
			return Object.hasOwn(effective, tool) ? effective[tool] : "full";
		},
	};
}

export const entryTarget = (pattern: string): Target => ({
	key: quoted(pattern),
	path: [MODEL_OVERRIDES, exact(pattern)],
	kind: "map",
	structured: true,
});

export function entryProblem(layer: ParsedLayer, pattern: string): string | undefined {
	if (layer.modelOverridesProblems.nonObjectEntries.includes(pattern)) {
		return "is not an object";
	}
	if (layer.modelHints.get(pattern)?.kind === "invalid") {
		return "invalid rewind_hint_reserve_tokens";
	}
	const auto = layer.modelAutoNavigate?.get(pattern);
	return auto?.kind === "invalid" ? auto.error : undefined;
}

export const OVERRIDES: Group = {
	key: "model_overrides",
	path: [MODEL_OVERRIDES],
	unit: ["entry", "entries"],
	description:
		"Per-model reserve and auto_navigate, keyed by provider/model or a wildcard. Enter opens the list.",
	problem: (layer) => {
		const { notObject, nonObjectEntries } = layer.modelOverridesProblems;
		if (notObject) return "model_overrides must be an object keyed by model";
		if (nonObjectEntries.length > 0) {
			return `${quoted(nonObjectEntries[0])} must be an object`;
		}
		for (const [pattern] of layer.modelHints) {
			const problem = entryProblem(layer, pattern);
			if (problem) return `${quoted(pattern)}: ${problem}`;
		}
		for (const [pattern] of layer.modelAutoNavigate ?? []) {
			const problem = entryProblem(layer, pattern);
			if (problem) return problem;
		}
		return undefined;
	},
};

/** A model's reserve inside one override entry. */
const overrideReserve = (pattern: string): SettingDef => ({
	...BASE_RESERVE,
	key: `${quoted(pattern)}.${BASE_RESERVE.key}`,
	label: BASE_RESERVE.key,
	path: [MODEL_OVERRIDES, exact(pattern), ...BASE_RESERVE.path],
	structured: true,
	fallback: BASE_RESERVE,
	status: (layer) => {
		const field = layer.modelHints.get(pattern);
		return field ? fieldStatus(field) : ABSENT;
	},
	read: (config) =>
		config.rewindHintModelReserveTokens.has(pattern)
			? config.rewindHintModelReserveTokens.get(pattern)
			: BASE_RESERVE.read(config),
});

/** One `auto_navigate` property inside an override entry, reusing the root setting's rules. */
function overrideAuto(base: SettingDef, pattern: string): SettingDef {
	const part = base.path[1];
	const field = AUTO_FIELD[part.snake];
	return {
		...base,
		key: `${quoted(pattern)}.${base.key}`,
		label: base.key,
		path: [MODEL_OVERRIDES, exact(pattern), AUTO_NAVIGATE, part],
		structured: true,
		fallback: base,
		status: (layer) => {
			const entry = layer.modelAutoNavigate?.get(pattern);
			if (!entry) return ABSENT;
			if (entry.kind === "invalid") {
				return { kind: "invalid", error: entry.error };
			}
			return entry.value[field] === undefined ? ABSENT : SET;
		},
		read: (config) => {
			const own = config.autoNavigateByModel?.get(pattern);
			return own === null ? undefined : (own?.[field] ?? base.read(config));
		},
	};
}

export const entrySettings = (pattern: string): readonly SettingDef[] => [
	overrideReserve(pattern),
	...BASE_AUTO.map((base) => overrideAuto(base, pattern)),
];

export const entryItems = (pattern: string): readonly Item[] => [
	...entrySettings(pattern).map((def): Item => ({ def })),
	{ group: overrideTools(pattern) },
];

const GROUP_AFTER = new Map<string, Group>([
	["treeProposal.model", PROPOSAL_TOOLS],
	["auto_navigate.keep_recent_share", AUTO_TOOLS],
]);

/** Everything the top screen lists, in order. */
export const ITEMS: readonly Item[] = [
	...SETTINGS.flatMap((def): Item[] => {
		const group = GROUP_AFTER.get(def.key);
		return group ? [{ def }, { group }] : [{ def }];
	}),
	{ group: OVERRIDES },
];

export const isToolsGroup = (group: Group): group is ToolsGroup => "policy" in group;
