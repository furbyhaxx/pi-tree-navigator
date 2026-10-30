/** Settings editor contracts, key spellings and target types. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { loadTreeNavigatorConfig, ParsedLayer } from "../core/config.ts";
import type { PolicyKind } from "./policy-settings.ts";

export interface SettingsAccess {
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
	/** Session-only automatic-fold gate; recovery, capture and manual folds remain active. */
	automaticFolding?: {
		isPaused(ctx: ExtensionCommandContext): boolean;
		setPaused(ctx: ExtensionCommandContext, paused: boolean): void;
	};
}

/** "done" ends the whole command; "back" returns to the screen that opened this one. */
export type ScreenExit = "back" | "done";

export const LAYERS = ["global", "project", "runtime"] as const;
export const PRECEDENCE = ["runtime", "project", "global"] as const;
export type Layer = (typeof LAYERS)[number];
export type Source = Layer | "default";
export type Root = Record<string, unknown>;
export type Style = "camel" | "snake";
export type Loaded = Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"];

/** One key as the file may spell it. Snake_case wins when both exist, as in config.ts. */
export interface KeyName {
	camel: string;
	snake: string;
	/** Spelling for a new key regardless of the file's style. */
	fresh?: Style;
	/** `auto_navigate: true` means `{ enabled: true }`; this is the key it stands for. */
	shorthand?: string;
}

export const name = (camel: string, snake = camel): KeyName => ({ camel, snake });
export const CONTINUITY = name("continuity");
export const TREE_PROPOSAL = name("treeProposal", "tree_proposal");
export const AUTO_NAVIGATE: KeyName = {
	camel: "autoNavigate",
	snake: "auto_navigate",
	fresh: "snake",
	shorthand: "enabled",
};

export type Status = { kind: "absent" } | { kind: "set" } | { kind: "invalid"; error?: string };
export const ABSENT: Status = { kind: "absent" };
export const SET: Status = { kind: "set" };

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
export interface Target {
	/** Identity in the staged map: the key as the README spells it, unique per path. */
	key: string;
	path: readonly KeyName[];
	kind: Kind;
	/** Part of a keyed map: edits refuse to replace a non-object on the way down. */
	structured?: boolean;
	/** Classifier policy edited by the structured editor, not as raw JSON. */
	policy?: PolicyKind;
}

export interface SettingDef extends Target {
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
