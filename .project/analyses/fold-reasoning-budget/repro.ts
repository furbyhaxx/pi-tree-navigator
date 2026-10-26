// Live reproduction of the chunked-summary `length` failure on reasoning models.
// Synthetic evidence only; records options, stop reasons and usage, never credentials.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { BudgetLedger } from "../../../scripts/classifier-eval/budget.ts";
import { buildCorpus } from "../../../scripts/fold-acceptance/fixture.ts";

const { values } = parseArgs({
  options: {
    impl: { type: "string" },
    provider: { type: "string", default: "claude" },
    model: { type: "string", default: "claude-opus-5-5" },
    thinking: { type: "string", default: "medium" },
    blocks: { type: "string", default: "20" },
    "map-tokens": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.out || !["old", "new"].includes(values.impl ?? ""))
  throw new Error("--impl old|new and --out are required");
const out = resolve(values.out);
mkdirSync(out);

const summarizer = await import(
  values.impl === "old"
    ? "../../../extensions/navigate-tree/fold-summarizer.main.tmp.ts"
    : "../../../src/fold/fold-summarizer.ts"
);
const agentDir = join(homedir(), ".pi", "agent");
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "models-store.json"),
  allowModelNetwork: false,
});
const registry = new ModelRegistry(runtime);
const model = registry.find(values.provider, values.model);
if (!model || !registry.hasConfiguredAuth(model))
  throw new Error(`${values.provider}/${values.model} unavailable`);
// Shared live-spend ledger: reserve each call's worst case before dispatch.
const ledger = BudgetLedger.open(
  resolve(".project/analyses/classifier-eval/budget-ledger.jsonl"),
  25,
);

const recordingRegistry = {
  streamSimple(
    selected: Parameters<ModelRegistry["streamSimple"]>[0],
    context: Parameters<ModelRegistry["streamSimple"]>[1],
    options: Parameters<ModelRegistry["streamSimple"]>[2],
  ) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    // Upper bounds: one token per two characters, cache writes at 1.25x input,
    // and the full response ceiling at the output price.
    const inputTokens = JSON.stringify(context).length / 2;
    const ceiling = options?.maxTokens ?? selected.maxTokens;
    const worstUsd =
      (inputTokens * selected.cost.input * 1.25 +
        ceiling * selected.cost.output) /
      1e6;
    const reservation = randomUUID();
    ledger.reserve(reservation, Math.max(worstUsd, 0.0001));
    const stream = registry.streamSimple(selected, context, options);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      const message = await result();
      const cost = message.usage?.cost?.total;
      ledger.settle(
        reservation,
        typeof cost === "number" && cost > 0 ? Math.min(cost, worstUsd) : null,
      );
      appendFileSync(
        join(out, "calls.jsonl"),
        `${JSON.stringify({
          startedAt,
          durationMs: Date.now() - started,
          model: `${selected.provider}/${selected.id}`,
          reasoning: options?.reasoning ?? null,
          maxTokens: options?.maxTokens,
          toolChoice: options?.toolChoice,
          inputChars: JSON.stringify(context.messages).length,
          reservedUsd: worstUsd,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage ?? null,
          usage: message.usage,
          textChars: message.content
            .filter((block) => block.type === "text")
            .reduce((sum, block) => sum + block.text.length, 0),
        })}\n`,
      );
      return message;
    };
    return stream;
  },
};

const runner = summarizer.createFoldSummaryRunner({
  registry: recordingRegistry,
  model,
  thinking: values.thinking,
  sessionId: `fold-reasoning-repro-${values.impl}`,
});
const records = buildCorpus(Number(values.blocks)).map((text, index) => ({
  id: `b${index + 1}`,
  role: "tool" as const,
  text,
}));
const result = await summarizer.summarizeFold({
  runner,
  focus:
    "Latest request: finish the synthetic service audit and report each service's retry and validation findings.",
  segment: { background: "", records },
  admit: () => ({ fits: false, inputEstimate: Number.POSITIVE_INFINITY }),
  ...(values["map-tokens"]
    ? { limits: { mapOutputTokens: Number(values["map-tokens"]) } }
    : {}),
  onProgress: (progress: unknown) =>
    appendFileSync(
      join(out, "progress.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), progress })}\n`,
    ),
});
const summary = {
  impl: values.impl,
  model: `${values.provider}/${values.model}`,
  thinking: values.thinking,
  blocks: Number(values.blocks),
  mapOutputTokens: values["map-tokens"] ? Number(values["map-tokens"]) : null,
  evidenceChars: records.reduce((sum, record) => sum + record.text.length, 0),
  ok: result.ok,
  ...(result.ok
    ? {
        strategy: result.strategy,
        calls: result.calls,
        chunks: result.chunks,
        summaryChars: result.text.length,
      }
    : { reason: result.reason, detail: result.detail, calls: result.calls }),
};
writeFileSync(join(out, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
ledger.close();
if (result.ok) writeFileSync(join(out, "summary.md"), result.text);
console.log(JSON.stringify(summary));
