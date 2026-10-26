/** In-memory retrospective clone construction and preservation checks. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	buildSessionProjection,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	getHandoff,
	type HistoryGroup,
	type HistoryManifest,
	makeHandoff,
	materializeHandoff,
} from "../fold/handoff.ts";
import type { RetrospectivePreview } from "./retrospective.ts";
import {
	type RetrospectiveGroup,
	type RetrospectivePlan,
	type SessionSnapshot,
	validateCompleteToolCalls,
} from "./retrospective-plan.ts";

interface IndexedGroup {
	group: RetrospectiveGroup;
	first: number;
	last: number;
	children: IndexedGroup[];
}

function state(entries: SessionEntry[], leaf: string | null) {
	const context = buildSessionContext(entries, leaf);
	const system = getCurrentSystemMessage(context.messages);
	return { context, system };
}

function systemState(system: SystemMessage | undefined) {
	return {
		content: system?.content ?? "",
		sections: system?.sections ?? {},
		tools: [...(system?.toolsAdded ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function validateRanges(snapshot: SessionSnapshot, plan: RetrospectivePlan): IndexedGroup[] {
	const { entries } = snapshot;
	const indices = new Map(entries.map((entry, index) => [entry.id, index]));
	const safeCuts = snapshot.safeCuts;
	validateCompleteToolCalls(snapshot);
	function visit(
		groups: readonly RetrospectiveGroup[],
		first: number,
		last: number,
	): IndexedGroup[] {
		let previousEnd = first - 1;
		return groups.map((group) => {
			const start = indices.get(group.firstEntryId);
			const end = indices.get(group.lastEntryId);
			if (start === undefined || end === undefined)
				throw new Error(`${group.name}: unknown range endpoint`);
			if (start < first || end > last || start > end)
				throw new Error(`${group.name}: range is outside its parent or reversed`);
			if (start <= previousEnd)
				throw new Error(`${group.name}: sibling ranges must be ordered and non-overlapping`);
			previousEnd = end;
			const startEntry = entries[start];
			if (startEntry === undefined) throw new Error(`${group.name}: missing range start`);
			const incomingParent = startEntry.parentId;
			if (
				group.state === "folded" &&
				(!safeCuts.has(incomingParent === null ? -1 : (indices.get(incomingParent) ?? -2)) ||
					!safeCuts.has(end))
			) {
				throw new Error(
					`${group.name}: boundary splits a tool call from its results; move it to a completed tool batch`,
				);
			}
			if (group.state === "folded") {
				const inside = new Set(entries.slice(start, end + 1).map((entry) => entry.id));
				const incoming = new Set(
					entries
						.slice(start, end + 1)
						.filter((entry) => entry.parentId === null || !inside.has(entry.parentId))
						.map((entry) => entry.parentId),
				);
				if (incoming.size !== 1)
					throw new Error(`${group.name}: unsafe graph cut has multiple external incoming parents`);
			}
			for (const entry of entries) {
				if (entry.type !== "context_edit") continue;
				const target = indices.get(entry.targetId);
				const edit = indices.get(entry.id);
				if (target === undefined || edit === undefined || target >= edit)
					throw new Error(`Invalid context edit ${entry.id}`);
				const targetInside = target >= start && target <= end;
				const editInside = edit >= start && edit <= end;
				if (group.state === "folded" && targetInside !== editInside) {
					throw new Error(
						`${group.name}: context edit ${entry.id} and target ${entry.targetId} must stay in the same range`,
					);
				}
			}
			return {
				group,
				first: start,
				last: end,
				children: visit(group.children, start, end),
			};
		});
	}
	return visit(plan.groups, 0, entries.length - 1);
}

/** Construct a clone only when original graph, context and runtime state survive. */
export function buildClone(snapshot: SessionSnapshot, plan: RetrospectivePlan) {
	const ranges = validateRanges(snapshot, plan);
	const original = snapshot.entries;
	const entries: SessionEntry[] = [];
	const labels: { targetId: string; label: string }[] = [];
	const timestamp = new Date().toISOString();
	const groups: RetrospectivePreview["groups"][number][] = [];
	const changes: {
		id: string;
		originalParentId: string | null;
		parentId: string | null;
	}[] = [];
	const reservedLabels = new Set(
		original.flatMap((entry) => (entry.type === "label" && entry.label ? [entry.label] : [])),
	);
	const completed = new Map<string, string>();
	const overrides: { parent: string | null; marker: string }[] = [];
	function resolveParent(parent: string | null): string | null {
		for (let index = overrides.length - 1; index >= 0; index--) {
			const override = overrides[index];
			if (override?.parent === parent) return override.marker;
		}
		return parent === null ? null : (completed.get(parent) ?? parent);
	}
	let leaf: string | null = null;
	const id = () => randomUUID();
	const base = () => ({ id: id(), parentId: leaf, timestamp });
	function append(entry: SessionEntry) {
		entries.push(entry);
		leaf = entry.id;
	}
	function restoreState(endId: string) {
		const expected = state(original, endId);
		const actual = state(entries, leaf);
		if (
			!isDeepStrictEqual(expected.context.model, actual.context.model) &&
			expected.context.model
		) {
			append({ ...base(), type: "model_change", ...expected.context.model });
		}
		if (expected.context.thinkingLevel !== actual.context.thinkingLevel) {
			append({
				...base(),
				type: "thinking_level_change",
				thinkingLevel: expected.context.thinkingLevel,
			});
		}
		const desired = systemState(expected.system);
		const current = systemState(actual.system);
		if (!isDeepStrictEqual(desired, current)) {
			const beforeText = current.content;
			const afterText = desired.content;
			if (typeof beforeText !== "string" || typeof afterText !== "string")
				throw new Error("Unexpected replayed system content");
			let content = "";
			if (beforeText !== afterText) {
				if (!beforeText) content = afterText;
				else if (afterText.startsWith(`${beforeText}\n\n`))
					content = afterText.slice(beforeText.length + 2);
				else
					throw new Error(
						`Range ending at ${endId} replaces plain system text; keep that checkpoint outside the range`,
					);
			}
			const sections: Record<string, string | null> = {};
			for (const name of Object.keys(current.sections))
				if (!(name in desired.sections)) sections[name] = null;
			for (const [name, value] of Object.entries(desired.sections))
				if (current.sections[name] !== value) sections[name] = value;
			append({
				...base(),
				type: "message",
				message: {
					role: "system",
					content,
					sections,
					toolsRemoved: current.tools.map((tool) => ({ name: tool.name })),
					toolsAdded: desired.tools,
					timestamp: Date.parse(timestamp),
				},
			});
		}
		const restored = state(entries, leaf);
		if (
			!isDeepStrictEqual(expected.context.model, restored.context.model) ||
			expected.context.thinkingLevel !== restored.context.thinkingLevel ||
			!isDeepStrictEqual(desired, systemState(restored.system))
		) {
			throw new Error(`Cannot preserve runtime state at ${endId}`);
		}
	}
	function emit(
		first: number,
		last: number,
		children: IndexedGroup[],
		depth: number,
	): HistoryGroup[] {
		const history: HistoryGroup[] = [];
		let cursor = first;
		for (const range of children) {
			copy(cursor, range.first - 1);
			const firstEntry = original[range.first];
			if (firstEntry === undefined) throw new Error(`${range.group.name}: missing range start`);
			const originalParent = firstEntry.parentId;
			const parent = resolveParent(originalParent);
			groups.push({
				name: range.group.name,
				depth,
				firstEntryId: range.group.firstEntryId,
				lastEntryId: range.group.lastEntryId,
				summary: range.group.summary,
				state: range.group.state,
				mode: range.group.mode ?? plan.parentHandoffMode,
			});
			for (const prefix of ["anchor:", "branch:"]) {
				if (reservedLabels.has(`${prefix}${range.group.name}`))
					throw new Error(`Label already exists: ${prefix}${range.group.name}`);
			}
			const startId = id();
			const title = range.group.title ?? range.group.name.replaceAll("-", " ");
			const startEntry: SessionEntry = {
				id: startId,
				parentId: parent,
				timestamp,
				type: "custom",
				customType: "tree-phase",
				data: {
					name: range.group.name,
					title,
					state: range.group.state,
					goal: range.group.goal,
				},
			};
			append(startEntry);
			overrides.push({ parent: originalParent, marker: startId });
			const childGroups = emit(range.first, range.last, range.children, depth + 1);
			const sourceEntries = original.slice(range.first, range.last + 1);
			if (range.group.state === "open") {
				overrides.pop();
				labels.push({ targetId: startId, label: `anchor:${range.group.name}` });
				history.push({
					name: range.group.name,
					title,
					entryId: startId,
					startId,
					state: "open",
					sourceIds: sourceEntries.map((entry) => entry.id),
					children: childGroups,
				});
				cursor = range.last + 1;
				continue;
			}
			overrides.pop();
			append({
				...base(),
				type: "custom",
				customType: "tree-clone-boundary",
				data: { name: range.group.name },
			});
			const fromId = leaf;
			if (!fromId) throw new Error("Missing archived branch endpoint");
			labels.push({ targetId: fromId, label: `branch:${range.group.name}` });
			leaf = parent;
			restoreState(range.group.lastEntryId);
			const summaryId = id();
			const handoff = makeHandoff({
				name: range.group.name,
				title,
				...(range.group.goal === undefined ? {} : { goal: range.group.goal }),
				...(range.group.outcome === undefined ? {} : { outcome: range.group.outcome }),
				report: range.group.summary,
				mode: range.group.mode ?? plan.parentHandoffMode,
				children: childGroups.map((group) => group.entryId),
				sourceEntries,
			});
			const childReports = childGroups.map((group) => {
				const entry = entries.find((entry) => entry.id === group.entryId);
				if (entry?.type !== "branch_summary")
					throw new Error(`Missing child handoff ${group.name}`);
				const childHandoff = getHandoff(entry);
				return {
					id: entry.id,
					summary: entry.summary,
					...(childHandoff === undefined ? {} : { handoff: childHandoff }),
				};
			});
			append({
				id: summaryId,
				parentId: leaf,
				timestamp,
				type: "branch_summary",
				fromId,
				summary: materializeHandoff(handoff, childReports),
				fromHook: true,
				details: {
					retrospective: true,
					treeNavigator: handoff,
					sourceSessionId: snapshot.header.id,
					firstEntryId: range.group.firstEntryId,
					lastEntryId: range.group.lastEntryId,
				},
			});
			completed.set(range.group.lastEntryId, summaryId);
			labels.push({ targetId: summaryId, label: `anchor:${range.group.name}` });
			history.push({
				name: range.group.name,
				title,
				entryId: summaryId,
				startId,
				state: "folded",
				sourceIds: handoff.sourceIds,
				children: childGroups,
			});
			cursor = range.last + 1;
		}
		copy(cursor, last);
		return history;
	}
	function copy(first: number, last: number) {
		for (let index = first; index <= last; index++) {
			const entry = original[index];
			if (entry === undefined) throw new Error(`Missing source entry at index ${index}`);
			const parentId = resolveParent(entry.parentId);
			if (entry.parentId !== parentId)
				changes.push({
					id: entry.id,
					originalParentId: entry.parentId,
					parentId,
				});
			append({ ...entry, parentId });
		}
	}
	const history: HistoryManifest = {
		version: 1,
		sourceOrder: original.map((entry) => entry.id),
		groups: emit(0, original.length - 1, ranges, 0),
	};
	const activeLeaf = leaf;
	validateClone(original, entries, activeLeaf);
	const name = `${snapshot.name}${plan.nameSuffix}`;
	append({
		...base(),
		type: "custom",
		customType: "tree-clone-provenance",
		data: {
			version: 1,
			source: snapshot.path,
			sourceSessionId: snapshot.header.id,
			sourceSha256: snapshot.sha256,
			plan,
			history,
			changes,
		},
	});
	for (const label of labels) append({ ...base(), type: "label", ...label });
	append({ ...base(), type: "session_info", name });
	return { entries, groups, name, timestamp };
}

function validateClone(
	original: SessionEntry[],
	entries: SessionEntry[],
	activeLeaf: string | null,
) {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (byId.has(entry.id) || (entry.parentId !== null && !byId.has(entry.parentId)))
			throw new Error(`Invalid clone linkage at ${entry.id}`);
		byId.set(entry.id, entry);
	}
	function ancestors(entry: SessionEntry) {
		const ids = new Set<string>();
		let current: SessionEntry | undefined = entry;
		while (current) {
			ids.add(current.id);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return ids;
	}
	for (const entry of entries) {
		if (entry.type === "compaction" && !ancestors(entry).has(entry.firstKeptEntryId)) {
			throw new Error(
				`Compaction ${entry.id} retains ${entry.firstKeptEntryId}, which a range removes from its branch. Move the range boundary before ${entry.firstKeptEntryId}, or merge the ranges.`,
			);
		}
		if (entry.type === "context_edit" && !ancestors(entry).has(entry.targetId))
			throw new Error(`Context edit ${entry.id} loses target ${entry.targetId}`);
	}
	const active = activeLeaf ? byId.get(activeLeaf) : undefined;
	const activeIds = active ? ancestors(active) : new Set<string>();
	const originalIds = new Set(original.map((entry) => entry.id));
	const newActiveHandoffs = entries.filter(
		(entry) =>
			entry.type === "branch_summary" && !originalIds.has(entry.id) && activeIds.has(entry.id),
	);
	if (
		entries.some((entry) => {
			if (entry.type !== "compaction" || !activeIds.has(entry.id)) return false;
			const kept = byId.get(entry.firstKeptEntryId);
			const hidden = kept ? ancestors(kept) : new Set<string>();
			return newActiveHandoffs.some((handoff) => hidden.has(handoff.id));
		})
	) {
		throw new Error(
			"A compaction remains on the active path and could hide the new summaries. Include it in a completed top-level range.",
		);
	}
	for (const entry of original) {
		const before = state(original, entry.id);
		const after = state(entries, entry.id);
		if (
			!isDeepStrictEqual(before.context.model, after.context.model) ||
			before.context.thinkingLevel !== after.context.thinkingLevel ||
			!isDeepStrictEqual(systemState(before.system), systemState(after.system))
		) {
			throw new Error(
				`Runtime state would change at original entry ${entry.id}; adjust range boundaries`,
			);
		}
	}
	const parents = new Set(original.map((entry) => entry.parentId));
	const checkpoints = original
		.filter((entry) => entry.type === "context_edit" || !parents.has(entry.id))
		.map((entry) => entry.id);
	function compare(beforeLeaf: string | null, afterLeaf: string | null) {
		const beforeProjection = buildSessionProjection(original, beforeLeaf);
		const afterProjection = buildSessionProjection(entries, afterLeaf);
		const beforeById = new Map(
			beforeProjection.entries.map((entry) => [entry.sourceEntry.id, entry.messages]),
		);
		for (const entry of afterProjection.entries) {
			const before = beforeById.get(entry.sourceEntry.id);
			if (before && !isDeepStrictEqual(before, entry.messages))
				throw new Error(`Context edits would change surviving entry ${entry.sourceEntry.id}`);
		}
	}
	compare(original.at(-1)?.id ?? null, activeLeaf);
	for (const checkpoint of checkpoints) compare(checkpoint, checkpoint);
}
