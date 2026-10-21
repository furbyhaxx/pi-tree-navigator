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

interface CapturedRequest {
  systemPrompt: string;
  text: string;
}

function fakeRunner(
  replyText: string,
  capturedRequests: CapturedRequest[] = [],
  limits = { contextWindow: 128_000, maxOutputTokens: 4_000 },
): ProposalModelRunner {
  return {
    name: "openai/gpt-6-luna:low",
    ...limits,
    async complete(req) {
      capturedRequests.push({ systemPrompt: req.systemPrompt, text: req.text });
      return { text: replyText };
    },
  };
}

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
const REQUEST_RESERVE = 2_048;

function chain(count: number, textFor: (i: number) => string): SessionEntry[] {
  const out: SessionEntry[] = [user("e0", null, "Begin")];
  for (let i = 1; i < count; i++) {
    out.push(
      i % 2
        ? assistant(`e${i}`, `e${i - 1}`, textFor(i))
        : user(`e${i}`, `e${i - 1}`, textFor(i)),
    );
  }
  return out;
}

const autoCall = (
  overrides: Partial<Parameters<typeof evaluateAutoNavigateTurn>[0]> &
    Pick<Parameters<typeof evaluateAutoNavigateTurn>[0], "runner" | "branch">,
) =>
  evaluateAutoNavigateTurn({
    config: materializeAutoNavigateConfig({
      enabled: true,
      mode: "anchor-and-rewind",
      rewindAtTokens: 50_000,
    }),
    getLabel: () => undefined,
    activeTokens: 70_000,
    tokensSinceLastAnchor: 60_000,
    turnsSinceLastCheck: 6,
    ...overrides,
  });

const FOCUS =
  "1. User instruction verbatim: continue. 2. Done: everything above. 3. Next: the following unit.";

describe("auto-navigate sidecar controller", () => {
  const branch: SessionEntry[] = [
    user("u1", null, "Implement wave 1 units"),
    assistant("a1", "u1", "Context gathered."),
    user("u2", "a1", "Proceed with W1"),
    assistant("a2", "u2", "W1 finished and verified."),
  ];
  const labels = new Map<string, string>([["a1", "anchor:start"]]);

  it("extracts a valid anchor milestone and applies tool disclosure rules", async () => {
    const requests: CapturedRequest[] = [];
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

  describe("bounded evidence", () => {
    const tight = { contextWindow: 8_000, maxOutputTokens: 1_000 };
    const budgetOf = (l: { contextWindow: number; maxOutputTokens: number }) =>
      l.contextWindow - l.maxOutputTokens - REQUEST_RESERVE;

    it("fails closed without a call when the newest record cannot fit", async () => {
      const requests: CapturedRequest[] = [];
      const entries = chain(4, (i) => (i === 3 ? "x".repeat(20_000) : "ok"));
      const decision = await autoCall({
        runner: fakeRunner(
          '{"action":"anchor","name":"w1","target_entry_id":"e3"}',
          requests,
          tight,
        ),
        branch: entries,
        getLabel: (id) => (id === "e0" ? "anchor:start" : undefined),
      });
      assert.deepEqual(decision, { action: "none" });
      assert.equal(requests.length, 0);
    });

    it("keeps escaped JSON framing, system prompt and payload within the budget", async () => {
      const limits = { contextWindow: 16_000, maxOutputTokens: 2_000 };
      const requests: CapturedRequest[] = [];
      const entries = chain(40, () => `"q" \\ b\nl \u{1F600}\u2028 `.repeat(6));
      await autoCall({
        runner: fakeRunner(
          '{"action":"anchor","name":"w1","target_entry_id":"e39"}',
          requests,
          limits,
        ),
        branch: entries,
        getLabel: (id) => (id === "e0" ? "anchor:start" : undefined),
      });
      assert.equal(requests.length, 1);
      const { systemPrompt, text } = requests[0];
      assert.ok(utf8(systemPrompt) + utf8(text) <= budgetOf(limits));
      const payload = JSON.parse(text);
      assert.equal(payload.segment_records.at(-1).id, "e39");
      assert.ok(payload.omitted_older_records > 0);
      assert.equal(
        payload.omitted_older_records + payload.segment_records.length,
        40,
      );
    });

    it("rejects anchor targets that are omitted, unknown, missing or already labeled", async () => {
      const entries = chain(40, () => "padding ".repeat(40));
      const labels = new Map([
        ["e0", "anchor:start"],
        ["e39", "checkpoint"],
        ["e38", "branch:old-work"],
      ]);
      const requests: CapturedRequest[] = [];
      const ask = async (reply: object) => {
        const decision = await autoCall({
          runner: fakeRunner(JSON.stringify(reply), requests, tight),
          branch: entries,
          getLabel: (id) => labels.get(id),
        });
        return decision;
      };
      await ask({ action: "anchor", name: "w1", target_entry_id: "e37" });
      const sent = JSON.parse(requests[0].text).segment_records as {
        id: string;
      }[];
      assert.ok(!sent.some((r) => r.id === "e1"));
      for (const bad of [
        { action: "anchor", name: "w1", target_entry_id: "e1" },
        { action: "anchor", name: "w1", target_entry_id: "nope" },
        { action: "anchor", name: "w1" },
        { action: "anchor", name: "w1", target_entry_id: "e39" },
        { action: "anchor", name: "w1", target_entry_id: "e0" },
        { action: "anchor", name: "checkpoint", target_entry_id: "e37" },
        { action: "anchor", name: "old-work", target_entry_id: "e37" },
        { action: "anchor", name: "start", target_entry_id: "e37" },
      ]) {
        assert.deepEqual(
          await ask(bad),
          { action: "none" },
          JSON.stringify(bad),
        );
      }
      assert.deepEqual(
        await ask({ action: "anchor", name: "w1", target_entry_id: "e37" }),
        { action: "anchor", name: "w1", targetEntryId: "e37" },
      );
    });

    it("exposes only the newest anchor and rejects earlier unseen anchors", async () => {
      const entries = chain(8, (i) => `step ${i}`);
      const labels = new Map([
        ["e1", "anchor:old"],
        ["e4", "anchor:new"],
      ]);
      const requests: CapturedRequest[] = [];
      const ask = (rewindTo: string) =>
        autoCall({
          runner: fakeRunner(
            JSON.stringify({
              action: "rewind",
              rewind_to: rewindTo,
              new_label: "folded",
              summary_focus: FOCUS,
            }),
            requests,
          ),
          branch: entries,
          getLabel: (id) => labels.get(id),
        });
      assert.deepEqual(await ask("old"), { action: "none" });
      assert.deepEqual(await ask("new"), {
        action: "rewind",
        rewindTo: "new",
        newLabel: "folded",
        summaryFocus: FOCUS,
      });
      const payload = JSON.parse(requests[0].text);
      assert.deepEqual(payload.active_anchors, ["new"]);
      assert.equal(payload.mode, "anchor-or-rewind");
      assert.equal(payload.segment_records[0].id, "e4");
    });

    it("does not offer rewind when the anchor-to-leaf segment is truncated", async () => {
      const entries = chain(40, () => "padding ".repeat(40));
      const requests: CapturedRequest[] = [];
      const decision = await autoCall({
        runner: fakeRunner(
          JSON.stringify({
            action: "rewind",
            rewind_to: "start",
            new_label: "folded",
            summary_focus: FOCUS,
          }),
          requests,
          tight,
        ),
        branch: entries,
        getLabel: (id) => (id === "e0" ? "anchor:start" : undefined),
      });
      assert.deepEqual(decision, { action: "none" });
      const payload = JSON.parse(requests[0].text);
      assert.deepEqual(payload.active_anchors, []);
      assert.equal(payload.mode, "anchor-only");
      assert.ok(payload.omitted_older_records > 0);
    });

    it("rejects new rewind labels that collide with any existing label", async () => {
      const labels = new Map([
        ["a1", "anchor:start"],
        ["u2", "branch:finished"],
        ["a2", "checkpoint"],
      ]);
      for (const newLabel of ["finished", "checkpoint", "start"]) {
        const decision = await autoCall({
          runner: fakeRunner(
            JSON.stringify({
              action: "rewind",
              rewind_to: "start",
              new_label: newLabel,
              summary_focus: FOCUS,
            }),
          ),
          branch,
          getLabel: (id) => labels.get(id),
        });
        assert.deepEqual(decision, { action: "none" }, newLabel);
      }
    });
  });
});
