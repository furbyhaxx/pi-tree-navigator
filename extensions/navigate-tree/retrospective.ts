import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  getCurrentSystemMessage,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  buildSessionProjection,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  type RetrospectiveGroup,
  type RetrospectivePlan,
  readRetrospectivePlan,
  readSessionSnapshot,
  type SessionSnapshot,
  sha256,
} from "./retrospective-plan.ts";
import { buildStoredSummary } from "./summary-prompt.ts";

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
    tools: [...(system?.toolsAdded ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}

function validateRanges(
  snapshot: SessionSnapshot,
  plan: RetrospectivePlan,
): IndexedGroup[] {
  const { entries } = snapshot;
  const indices = new Map(entries.map((entry, index) => [entry.id, index]));
  const safeCuts = snapshot.safeCuts;
  if (snapshot.pendingToolCalls.length)
    throw new Error(
      `Source has unfinished tool calls: ${snapshot.pendingToolCalls.join(", ")}. Wait for the source session to finish before cloning.`,
    );
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
        throw new Error(
          `${group.name}: range is outside its parent or reversed`,
        );
      if (start <= previousEnd)
        throw new Error(
          `${group.name}: sibling ranges must be ordered and non-overlapping`,
        );
      previousEnd = end;
      if (!safeCuts.has(start - 1) || !safeCuts.has(end)) {
        throw new Error(
          `${group.name}: boundary splits a tool call from its results; move it to a completed tool batch`,
        );
      }
      for (const entry of entries) {
        if (entry.type !== "context_edit") continue;
        const target = indices.get(entry.targetId);
        const edit = indices.get(entry.id);
        if (target === undefined || edit === undefined || target >= edit)
          throw new Error(`Invalid context edit ${entry.id}`);
        const targetInside = target >= start && target <= end;
        const editInside = edit >= start && edit <= end;
        if (targetInside !== editInside) {
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
    original.flatMap((entry) =>
      entry.type === "label" && entry.label ? [entry.label] : [],
    ),
  );
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
  ) {
    let cursor = first;
    for (const range of children) {
      copy(cursor, range.first - 1);
      const parent = leaf;
      groups.push({
        name: range.group.name,
        depth,
        firstEntryId: range.group.firstEntryId,
        lastEntryId: range.group.lastEntryId,
        summary: range.group.summary,
      });
      for (const prefix of ["anchor:", "branch:"]) {
        if (reservedLabels.has(`${prefix}${range.group.name}`))
          throw new Error(`Label already exists: ${prefix}${range.group.name}`);
      }
      emit(range.first, range.last, range.children, depth + 1);
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
      append({
        id: summaryId,
        parentId: leaf,
        timestamp,
        type: "branch_summary",
        fromId,
        summary: buildStoredSummary(range.group.summary, [], []),
        fromHook: true,
        details: {
          retrospective: true,
          sourceSessionId: snapshot.header.id,
          firstEntryId: range.group.firstEntryId,
          lastEntryId: range.group.lastEntryId,
        },
      });
      labels.push({ targetId: summaryId, label: `anchor:${range.group.name}` });
      cursor = range.last + 1;
    }
    copy(cursor, last);
  }
  function copy(first: number, last: number) {
    for (let index = first; index <= last; index++) {
      const entry = original[index];
      if (entry.parentId !== leaf)
        changes.push({
          id: entry.id,
          originalParentId: entry.parentId,
          parentId: leaf,
        });
      append({ ...entry, parentId: leaf });
    }
  }
  emit(0, original.length - 1, ranges, 0);
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
    if (
      byId.has(entry.id) ||
      (entry.parentId !== null && !byId.has(entry.parentId))
    )
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
    if (
      entry.type === "compaction" &&
      !ancestors(entry).has(entry.firstKeptEntryId)
    ) {
      throw new Error(
        `Compaction ${entry.id} retains ${entry.firstKeptEntryId}, which a range removes from its branch. Move the range boundary before ${entry.firstKeptEntryId}, or merge the ranges.`,
      );
    }
    if (entry.type === "context_edit" && !ancestors(entry).has(entry.targetId))
      throw new Error(
        `Context edit ${entry.id} loses target ${entry.targetId}`,
      );
  }
  const active = activeLeaf ? byId.get(activeLeaf) : undefined;
  const activeIds = active ? ancestors(active) : new Set<string>();
  if (
    entries.some(
      (entry) => entry.type === "compaction" && activeIds.has(entry.id),
    )
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
  const beforeProjection = buildSessionProjection(original);
  const afterProjection = buildSessionProjection(entries, activeLeaf);
  const beforeById = new Map(
    beforeProjection.entries.map((entry) => [
      entry.sourceEntry.id,
      entry.messages,
    ]),
  );
  for (const entry of afterProjection.entries) {
    const before = beforeById.get(entry.sourceEntry.id);
    if (before && !isDeepStrictEqual(before, entry.messages))
      throw new Error(
        `Context edits would change surviving entry ${entry.sourceEntry.id}`,
      );
  }
}

async function prepare(path: string) {
  const plan = await readRetrospectivePlan(path);
  const snapshot = await readSessionSnapshot(plan.source);
  if (snapshot.sha256 !== plan.sourceSha256)
    throw new Error(
      "Source snapshot changed: inspect it again and review the plan against the new hash",
    );
  const clone = buildClone(snapshot, plan);
  const preview: RetrospectivePreview = {
    source: snapshot.path,
    sourceSha256: snapshot.sha256,
    name: clone.name,
    previewToken: sha256(JSON.stringify({ source: snapshot.path, plan })),
    originalEntries: snapshot.entries.length,
    addedEntries: clone.entries.length - snapshot.entries.length,
    groups: clone.groups,
    warnings: [
      "Summary accuracy is not machine-verifiable. Review every handoff before creating the clone.",
      "Extension-specific custom state remains on its original branch; external provider histories and extension sidecar files are not cloned.",
    ],
  };
  return { snapshot, clone, preview };
}

/** Validate a conversion and return its complete review surface without creating a session. */
export async function previewRetrospectiveSession(
  planPath: string,
): Promise<RetrospectivePreview> {
  return (await prepare(planPath)).preview;
}

/** Publish a new independently resumable session, only for the exact previewed plan and snapshot. */
export async function cloneRetrospectiveSession(
  planPath: string,
  previewToken: string,
) {
  const { snapshot, clone, preview } = await prepare(planPath);
  if (previewToken !== preview.previewToken)
    throw new Error(
      "Preview changed or missing; preview the plan again before creating a clone",
    );
  const sessionId = randomUUID();
  const dir = dirname(snapshot.path);
  const path = join(
    dir,
    `${clone.timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
  );
  const temporary = join(dir, `.tree-clone-${sessionId}.tmp`);
  const header = {
    ...snapshot.header,
    id: sessionId,
    timestamp: clone.timestamp,
    parentSession: snapshot.path,
  };
  const data = `${[header, ...clone.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  let failure: { error: unknown } | undefined;
  const warnings: string[] = [];
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    const reopened = SessionManager.open(temporary);
    if (
      reopened.getSessionId() !== sessionId ||
      reopened.getSessionName() !== preview.name ||
      reopened.getEntries().length !== clone.entries.length
    ) {
      throw new Error("Clone failed Pi session reload validation");
    }
    if (
      !isDeepStrictEqual(
        reopened.buildSessionContext(),
        buildSessionContext(clone.entries),
      )
    )
      throw new Error("Clone context changed after reloading");
    if (sha256(await readFile(snapshot.path)) !== snapshot.sha256)
      throw new Error(
        "Source changed during conversion; no clone was published",
      );
    await link(temporary, path);
    published = true;
  } catch (error) {
    failure = { error };
  }
  await handle.close();
  try {
    await unlink(temporary);
  } catch (error) {
    if (!published)
      throw new AggregateError(
        [failure?.error, error],
        `Conversion failed; remove temporary file ${temporary}`,
      );
    warnings.push(
      `Clone published, but temporary file cleanup failed: ${temporary}`,
    );
  }
  if (failure) throw failure.error;
  if (process.platform !== "win32") {
    try {
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
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
  };
}
