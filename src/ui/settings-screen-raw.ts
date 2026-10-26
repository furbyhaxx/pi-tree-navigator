/** Spelling-preserving config edits and staged change plans. */

import type { KeyName, Root, Style, Target } from "./settings-screen-types.ts";

export const isRoot = (value: unknown): value is Root =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

export const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

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

export interface Raw {
	present: boolean;
	value?: unknown;
}

export function rawOf(root: Root, { path }: { path: readonly KeyName[] }): Raw {
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

export function setAt(root: Root, path: readonly KeyName[], value: unknown, style: Style): void {
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
export const isUnder = (path: readonly KeyName[], ancestor: readonly KeyName[]): boolean =>
	ancestor.length <= path.length &&
	ancestor.every((part, index) => part.snake === path[index].snake);

/** The first container above the leaf that exists but is not an object, which an edit would replace. */
export function blockedBy(root: Root, path: readonly KeyName[]): string | undefined {
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
export function namesAt(root: Root, path: readonly KeyName[]): string[] {
	const raw = rawOf(root, { path });
	return raw.present && isRoot(raw.value) ? Object.keys(raw.value) : [];
}

export type Edit = { kind: "set"; value: unknown } | { kind: "reset" };

/** A staged edit with what it addresses; the key in the staged map is `def.key`. */
export interface Pending {
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

export interface Change {
	def: Target;
	edit: Edit;
	before: Raw;
	after: Raw;
}

export interface Plan {
	next: Root;
	changes: Change[];
}

/** The edits that actually change this file, applied in the order they were staged. */
export function planChanges(root: Root, staged: ReadonlyMap<string, Pending>): Plan {
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

export const serialize = (root: Root): string => `${JSON.stringify(root, null, 2)}\n`;
