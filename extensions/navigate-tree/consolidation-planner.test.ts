import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  type ConsolidationInput,
  type ProjectedHandoff,
  planConsolidation,
} from "./consolidation-planner.ts";

const LIMITS = { maxHandoffs: 4, maxWindowShare: 0.1, keepNewest: 2 };

/** `count` handoffs of `tokens` each, separated by 10k tokens of work. */
function handoffs(count: number, tokens = 1_000): ProjectedHandoff[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `h${i + 1}`,
    tokens,
    prefixTokens: i * (tokens + 10_000) + 2_000,
  }));
}

function input(overrides: Partial<ConsolidationInput>): ConsolidationInput {
  return {
    limits: LIMITS,
    handoffs: handoffs(5),
    contextWindow: 400_000,
    summaryTokens: 2_000,
    minSavingTokens: 5_000,
    ...overrides,
  };
}

describe("planConsolidation", () => {
  it("cuts at the oldest of the newest kept handoffs when the count is exceeded", () => {
    const plan = planConsolidation(input({}));
    assert.deepEqual(plan, {
      kind: "consolidate",
      firstKeptEntryId: "h4",
      merged: 3,
      trigger: "count",
      prefixTokens: 35_000,
      savingTokens: 33_000,
    });
  });

  it("fires on window share alone with few but large handoffs", () => {
    const plan = planConsolidation(
      input({ handoffs: handoffs(3, 20_000), contextWindow: 400_000 }),
    );
    assert.equal(plan.kind, "consolidate");
    assert.equal(plan.kind === "consolidate" && plan.trigger, "share");
    assert.equal(plan.kind === "consolidate" && plan.firstKeptEntryId, "h2");
  });

  it("stays quiet below both limits and when the window is unknown", () => {
    assert.equal(
      planConsolidation(input({ handoffs: handoffs(4) })).kind,
      "skip",
    );
    const unknown = planConsolidation(
      input({ handoffs: handoffs(3, 50_000), contextWindow: 0 }),
    );
    assert.equal(unknown.kind === "skip" && unknown.reason, "below-threshold");
  });

  it("refuses when every handoff is within the kept range", () => {
    const plan = planConsolidation(
      input({ handoffs: handoffs(2, 30_000), contextWindow: 100_000 }),
    );
    assert.equal(plan.kind === "skip" && plan.reason, "too-few-handoffs");
  });

  it("refuses a cut whose prefix would barely shrink, so a fresh compaction does not repeat", () => {
    const compacted: ProjectedHandoff[] = [
      { entryId: "h5", tokens: 30_000, prefixTokens: 3_000 },
      { entryId: "h6", tokens: 30_000, prefixTokens: 40_000 },
      { entryId: "h7", tokens: 30_000, prefixTokens: 80_000 },
    ];
    const plan = planConsolidation(
      input({
        handoffs: compacted,
        contextWindow: 400_000,
        limits: { ...LIMITS, keepNewest: 2 },
      }),
    );
    assert.equal(plan.kind, "consolidate");
    const again = planConsolidation(
      input({ handoffs: compacted.slice(1), contextWindow: 400_000 }),
    );
    assert.equal(again.kind === "skip" && again.reason, "too-few-handoffs");
    const noSaving = planConsolidation(
      input({
        handoffs: [
          { entryId: "x", tokens: 50_000, prefixTokens: 1_000 },
          { entryId: "y", tokens: 50_000, prefixTokens: 6_000 },
          { entryId: "z", tokens: 50_000, prefixTokens: 9_000 },
        ],
      }),
    );
    assert.equal(noSaving.kind === "skip" && noSaving.reason, "no-saving");
  });
});
