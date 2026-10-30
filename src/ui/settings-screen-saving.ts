/** Confirmed settings persistence and explicit save-scope selection. */

import { writeFile as fsWriteFile, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeRuntimeConfig } from "../core/runtime-config.ts";
import { selectFrame } from "./frame.ts";
import { readSnapshot, resolveDef, show } from "./settings-screen-layers.ts";
import {
	blockedBy,
	type Change,
	messageOf,
	type Pending,
	type Raw,
	serialize,
} from "./settings-screen-raw.ts";
import { planFor, scopeLabel, targetProblem } from "./settings-screen-rows.ts";
import {
	LAYERS,
	type Layer,
	type SettingDef,
	type SettingsAccess,
	type Target,
} from "./settings-screen-types.ts";

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
export async function save(
	ctx: ExtensionCommandContext,
	deps: SettingsAccess,
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
		ctx.ui.notify(
			target === "runtime"
				? "Nothing to apply: Session already has these values."
				: `Nothing to save: ${path} already has these values.`,
			"info",
		);
		return "unchanged";
	}
	const { changes } = first.plan;
	const count = `${changes.length} ${changes.length === 1 ? "change" : "changes"}`;
	const confirmed = await ctx.ui.confirm(
		target === "runtime"
			? `Apply ${count} to this Session?`
			: `Save ${count} to the ${target} config?`,
		target === "runtime"
			? `${changeLines(changes)}\n\nNo file is written; reload or switching sessions clears these changes. All other settings stay as they are.`
			: `${path}\n\n${changeLines(changes)}\n\nAll other keys stay as they are.`,
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
	const applied = deps.onSaved ? " Applied to this session." : "";
	ctx.ui.notify(
		target === "runtime"
			? `Saved ${count} to Session memory.${applied} No file was written; reload or switching sessions clears it.`
			: `Saved ${changes.length} ${changes.length === 1 ? "setting" : "settings"} to ${path}.${applied}`,
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
export async function saveScope(
	ctx: ExtensionCommandContext,
	target: Layer,
	trusted: boolean,
	title: "Save" | "Scope" = "Save",
): Promise<Layer | undefined> {
	const scopes = LAYERS.filter((layer) => layer !== "project" || trusted);
	const choice = await selectFrame(ctx, {
		breadcrumbs: ["Anchor", "Settings", title],
		cursor: scopes.indexOf(target),
		enterAction: "choose",
		rows: scopes.map((layer) => ({
			label: scopeLabel(layer),
			description:
				layer === "runtime"
					? "Apply only to this Session. No file is written; reload or switching sessions clears it."
					: title === "Scope"
						? `Target the ${layer} file. Changes are saved only when you apply them.`
						: `Merge into the ${layer} file and apply now. Other keys are preserved.`,
		})),
		shortcuts: [
			{ key: "u", action: "global" },
			...(trusted ? [{ key: "p" as const, action: "project" }] : []),
			{ key: "r", action: "Session" },
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
