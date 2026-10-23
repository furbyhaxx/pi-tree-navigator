import assert from "node:assert/strict";
import { test } from "node:test";
import { retirementCaseId } from "./retirement-cases.ts";
import {
  rankScreen,
  type ScreenRow,
  type SimulationInput,
  simulate,
} from "./retirement-report.ts";
import type { EvalCase, EvalObservation } from "./types.ts";

const ITEMS = [
  { id: "R1", kind: "rule", text: "Always use pnpm." },
  { id: "R2", kind: "rule", text: "Never push to main." },
];

const parent = (id: string, contradicts: string[]): EvalCase => ({
  id,
  split: "holdout",
  family: id,
  task: "supersession",
  input: { type: "intent", message: "m", activeItems: ITEMS },
  expected: {
    kind: { choices: ["rule"], unsafeChoices: [], rationale: "r".repeat(30) },
    contradicts: {
      choices: contradicts,
      unsafeChoices: ITEMS.map((i) => i.id).filter(
        (i) => !contradicts.includes(i),
      ),
      rationale: "r".repeat(30),
    },
  },
});

const observation = (
  model: string,
  caseId: string,
  answers: EvalObservation["answers"],
  durationMs: number,
  extra: Partial<EvalObservation> = {},
): EvalObservation => ({
  caseId,
  model,
  adapter: model.startsWith("chat") ? "chat" : "decisions",
  repetition: 0,
  status: "ok",
  answers,
  durationMs,
  costUsd: 0.001,
  costSource: "generation",
  costBoundUsd: 0.01,
  startedAt: "2026-10-23T00:00:00.000Z",
  ...extra,
});

const MS = "decisions:microsoft/microsoft-decision-1";
const LUNA = "chat:openai/gpt-6-luna";
const VERIFIER = "decisions:acme/judge";
const kind = { choice: "rule", confidence: 0.9 };
const pick = (choice: string, confidence = 0.9) => ({
  kind,
  contradicts: { choice, confidence },
});

// A: ms right (R1). B: ms abstains, luna wrong (R2 on a none case). C: ms wrong (R2).
// D: ms abstains, luna right (R1). E: ms right (R1) but the verifier will say no.
const parents = [
  parent("p-a", ["R1"]),
  parent("p-b", ["none"]),
  parent("p-c", ["none"]),
  parent("p-d", ["R1"]),
  parent("p-e", ["R1"]),
];
const msObs = [
  observation(MS, "p-a", pick("R1"), 100),
  observation(MS, "p-b", pick("R2", 0.4), 100),
  observation(MS, "p-c", pick("R2"), 100),
  observation(MS, "p-d", pick("R1", 0.3), 100),
  observation(MS, "p-e", pick("R1"), 100),
];
const lunaObs = parents.map((p) =>
  observation(
    LUNA,
    p.id,
    p.id === "p-b" ? pick("R2", 0.95) : pick("R1", 0.95),
    2000,
    { costUsd: 0.01 },
  ),
);
const verdict = (parentId: string, item: string, choice: string, ms = 500) =>
  observation(
    VERIFIER,
    retirementCaseId(parentId, item),
    { retires: { choice, confidence: 0.9 } },
    ms,
  );
const base: Omit<SimulationInput, "verifier"> = {
  parents,
  ms: msObs,
  luna: lunaObs,
};
const fullVerifier = [
  verdict("p-a", "R1", "yes", 300),
  verdict("p-b", "R2", "no", 400),
  verdict("p-c", "R2", "yes", 500),
  verdict("p-d", "R1", "yes", 600),
  verdict("p-e", "R1", "no", 700),
];

test("without verification the pipeline keeps its accepted unsafe retirements", () => {
  const sim = simulate({ ...base, verifier: [] }, "none");
  assert.equal(sim.decisions, 5);
  assert.equal(sim.acceptedExact, 3);
  assert.equal(sim.unsafe, 2);
  assert.equal(sim.verified, 0);
  assert.equal(sim.addedP95Ms, null);
  assert.equal(sim.totalP95Ms, 2100);
});

test("verify escalated checks only retirements proposed after microsoft abstained", () => {
  const sim = simulate({ ...base, verifier: fullVerifier }, "escalated");
  assert.equal(sim.verified, 2);
  assert.equal(sim.confirmed, 1);
  assert.equal(sim.rejected, 1);
  assert.equal(sim.unsafeRejected, 1);
  assert.equal(sim.correctRejected, 0);
  assert.equal(sim.unsafe, 1);
  assert.equal(sim.acceptedExact, 3);
  assert.equal(sim.acceptedExactIfRejectedIsNone, 4);
  assert.equal(sim.addedP95Ms, 600);
  assert.equal(sim.totalP95Ms, 2700);
});

test("verify every retirement also blocks correct retirements the verifier doubts", () => {
  const sim = simulate({ ...base, verifier: fullVerifier }, "every");
  assert.equal(sim.verified, 5);
  assert.equal(sim.unsafe, 1);
  assert.equal(sim.unsafeRejected, 1);
  assert.equal(sim.correctRejected, 1);
  assert.equal(sim.acceptedExact, 2);
  assert.equal(sim.addedP95Ms, 700);
  assert.ok(sim.addedCostPer1000 > 0);
});

test("a failed check keeps the item; a missing pair is reported and excluded", () => {
  const failing = [
    ...fullVerifier.filter((o) => !o.caseId.includes("p-d")),
    verdict("p-d", "R1", "yes"),
  ].map((o) =>
    o.caseId === retirementCaseId("p-b", "R2")
      ? { ...o, status: "error" as const, answers: {} }
      : o,
  );
  const sim = simulate({ ...base, verifier: failing }, "escalated");
  assert.equal(sim.failed, 1);
  assert.equal(sim.rejected, 0);
  assert.equal(sim.unsafeRejected, 1);

  const missing = simulate(
    {
      ...base,
      verifier: fullVerifier.filter(
        (o) => o.caseId !== retirementCaseId("p-c", "R2"),
      ),
    },
    "every",
  );
  assert.deepEqual(missing.missing, [
    { caseId: "p-c", item: "R2", repetition: 0 },
  ]);
  assert.equal(missing.decisions, 4);
});

test("ranking puts zero unsafe first, then positives, cost and p95", () => {
  const row = (model: string, over: Partial<ScreenRow>): ScreenRow => ({
    model,
    unsafe: 0,
    negatives: 10,
    negativeAcceptedExact: 10,
    positives: 4,
    positiveAcceptedExact: 2,
    positiveRate: 0.5,
    ambiguous: 1,
    ambiguousConfirmed: 0,
    errors: 0,
    decisions: 15,
    costPer1000: 0.02,
    p95Ms: 300,
    ...over,
  });
  const ranked = rankScreen([
    row("cheap-unsafe", { unsafe: 1, positiveRate: 1, costPer1000: 0.001 }),
    row("slow", { p95Ms: 900 }),
    row("accurate", { positiveRate: 0.75 }),
    row("pricey", { costPer1000: 0.5 }),
    row("fast", { p95Ms: 200 }),
  ]).map((r) => r.model);
  assert.deepEqual(ranked, [
    "accurate",
    "fast",
    "slow",
    "pricey",
    "cheap-unsafe",
  ]);
});
