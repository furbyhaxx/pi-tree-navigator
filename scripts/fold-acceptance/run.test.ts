import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseOptions, runAcceptance } from "./run.ts";

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

it("rejects malformed scenarios and unsafe fixture sizes before execution", () => {
  for (const args of [
    ["--scenario", "unknown"],
    ["--blocks", "NaN"],
    ["--blocks", "0"],
    ["--window", "-1"],
  ]) {
    assert.throws(() => parseOptions(["--out", "/unused", ...args]));
  }
});
