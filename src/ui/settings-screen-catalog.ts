/** Scalar settings and their parser-backed rules. */

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
	type ParsedLayer,
	REWIND_HINT_MAX_RESERVE,
	REWIND_HINT_MIN_RESERVE,
	resolveAutoNavigateConfig,
	START_ANCHOR_MAX_TURNS,
	START_ANCHOR_MIN_TURNS,
} from "../core/config.ts";
import {
	ABSENT,
	AUTO_NAVIGATE,
	CONTINUITY,
	type Loaded,
	name,
	SET,
	type SettingDef,
	type Status,
	TREE_PROPOSAL,
} from "./settings-screen-types.ts";

const count = (n: number): string => n.toLocaleString("en-US");
const range = (min: number, max: number): string => `${count(min)}-${count(max)}`;

/** `50k`, `1.5M`, or the plain number when it has no short form. */
export function tokens(n: number): string {
	if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
	if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}k`;
	return count(n);
}

export const fieldStatus = (field: { kind: "absent" | "ok" | "disabled" | "invalid" }): Status =>
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

export const autoRead = (config: Loaded) => resolveAutoNavigateConfig(config, undefined);

const TOKEN_RANGE = range(AUTO_NAVIGATE_MIN_TOKENS, AUTO_NAVIGATE_MAX_TOKENS);
const KEEP_RECENT_SHARE_RANGE = range(
	AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE,
	AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE,
);

/** The reserve definition shared by the root catalog and per-model overrides. */
export const BASE_RESERVE: SettingDef = {
	key: "rewindHintReserveTokens",
	path: [name("rewindHintReserveTokens", "rewind_hint_reserve_tokens")],
	kind: "tokens",
	off: true,
	onInvalid: "claims",
	expects: `${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)} tokens (e.g. 50k), or off`,
	description: `Nudge the agent to rewind when this many tokens are left in the window. ${range(REWIND_HINT_MIN_RESERVE, REWIND_HINT_MAX_RESERVE)}, or off (default).`,
	status: (layer) => fieldStatus(layer.hint),
	read: (config) => config.rewindHintReserveTokens,
};

export const SETTINGS: readonly SettingDef[] = [
	BASE_RESERVE,
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
