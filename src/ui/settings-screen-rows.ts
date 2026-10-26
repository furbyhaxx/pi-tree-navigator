/** Settings frame rows, scope details and staged-value presentation. */

import { homedir } from "node:os";
import { sep } from "node:path";
import type { FrameRow, FrameScreen } from "./frame.ts";
import { policyWarning } from "./policy-settings.ts";
import {
	INVALID_TEXT,
	invalidIn,
	layerSummary,
	type Resolution,
	resolveDef,
	type Snapshot,
	show,
} from "./settings-screen-layers.ts";
import {
	BASE_RESERVE,
	entryProblem,
	entrySettings,
	entryTarget,
	type Group,
	type Item,
	mapTarget,
	overrideTools,
} from "./settings-screen-maps.ts";
import {
	capitalized,
	isRoot,
	isUnder,
	namesAt,
	type Pending,
	type Plan,
	planChanges,
	rawOf,
} from "./settings-screen-raw.ts";
import {
	type KeyName,
	LAYERS,
	type Layer,
	PRECEDENCE,
	type Root,
	type SettingDef,
	type Target,
} from "./settings-screen-types.ts";

// --- The screen ----------------------------------------------------------------

export function shortPath(path: string, cwd: string): string {
	const home = homedir();
	if (path.startsWith(`${cwd}${sep}`)) return `.${path.slice(cwd.length)}`;
	if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
	return path;
}

export function brokenNotice(snap: Snapshot, layer: Layer): string {
	const file = snap.files[layer];
	const reason = file.kind === "broken" ? file.reason : "is not usable";
	return `${capitalized(layer)} config at ${snap.paths[layer]} ${reason}. It is ignored and will not be edited here. Fix the file, then reopen /anchor settings.`;
}

/** Why edits to this layer are refused right now, or undefined when they may proceed. */
export function targetProblem(snap: Snapshot, target: Layer): string | undefined {
	if (target === "project" && !snap.trusted) {
		return "This project is not trusted, so its tree-navigator.json is not read or edited.";
	}
	return snap.files[target].kind === "broken" ? brokenNotice(snap, target) : undefined;
}

export function planFor(
	snap: Snapshot,
	target: Layer,
	staged: ReadonlyMap<string, Pending>,
): Plan | undefined {
	const file = snap.files[target];
	if (file.kind === "broken") return undefined;
	return planChanges(file.kind === "ok" ? file.root : {}, staged);
}

export interface View {
	snap: Snapshot;
	target: Layer;
	staged: Map<string, Pending>;
	plan: Plan | undefined;
	preview: Resolution;
}

export function settingRow(def: SettingDef, view: View): FrameRow {
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

export function badgeOf(view: View): string {
	const { snap, target, staged, plan } = view;
	const pending = plan ? plan.changes.length : staged.size;
	const where = targetProblem(snap, target)
		? `target: ${target} · file invalid`
		: `target: ${target}`;
	return pending > 0 ? `${pending} staged · ${where}` : where;
}

/** Staged edits that touch `path` or anything below it. */
export function stagedUnder(view: View, path: readonly KeyName[]): Target[] {
	const defs = view.plan
		? view.plan.changes.map((change) => change.def)
		: [...view.staged.values()].map((pending) => pending.def);
	return defs.filter((def) => isUnder(def.path, path));
}

export function unstageUnder(staged: Map<string, Pending>, path: readonly KeyName[]): void {
	for (const [key, { def }] of staged) {
		if (isUnder(def.path, path)) staged.delete(key);
	}
}

/** True when the target file has a value to remove and its removal is not staged yet. */
export function canReset(view: View, target: Target): boolean {
	const file = view.snap.files[view.target];
	return (
		file.kind === "ok" &&
		rawOf(file.root, target).present &&
		view.staged.get(target.key)?.edit.kind !== "reset"
	);
}

export const otherLayer = (layer: Layer, trusted: boolean): Layer => {
	const available = LAYERS.filter((item) => item !== "project" || trusted);
	return available[(available.indexOf(layer) + 1) % available.length];
};

/** Why a layer's file cannot be read for entries, or undefined when it can. */
function unavailable(snap: Snapshot, layer: Layer): string | undefined {
	if (layer === "project" && !snap.trusted) return "untrusted";
	return snap.files[layer].kind === "broken" ? "file invalid" : undefined;
}

/** A layer's root as the loader sees it: empty when the file is missing, none when unusable. */
export function readableRoot(snap: Snapshot, layer: Layer): Root | undefined {
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
export function mapNames(view: View, path: readonly KeyName[]): string[] {
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

export const itemTarget = (item: Item): Target =>
	"def" in item ? item.def : mapTarget(item.group);

type Shortcut = NonNullable<FrameScreen["shortcuts"]>[number];

export function buildScreen(
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

export function entryRow(pattern: string, view: View): FrameRow {
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
