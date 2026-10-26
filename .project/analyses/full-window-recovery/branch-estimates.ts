/**
 * Read-only estimator reconstruction for the full-window-recovery analysis.
 *
 *   node branch-estimates.ts <session.jsonl> [entryId ...]
 *
 * Prints aggregate counts, estimator values and per-anchor percentages only:
 * no prompt text, no tool-result text. Never constructs a SessionManager, so
 * the session file is only read.
 */
import { readFileSync } from "node:fs";
import {
  buildSessionProjection,
  calculateContextTokens,
  convertToLlm,
  estimateTokens,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { projectHandoffs, invalidateStaleUsage } from "/mnt/Projects/furbyhaxx/pi-tree-navigator/src/fold/handoff-projection.ts";
import {
  estimateContentTokens,
  estimateContextTokens,
  estimateRequestTokens,
  splitContextEstimate,
} from "/mnt/Projects/furbyhaxx/pi-tree-navigator/src/core/context-tokens.ts";

// index.ts ANCHOR_MANDATE, duplicated so this script does not import the
// extension entry point (which patches AgentSession on import).
const ANCHOR_MANDATE =
  "navigate_tree: gather all context, then anchor `context-gathered`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.";
const MANDATE_TOKENS = Math.ceil(ANCHOR_MANDATE.length / 3.5);

const [sessionPath, ...entryIds] = process.argv.slice(2);
const entries = parseSessionEntries(readFileSync(sessionPath, "utf8")).filter(
  (entry) => entry.type !== "version",
) as Array<Record<string, any>>;
const byId = new Map(entries.map((entry) => [entry.id, entry]));

function messagesAt(entryId: string) {
  const projection = buildSessionProjection(entries, entryId, byId);
  const mapped = invalidateStaleUsage(
    projectHandoffs(projection, entries).entries.map((entry) => ({
      sourceEntry: entry.sourceEntry,
      messages: entry.messages,
    })),
    projection.model,
  ) as Array<{ sourceEntry: any; messages: any[] }>;
  return { model: projection.model, messages: mapped.flatMap((e) => e.messages) };
}

function branchOf(leafId: string) {
  const out: Array<Record<string, any>> = [];
  let cur: string | null = leafId;
  while (cur) {
    const entry = byId.get(cur);
    if (!entry) break;
    out.push(entry);
    cur = entry.parentId;
  }
  return out.reverse();
}

const labels = new Map<string, string[]>();
for (const entry of entries) {
  if (entry.type !== "label") continue;
  labels.set(entry.targetId, [...(labels.get(entry.targetId) ?? []), entry.label]);
}

function perAnchor(leafId: string, contextWindow: number) {
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of branchOf(leafId)) {
    for (const label of labels.get(entry.id) ?? []) {
      if (!label.startsWith("anchor:")) continue;
      const { messages } = messagesAt(entry.id);
      const tokens = estimateContextTokens(messages);
      rows.push({
        anchor: label.slice("anchor:".length),
        entryId: entry.id,
        type: entry.type,
        tokens,
        pct: `${((tokens / contextWindow) * 100).toFixed(1)}%`,
      });
    }
  }
  const { messages } = messagesAt(leafId);
  const total = estimateContextTokens(messages);
  const { baseline, tail } = splitContextEstimate(messages);
  return {
    leaf: leafId,
    total,
    totalPct: `${((total / contextWindow) * 100).toFixed(1)}%`,
    baseline,
    tail,
    newestAnchors: rows.slice(-5).map((row) => ({
      ...row,
      savable: Math.max(0, total - (row.tokens as number)),
    })),
  };
}

for (const entryId of entryIds) {
  const { messages, model } = messagesAt(entryId);
  const converted = convertToLlm(messages);
  const roles: Record<string, number> = {};
  for (const message of messages) roles[message.role] = (roles[message.role] ?? 0) + 1;
  let toolTokens = 0;
  for (const message of messages) if (message.role === "toolResult") toolTokens += estimateTokens(message);
  const content = estimateContentTokens(messages);
  const request = estimateRequestTokens(messages);
  const leaf = byId.get(entryId);
  const contextWindow = 372_000;
  let newestUsage: Record<string, unknown> | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message.role !== "assistant" || !message.usage) continue;
    if (calculateContextTokens(message.usage) <= 0) continue;
    newestUsage = {
      stopReason: message.stopReason,
      recordedPrompt:
        (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0),
      baseline: calculateContextTokens(message.usage),
      tailAfter: messages.slice(i + 1).reduce((sum, m) => sum + estimateTokens(m), 0),
    };
    break;
  }
  console.log(
    JSON.stringify(
      {
        entryId,
        type: leaf?.type,
        model,
        messageCount: messages.length,
        convertedCount: converted.length,
        roles,
        toolTokens,
        contentEstimate: content,
        contextEstimate: estimateContextTokens(messages),
        requestEstimate: request,
        guardTotal: request + MANDATE_TOKENS,
        guardCeiling: contextWindow - 1_024 - 4_096,
        contentCeiling: Math.floor(((contextWindow - 1_024 - 4_096 - MANDATE_TOKENS) * 7) / 8),
        content8of7: Math.ceil((content * 8) / 7),
        newestUsage,
        anchors: perAnchor(entryId, contextWindow),
      },
      null,
      1,
    ),
  );
}
