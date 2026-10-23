import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildMilestoneClassifierContext,
  type MilestoneRecord,
  type MilestoneStructure,
} from "../../extensions/navigate-tree/milestone-classifier.ts";
import {
  type AnswerOptions,
  chatCandidate,
  decisionsCandidate,
} from "./adapters.ts";
import {
  loadRouteTable,
  PROMPT_MARGIN_BYTES,
  ROUTE_PRICES_URL,
} from "./billing.ts";
import { CASES } from "./cases.ts";
import {
  addCarried,
  combineGranular,
  generateStructure,
  heuristicStructure,
  parseStructure,
  parseVariant,
  planVariant,
  type StructureObservation,
  structureRequest,
  variantCase,
  worstCaseStructure,
} from "./milestone-variants.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalAnswer, EvalCase, PreparedCase } from "./types.ts";

const KEY = "sk-or-test-SECRET-0000000000";
const TABLE = loadRouteTable(ROUTE_PRICES_URL);
const EVIDENCE = new URL(
  "../../.project/analyses/classifier-eval/runs-catalogued-2026-10-23/dev-screen-2026-10-23/observations.jsonl",
  import.meta.url,
);

const RECORDS: MilestoneRecord[] = [
  { id: "u1", role: "user", text: "Add the export command and run the tests." },
  { id: "a1", role: "assistant", text: "Adding the command." },
  { id: "t1", role: "tool", text: "Edited src/export.ts" },
  { id: "a2", role: "assistant", text: "Done; tests pass. Docs are next." },
  { id: "a3", role: "assistant", text: "Updating the docs now." },
];

const STRUCTURE: MilestoneStructure = {
  objective: "Ship the export command",
  goals: ["export command", "docs"],
  folds: [{ label: "f1", title: "Setup", outcome: "done" }],
  anchors: [{ name: "baseline" }],
};

const milestoneCase = (structure?: MilestoneStructure): EvalCase => ({
  id: "m-1",
  split: "development",
  family: "export",
  task: "milestone-status",
  input: {
    type: "milestone",
    lastAnchor: "baseline",
    records: RECORDS,
    ...(structure && { structure }),
  },
  expected: {
    status: {
      choices: ["continue"],
      unsafeChoices: ["milestone"],
      rationale: "r",
    },
    boundary: { choices: ["a2"], unsafeChoices: ["a3"], rationale: "r" },
  },
});

let directory = "";
let registry: ModelRegistry;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "variants-test-"));
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
  return decisionsCandidate(model, TABLE);
};
const luna = () => {
  const model = registry.getModelOfType(
    "chat",
    "openrouter",
    "openai/gpt-6-luna",
  );
  assert.ok(model);
  const candidate = chatCandidate(model, TABLE);
  assert.equal(candidate.adapter, "chat");
  return candidate.adapter === "chat"
    ? { ...candidate, label: `${candidate.label}#structure` }
    : candidate;
};

const options = (fetch: typeof globalThis.fetch): AnswerOptions => ({
  registry,
  repetition: 0,
  timeoutMs: 5_000,
  fetch,
});

describe("variant ids", () => {
  it("canonicalizes parts and rejects combinations that contradict", () => {
    assert.equal(parseVariant("base").id, "base");
    assert.equal(parseVariant("tree-luna+granular").id, "granular+tree-luna");
    assert.equal(
      parseVariant("tree-heuristic+instructions").id,
      "instructions+tree-heuristic",
    );
    for (const bad of [
      "instructions+granular",
      "tree-luna+tree-heuristic",
      "base+granular",
      "granular+granular",
      "tree",
    ])
      assert.throws(() => parseVariant(bad), Error, bad);
  });
});

describe("base variant", () => {
  it("sends the production request without structure, byte for byte", () => {
    const plain = prepareCase(milestoneCase());
    const withStructure = prepareCase(milestoneCase(STRUCTURE));
    assert.ok("structure" in withStructure.context.state);
    const base = variantCase(withStructure, parseVariant("base"));
    assert.equal(JSON.stringify(base.context), JSON.stringify(plain.context));
    assert.deepEqual(base.questions, plain.questions);
  });

  it("matches the request hash of an earlier live observation for the same cases", async () => {
    const earlier = readFileSync(EVIDENCE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const candidate = jev();
    const cases = CASES.filter(
      (fixture) =>
        fixture.split === "development" && fixture.input.type === "milestone",
    ).slice(0, 3);
    assert.equal(cases.length, 3);
    for (const fixture of cases) {
      const old = earlier.find(
        (o) =>
          o.model === candidate.label &&
          o.caseId === fixture.id &&
          o.repetition === 0,
      );
      assert.ok(old?.requestSha256, `no earlier observation for ${fixture.id}`);
      const plan = planVariant(
        prepareCase(fixture),
        candidate,
        parseVariant("base"),
        new Map(),
      );
      const result = await plan.run(
        options(async () => new Response("{}", { status: 400 })),
      );
      assert.equal(result.observation.model, `${candidate.label}#base`);
      assert.equal(result.observation.requestSha256, old.requestSha256);
    }
  });
});

describe("variant requests", () => {
  const fixture = prepareCase(milestoneCase());

  it("instructions keep the question ids and every record choice", () => {
    const sent = variantCase(fixture, parseVariant("instructions"));
    assert.deepEqual(Object.keys(sent.questions), ["status", "boundary"]);
    assert.deepEqual(
      Object.keys(sent.questions.boundary?.choices ?? {}),
      Object.keys(fixture.questions.boundary?.choices ?? {}),
    );
    assert.notEqual(
      sent.questions.status?.instructions,
      fixture.questions.status?.instructions,
    );
    assert.deepEqual(sent.context.state, fixture.context.state);
  });

  it("granular asks one yes/no question per signal and per assistant record", () => {
    const sent = variantCase(fixture, parseVariant("granular"));
    assert.deepEqual(Object.keys(sent.questions), [
      "asks-user",
      "blocked",
      "open-work",
      "finished",
      "report:a1",
      "report:a2",
      "report:a3",
    ]);
    for (const question of Object.values(sent.questions))
      assert.deepEqual(Object.keys(question.choices), ["yes", "no"]);
    assert.match(
      sent.questions["report:a2"]?.instructions ?? "",
      /Done; tests pass/u,
    );
  });

  it("tree-heuristic derives objective, goals and anchor, and keeps a case structure as given", () => {
    assert.deepEqual(
      heuristicStructure({ records: RECORDS, lastAnchor: "baseline" }),
      {
        objective: "Add the export command and run the tests.",
        anchors: [{ name: "baseline" }],
      },
    );
    assert.equal(
      heuristicStructure({ records: [RECORDS[1] as MilestoneRecord] }),
      undefined,
    );
    const variant = parseVariant("tree-heuristic");
    const derived = planVariant(fixture, jev(), variant, new Map());
    assert.ok("structure" in derived.prepared.context.state);
    const given = planVariant(
      prepareCase(milestoneCase(STRUCTURE)),
      jev(),
      variant,
      new Map(),
    );
    assert.deepEqual(
      (given.prepared.context.state as { structure: unknown }).structure,
      buildMilestoneClassifierContext({
        records: RECORDS,
        structure: STRUCTURE,
      }).context.state.structure,
    );
  });
});

const yes = (confidence = 0.9): EvalAnswer => ({ choice: "yes", confidence });
const no = (confidence = 0.9): EvalAnswer => ({ choice: "no", confidence });

describe("granular combination", () => {
  const SIGNALS = ["asks-user", "blocked", "open-work", "finished"] as const;
  const GIVEN: (EvalAnswer | undefined)[] = [
    yes(),
    no(),
    undefined,
    { choice: "maybe", confidence: 1 },
  ];

  it("never yields milestone unless every signal is answered and only finished is yes", () => {
    let milestones = 0;
    for (const a of GIVEN)
      for (const b of GIVEN)
        for (const c of GIVEN)
          for (const d of GIVEN) {
            const answers = Object.fromEntries(
              SIGNALS.flatMap((signal, index) => {
                const given = [a, b, c, d][index];
                return given ? [[signal, given]] : [];
              }),
            );
            const status = combineGranular(RECORDS, answers).status;
            const clear =
              a?.choice === "no" &&
              b?.choice === "no" &&
              c?.choice === "no" &&
              d?.choice === "yes";
            assert.equal(status?.choice === "milestone", clear);
            if (clear) milestones++;
            if (a?.choice === "yes") assert.equal(status?.choice, "await-user");
            else if (b?.choice === "yes")
              assert.equal(status?.choice, "blocked");
            else if (c?.choice === "yes")
              assert.equal(status?.choice, "continue");
          }
    assert.equal(milestones, 1);
  });

  it("states milestone with the lowest confidence of its signals", () => {
    const status = combineGranular(RECORDS, {
      "asks-user": no(0.95),
      blocked: no(0.9),
      "open-work": no(0.6),
      finished: yes(0.99),
    }).status;
    assert.deepEqual(status, { choice: "milestone", confidence: 0.6 });
  });

  it("decides a non-milestone status from one answer even when the others are missing", () => {
    assert.deepEqual(
      combineGranular(RECORDS, { "open-work": yes(0.8) }).status,
      {
        choice: "continue",
        confidence: 0.8,
      },
    );
    assert.equal(
      combineGranular(RECORDS, { finished: yes() }).status,
      undefined,
    );
    assert.deepEqual(
      combineGranular(RECORDS, {
        "asks-user": no(),
        blocked: no(),
        "open-work": no(),
        finished: no(0.7),
      }).status,
      { choice: "continue", confidence: 0.7 },
    );
  });

  it("takes the newest finished-phase report and the confidence of everything after it", () => {
    assert.deepEqual(
      combineGranular(RECORDS, {
        "report:a1": no(),
        "report:a2": yes(0.85),
        "report:a3": no(0.7),
      }).boundary,
      { choice: "a2", confidence: 0.7 },
    );
    assert.deepEqual(
      combineGranular(RECORDS, {
        "report:a1": no(0.8),
        "report:a2": no(0.9),
        "report:a3": no(0.95),
      }).boundary,
      { choice: "none", confidence: 0.8 },
    );
  });

  it("leaves the boundary out when a record at or after the report is unanswered", () => {
    assert.equal(
      combineGranular(RECORDS, { "report:a1": yes(), "report:a2": yes() })
        .boundary,
      undefined,
    );
    assert.equal(
      combineGranular(RECORDS, {
        "report:a1": yes(),
        "report:a2": { choice: "yes", confidence: 7 },
        "report:a3": no(),
      }).boundary,
      undefined,
    );
  });
});

describe("generated structure", () => {
  it("keeps only valid, bounded, printable text and known record ids", () => {
    const parsed = parseStructure(
      JSON.stringify({
        objective: `  ship\nthe\u0007 export ${"x".repeat(400)}`,
        goals: ["a", 3, "", "b".repeat(500), "c", "d", "e", "f", "g"],
        anchors: [
          { name: "first", afterRecordId: "a2" },
          { name: "ghost", afterRecordId: "zz" },
          { name: "", afterRecordId: "a1" },
          { name: "n".repeat(90), afterRecordId: "a3" },
        ],
      }),
      ["u1", "a1", "a2", "a3"],
    );
    assert.deepEqual(parsed.problems, []);
    const structure = parsed.structure;
    assert.ok(structure);
    assert.equal(structure.objective?.length, 200);
    assert.match(structure.objective ?? "", /^ship the export /u);
    assert.equal(structure.goals?.length, 6);
    assert.equal(structure.goals?.[1]?.length, 160);
    assert.deepEqual(
      structure.anchors?.map((a) => a.afterRecordId),
      ["a2", "a3"],
    );
    assert.equal(structure.anchors?.[1]?.name.length, 40);
  });

  it("rejects output without an objective or lists", () => {
    assert.deepEqual(parseStructure("nope", []).problems, [
      "output is not valid JSON",
    ]);
    assert.deepEqual(parseStructure("{}", []).problems, [
      "no objective",
      "goals is not a list",
      "anchors is not a list",
    ]);
  });

  it("is priced for the largest structure the limits allow", () => {
    const worst = worstCaseStructure(RECORDS);
    const adversarial = parseStructure(
      JSON.stringify({
        objective: '"\\'.repeat(300),
        goals: Array.from({ length: 9 }, () => "\u{1F600}".repeat(300)),
        anchors: Array.from({ length: 12 }, () => ({
          name: "\u20ac".repeat(90),
          afterRecordId: "a2",
        })),
      }),
      RECORDS.map((r) => r.id),
    ).structure;
    assert.ok(adversarial);
    const bytes = (structure: MilestoneStructure) =>
      Buffer.byteLength(
        JSON.stringify(
          buildMilestoneClassifierContext({ records: RECORDS, structure })
            .context,
        ),
      );
    assert.ok(bytes(adversarial) <= bytes(worst));
  });

  it("is generated once through the chat route and recorded with its cost evidence", async () => {
    const sent: string[] = [];
    const reply = JSON.stringify({
      objective: "Ship the export command",
      goals: ["export command", "docs"],
      anchors: [{ name: "export done", afterRecordId: "a2" }],
    });
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      sent.push(String(init?.body));
      const chunk = (extra: object) =>
        `data: ${JSON.stringify({ id: "gen-struct-1", ...extra })}\n\n`;
      return new Response(
        chunk({
          choices: [{ index: 0, delta: { role: "assistant", content: reply } }],
        }) +
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
          chunk({
            choices: [],
            usage: { prompt_tokens: 90, completion_tokens: 30, cost: 0.00002 },
          }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const fixture = prepareCase(milestoneCase());
    const candidate = luna();
    const result = await generateStructure(fixture, candidate, options(fetch));
    assert.equal(sent.length, 1);
    const planned = structureRequest(fixture, candidate).bodyBytes;
    const bytes = Buffer.byteLength(sent[0] ?? "");
    assert.ok(bytes >= planned && bytes <= planned + PROMPT_MARGIN_BYTES);
    const observation = result.observation as StructureObservation;
    assert.equal(observation.model, "chat:openai/gpt-6-luna#structure");
    assert.equal(observation.status, "ok");
    assert.equal(observation.generationId, "gen-struct-1");
    assert.equal(
      observation.requestSha256,
      createHash("sha256")
        .update(sent[0] ?? "")
        .digest("hex"),
    );
    assert.deepEqual(observation.structure?.anchors, [
      { name: "export done", afterRecordId: "a2" },
    ]);
    assert.equal(result.evidence.responseCostUsd, 0.00002);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  });
});

describe("tree-luna variant", () => {
  const fixture: PreparedCase = prepareCase(milestoneCase());
  const variant = parseVariant("tree-luna");
  const generated = (
    extra: Partial<StructureObservation> = {},
  ): StructureObservation => ({
    caseId: "m-1",
    model: "chat:openai/gpt-6-luna#structure",
    adapter: "chat",
    repetition: 0,
    status: "ok",
    answers: {},
    durationMs: 1200,
    costUsd: 0.00004,
    costSource: "generation",
    costBoundUsd: 0.01,
    startedAt: "2026-10-23T00:00:00.000Z",
    structure: { objective: "Ship the export command" },
    ...extra,
  });

  it("sends the generated structure, keeps the case folds and carries the structure cost and time", async () => {
    const structures = new Map([["m-1", generated()]]);
    const sent: string[] = [];
    const plan = planVariant(
      prepareCase(milestoneCase(STRUCTURE)),
      jev(),
      variant,
      structures,
    );
    const result = await plan.run(
      options(async (_input, init) => {
        sent.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    );
    const { state } = JSON.parse(sent[0] ?? "{}") as {
      state: { structure: MilestoneStructure };
    };
    assert.equal(state.structure.objective, "Ship the export command");
    assert.deepEqual(state.structure.folds, STRUCTURE.folds);
    assert.equal(state.structure.goals, undefined);
    assert.deepEqual(result.carried, {
      costUsd: 0.00004,
      costSource: "generation",
      boundUsd: 0.01,
    });
    assert.ok(result.observation.durationMs >= 1200);
  });

  it("records an error without a request when the structure is missing", async () => {
    let requests = 0;
    const plan = planVariant(fixture, jev(), variant, new Map());
    const result = await plan.run(
      options(async () => {
        requests++;
        return new Response("{}");
      }),
    );
    assert.equal(requests, 0);
    assert.equal(result.observation.status, "error");
    assert.match(
      result.observation.error ?? "",
      /structure generation failed/u,
    );
    assert.equal(result.evidence.dispatched, false);
  });

  it("adds carried costs and treats an unknown part as unknown", () => {
    const carried = {
      costUsd: 0.00004,
      costSource: "generation" as const,
      boundUsd: 0.01,
    };
    assert.deepEqual(
      addCarried({ costUsd: 0.00001, costSource: "generation" }, carried),
      { costUsd: 0.00005, costSource: "generation" },
    );
    assert.deepEqual(
      addCarried({ costUsd: 0.00001, costSource: "response" }, carried)
        .costSource,
      "response",
    );
    assert.deepEqual(
      addCarried({ costUsd: null, costSource: "unknown" }, carried),
      { costUsd: null, costSource: "unknown" },
    );
    assert.deepEqual(addCarried({ costUsd: 0, costSource: "local" }, carried), {
      costUsd: 0.00004,
      costSource: "generation",
    });
  });
});
