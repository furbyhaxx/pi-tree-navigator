/** Settings input, validation and in-memory staging. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseTreeNavigatorConfig } from "../core/config.ts";
import { editPolicy, policyAccepted } from "./policy-settings.ts";
import { pickSettingsModel } from "./settings-model-picker.ts";
import {
	brief,
	readSnapshot,
	resolve,
	type Snapshot,
	show,
	textOf,
} from "./settings-screen-layers.ts";
import {
	blockedBy,
	type Edit,
	isRoot,
	isUnder,
	type Pending,
	planChanges,
	rawOf,
	serialize,
	setAt,
} from "./settings-screen-raw.ts";
import {
	brokenNotice,
	planFor,
	targetProblem,
	unstageUnder,
	type View,
} from "./settings-screen-rows.ts";
import {
	LAYERS,
	type Layer,
	type Root,
	type SettingDef,
	type SettingsAccess,
	type Target,
} from "./settings-screen-types.ts";

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
export function accepts(def: SettingDef, value: unknown): boolean {
	const probe: Root = {};
	setAt(probe, def.path, value, "camel");
	const parsed = parseTreeNavigatorConfig(probe);
	return parsed.kind === "fields" && def.status(parsed.layer).kind === "set";
}

export async function promptEdit(
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

/** Reads the files again, so every screen shows what is on disk plus the staged edits. */
export async function loadView(session: Session): Promise<View> {
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
/** True when edits to the target layer may proceed; otherwise says why not. */
export function usable(ctx: ExtensionCommandContext, snap: Snapshot, target: Layer): boolean {
	const problem = targetProblem(snap, target);
	if (problem !== undefined) ctx.ui.notify(problem, "warning");
	return problem === undefined;
}

/** Stage the removal of a setting, entry or whole map; a non-empty map or entry needs a yes first. */
export async function removeEntry(session: Session, view: View, target: Target): Promise<void> {
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
export function stage(
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

/** What the screens share while one `/anchor settings` command runs. */
export interface Session {
	ctx: ExtensionCommandContext;
	deps: SettingsAccess;
	staged: Map<string, Pending>;
	warned: Set<Layer>;
	target: Layer;
}
