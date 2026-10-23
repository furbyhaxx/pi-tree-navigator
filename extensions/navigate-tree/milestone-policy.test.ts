/**
 * Tests for the milestone policy: strict validation of the object form, and
 * how `evaluateMilestone` turns the answers of two fake models into decisions.
 * No live calls. Node test runner.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PolicyRegistry } from "./intent-policy.ts";
import {
  INSTRUCTED_WORDING,
  type MilestoneInput,
} from "./milestone-classifier.ts";
import {
  evaluateMilestone,
  parseMilestonePolicyObject,
  RECOMMENDED_MILESTONE_CLASSIFIER,
  RECOMMENDED_MILESTONE_POLICY,
  resolveMilestonePolicy,
} from "./milestone-policy.ts";

const JEV = `${RECOMMENDED_MILESTONE_POLICY.provider}/${RECOMMENDED_MILESTONE_POLICY.classifier}`;
const LUNA = `${RECOMMENDED_MILESTONE_POLICY.provider}/${RECOMMENDED_MILESTONE_POLICY.confirmer}`;

const INPUT: MilestoneInput = {
  records: [
    { id: "u1", role: "user", text: "Add the export command." },
    { id: "a1", role: "assistant", text: "Done; tests pass." },
  ],
};

const policy = (setting: string) => {
  const out = resolveMilestonePolicy(setting);
  assert.ok(out, setting);
  return out;
};

const problems = (value: unknown): readonly string[] => {
  const out = parseMilestonePolicyObject(value);
  assert.equal(out.ok, false);
  return out.ok ? [] : out.problems;
};

describe("milestone policy setting", () => {
  it("resolves the preset to the benchmarked pair with the 0.7 gate", () => {
    assert.deepEqual(policy(RECOMMENDED_MILESTONE_CLASSIFIER), {
      minConfidence: 0.7,
      classifier: JEV,
      confirmer: LUNA,
      instructions: {},
    });
  });

  it("returns undefined for anything but the preset and a valid canonical object", () => {
    for (const text of ["", "off", JEV, "{", "[]", '{"preset":"other"}'])
      assert.equal(resolveMilestonePolicy(text), undefined, text);
  });

  it("overrides the preset field by field and swaps or drops a stage", () => {
    const swapped = parseMilestonePolicyObject({
      confirmer: { model: " acme/judge " },
      minConfidence: 0.85,
      preset: "recommended",
      boundary: { instructions: " Last record? " },
    });
    assert.ok(swapped.ok);
    assert.equal(
      swapped.canonical,
      JSON.stringify({
        preset: "recommended",
        minConfidence: 0.85,
        confirmer: { model: "acme/judge" },
        boundary: { instructions: "Last record?" },
      }),
    );
    assert.deepEqual(policy(swapped.canonical), {
      minConfidence: 0.85,
      classifier: JEV,
      confirmer: "acme/judge",
      instructions: { boundary: "Last record?" },
    });
    assert.equal(
      policy('{"preset":"recommended","confirmer":{"model":null}}').confirmer,
      null,
    );
    assert.equal(
      policy('{"preset":"recommended","classifier":{"model":null}}').classifier,
      null,
    );
  });

  it("is off without a preset until a classifier model is given", () => {
    assert.equal(policy("{}").classifier, null);
    assert.equal(
      policy('{"classifier":{"model":"acme/judge"}}').classifier,
      "acme/judge",
    );
    assert.equal(
      policy('{"classifier":{"model":"acme/judge"}}').confirmer,
      null,
    );
  });

  it("names every problem by its field path", () => {
    assert.deepEqual(
      problems({
        preset: "best",
        minConfidence: 0,
        classifier: { model: "nomodel" },
        confirmer: { model: 3, extra: 1 },
        status: { instructions: "  " },
        boundary: "x",
        other: true,
      }),
      [
        "autoNavigate.milestone.other is not a field",
        'autoNavigate.milestone.preset must be "recommended"',
        "autoNavigate.milestone.minConfidence must be a number above 0 up to 1",
        'autoNavigate.milestone.classifier.model must be "provider/id" or null',
        "autoNavigate.milestone.confirmer.extra is not a field",
        'autoNavigate.milestone.confirmer.model must be "provider/id" or null',
        "autoNavigate.milestone.status.instructions must be a text of 1-1000 characters",
        "autoNavigate.milestone.boundary must be an object",
      ],
    );
    assert.deepEqual(problems([]), [
      "autoNavigate.milestone must be an object",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Evaluation with fake models
// ---------------------------------------------------------------------------

interface Answer {
  choice: string;
  confidence: number;
}
type Answers = Record<string, Answer>;

/** A model: answers, or a failure. */
type Behaviour = Answers | Error;

interface Sent {
  model: string;
  questions: string[];
  statusInstructions?: string;
  /** The chat prompt, for chat models. */
  prompt?: string;
}

const USAGE = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: {
    input: 0.001,
    output: 0.0001,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.0011,
  },
};

function fakeRegistry(
  behaviour: { jev?: Behaviour; luna?: Behaviour; chatText?: string },
  sent: Sent[] = [],
  delays: { jev?: number; luna?: number } = {},
): PolicyRegistry {
  const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const record = (model: string, context: { questions: object }) => {
    const status = (
      context.questions as Record<string, { instructions: string }>
    ).status;
    sent.push({
      model,
      questions: Object.keys(context.questions),
      ...(status && { statusInstructions: status.instructions }),
    });
  };
  return {
    getAvailableOfType: async (type: string) =>
      type === "classifier"
        ? [
            {
              provider: "openrouter",
              id: RECOMMENDED_MILESTONE_POLICY.classifier,
              api: "decisions",
            },
          ]
        : [
            {
              provider: "openrouter",
              id: RECOMMENDED_MILESTONE_POLICY.confirmer,
              api: "openai-completions",
            },
          ],
    classify: async (model: { id: string }, context: { questions: object }) => {
      record(model.id, context);
      await wait(delays.jev);
      const given = behaviour.jev;
      if (given instanceof Error) throw given;
      return {
        answers: Object.fromEntries(
          Object.entries(given ?? {}).map(([id, a]) => [
            id,
            { type: "choice", ...a, probabilities: {} },
          ]),
        ),
        usage: USAGE,
        stopReason: "stop",
      };
    },
    streamSimple: (
      model: { id: string },
      chat: { messages: { content: string }[] },
    ) => ({
      result: async () => {
        sent.push({
          model: model.id,
          questions: [],
          ...(chat.messages[0] && { prompt: chat.messages[0].content }),
        });
        await wait(delays.luna);
        const given = behaviour.luna;
        if (given instanceof Error)
          return {
            stopReason: "error",
            errorMessage: given.message,
            content: [],
          };
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text:
                behaviour.chatText ?? JSON.stringify({ answers: given ?? {} }),
            },
          ],
          usage: USAGE,
        };
      },
    }),
  } as unknown as PolicyRegistry;
}

const sure = (choice: string, confidence = 0.9): Answer => ({
  choice,
  confidence,
});

const evaluate = (
  setting: string,
  behaviour: Parameters<typeof fakeRegistry>[0],
  signal?: AbortSignal,
  sent?: Sent[],
  delays?: { jev?: number; luna?: number },
) =>
  evaluateMilestone({
    policy: policy(setting),
    registry: fakeRegistry(behaviour, sent, delays),
    input: INPUT,
    ...(signal && { signal }),
  });

describe("evaluateMilestone", () => {
  it("decides each question where both models give the same accepted choice", async () => {
    const out = await evaluate("recommended", {
      jev: { status: sure("milestone", 0.95), boundary: sure("a1", 0.8) },
      luna: { status: sure("milestone", 0.7), boundary: sure("a1", 0.99) },
    });
    assert.deepEqual(out.status, { kind: "accept", status: "milestone" });
    assert.deepEqual(out.boundary, { kind: "record", recordId: "a1" });
    assert.deepEqual(
      out.ran.map((r) => [r.stage, r.model, r.answered]),
      [
        ["classifier", JEV, true],
        ["confirmer", LUNA, true],
      ],
    );
    assert.deepEqual(out.warnings, []);
  });

  it("reports the none boundary as its own decision", async () => {
    const both = { status: sure("continue"), boundary: sure("none") };
    const out = await evaluate("recommended", { jev: both, luna: both });
    assert.deepEqual(out.status, { kind: "accept", status: "continue" });
    assert.deepEqual(out.boundary, { kind: "none" });
  });

  it("abstains where the models disagree or either is below the gate, per question", async () => {
    const out = await evaluate("recommended", {
      jev: { status: sure("milestone"), boundary: sure("a1", 0.69) },
      luna: { status: sure("continue"), boundary: sure("a1") },
    });
    assert.deepEqual(out.status, { kind: "abstain" });
    assert.deepEqual(out.boundary, { kind: "abstain" });
    assert.deepEqual(out.warnings, []);

    const partial = await evaluate("recommended", {
      jev: { status: sure("milestone"), boundary: sure("a1") },
      luna: { status: sure("milestone", 0.5), boundary: sure("a1") },
    });
    assert.deepEqual(partial.status, { kind: "abstain" });
    assert.deepEqual(partial.boundary, { kind: "record", recordId: "a1" });
  });

  it("never lets one model decide alone when a confirmer is configured", async () => {
    const out = await evaluate("recommended", {
      jev: { status: sure("milestone", 1), boundary: sure("a1", 1) },
      luna: new Error("HTTP 503"),
    });
    assert.deepEqual(out.status, { kind: "abstain" });
    assert.deepEqual(out.boundary, { kind: "abstain" });
    assert.equal(out.ran[1]?.answered, false);
    assert.equal(out.warnings.length, 1);
    assert.match(
      out.warnings[0] ?? "",
      /confirmer .*gpt-6-luna.*failed \(HTTP 503\)/u,
    );

    const flipped = await evaluate("recommended", {
      jev: new Error("down"),
      luna: { status: sure("milestone", 1), boundary: sure("a1", 1) },
    });
    assert.deepEqual(flipped.status, { kind: "abstain" });
    assert.match(flipped.warnings[0] ?? "", /classifier .*failed \(down\)/u);
  });

  it("treats choices that were not offered, unknown questions and malformed output as abstentions with a warning", async () => {
    const wrongChoice = await evaluate("recommended", {
      jev: { status: sure("milestone"), boundary: sure("zz") },
      luna: { status: sure("milestone"), boundary: sure("zz") },
    });
    assert.deepEqual(wrongChoice.status, {
      kind: "accept",
      status: "milestone",
    });
    assert.deepEqual(wrongChoice.boundary, { kind: "abstain" });
    assert.equal(wrongChoice.warnings.length, 2);
    assert.match(
      wrongChoice.warnings[0] ?? "",
      /no usable answer to boundary/u,
    );

    const extra = await evaluate("recommended", {
      jev: {
        status: sure("milestone"),
        boundary: sure("a1"),
        granular: sure("yes"),
      },
      luna: { status: sure("milestone"), boundary: sure("a1") },
    });
    assert.deepEqual(extra.status, { kind: "abstain" });
    assert.match(extra.warnings[0] ?? "", /unknown question granular/u);

    const badRange = await evaluate("recommended", {
      jev: { status: sure("milestone", 7), boundary: sure("a1") },
      luna: { status: sure("milestone"), boundary: sure("a1") },
    });
    assert.deepEqual(badRange.status, { kind: "abstain" });
    assert.deepEqual(badRange.boundary, { kind: "record", recordId: "a1" });

    const prose = await evaluate("recommended", {
      jev: { status: sure("milestone"), boundary: sure("a1") },
      luna: {},
      chatText: "The work is done.",
    });
    assert.deepEqual(prose.status, { kind: "abstain" });
    assert.equal(prose.warnings.length, 1);
  });

  it("asks both models at once, with one identical request carrying both questions", async () => {
    const sent: Sent[] = [];
    const started = Date.now();
    const out = await evaluate(
      "recommended",
      {
        jev: { status: sure("milestone"), boundary: sure("a1") },
        luna: { status: sure("milestone"), boundary: sure("a1") },
      },
      undefined,
      sent,
      { jev: 150, luna: 150 },
    );
    assert.ok(Date.now() - started < 290, "stages ran one after another");
    assert.deepEqual(
      sent.map((s) => s.model).sort(),
      [
        RECOMMENDED_MILESTONE_POLICY.classifier,
        RECOMMENDED_MILESTONE_POLICY.confirmer,
      ].sort(),
    );
    assert.deepEqual(sent.find((s) => s.questions.length)?.questions, [
      "status",
      "boundary",
    ]);
    assert.equal(
      sent.find((s) => s.questions.length)?.statusInstructions,
      INSTRUCTED_WORDING.status.instructions,
    );
    assert.deepEqual(out.status, { kind: "accept", status: "milestone" });
  });

  it("sums the usage the stages reported", async () => {
    const out = await evaluate("recommended", {
      jev: { status: sure("milestone"), boundary: sure("a1") },
      luna: { status: sure("milestone"), boundary: sure("a1") },
    });
    assert.deepEqual(out.ran[0]?.usage, {
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.0011,
    });
    assert.equal(out.usage.inputTokens, 200);
    assert.ok(Math.abs(out.usage.costUsd - 0.0022) < 1e-12);
  });

  it("lets the classifier decide alone only when the confirmer is dropped", async () => {
    const only = '{"preset":"recommended","confirmer":{"model":null}}';
    const sent: Sent[] = [];
    const out = await evaluate(
      only,
      {
        jev: { status: sure("blocked"), boundary: sure("none", 0.6) },
        luna: new Error("never asked"),
      },
      undefined,
      sent,
    );
    assert.deepEqual(out.status, { kind: "accept", status: "blocked" });
    assert.deepEqual(out.boundary, { kind: "abstain" });
    assert.deepEqual(
      out.ran.map((r) => r.stage),
      ["classifier"],
    );
    assert.deepEqual(
      sent.map((s) => s.model),
      [RECOMMENDED_MILESTONE_POLICY.classifier],
    );
  });

  it("asks nothing when the policy is off, the records are empty or the signal is aborted", async () => {
    const sent: Sent[] = [];
    const given = { jev: { status: sure("milestone") } };
    const off = await evaluate(
      '{"preset":"recommended","classifier":{"model":null}}',
      given,
      undefined,
      sent,
    );
    const aborted = await evaluate(
      "recommended",
      given,
      AbortSignal.abort(),
      sent,
    );
    const empty = await evaluateMilestone({
      policy: policy("recommended"),
      registry: fakeRegistry(given, sent),
      input: { records: [] },
    });
    for (const out of [off, aborted, empty]) {
      assert.deepEqual(out.status, { kind: "abstain" });
      assert.deepEqual(out.ran, []);
      assert.deepEqual(out.warnings, []);
    }
    assert.deepEqual(sent, []);
  });

  it("abstains with one warning, and asks nothing, when a model is not in the catalog", async () => {
    const sent: Sent[] = [];
    const out = await evaluateMilestone({
      policy: policy(
        '{"preset":"recommended","confirmer":{"model":"acme/ghost"}}',
      ),
      registry: fakeRegistry({ jev: { status: sure("milestone") } }, sent),
      input: INPUT,
    });
    assert.deepEqual(out.status, { kind: "abstain" });
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0] ?? "", /acme\/ghost not available/u);
    assert.deepEqual(sent, []);
  });

  it("sends the policy's instruction override and keeps the preset criteria", async () => {
    const sent: Sent[] = [];
    await evaluate(
      '{"preset":"recommended","status":{"instructions":"Custom?"}}',
      { jev: {}, luna: {} },
      undefined,
      sent,
    );
    assert.equal(
      sent.find((s) => s.questions.length)?.statusInstructions,
      "Custom?",
    );
    const prompt = sent.find((s) => s.prompt)?.prompt ?? "";
    assert.match(prompt, /## status\nCustom\?\nChoices:/u);
    assert.ok(prompt.includes(INSTRUCTED_WORDING.status.criteria.milestone));
  });
});
