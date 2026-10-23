#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const root = path.resolve(process.argv[2] ?? ".project/analyses/live-acceptance/parallel-01");
const parseLines = (text) => text.trim().split("\n").filter(Boolean).map(JSON.parse);
const input = (message) => (message?.usage?.input ?? 0) + (message?.usage?.cacheRead ?? 0) + (message?.usage?.cacheWrite ?? 0);
const textOnly = (payload) => payload.tool_choice === "none" || payload.tool_choice?.type === "none" || payload.config?.toolConfig?.functionCallingConfig?.mode === "NONE";
const results = [];
for (const dir of (await readdir(root)).filter((p) => /^agent-\d+$/.test(p)).sort()) {
  const base = path.join(root, dir);
  const outcome = JSON.parse(await readFile(path.join(base, "outcome.json"), "utf8"));
  const file = (await readdir(base)).find((p) => p.endsWith(".jsonl"));
  const entries = parseLines(await readFile(path.join(base, file), "utf8"));
  const wire = parseLines(gunzipSync(await readFile(path.join(base, "wire.jsonl.gz"))).toString("utf8"));
  const requests = wire.filter((e) => e.type === "request");
  const summaryRequests = requests.filter((e) => {
    const last = (e.payload.input ?? e.payload.messages ?? e.payload.contents ?? []).at(-1);
    const content = last?.content ?? last?.parts;
    const text = typeof content === "string"
      ? content
      : (content ?? []).map((block) => block.text ?? "").join("\n");
    return text.startsWith("[navigate_tree]\nSummarize only messages ");
  });
  const assistants = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
  const folds = [];
  for (const e of entries.filter((e) => e.type === "custom_message" && e.customType === "navigate-tree-rewind" && e.details?.status === "done")) {
    const at = entries.indexOf(e);
    const summary = entries.find((s) => s.id === e.details.summaryId);
    const summaryAt = entries.indexOf(summary);
    const preceding = entries.slice(0, summaryAt).filter((s) => s.type === "message" && s.message.role === "assistant");
    const writer = preceding.at(-1)?.message;
    const previous = preceding.at(-2)?.message;
    const next = entries.slice(at + 1).find((s) => s.type === "message" && ["assistant", "user"].includes(s.message.role));
    const beforeSummary = entries.slice(0, summaryAt);
    const endedCalls = new Set(beforeSummary.filter((s) => s.type === "custom" && s.customType === "navigate-tree-rewind-outcome").map((s) => s.data?.toolCallId));
    const original = beforeSummary.findLast((s) => s.type === "custom_message" && s.customType === "navigate-tree-summary-request" && s.details?.newLabel === e.details.newLabel && !endedCalls.has(s.details?.toolCallId));
    const ledger = summary.details.continuity;
    folds.push({ name: e.details.newLabel, summaryId: summary.id, summaryChars: summary.summary.length, reportChars: summary.details.treeNavigator.report.length, summaryInput: input(writer), summaryCacheRead: writer?.usage?.cacheRead, previousInput: input(previous), cacheRatio: input(previous) > 0 ? writer.usage.cacheRead / input(previous) : 0, nextInput: input(next?.message), reductionRatio: 1 - input(next?.message) / input(writer), sameRunContinuation: next?.message.role === "assistant", nextTools: next?.message.content?.filter((c) => c.type === "toolCall").map((c) => c.name) ?? [], summaryRequestFound: Boolean(original), protectedRuleRetained: ledger.items.some((item) => item.kind === "rule" && item.source?.origin === "user" && item.status === "active" && item.text.includes("never edit the source")), ledgerItems: ledger.items.length, continuation: e.details });
  }
  const finalBranch = new Map(entries.map((e) => [e.id, e]));
  const branch = [];
  for (let e = entries.at(-1); e; e = finalBranch.get(e.parentId)) branch.push(e);
  const finalContext = branch.filter((e) => e.type === "branch_summary").map((e) => e.summary).join("\n");
  const manifest = JSON.parse(await readFile(path.join(root, "corpus-manifest.json"), "utf8"));
  const hashesInActiveHandoffs = manifest.partitions.every((p) => finalContext.includes(p.sha256));
  const errors = assistants.filter((e) => e.message.stopReason === "error").map((e) => e.message.errorMessage);
  const failures = [];
  if (process.argv.includes("--require-text-only")) {
    if (summaryRequests.length < folds.length) failures.push("summary request capture incomplete");
    if (summaryRequests.some((e) => !textOnly(e.payload))) failures.push("pending summary request did not disable tools");
  }
  if (!outcome.submitted) failures.push("report not accepted");
  if (folds.length !== 4) failures.push(`expected 4 folds, saw ${folds.length}`);
  if (outcome.userMessages !== 1) failures.push(`expected one user prompt, saw ${outcome.userMessages}`);
  if (!hashesInActiveHandoffs) failures.push("partition hash missing from final active handoffs");
  if (outcome.extensionErrors.length) failures.push("extension errors recorded");
  for (const fold of folds) {
    if (!fold.sameRunContinuation) failures.push(`${fold.name}: no same-run continuation`);
    if (!fold.protectedRuleRetained) failures.push(`${fold.name}: user rule missing`);
    if (fold.nextInput >= fold.summaryInput) failures.push(`${fold.name}: no observed input reduction`);
    if (fold.cacheRatio < 0.95) failures.push(`${fold.name}: cache gate below 95%`);
    if (!fold.summaryRequestFound) failures.push(`${fold.name}: summary request missing`);
  }
  const result = { agent: dir, model: outcome.model, lens: outcome.lens, started: outcome.started, finished: outcome.finished, submitted: outcome.submitted, requests: requests.length, summaryRequests: summaryRequests.length, textOnlySummaryRequests: summaryRequests.filter((e) => textOnly(e.payload)).length, wireResponses: wire.filter((e) => e.type === "response").map((e) => e.status), rawStreamEvents: wire.filter((e) => e.type === "stream").length, requestBytes: requests.map((e) => Buffer.byteLength(JSON.stringify(e.payload))), peakInputTokens: outcome.peakInputTokens, inputTokensCumulative: outcome.inputTokensCumulative, cacheReadTokens: outcome.cacheReadTokens, outputTokens: outcome.outputTokens, userMessages: outcome.userMessages, hashesInActiveHandoffs, folds, errors, failures };
  results.push(result);
  console.log(JSON.stringify({ agent: dir, folds: folds.length, submitted: result.submitted, peak: result.peakInputTokens, cumulative: result.inputTokensCumulative, minCacheRatio: Math.min(...folds.map((f) => f.cacheRatio)), minReduction: Math.min(...folds.map((f) => f.reductionRatio)), failures }));
}
const summary = { agents: results.length, folds: results.reduce((n, r) => n + r.folds.length, 0), inputTokensCumulative: results.reduce((n, r) => n + r.inputTokensCumulative, 0), peakInputTokens: Math.max(...results.map((r) => r.peakInputTokens)), cacheReadTokens: results.reduce((n, r) => n + r.cacheReadTokens, 0), outputTokens: results.reduce((n, r) => n + r.outputTokens, 0), passed: results.every((r) => !r.failures.length), results };
await writeFile(path.join(root, "analysis.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, results: undefined }));
if (!summary.passed) process.exitCode = 1;
