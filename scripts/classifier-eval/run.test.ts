import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { decisionsCandidate, planRequest } from "./adapters.ts";
import { loadRouteTable, ROUTE_PRICES_URL, worstCaseUsd } from "./billing.ts";
import { prepareCase } from "./prepare.ts";
import { type Deps, main } from "./run.ts";
import type { EvalCase, EvalObservation } from "./types.ts";

const KEY = "credential-0123456789abcdef";

const intentCase = (id: string, split: EvalCase["split"]): EvalCase => ({
  id,
  split,
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
});

const CASES: EvalCase[] = [
  intentCase("rule-1", "development"),
  {
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
      boundary: {
        choices: ["r2"],
        unsafeChoices: [],
        rationale: "last record",
      },
    },
  },
  intentCase("rule-2", "holdout"),
];

let directory = "";
let registry: ModelRegistry;

before(async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "run-test-runtime-"));
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(runtimeDir, "store.json"),
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("openrouter", KEY);
  registry = new ModelRegistry(runtime);
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "run-test-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Handler = (request: {
  body: string;
  signal?: AbortSignal | null;
  count: number;
}) => Response | Promise<Response>;

interface World {
  systemone?: Handler;
  chat?: Handler;
  generation?: (id: string) => Response;
}

const ANSWERS: Record<string, string> = {
  kind: "rule",
  contradicts: "none",
  status: "milestone",
  boundary: "r2",
};

const decisionResponse = (
  body: string,
  count: number,
  extra: object = {
    id: `gen-dec-${count}`,
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.00002 },
  },
) => {
  const { questions } = JSON.parse(body) as {
    questions: Record<string, unknown>;
  };
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => [
      id,
      {
        type: "choice",
        choice: ANSWERS[id],
        probabilities: {},
        confidence: 0.9,
      },
    ]),
  );
  return new Response(JSON.stringify({ model: "m", answers, ...extra }));
};

/** The whole network: the provider endpoints, billing lookups and key usage. */
function environment(world: World = {}) {
  const requests = { systemone: 0, chat: 0, generation: 0, key: 0, other: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    if (url.endsWith("/systemone")) {
      const count = ++requests.systemone;
      return (world.systemone ?? (({ body }) => decisionResponse(body, count)))(
        { body, signal: init?.signal, count },
      );
    }
    if (url.endsWith("/chat/completions")) {
      const count = ++requests.chat;
      return (world.chat ?? (() => new Response("", { status: 500 })))({
        body,
        signal: init?.signal,
        count,
      });
    }
    if (url.includes("/generation?id=")) {
      requests.generation++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${KEY}`,
      );
      return (
        world.generation ??
        (() => new Response(JSON.stringify({ data: { total_cost: 0.00003 } })))
      )(url);
    }
    if (url.endsWith("/key")) {
      requests.key++;
      return new Response(
        JSON.stringify({
          data: { usage: 1 + requests.key, limit: 25, limit_remaining: 24 },
        }),
      );
    }
    requests.other++;
    throw new Error(`unexpected request ${url}`);
  };
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    loadCases: async () => CASES,
    createRegistry: async () => registry,
    loadRoutePrices: () => loadRouteTable(ROUTE_PRICES_URL),
    fetch,
    git: () => ({ sha: "deadbeef", dirty: false }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    billingDelaysMs: [0],
    handleSignals: false,
  };
  return { deps, requests, out, err };
}

const ledgerPath = () => join(directory, "ledger.jsonl");
const runDir = (name = "run") => join(directory, name);
const flags = (name = "run", ...extra: string[]) => [
  "--out",
  runDir(name),
  "--ledger",
  ledgerPath(),
  ...extra,
];

const ledgerEvents = () =>
  readFileSync(ledgerPath(), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const observations = (name = "run") =>
  readFileSync(join(runDir(name), "observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalObservation);

const JEV = "decisions:typesafe/jev-1.14";

describe("budget control", () => {
  it("fsyncs the reservation before dispatch and settles the billed cost", async () => {
    const seen: Record<string, unknown>[][] = [];
    const world = environment({
      systemone: ({ body, count }) => {
        seen.push(ledgerEvents());
        return decisionResponse(body, count);
      },
    });
    const code = await main(
      [
        "--models",
        JEV,
        "--split",
        "development",
        "--tasks",
        "intent",
        ...flags(),
      ],
      world.deps,
    );
    assert.equal(code, 0, world.err.join(""));
    const atDispatch = seen[0] ?? [];
    assert.deepEqual(
      atDispatch.map((event) => event.event),
      ["cap", "reserve"],
    );
    assert.match(
      String(atDispatch[1]?.id),
      /\/decisions:typesafe\/jev-1\.14\/rule-1\/0$/u,
    );
    const events = ledgerEvents();
    const settle = events.find((event) => event.event === "settle");
    assert.equal(settle?.actualNanoUsd, 30_000);
    const [observation] = observations();
    assert.equal(observation?.costUsd, 0.00003);
    assert.equal(observation?.costSource, "generation");
    assert.equal(observation?.generationId, "gen-dec-1");
    assert.ok((observation?.costBoundUsd ?? 0) > 0.00003);
    assert.equal(world.requests.generation, 1);
  });

  it("uses the response cost when no generation record appears, and holds an unknown one", async () => {
    const missing = () => new Response("{}", { status: 404 });
    const withCost = environment({ generation: missing });
    await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--split",
        "development",
        ...flags("a"),
      ],
      withCost.deps,
    );
    assert.equal(observations("a")[0]?.costSource, "response");
    assert.equal(observations("a")[0]?.costUsd, 0.00002);

    const noCost = environment({
      generation: missing,
      systemone: ({ body, count }) =>
        decisionResponse(body, count, {
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const ledger = join(directory, "unknown.jsonl");
    await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--split",
        "development",
        "--out",
        runDir("b"),
        "--ledger",
        ledger,
      ],
      noCost.deps,
    );
    assert.equal(observations("b")[0]?.costUsd, null);
    assert.equal(observations("b")[0]?.costSource, "unknown");
    const events = readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1)?.actualNanoUsd, null);
  });

  it("stops dispatching once the cap cannot hold another reservation", async () => {
    const prepared = prepareCase(CASES[0] as EvalCase);
    const model = registry.getModelOfType(
      "classifier",
      "openrouter",
      "typesafe/jev-1.14",
    );
    assert.ok(model);
    const candidate = decisionsCandidate(
      model,
      loadRouteTable(ROUTE_PRICES_URL),
    );
    const plan = planRequest(prepared, candidate);
    assert.ok(plan.kind === "request" && candidate.adapter === "decisions");
    const one = worstCaseUsd(
      plan.bodyBytes,
      plan.maxOutputTokens,
      candidate.pricing.rates,
    );
    const world = environment({
      generation: () => new Response("{}", { status: 404 }),
      systemone: ({ body, count }) =>
        decisionResponse(body, count, {
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const code = await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--concurrency",
        "1",
        "--repetitions",
        "3",
        "--cap",
        String(one * 1.5),
        ...flags(),
      ],
      world.deps,
    );
    assert.equal(code, 3);
    assert.equal(world.requests.systemone, 1);
    assert.equal(observations().length, 1);
    assert.match(world.out.join(""), /STOPPED: cap_exceeded/u);
    assert.equal(
      ledgerEvents().filter((event) => event.event === "reserve").length,
      1,
    );
  });

  it("settles an interrupted call as unknown and dispatches nothing more", async () => {
    const interrupt = new AbortController();
    const world = environment({
      systemone: ({ signal }) =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => interrupt.abort(), 5);
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const code = await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--concurrency",
        "1",
        "--repetitions",
        "3",
        ...flags(),
      ],
      {
        ...world.deps,
        interrupt: interrupt.signal,
      },
    );
    assert.equal(code, 130);
    assert.equal(world.requests.systemone, 1);
    assert.deepEqual(observations(), []);
    assert.match(world.out.join(""), /1 interrupted call\(s\) unrecorded/u);
    const settles = ledgerEvents().filter((event) => event.event === "settle");
    assert.deepEqual(
      settles.map((event) => event.actualNanoUsd),
      [null],
    );
    const meta = JSON.parse(readFileSync(join(runDir(), "run.json"), "utf8"));
    assert.equal(meta.sessions[0].interrupted, 1);
    assert.equal(meta.sessions[0].stopped, "interrupted");
  });
});

describe("dry run", () => {
  it("prices the plan without any request or file", async () => {
    const world = environment();
    const code = await main(
      [
        "--models",
        `${JEV},chat:google/gemini-2.5-flash-lite,heuristic`,
        "--dry-run",
        "--ledger",
        ledgerPath(),
      ],
      world.deps,
    );
    assert.equal(code, 0, world.err.join(""));
    assert.deepEqual(world.requests, {
      systemone: 0,
      chat: 0,
      generation: 0,
      key: 0,
      other: 0,
    });
    assert.equal(existsSync(ledgerPath()), false);
    const report = world.out.join("");
    assert.match(report, /planned live calls: 6 /u);
    assert.match(report, /heuristic: 0 live, 2 local, 1 unsupported/u);
    assert.match(report, /OK: summed reservations fit/u);
  });

  it("refuses a plan that exceeds the remaining budget", async () => {
    const world = environment();
    const code = await main(
      [
        "--models",
        JEV,
        "--dry-run",
        "--cap",
        "0.001",
        "--ledger",
        ledgerPath(),
      ],
      world.deps,
    );
    assert.equal(code, 3);
    assert.match(world.out.join(""), /REFUSED/u);
    assert.equal(world.requests.systemone, 0);
  });
});

describe("run directory", () => {
  it("resumes without repeating finished work", async () => {
    const first = environment();
    assert.equal(
      await main(
        ["--models", `${JEV},heuristic`, "--split", "development", ...flags()],
        first.deps,
      ),
      0,
    );
    assert.equal(first.requests.systemone, 2);
    const second = environment();
    const code = await main(
      [
        "--models",
        `${JEV},heuristic`,
        "--split",
        "all",
        "--resume",
        runDir(),
        "--ledger",
        ledgerPath(),
      ],
      second.deps,
    );
    assert.equal(code, 0, second.err.join(""));
    assert.equal(second.requests.systemone, 1);
    const keys = observations().map(
      (o) => `${o.model}|${o.caseId}|${o.repetition}`,
    );
    assert.equal(keys.length, new Set(keys).size);
    assert.equal(observations().length, 6);
    const meta = JSON.parse(readFileSync(join(runDir(), "run.json"), "utf8"));
    assert.equal(meta.sessions.length, 2);
  });

  it("keeps one observation per unit of work, errors included", async () => {
    const failing = environment({
      systemone: () => new Response("{}", { status: 500 }),
    });
    await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--split",
        "development",
        ...flags(),
      ],
      failing.deps,
    );
    assert.equal(observations()[0]?.status, "error");
    const healthy = environment();
    await main(
      [
        "--models",
        JEV,
        "--tasks",
        "intent",
        "--split",
        "development",
        "--resume",
        runDir(),
        "--ledger",
        ledgerPath(),
      ],
      healthy.deps,
    );
    assert.equal(healthy.requests.systemone, 0);
    assert.equal(observations().length, 1);
  });

  it("records metadata and keeps credentials out of every file", async () => {
    const world = environment({
      chat: () =>
        new Response(
          `data: ${JSON.stringify({ id: "gen-chat-1", choices: [{ index: 0, delta: { content: "not json" } }] })}\n\n` +
            `data: ${JSON.stringify({ id: "gen-chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            `data: ${JSON.stringify({ id: "gen-chat-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000001 } })}\n\ndata: [DONE]\n\n`,
        ),
    });
    const code = await main(
      [
        "--models",
        `${JEV},chat:google/gemini-2.5-flash-lite,heuristic`,
        "--uncatalogued",
        "respan/span-02:0.01:200",
        "--tasks",
        "intent",
        "--split",
        "development",
        ...flags(),
      ],
      world.deps,
    );
    assert.equal(code, 0, world.err.join(""));
    const all = observations();
    const chat = all.find((o) => o.adapter === "chat");
    assert.equal(chat?.status, "ok");
    assert.deepEqual(chat?.answers, {});
    assert.match(chat?.error ?? "", /not valid JSON/u);
    assert.equal(chat?.costSource, "generation");
    const tiny = all.find((o) => o.model === "decisions:respan/span-02");
    assert.equal(tiny?.status, "unsupported");
    assert.equal(tiny?.costUsd, 0);
    assert.equal(world.requests.systemone, 1);
    const heuristic = all.find((o) => o.adapter === "heuristic");
    assert.equal(heuristic?.costSource, "local");

    const meta = JSON.parse(readFileSync(join(runDir(), "run.json"), "utf8"));
    assert.equal(meta.gitSha, "deadbeef");
    assert.match(meta.casesSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      meta.models.map((model: { label: string; uncatalogued?: boolean }) => [
        model.label,
        model.uncatalogued ?? false,
      ]),
      [
        [JEV, false],
        ["chat:google/gemini-2.5-flash-lite", false],
        ["heuristic", false],
        ["decisions:respan/span-02", true],
      ],
    );
    assert.deepEqual(meta.sessions[0].keyUsageBefore, {
      usage: 2,
      usageDaily: null,
      limit: 25,
      limitRemaining: 24,
    });
    assert.equal(meta.sessions[0].keyUsageAfter.usage, 3);
    for (const file of readdirSync(runDir())) {
      const text = readFileSync(join(runDir(), file), "utf8");
      assert.equal(
        text.includes(KEY) || /bearer|authorization/iu.test(text),
        false,
        file,
      );
    }
    const ledgerText = readFileSync(ledgerPath(), "utf8");
    assert.equal(
      ledgerText.includes(KEY) || /bearer|authorization/iu.test(ledgerText),
      false,
    );
  });
});

describe("usage errors", () => {
  it("rejects unknown models, missing destinations and an existing --out", async () => {
    const world = environment();
    assert.equal(
      await main(["--models", "decisions:nope/none", ...flags()], world.deps),
      2,
    );
    assert.equal(
      await main(["--models", JEV, "--ledger", ledgerPath()], world.deps),
      2,
    );
    assert.equal(await main(["--models", JEV, ...flags()], world.deps), 0);
    assert.equal(await main(["--models", JEV, ...flags()], world.deps), 2);
    assert.match(world.err.join(""), /already exists/u);
  });
});

describe("prices", () => {
  const dry = (...argv: string[]) => {
    const world = environment();
    return main(
      ["--dry-run", "--ledger", ledgerPath(), ...argv],
      world.deps,
    ).then((code) => ({ code, world, text: world.out.join("") }));
  };

  it("reserves above zero for every live call, clef at its route price", async () => {
    const { code, text } = await dry(
      "--models",
      "decisions:cloudflare/clef",
      "--split",
      "dev",
    );
    assert.equal(code, 0);
    assert.match(text, /rates 0\.24\/0 USD\/M/u);
    for (const row of text.matchAll(/(\d+) live.* reserve ([\d.]+) USD/gu))
      assert.ok(Number(row[1]) === 0 || Number(row[2]) > 0, row[0]);
  });

  it("refuses a named model without a positive price, live and in a dry run", async () => {
    const { code, text } = await dry(
      "--models",
      "decisions:respan/span-01-lite",
    );
    assert.equal(code, 3);
    assert.match(
      text,
      /REFUSED decisions:respan\/span-01-lite: no positive prompt price/u,
    );
    const world = environment();
    for (const argv of [
      ["--models", "decisions:respan/span-01-lite", ...flags()],
      [
        "--models",
        "heuristic",
        "--uncatalogued",
        "acme/free-lunch:0:1000",
        ...flags("zero"),
      ],
    ]) {
      assert.equal(await main(argv, world.deps), 2, argv.join(" "));
    }
    assert.match(world.err.join(""), /refused before any request/u);
    assert.deepEqual(world.requests, {
      systemone: 0,
      chat: 0,
      generation: 0,
      key: 0,
      other: 0,
    });
    assert.equal(existsSync(runDir()), false);
  });

  it("accepts a verified free variant at the minimum reservation", async () => {
    const { code, text } = await dry(
      "--models",
      "decisions:inception/mercury-decide:free",
      "--tasks",
      "intent",
    );
    assert.equal(code, 0);
    assert.doesNotMatch(text, /reserve 0\.000000/u);
  });

  it("expands all-decisions to priced models and reports every exclusion", async () => {
    const { code, text } = await dry(
      "--models",
      "all-decisions",
      "--split",
      "dev",
    );
    assert.equal(code, 0);
    assert.match(text, /decisions:typesafe\/jev-1\.14: .*rates 0\.042\/0/u);
    assert.match(text, /decisions:cloudflare\/clef: .*rates 0\.24\/0/u);
    assert.match(text, /decisions:respan\/span-02: .*rates 0\.01\/0/u);
    assert.match(
      text,
      /decisions:perplexity\/pplx-decider-v1\.1-27b: .*\(catalog only\)/u,
    );
    assert.match(
      text,
      /excluded decisions:respan\/span-01-lite: no positive prompt price/u,
    );
    assert.match(
      text,
      /excluded decisions:inception\/mercury-decide:free: free variant/u,
    );
    assert.match(
      text,
      /excluded decisions:~typesafe\/jev-latest: dynamic alias/u,
    );
    assert.doesNotMatch(text, /chat:/u);
    assert.doesNotMatch(text, /[1-9]\d* live.*reserve 0\.000000/u);
  });

  it("reads a shortlist file and lets --rates raise but not lower a price", async () => {
    const shortlist = join(directory, "shortlist.txt");
    writeFileSync(shortlist, `# first picks\n${JEV}\n\nheuristic # baseline\n`);
    const rates = join(directory, "rates.json");
    writeFileSync(
      rates,
      JSON.stringify({
        retrievedAt: "2026-10-24",
        source: ["manual"],
        models: {
          "typesafe/jev-1.14": {
            kind: "decisions",
            promptUsdPerM: 0.5,
            completionUsdPerM: 0,
            contextTokens: 262144,
          },
          "scaledown/classify-1": {
            kind: "decisions",
            promptUsdPerM: 0.001,
            completionUsdPerM: 0,
            contextTokens: 1000000,
          },
        },
      }),
    );
    const { code, text } = await dry(
      "--models",
      `shortlist:${shortlist},decisions:scaledown/classify-1`,
      "--rates",
      rates,
      "--tasks",
      "intent",
    );
    assert.equal(code, 0, text);
    assert.match(text, /decisions:typesafe\/jev-1\.14: .*rates 0\.5\/0/u);
    assert.match(text, /decisions:scaledown\/classify-1: .*rates 0\.04\/0/u);
    assert.match(text, /heuristic: 0 live/u);
  });

  it("sends the route price ceiling with every live request and redacts the key from errors", async () => {
    const bodies: string[] = [];
    const world = environment({
      systemone: ({ body }) => {
        bodies.push(body);
        return new Response(`{"error":"rejected ${KEY}"}`, { status: 400 });
      },
    });
    const code = await main(
      [
        "--models",
        "decisions:cloudflare/clef",
        "--tasks",
        "intent",
        "--split",
        "development",
        ...flags(),
      ],
      world.deps,
    );
    assert.equal(code, 0, world.err.join(""));
    assert.deepEqual(JSON.parse(bodies[0] ?? "{}").provider, {
      max_price: { prompt: "0.24", completion: "0" },
    });
    const [observation] = observations();
    assert.equal(observation?.status, "error");
    assert.equal(observation?.error?.includes(KEY), false);
    assert.match(observation?.error ?? "", /\[redacted\]/u);
    assert.equal(observation?.costUsd, 0);
  });
});
