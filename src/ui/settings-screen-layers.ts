/** Config snapshots and effective values through the real loader and parsers. */

import { readFile as fsReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	loadTreeNavigatorConfig,
	type ParsedLayer,
	parseTreeNavigatorConfig,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "../core/config.ts";
import { readRuntimeConfig } from "../core/runtime-config.ts";
import { summarizePolicy } from "./policy-settings.ts";
import { tokens } from "./settings-screen-catalog.ts";
import { isEnoent, isRoot, messageOf, rawOf, serialize } from "./settings-screen-raw.ts";
import {
	ABSENT,
	type Layer,
	type Loaded,
	PRECEDENCE,
	type Root,
	type SettingDef,
	type SettingsAccess,
	type Source,
	type Target,
} from "./settings-screen-types.ts";

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

export interface Resolution {
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

export interface Snapshot {
	cwd: string;
	paths: Record<Layer, string>;
	trusted: boolean;
	files: Record<Layer, FileState>;
	current: Resolution;
}

export const textOf = (file: FileState): string | undefined =>
	file.kind === "missing" ? undefined : file.text;

/** Runs the real loader over in-memory texts, so values match what a session would load. */
export async function resolve(
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

export async function readSnapshot(
	ctx: ExtensionCommandContext,
	deps: SettingsAccess,
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

export function resolveDef(def: SettingDef, resolution: Resolution): Resolved {
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

export const INVALID_TEXT: Record<SettingDef["onInvalid"], string> = {
	claims: "invalid value, treated as off",
	"falls-through": "invalid value, ignored",
	blocks: "invalid value",
};

export const brief = (text: string, max = 60): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function show(def: Pick<Target, "kind" | "policy">, value: unknown): string {
	if (def.policy) return summarizePolicy(def.policy, value);
	if (value === undefined) return "invalid";
	if (value === null) return "off";
	if (typeof value === "object") return brief(JSON.stringify(value));
	if (typeof value === "number" && def.kind === "tokens") return tokens(value);
	return String(value);
}

export function layerSummary(def: SettingDef, snap: Snapshot, layer: Layer): string {
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
export function invalidIn(
	def: SettingDef,
	snap: Snapshot,
): { layer: Layer; error?: string | undefined } | undefined {
	for (const layer of PRECEDENCE) {
		const parsed = snap.current.layers[layer];
		const status = parsed ? def.status(parsed) : ABSENT;
		if (status.kind === "invalid") return { layer, error: status.error };
	}
	return undefined;
}
