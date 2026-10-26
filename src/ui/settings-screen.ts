/**
 * `/anchor settings`: staged editor for `tree-navigator.json`.
 *
 * Edits are staged in memory against one target layer (global or project) and
 * written only on save, after a confirmation. Effective values come from the
 * real loader (`loadTreeNavigatorConfig`) and every candidate value is checked
 * with the real parsers (`parseTreeNavigatorConfig`), so the screen cannot
 * accept a value that the next session start would reject. A file that does
 * not parse as a JSON object is never written.
 *
 * The keyed maps (`treeProposal.tools`, `auto_navigate.tools` and
 * `model_overrides`, with their nested tool policies) open as submenus. Each
 * entry stages the same way a scalar does, addressed by its own path.
 */
import {
	readFile as fsReadFile,
	writeFile as fsWriteFile,
	mkdir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE,
	AUTO_NAVIGATE_MAX_TOKENS,
	AUTO_NAVIGATE_MAX_TURNS,
	AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE,
	AUTO_NAVIGATE_MIN_TOKENS,
	AUTO_NAVIGATE_MIN_TURNS,
	type AutoNavigatePartial,
} from "../auto/auto-navigate-config.ts";
import {
	loadTreeNavigatorConfig,
	type ParsedLayer,
	parseTreeNavigatorConfig,
	REWIND_HINT_MAX_RESERVE,
	REWIND_HINT_MIN_RESERVE,
	resolveAutoNavigateConfig,
	START_ANCHOR_MAX_TURNS,
	START_ANCHOR_MIN_TURNS,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "../core/config.ts";
import { readRuntimeConfig, writeRuntimeConfig } from "../core/runtime-config.ts";
import type { ProposalToolMode } from "../retrospective/proposal-options.ts";
import { type FrameRow, type FrameScreen, selectFrame } from "./frame.ts";
import {
	editPolicy,
	type PolicyKind,
	policyAccepted,
	policyWarning,
	summarizePolicy,
} from "./policy-settings.ts";
import { pickSettingsModel } from "./settings-model-picker.ts";

/** Where the two config files live for the session and whether the project layer counts. */
export interface SettingsScreenDeps {
	locations(ctx: ExtensionCommandContext): {
		agentDir: string;
		projectPath: string;
		projectTrusted: boolean;
	};
	/** Defaults to UTF-8 `fs.readFile`. */
	readFile?(path: string): Promise<string>;
	/** Defaults to an atomic write (temp file + rename) that creates missing directories. */
	writeFile?(path: string, text: string): Promise<void>;
	/** Apply the effective configuration to the live session after any scope is saved. */
	onSaved?(ctx: ExtensionCommandContext): Promise<void>;
}

/** The deps for the live extension: pi's agent dir and the session's cwd and trust. */
export function createSettingsScreenDeps(): SettingsScreenDeps {
	return {
		locations: (ctx) => ({
			agentDir: getAgentDir(),
			projectPath: join(ctx.cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME),
			projectTrusted: ctx.isProjectTrusted(),
		}),
	};
}

/** "done" ends the whole command; "back" returns to the screen that opened this one. */
type ScreenExit = "back" | "done";

const LAYERS = ["global", "project", "runtime"] as const;
const PRECEDENCE = ["runtime", "project", "global"] as const;
type Layer = (typeof LAYERS)[number];
type Source = Layer | "default";
type Root = Record<string, unknown>;
type Style = "camel" | "snake";
type Loaded = Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"];

/** One key as the file may spell it. Snake_case wins when both exist, as in config.ts. */
interface KeyName {
	camel: string;
	snake: string;
	/** Spelling for a new key regardless of the file's style. */
	fresh?: Style;
	/** `auto_navigate: true` means `{ enabled: true }`; this is the key it stands for. */
	shorthand?: string;
}

const name = (camel: string, snake = camel): KeyName => ({ camel, snake });
const CONTINUITY = name("continuity");
const TREE_PROPOSAL = name("treeProposal", "tree_proposal");
const AUTO_NAVIGATE: KeyName = {
	camel: "autoNavigate",
	snake: "auto_navigate",
	fresh: "snake",
	shorthand: "enabled",
};

type Status = { kind: "absent" } | { kind: "set" } | { kind: "invalid"; error?: string };
const ABSENT: Status = { kind: "absent" };
const SET: Status = { kind: "set" };

type Kind =
	| "tokens"
	| "count"
	| "share"
	| "flag"
	| "choice"
	| "model"
	| "classifier"
	| "policy"
	| "map";

/** What a staged edit addresses: a setting, or a whole map or entry. */
interface Target {
	/** Identity in the staged map: the key as the README spells it, unique per path. */
	key: string;
	path: readonly KeyName[];
	kind: Kind;
	/** Part of a keyed map: edits refuse to replace a non-object on the way down. */
	structured?: boolean;
	/** Classifier policy edited by the structured editor, not as raw JSON. */
	policy?: PolicyKind;
}

interface SettingDef extends Target {
	/** Row label when it differs from the identity. */
	label?: string;
	choices?: readonly string[];
	/** Accepts the disable sentinels; written as `null`. */
	off?: boolean;
	/** What a valid value looks like, for the prompt and the refusal. */
	expects: string;
	description: string;
	/**
	 * How an invalid value in a layer counts: it still claims the setting (hint),
	 * falls through to the other layer (most fields), or blocks the whole group.
	 */
	onInvalid: "claims" | "falls-through" | "blocks";
	/** The setting whose value applies while no layer sets this one. */
	fallback?: SettingDef;
	status(layer: ParsedLayer): Status;
	read(config: Loaded): unknown;
}

const count = (n: number): string => n.toLocaleString("en-US");
const range = (min: number, max: number): string => `${count(min)}-${count(max)}`;

/** `50k`, `1.5M`, or the plain number when it has no short form. */
function tokens(n: number): string {
	if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
	if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}k`;
	return count(n);
}

const fieldStatus = (field: { kind: "absent" | "ok" | "disabled" | "invalid" }): Status =>
	field.kind === "absent" ? ABSENT : field.kind === "invalid" ? { kind: "invalid" } : SET;

const continuityStatus =
	(pick: "capture" | "intentClassifier") =>
	(layer: ParsedLayer): Status => {
		const field = layer.continuity?.[pick];
		if (field === undefined) return ABSENT;
		return field.kind === "invalid" && "problems" in field
			? { kind: "invalid", error: field.problems.join("; ") }
			: fieldStatus(field);
	};

const autoStatus =
	(field: keyof AutoNavigatePartial) =>
	(layer: ParsedLayer): Status => {
		const block = layer.autoNavigate;
		if (!block) return ABSENT;
		if (block.kind === "invalid") return { kind: "invalid", error: block.error };
		return block.value[field] === undefined ? ABSENT : SET;
	};

const autoRead = (config: Loaded) => resolveAutoNavigateConfig(config, undefined);

const TOKEN_RANGE = range(AUTO_NAVIGATE_MIN_TOKENS, AUTO_NAVIGATE_MAX_TOKENS);
const KEEP_RECENT_SHARE_RANGE = range(
	AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE,
	AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE,
);

const SETTINGS: readonly SettingDef[] = [
	{
		key: "rewindHintReserveTokens",
		path: [name("rewindHintReserveTokens", "rewind_hint_reserve_tokens")],
		kind: "tokens",
		off: true,
		onInvalid: "claims",
		expects: `${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)} tokens (e.g. 50k), or off`,
		description: `Nudge the agent to rewind when this many tokens are left in the window. ${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)}, or off (default).`,
		status: (layer) => fieldStatus(layer.hint),
		read: (config) => config.rewindHintReserveTokens,
	},
	{
		key: "anchorStartAfterTurns",
		path: [name("anchorStartAfterTurns", "anchor_start_after_turns")],
		kind: "count",
		onInvalid: "falls-through",
		expects: `${range(START_ANCHOR_MIN_TURNS, START_ANCHOR_MAX_TURNS)} turns`,
		description: `Turn of an agent run at which the silent start anchor is written. ${range(START_ANCHOR_MIN_TURNS, START_ANCHOR_MAX_TURNS)} (default 2).`,
		status: (layer) => fieldStatus(layer.startAnchor),
		read: (config) => config.anchorStartAfterTurns,
	},
	{
		key: "parentHandoffMode",
		path: [name("parentHandoffMode", "parent_handoff_mode")],
		kind: "choice",
		choices: ["digest", "full", "synthesized"],
		onInvalid: "falls-through",
		expects: "full, synthesized or digest",
		description: "Digest (default): one line per child; full: reports; synthesized: parent only.",
		status: (layer) => fieldStatus(layer.parentHandoffMode),
		read: (config) => config.parentHandoffMode,
	},
	{
		key: "continuity.capture",
		path: [CONTINUITY, name("capture")],
		kind: "flag",
		onInvalid: "falls-through",
		expects: "true or false",
		description:
			"Capture your rules and decisions from messages into the continuity ledger. Default true.",
		status: continuityStatus("capture"),
		read: (config) => config.continuity.capture,
	},
	{
		key: "continuity.intentClassifier",
		path: [CONTINUITY, name("intentClassifier", "intent_classifier")],
		kind: "policy",
		policy: "intent",
		off: true,
		onInvalid: "falls-through",
		expects: "recommended, off, or a custom policy",
		description:
			"Judges new messages for the ledger. recommended is opt-in; off (default) uses heuristics only.",
		status: continuityStatus("intentClassifier"),
		read: (config) => config.continuity.intentClassifier,
	},
	{
		key: "treeProposal.model",
		path: [TREE_PROPOSAL, name("model")],
		kind: "model",
		onInvalid: "blocks",
		expects: "current or provider/id[:thinking]",
		description:
			"Model for tree proposals: current (the active model) or provider/id[:thinking]. Default current.",
		status: (layer) =>
			layer.proposal === undefined
				? ABSENT
				: layer.proposal.kind === "invalid"
					? { kind: "invalid", error: layer.proposal.error }
					: layer.proposal.value.model === undefined
						? ABSENT
						: SET,
		read: (config) =>
			config.proposalError === undefined ? (config.proposal?.model ?? "current") : undefined,
	},
	{
		key: "auto_navigate.enabled",
		path: [AUTO_NAVIGATE, name("enabled")],
		kind: "flag",
		onInvalid: "blocks",
		expects: "true or false",
		description:
			"Let a sidecar controller set anchors and fold on its own as the context grows. Default false.",
		status: autoStatus("enabled"),
		read: (config) => autoRead(config).enabled,
	},
	{
		key: "auto_navigate.mode",
		path: [AUTO_NAVIGATE, name("mode")],
		kind: "choice",
		choices: ["anchor-only", "anchor-and-rewind"],
		onInvalid: "blocks",
		expects: "anchor-only or anchor-and-rewind",
		description: "anchor-only sets anchors; anchor-and-rewind (default) may also fold back to one.",
		status: autoStatus("mode"),
		read: (config) => autoRead(config).mode,
	},
	{
		key: "auto_navigate.milestone",
		path: [AUTO_NAVIGATE, name("milestone")],
		kind: "policy",
		policy: "milestone",
		off: true,
		onInvalid: "blocks",
		expects: "recommended, off, or a custom policy",
		description:
			"Confirms a finished phase before an automatic fold. recommended (default), off, or a custom policy.",
		status: autoStatus("milestonePolicy"),
		read: (config) => autoRead(config).milestonePolicy,
	},
	{
		key: "auto_navigate.check_every_turns",
		path: [AUTO_NAVIGATE, name("check_every_turns")],
		kind: "count",
		onInvalid: "blocks",
		expects: `${range(AUTO_NAVIGATE_MIN_TURNS, AUTO_NAVIGATE_MAX_TURNS)} turns`,
		description: `Check again after this many completed turns. ${range(AUTO_NAVIGATE_MIN_TURNS, AUTO_NAVIGATE_MAX_TURNS)} (default 6).`,
		status: autoStatus("checkEveryTurns"),
		read: (config) => autoRead(config).checkEveryTurns,
	},
	{
		key: "auto_navigate.min_tokens_since_anchor",
		path: [AUTO_NAVIGATE, name("min_tokens_since_anchor")],
		kind: "tokens",
		onInvalid: "blocks",
		expects: `${TOKEN_RANGE} tokens (e.g. 25k)`,
		description: `Check again after this many new tokens since the last anchor. ${TOKEN_RANGE} (default 25k).`,
		status: autoStatus("minTokensSinceAnchor"),
		read: (config) => autoRead(config).minTokensSinceAnchor,
	},
	{
		key: "auto_navigate.rewind_at_tokens",
		path: [AUTO_NAVIGATE, name("rewind_at_tokens")],
		kind: "tokens",
		onInvalid: "blocks",
		expects: `${TOKEN_RANGE} tokens (e.g. 120k)`,
		description: `Context size at which the controller may fold to an earlier anchor. ${TOKEN_RANGE} (default 120k).`,
		status: autoStatus("rewindAtTokens"),
		read: (config) => autoRead(config).rewindAtTokens,
	},
	{
		key: "auto_navigate.pressure",
		path: [AUTO_NAVIGATE, name("pressure")],
		kind: "choice",
		choices: ["compact", "fold"],
		onInvalid: "blocks",
		expects: "compact or fold",
		description:
			"At rewind_at_tokens: compact (default) summarizes older work; keeps recent work verbatim. Fold returns to anchor.",
		status: autoStatus("pressure"),
		read: (config) => autoRead(config).pressure,
	},
	{
		key: "auto_navigate.keep_recent_share",
		path: [AUTO_NAVIGATE, name("keep_recent_share")],
		kind: "share",
		onInvalid: "blocks",
		expects: `number ${KEEP_RECENT_SHARE_RANGE} inclusive`,
		description:
			"Share of rewind_at_tokens kept verbatim after a pressure compaction. 0.05 to 0.45 (default 0.25).",
		status: autoStatus("keepRecentShare"),
		read: (config) => autoRead(config).keepRecentShare,
	},
	{
		key: "consolidation.enabled",
		path: [name("consolidation"), { ...name("enabled", "enabled"), fresh: "snake" }],
		kind: "flag",
		onInvalid: "falls-through",
		expects: "true or false",
		description:
			"Merge older handoffs into one compaction entry while you work. Newest handoffs stay verbatim. Default true.",
		status: (layer) => (layer.consolidation ? fieldStatus(layer.consolidation.enabled) : ABSENT),
		read: (config) => config.consolidation.enabled,
	},
	{
		key: "consolidation.max_handoffs",
		path: [name("consolidation"), { ...name("maxHandoffs", "max_handoffs"), fresh: "snake" }],
		kind: "count",
		onInvalid: "falls-through",
		expects: "integer 1-100",
		description:
			"Consolidate when the projection has more handoffs than this count. 1-100 (default 4).",
		status: (layer) =>
			layer.consolidation ? fieldStatus(layer.consolidation.maxHandoffs) : ABSENT,
		read: (config) => config.consolidation.maxHandoffs,
	},
	{
		key: "consolidation.max_window_share",
		path: [
			name("consolidation"),
			{ ...name("maxWindowShare", "max_window_share"), fresh: "snake" },
		],
		kind: "share",
		onInvalid: "falls-through",
		expects: "number greater than 0 and at most 1",
		description:
			"Consolidate when handoff tokens exceed this share of the context window. Greater than 0, at most 1 (default 0.1).",
		status: (layer) =>
			layer.consolidation ? fieldStatus(layer.consolidation.maxWindowShare) : ABSENT,
		read: (config) => config.consolidation.maxWindowShare,
	},
	{
		key: "consolidation.keep_newest",
		path: [name("consolidation"), { ...name("keepNewest", "keep_newest"), fresh: "snake" }],
		kind: "count",
		onInvalid: "falls-through",
		expects: "integer 1-20",
		description: "Newest handoffs retained verbatim during consolidation. 1-20 (default 2).",
		status: (layer) => (layer.consolidation ? fieldStatus(layer.consolidation.keepNewest) : ABSENT),
		read: (config) => config.consolidation.keepNewest,
	},
];

// --- Keyed maps: tool policies and model overrides ------------------------------

/** A key that is data (a tool name, a model pattern), spelled one way only. */
const exact = (key: string): KeyName => ({ camel: key, snake: key });
const TOOLS = name("tools");
const MODEL_OVERRIDES = name("modelOverrides", "model_overrides");
const TOOL_MODES: readonly ProposalToolMode[] = ["full", "calls-only", "omit"];
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
const BASE_RESERVE = SETTINGS.filter((def) => def.key === "rewindHintReserveTokens")[0];
const BASE_AUTO = SETTINGS.filter((def) => def.path[0] === AUTO_NAVIGATE);

type ToolsPolicy = Readonly<Record<string, ProposalToolMode>>;
type Policy = { kind: "ok"; tools: ToolsPolicy } | { kind: "invalid"; error: string };

/** A keyed map the screen opens as a submenu. */
interface Group {
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
	open(session: Session, crumbs: readonly string[]): Promise<void>;
}

interface ToolsGroup extends Group {
	policy(layer: ParsedLayer): Policy | undefined;
	/** What the loaded config applies; undefined while a layer blocks it. */
	effective(config: Loaded): ToolsPolicy | undefined;
}

type Item = { def: SettingDef } | { group: Group };

const mapTarget = (group: Group): Target => ({
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
		open: (session, crumbs) => editTools(session, group, crumbs),
	};
	return group;
}

const PROPOSAL_TOOLS = toolsGroup({
	key: "treeProposal.tools",
	path: [TREE_PROPOSAL, TOOLS],
	description: "Tools a tree-proposal model may see, by exact name. Enter opens the list.",
	policy: (layer) => policyOf(layer.proposal),
	effective: (config) =>
		config.proposalError === undefined ? (config.proposal?.tools ?? {}) : undefined,
});

const AUTO_TOOLS = toolsGroup({
	key: "auto_navigate.tools",
	path: [AUTO_NAVIGATE, TOOLS],
	fallback: PROPOSAL_TOOLS,
	description:
		"Tools the controller may see; unlisted ones follow treeProposal.tools. Enter opens the list.",
	policy: (layer) => policyOf(layer.autoNavigate),
	effective: (config) => autoRead(config).tools,
});

const overrideTools = (pattern: string): ToolsGroup =>
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
function toolDef(group: ToolsGroup, tool: string): SettingDef {
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

const entryTarget = (pattern: string): Target => ({
	key: quoted(pattern),
	path: [MODEL_OVERRIDES, exact(pattern)],
	kind: "map",
	structured: true,
});

function entryProblem(layer: ParsedLayer, pattern: string): string | undefined {
	if (layer.modelOverridesProblems.nonObjectEntries.includes(pattern)) {
		return "is not an object";
	}
	if (layer.modelHints.get(pattern)?.kind === "invalid") {
		return "invalid rewind_hint_reserve_tokens";
	}
	const auto = layer.modelAutoNavigate?.get(pattern);
	return auto?.kind === "invalid" ? auto.error : undefined;
}

const OVERRIDES: Group = {
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
	open: (session, crumbs) => editOverrides(session, crumbs),
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

const entrySettings = (pattern: string): readonly SettingDef[] => [
	overrideReserve(pattern),
	...BASE_AUTO.map((base) => overrideAuto(base, pattern)),
];

const entryItems = (pattern: string): readonly Item[] => [
	...entrySettings(pattern).map((def): Item => ({ def })),
	{ group: overrideTools(pattern) },
];

const GROUP_AFTER = new Map<string, Group>([
	["treeProposal.model", PROPOSAL_TOOLS],
	["auto_navigate.keep_recent_share", AUTO_TOOLS],
]);

/** Everything the top screen lists, in order. */
const ITEMS: readonly Item[] = [
	...SETTINGS.flatMap((def): Item[] => {
		const group = GROUP_AFTER.get(def.key);
		return group ? [{ def }, { group }] : [{ def }];
	}),
	{ group: OVERRIDES },
];

const isRoot = (value: unknown): value is Root =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// --- Raw file access: spelling-preserving reads and edits ----------------------

function findName(node: Root, part: KeyName): string | undefined {
	if (Object.hasOwn(node, part.snake)) return part.snake;
	return Object.hasOwn(node, part.camel) ? part.camel : undefined;
}

const freshName = (part: KeyName, style: Style): string =>
	(part.fresh ?? style) === "snake" ? part.snake : part.camel;

const SNAKE_MARKERS = [
	"rewind_hint_reserve_tokens",
	"anchor_start_after_turns",
	"parent_handoff_mode",
	"tree_proposal",
	"model_overrides",
];
const CAMEL_MARKERS = [
	"rewindHintReserveTokens",
	"anchorStartAfterTurns",
	"parentHandoffMode",
	"treeProposal",
	"modelOverrides",
];

/** The spelling a file uses for its top-level keys; new keys follow it. */
function styleOf(root: Root): Style {
	const used = (names: readonly string[]) =>
		names.filter((candidate) => Object.hasOwn(root, candidate)).length;
	return used(SNAKE_MARKERS) > used(CAMEL_MARKERS) ? "snake" : "camel";
}

interface Raw {
	present: boolean;
	value?: unknown;
}

function rawOf(root: Root, { path }: { path: readonly KeyName[] }): Raw {
	let node = root;
	for (const [index, part] of path.entries()) {
		const found = findName(node, part);
		if (found === undefined) return { present: false };
		const value = node[found];
		if (index === path.length - 1) return { present: true, value };
		if (typeof value === "boolean" && part.shorthand === path[index + 1].snake) {
			return { present: true, value };
		}
		if (!isRoot(value)) return { present: false };
		node = value;
	}
	return { present: false };
}

/** Own-property write: keys here are user data, so `__proto__` must not reach the prototype. */
function define(node: Root, key: string, value: unknown): void {
	Object.defineProperty(node, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function setAt(root: Root, path: readonly KeyName[], value: unknown, style: Style): void {
	let node = root;
	for (const [index, part] of path.entries()) {
		const key = findName(node, part) ?? freshName(part, style);
		if (index === path.length - 1) {
			define(node, key, value);
			return;
		}
		let child = node[key];
		if (typeof child === "boolean" && part.shorthand !== undefined) {
			child = { [part.shorthand]: child };
		}
		const next = isRoot(child) ? child : {};
		define(node, key, next);
		node = next;
	}
}

/** Removes every spelling of the key, then any container that this left empty. */
function removeAt(root: Root, path: readonly KeyName[]): void {
	const trail: { parent: Root; key: string }[] = [];
	let node = root;
	for (const [index, part] of path.entries()) {
		const key = findName(node, part);
		if (key === undefined) return;
		const child = node[key];
		const leaf = index === path.length - 1;
		const standsForLeaf = typeof child === "boolean" && part.shorthand === path[index + 1]?.snake;
		if (leaf || standsForLeaf) {
			for (const spelling of new Set([part.snake, part.camel])) {
				Reflect.deleteProperty(node, spelling);
			}
			break;
		}
		if (!isRoot(child)) return;
		trail.push({ parent: node, key });
		node = child;
	}
	for (const { parent, key } of trail.reverse()) {
		const child = parent[key];
		if (!isRoot(child) || Object.keys(child).length > 0) break;
		Reflect.deleteProperty(parent, key);
	}
}

/** True when `path` is `ancestor` or lies below it. */
const isUnder = (path: readonly KeyName[], ancestor: readonly KeyName[]): boolean =>
	ancestor.length <= path.length &&
	ancestor.every((part, index) => part.snake === path[index].snake);

/** The first container above the leaf that exists but is not an object, which an edit would replace. */
function blockedBy(root: Root, path: readonly KeyName[]): string | undefined {
	let node = root;
	for (const [index, part] of path.slice(0, -1).entries()) {
		const found = findName(node, part);
		if (found === undefined) return undefined;
		const value = node[found];
		if (isRoot(value)) {
			node = value;
			continue;
		}
		if (typeof value === "boolean" && part.shorthand !== undefined) {
			return undefined;
		}
		return path
			.slice(0, index + 1)
			.map((step) => step.snake)
			.join(".");
	}
	return undefined;
}

/** The keys of the object at `path`; none when it is absent or not an object. */
function namesAt(root: Root, path: readonly KeyName[]): string[] {
	const raw = rawOf(root, { path });
	return raw.present && isRoot(raw.value) ? Object.keys(raw.value) : [];
}

type Edit = { kind: "set"; value: unknown } | { kind: "reset" };

/** A staged edit with what it addresses; the key in the staged map is `def.key`. */
interface Pending {
	def: Target;
	edit: Edit;
}

function applyEdit(root: Root, def: Target, edit: Edit): Root {
	const next = structuredClone(root);
	if (edit.kind === "reset") removeAt(next, def.path);
	else setAt(next, def.path, edit.value, styleOf(root));
	return next;
}

const sameRaw = (a: Raw, b: Raw): boolean =>
	a.present === b.present && JSON.stringify(a.value) === JSON.stringify(b.value);

interface Change {
	def: Target;
	edit: Edit;
	before: Raw;
	after: Raw;
}

interface Plan {
	next: Root;
	changes: Change[];
}

/** The edits that actually change this file, applied in the order they were staged. */
function planChanges(root: Root, staged: ReadonlyMap<string, Pending>): Plan {
	let next = root;
	const changes: Change[] = [];
	for (const { def, edit } of staged.values()) {
		const candidate = applyEdit(next, def, edit);
		const before = rawOf(next, def);
		const after = rawOf(candidate, def);
		if (sameRaw(before, after)) continue;
		next = candidate;
		changes.push({ def, edit, before, after });
	}
	return { next, changes };
}

const serialize = (root: Root): string => `${JSON.stringify(root, null, 2)}\n`;

// --- Reading both layers --------------------------------------------------------

type FileState =
	| { kind: "missing" }
	| { kind: "ok"; text: string; root: Root }
	| { kind: "broken"; text?: string; reason: string };

async function readFileState(
	read: (path: string) => Promise<string>,
	path: string,
): Promise<FileState> {
	let text: string;
	try {
		text = await read(path);
	} catch (error) {
		if (isEnoent(error)) return { kind: "missing" };
		return {
			kind: "broken",
			reason: `could not be read (${messageOf(error)})`,
		};
	}
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (error) {
		return {
			kind: "broken",
			text,
			reason: `is not valid JSON (${messageOf(error)})`,
		};
	}
	if (!isRoot(root)) {
		return { kind: "broken", text, reason: "must be a JSON object" };
	}
	return { kind: "ok", text, root };
}

interface Resolution {
	config: Loaded;
	layers: Record<Layer, ParsedLayer | undefined>;
}

function parseLayer(text: string | undefined): ParsedLayer | undefined {
	if (text === undefined) return undefined;
	try {
		const parsed = parseTreeNavigatorConfig(JSON.parse(text));
		return parsed.kind === "fields" ? parsed.layer : undefined;
	} catch {
		return undefined;
	}
}

interface Snapshot {
	cwd: string;
	paths: Record<Layer, string>;
	trusted: boolean;
	files: Record<Layer, FileState>;
	current: Resolution;
}

const textOf = (file: FileState): string | undefined =>
	file.kind === "missing" ? undefined : file.text;

/** Runs the real loader over in-memory texts, so values match what a session would load. */
async function resolve(
	paths: Record<Layer, string>,
	trusted: boolean,
	texts: Record<Layer, string | undefined>,
): Promise<Resolution> {
	const { config } = await loadTreeNavigatorConfig({
		agentDir: dirname(paths.global),
		projectPath: paths.project,
		projectTrusted: trusted,
		runtime: texts.runtime ? JSON.parse(texts.runtime) : {},
		async readFile(path) {
			const text = path === paths.global ? texts.global : texts.project;
			if (text === undefined) {
				throw Object.assign(new Error("not found"), { code: "ENOENT" });
			}
			return text;
		},
	});
	return {
		config,
		layers: {
			global: parseLayer(texts.global),
			project: trusted ? parseLayer(texts.project) : undefined,
			runtime: parseLayer(texts.runtime),
		},
	};
}

async function readSnapshot(
	ctx: ExtensionCommandContext,
	deps: SettingsScreenDeps,
): Promise<Snapshot> {
	const where = deps.locations(ctx);
	const runtime = readRuntimeConfig(ctx.sessionManager.getSessionId());
	const read = deps.readFile ?? ((path) => fsReadFile(path, "utf8"));
	const paths: Record<Layer, string> = {
		global: join(where.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME),
		project: where.projectPath,
		runtime: "session memory (cleared on reload or session switch)",
	};
	const files: Record<Layer, FileState> = {
		global: await readFileState(read, paths.global),
		project: where.projectTrusted ? await readFileState(read, paths.project) : { kind: "missing" },
		runtime: { kind: "ok", root: runtime, text: serialize(runtime) },
	};
	return {
		cwd: ctx.cwd,
		paths,
		trusted: where.projectTrusted,
		files,
		current: await resolve(paths, where.projectTrusted, {
			global: textOf(files.global),
			project: textOf(files.project),
			runtime: textOf(files.runtime),
		}),
	};
}

// --- Effective values and where they come from ---------------------------------

interface Resolved {
	value: unknown;
	source: Source;
	/** Set when no layer sets the setting itself: the setting its value comes from. */
	inheritedFrom?: string;
}

function resolveDef(def: SettingDef, resolution: Resolution): Resolved {
	const layers = PRECEDENCE.map((layer) => ({
		layer,
		status: resolution.layers[layer] ? def.status(resolution.layers[layer]) : ABSENT,
	}));
	let source: Source = "default";
	const blocking =
		def.onInvalid === "blocks" && layers.find(({ status }) => status.kind === "invalid");
	if (blocking) source = blocking.layer;
	else {
		const claimed = layers.find(
			({ status }) =>
				status.kind === "set" || (status.kind === "invalid" && def.onInvalid === "claims"),
		);
		if (claimed) source = claimed.layer;
	}
	const value = def.read(resolution.config);
	if (source === "default" && def.fallback) {
		const inherited = resolveDef(def.fallback, resolution);
		return {
			value,
			source: inherited.source,
			inheritedFrom: inherited.inheritedFrom ?? def.fallback.key,
		};
	}
	return { value, source };
}

const INVALID_TEXT: Record<SettingDef["onInvalid"], string> = {
	claims: "invalid value, treated as off",
	"falls-through": "invalid value, ignored",
	blocks: "invalid value",
};

const brief = (text: string, max = 60): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

function show(def: Pick<Target, "kind" | "policy">, value: unknown): string {
	if (def.policy) return summarizePolicy(def.policy, value);
	if (value === undefined) return "invalid";
	if (value === null) return "off";
	if (typeof value === "object") return brief(JSON.stringify(value));
	if (typeof value === "number" && def.kind === "tokens") return tokens(value);
	return String(value);
}

function layerSummary(def: SettingDef, snap: Snapshot, layer: Layer): string {
	if (layer === "project" && !snap.trusted) return "untrusted";
	const file = snap.files[layer];
	if (file.kind === "broken") return "file invalid";
	const parsed = snap.current.layers[layer];
	const status = parsed ? def.status(parsed) : ABSENT;
	if (status.kind === "invalid") return "invalid";
	if (file.kind !== "ok" || status.kind === "absent") return "unset";
	return show(def, rawOf(file.root, def).value);
}

/** The first layer whose value this setting rejected, with the parser's reason when it gave one. */
function invalidIn(def: SettingDef, snap: Snapshot): { layer: Layer; error?: string } | undefined {
	for (const layer of PRECEDENCE) {
		const parsed = snap.current.layers[layer];
		const status = parsed ? def.status(parsed) : ABSENT;
		if (status.kind === "invalid") return { layer, error: status.error };
	}
	return undefined;
}

// --- The screen ----------------------------------------------------------------

function shortPath(path: string, cwd: string): string {
	const home = homedir();
	if (path.startsWith(`${cwd}${sep}`)) return `.${path.slice(cwd.length)}`;
	if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
	return path;
}

function brokenNotice(snap: Snapshot, layer: Layer): string {
	const file = snap.files[layer];
	const reason = file.kind === "broken" ? file.reason : "is not usable";
	return `${capitalized(layer)} config at ${snap.paths[layer]} ${reason}. It is ignored and will not be edited here. Fix the file, then reopen /anchor settings.`;
}

/** Why edits to this layer are refused right now, or undefined when they may proceed. */
function targetProblem(snap: Snapshot, target: Layer): string | undefined {
	if (target === "project" && !snap.trusted) {
		return "This project is not trusted, so its tree-navigator.json is not read or edited.";
	}
	return snap.files[target].kind === "broken" ? brokenNotice(snap, target) : undefined;
}

function planFor(
	snap: Snapshot,
	target: Layer,
	staged: ReadonlyMap<string, Pending>,
): Plan | undefined {
	const file = snap.files[target];
	if (file.kind === "broken") return undefined;
	return planChanges(file.kind === "ok" ? file.root : {}, staged);
}

interface View {
	snap: Snapshot;
	target: Layer;
	staged: Map<string, Pending>;
	plan: Plan | undefined;
	preview: Resolution;
}

function settingRow(def: SettingDef, view: View): FrameRow {
	const { snap, target, staged, plan, preview } = view;
	const before = resolveDef(def, snap.current);
	const after = resolveDef(def, preview);
	const beforeText = show(def, before.value);
	const stagedValue = plan && staged.has(def.key) ? rawOf(plan.next, def) : undefined;
	const displayed =
		def.policy && stagedValue?.present
			? stagedValue.value
			: after.value === undefined && stagedValue?.present
				? stagedValue.value
				: after.value;
	const afterText = show(def, displayed);
	const edit = staged.get(def.key)?.edit;
	const isStaged = plan
		? plan.changes.some((change) => change.def.key === def.key)
		: edit !== undefined;
	const changed = beforeText !== afterText;
	const shadowed = isStaged && edit?.kind === "set" && after.source !== target;
	const invalid = invalidIn(def, snap);

	let detail = LAYERS.map((layer) => `${layer} ${layerSummary(def, snap, layer)}`).join(" · ");
	if (invalid) {
		detail = `${invalid.layer}: ${invalid.error ?? INVALID_TEXT[def.onInvalid]}`;
	}
	if (shadowed) {
		detail = `staged ${target} value is overridden by the ${after.source} scope`;
	} else if (!invalid && after.inheritedFrom !== undefined) {
		detail += ` · inherits ${after.inheritedFrom}`;
	}
	const inherited = after.inheritedFrom !== undefined && after.source !== "default";
	const warning = def.policy ? policyWarning(def.policy, displayed) : undefined;
	if (warning && !invalid && !shadowed) detail = warning;

	return {
		label: def.label ?? def.key,
		value: changed
			? `${beforeText} → ${afterText}`
			: `${afterText} · ${after.source}${inherited ? " (inherited)" : ""}`,
		tone:
			invalid || after.value === undefined
				? "warning"
				: isStaged || changed
					? "accent"
					: warning
						? "warning"
						: after.source === "default"
							? "muted"
							: "text",
		detail,
		description: def.description,
	};
}

function badgeOf(view: View): string {
	const { snap, target, staged, plan } = view;
	const pending = plan ? plan.changes.length : staged.size;
	const where = targetProblem(snap, target)
		? `target: ${target} · file invalid`
		: `target: ${target}`;
	return pending > 0 ? `${pending} staged · ${where}` : where;
}

/** Staged edits that touch `path` or anything below it. */
function stagedUnder(view: View, path: readonly KeyName[]): Target[] {
	const defs = view.plan
		? view.plan.changes.map((change) => change.def)
		: [...view.staged.values()].map((pending) => pending.def);
	return defs.filter((def) => isUnder(def.path, path));
}

function unstageUnder(staged: Map<string, Pending>, path: readonly KeyName[]): void {
	for (const [key, { def }] of staged) {
		if (isUnder(def.path, path)) staged.delete(key);
	}
}

/** True when the target file has a value to remove and its removal is not staged yet. */
function canReset(view: View, target: Target): boolean {
	const file = view.snap.files[view.target];
	return (
		file.kind === "ok" &&
		rawOf(file.root, target).present &&
		view.staged.get(target.key)?.edit.kind !== "reset"
	);
}

const otherLayer = (layer: Layer, trusted: boolean): Layer => {
	const available = LAYERS.filter((item) => item !== "project" || trusted);
	return available[(available.indexOf(layer) + 1) % available.length];
};

/** Why a layer's file cannot be read for entries, or undefined when it can. */
function unavailable(snap: Snapshot, layer: Layer): string | undefined {
	if (layer === "project" && !snap.trusted) return "untrusted";
	return snap.files[layer].kind === "broken" ? "file invalid" : undefined;
}

/** A layer's root as the loader sees it: empty when the file is missing, none when unusable. */
function readableRoot(snap: Snapshot, layer: Layer): Root | undefined {
	if (unavailable(snap, layer)) return undefined;
	const file = snap.files[layer];
	return file.kind === "ok" ? file.root : {};
}

/** The first layer whose copy of this map the parsers rejected. */
function problemIn(group: Group, snap: Snapshot): { layer: Layer; error: string } | undefined {
	for (const layer of PRECEDENCE) {
		const parsed = snap.current.layers[layer];
		const error = parsed ? group.problem(parsed) : undefined;
		if (error !== undefined) return { layer, error };
	}
	return undefined;
}

/** Entry names in file order, so a staged removal or addition never moves the other rows. */
function mapNames(view: View, path: readonly KeyName[]): string[] {
	const roots = [
		readableRoot(view.snap, view.target),
		view.plan?.next,
		...LAYERS.filter((layer) => layer !== view.target).map((layer) =>
			readableRoot(view.snap, layer),
		),
	];
	return [...new Set(roots.flatMap((root) => (root ? namesAt(root, path) : [])))];
}

function groupRow(group: Group, view: View): FrameRow {
	const { snap, target, plan } = view;
	const namesByLayer = (planned: boolean) =>
		Object.fromEntries(
			LAYERS.map((layer) => {
				const root = planned && layer === target && plan ? plan.next : readableRoot(snap, layer);
				return [layer, root && namesAt(root, group.path)];
			}),
		) as Record<Layer, string[] | undefined>;
	const before = namesByLayer(false);
	const after = namesByLayer(true);
	const total = (byLayer: Record<Layer, string[] | undefined>) =>
		new Set(LAYERS.flatMap((layer) => byLayer[layer] ?? [])).size;
	const [from, to] = [total(before), total(after)];
	const counted = (n: number) => (n === 0 ? "none" : `${n} ${group.unit[n === 1 ? 0 : 1]}`);
	const change = from === to ? counted(to) : `${from || "none"} → ${counted(to)}`;
	const sources = LAYERS.filter((layer) => (after[layer]?.length ?? 0) > 0);
	const source = sources.length > 1 ? sources.join(" + ") : (sources[0] ?? "default");
	const staged = stagedUnder(view, group.path).length;
	const problem = problemIn(group, snap);

	let detail = LAYERS.map(
		(layer) => `${layer} ${unavailable(snap, layer) ?? after[layer]?.length}`,
	).join(" · ");
	if (group.fallback) {
		const own = new Set(LAYERS.flatMap((layer) => after[layer] ?? []));
		const inherited = Object.keys(group.fallback.effective(view.preview.config) ?? {}).filter(
			(tool) => !own.has(tool),
		).length;
		if (inherited > 0) {
			detail += ` · inherits ${inherited} from ${group.fallback.key}`;
		}
	}
	if (staged > 0) detail = `${staged} staged · ${detail}`;
	if (problem) detail = `${problem.layer}: ${problem.error}`;

	return {
		label: group.label ?? group.key,
		value: `${change} · ${source}${staged > 0 ? ` · ${staged} staged` : ""}`,
		tone: problem ? "warning" : staged > 0 ? "accent" : to === 0 ? "muted" : "text",
		detail,
		description: group.description,
	};
}

const itemRow = (item: Item, view: View): FrameRow =>
	"def" in item ? settingRow(item.def, view) : groupRow(item.group, view);

const itemTarget = (item: Item): Target => ("def" in item ? item.def : mapTarget(item.group));

type Shortcut = NonNullable<FrameScreen["shortcuts"]>[number];

function buildScreen(
	view: View,
	items: readonly Item[],
	crumbs: readonly string[],
	cursor: number,
	top: boolean,
): FrameScreen {
	const { snap, target, plan, staged } = view;
	const at = (index: number): Target | undefined => {
		const item = items[index];
		return item && itemTarget(item);
	};
	const pending = plan ? plan.changes.length : staged.size;
	const shortcuts: Shortcut[] = [
		{
			key: "left",
			action: "decrease",
			enabled: (_row, index) => items[index] !== undefined && "def" in items[index],
		},
		{
			key: "right",
			action: "increase",
			enabled: (_row, index) => items[index] !== undefined && "def" in items[index],
		},
		{
			key: "backspace",
			action: "inherit",
			enabled: (_row, index) => {
				const found = at(index);
				return found !== undefined && canReset(view, found);
			},
		},
		{
			key: "u",
			action: "unstage",
			enabled: (_row, index) => {
				const found = at(index);
				return found !== undefined && stagedUnder(view, found.path).length > 0;
			},
		},
		{
			key: "d",
			action: "inherit",
			enabled: (_row, index) => {
				const found = at(index);
				return found !== undefined && canReset(view, found);
			},
		},
	];
	if (top) {
		shortcuts.unshift({
			key: "t",
			action: `to ${otherLayer(target, snap.trusted)}`,
		});
		shortcuts.push({
			key: "s",
			action: "save",
			priority: "essential",
			enabled: () => pending > 0,
		});
	}
	return {
		breadcrumbs: crumbs,
		rightBadge: badgeOf(view),
		placeholder: `Filter settings · file: ${shortPath(snap.paths[target], snap.cwd)}`,
		enterAction: "edit",
		rows: items.map((item) => itemRow(item, view)),
		cursor,
		shortcuts,
	};
}

// --- Input ---------------------------------------------------------------------

const OFF_WORDS = new Set(["off", "disabled", "disable", "none", "no", "false", "null"]);

/** `50k`, `1.5m`, `50,000`, `50 000`, `50_000` or `50000`; undefined when it is no whole number. */
function parseCount(text: string): number | undefined {
	const compact = text.toLowerCase().replace(/[\s_]/g, "");
	const match = /^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+)([km])?$/.exec(compact);
	if (!match) return undefined;
	const factor = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
	const value = Number(match[1].replace(/,/g, "")) * factor;
	const whole = Math.round(value);
	return Math.abs(value - whole) < 1e-6 ? whole : undefined;
}

function parseInput(def: SettingDef, text: string): unknown {
	const lower = text.toLowerCase();
	if (def.off && OFF_WORDS.has(lower)) return null;
	if (def.kind === "tokens" || def.kind === "count") return parseCount(text);
	if (def.kind === "share") return text.trim() === "" ? undefined : Number(text);
	const unquoted = text.replace(/^["']+|["']+$/g, "").trim();
	return def.kind === "model" && unquoted.toLowerCase() === "current" ? "current" : unquoted;
}

/** True when the real parsers accept `value` for this setting. */
function accepts(def: SettingDef, value: unknown): boolean {
	const probe: Root = {};
	setAt(probe, def.path, value, "camel");
	const parsed = parseTreeNavigatorConfig(probe);
	return parsed.kind === "fields" && def.status(parsed.layer).kind === "set";
}

async function promptEdit(
	ctx: ExtensionCommandContext,
	def: SettingDef,
	current: unknown,
	target: Layer,
	direction?: -1 | 1,
): Promise<Edit | undefined> {
	if (def.kind === "policy" && def.policy) {
		const value = await editPolicy(ctx, def.policy, current);
		if (value === undefined) return undefined;
		if (!accepts(def, value) && !policyAccepted(def.policy, value)) {
			ctx.ui.notify(`Invalid policy for ${def.key}. Use ${def.expects}.`, "warning");
			return undefined;
		}
		return { kind: "set", value };
	}
	const shown = show(def, current);
	if (def.kind === "flag") {
		return {
			kind: "set",
			value: direction === undefined ? shown !== "true" : direction === 1,
		};
	}
	if (
		direction !== undefined &&
		(def.kind === "tokens" || def.kind === "count" || def.kind === "share")
	) {
		const step = def.kind === "tokens" ? 1000 : def.kind === "share" ? 0.01 : 1;
		const before = shown === "off" ? 0 : def.kind === "share" ? Number(shown) : parseCount(shown);
		if (before === undefined) return undefined;
		const value =
			def.off && before + step * direction <= 0
				? null
				: def.kind === "share"
					? Math.round((before + step * direction) * 100) / 100
					: before + step * direction;
		if (accepts(def, value)) return { kind: "set", value };
		ctx.ui.notify(`Limit reached for ${def.key}. Use ${def.expects}.`, "warning");
		return undefined;
	}
	if (def.kind === "choice" && def.choices) {
		const next =
			def.choices[
				(def.choices.indexOf(shown) + (direction ?? 1) + def.choices.length) % def.choices.length
			];
		return { kind: "set", value: next };
	}
	if (def.kind === "model" || def.kind === "classifier") {
		const value = await pickSettingsModel(ctx, {
			kind: def.kind,
			current: shown === "off" ? null : shown,
		});
		if (value === undefined) return undefined;
		if (!accepts(def, value)) {
			ctx.ui.notify(`Invalid model selection for ${def.key}. Use ${def.expects}.`, "warning");
			return undefined;
		}
		return { kind: "set", value };
	}
	const input = await ctx.ui.input(`${def.key} (${target} scope)`, `now ${shown} · ${def.expects}`);
	const text = input?.trim();
	if (!text) return undefined;
	const value = parseInput(def, text);
	if (value === undefined || !accepts(def, value)) {
		ctx.ui.notify(`"${text}" is not valid for ${def.key}. Use ${def.expects}.`, "warning");
		return undefined;
	}
	return { kind: "set", value };
}

// --- Saving --------------------------------------------------------------------

async function writeAtomically(path: string, text: string): Promise<void> {
	const target = await realpath(path).catch(() => path);
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fsWriteFile(temp, text, { encoding: "utf8", flag: "wx" });
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

const isSetting = (def: Target): def is SettingDef => "read" in def;

const rawText = (def: Target, raw: Raw): string => (raw.present ? show(def, raw.value) : "unset");

function changeLines(changes: readonly Change[]): string {
	return changes
		.map(({ def, edit, before, after }) => {
			const to = edit.kind === "reset" ? "removed" : rawText(def, after);
			return `${def.key}: ${rawText(def, before)} → ${to}`;
		})
		.join("\n");
}

/** "written" when the file changed, "unchanged" when it already had the values, "kept" when nothing was saved. */
async function save(
	ctx: ExtensionCommandContext,
	deps: SettingsScreenDeps,
	target: Layer,
	staged: ReadonlyMap<string, Pending>,
): Promise<"written" | "unchanged" | "kept"> {
	const prepare = async () => {
		const snap = await readSnapshot(ctx, deps);
		let problem = targetProblem(snap, target);
		const file = snap.files[target];
		if (!problem && file.kind === "ok") {
			for (const { def, edit } of staged.values()) {
				const blocked = edit.kind === "set" ? blockedBy(file.root, def.path) : undefined;
				if (blocked) {
					problem = `${blocked} is no longer an object. Nothing was saved; reopen settings before editing ${def.key}.`;
					break;
				}
			}
		}
		const plan = problem ? undefined : planFor(snap, target, staged);
		return { snap, problem, plan };
	};
	const first = await prepare();
	if (first.problem !== undefined || !first.plan) {
		ctx.ui.notify(first.problem ?? "Nothing to save.", "warning");
		return "kept";
	}
	const path = first.snap.paths[target];
	if (first.plan.changes.length === 0) {
		ctx.ui.notify(`Nothing to save: ${path} already has these values.`, "info");
		return "unchanged";
	}
	const { changes } = first.plan;
	const confirmed = await ctx.ui.confirm(
		`Save ${changes.length} ${changes.length === 1 ? "change" : "changes"} to the ${target} config?`,
		`${path}\n\n${changeLines(changes)}\n\nAll other keys stay as they are.`,
	);
	if (!confirmed) return "kept";

	// The file may have changed while the dialog was open: write onto what is there now.
	const final = await prepare();
	if (final.problem !== undefined || !final.plan) {
		ctx.ui.notify(final.problem ?? "Nothing to save.", "warning");
		return "kept";
	}
	try {
		if (target === "runtime")
			writeRuntimeConfig(ctx.sessionManager.getSessionId(), final.plan.next);
		else await (deps.writeFile ?? writeAtomically)(path, serialize(final.plan.next));
	} catch (error) {
		ctx.ui.notify(
			`Could not write ${path}: ${messageOf(error)}. The file was not changed.`,
			"error",
		);
		return "kept";
	}
	try {
		await deps.onSaved?.(ctx);
	} catch (error) {
		ctx.ui.notify(
			`Settings were saved, but live refresh failed: ${messageOf(error)}. Run /reload to restore file settings; runtime values will be cleared.`,
			"error",
		);
		return "written";
	}
	ctx.ui.notify(
		`Saved ${changes.length} ${changes.length === 1 ? "setting" : "settings"} to ${path}.${deps.onSaved ? " Applied to this session." : ""}`,
		"info",
	);
	const saved = await readSnapshot(ctx, deps);
	const overridden = changes.filter(
		({ def, edit }) =>
			edit.kind === "set" && isSetting(def) && resolveDef(def, saved.current).source !== target,
	);
	if (overridden.length > 0) {
		ctx.ui.notify(
			`Still overridden: ${overridden.map(({ def }) => `${def.key} (${isSetting(def) ? resolveDef(def, saved.current).source : "higher scope"})`).join(", ")}.`,
			"warning",
		);
	}
	return "written";
}

/** Pick a save scope without changing the staged edits. */
async function saveScope(
	ctx: ExtensionCommandContext,
	target: Layer,
	trusted: boolean,
): Promise<Layer | undefined> {
	const scopes = LAYERS.filter((layer) => layer !== "project" || trusted);
	const choice = await selectFrame(ctx, {
		breadcrumbs: ["Anchor", "Settings", "Save"],
		cursor: scopes.indexOf(target),
		enterAction: "choose",
		rows: scopes.map((layer) => ({
			label: layer,
			description:
				layer === "runtime"
					? "Apply only to this session. No file is written; reload or switching sessions clears it."
					: `Merge into the ${layer} file and apply now. Other keys are preserved.`,
		})),
		shortcuts: [
			{ key: "u", action: "global" },
			...(trusted ? [{ key: "p" as const, action: "project" }] : []),
			{ key: "r", action: "runtime" },
		],
	});
	return !choice
		? undefined
		: choice.key === "u"
			? "global"
			: choice.key === "p"
				? "project"
				: choice.key === "r"
					? "runtime"
					: scopes[choice.index];
}

// --- The loop ------------------------------------------------------------------

/** Human-readable effective settings for non-interactive commands. */
export async function describeSettings(
	ctx: ExtensionCommandContext,
	deps: SettingsScreenDeps,
): Promise<string> {
	const snap = await readSnapshot(ctx, deps);
	const lines = SETTINGS.map((def) => {
		const { value, source } = resolveDef(def, snap.current);
		return `${def.key}: ${show(def, value)} (${source})`;
	});
	return [
		"Anchor settings",
		...lines,
		`Global: ${snap.paths.global}`,
		...[PROPOSAL_TOOLS, AUTO_TOOLS].flatMap((group) =>
			Object.keys(group.effective(snap.current.config) ?? {}).map((tool) => {
				const def = toolDef(group, tool);
				const { value, source } = resolveDef(def, snap.current);
				return `${def.key}: ${show(def, value)} (${source})`;
			}),
		),
		...[
			...new Set(
				LAYERS.flatMap((layer) => namesAt(readableRoot(snap, layer) ?? {}, [MODEL_OVERRIDES])),
			),
		].flatMap((pattern) => [
			...entrySettings(pattern).map((def) => {
				const { value, source } = resolveDef(def, snap.current);
				return `${def.key}: ${show(def, value)} (${source})`;
			}),
			...Object.keys(overrideTools(pattern).effective(snap.current.config) ?? {}).map((tool) => {
				const def = toolDef(overrideTools(pattern), tool);
				const { value, source } = resolveDef(def, snap.current);
				return `${def.key}: ${show(def, value)} (${source})`;
			}),
		]),
		`Project: ${snap.paths.project}${snap.trusted ? "" : " (untrusted, ignored)"}`,
		`Runtime: ${snap.paths.runtime}`,
	].join("\n");
}

/** What the screens share while one `/anchor settings` command runs. */
interface Session {
	ctx: ExtensionCommandContext;
	deps: SettingsScreenDeps;
	staged: Map<string, Pending>;
	warned: Set<Layer>;
	target: Layer;
}

/** Edit tree-navigator.json settings in staged changes until the user leaves. */
export async function openSettingsScreen(
	ctx: ExtensionCommandContext,
	deps: SettingsScreenDeps,
): Promise<ScreenExit> {
	const session: Session = {
		ctx,
		deps,
		staged: new Map(),
		warned: new Set(),
		target: "global",
	};
	return itemsScreen(session, ["Anchor", "Settings"], ITEMS, true);
}

/** Reads the files again, so every screen shows what is on disk plus the staged edits. */
async function loadView(session: Session): Promise<View> {
	const { ctx, deps, staged } = session;
	const snap = await readSnapshot(ctx, deps);
	for (const layer of LAYERS) {
		if (snap.files[layer].kind === "broken" && !session.warned.has(layer)) {
			session.warned.add(layer);
			ctx.ui.notify(brokenNotice(snap, layer), "warning");
		}
	}
	if (session.target === "project" && !snap.trusted) session.target = "global";
	const target = session.target;
	const plan = planFor(snap, target, staged);
	const preview =
		plan && plan.changes.length > 0
			? await resolve(snap.paths, snap.trusted, {
					global: textOf(snap.files.global),
					project: textOf(snap.files.project),
					runtime: textOf(snap.files.runtime),
					[target]: serialize(plan.next),
				})
			: snap.current;
	return { snap, target, staged, plan, preview };
}

/** A list of settings and keyed maps. Only the top one switches layers and saves. */
async function itemsScreen(
	session: Session,
	crumbs: readonly string[],
	items: readonly Item[],
	top: boolean,
): Promise<ScreenExit> {
	const { ctx, deps, staged } = session;
	let cursor = 0;
	while (true) {
		const view = await loadView(session);
		const { snap, plan, target } = view;
		const pending = plan ? plan.changes.length : staged.size;

		const choice = await selectFrame(ctx, buildScreen(view, items, crumbs, cursor, top));
		if (!choice) {
			if (!top || pending === 0) return "back";
			const discard = await ctx.ui.confirm(
				"Discard staged changes?",
				`${pending} staged ${pending === 1 ? "change has" : "changes have"} not been saved.`,
			);
			if (discard) return "back";
			continue;
		}
		cursor = choice.index;
		const item = items[choice.index];

		if (choice.key === "t") {
			session.target = otherLayer(target, snap.trusted);
		} else if (choice.key === "s") {
			const scope = await saveScope(ctx, target, snap.trusted);
			if (scope === undefined) continue;
			session.target = scope;
			const saved = await save(ctx, deps, scope, staged);
			if (saved !== "kept") staged.clear();
		} else if (choice.key === "u") {
			unstageUnder(staged, itemTarget(item).path);
		} else if (choice.key === "d" || choice.key === "backspace") {
			await removeEntry(session, view, itemTarget(item));
		} else if ("group" in item) {
			if (usable(ctx, snap, target)) {
				await item.group.open(session, [...crumbs, item.group.label ?? item.group.key]);
			}
		} else if (usable(ctx, snap, target)) {
			const targetValue = plan ? rawOf(plan.next, item.def) : { present: false };
			const edit = await promptEdit(
				ctx,
				item.def,
				targetValue.present ? targetValue.value : resolveDef(item.def, view.preview).value,
				target,
				choice.key === "left" ? -1 : choice.key === "right" ? 1 : undefined,
			);
			if (edit) stage(ctx, snap, target, staged, item.def, edit);
		}
	}
}

/** True when edits to the target layer may proceed; otherwise says why not. */
function usable(ctx: ExtensionCommandContext, snap: Snapshot, target: Layer): boolean {
	const problem = targetProblem(snap, target);
	if (problem !== undefined) ctx.ui.notify(problem, "warning");
	return problem === undefined;
}

/** Stage the removal of a setting, entry or whole map; a non-empty map or entry needs a yes first. */
async function removeEntry(session: Session, view: View, target: Target): Promise<void> {
	const { ctx } = session;
	if (target.kind === "map") {
		const raw = view.plan ? rawOf(view.plan.next, target) : { present: false };
		const empty = !raw.present || (isRoot(raw.value) && Object.keys(raw.value).length === 0);
		if (!empty) {
			const confirmed = await ctx.ui.confirm(
				`Remove ${target.key}?`,
				`${brief(JSON.stringify(raw.value), 300)}\n\nThis stages the removal from the ${view.target} file. Nothing is written until you save.`,
			);
			if (!confirmed) return;
		}
	}
	stage(ctx, view.snap, view.target, view.staged, target, { kind: "reset" });
}

/** Stage an edit, or say why nothing is staged. */
function stage(
	ctx: ExtensionCommandContext,
	snap: Snapshot,
	target: Layer,
	staged: Map<string, Pending>,
	def: Target,
	edit: Edit,
): void {
	const problem = targetProblem(snap, target);
	if (problem !== undefined) {
		ctx.ui.notify(problem, "warning");
		return;
	}
	const removal = [...staged.values()].find(
		(pending) =>
			pending.edit.kind === "reset" &&
			pending.def.key !== def.key &&
			isUnder(def.path, pending.def.path),
	);
	if (removal) {
		ctx.ui.notify(
			`${removal.def.key} is staged for removal. Unstage it (u) before editing inside it.`,
			"warning",
		);
		return;
	}
	const file = snap.files[target];
	const root = file.kind === "ok" ? file.root : {};
	const blocked = def.structured && edit.kind === "set" ? blockedBy(root, def.path) : undefined;
	if (blocked !== undefined) {
		ctx.ui.notify(
			`${blocked} in the ${target} file is not an object, so ${def.key} cannot be edited there. Remove ${blocked} (d) first.`,
			"warning",
		);
		return;
	}
	const plan = planChanges(root, new Map([[def.key, { def, edit }]]));
	if (edit.kind === "reset") unstageUnder(staged, def.path);
	if (plan.changes.length === 0) {
		staged.delete(def.key);
		ctx.ui.notify(
			edit.kind === "reset"
				? `No change: ${def.key} is not set in the ${target} file.`
				: `No change: the ${target} file already has this value for ${def.key}.`,
			"info",
		);
		return;
	}
	staged.set(def.key, { def, edit });
}

// --- Keyed-map submenus -----------------------------------------------------------

/** Tool names the group lists in either file, or inherits from the policy behind it. */
const toolNames = (view: View, group: ToolsGroup): string[] => [
	...new Set([
		...mapNames(view, group.path),
		...Object.keys(group.effective(view.preview.config) ?? {}),
	]),
];

async function chooseMode(session: Session, view: View, def: SettingDef): Promise<void> {
	const { ctx } = session;
	if (!usable(ctx, view.snap, view.target)) return;
	const mode = await ctx.ui.select(`${def.key} (${view.target} file)`, [...TOOL_MODES]);
	if (!mode) return;
	if (!accepts(def, mode)) {
		ctx.ui.notify(`"${mode}" is not valid for ${def.key}. Use ${def.expects}.`, "warning");
		return;
	}
	stage(ctx, view.snap, view.target, view.staged, def, {
		kind: "set",
		value: mode,
	});
}

/** Exact tool names mapped to full, calls-only or omit, for one policy map. */
async function editTools(
	session: Session,
	group: ToolsGroup,
	crumbs: readonly string[],
): Promise<void> {
	const { ctx } = session;
	let cursor = 0;
	while (true) {
		const view = await loadView(session);
		const defs = toolNames(view, group).map((tool) => toolDef(group, tool));
		const choice = await selectFrame(ctx, {
			breadcrumbs: crumbs,
			rightBadge: badgeOf(view),
			placeholder: `Filter tools · file: ${shortPath(view.snap.paths[view.target], view.snap.cwd)}`,
			enterAction: "set",
			cursor,
			rows: [
				...defs.map((def) => settingRow(def, view)),
				{
					label: "+ add tool",
					description: "Add a tool by exact name, then pick its mode.",
				},
			],
			shortcuts: [
				{ key: "a", action: "add" },
				{
					key: "u",
					action: "unstage",
					enabled: (_row, index) =>
						index < defs.length && stagedUnder(view, defs[index].path).length > 0,
				},
				{
					key: "d",
					action: "remove",
					enabled: (_row, index) => index < defs.length && canReset(view, defs[index]),
				},
			],
		});
		if (!choice) return;
		cursor = choice.index;
		const def = defs[choice.index];

		if (choice.key === "u") {
			unstageUnder(view.staged, def.path);
		} else if (choice.key === "d") {
			stage(ctx, view.snap, view.target, view.staged, def, { kind: "reset" });
		} else if (def && choice.key !== "a") {
			await chooseMode(session, view, def);
		} else if (usable(ctx, view.snap, view.target)) {
			const input = await ctx.ui.input(
				`${group.label ?? group.key} (${view.target} file)`,
				"exact tool name, e.g. bash",
			);
			const tool = input?.trim();
			if (tool) await chooseMode(session, view, toolDef(group, tool));
		}
	}
}

/** One short line of what an override entry sets in this file. */
function entrySummary(pattern: string, root: Root): string {
	const parts = entrySettings(pattern).flatMap((def) => {
		const raw = rawOf(root, def);
		if (!raw.present) return [];
		const last = def.path[def.path.length - 1].snake;
		const name = last === BASE_RESERVE.path[0].snake ? "reserve" : last;
		return [`${name} ${show(def, raw.value)}`];
	});
	const tools = namesAt(root, overrideTools(pattern).path).length;
	if (tools > 0) parts.push(`tools ${tools}`);
	return parts.join(", ") || "empty";
}

function entryRow(pattern: string, view: View): FrameRow {
	const { snap, target, plan, staged } = view;
	const entry = entryTarget(pattern);
	const planned = plan ? rawOf(plan.next, entry) : { present: false };
	const file = snap.files[target];
	const existed = file.kind === "ok" && rawOf(file.root, entry).present;
	const removed = staged.get(entry.key)?.edit.kind === "reset";
	const changes = stagedUnder(view, entry.path).length;

	let problem: { layer: Layer; error: string } | undefined;
	for (const layer of PRECEDENCE) {
		const parsed = snap.current.layers[layer];
		const error = parsed && entryProblem(parsed, pattern);
		if (error && !problem) problem = { layer, error };
	}

	let value: string;
	if (removed) value = "removed · staged";
	else if (!planned.present) value = `not in ${target} file`;
	else if (!isRoot(planned.value)) value = "not an object";
	else value = entrySummary(pattern, plan ? plan.next : {});
	if (changes > 0 && !removed) value += existed ? " · edited" : " · new";

	const layers = LAYERS.map((layer) => {
		const root = readableRoot(snap, layer);
		const raw = root ? rawOf(root, entry) : { present: false };
		const text =
			unavailable(snap, layer) ??
			(!raw.present
				? "none"
				: isRoot(raw.value)
					? `${Object.keys(raw.value).length} set`
					: "not an object");
		return `${layer} ${text}`;
	}).join(" · ");

	return {
		label: pattern,
		value,
		tone: problem ? "warning" : changes > 0 ? "accent" : "text",
		detail: problem ? `${problem.layer}: ${problem.error}` : layers,
		description:
			"Enter edits this model's reserve and auto_navigate settings; d removes the entry from the target file.",
	};
}

/** Model patterns (provider/model, wildcards or bare ids) with their per-model settings. */
async function editOverrides(session: Session, crumbs: readonly string[]): Promise<void> {
	const { ctx } = session;
	let cursor = 0;
	while (true) {
		const view = await loadView(session);
		const patterns = mapNames(view, OVERRIDES.path);
		const choice = await selectFrame(ctx, {
			breadcrumbs: crumbs,
			rightBadge: badgeOf(view),
			placeholder: `Filter models · file: ${shortPath(view.snap.paths[view.target], view.snap.cwd)}`,
			enterAction: "edit",
			cursor,
			rows: [
				...patterns.map((pattern) => entryRow(pattern, view)),
				{
					label: "+ add model",
					description:
						"Add a provider/model, a wildcard such as openrouter/* or *gemini*, or a bare model id.",
				},
			],
			shortcuts: [
				{ key: "a", action: "add" },
				{
					key: "u",
					action: "unstage",
					enabled: (_row, index) =>
						index < patterns.length &&
						stagedUnder(view, entryTarget(patterns[index]).path).length > 0,
				},
				{
					key: "d",
					action: "remove",
					enabled: (_row, index) =>
						index < patterns.length && canReset(view, entryTarget(patterns[index])),
				},
			],
		});
		if (!choice) return;
		cursor = choice.index;
		const existing = patterns[choice.index];

		if (choice.key === "u") {
			unstageUnder(view.staged, entryTarget(existing).path);
		} else if (choice.key === "d") {
			await removeEntry(session, view, entryTarget(existing));
		} else if (!usable(ctx, view.snap, view.target)) {
		} else {
			let pattern: string | undefined = existing;
			if (pattern === undefined || choice.key === "a") {
				const input = await ctx.ui.input(
					`${OVERRIDES.key} (${view.target} file)`,
					"provider/model, a wildcard like openrouter/* or *gemini*, or a bare model id",
				);
				pattern = input?.trim();
				if (pattern && /\s/.test(pattern)) {
					ctx.ui.notify(
						`"${pattern}" is not a model pattern: it contains whitespace. Use provider/model or a wildcard such as openrouter/*.`,
						"warning",
					);
					pattern = undefined;
				}
			}
			if (!pattern) continue;
			const entry = entryTarget(pattern);
			if (view.staged.get(entry.key)?.edit.kind === "reset") {
				ctx.ui.notify(
					`${entry.key} is staged for removal. Unstage it (u) to edit it again.`,
					"warning",
				);
				continue;
			}
			await itemsScreen(session, [...crumbs, pattern], entryItems(pattern), false);
		}
	}
}
