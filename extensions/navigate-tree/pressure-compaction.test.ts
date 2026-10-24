import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type PressureCutEntry,
  planPressureCut,
} from "./pressure-compaction.ts";

const user = (id: string, tokens: number): PressureCutEntry => ({
  entryId: id,
  tokens,
  roles: ["user"],
  toolCallIds: [],
  toolResultIds: [],
});
const call = (
  id: string,
  tokens: number,
  ...calls: string[]
): PressureCutEntry => ({
  entryId: id,
  tokens,
  roles: ["assistant"],
  toolCallIds: calls,
  toolResultIds: [],
});
const result = (
  id: string,
  tokens: number,
  callId: string,
): PressureCutEntry => ({
  entryId: id,
  tokens,
  roles: ["toolResult"],
  toolCallIds: [],
  toolResultIds: [callId],
});

/** One user prompt followed by `turns` read/result tool turns of 10k tokens each. */
function agentRun(turns: number): PressureCutEntry[] {
  const entries = [user("u", 1_000)];
  for (let i = 1; i <= turns; i++)
    entries.push(
      call(`a${i}`, 1_000, `c${i}`),
      result(`r${i}`, 9_000, `c${i}`),
    );
  return entries;
}

describe("planPressureCut", () => {
  it("keeps at least the recent budget and cuts at the start of a tool turn inside one long run", () => {
    const plan = planPressureCut({
      entries: agentRun(20),
      keepRecentTokens: 45_000,
    });
    assert.deepEqual(plan, {
      kind: "cut",
      firstKeptEntryId: "a16",
      keptTokens: 50_000,
      prefixTokens: 151_000,
    });
  });

  it("never keeps a tool result whose call would be summarized", () => {
    // Parallel calls: both results follow a single assistant message.
    const entries = [
      user("u", 1_000),
      call("a1", 1_000, "c1", "c2"),
      result("r1", 30_000, "c1"),
      result("r2", 30_000, "c2"),
      call("a2", 1_000, "c3"),
      result("r3", 5_000, "c3"),
    ];
    const plan = planPressureCut({ entries, keepRecentTokens: 20_000 });
    // r2 alone would satisfy the budget, but cutting there or at r1 splits c1/c2.
    assert.equal(plan.kind, "cut");
    assert.equal(plan.kind === "cut" && plan.firstKeptEntryId, "a1");
  });

  it("cuts at a user message between runs", () => {
    const entries = [
      ...agentRun(3),
      user("u2", 1_000),
      call("b1", 1_000, "d1"),
      result("s1", 9_000, "d1"),
    ];
    const plan = planPressureCut({ entries, keepRecentTokens: 10_500 });
    assert.equal(plan.kind === "cut" && plan.firstKeptEntryId, "u2");
  });

  it("keeps a single oversized tool turn whole instead of cutting inside it", () => {
    const entries = [
      user("u", 1_000),
      call("a1", 1_000, "c1"),
      result("r1", 90_000, "c1"),
    ];
    const plan = planPressureCut({ entries, keepRecentTokens: 10_000 });
    assert.deepEqual(plan, {
      kind: "cut",
      firstKeptEntryId: "a1",
      keptTokens: 91_000,
      prefixTokens: 1_000,
    });
  });

  it("skips when everything fits the kept budget or no boundary is safe", () => {
    const within = planPressureCut({
      entries: agentRun(2),
      keepRecentTokens: 50_000,
    });
    assert.equal(within.kind === "skip" && within.reason, "within-recent");
    // Only the first entry starts with a message; the rest continue a turn.
    const none = planPressureCut({
      entries: [
        user("u", 1_000),
        { ...call("a1", 1_000, "c1"), roles: [] },
        result("r1", 30_000, "c1"),
      ],
      keepRecentTokens: 10_000,
    });
    assert.equal(none.kind === "skip" && none.reason, "no-safe-cut");
  });
});
