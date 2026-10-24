import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createFoldSummaryRunner,
  type FoldSegmentRecord,
  type FoldSummaryProgress,
  type FoldSummaryRunner,
  reasoningAllowance,
  type SummarizeFoldOptions,
  summarizeFold,
} from "./fold-summarizer.ts";
import {
  buildConsolidationRequestText,
  buildSummaryRequestText,
  extractSummaryText,
} from "./summary-prompt.ts";

type Completion = Awaited<ReturnType<FoldSummaryRunner["complete"]>>;
type Request = Parameters<FoldSummaryRunner["complete"]>[0];

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const SUMMARY = "## Goal\nShip the fold.\n\n## Next Steps\n1. Verify.";
const FOCUS = "fold the integration work";
const BACKGROUND = "Goal: ship the independent folding engine.";
const PARENT = { mode: "synthesized", childCount: 2 } as const;
const CONTINUITY = "<continuity-delta>keep</continuity-delta>";
const SYSTEM = "LIVE SYSTEM PROMPT";
const TOOLS = [{ name: "navigate_tree" }] as unknown as Tool[];

const text = (message: Message | undefined): string => {
  const content = message && "content" in message ? message.content : "";
  return typeof content === "string"
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");
};
const lastText = (request: Request) => text(request.messages.at(-1));
const isFinal = (request: Request) =>
  lastText(request).startsWith("[navigate_tree]");
const isConsolidation = (request: Request) =>
  text(request.messages[0]).includes("Evidence notes to consolidate");

interface Harness {
  requests: Request[];
  runner: FoldSummaryRunner;
}

/** A fake runner recording every request; `reply` scripts the response. */
function harness(
  reply: (request: Request, index: number) => Partial<Completion> = () => ({}),
  contextWindow = 8000,
  thinking: FoldSummaryRunner["thinking"] = "off",
  maxOutputTokens = 2000,
): Harness {
  const requests: Request[] = [];
  const runner: FoldSummaryRunner = {
    name: "fake",
    contextWindow,
    maxOutputTokens,
    thinking,
    async complete(request) {
      const index = requests.length;
      requests.push(request);
      const scripted = reply(request, index);
      const body = isFinal(request)
        ? SUMMARY
        : isConsolidation(request)
          ? `CONSOLIDATED ${index}`
          : `NOTE ${index}`;
      return { text: body, stopReason: "stop", usage, ...scripted };
    },
  };
  return { requests, runner };
}

const BIG_ID = "big";
const bigText = Array.from(
  { length: 900 },
  (_, i) => `line ${i} é 日本語 😀 payload-${i}-${"x".repeat(20)}`,
).join("\n");

function records(): FoldSegmentRecord[] {
  const small = (id: string): FoldSegmentRecord => ({
    id,
    role: "assistant",
    text: `${id} says ${"y".repeat(3000)}`,
  });
  return [
    {
      id: "u1",
      role: "user",
      text: "Please fold; keep authorization verbatim.",
    },
    small("a1"),
    small("a2"),
    { id: BIG_ID, role: "tool", text: bigText },
    small("a3"),
    small("a4"),
  ];
}

function options(
  runner: FoldSummaryRunner,
  overrides: Partial<SummarizeFoldOptions> = {},
): SummarizeFoldOptions {
  return {
    runner,
    focus: FOCUS,
    parent: PARENT,
    continuitySection: CONTINUITY,
    segment: { background: BACKGROUND, records: records() },
    admit: () => ({ fits: false, inputEstimate: 999_999 }),
    limits: { mapOutputTokens: 200, reduceOutputTokens: 400 },
    ...overrides,
  };
}

const inContext = (
  first = 4,
): NonNullable<SummarizeFoldOptions["inContext"]> => ({
  systemPrompt: SYSTEM,
  tools: TOOLS,
  messages: [{ role: "user", content: "live work", timestamp: 1 }],
  first,
});

/** The evidence section of a map request: between its label line and the instruction. */
function evidenceOf(request: Request): string {
  const body = text(request.messages[0]);
  const start = body.indexOf("Evidence records ");
  const from = body.indexOf("\n", start) + 1;
  return body.slice(from, body.indexOf("\n\nExtract evidence notes"));
}

describe("summarizeFold chunked strategy", () => {
  it("covers every record once in order, splitting an oversized record losslessly, and ends with the exact r5d reduce", async () => {
    const { runner, requests } = harness();
    const progress: FoldSummaryProgress[] = [];
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        onProgress: (p) => progress.push(p),
      }),
    );
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.strategy, "chunked");
    assert.equal(result.text, extractSummaryText(SUMMARY));
    assert.ok(result.chunks > 1);
    assert.equal(result.calls, requests.length);
    assert.equal(result.calls, result.chunks + 1);
    assert.ok(result.calls <= 16);
    assert.equal(result.usage.length, result.calls);
    assert.ok(
      requests.every((r) => r.systemPrompt !== SYSTEM && !r.tools),
      "the live request must not be replayed when it does not fit",
    );

    const covered = result.coverage.flat();
    const deduped = covered.filter((id, i) => id !== covered[i - 1]);
    assert.deepEqual(
      deduped,
      records().map((r) => r.id),
    );
    assert.equal(result.coverage.length, result.chunks);

    const parts: string[] = [];
    const header = /\[big part (\d+)\/(\d+)\] tool:\n/;
    for (const request of requests.slice(0, -1)) {
      const evidence = evidenceOf(request);
      const match = header.exec(evidence);
      if (!match) continue;
      const rest = evidence.slice(match.index + match[0].length);
      const end = rest.search(/\n\n\[[a-z0-9 /]+\] \w+:\n/);
      parts.push(end < 0 ? rest : rest.slice(0, end));
      assert.equal(Number(match[1]), parts.length);
    }
    assert.ok(parts.length > 1, "the oversized record must be split");
    assert.equal(parts.join(""), bigText);

    const final = requests.at(-1) as Request;
    assert.equal(
      lastText(final),
      buildSummaryRequestText(2, FOCUS, PARENT, CONTINUITY),
    );
    assert.match(text(final.messages[0]), /Goal: ship the independent/);
    const notes = final.messages.slice(1, -1).map(text);
    assert.equal(notes.length, result.chunks);
    notes.forEach((note, i) => {
      assert.ok(note.includes(`NOTE ${i}`), note);
    });

    assert.deepEqual(
      progress.map((p) => p.phase),
      [...Array(result.chunks).fill("map"), "reduce"],
    );
    assert.deepEqual(
      progress.map((p) => p.call),
      Array.from({ length: result.calls }, (_, i) => i + 1),
    );
    assert.ok(progress.every((p) => p.plannedCalls === result.calls));
  });

  it("starts the evidence at message 1 when there is no background", async () => {
    const { runner, requests } = harness();
    const result = await summarizeFold(
      options(runner, { segment: { background: "", records: records() } }),
    );
    assert.ok(result.ok);
    const final = requests.at(-1) as Request;
    assert.equal(
      lastText(final),
      buildSummaryRequestText(1, FOCUS, PARENT, CONTINUITY),
    );
    assert.match(text(final.messages[0]), /^Evidence notes 1\//);
  });

  it("consolidates notes in order when they do not fit one reduce request", async () => {
    const { runner, requests } = harness((request, index) =>
      isFinal(request) || isConsolidation(request)
        ? {}
        : { text: `NOTE ${index} ${"z".repeat(3000)}` },
    );
    const result = await summarizeFold(options(runner));
    assert.ok(result.ok, JSON.stringify(result));
    const consolidations = requests.filter(isConsolidation);
    assert.ok(consolidations.length > 0);
    assert.equal(result.calls, result.chunks + consolidations.length + 1);
    const final = requests.at(-1) as Request;
    assert.equal(
      lastText(final),
      buildSummaryRequestText(2, FOCUS, PARENT, CONTINUITY),
    );
    // A final note is a consolidation (whose inputs are in its request) or a lone passthrough.
    const order = final.messages.slice(1, -1).flatMap((message) => {
      const consolidated = /CONSOLIDATED (\d+)/.exec(text(message))?.[1];
      const source = consolidated
        ? text(requests[Number(consolidated)].messages[0])
        : text(message);
      return [...source.matchAll(/NOTE (\d+) /g)].map((m) => Number(m[1]));
    });
    assert.deepEqual(
      order,
      Array.from({ length: result.chunks }, (_, i) => i),
    );
  });

  it("fails over-call-budget before any call when the plan exceeds maxCalls", async () => {
    const { runner, requests } = harness();
    const result = await summarizeFold(
      options(runner, {
        limits: { mapOutputTokens: 200, reduceOutputTokens: 400, maxCalls: 3 },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "over-call-budget");
    assert.match(result.detail, /planned \d+ calls .* limit of 3/);
    assert.equal(result.calls, 0);
    assert.equal(requests.length, 0);
  });

  it("returns no-evidence without calling when there is nothing to summarize", async () => {
    const { runner, requests } = harness();
    const result = await summarizeFold(
      options(runner, { segment: { background: BACKGROUND, records: [] } }),
    );
    assert.deepEqual(result.ok ? null : [result.reason, result.calls], [
      "no-evidence",
      0,
    ]);
    assert.equal(requests.length, 0);
  });

  it("rejects an invalid final summary after at most one retry", async () => {
    const { runner, requests } = harness((request) =>
      isFinal(request) ? { text: "I will summarize now." } : {},
    );
    const result = await summarizeFold(options(runner));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid-summary");
    assert.equal(requests.filter(isFinal).length, 2);
    assert.equal(result.calls, requests.length);
  });

  it("does not retry the final reduce past maxCalls", async () => {
    const probe = harness();
    const planned = await summarizeFold(options(probe.runner));
    assert.ok(planned.ok);
    const { runner, requests } = harness((request) =>
      isFinal(request) ? { text: "no heading" } : {},
    );
    const result = await summarizeFold(
      options(runner, {
        limits: {
          mapOutputTokens: 200,
          reduceOutputTokens: 400,
          maxCalls: planned.calls,
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(requests.length, planned.calls);
  });

  it("retries a map call that stops at its output limit once without reasoning, keeping only the complete notes", async () => {
    const { runner, requests } = harness(
      (request, index) =>
        index === 0 && !isFinal(request)
          ? { stopReason: "length", text: "CUT" }
          : {},
      200_000,
      "medium",
      64_000,
    );
    const result = await summarizeFold(options(runner));
    assert.ok(result.ok, JSON.stringify(result));
    const [cut, retry] = [requests[0], requests[1]];
    assert.equal(cut.reasoning, undefined);
    assert.equal(retry.reasoning, "off");
    assert.equal(text(retry.messages[0]), text(cut.messages[0]));
    assert.ok(retry.maxTokens >= cut.maxTokens);
    assert.equal(result.calls, requests.length);
    const reduce = requests.at(-1);
    assert.ok(reduce && isFinal(reduce));
    assert.ok(
      !reduce.messages.some((message) => text(message).includes("CUT")),
    );
  });

  it("fails a map call that still stops at its output limit after the retry, without storing cut-off notes", async () => {
    const { runner, requests } = harness((request, index) =>
      (index === 1 || index === 2) && !isFinal(request)
        ? { stopReason: "length" }
        : {},
    );
    const result = await summarizeFold(options(runner));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid-summary");
    assert.match(
      result.detail,
      /map call 2\/.*after a retry without reasoning/,
    );
    assert.equal(requests.length, 3);
  });

  it("leaves reasoning room on top of every answer cap, as adaptive and effort models share the ceiling", async () => {
    const { runner, requests } = harness(() => ({}), 200_000, "medium", 64_000);
    const admitted: number[] = [];
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        admit: (_request, maxOutputTokens) => {
          admitted.push(maxOutputTokens);
          return { fits: false, inputEstimate: 999_999 };
        },
      }),
    );
    assert.ok(result.ok, JSON.stringify(result));
    const allowance = reasoningAllowance("medium");
    assert.equal(allowance, 8192);
    assert.deepEqual(admitted, [400 + allowance]);
    for (const request of requests)
      assert.equal(
        request.maxTokens,
        (isFinal(request) ? 400 : 200) + allowance,
      );
  });
});

describe("summarizeFold in-context strategy", () => {
  it("asks once with the live request and tools when it fits", async () => {
    const { runner, requests } = harness();
    const admitted: number[] = [];
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(7),
        admit: (_request, maxOutputTokens) => {
          admitted.push(maxOutputTokens);
          return { fits: true, inputEstimate: 10 };
        },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.strategy, "in-context");
    assert.equal(result.calls, 1);
    assert.equal(result.text, extractSummaryText(SUMMARY));
    const [request] = requests;
    assert.equal(request.systemPrompt, SYSTEM);
    assert.equal(request.tools, TOOLS);
    assert.equal(request.maxTokens, 400);
    assert.deepEqual(admitted, [400]);
    assert.equal(request.messages.length, 2);
    assert.equal(
      lastText(request),
      buildSummaryRequestText(7, FOCUS, PARENT, CONTINUITY),
    );
  });

  it("sends system messages inside messages unchanged, before the summary request, without a separate prompt", async () => {
    const { runner, requests } = harness();
    const system: Message = {
      role: "system",
      content: SYSTEM,
      timestamp: 0,
    };
    const live: Message = { role: "user", content: "live work", timestamp: 1 };
    const admitted: Message[][] = [];
    const result = await summarizeFold(
      options(runner, {
        inContext: { messages: [system, live], first: 2 },
        admit: (request) => {
          admitted.push(request.messages);
          return { fits: true, inputEstimate: 10 };
        },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.strategy, "in-context");
    const [request] = requests;
    assert.equal(request.systemPrompt, undefined);
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 3);
    assert.equal(request.messages[0], system);
    assert.equal(request.messages[1], live);
    assert.equal(
      lastText(request),
      buildSummaryRequestText(2, FOCUS, PARENT, CONTINUITY),
    );
    assert.deepEqual(admitted[0], request.messages);
  });

  for (const [name, reply] of [
    ["length", { stopReason: "length", text: "## Goal\ncut off" }],
    ["a reply without the summary heading", { text: "Done." }],
  ] as const) {
    it(`falls back once to chunks on ${name}`, async () => {
      const { runner, requests } = harness((request) =>
        request.systemPrompt === SYSTEM ? reply : {},
      );
      const result = await summarizeFold(
        options(runner, {
          inContext: inContext(),
          admit: () => ({ fits: true, inputEstimate: 10 }),
        }),
      );
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.strategy, "chunked");
      assert.equal(requests.filter((r) => r.systemPrompt === SYSTEM).length, 1);
      assert.equal(result.calls, 1 + result.chunks + 1);
      assert.equal(result.usage.length, result.calls);
    });
  }

  it("counts the in-context call against maxCalls when falling back", async () => {
    const probe = harness();
    const planned = await summarizeFold(options(probe.runner));
    assert.ok(planned.ok);
    const { runner, requests } = harness((request) =>
      request.systemPrompt === SYSTEM ? { stopReason: "length" } : {},
    );
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        admit: () => ({ fits: true, inputEstimate: 10 }),
        limits: {
          mapOutputTokens: 200,
          reduceOutputTokens: 400,
          maxCalls: planned.calls,
        },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "over-call-budget");
    assert.equal(result.calls, 1);
    assert.equal(requests.length, 1);
  });

  it("returns a provider error without fallback or retry", async () => {
    const { runner, requests } = harness(() => ({
      stopReason: "error",
      text: "",
      errorMessage: "quota exceeded",
    }));
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        admit: () => ({ fits: true, inputEstimate: 10 }),
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "provider-error");
    assert.equal(result.detail, "quota exceeded");
    assert.equal(requests.length, 1);
    assert.equal(result.usage.length, 1);
  });

  it("never calls the live request when it does not fit, and reports the evidence gap", async () => {
    const { runner, requests } = harness();
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        segment: { background: "", records: [] },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no-evidence");
    assert.match(result.detail, /does not fit/);
    assert.equal(requests.length, 0);
  });

  it("reports an invalid in-context reply when no records remain to fall back on", async () => {
    const { runner } = harness(() => ({ text: "Done." }));
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(),
        admit: () => ({ fits: true, inputEstimate: 10 }),
        segment: { background: "", records: [] },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid-summary");
    assert.equal(result.calls, 1);
  });
});

describe("summarizeFold cancellation and runner failures", () => {
  it("does not call the runner when already aborted", async () => {
    const { runner, requests } = harness();
    const result = await summarizeFold(
      options(runner, { signal: AbortSignal.abort() }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "aborted");
    assert.equal(requests.length, 0);
  });

  it("stops between calls once the signal aborts and passes the signal through", async () => {
    const controller = new AbortController();
    const { runner, requests } = harness((_request, index) => {
      if (index === 1) controller.abort();
      return {};
    });
    const result = await summarizeFold(
      options(runner, { signal: controller.signal }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "aborted");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.signal === controller.signal));
  });

  it("treats an aborted stop reason as cancellation", async () => {
    const { runner } = harness(() => ({ stopReason: "aborted" }));
    const result = await summarizeFold(options(runner));
    assert.equal(result.ok ? null : result.reason, "aborted");
  });

  it("maps an unexpected runner throw to provider-error and an AbortError to aborted", async () => {
    for (const [error, reason] of [
      [new Error("socket hang up"), "provider-error"],
      [new DOMException("stopped", "AbortError"), "aborted"],
    ] as const) {
      const { runner } = harness();
      runner.complete = async () => {
        throw error;
      };
      const result = await summarizeFold(options(runner));
      assert.equal(result.ok ? null : result.reason, reason);
    }
  });
});

describe("createFoldSummaryRunner", () => {
  const model = {
    provider: "test",
    id: "fold",
    name: "Fold",
    api: "openai-completions",
    baseUrl: "http://localhost",
    reasoning: true,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 4000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<Api>;
  const reply = (
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
  ): AssistantMessage => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    errorMessage,
    timestamp: 1,
    usage,
  });

  it("forwards the request without tool use and returns stop reasons instead of throwing", async () => {
    let observed: SimpleStreamOptions | undefined;
    let context: { systemPrompt?: string; tools?: Tool[] } | undefined;
    const registry: Pick<ModelRegistry, "streamSimple"> = {
      streamSimple(actualModel, actualContext, actualOptions) {
        assert.equal(actualModel, model);
        context = actualContext;
        observed = actualOptions;
        const stream = createAssistantMessageEventStream();
        stream.end(reply("error", "overloaded"));
        return stream;
      },
    };
    const runner = createFoldSummaryRunner({
      registry,
      model,
      thinking: "high",
      sessionId: "session-1",
    });
    assert.equal(runner.name, "test/fold:high");
    assert.equal(runner.thinking, "high");
    assert.equal(runner.contextWindow, 32000);
    assert.equal(runner.maxOutputTokens, 4000);
    const controller = new AbortController();
    const response = await runner.complete({
      systemPrompt: SYSTEM,
      tools: TOOLS,
      messages: [],
      maxTokens: 1234,
      signal: controller.signal,
    });
    assert.deepEqual(
      { ...response, usage: undefined },
      {
        text: "one\ntwo",
        stopReason: "error",
        usage: undefined,
        errorMessage: "overloaded",
      },
    );
    assert.equal(context?.systemPrompt, SYSTEM);
    assert.equal(context?.tools, TOOLS);
    assert.equal(observed?.toolChoice, "none");
    assert.equal(observed?.reasoning, "high");
    assert.equal(observed?.maxTokens, 1234);
    assert.equal(observed?.sessionId, "session-1");
    assert.equal(observed?.signal, controller.signal);
  });

  it("omits reasoning when thinking is off", async () => {
    let observed: SimpleStreamOptions | undefined;
    const registry: Pick<ModelRegistry, "streamSimple"> = {
      streamSimple(_model, _context, actualOptions) {
        observed = actualOptions;
        const stream = createAssistantMessageEventStream();
        stream.end(reply("stop"));
        return stream;
      },
    };
    const response = await createFoldSummaryRunner({
      registry,
      model,
      thinking: "off",
    }).complete({ messages: [], maxTokens: 10 });
    assert.equal(response.stopReason, "stop");
    assert.equal(observed?.reasoning, undefined);
  });

  it("omits reasoning for a request that turns it off", async () => {
    let observed: SimpleStreamOptions | undefined;
    const registry: Pick<ModelRegistry, "streamSimple"> = {
      streamSimple(_model, _context, actualOptions) {
        observed = actualOptions;
        const stream = createAssistantMessageEventStream();
        stream.end(reply("stop"));
        return stream;
      },
    };
    await createFoldSummaryRunner({
      registry,
      model,
      thinking: "high",
    }).complete({ messages: [], maxTokens: 10, reasoning: "off" });
    assert.equal(observed?.reasoning, undefined);
    assert.equal(observed?.maxTokens, 10);
  });
});

describe("summarizeFold instruction override", () => {
  const consolidate = (first: number) => buildConsolidationRequestText(first);
  const answer = (request: Request) =>
    lastText(request).startsWith("[navigate_tree consolidation]")
      ? { text: SUMMARY }
      : {};

  it("sends the override instead of r5d in the in-context request", async () => {
    const { requests, runner } = harness(answer);
    const result = await summarizeFold(
      options(runner, {
        inContext: inContext(1),
        instruction: consolidate,
        admit: () => ({ fits: true, inputEstimate: 10 }),
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(lastText(requests[0]), buildConsolidationRequestText(1));
    assert.ok(!lastText(requests[0]).includes(FOCUS));
  });

  it("sends the override in the chunked final reduce", async () => {
    const { requests, runner } = harness(answer, 8000);
    const result = await summarizeFold(
      options(runner, { instruction: consolidate }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.strategy, "chunked");
    const finals = requests.filter((request) =>
      lastText(request).startsWith("[navigate_tree"),
    );
    assert.equal(finals.length, 1);
    assert.equal(lastText(finals[0]), buildConsolidationRequestText(2));
    assert.ok(!requests.some(isFinal));
  });
});
