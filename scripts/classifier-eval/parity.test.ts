import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { RETIREMENT_YES } from "../../extensions/navigate-tree/retirement-check.ts";
import type { Billing, RouteTable } from "./billing.ts";
import { BudgetLedger } from "./budget.ts";
import {
  type BaseRegistry,
  type CallRecord,
  compareCase,
  compareLunaProbe,
  createMeter,
  type LiveCase,
  MeterRefusal,
  summarize,
} from "./parity.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalCase, EvalObservation } from "./types.ts";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "parity-test-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const TABLE: RouteTable = { retrievedAt: "test", source: [], models: {} };
const COST = { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 };
const MICROSOFT = {
  provider: "openrouter",
  id: "microsoft/microsoft-decision-1",
  cost: COST,
};
const LUNA = {
  provider: "openrouter",
  id: "openai/gpt-6-luna",
  cost: COST,
};

const billing = (costUsd: number | null): Billing => ({
  settle: async (evidence) =>
    evidence.dispatched
      ? { costUsd, costSource: costUsd === null ? "unknown" : "generation" }
      : { costUsd: 0, costSource: "local" },
  keyUsage: async () => ({
    usage: null,
    usageDaily: null,
    limit: null,
    limitRemaining: null,
  }),
});

const answered = (id: string, extra: object = {}) =>
  new Response(
    JSON.stringify({
      id,
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      ...extra,
    }),
  );

const CONTEXT = {
  state: { message: "Use spaces." },
  questions: {
    kind: { type: "choice", instructions: "kind?", criteria: { rule: "r" } },
  },
} as unknown as ClassifierContext;

describe("metering registry", () => {
  function setup(opts: { maxRunUsd?: number; cost?: number | null } = {}) {
    const ledger = BudgetLedger.open(join(directory, "ledger.jsonl"), 1);
    const meter = createMeter({
      ledger,
      billing: billing(opts.cost === undefined ? 0.00002 : opts.cost),
      table: TABLE,
      fetch: async () => answered("gen-1"),
      sessionId: "run-1",
      maxRunUsd: opts.maxRunUsd ?? 1,
    });
    return { ledger, meter };
  }

  it("reserves the worst case before dispatch, forbids retries, caps the route price and settles from billing", async () => {
    const { ledger, meter } = setup();
    const seen: {
      held: number;
      options: Record<string, unknown>;
      wire: unknown;
    }[] = [];
    const base = {
      classify: async (
        _model: unknown,
        _context: unknown,
        options: Record<string, unknown> & {
          onPayload: (p: unknown) => unknown;
          fetch: typeof fetch;
        },
      ) => {
        const wire = options.onPayload({ model: "m", state: {} });
        await options.fetch("https://openrouter.test/decide", {
          method: "POST",
          body: JSON.stringify(wire),
        });
        seen.push({ held: ledger.snapshot().heldUsd, options, wire });
        return {
          answers: {
            kind: {
              type: "choice",
              choice: "rule",
              confidence: 0.9,
              probabilities: {},
            },
          },
          stopReason: "stop",
        };
      },
    } as unknown as BaseRegistry;
    meter.setCase("case-1");
    const result = await meter
      .registry(base)
      .classify(MICROSOFT as never, CONTEXT);
    await meter.settled();
    assert.equal(result.stopReason, "stop");
    assert.ok(seen[0] && seen[0].held > 0, "held before the request was sent");
    assert.equal(seen[0]?.options.maxRetries, 0);
    assert.deepEqual(seen[0]?.wire, {
      model: "m",
      state: {},
      provider: { max_price: { prompt: "0.1", completion: "0.5" } },
    });
    const [call] = meter.calls as CallRecord[];
    assert.equal(call?.caseId, "case-1");
    assert.equal(call?.generationId, "gen-1");
    assert.equal(call?.costUsd, 0.00002);
    assert.equal(call?.costSource, "generation");
    assert.deepEqual(call?.answers, {
      kind: { choice: "rule", confidence: 0.9 },
    });
    assert.match(call?.requestSha256 ?? "", /^[0-9a-f]{64}$/);
    const after = ledger.snapshot();
    assert.equal(after.heldUsd, 0);
    assert.equal(after.spentUsd, 0.00002);
    ledger.close();
  });

  it("a chat call keeps the product's payload edits, adds the route ceiling and records the reply text", async () => {
    const { ledger, meter } = setup();
    let wire: unknown;
    const base = {
      streamSimple: (
        _model: unknown,
        _context: unknown,
        options: {
          maxRetries: number;
          onPayload: (p: unknown, m: unknown) => Promise<unknown>;
          fetch: typeof fetch;
        },
      ) => ({
        result: async () => {
          wire = await options.onPayload(
            { tool_choice: "none", model: "m" },
            {},
          );
          await options.fetch("https://openrouter.test/chat", {
            method: "POST",
            body: JSON.stringify(wire),
          });
          assert.equal(options.maxRetries, 0);
          return {
            stopReason: "stop",
            responseId: "gen-chat-1",
            content: [{ type: "text", text: '{"answers":{}}' }],
          };
        },
      }),
    } as unknown as BaseRegistry;
    meter.setCase("case-2");
    const message = await meter
      .registry(base)
      .streamSimple(
        LUNA as never,
        {
          systemPrompt: "s",
          messages: [{ role: "user", content: "u", timestamp: 0 }],
        },
        {
          maxTokens: 1024,
          onPayload: (payload) => {
            const { tool_choice: _unused, ...rest } = payload as Record<
              string,
              unknown
            >;
            return { ...rest, response_format: { type: "json_schema" } };
          },
        },
      )
      .result();
    await meter.settled();
    assert.equal(message.content[0]?.type, "text");
    assert.deepEqual(wire, {
      model: "m",
      response_format: { type: "json_schema" },
      provider: { max_price: { prompt: "0.1", completion: "0.5" } },
    });
    assert.equal(meter.calls[0]?.text, '{"answers":{}}');
    assert.equal(meter.calls[0]?.generationId, "gen-1");
    ledger.close();
  });

  it("refuses a call that would pass the run ceiling before anything is sent", async () => {
    const { ledger, meter } = setup({ maxRunUsd: 0.0001 });
    let dispatched = false;
    const base = {
      classify: async () => {
        dispatched = true;
        return { answers: {}, stopReason: "stop" };
      },
    } as unknown as BaseRegistry;
    await assert.rejects(
      () => meter.registry(base).classify(MICROSOFT as never, CONTEXT),
      MeterRefusal,
    );
    assert.equal(dispatched, false);
    assert.match(meter.refused() ?? "", /run ceiling/);
    assert.equal(ledger.snapshot().heldUsd, 0);
    ledger.close();
  });

  it("an unknown cost keeps the full hold and is recorded as unknown", async () => {
    const { ledger, meter } = setup({ cost: null });
    const base = {
      classify: async (
        _m: unknown,
        _c: unknown,
        options: { fetch: typeof fetch },
      ) => {
        await options.fetch("https://openrouter.test/decide", {
          method: "POST",
          body: "{}",
        });
        return { answers: {}, stopReason: "stop" };
      },
    } as unknown as BaseRegistry;
    await meter.registry(base).classify(MICROSOFT as never, CONTEXT);
    await meter.settled();
    assert.equal(meter.calls[0]?.costUsd, null);
    assert.ok(ledger.snapshot().heldUsd > 0);
    ledger.close();
  });
});

describe("comparison with the benchmark", () => {
  const fixture: EvalCase = {
    id: "swap-tabs",
    split: "holdout",
    family: "swap",
    task: "supersession",
    input: {
      type: "intent",
      message: "From now on use spaces, not tabs.",
      activeItems: [{ id: "R1", kind: "rule", text: "Use tabs" }],
    },
    expected: {
      kind: {
        choices: ["rule"],
        unsafeChoices: ["ephemeral"],
        rationale: "rule",
      },
      contradicts: {
        choices: ["R1"],
        unsafeChoices: ["none"],
        rationale: "replaces",
      },
    },
  };
  const prepared = prepareCase(fixture);

  const observation = (
    model: string,
    repetition: number,
    answers: EvalObservation["answers"],
    requestSha256?: string,
  ): EvalObservation => ({
    caseId: "swap-tabs",
    model,
    adapter: model.startsWith("chat") ? "chat" : "decisions",
    repetition,
    status: "ok",
    answers,
    durationMs: 1,
    costUsd: 0,
    costSource: "generation",
    costBoundUsd: 0,
    startedAt: "2026-10-23T00:00:00.000Z",
    ...(requestSha256 && { requestSha256 }),
  });
  const MICRO = "decisions:microsoft/microsoft-decision-1";
  const CHAT = "chat:openai/gpt-6-luna";
  const kind = { choice: "rule", confidence: 0.99 };
  const benchmark = [
    observation(
      MICRO,
      0,
      { kind, contradicts: { choice: "R1", confidence: 0.4 } },
      "h1",
    ),
    observation(
      MICRO,
      1,
      { kind, contradicts: { choice: "R1", confidence: 0.4 } },
      "h1",
    ),
    observation(
      MICRO,
      2,
      { kind, contradicts: { choice: "none", confidence: 0.9 } },
      "h1",
    ),
    observation(CHAT, 0, {
      kind,
      contradicts: { choice: "R1", confidence: 0.9 },
    }),
    observation(CHAT, 1, {
      kind,
      contradicts: { choice: "R1", confidence: 0.9 },
    }),
    observation(CHAT, 2, {
      kind,
      contradicts: { choice: "R1", confidence: 0.9 },
    }),
  ];

  const call = (over: Partial<CallRecord>): CallRecord => ({
    seq: 1,
    caseId: "swap-tabs",
    kind: "classify",
    model: "microsoft/microsoft-decision-1",
    status: "ok",
    durationMs: 1,
    costBoundUsd: 0.001,
    costUsd: 0.00001,
    costSource: "generation",
    ...over,
  });
  const live = (supersedes: string[] | undefined): LiveCase => ({
    caseId: "swap-tabs",
    verdict: {
      kind: "rule",
      by: "classifier",
      ...(supersedes && { supersedes }),
    },
    calls: [
      call({
        requestSha256: "h1",
        answers: { kind, contradicts: { choice: "R1", confidence: 0.3 } },
      }),
      call({
        kind: "chat",
        model: "openai/gpt-6-luna",
        text: JSON.stringify({
          answers: { contradicts: { choice: "R1", confidence: 0.92 } },
        }),
      }),
      // The shipped preset confirms an escalated retirement with a second model.
      call({
        answers: { retires: { choice: RETIREMENT_YES, confidence: 0.95 } },
      }),
    ],
  });

  it("cannot replay a recorded retirement the shipped policy now verifies", async () => {
    // The benchmark predates the retirement-verification stage: its recorded
    // answers never ask `retires`, so replaying escalated retirements abstains.
    const result = await compareCase(prepared, live(["R1"]), benchmark);
    assert.deepEqual(result.benchmarkVerdicts, [
      "rule|none",
      "rule|none",
      "rule|none",
    ]);
    assert.deepEqual(result.agreement, {
      requestSha256: true,
      microsoftKind: true,
      microsoftContradicts: true,
      lunaContradicts: true,
      verdictModal: false,
      verdictAnyRepetition: false,
    });
    assert.equal(result.liveUnsafe, 0);
    assert.equal(result.liveUnsafeAccepted, 0);
    assert.equal(result.benchmarkUnsafeAccepted, 1);
    assert.equal(result.liveExact, true);
    assert.equal(result.benchmarkUnsafe, 3);
    assert.equal(result.benchmarkExactRepetitions, 0);
  });

  it("flags a different verdict, a different request and an unsafe live answer", async () => {
    const other = live(undefined);
    const first = other.calls[0] as CallRecord;
    const result = await compareCase(
      prepared,
      { ...other, calls: [{ ...first, requestSha256: "other" }] },
      benchmark,
    );
    assert.equal(result.agreement.requestSha256, false);
    // Every recorded repetition abstains without the verification stage, so the
    // unchecked verdict is the modal one here.
    assert.equal(result.agreement.verdictModal, true);
    assert.equal(result.agreement.verdictAnyRepetition, true);
    assert.equal(result.agreement.lunaContradicts, null);
    assert.equal(result.liveUnsafe, 1);
    assert.equal(result.liveUnsafeAccepted, 0);
  });

  it("compares a Luna probe with the recorded Luna answers, and skips an unreadable reply", () => {
    const probe = (text: string) =>
      call({ kind: "chat", model: "openai/gpt-6-luna", text });
    const reply = (choice: string, confidence: number) =>
      JSON.stringify({ answers: { contradicts: { choice, confidence } } });
    assert.equal(
      compareLunaProbe(prepared, probe(reply("R1", 0.9)), benchmark),
      true,
    );
    assert.equal(
      compareLunaProbe(prepared, probe(reply("none", 0.9)), benchmark),
      false,
    );
    assert.equal(
      compareLunaProbe(prepared, probe(reply("R1", 0.4)), benchmark),
      false,
    );
    assert.equal(
      compareLunaProbe(prepared, probe("not json"), benchmark),
      null,
    );
  });

  it("summarizes per task and split", async () => {
    const results = [
      await compareCase(prepared, live(["R1"]), benchmark),
      await compareCase(prepared, live(undefined), benchmark),
    ];
    const [row] = summarize(results);
    assert.equal(row?.task, "supersession");
    assert.equal(row?.split, "holdout");
    assert.equal(row?.cases, 2);
    // The recorded benchmark abstains everywhere without the verification stage.
    assert.equal(row?.verdictModal, "1/2");
    // Only the live case without a supersession matches a recorded repetition.
    assert.equal(row?.verdictAnyRepetition, "1/2");
    assert.equal(row?.liveUnsafe, 1);
  });
});
