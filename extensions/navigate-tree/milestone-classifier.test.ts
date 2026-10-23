import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMilestoneClassifierContext,
  MAX_STRUCTURE_ITEMS,
} from "./milestone-classifier.ts";

const records = [
  { id: "r1", role: "user" as const, text: "Add the parser." },
  { id: "r2", role: "assistant" as const, text: "Parser added and tested." },
];

describe("milestone classifier context", () => {
  it("leaves the request without structure unchanged", () => {
    const { context } = buildMilestoneClassifierContext({
      records,
      lastAnchor: "start",
    });
    assert.deepEqual(Object.keys(context.state as object), [
      "note",
      "lastAnchor",
      "records",
    ]);
  });

  it("sends the newest structure items with bounded text", () => {
    const folds = Array.from({ length: MAX_STRUCTURE_ITEMS + 3 }, (_, i) => ({
      label: `phase-${i}`,
      title: `Phase ${i}`,
      outcome: "x".repeat(1_000),
    }));
    const { context } = buildMilestoneClassifierContext({
      records,
      structure: {
        objective: "Ship the parser",
        folds,
        anchors: [{ name: "parser-start", afterRecordId: "r1" }],
      },
    });
    const structure = (
      context.state as {
        structure: {
          objective: string;
          folds: { label: string; outcome: string }[];
          anchors: unknown[];
        };
      }
    ).structure;
    assert.equal(structure.objective, "Ship the parser");
    assert.equal(structure.folds.length, MAX_STRUCTURE_ITEMS);
    assert.equal(structure.folds[0].label, "phase-3");
    assert.ok(structure.folds[0].outcome.length <= 300);
    assert.deepEqual(structure.anchors, [
      { name: "parser-start", afterRecordId: "r1" },
    ]);
  });
});
