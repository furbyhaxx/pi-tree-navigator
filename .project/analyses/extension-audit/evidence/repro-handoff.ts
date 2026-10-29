import { makeHandoff } from "../../../../src/fold/handoff.ts";
import { handoffRow, handoffUsage } from "../../../../src/ui/handoff-renderer.ts";
const marker = "hello\x1b]0;AUDIT_TITLE\x07world";
const data = makeHandoff({
  name: "audit", title: marker, goal: "Synthetic", outcome: marker,
  report: "Synthetic report", mode: "digest", children: [],
  sourceEntries: [{type: "message", id: "u1", parentId: null, timestamp: "2026-10-29T17:00:00+01:00", message: {role: "user", content: "Synthetic", timestamp: 1}}]
});
console.log(JSON.stringify({rawOscSurvivesRow: handoffRow(data).includes("\x1b]0;AUDIT_TITLE\x07"), usageRecords: data.stats.usageRecords, renderedAccounting: handoffUsage(data)}));
