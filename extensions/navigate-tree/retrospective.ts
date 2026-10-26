import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	buildSessionProjection,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { discoverDescendantSessions, planDescendantCopies } from "./descendant-sessions.ts";
import {
	getHandoff,
	type HistoryGroup,
	type HistoryManifest,
	makeHandoff,
	materializeHandoff,
} from "./handoff.ts";
import {
	type RetrospectiveGroup,
	type RetrospectivePlan,
	readRetrospectivePlan,
	readSessionSnapshot,
	type SessionSnapshot,
	sha256,
	validateCompleteToolCalls,
} from "./retrospective-plan.ts";

/** Reviewable conversion output; its token binds both the source and complete plan. */
export interface RetrospectivePreview {
	readonly source: string;
	readonly sourceSha256: string;
	readonly name: string;
	readonly previewToken: string;
	readonly originalEntries: number;
	readonly addedEntries: number;
	readonly groups: readonly {
		name: string;
		depth: number;
		firstEntryId: string;
		lastEntryId: string;
		summary: string;
		state: "folded" | "open";
		mode: "full" | "synthesized" | "digest";
	}[];
	readonly descendants: readonly {
		source: string;
		sourceSha256: string;
		mode: "copied" | "restructured";
	}[];
	readonly warnings: readonly string[];
}

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
			const incomingParent = entries[start].parentId;
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

function buildClone(snapshot: SessionSnapshot, plan: RetrospectivePlan) {
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
			if (override.parent === parent) return override.marker;
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
			const originalParent = original[range.first].parentId;
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
				goal: range.group.goal,
				outcome: range.group.outcome,
				report: range.group.summary,
				mode: range.group.mode ?? plan.parentHandoffMode,
				children: childGroups.map((group) => group.entryId),
				sourceEntries,
			});
			const childReports = childGroups.map((group) => {
				const entry = entries.find((entry) => entry.id === group.entryId);
				if (entry?.type !== "branch_summary")
					throw new Error(`Missing child handoff ${group.name}`);
				return {
					id: entry.id,
					summary: entry.summary,
					handoff: getHandoff(entry),
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

/** Validate a plan entirely in memory without discovering or publishing sessions. */
export function validateRetrospectivePlan(
	snapshot: SessionSnapshot,
	plan: RetrospectivePlan,
): void {
	if (snapshot.sha256 !== plan.sourceSha256) throw new Error("Source snapshot changed");
	buildClone(snapshot, plan);
}

async function prepare(path: string) {
	const plan = await readRetrospectivePlan(path);
	const snapshot = await readSessionSnapshot(plan.source);
	if (snapshot.sha256 !== plan.sourceSha256)
		throw new Error(
			"Source snapshot changed: inspect it again and review the plan against the new hash",
		);
	const clone = buildClone(snapshot, plan);
	const descendants = await discoverDescendantSessions(snapshot.path);
	const descendantClones = new Map<
		string,
		{ plan: RetrospectivePlan; clone: ReturnType<typeof buildClone> }
	>();
	if (!plan.recurse && plan.descendantPlans.length)
		throw new Error(
			"descendantPlans requires recurse: true; otherwise descendant histories are copied unchanged",
		);
	if (plan.recurse) {
		for (const planPath of plan.descendantPlans) {
			const childPlan = await readRetrospectivePlan(planPath);
			const child = await readSessionSnapshot(childPlan.source);
			if (!descendants.some((descendant) => descendant.path === child.path))
				throw new Error(`Plan source is not a descendant of this session: ${child.path}`);
			if (child.sha256 !== childPlan.sourceSha256)
				throw new Error(`Descendant snapshot changed: ${child.path}`);
			if (descendantClones.has(child.path))
				throw new Error(`Duplicate descendant plan: ${child.path}`);
			descendantClones.set(child.path, {
				plan: childPlan,
				clone: buildClone(child, childPlan),
			});
		}
		const missing = descendants.filter((descendant) => !descendantClones.has(descendant.path));
		if (missing.length)
			throw new Error(
				`Recursive restructuring requires a reviewed plan for every descendant. Missing ${missing.length}: ${missing.map((item) => item.path).join(", ")}. Supply descendantPlans or leave recurse off to copy their histories unchanged.`,
			);
	}
	const family = descendants.map((descendant) => ({
		source: descendant.path,
		sourceSha256: descendant.sha256,
		mode: descendantClones.has(descendant.path) ? ("restructured" as const) : ("copied" as const),
	}));
	const preview: RetrospectivePreview = {
		source: snapshot.path,
		sourceSha256: snapshot.sha256,
		name: clone.name,
		previewToken: sha256(
			JSON.stringify({
				source: snapshot.path,
				plan,
				family,
				descendantPlans: [...descendantClones].map(([source, item]) => ({
					source,
					plan: item.plan,
				})),
			}),
		),
		descendants: family,
		originalEntries: snapshot.entries.length,
		addedEntries: clone.entries.length - snapshot.entries.length,
		groups: clone.groups,
		warnings: [
			"Summary accuracy is not machine-verifiable. Review every handoff before creating the clone.",
			"Extension-specific custom state remains on its original branch; external provider histories and extension sidecar files are not cloned.",
		],
	};
	return { snapshot, clone, preview, descendants, descendantClones };
}

/** Validate a conversion and return its complete review surface without creating a session. */
export async function previewRetrospectiveSession(planPath: string): Promise<RetrospectivePreview> {
	return (await prepare(planPath)).preview;
}

/** Publish a new independently resumable session, only for the exact previewed plan and snapshot. */
export async function cloneRetrospectiveSession(planPath: string, previewToken: string) {
	const { snapshot, clone, preview, descendants, descendantClones } = await prepare(planPath);
	if (previewToken !== preview.previewToken)
		throw new Error("Preview changed or missing; preview the plan again before creating a clone");
	const sessionId = randomUUID();
	const dir = dirname(snapshot.path);
	const path = join(dir, `${clone.timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	const header = {
		...snapshot.header,
		id: sessionId,
		timestamp: clone.timestamp,
	};
	const data = `${[header, ...clone.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const copied = planDescendantCopies(descendants, snapshot.path, path).map((copy) => {
		const replacement = descendantClones.get(copy.source.path);
		if (!replacement) return copy;
		const newline = copy.bytes.indexOf(10);
		const childHeader: unknown = JSON.parse(copy.bytes.subarray(0, newline).toString("utf8"));
		return {
			...copy,
			bytes: Buffer.from(
				`${[childHeader, ...replacement.clone.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			),
		};
	});
	const files = [
		...copied.map((copy) => ({ path: copy.path, bytes: copy.bytes })),
		{ path, bytes: Buffer.from(data) },
	];
	const staged: { path: string; temporary: string }[] = [];
	const published: string[] = [];
	const warnings: string[] = [];
	let failure: { error: unknown } | undefined;
	try {
		for (const file of files) {
			const temporary = join(dirname(file.path), `.tree-clone-${randomUUID()}.tmp`);
			const handle = await open(temporary, "wx", 0o600);
			staged.push({ path: file.path, temporary });
			try {
				await handle.writeFile(file.bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		const root = staged.at(-1);
		if (!root) throw new Error("Missing staged root");
		const reopened = SessionManager.open(root.temporary);
		if (
			reopened.getSessionId() !== sessionId ||
			reopened.getSessionName() !== preview.name ||
			reopened.getEntries().length !== clone.entries.length
		) {
			throw new Error("Clone failed Pi session reload validation");
		}
		if (
			!isDeepStrictEqual(
				buildSessionContext(reopened.getEntries()),
				buildSessionContext(clone.entries),
			)
		)
			throw new Error("Clone context changed after reloading");
		if (sha256(await readFile(snapshot.path)) !== snapshot.sha256)
			throw new Error("Source changed during conversion; no clone was published");
		for (const descendant of descendants)
			if (sha256(await readFile(descendant.path)) !== descendant.sha256)
				throw new Error(`Descendant changed during conversion: ${descendant.path}`);
		const currentFamily = await discoverDescendantSessions(snapshot.path);
		if (
			!isDeepStrictEqual(
				currentFamily.map((item) => [item.path, item.sha256]),
				descendants.map((item) => [item.path, item.sha256]),
			)
		)
			throw new Error("Descendant family changed during conversion; preview again");
		for (const file of staged) {
			await link(file.temporary, file.path);
			published.push(file.path);
		}
	} catch (error) {
		failure = { error };
		const rollback = await Promise.allSettled(published.map((path) => unlink(path)));
		const incomplete = rollback.flatMap((result, index) =>
			result.status === "rejected" ? [published[index]] : [],
		);
		if (incomplete.length)
			failure = {
				error: new Error(
					`Conversion failed and rollback left cloned files: ${incomplete.join(", ")}`,
					{ cause: error },
				),
			};
	}
	for (const file of staged) {
		try {
			await unlink(file.temporary);
		} catch {
			warnings.push(`Temporary file cleanup failed: ${file.temporary}`);
		}
	}
	if (failure) throw failure.error;
	if (process.platform !== "win32") {
		try {
			for (const location of new Set(files.map((file) => dirname(file.path)))) {
				const directory = await open(location, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} catch {
			warnings.push(
				"Clone published, but directory sync failed; crash durability could not be confirmed.",
			);
		}
	}
	return {
		path,
		warnings,
		sessionId,
		name: preview.name,
		source: snapshot.path,
		sourceSha256: snapshot.sha256,
		descendants: copied.map((copy) => ({
			source: copy.source.path,
			path: copy.path,
			sessionId: copy.sessionId,
			mode: descendantClones.has(copy.source.path) ? "restructured" : "copied",
		})),
	};
}
