import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateAdmissionTokens } from "../../extensions/navigate-tree/index.ts";
import { AUTOMATIC_CONFIG, AUTOMATIC_REQUEST, seedCorpus } from "./fixture.ts";
import { interceptRuntime, parseOptions, runAcceptance } from "./run.ts";

it("dry run writes only synthetic evidence without opening a ledger or contacting providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "fold-runner-test-"));
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no network allowed");
  };
  try {
    const ledger = join(root, "budget.jsonl"),
      out = join(root, "evidence");
    const options = parseOptions([
      "--out",
      out,
      "--ledger",
      ledger,
      "--blocks",
      "2",
      "--auth-dir",
      join(root, "does-not-exist"),
      "--dry-run",
    ]);
    await runAcceptance(options);
    assert.equal(calls, 0);
    assert.equal(existsSync(ledger), false);
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    assert.equal(result.dispatched, 0);
    assert.ok(result.sourceBytes > 10_000);
    const original = readFileSync(join(out, "fixture.json"));
    await assert.rejects(runAcceptance(options), /EEXIST/);
    assert.deepEqual(readFileSync(join(out, "fixture.json")), original);
  } finally {
    globalThis.fetch = oldFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

it("runs the production manual fold and subsequent main turn through an isolated SDK session", async () => {
  const root = mkdtempSync(join(tmpdir(), "fold-runner-sdk-"));
  const calls: boolean[] = [];
  try {
    const options = parseOptions([
      "--out",
      join(root, "out"),
      "--ledger",
      join(root, "ledger.jsonl"),
      "--auth-dir",
      root,
      "--model",
      "acceptance-test",
      "--blocks",
      "2",
    ]);
    await runAcceptance(options, async () => {
      const runtime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: join(root, "models.json"),
        allowModelNetwork: false,
      });
      runtime.registerProvider("openrouter", {
        baseUrl: "http://127.0.0.1:0",
        api: "fold-local-test",
        apiKey: "local-test-only",
        models: [
          {
            id: "acceptance-test",
            name: "Acceptance test",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple: (_model, _context, opts) => {
          const side = opts?.toolChoice === "none";
          calls.push(side);
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() =>
            stream.end(
              fauxAssistantMessage(
                side
                  ? "## Goal\nContinue the synthetic audit.\n\n## Progress\n### Done\n- [x] Audit complete.\n"
                  : "ACCEPTANCE-CONTINUED: compare the next supplied change.",
              ),
            ),
          );
          return stream;
        },
      });
      return runtime;
    });
    assert.ok(calls[0]);
    assert.equal(calls.at(-1), false);
    const result = JSON.parse(
      readFileSync(join(root, "out", "result.json"), "utf8"),
    );
    assert.equal(result.passed, true);
    assert.ok(result.afterTokens < result.initialTokens);
    assert.equal(result.afterBudget.spentUsd, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("automatic dry run records the opt-in policy and finalization fixture without runtime or network", async () => {
  const root = mkdtempSync(join(tmpdir(), "fold-auto-dry-"));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("no network allowed");
  };
  try {
    const options = parseOptions([
      "--scenario",
      "automatic",
      "--out",
      join(root, "out"),
      "--ledger",
      join(root, "ledger.jsonl"),
      "--dry-run",
    ]);
    assert.equal(options.blocks, 8);
    assert.equal(options.window, 96000);
    assert.equal(options.ledger, join(root, "ledger.jsonl"));
    await runAcceptance(options, async () => {
      throw new Error("runtime must not open");
    });
    assert.equal(existsSync(options.ledger), false);
    const fixture = JSON.parse(
      readFileSync(join(options.out, "fixture.json"), "utf8"),
    );
    assert.equal(fixture.request, AUTOMATIC_REQUEST);
    assert.ok(fixture.corpus.join("").length > 16000);
    const sm = SessionManager.create(root, join(root, "sessions"));
    seedCorpus(sm, fixture.corpus, true);
    const initialTokens = estimateAdmissionTokens(sm);
    assert.ok(initialTokens > AUTOMATIC_CONFIG.auto_navigate.rewind_at_tokens);
    assert.ok(initialTokens > 4000);
    assert.ok(initialTokens + 16384 < options.window);
    assert.match(
      JSON.stringify(sm.getBranch().at(-1)),
      /Synthetic completed review phase/,
    );
    assert.doesNotMatch(
      fixture.request,
      /rewind|navigate_tree|classifier|confidence/i,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(options.out, "auto-config.json"), "utf8")),
      AUTOMATIC_CONFIG,
    );
  } finally {
    globalThis.fetch = oldFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

it("intercepts chat and Decisions runtime calls with the same fetch and zero retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "fold-intercept-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      allowModelNetwork: false,
    });
    const seen: unknown[] = [];
    const calls: Parameters<Parameters<typeof interceptRuntime>[2]>[0][] = [];
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("must not dispatch");
    };
    const stream = createAssistantMessageEventStream();
    runtime.streamSimple = (_model, _context, options) => {
      seen.push(options);
      return stream;
    };
    runtime.classify = async (model, _context, options) => {
      seen.push(options);
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: {},
        stopReason: "stop",
        timestamp: 1,
      };
    };
    interceptRuntime(runtime, fetch, (call) => calls.push(call));
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    runtime.streamSimple(
      {
        id: "chat",
        provider: "openrouter",
        api: "openai-completions",
        name: "Local chat",
        baseUrl: "http://127.0.0.1:0",
        reasoning: false,
        input: ["text"],
        contextWindow: 96000,
        maxTokens: 1024,
        cost,
      },
      { messages: [] },
      { maxRetries: 9 },
    );
    const classified = await runtime.classify(
      {
        type: "classifier",
        id: "decisions",
        provider: "openrouter",
        api: "typesafe",
        name: "Local Decisions",
        baseUrl: "http://127.0.0.1:0",
        input: ["text"],
        contextWindow: 96000,
        cost,
      },
      { state: {}, questions: {} },
      { maxRetries: 9 },
    );
    assert.equal(classified.stopReason, "stop");
    assert.deepEqual(seen, [
      { maxRetries: 0, fetch },
      { maxRetries: 0, fetch },
    ]);
    assert.deepEqual(
      calls.map(({ api, model, side }) => ({ api, model, side })),
      [
        { api: "chat", model: "openrouter/chat", side: false },
        { api: "decisions", model: "openrouter/decisions", side: true },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects malformed scenarios and unsafe fixture sizes before execution", () => {
  for (const args of [
    ["--scenario", "unknown"],
    ["--scenario", "automatic"],
    ["--scenario", "automatic", "--ledger", "relative-copy.jsonl"],
    ["--blocks", "NaN"],
    ["--blocks", "0"],
    ["--window", "-1"],
  ]) {
    assert.throws(() => parseOptions(["--out", "/unused", ...args]));
  }
});
