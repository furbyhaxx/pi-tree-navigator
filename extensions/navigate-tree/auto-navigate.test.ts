import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildAutoNavigateRewindSteerText,
  evaluateAutoNavigateTurn,
} from "./auto-navigate.ts";
import { materializeAutoNavigateConfig } from "./auto-navigate-config.ts";
import type { ProposalModelRunner } from "./proposal-engine.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function user(
  id: string,
  parentId: string | null,
  content: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content, timestamp: 1 },
  };
}

function assistant(id: string, parentId: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openrouter",
      model: "google/gemini-4-argon",
      stopReason: "stop",
      usage: {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    },
  };
}

function fakeRunner(
  replyText: string,
  capturedRequests: string[] = [],
): ProposalModelRunner {
  return {
    name: "openai/gpt-6-luna:low",
    contextWindow: 128_000,
    maxOutputTokens: 4_000,
    async complete(req) {
      capturedRequests.push(req.text);
      return { text: replyText };
    },
  };
}

describe("auto-navigate sidecar controller", () => {
  const branch: SessionEntry[] = [
    user("u1", null, "Implement wave 1 units"),
    assistant("a1", "u1", "Context gathered."),
    user("u2", "a1", "Proceed with W1"),
    assistant("a2", "u2", "W1 finished and verified."),
  ];
  const labels = new Map<string, string>([["a1", "anchor:start"]]);

  it("extracts a valid anchor milestone and applies tool disclosure rules", async () => {
    const requests: string[] = [];
    const config = materializeAutoNavigateConfig({
      enabled: true,
      mode: "anchor-and-rewind",
      checkEveryTurns: 2,
      minTokensSinceAnchor: 10_000,
      rewindAtTokens: 100_000,
      tools: { bash: "calls-only" },
    });
    const decision = await evaluateAutoNavigateTurn({
      config,
      runner: fakeRunner(
        '{"action":"anchor","name":"w1-complete","target_entry_id":"a2"}',
        requests,
      ),
      branch,
      getLabel: (id) => labels.get(id),
      activeTokens: 40_000,
      tokensSinceLastAnchor: 30_000,
      turnsSinceLastCheck: 2,
    });
    assert.deepEqual(decision, {
      action: "anchor",
      name: "w1-complete",
      targetEntryId: "a2",
    });
    assert.equal(requests.length, 1);
  });

  it("extracts a valid rewind decision when activeTokens >= rewind_at_tokens", async () => {
    const config = materializeAutoNavigateConfig({
      enabled: true,
      mode: "anchor-and-rewind",
      checkEveryTurns: 2,
      minTokensSinceAnchor: 10_000,
      rewindAtTokens: 80_000,
    });
    const focus =
      "1. User instruction verbatim: Proceed with W1. 2. Done: W1 finished and verified. 3. Next: Start W2.";
    const decision = await evaluateAutoNavigateTurn({
      config,
      runner: fakeRunner(
        JSON.stringify({
          action: "rewind",
          rewind_to: "start",
          new_label: "w1-folded",
          summary_focus: focus,
        }),
      ),
      branch,
      getLabel: (id) => labels.get(id),
      activeTokens: 95_000,
      tokensSinceLastAnchor: 80_000,
      turnsSinceLastCheck: 2,
    });
    assert.deepEqual(decision, {
      action: "rewind",
      rewindTo: "start",
      newLabel: "w1-folded",
      summaryFocus: focus,
    });
    const steer = buildAutoNavigateRewindSteerText(decision);
    assert.match(steer, /rewindTo: "start"/);
    assert.match(steer, /newLabel: "w1-folded"/);
  });

  it("rejects duplicate labels, unknown rewind targets, and short summary_focus", async () => {
    const config = materializeAutoNavigateConfig({
      enabled: true,
      mode: "anchor-and-rewind",
      rewindAtTokens: 50_000,
    });
    for (const bad of [
      '{"action":"anchor","name":"start","target_entry_id":"a2"}',
      '{"action":"rewind","rewind_to":"nonexistent","new_label":"ok-name","summary_focus":"' +
        "x".repeat(80) +
        '"}',
      '{"action":"rewind","rewind_to":"start","new_label":"ok-name","summary_focus":"too short"}',
    ]) {
      const decision = await evaluateAutoNavigateTurn({
        config,
        runner: fakeRunner(bad),
        branch,
        getLabel: (id) => labels.get(id),
        activeTokens: 70_000,
        tokensSinceLastAnchor: 60_000,
        turnsSinceLastCheck: 6,
      });
      assert.deepEqual(decision, { action: "none" });
    }
  });
});
