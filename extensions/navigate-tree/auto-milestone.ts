import {
  buildSessionProjection,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readBranchLedger } from "./continuity-store.ts";
import { getHandoff } from "./handoff.ts";
import { projectHandoffs } from "./handoff-projection.ts";
import { LABEL_PREFIX } from "./helpers.ts";
import {
  MAX_MILESTONE_RECORDS,
  type MilestoneInput,
  type MilestoneRecord,
} from "./milestone-classifier.ts";
import type { ProposalToolMode } from "./proposal-options.ts";
import { buildProposalRecords } from "./proposal-source.ts";
import type { SessionSnapshot } from "./retrospective-plan.ts";

function snapshot(entries: SessionEntry[]): SessionSnapshot {
  return {
    path: "/auto-milestone-live.jsonl",
    sha256: "",
    header: {
      type: "session",
      version: 3,
      id: "live",
      cwd: "/",
      timestamp: "1970-01-01T00:00:00.000Z",
    },
    entries,
    name: "live",
    safeCuts: new Set(),
    pendingToolCalls: [],
  };
}

type DisclosedMessage = {
  role: string;
  content?:
    | string
    | {
        type: string;
        text?: string;
        name?: string;
        arguments?: unknown;
        omitted?: string;
      }[];
  command?: string;
  output?: string;
  toolName?: string;
  omitted?: string;
};

function readable(message: DisclosedMessage): string {
  if (message.role === "bashExecution")
    return [
      message.command && `[bash] ${message.command}`,
      message.omitted ? `[${message.omitted}]` : message.output,
    ]
      .filter(Boolean)
      .join("\n");
  if (message.omitted)
    return `[${message.toolName ?? "tool"}: ${message.omitted}]`;
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .flatMap((block) => {
      if (block.type === "text") return block.text ? [block.text] : [];
      if (block.type === "toolCall")
        return [
          `[tool call ${block.name}] ${block.omitted ?? JSON.stringify(block.arguments)}`,
        ];
      return [];
    })
    .join("\n");
}

/** Build bounded semantic evidence from the active projection, with tool disclosure applied. */
export function buildAutoMilestoneEvidence(options: {
  entries: SessionEntry[];
  leafId: string;
  getLabel: (id: string) => string | undefined;
  tools: Record<string, ProposalToolMode>;
}): {
  input: MilestoneInput;
  recordEntryIds: ReadonlyMap<string, string>;
  warnings: string[];
} {
  const { entries, leafId, getLabel, tools } = options;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let cursor = byId.get(leafId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();
  const disclosure = buildProposalRecords(snapshot(branch), { tools });
  const restricted = new Map<string, string>();
  for (const record of disclosure.records) {
    const value = JSON.parse(record.text) as {
      id: string;
      type: string;
      targetId?: string;
      omitted?: string;
      message?: DisclosedMessage;
    };
    if (value.message?.omitted)
      restricted.set(value.id, readable(value.message));
    if (
      value.type === "context_edit" &&
      value.omitted &&
      value.targetId &&
      !restricted.has(value.targetId)
    )
      restricted.set(
        value.targetId,
        "[restricted tool context replacement withheld]",
      );
  }
  const projected = projectHandoffs(
    buildSessionProjection(entries, leafId),
    entries,
  );
  const anchors = branch.flatMap((entry, index) => {
    const label = getLabel(entry.id);
    return label?.startsWith(LABEL_PREFIX)
      ? [{ name: label.slice(LABEL_PREFIX.length), id: entry.id, index }]
      : [];
  });
  const newest = anchors.at(-1);
  const after = new Set(
    branch.slice(newest ? newest.index + 1 : 0).map((entry) => entry.id),
  );
  const visible: SessionEntry[] = [];
  for (const { sourceEntry, messages } of projected.entries) {
    if (!after.has(sourceEntry.id)) continue;
    for (const message of messages) {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult" &&
        message.role !== "bashExecution"
      )
        continue;
      // Original ancestry decides exclusions even when an edit replaced its tool calls.
      const withheld = restricted.get(sourceEntry.id);
      visible.push({
        ...sourceEntry,
        type: "message",
        message:
          withheld === undefined
            ? message
            : {
                role: "user",
                content: withheld,
                timestamp: message.timestamp,
              },
      });
    }
  }
  const filtered = buildProposalRecords(snapshot(visible), { tools });
  const records: MilestoneRecord[] = [];
  for (const record of filtered.records) {
    const value = JSON.parse(record.text) as { message: DisclosedMessage };
    const text = readable(value.message);
    if (!text.trim()) continue;
    const original = byId.get(record.id);
    const role =
      original?.type === "message" ? original.message.role : value.message.role;
    records.push({
      id: record.id,
      role:
        role === "assistant" ? "assistant" : role === "user" ? "user" : "tool",
      text,
    });
  }
  const capped = records.slice(-MAX_MILESTONE_RECORDS);
  const recordEntryIds = new Map(
    capped.map((record) => [record.id, record.id]),
  );
  const ledger = readBranchLedger(branch);
  const active = ledger.ledger.items.filter((item) => item.status === "active");
  const folds = projected.entries.flatMap(({ sourceEntry, messages }) => {
    const handoff = messages.length ? getHandoff(sourceEntry) : undefined;
    return handoff
      ? [
          {
            label: handoff.name,
            title: handoff.title,
            goal: handoff.goal,
            outcome: handoff.outcome,
          },
        ]
      : [];
  });
  const warnings = [
    ...new Set([
      ...ledger.warnings,
      ...disclosure.warnings,
      ...filtered.warnings,
    ]),
  ];
  if (records.length > capped.length)
    warnings.push(
      `${records.length - capped.length} older milestone records omitted.`,
    );
  return {
    input: {
      records: capped,
      ...(newest && { lastAnchor: newest.name }),
      structure: {
        objective: active.find((item) => item.kind === "objective")?.text,
        goals: active
          .filter((item) => item.kind === "sub-goal")
          .map((item) => item.text),
        folds,
        anchors: anchors.map((anchor) => ({
          name: anchor.name,
          ...(recordEntryIds.has(anchor.id) && { afterRecordId: anchor.id }),
        })),
      },
    },
    recordEntryIds,
    warnings,
  };
}
