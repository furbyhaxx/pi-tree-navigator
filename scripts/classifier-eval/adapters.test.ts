import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AnswerOptions,
  answer,
  type Candidate,
  chatCandidate,
  createRecorder,
  decisionsCandidate,
  HEURISTIC,
  parseChatAnswers,
  planRequest,
} from "./adapters.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalCase } from "./types.ts";

const KEY = "sk-or-test-SECRET-0000000000";

const intentCase: EvalCase = {
  id: "rule-1",
  split: "development",
  family: "rule",
  task: "intent",
  input: {
    type: "intent",
    message: "From now on, always run the replay corpus before merging.",
    activeItems: [
      { id: "R1", kind: "rule", text: "Never push without asking." },
    ],
  },
  expected: {
    kind: {
      choices: ["rule"],
      unsafeChoices: ["ephemeral"],
      rationale: "explicit rule",
    },
    contradicts: {
      choices: ["none"],
      unsafeChoices: ["R1"],
      rationale: "no conflict",
    },
  },
};

const milestoneCase: EvalCase = {
  id: "milestone-1",
  split: "development",
  family: "done",
  task: "milestone-status",
  input: {
    type: "milestone",
    records: [
      { id: "r1", role: "user", text: "Add the export command." },
      { id: "r2", role: "assistant", text: "Done; tests pass." },
    ],
  },
  expected: {
    status: {
      choices: ["milestone"],
      unsafeChoices: ["blocked"],
      rationale: "finished",
    },
    boundary: { choices: ["r2"], unsafeChoices: [], rationale: "last record" },
  },
};

const intent = prepareCase(intentCase);
const milestone = prepareCase(milestoneCase);

let directory = "";
let registry: ModelRegistry;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "adapters-test-"));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "store.json"),
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("openrouter", KEY);
  registry = new ModelRegistry(runtime);
});

after(() => rmSync(directory, { recursive: true, force: true }));

const jev = () => {
  const model = registry.getModelOfType(
    "classifier",
    "openrouter",
    "typesafe/jev-1.14",
  );
  assert.ok(model);
  return decisionsCandidate(model);
};
const gemini = () => {
  const model = registry.getModelOfType(
    "chat",
    "openrouter",
    "google/gemini-2.5-flash-lite",
  );
  assert.ok(model);
  return chatCandidate(model);
};

interface Sent {
  url: string;
  body: string;
  authorized: boolean;
}

/** Records each request and answers with `reply`; nothing leaves the process. */
function fakeFetch(reply: () => Response) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({
      url: String(input),
      body: String(init?.body),
      authorized:
        new Headers(init?.headers).get("authorization") === `Bearer ${KEY}`,
    });
    return reply();
  };
  return { fetch, sent };
}

const options = (
  fetch: typeof globalThis.fetch,
  extra: Partial<AnswerOptions> = {},
): AnswerOptions => ({
  registry,
  repetition: 0,
  timeoutMs: 5_000,
  fetch,
  ...extra,
});

const decisionReply =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });

const sse = (chunks: unknown[]) =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const chatReply =
  (text: string, cost = 0.0000042) =>
  () =>
    sse([
      {
        id: "gen-chat-1",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      },
      {
        id: "gen-chat-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "gen-chat-1",
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 18,
          total_tokens: 138,
          cost,
        },
      },
    ]);

describe("decisions adapter", () => {
  it("records the request hash, status, generation id and billed cost, never headers", async () => {
    const api = fakeFetch(
      decisionReply({
        model: "typesafe/jev-1.14-20261014",
        answers: {
          kind: {
            type: "choice",
            choice: "rule",
            probabilities: { rule: 0.9 },
            confidence: 0.9,
          },
          contradicts: {
            type: "choice",
            choice: "none",
            probabilities: { none: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 671, output_tokens: 98, cost: 0.000028182 },
        id: "gen-dec-1792747918-abc",
      }),
    );
    const result = await answer(intent, jev(), options(api.fetch));
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0]?.url, "https://openrouter.ai/api/v1/systemone");
    assert.equal(api.sent[0]?.authorized, true);
    assert.deepEqual(result.observation, {
      caseId: "rule-1",
      model: "decisions:typesafe/jev-1.14",
      adapter: "decisions",
      repetition: 0,
      startedAt: result.observation.startedAt,
      status: "ok",
      answers: {
        kind: { choice: "rule", confidence: 0.9 },
        contradicts: { choice: "none", confidence: 1 },
      },
      durationMs: result.observation.durationMs,
      generationId: "gen-dec-1792747918-abc",
      inputTokens: 671,
      outputTokens: 98,
      requestSha256: createHash("sha256")
        .update(api.sent[0]?.body ?? "")
        .digest("hex"),
    });
    assert.deepEqual(result.evidence, {
      dispatched: true,
      httpStatus: 200,
      generationId: "gen-dec-1792747918-abc",
      responseCostUsd: 0.000028182,
    });
    const text = JSON.stringify(result);
    assert.equal(text.includes("SECRET"), false);
    assert.equal(/bearer|authorization/iu.test(text), false);
  });

  it("plans exactly the bytes the SDK sends", async () => {
    const api = fakeFetch(decisionReply({ error: "rejected" }, 400));
    const candidate = jev();
    await answer(intent, candidate, options(api.fetch));
    const plan = planRequest(intent, candidate);
    assert.equal(plan.kind, "request");
    assert.equal(
      plan.kind === "request" && plan.bodyBytes,
      Buffer.byteLength(api.sent[0]?.body ?? ""),
    );
  });

  it("reports an HTTP rejection as an error with its status and no key", async () => {
    const api = fakeFetch(
      decisionReply({ error: { message: `bad Bearer ${KEY}` } }, 400),
    );
    const result = await answer(intent, jev(), options(api.fetch));
    assert.equal(result.observation.status, "error");
    assert.deepEqual(result.observation.answers, {});
    assert.equal(result.evidence.httpStatus, 400);
    assert.equal(api.sent.length, 1);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  });

  it("does not call a model whose context cannot hold the request", async () => {
    const api = fakeFetch(decisionReply({}));
    const model = registry.getModelOfType(
      "classifier",
      "openrouter",
      "typesafe/jev-1.14",
    );
    assert.ok(model);
    const small = decisionsCandidate({ ...model, contextWindow: 50 });
    const result = await answer(intent, small, options(api.fetch));
    assert.equal(result.observation.status, "unsupported");
    assert.match(result.observation.error ?? "", /model context is 50/u);
    assert.equal(result.evidence.dispatched, false);
    assert.equal(api.sent.length, 0);
  });

  it("settles an aborted request as dispatched without a status", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    const result = await answer(
      intent,
      jev(),
      options(fetch, { signal: controller.signal }),
    );
    assert.equal(result.observation.status, "error");
    assert.equal(result.observation.error, "aborted");
    assert.deepEqual(result.evidence, { dispatched: true });
  });
});

describe("recording fetch", () => {
  it("refuses an oversized body and a second request before sending", async () => {
    let sent = 0;
    const recorder = createRecorder(async () => {
      sent++;
      return new Response("{}");
    }, 10);
    await assert.rejects(() =>
      recorder.fetch("https://x", { body: "x".repeat(11) }),
    );
    await assert.rejects(() =>
      recorder.fetch("https://x", { body: new Uint8Array(1) }),
    );
    assert.equal(sent, 0);
    await recorder.fetch("https://x", { body: "x".repeat(10) });
    await assert.rejects(() => recorder.fetch("https://x", { body: "x" }));
    assert.equal(sent, 1);
    assert.equal((await recorder.finish()).dispatched, true);
  });
});

describe("chat adapter", () => {
  const goodAnswer = JSON.stringify({
    answers: {
      kind: { choice: "rule", confidence: 0.8 },
      contradicts: { choice: "none", confidence: 0.95 },
    },
  });

  it("asks for strict structured JSON and records the streamed usage", async () => {
    const api = fakeFetch(chatReply(goodAnswer));
    const result = await answer(intent, gemini(), options(api.fetch));
    const body = JSON.parse(api.sent[0]?.body ?? "{}");
    assert.equal(
      api.sent[0]?.url,
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(
      body.response_format.json_schema.schema.properties.answers.properties.kind
        .properties.choice.enum,
      Object.keys(intent.questions.kind?.choices ?? {}),
    );
    assert.equal(body.max_completion_tokens, 1_024);
    assert.equal("tool_choice" in body, false);
    assert.equal("tools" in body, false);
    assert.equal(
      JSON.stringify(body.messages).includes("explicit rule"),
      false,
    );
    assert.equal(result.observation.status, "ok");
    assert.deepEqual(result.observation.answers, {
      kind: { choice: "rule", confidence: 0.8 },
      contradicts: { choice: "none", confidence: 0.95 },
    });
    assert.equal(result.observation.generationId, "gen-chat-1");
    assert.equal(result.observation.inputTokens, 120);
    assert.equal(result.observation.outputTokens, 18);
    assert.equal(result.evidence.responseCostUsd, 0.0000042);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  });

  it("keeps malformed output as an ok observation with no valid answer", async () => {
    const result = await answer(
      intent,
      gemini(),
      options(fakeFetch(chatReply("Sure! kind = rule")).fetch),
    );
    assert.equal(result.observation.status, "ok");
    assert.deepEqual(result.observation.answers, {});
    assert.match(result.observation.error ?? "", /not valid JSON/u);
    assert.equal(result.evidence.responseCostUsd, 0.0000042);
  });

  it("records a choice the question never offered", () => {
    const parsed = parseChatAnswers(
      JSON.stringify({
        answers: {
          kind: { choice: "Rule", confidence: 2 },
          extra: { choice: "x" },
        },
      }),
      intent.questions,
    );
    assert.deepEqual(parsed.answers, {
      kind: { choice: "Rule", confidence: 2 },
      extra: { choice: "x" },
    });
    assert.deepEqual(parsed.problems, [
      "unknown question extra",
      "kind: choice is not offered",
      "no answer for contradicts",
    ]);
  });
});

describe("heuristic adapter", () => {
  it("answers intent locally from the production heuristic and never supersedes", async () => {
    const api = fakeFetch(decisionReply({}));
    const result = await answer(intent, HEURISTIC, options(api.fetch));
    assert.equal(result.observation.status, "ok");
    assert.equal(result.observation.model, "heuristic");
    assert.deepEqual(result.observation.answers, {
      kind: { choice: "rule" },
      contradicts: { choice: "none" },
    });
    assert.equal(result.evidence.dispatched, false);
    assert.equal(api.sent.length, 0);
  });

  it("is unsupported for milestone cases", async () => {
    const result = await answer(
      milestone,
      HEURISTIC,
      options(fakeFetch(decisionReply({})).fetch),
    );
    assert.equal(result.observation.status, "unsupported");
    assert.deepEqual(result.observation.answers, {});
  });
});

describe("uncatalogued decision models", () => {
  it("run through the template's transport", async () => {
    const template = registry.getModelOfType(
      "classifier",
      "openrouter",
      "typesafe/jev-1.14",
    );
    assert.ok(template);
    const candidate: Candidate = decisionsCandidate(
      {
        ...template,
        id: "respan/span-02",
        cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
      },
      true,
    );
    const api = fakeFetch(decisionReply({ error: "x" }, 400));
    await answer(intent, candidate, options(api.fetch));
    assert.equal(JSON.parse(api.sent[0]?.body ?? "{}").model, "respan/span-02");
    assert.equal(candidate.label, "decisions:respan/span-02");
  });
});
