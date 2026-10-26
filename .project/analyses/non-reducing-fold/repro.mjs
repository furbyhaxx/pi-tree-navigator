// Offline reproduction for .project/analyses/non-reducing-fold/report.md.
// Read-only: parses a copied session file, never builds a SessionManager, prints
// counts and token estimates only (no message text).
//
//   node .project/analyses/non-reducing-fold/repro.mjs /tmp/<copy>/session.jsonl
import { readFileSync } from "node:fs";
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { estimateContentTokens } from "../../../src/core/context-tokens.ts";
import { projectHandoffs } from "../../../src/fold/handoff-projection.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: repro.mjs <session.jsonl>");
const all = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// State at the failed fold: everything persisted up to the failed summary
// attempt; the anchor `live-acceptance-shipped` and the rewind turn follow.
const at = (id) => all.findIndex((e) => e.id === id);
const entries = all.slice(0, at("328ef699") + 1);
const leaf = "328ef699";
const byId = new Map(entries.map((e) => [e.id, e]));
const path = [];
for (let cur = leaf; cur && byId.has(cur); cur = byId.get(cur).parentId)
  path.push(byId.get(cur));
path.reverse();

const label = entries.find(
  (e) => e.type === "label" && e.label === "anchor:live-acceptance-shipped",
);
const target = label.targetId;
const compactionAt = path.findLastIndex((e) => e.type === "compaction");
const targetAt = path.findIndex((e) => e.id === target);
const content = (messages) =>
  messages.reduce(
    (sum, m) => (m.role === "system" ? sum : sum + estimateTokens(m)),
    0,
  );

console.log("label entry       ", label.id, "-> targetId", target);
console.log("path positions     target", targetAt, "compaction", compactionAt);
console.log(
  "target is pre-compaction:",
  targetAt >= 0 && targetAt < compactionAt,
);

// `first` of the summary instruction (`Summarize only messages N onwards`).
const raw = buildSessionProjection(entries, leaf);
let seen = 0;
let first = null;
for (const entry of raw.entries) {
  for (const m of convertToLlm(entry.messages))
    if (m.role !== "system" && !(m.role === "assistant" && isEmpty(m))) seen++;
  if (entry.sourceEntry.id === target) first = seen + 1;
}
console.log("instruction `first`", first, "(live instruction said 23)");

// Before: the live, compaction-aware projection up to the rewind call.
const current = projectHandoffs(buildSessionProjection(entries, leaf), entries);
const rewindAt = current.entries.findIndex(
  (e) => e.sourceEntry.id === "3694e95d",
);
const before = estimateContentTokens(
  current.entries.slice(0, rewindAt).flatMap((e) => e.messages),
);
console.log("foldEstimateBefore", before, "(live: 141515)");
console.log(
  "  of which system   ",
  before - content(current.entries.slice(0, rewindAt).flatMap((e) => e.messages)),
);

// After: the same construction completeRewind uses (index.ts:3017-3035).
function after(parent, reportChars) {
  const preview = {
    type: "branch_summary",
    id: "tree-navigator-fold-preview",
    parentId: parent,
    timestamp: "",
    fromId: leaf,
    summary: "x".repeat(reportChars),
    details: {},
    fromHook: true,
  };
  const list = [...entries, preview];
  const projection = projectHandoffs(
    buildSessionProjection(list, preview.id),
    list,
  );
  return {
    entries: projection.entries.length,
    compactionOnPath: projection.entries.some(
      (e) => e.sourceEntry.type === "compaction",
    ),
    tokens: estimateContentTokens(projection.messages),
  };
}

const actual = after(target, 0);
console.log("foldEstimateAfter  ", actual);
console.log("  +7940-char handoff", after(target, 7940).tokens, "(live: 218367)");
console.log(
  "counterfactual: parent = newest post-compaction entry",
  after("22ed4097", 0),
);

function isEmpty(message) {
  const content = message.content;
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return false;
  return content.every(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length === 0,
  );
}
