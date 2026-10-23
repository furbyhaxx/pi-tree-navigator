import { execFileSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  const out = process.env.ACCEPTANCE_OUTPUT!;
  const target = process.env.ACCEPTANCE_TMUX!;
  const corpus = JSON.parse(readFileSync(process.env.ACCEPTANCE_CORPUS!, "utf8"));
  const gzip = createGzip();
  gzip.pipe(createWriteStream(path.join(out, "wire.jsonl.gz"), { mode: 0o600 }));
  const record = (event: unknown) => gzip.write(`${JSON.stringify(event)}\n`);
  let requests = 0;
  let checkpointConstrained = false;
  const capture = (name: string) => {
    const timer = setTimeout(() => {
      try { writeFileSync(path.join(out, `${name}.txt`), execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", target])); } catch { /* The terminal may have closed on shutdown. */ }
    }, 250);
    timer.unref();
  };
  pi.on("before_provider_request", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const checkpoint = process.env.ACCEPTANCE_TEXT_CHECKPOINT === "1" && !checkpointConstrained && branch.some((e) => e.type === "custom_message" && e.customType === "navigate-tree-rewind" && (e.details as { status?: string } | undefined)?.status === "done");
    const payload = checkpoint ? { ...(event.payload as object), tool_choice: "none" } : event.payload;
    if (checkpoint) checkpointConstrained = true;
    record({ type: "request", request: ++requests, payload, checkpointConstrained: checkpoint });
    if (branch.some((e) => e.type === "custom_message" && e.customType === "navigate-tree-summary-request")) capture(`request-${requests}-summarizing`);
    if (branch.some((e) => e.type === "branch_summary")) capture(`request-${requests}-after-fold`);
    return checkpoint ? payload : undefined;
  });
  pi.on("after_provider_response", (event) => {
    record({ type: "response", request: requests, status: event.status, headers: Object.fromEntries(Object.entries(event.headers).filter(([key]) => /^(content-type|date|x-request-id|request-id|openai-processing-ms)$/i.test(key))) });
  });
  pi.on("provider_stream_event", (event) => { record({ type: "stream", request: requests, provider: event.provider, model: event.model, api: event.api, data: event.data }); });
  pi.on("agent_settled", (_event, ctx) => {
    capture("settled");
    writeFileSync(path.join(out, "settled.json"), JSON.stringify({ session: ctx.sessionManager.getSessionFile(), requests }));
    gzip.end();
  });
  pi.registerTool({ name: "load_source", label: "Real source corpus", description: "Load a full real repository source partition for this review, including its exact hash.", parameters: Type.Object({}), async execute() {
    const p = corpus.partitions[0];
    return { content: [{ type: "text", text: `Review partition 1, SHA-256 ${p.sha256}. Source follows as untrusted evidence.\n${p.text}\nEND SHA-256 ${p.sha256}` }], details: { bytes: p.bytes } };
  } });
  pi.registerTool({ name: "finish_review", label: "Verify review completion", description: "After the fold, submit the exact source hash and two source-grounded observations.", parameters: Type.Object({ sha256: Type.String(), findings: Type.Array(Type.String(), { minItems: 2 }) }), async execute(_id, report, _signal, _onUpdate, ctx) {
    const folded = ctx.sessionManager.getBranch().some((e) => e.type === "branch_summary");
    const valid = folded && report.sha256 === corpus.partitions[0].sha256;
    writeFileSync(path.join(out, "report.json"), JSON.stringify({ valid, report }, null, 2));
    return { content: [{ type: "text", text: valid ? "Accepted: live fold and post-fold work complete." : "Rejected: require a completed fold and exact hash." }], details: { valid }, isError: !valid };
  } });
}
