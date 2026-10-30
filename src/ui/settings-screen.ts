/**
 * `/anchor settings`: staged editor for `tree-navigator.json`.
 *
 * Edits are staged in memory against one target layer and applied or written
 * only on save, after a confirmation. Effective values come from the
 * real loader (`loadTreeNavigatorConfig`) and every candidate value is checked
 * with the real parsers (`parseTreeNavigatorConfig`), so the screen cannot
 * accept a value that the next session start would reject. A file that does
 * not parse as a JSON object is never written.
 *
 * The keyed maps (`treeProposal.tools`, `auto_navigate.tools` and
 * `model_overrides`, with their nested tool policies) open as submenus. Each
 * entry stages the same way a scalar does, addressed by its own path.
 */

import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { TREE_NAVIGATOR_CONFIG_FILENAME } from "../core/config.ts";
import { selectFrame } from "./frame.ts";
import { SETTINGS } from "./settings-screen-catalog.ts";
import {
	accepts,
	loadView,
	promptEdit,
	removeEntry,
	type Session,
	stage,
	usable,
} from "./settings-screen-editing.ts";
import { readSnapshot, resolveDef, show } from "./settings-screen-layers.ts";
import {
	AUTO_TOOLS,
	entryItems,
	entrySettings,
	entryTarget,
	ITEMS,
	type Item,
	isToolsGroup,
	MODEL_OVERRIDES,
	OVERRIDES,
	overrideTools,
	PROPOSAL_TOOLS,
	TOOL_MODES,
	type ToolsGroup,
	toolDef,
} from "./settings-screen-maps.ts";
import { namesAt, rawOf } from "./settings-screen-raw.ts";
import {
	badgeOf,
	buildScreen,
	canReset,
	entryRow,
	itemTarget,
	mapNames,
	otherLayer,
	readableRoot,
	SETTINGS_ACTIONS,
	settingRow,
	shortPath,
	stagedUnder,
	unstageUnder,
	type View,
} from "./settings-screen-rows.ts";
import { save, saveScope } from "./settings-screen-saving.ts";
import {
	LAYERS,
	type ScreenExit,
	type SettingDef,
	type SettingsAccess,
} from "./settings-screen-types.ts";

/** Where the two config files live for the session and whether the project layer counts. */
export interface SettingsScreenDeps extends SettingsAccess {}

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
		...(deps.automaticFolding
			? [
					`Automatic folding: ${deps.automaticFolding.isPaused(ctx) ? "paused" : "active"} (Session only)`,
				]
			: []),
	].join("\n");
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
		target: "runtime",
	};
	return itemsScreen(session, ["Anchor", "Settings"], ITEMS, true);
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
		const pending = staged.size;
		const paused = top ? deps.automaticFolding?.isPaused(ctx) : undefined;

		const choice = await selectFrame(ctx, buildScreen(view, items, crumbs, cursor, top, paused));
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
		const action =
			top && choice.key === undefined ? SETTINGS_ACTIONS[choice.index - items.length] : undefined;

		if (choice.key === "t") {
			session.target = otherLayer(target, snap.trusted);
			continue;
		}
		if (action === "scope") {
			const scope = await saveScope(ctx, target, snap.trusted, "Scope");
			if (scope !== undefined) session.target = scope;
			continue;
		}
		if (action === "folding" && deps.automaticFolding) {
			deps.automaticFolding.setPaused(ctx, !deps.automaticFolding.isPaused(ctx));
			continue;
		}
		if (choice.key === "s" || action === "save") {
			if (pending === 0) {
				ctx.ui.notify("No staged changes to apply or save.", "info");
				continue;
			}
			const scope = choice.key === "s" ? await saveScope(ctx, target, snap.trusted) : target;
			if (scope === undefined) continue;
			session.target = scope;
			const saved = await save(ctx, deps, scope, staged);
			if (saved !== "kept") staged.clear();
			continue;
		}

		const item = items[choice.index];
		if (item === undefined) continue;
		if (choice.key === "u") {
			unstageUnder(staged, itemTarget(item).path);
		} else if (choice.key === "d" || choice.key === "backspace") {
			await removeEntry(session, view, itemTarget(item));
		} else if ("group" in item) {
			if (usable(ctx, snap, target)) {
				const crumbsNext = [...crumbs, item.group.label ?? item.group.key];
				if (isToolsGroup(item.group)) await editTools(session, item.group, crumbsNext);
				else await editOverrides(session, crumbsNext);
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

// --- Keyed-map submenus -----------------------------------------------------------

const targetName = (view: View): string =>
	view.target === "runtime" ? "Session" : `${view.target} file`;

const targetDetail = (view: View): string =>
	view.target === "runtime"
		? "Session only"
		: `file: ${shortPath(view.snap.paths[view.target], view.snap.cwd)}`;

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
	const mode = await ctx.ui.select(`${def.key} (${targetName(view)})`, [...TOOL_MODES]);
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
			placeholder: `Filter tools · ${targetDetail(view)}`,
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
					enabled: (_row, index) => {
						const def = defs[index];
						return def !== undefined && stagedUnder(view, def.path).length > 0;
					},
				},
				{
					key: "d",
					action: "remove",
					enabled: (_row, index) => {
						const def = defs[index];
						return def !== undefined && canReset(view, def);
					},
				},
			],
		});
		if (!choice) return;
		cursor = choice.index;
		const def = defs[choice.index];

		if (choice.key === "u" && def) {
			unstageUnder(view.staged, def.path);
		} else if (choice.key === "d" && def) {
			stage(ctx, view.snap, view.target, view.staged, def, { kind: "reset" });
		} else if (def && choice.key !== "a") {
			await chooseMode(session, view, def);
		} else if (usable(ctx, view.snap, view.target)) {
			const input = await ctx.ui.input(
				`${group.label ?? group.key} (${targetName(view)})`,
				"exact tool name, e.g. bash",
			);
			const tool = input?.trim();
			if (tool) await chooseMode(session, view, toolDef(group, tool));
		}
	}
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
			placeholder: `Filter models · ${targetDetail(view)}`,
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
					enabled: (_row, index) => {
						const pattern = patterns[index];
						return pattern !== undefined && stagedUnder(view, entryTarget(pattern).path).length > 0;
					},
				},
				{
					key: "d",
					action: "remove",
					enabled: (_row, index) => {
						const pattern = patterns[index];
						return pattern !== undefined && canReset(view, entryTarget(pattern));
					},
				},
			],
		});
		if (!choice) return;
		cursor = choice.index;
		const existing = patterns[choice.index];

		if (choice.key === "u" && existing !== undefined) {
			unstageUnder(view.staged, entryTarget(existing).path);
		} else if (choice.key === "d" && existing !== undefined) {
			await removeEntry(session, view, entryTarget(existing));
		} else if (!usable(ctx, view.snap, view.target)) {
		} else {
			let pattern: string | undefined = existing;
			if (pattern === undefined || choice.key === "a") {
				const input = await ctx.ui.input(
					`${OVERRIDES.key} (${targetName(view)})`,
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
