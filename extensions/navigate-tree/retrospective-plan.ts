import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type FileEntry,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { HandoffMode } from "./handoff.ts";
import { extractTextContent, isValidName } from "./helpers.ts";

/** A completed range, inclusive of both endpoints, optionally divided into subphases. */
export interface RetrospectiveGroup {
  readonly name: string;
  readonly firstEntryId: string;
  readonly lastEntryId: string;
  readonly summary: string;
  readonly title?: string;
  readonly goal?: string;
  readonly outcome?: string;
  readonly state: "folded" | "open";
  readonly mode?: HandoffMode;
  readonly children: readonly RetrospectiveGroup[];
}

/** An explicit, reviewable restructuring plan bound to one source snapshot. */
export interface RetrospectivePlan {
  readonly version: 1;
  readonly source: string;
  readonly sourceSha256: string;
  readonly nameSuffix: string;
  readonly parentHandoffMode: HandoffMode;
  readonly recurse: boolean;
  readonly descendantPlans: readonly string[];
  readonly groups: readonly RetrospectiveGroup[];
}

/** A strict snapshot; reading never opens a writable Pi session manager. */
export interface SessionSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly header: SessionHeader;
  readonly entries: SessionEntry[];
  readonly name: string;
  readonly safeCuts: ReadonlySet<number>;
  readonly pendingToolCalls: readonly string[];
}

/** Hash source bytes or a preview contract. */
export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where} must be a non-empty string`);
  }
  return value;
}

function knownKeys(
  value: Record<string, unknown>,
  keys: string[],
  where: string,
) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unknown ${where} field: ${key}`);
  }
}

/** Parse a plan without silently accepting misspelled fields or empty summaries. */
export function parseRetrospectivePlan(value: unknown): RetrospectivePlan {
  const plan = object(value, "Plan");
  knownKeys(
    plan,
    [
      "version",
      "source",
      "sourceSha256",
      "nameSuffix",
      "groups",
      "parentHandoffMode",
      "recurse",
      "descendantPlans",
    ],
    "plan",
  );
  if (plan.version !== 1) throw new Error("Plan version must be 1");
  const hash = string(plan.sourceSha256, "sourceSha256");
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("sourceSha256 must be a SHA-256 hex digest");
  const mode = (value: unknown): HandoffMode => {
    if (value !== "full" && value !== "synthesized")
      throw new Error("Handoff mode must be full or synthesized");
    return value;
  };
  const names = new Set<string>();
  function groups(value: unknown, depth: number): RetrospectiveGroup[] {
    if (!Array.isArray(value))
      throw new Error("groups/children must be arrays");
    if (depth > 32) throw new Error("Plan exceeds 32 nesting levels");
    return value.map((raw) => {
      const group = object(raw, "Group");
      knownKeys(
        group,
        [
          "name",
          "title",
          "goal",
          "outcome",
          "state",
          "mode",
          "firstEntryId",
          "lastEntryId",
          "summary",
          "children",
        ],
        "group",
      );
      const name = string(group.name, "Group name");
      if (!isValidName(name) || names.has(name)) {
        throw new Error(
          `Group name must be unique kebab-case (at most 40 characters): ${name}`,
        );
      }
      names.add(name);
      const state = group.state ?? "folded";
      if (state !== "folded" && state !== "open")
        throw new Error(`${name}.state must be folded or open`);
      const optionalText = (key: string) =>
        group[key] === undefined
          ? undefined
          : string(group[key], `${name}.${key}`);
      const children = groups(group.children ?? [], depth + 1);
      if (
        state === "folded" &&
        children.some((child) => child.state === "open")
      )
        throw new Error(
          `${name}: an open child cannot be folded into its parent`,
        );
      return {
        name,
        firstEntryId: string(group.firstEntryId, `${name}.firstEntryId`),
        lastEntryId: string(group.lastEntryId, `${name}.lastEntryId`),
        summary:
          state === "open" && group.summary === undefined
            ? ""
            : string(group.summary, `${name}.summary`).trim(),
        title: optionalText("title"),
        goal: optionalText("goal"),
        outcome: optionalText("outcome"),
        state,
        mode: group.mode === undefined ? undefined : mode(group.mode),
        children,
      };
    });
  }
  const parsedGroups = groups(plan.groups, 0);
  if (!parsedGroups.length)
    throw new Error("Plan must contain at least one group");
  const nameSuffix = string(plan.nameSuffix ?? " (restructured)", "nameSuffix");
  if (
    [...nameSuffix].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error("nameSuffix must be a single printable line");
  return {
    version: 1,
    source: string(plan.source, "source"),
    sourceSha256: hash,
    nameSuffix,
    parentHandoffMode: mode(plan.parentHandoffMode ?? "full"),
    recurse:
      plan.recurse === undefined
        ? false
        : (() => {
            if (typeof plan.recurse !== "boolean")
              throw new Error("recurse must be a boolean");
            return plan.recurse;
          })(),
    descendantPlans:
      plan.descendantPlans === undefined
        ? []
        : (() => {
            if (!Array.isArray(plan.descendantPlans))
              throw new Error("descendantPlans must be an array of plan paths");
            return plan.descendantPlans.map((path) =>
              string(path, "descendant plan path"),
            );
          })(),
    groups: parsedGroups,
  };
}

/** Read a plan, resolving its source relative to the plan's directory. */
export async function readRetrospectivePlan(
  path: string,
): Promise<RetrospectivePlan> {
  const planPath = await realpath(path);
  const plan = parseRetrospectivePlan(
    JSON.parse(await readFile(planPath, "utf8")),
  );
  return {
    ...plan,
    source: resolve(dirname(planPath), plan.source),
    descendantPlans: plan.descendantPlans.map((path) =>
      resolve(dirname(planPath), path),
    ),
  };
}

function validateRecord(value: unknown, line: number): void {
  const entry = object(value, `Line ${line}`);
  string(entry.type, `Line ${line} type`);
  string(entry.id, `Line ${line} id`);
  string(entry.timestamp, `Line ${line} timestamp`);
  if (entry.type === "session") {
    if (line !== 1 || entry.version !== 3)
      throw new Error("Expected one version-3 session header on line 1");
    string(entry.cwd, "Session cwd");
    return;
  }
  if (line === 1) throw new Error("Line 1 must be a session header");
  if (
    ![
      "message",
      "model_change",
      "thinking_level_change",
      "usage",
      "compaction",
      "context_edit",
      "branch_summary",
      "custom",
      "custom_message",
      "label",
      "session_info",
    ].includes(String(entry.type))
  )
    throw new Error(`Line ${line}: unsupported entry type ${entry.type}`);
  if (entry.parentId !== null) string(entry.parentId, `Line ${line} parentId`);
  if (entry.type === "message") {
    const message = object(entry.message, `Line ${line} message`);
    string(message.role, `Line ${line} message role`);
    if (
      ![
        "user",
        "assistant",
        "toolResult",
        "system",
        "custom",
        "bashExecution",
        "branchSummary",
        "compactionSummary",
      ].includes(String(message.role))
    )
      throw new Error(`Line ${line}: unsupported message role ${message.role}`);
    if (
      typeof message.timestamp !== "number" ||
      !Number.isFinite(message.timestamp)
    )
      throw new Error(`Line ${line}: invalid message timestamp`);
    if (message.role === "bashExecution") {
      if (
        typeof message.command !== "string" ||
        typeof message.output !== "string" ||
        typeof message.cancelled !== "boolean" ||
        typeof message.truncated !== "boolean"
      )
        throw new Error(`Line ${line}: invalid shell execution message`);
    }
    if (
      message.role === "branchSummary" ||
      message.role === "compactionSummary"
    )
      string(message.summary, `Line ${line} summary`);
    if (message.role === "assistant") {
      string(message.provider, `Line ${line} provider`);
      string(message.model, `Line ${line} model`);
      string(message.api, `Line ${line} api`);
      string(message.stopReason, `Line ${line} stopReason`);
      object(message.usage, `Line ${line} usage`);
    }
    if (
      ["user", "assistant", "toolResult", "system", "custom"].includes(
        String(message.role),
      ) &&
      typeof message.content !== "string" &&
      !Array.isArray(message.content)
    ) {
      throw new Error(`Line ${line}: message content must be text or an array`);
    }
    if (message.role === "assistant" && !Array.isArray(message.content)) {
      throw new Error(`Line ${line}: assistant content must be an array`);
    }
    if (Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = object(raw, `Line ${line} content block`);
        string(block.type, `Line ${line} content type`);
        if (block.type === "toolCall") {
          if (message.role !== "assistant")
            throw new Error(
              `Line ${line}: tool calls require an assistant message`,
            );
          string(block.id, `Line ${line} tool call id`);
          string(block.name, `Line ${line} tool name`);
          object(block.arguments, `Line ${line} tool arguments`);
        }
      }
    }
    if (message.role === "toolResult") {
      string(message.toolCallId, `Line ${line} toolCallId`);
      string(message.toolName, `Line ${line} toolName`);
      if (typeof message.isError !== "boolean")
        throw new Error(`Line ${line}: tool result requires isError`);
    }
  }
  if (entry.type === "compaction") {
    string(entry.firstKeptEntryId, `Line ${line} firstKeptEntryId`);
    string(entry.summary, `Line ${line} summary`);
  }
  if (entry.type === "context_edit" || entry.type === "label") {
    string(entry.targetId, `Line ${line} targetId`);
  }
  if (entry.type === "context_edit" && entry.replacement !== null) {
    const replacement = object(entry.replacement, `Line ${line} replacement`);
    if (
      typeof replacement.content !== "string" &&
      !Array.isArray(replacement.content)
    ) {
      throw new Error(`Line ${line}: invalid context edit replacement`);
    }
  }
}

/** Read a linear session strictly; malformed JSON and non-linear histories are refused. */
export async function readSessionSnapshot(
  path: string,
): Promise<SessionSnapshot> {
  const canonicalPath = await realpath(path);
  const bytes = await readFile(canonicalPath);
  const content = bytes.toString("utf8");
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      if (index !== lines.length - 1)
        throw new Error(`Blank record on line ${index + 1}`);
      continue;
    }
    validateRecord(JSON.parse(line), index + 1);
  }
  const records: FileEntry[] = parseSessionEntries(content);
  const header = records[0];
  if (header?.type !== "session") throw new Error("Session header is missing");
  const entries = records.filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
  if (!entries.length) throw new Error("Session has no entries");
  const ids = new Set<string>();
  const safeCuts = new Set([-1]);
  const pending = new Set<string>();
  let previous: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) throw new Error(`Duplicate entry id: ${entry.id}`);
    if (entry.parentId !== previous) {
      throw new Error(
        `Source must be linear: ${entry.id} does not follow the previous record. Export a single branch first.`,
      );
    }
    ids.add(entry.id);
    previous = entry.id;
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type !== "toolCall") continue;
        if (pending.has(block.id))
          throw new Error(`Duplicate outstanding tool call ${block.id}`);
        pending.add(block.id);
      }
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult"
    ) {
      if (!pending.delete(entry.message.toolCallId))
        throw new Error(
          `Orphan tool result ${entry.id}: no outstanding call ${entry.message.toolCallId}`,
        );
    }
    if (!pending.size) safeCuts.add(index);
  }
  let name = header.id;
  for (const entry of entries)
    if (entry.type === "session_info" && entry.name) name = entry.name;
  return {
    path: canonicalPath,
    sha256: sha256(bytes),
    header,
    entries,
    name,
    safeCuts,
    pendingToolCalls: [...pending],
  };
}

/** Inspect stable IDs and user-turn boundaries without sending transcript data to a model. */
export async function inspectRetrospectiveSession(path: string) {
  const snapshot = await readSessionSnapshot(path);
  return {
    source: snapshot.path,
    sourceSha256: snapshot.sha256,
    sessionId: snapshot.header.id,
    name: snapshot.name,
    entries: snapshot.entries.length,
    lastEntryId: snapshot.entries.at(-1)?.id,
    pendingToolCalls: snapshot.pendingToolCalls,
    turns: snapshot.entries.flatMap((entry, index) =>
      entry.type === "message" && entry.message.role === "user"
        ? [
            {
              line: index + 2,
              id: entry.id,
              previousEntryId: entry.parentId,
              text: extractTextContent(entry.message.content).slice(0, 240),
            },
          ]
        : [],
    ),
    references: snapshot.entries.flatMap<{
      type: string;
      id: string;
      targetId: string;
    }>((entry) => {
      if (entry.type === "compaction")
        return [
          { type: entry.type, id: entry.id, targetId: entry.firstKeptEntryId },
        ];
      if (entry.type === "context_edit")
        return [{ type: entry.type, id: entry.id, targetId: entry.targetId }];
      return [];
    }),
  };
}
