/**
 * Live acceptance for model-refined tree proposals (pi-tree-navigator).
 *
 * Drives the real exported product paths against a completed long-context
 * session and a real provider:
 *   readSessionSnapshot -> resolveProposalModel -> createProposalModelRunner
 *   -> proposeTree -> validateTreeProposal -> saveTreeProposal
 *   -> previewRetrospectiveSession -> cloneRetrospectiveSession -> SessionManager.open
 *
 * Read-only for the product source. The one source session is copied byte for
 * byte into this analysis directory; every plan, preview and clone lands here.
 * Wire evidence (request payload, response status, safe headers, parsed provider
 * stream events) is written next to this script. Authorization/cookie header
 * values are never recorded.
 *
 * Usage:
 *   node run-proposal-acceptance.ts [--runs full,calls-only] [--model openai/gpt-6-luna:low]
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { proposeTree } from "../../../../extensions/navigate-tree/proposal-engine.ts";
import { createProposalModelRunner, resolveProposalModel } from "../../../../extensions/navigate-tree/proposal-model.ts";
import { saveTreeProposal, validateTreeProposal } from "../../../../extensions/navigate-tree/proposal-command.ts";
import type { ProposalOptions } from "../../../../extensions/navigate-tree/proposal-options.ts";
import { cloneRetrospectiveSession, previewRetrospectiveSession } from "../../../../extensions/navigate-tree/retrospective.ts";
import {
  readSessionSnapshot,
  type SessionSnapshot,
  sha256,
  validateCompleteToolCalls,
} from "../../../../extensions/navigate-tree/retrospective-plan.ts";

const AUTH_PATH = "/home/furbyhaxx/.pi/agent/auth.json";
const MODELS_PATH = "/home/furbyhaxx/.pi/agent/models.json";
let OUT = import.meta.dirname;
const SOURCE =
  "/mnt/Projects/furbyhaxx/pi-tree-navigator/.project/analyses/live-acceptance/parallel-01/agent-2/2026-10-23T08-56-15-857Z_01a167f9-a2f0-7612-b26a-071008d88c15.jsonl";
const SAFE_HEADER =
  /^(content-type|date|server|retry-after|x-request-id|request-id|openai-processing-ms|x-ratelimit-[a-z-]+|cf-ray|via)$/i;

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const runs = option("--runs", "full,calls-only")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "full" || value === "calls-only");
const selector = option("--model", "openai/gpt-6-luna:low");
const planArg = option("--plan", "");
const verifyArg = option("--verify-clone", "");
const tag = option("--tag", "");
const prefix = tag ? `${tag}-` : "";
OUT = resolve(option("--out", OUT));

const RUN_OPTIONS: Record<"full" | "calls-only", ProposalOptions> = {
  full: { model: selector, tools: {} },
  "calls-only": { model: selector, tools: { load_partition: "calls-only" } },
};

class Evidence {
  readonly path: string;
  private readonly gzip = createGzip();
  private readonly file;
  probe = { maxPayloadBytes: 0, withheldMarker: false, partitionText: false };
  readonly requests: {
    request: number;
    payloadBytes?: number;
    payloadSha256?: string;
    status?: number;
    streamEvents?: number;
    startedAt: string;
    firstByteMs?: number;
  }[] = [];

  constructor(path: string) {
    this.path = path;
    this.file = createWriteStream(path, { mode: 0o600 });
    this.gzip.pipe(this.file);
  }

  write(value: Record<string, unknown>) {
    this.gzip.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
  }

  entry(request: number) {
    let entry = this.requests.find((item) => item.request === request);
    if (!entry) {
      entry = { request, startedAt: new Date().toISOString() };
      this.requests.push(entry);
    }
    return entry;
  }

  async close() {
    this.gzip.end();
    await finished(this.file);
  }
}

function safeHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => SAFE_HEADER.test(name)),
  );
}

/** Registry proxy that records wire evidence without touching authentication. */
function instrumentedRegistry(
  registry: ModelRegistry,
  evidence: Evidence,
  started: number,
) {
  let request = 0;
  return {
    find: (provider: string, id: string) => registry.find(provider, id),
    hasConfiguredAuth: (model: Model<Api>) =>
      registry.hasConfiguredAuth(model),
    streamSimple: (
      model: Model<Api>,
      context: Parameters<ModelRegistry["streamSimple"]>[1],
      options: Parameters<ModelRegistry["streamSimple"]>[2],
    ) => {
      const current = ++request;
      const entry = evidence.entry(current);
      evidence.write({
        type: "request",
        request: current,
        model: { provider: model.provider, id: model.id, api: model.api },
        options: {
          reasoning: options?.reasoning,
          maxTokens: options?.maxTokens,
          toolChoice: options?.toolChoice,
        },
        messages: context.messages.length,
        systemPromptBytes: Buffer.byteLength(context.systemPrompt ?? ""),
      });
      return registry.streamSimple(model, context, {
        ...options,
        onPayload: (payload: unknown) => {
          const text = JSON.stringify(payload);
          entry.payloadBytes = Buffer.byteLength(text);
          entry.payloadSha256 = sha256(text);
          evidence.probe.maxPayloadBytes = Math.max(
            evidence.probe.maxPayloadBytes,
            entry.payloadBytes,
          );
          if (text.includes("calls-only: result content and details withheld"))
            evidence.probe.withheldMarker = true;
          if (/Partition \d\/4; SHA-256/.test(text))
            evidence.probe.partitionText = true;
          evidence.write({ type: "payload", request: current, payload });
        },
        onResponse: (response: { status: number; headers: Record<string, string> }) => {
          entry.status = response.status;
          evidence.write({
            type: "response",
            request: current,
            status: response.status,
            headers: safeHeaders(response.headers),
            totalMs: Date.now() - started,
          });
        },
        onProviderStreamEvent: (data: unknown) => {
          entry.streamEvents = (entry.streamEvents ?? 0) + 1;
          evidence.write({ type: "stream", request: current, data });
        },
      });
    },
  };
}

const hashes = (value: string | undefined) =>
  value?.match(/[a-f0-9]{64}/g) ?? [];

async function cloneAndVerify(
  planPath: string,
  snapshot: SessionSnapshot,
  preview: { previewToken: string; name: string; addedEntries: number },
) {
  const clone = await cloneRetrospectiveSession(planPath, preview.previewToken);
  const cloneBytes = await readFile(clone.path);
  const cloneHeader = JSON.parse(
    cloneBytes.subarray(0, cloneBytes.indexOf(10)).toString("utf8"),
  );
  const reopened = SessionManager.open(clone.path);
  return {
    path: clone.path,
    insideAnalysisDir: resolve(clone.path).startsWith(resolve(OUT)),
    sessionId: clone.sessionId,
    newSessionId: cloneHeader.id !== snapshot.header.id,
    headerIdMatches: cloneHeader.id === clone.sessionId,
    reopenIdMatches: reopened.getSessionId() === clone.sessionId,
    reopenName: reopened.getSessionName(),
    nameMatches: reopened.getSessionName() === preview.name,
    reopenEntryCount: reopened.getEntries().length,
    entryCountMatches:
      reopened.getEntries().length ===
      snapshot.entries.length + preview.addedEntries,
    sourceId: snapshot.header.id,
    sourceSha256Unchanged: snapshot.sha256,
    bytes: cloneBytes.length,
    warnings: clone.warnings,
  };
}

function flatten(groups: readonly any[], depth = 0): any[] {
  return groups.flatMap((group) => [
    { ...group, depth },
    ...flatten(group.children ?? [], depth + 1),
  ]);
}

async function main() {
  const started = Date.now();
  const inputDir = join(OUT, "input");
  const plansDir = join(OUT, "plans");
  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  await mkdir(plansDir, { recursive: true, mode: 0o700 });

  const originalBytes = await readFile(SOURCE);
  const originalSha = sha256(originalBytes);
  const localSource = join(inputDir, "source-copy.jsonl");
  await copyFile(SOURCE, localSource);
  const copySha = sha256(await readFile(localSource));

  const runtime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
  const registry = new ModelRegistry(runtime);
  const snapshot: SessionSnapshot = await readSessionSnapshot(localSource);
  validateCompleteToolCalls(snapshot);
  const labelNames = snapshot.entries.flatMap((entry) =>
    entry.type === "label" && entry.label ? [entry.label] : [],
  );
  const baseline = {
    originalSource: SOURCE,
    originalSha256: originalSha,
    originalBytes: originalBytes.length,
    localSource,
    localSourceSha256: copySha,
    localCopyMatchesOriginal: copySha === originalSha,
    originalHeaderId: snapshot.header.id,
    sessionName: snapshot.name,
    entries: snapshot.entries.length,
    safeCuts: snapshot.safeCuts.size,
    pendingToolCalls: snapshot.pendingToolCalls.length,
    labels: labelNames,
    toolResults: Object.fromEntries(
      Object.entries(
        snapshot.entries.reduce<Record<string, number>>((sizes, entry) => {
          if (entry.type === "message" && entry.message.role === "toolResult") {
            const name = entry.message.toolName;
            sizes[name] =
              (sizes[name] ?? 0) + Buffer.byteLength(JSON.stringify(entry));
          }
          return sizes;
        }, {}),
      ).sort((a, b) => b[1] - a[1]),
    ),
  };

  if (verifyArg) {
    const path = resolve(verifyArg);
    const bytes = await readFile(path);
    const reopened = SessionManager.open(path);
    console.log(
      JSON.stringify({
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        sessionId: reopened.getSessionId(),
        sessionName: reopened.getSessionName(),
        entries: reopened.getEntries().length,
        sourceHeaderId: snapshot.header.id,
        newSessionId: reopened.getSessionId() !== snapshot.header.id,
        sourceUnchanged: sha256(await readFile(SOURCE)) === originalSha,
      }),
    );
    return;
  }

  if (planArg) {
    const planPath = resolve(planArg);
    const preview = await previewRetrospectiveSession(planPath);
    const checks = await cloneAndVerify(planPath, snapshot, preview);
    const sourceUnchanged = sha256(await readFile(SOURCE)) === originalSha;
    await writeFile(
      join(OUT, "reuse-clone-check.json"),
      `${JSON.stringify({ plan: planPath, preview, clone: checks, sourceUnchanged, copyUnchanged: sha256(await readFile(localSource)) === copySha }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        type: "reuse",
        clone: checks.path,
        reopenIdMatches: checks.reopenIdMatches,
        sourceUnchanged,
      }),
    );
    return;
  }

  const summaries: Record<string, unknown>[] = [];
  for (const run of runs) {
    const tag = `${prefix}${run === "full" ? "run-1-full" : "run-2-calls-only"}`;
    const evidence = new Evidence(join(OUT, `${tag}-wire.jsonl.gz`));
    const outputs = createWriteStream(join(OUT, `${tag}-model-outputs.jsonl`), {
      mode: 0o600,
    });
    const runStarted = Date.now();
    const notes: string[] = [];
    const instrumented = instrumentedRegistry(registry, evidence, runStarted);

    const selected = resolveProposalModel({
      registry: instrumented,
      currentModel: undefined,
      currentThinking: "low" as ReturnType<ExtensionAPI["getThinkingLevel"]>,
      selector,
    });
    const realModel = registry.find(selected.model.provider, selected.model.id);
    if (!realModel) throw new Error(`registry lost ${selector}`);
    const baseRunner = createProposalModelRunner({
      registry: instrumented,
      model: realModel,
      thinking: selected.thinking,
    });
    let call = 0;
    const runner = {
      name: baseRunner.name,
      contextWindow: baseRunner.contextWindow,
      maxOutputTokens: baseRunner.maxOutputTokens,
      async complete(request: {
        systemPrompt: string;
        text: string;
        signal?: AbortSignal;
      }) {
        const index = ++call;
        const response = await baseRunner.complete(request);
        writeModelOutput(outputs, {
          call: index,
          promptBytes: Buffer.byteLength(request.text),
          responseBytes: Buffer.byteLength(response.text),
          responseSha256: sha256(response.text),
          usage: response.usage,
          text: response.text,
        });
        return response;
      },
    };

    const signal = AbortSignal.timeout(20 * 60 * 1000);
    const proposal = await proposeTree(snapshot, {
      input: RUN_OPTIONS[run],
      model: runner,
      signal,
      onProgress: (message) => notes.push(message),
    });
    const validated = validateTreeProposal(snapshot, proposal);
    const groups = flatten(validated.plan.groups);
    const uniqueClaims = [
      ...new Set(
        groups.flatMap((group) => [
          ...hashes(group.summary),
          ...hashes(group.outcome),
          ...hashes(group.goal),
        ]),
      ),
    ];
    const sourceText = originalBytes.toString("utf8");
    const planPath = join(plansDir, `${tag}.json`);
    const saved = await saveTreeProposal(snapshot, validated.plan, planPath);
    const preview = await previewRetrospectiveSession(saved);

    const previewChecks = {
      sourceMatchesSnapshot: preview.source === snapshot.path,
      shaMatches: preview.sourceSha256 === snapshot.sha256,
      originalEntries: preview.originalEntries === snapshot.entries.length,
      groupCountMatches: preview.groups.length === groups.length,
      descendants: preview.descendants.length,
      addedEntries: preview.addedEntries,
    };

    const cloneChecks =
      run === "full"
        ? await cloneAndVerify(saved, snapshot, preview)
        : undefined;

    const afterOriginal = sha256(await readFile(SOURCE));
    const afterCopy = sha256(await readFile(localSource));
    const summary = {
      tag,
      run,
      elapsedMs: Date.now() - runStarted,
      runner: baseRunner.name,
      contextWindow: baseRunner.contextWindow,
      maxOutputTokens: baseRunner.maxOutputTokens,
      modelRequests: call,
      progress: notes,
      proposal: {
        method: proposal.method,
        validatedMethod: validated.method,
        calls: proposal.calls,
        usage: proposal.usage,
        inputTokens: proposal.usage.reduce((sum, item) => sum + item.input, 0),
        cacheReadTokens: proposal.usage.reduce((sum, item) => sum + item.cacheRead, 0),
        outputTokens: proposal.usage.reduce((sum, item) => sum + item.output, 0),
        cost: proposal.usage.reduce((sum, item) => sum + item.cost.total, 0),
        warnings: proposal.warnings,
        modelWarnings: validated.warnings,
      },
      plan: {
        path: saved,
        source: validated.plan.source,
        sourceSha256: validated.plan.sourceSha256,
        nameSuffix: validated.plan.nameSuffix,
        parentHandoffMode: validated.plan.parentHandoffMode,
        groups: groups.length,
        folded: groups.filter((group) => group.state === "folded").length,
        open: groups.filter((group) => group.state === "open").length,
        maxDepth: Math.max(...groups.map((group) => group.depth)),
        names: groups.map((group) => group.name),
        summaries: groups.map((group) => ({
          name: group.name,
          state: group.state,
          firstEntryId: group.firstEntryId,
          lastEntryId: group.lastEntryId,
          title: group.title,
          summary: group.summary,
        })),
      },
      sourceGrounding: {
        claimedHashes: uniqueClaims.length,
        verifiedHashes: uniqueClaims.filter((value) => sourceText.includes(value)).length,
        unverifiedHashes: uniqueClaims.filter((value) => !sourceText.includes(value)),
        labelCollisions: groups.filter((group) =>
          labelNames.some((label) => label.replace(/^(anchor|branch):/, "") === group.name),
        ).length,
        omittedToolPayloadWarning: proposal.warnings.some((warning) =>
          warning.includes("omitted by disclosure rules"),
        ),
        withheldMarkerInWire: evidence.probe.withheldMarker,
        partitionTextInWire: evidence.probe.partitionText,
        maxPayloadBytes: evidence.probe.maxPayloadBytes,
      },
      preview: previewChecks,
      clone: cloneChecks,
      integrity: {
        wirePath: evidence.path,
        requests: evidence.requests,
        sourceUnchanged: afterOriginal === originalSha,
        copyUnchanged: afterCopy === copySha,
        copyMatchesOriginal: copySha === originalSha,
      },
    };
    await evidence.close();
    await new Promise<void>((done) => outputs.end(done));
    summaries.push(summary);
    console.log(
      JSON.stringify({
        type: "run",
        tag,
        method: summary.proposal.method,
        calls: summary.proposal.calls,
        inputTokens: summary.proposal.inputTokens,
        outputTokens: summary.proposal.outputTokens,
        groups: summary.plan.groups,
        folded: summary.plan.folded,
        warnings: summary.proposal.warnings,
        sourceUnchanged: summary.integrity.sourceUnchanged,
      }),
    );
  }

  if (runs.length)
    await writeFile(
      join(OUT, `${prefix}evidence-summary.json`),
      `${JSON.stringify({ baseline, runs: summaries }, null, 2)}\n`,
      { mode: 0o600 },
    );
  await writeFile(
    join(OUT, "package-versions.json"),
    `${JSON.stringify(
      {
        node: process.version,
        piCodingAgent: (
          await readFile(
            resolve(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-coding-agent/package.json"),
            "utf8",
          )
        ).match(/"version":\s*"([^"]+)"/)?.[1],
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

/** Append one model output line without buffering. */
async function writeModelOutput(stream: ReturnType<typeof createWriteStream>, value: unknown) {
  await new Promise<void>((done) => {
    if (stream.write(`${JSON.stringify(value)}\n`)) done();
    else stream.once("drain", () => done());
  });
}

await main();
