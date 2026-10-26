import {
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	keyText,
	type SessionEntry,
	type Theme,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { HistoryGroup, HistoryManifest } from "../fold/handoff.ts";

interface Row {
	id: string;
	text: string;
	depth: number;
	group?: HistoryGroup;
	current: boolean;
	parents: string[];
}
interface Outline {
	rows: Row[];
	expanded: Set<string>;
}
interface State {
	session: object;
	manifest: HistoryManifest;
	expanded: Set<string>;
	selected: number;
	query: string;
	searching: boolean;
	raw: boolean;
}
interface NativeList {
	maxVisibleLines: number;
	onSelect(id: string): void;
	onCancel(): void;
}
interface Selector {
	getTreeList(): NativeList;
	render(width: number): string[];
	handleInput(data: string): void;
}
let previousInstallation: (() => void) | undefined;

function manifestFrom(entries: readonly SessionEntry[]): HistoryManifest | undefined {
	const provenance = entries.findLast(
		(e) => e.type === "custom" && e.customType === "tree-clone-provenance",
	);
	if (provenance?.type !== "custom") return;
	const value = (provenance.data as { history?: unknown } | undefined)?.history;
	if (!value || typeof value !== "object") return;
	const m = value as HistoryManifest;
	const ids = new Map(entries.map((e) => [e.id, e]));
	if (
		m.version !== 1 ||
		!Array.isArray(m.sourceOrder) ||
		!m.sourceOrder.length ||
		new Set(m.sourceOrder).size !== m.sourceOrder.length ||
		!m.sourceOrder.every((id) => typeof id === "string" && ids.has(id)) ||
		!Array.isArray(m.groups)
	)
		return;
	const sourceIds = new Set(m.sourceOrder);
	const names = new Set<string>();
	const markers = new Set<string>();
	const validate = (groups: readonly HistoryGroup[], allowed: readonly string[]): boolean => {
		const positionsById = new Map(allowed.map((id, i) => [id, i]));
		const occupied = new Set<string>();
		let previous = -1;
		return groups.every((g) => {
			if (
				!g ||
				typeof g.name !== "string" ||
				!g.name ||
				names.has(g.name) ||
				typeof g.title !== "string" ||
				!["folded", "open"].includes(g.state) ||
				!Array.isArray(g.sourceIds) ||
				!g.sourceIds.length ||
				!Array.isArray(g.children)
			)
				return false;
			const start = ids.get(g.startId);
			const target = ids.get(g.entryId);
			if (
				start?.type !== "custom" ||
				start.customType !== "tree-phase" ||
				!target ||
				(g.state === "folded" ? target.type !== "branch_summary" : g.entryId !== g.startId) ||
				sourceIds.has(g.entryId) ||
				markers.has(g.entryId)
			)
				return false;
			const positions = g.sourceIds.map((id) => positionsById.get(id) ?? -1);
			const first = positions[0];
			const last = positions.at(-1);
			if (first === undefined || last === undefined) return false;
			if (
				first <= previous ||
				positions.some((p, i) => p < 0 || (i > 0 && p !== (positions[i - 1] ?? -1) + 1)) ||
				g.sourceIds.some((id) => occupied.has(id))
			)
				return false;
			previous = last;
			for (const id of g.sourceIds) occupied.add(id);
			names.add(g.name);
			markers.add(g.entryId);
			return validate(g.children, g.sourceIds);
		});
	};
	return validate(m.groups, m.sourceOrder) ? m : undefined;
}

function entryText(e: SessionEntry): string {
	if (e.type === "message" && "content" in e.message) {
		const content = e.message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((b) => ("text" in b ? b.text : b.type)).join(" ");
		return `${e.message.role}: ${text}`.replace(/\s+/g, " ");
	}
	return `${e.type} ${e.id}`;
}

/** Build chronological containment without changing persisted conversation ancestry. */
export function buildHistoryOutline(
	entries: readonly SessionEntry[],
	leaf: string | null,
	expanded?: Set<string>,
	query = "",
): Outline | undefined {
	const manifest = manifestFrom(entries);
	if (!manifest) return;
	const byId = new Map(entries.map((e) => [e.id, e]));
	const ancestry = new Set<string>();
	let cursor = leaf;
	while (cursor && !ancestry.has(cursor)) {
		ancestry.add(cursor);
		cursor = byId.get(cursor)?.parentId ?? null;
	}
	let currentGroup: HistoryGroup | undefined;
	let currentDepth = -1;
	const locate = (groups: readonly HistoryGroup[], depth = 0) => {
		for (const g of groups) {
			if (
				g.state === "open" &&
				(ancestry.has(g.startId) || g.sourceIds.includes(leaf ?? "")) &&
				depth > currentDepth
			) {
				currentGroup = g;
				currentDepth = depth;
			}
			locate(g.children, depth + 1);
		}
	};
	locate(manifest.groups);
	const open = expanded ?? new Set<string>();
	const all: Row[] = [];
	const emit = (order: readonly string[], groups: readonly HistoryGroup[], parents: string[]) => {
		const starts = new Map(groups.map((g) => [g.sourceIds[0], g]));
		for (let i = 0; i < order.length; i++) {
			const id = order[i];
			if (id === undefined) continue;
			const g = starts.get(id);
			if (g) {
				all.push({
					id: g.entryId,
					text: `${g.title} (${g.state})`,
					depth: parents.length,
					group: g,
					current: g === currentGroup,
					parents,
				});
				if (!expanded && g.state === "open") {
					open.add(g.entryId);
					for (const p of parents) open.add(p);
				}
				emit(g.sourceIds, g.children, [...parents, g.entryId]);
				i += g.sourceIds.length - 1;
			} else {
				const e = byId.get(id);
				if (
					e &&
					(e.type === "custom_message" ||
						e.type === "branch_summary" ||
						e.type === "compaction" ||
						(e.type === "message" &&
							e.message.role !== "system" &&
							!(
								e.message.role === "assistant" &&
								e.message.content.every((block) => block.type === "toolCall")
							)))
				)
					all.push({
						id,
						text: entryText(e),
						depth: parents.length,
						current: id === leaf,
						parents,
					});
			}
		}
	};
	emit(manifest.sourceOrder, manifest.groups, []);
	const provenanceIndex = entries.findLastIndex(
		(e) => e.type === "custom" && e.customType === "tree-clone-provenance",
	);
	const source = new Set(manifest.sourceOrder);
	for (const e of entries.slice(provenanceIndex + 1)) {
		if (
			!source.has(e.id) &&
			ancestry.has(e.id) &&
			e.type === "message" &&
			e.message.role !== "system"
		) {
			const parents = currentGroup
				? [...(all.find((r) => r.group === currentGroup)?.parents ?? []), currentGroup.entryId]
				: [];
			all.push({
				id: e.id,
				text: entryText(e),
				depth: parents.length,
				current: e.id === leaf,
				parents,
			});
		}
	}
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = all.filter((r) => tokens.every((t) => r.text.toLowerCase().includes(t)));
	const matchedIds = new Set(matches.map((r) => r.id));
	const revealed = new Set(matches.flatMap((r) => r.parents));
	return {
		expanded: open,
		rows: all.filter((r) =>
			tokens.length
				? matchedIds.has(r.id) || revealed.has(r.id)
				: r.parents.every((p) => open.has(p)),
		),
	};
}

/** Install the authorized native /tree outline for manifest-bearing UI sessions only. */
export function registerHistoryOutline(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let restore: (() => void) | undefined;
	const states = new WeakMap<object, State>();
	pi.on("session_start", async (_event, ctx) => {
		context = ctx.hasUI && ctx.mode === "tui" ? ctx : undefined;
		if (restore || !context) return;
		try {
			const proto = TreeSelectorComponent?.prototype as unknown as Selector | undefined;
			if (
				!proto ||
				typeof proto.render !== "function" ||
				typeof proto.handleInput !== "function" ||
				typeof proto.getTreeList !== "function"
			)
				return;
			previousInstallation?.();
			const render = proto.render;
			const input = proto.handleInput;
			const stateFor = (selector: Selector) => {
				const manager = context?.sessionManager;
				if (!manager) return;
				const list = selector.getTreeList();
				if (
					!list ||
					typeof list.onSelect !== "function" ||
					typeof list.onCancel !== "function" ||
					!Number.isFinite(list.maxVisibleLines)
				)
					return;
				const entries = manager.getEntries();
				const manifest = manifestFrom(entries);
				if (!manifest) return;
				let state = states.get(selector);
				if (!state || state.session !== manager || state.manifest !== manifest) {
					const outline = buildHistoryOutline(entries, manager.getLeafId());
					if (!outline) return;
					state = {
						session: manager,
						manifest,
						expanded: outline.expanded,
						selected: Math.max(
							0,
							outline.rows.findIndex((r) => r.current),
						),
						query: "",
						searching: false,
						raw: false,
					};
					states.set(selector, state);
				}
				const outline = buildHistoryOutline(
					entries,
					manager.getLeafId(),
					state.expanded,
					state.query,
				);
				if (!outline) return;
				state.selected = Math.max(0, Math.min(state.selected, outline.rows.length - 1));
				return {
					state,
					rows: outline.rows,
					list,
					theme: context?.ui.theme as Theme,
				};
			};
			const patchedRender = function (this: Selector, width: number): string[] {
				const view = stateFor(this);
				if (!view || view.state.raw) return render.call(this, width);
				const { state, rows, list, theme } = view;
				const height = Math.max(1, Math.min(list.maxVisibleLines, (process.stdout.rows || 40) - 9));
				const offset = Math.max(
					0,
					Math.min(state.selected - Math.floor(height / 2), rows.length - height),
				);
				const lines = [
					theme.fg("borderAccent", "─".repeat(Math.max(0, width))),
					theme.bold("  History · chronological containment"),
					theme.fg(
						"muted",
						state.searching || state.query
							? `  / ${state.query}`
							: "  Groups contain history; resume starts AFTER handoff",
					),
				];
				for (let i = 0; i < height; i++) {
					const row = rows[offset + i];
					lines.push(
						row
							? theme.fg(
									offset + i === state.selected ? "accent" : "text",
									`${offset + i === state.selected ? "❯ " : "  "}${"  ".repeat(Math.min(row.depth, 12))}${row.group ? (state.expanded.has(row.id) || state.query ? "▾ " : "▸ ") : ""}${row.current ? "[current] " : ""}${row.text}`,
								)
							: "",
					);
				}
				lines.push(
					theme.fg(
						"muted",
						`  ${offset + 1}-${Math.min(rows.length, offset + height)} / ${rows.length} · F2 raw tree: native labels / filters`,
					),
				);
				lines.push(
					`  ${keyText("tui.select.up")}/${keyText("tui.select.down")} move · ${keyHint("tui.select.confirm", "toggle / resume")} · Space toggle`,
				);
				lines.push(
					`  r resume AFTER handoff · / search · ${keyHint("tui.select.cancel", "clear / close")} · F2 raw`,
				);
				lines.push(theme.fg("borderAccent", "─".repeat(Math.max(0, width))));
				return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
			};
			const patchedInput = function (this: Selector, data: string): void {
				const view = stateFor(this);
				if (!view) {
					input.call(this, data);
					return;
				}
				const { state, rows, list } = view;
				const kb = getKeybindings();
				if (matchesKey(data, "f2")) {
					state.raw = !state.raw;
					return;
				}
				if (state.raw) {
					input.call(this, data);
					return;
				}
				if (kb.matches(data, "tui.select.cancel")) {
					if (state.searching || state.query) {
						state.searching = false;
						state.query = "";
					} else list.onCancel();
					return;
				}
				if (kb.matches(data, "tui.select.up")) {
					state.selected = Math.max(0, state.selected - 1);
					return;
				}
				if (kb.matches(data, "tui.select.down")) {
					state.selected = Math.min(rows.length - 1, state.selected + 1);
					return;
				}
				if (state.searching) {
					if (kb.matches(data, "tui.select.confirm")) state.searching = false;
					else if (matchesKey(data, "backspace"))
						state.query = [...state.query].slice(0, -1).join("");
					else if ([...data].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
						state.query += data;
					state.selected = 0;
					return;
				}
				if (data === "/") {
					state.searching = true;
					return;
				}
				const row = rows[state.selected];
				if (!row) return;
				if (data === "r" && row.group) {
					list.onSelect(row.id);
					return;
				}
				if (kb.matches(data, "tui.select.confirm") || data === " ") {
					if (row.group) {
						if (state.expanded.has(row.id)) state.expanded.delete(row.id);
						else state.expanded.add(row.id);
					} else if (kb.matches(data, "tui.select.confirm")) list.onSelect(row.id);
				}
			};
			proto.render = patchedRender;
			proto.handleInput = patchedInput;
			restore = () => {
				if (proto.render === patchedRender) proto.render = render;
				if (proto.handleInput === patchedInput) proto.handleInput = input;
			};
			previousInstallation = restore;
		} catch {
			/* Unsupported host internals leave the native tree intact. */
		}
	});
	pi.on("session_shutdown", async () => {
		context = undefined;
		restore?.();
		restore = undefined;
	});
}
