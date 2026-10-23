import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
  createFoldEngine,
  type FoldCommitResult,
  type FoldEngineDeps,
  type FoldPrepared,
  type FoldRequest,
  selectFoldTarget,
} from "./fold-engine.ts";
import type {
  FoldSegmentRecord,
  FoldSummaryRunner,
} from "./fold-summarizer.ts";
import { extractSummaryText } from "./summary-prompt.ts";

type Completion = Awaited<ReturnType<FoldSummaryRunner["complete"]>>;
type Request = Parameters<FoldSummaryRunner["complete"]>[0];

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const SUMMARY = "## Goal\nShip the fold.\n\n## Next Steps\n1. Verify.";

const request: FoldRequest = {
  sessionId: "s1",
  origin: "manual",
  rewindTo: "anchor:start",
  newLabel: "done",
  focus: "fold the work",
};

const text = (message: Message | undefined): string => {
  const content = message && "content" in message ? message.content : "";
  return typeof content === "string"
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");
};
const isFinal = (call: Request) =>
  text(call.messages.at(-1)).startsWith("[navigate_tree]");

interface Fake {
  calls: Request[];
  runner: FoldSummaryRunner;
}

/** A fake runner recording every request; `reply` scripts the response. */
function fakeRunner(
  reply: (
    call: Request,
    index: number,
  ) => Partial<Completion> | Promise<Partial<Completion>> = () => ({}),
  contextWindow = 8000,
): Fake {
  const calls: Request[] = [];
  const runner: FoldSummaryRunner = {
    name: "fake",
    contextWindow,
    maxOutputTokens: 2000,
    thinking: "off",
    async complete(call) {
      const index = calls.length;
      calls.push(call);
      const scripted = await reply(call, index);
      return {
        text: isFinal(call) ? SUMMARY : `NOTE ${index}`,
        stopReason: "stop",
        usage,
        ...scripted,
      };
    },
  };
  return { calls, runner };
}

const bigText = Array.from(
  { length: 900 },
  (_, i) => `line ${i} é 日本語 😀 payload-${i}-${"x".repeat(20)}`,
).join("\n");

function prepared(records?: FoldSegmentRecord[]): FoldPrepared {
  return {
    leafId: "leaf",
    targetId: "target",
    segment: {
      background: "",
      records: records ?? [
        { id: "u1", role: "user", text: "Fold the work." },
        { id: "big", role: "tool", text: bigText },
        { id: "a1", role: "assistant", text: "Done." },
      ],
    },
  };
}

interface Harness {
  deps: FoldEngineDeps<{ summaryId: string }>;
  fake: Fake;
  committed: Array<{ prepared: FoldPrepared; text: string }>;
  prepareCalls: FoldRequest[];
}

function harness(
  overrides: Partial<FoldEngineDeps<{ summaryId: string }>> = {},
  fake = fakeRunner(),
): Harness {
  const committed: Harness["committed"] = [];
  const prepareCalls: FoldRequest[] = [];
  const deps: FoldEngineDeps<{ summaryId: string }> = {
    prepare: (req) => {
      prepareCalls.push(req);
      return prepared();
    },
    runner: () => fake.runner,
    admit: () => ({ fits: false, inputEstimate: 999_999 }),
    limits: { mapOutputTokens: 200, reduceOutputTokens: 400 },
    async commit(_req, snapshot, summary) {
      committed.push({ prepared: snapshot, text: summary.text });
      return { ok: true, summaryId: "summary-1" };
    },
    ...overrides,
  };
  return { deps, fake, committed, prepareCalls };
}

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("fold engine run", () => {
  it("splits a record larger than the chunk budget without truncating it, then commits once with the summary text", async () => {
    const h = harness();
    const engine = createFoldEngine(h.deps);
    const outcome = await engine.run(request);

    assert.equal(outcome.status, "done", JSON.stringify(outcome));
    if (outcome.status !== "done") return;
    assert.equal(outcome.strategy, "chunked");
    assert.ok(outcome.chunks > 1);
    assert.equal(outcome.calls, h.fake.calls.length);
    assert.equal(outcome.usage.length, outcome.calls);
    assert.equal(outcome.text, extractSummaryText(SUMMARY));
    assert.equal(outcome.commit.summaryId, "summary-1");

    assert.equal(h.committed.length, 1);
    assert.equal(h.committed[0].text, extractSummaryText(SUMMARY));
    assert.equal(h.committed[0].prepared.targetId, "target");

    const parts: string[] = [];
    const header = /\[big part (\d+)\/(\d+)\] tool:\n/;
    for (const call of h.fake.calls.slice(0, -1)) {
      const body = text(call.messages[0]);
      const match = header.exec(body);
      if (!match) continue;
      const rest = body.slice(match.index + match[0].length);
      const end = rest.search(
        /\n\n(?:\[[a-z0-9 /]+\] \w+:\n|Extract evidence)/,
      );
      parts.push(end < 0 ? rest : rest.slice(0, end));
    }
    assert.ok(parts.length > 1, "the oversized record must be split");
    assert.equal(parts.join(""), bigText);
    assert.equal(engine.isBusy(request.sessionId), false);
  });

  it("returns busy for a concurrent request on the same session without calling anything, while another session runs", async () => {
    const gate = deferred<void>();
    const blocked = fakeRunner(async () => {
      await gate.promise;
      return {};
    });
    const free = fakeRunner();
    const h = harness({
      runner: (req) => (req.sessionId === "s1" ? blocked : free).runner,
    });
    const engine = createFoldEngine(h.deps);

    const first = engine.run(request);
    assert.equal(engine.isBusy("s1"), true);
    const prepareCount = h.prepareCalls.length;
    assert.deepEqual(await engine.run(request), { status: "busy" });
    assert.equal(h.prepareCalls.length, prepareCount);

    const other = await engine.run({ ...request, sessionId: "s2" });
    assert.equal(other.status, "done");
    assert.equal(engine.isBusy("s2"), false);
    assert.equal(engine.isBusy("s1"), true);
    assert.equal(h.committed.length, 1);

    gate.resolve();
    assert.equal((await first).status, "done");
    assert.equal(h.committed.length, 2);
    assert.equal(engine.isBusy("s1"), false);
  });

  it("releases the lock after a failed gate, a thrown dependency and a thrown commit", async () => {
    let fail: "prepare" | "throw" | "commit" | "none" = "prepare";
    const h = harness({
      prepare: () => {
        if (fail === "prepare") return { error: "no anchor" };
        if (fail === "throw") throw new Error("boom");
        return prepared();
      },
      commit: async () => {
        if (fail === "commit") throw new Error("disk full");
        return { ok: true, summaryId: "x" };
      },
    });
    const engine = createFoldEngine(h.deps);

    const gate = await engine.run(request);
    assert.deepEqual(gate, {
      status: "failed",
      stage: "gate",
      reason: "prepare",
      detail: "no anchor",
      usage: [],
    });
    assert.equal(engine.isBusy("s1"), false);

    fail = "throw";
    const thrown = await engine.run(request);
    assert.equal(thrown.status, "failed");
    if (thrown.status === "failed") {
      assert.equal(thrown.stage, "gate");
      assert.equal(thrown.reason, "exception");
      assert.equal(thrown.detail, "boom");
    }
    assert.equal(engine.isBusy("s1"), false);

    fail = "commit";
    const commit = await engine.run(request);
    assert.equal(commit.status, "failed");
    if (commit.status === "failed") {
      assert.equal(commit.stage, "commit");
      assert.equal(commit.detail, "disk full");
      assert.ok(
        commit.usage.length > 0,
        "the spent summary calls stay visible",
      );
    }
    assert.equal(engine.isBusy("s1"), false);

    fail = "none";
    assert.equal((await engine.run(request)).status, "done");
  });

  it("fails the gate when no runner can be built, before any model call", async () => {
    const h = harness({ runner: () => ({ error: "no model configured" }) });
    const outcome = await createFoldEngine(h.deps).run(request);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.stage, "gate");
    assert.equal(outcome.reason, "runner");
    assert.equal(h.fake.calls.length, 0);
    assert.equal(h.committed.length, 0);
  });

  it("returns the usage of a failed summary and never commits", async () => {
    const h = harness(
      {},
      fakeRunner((_call, index) =>
        index === 1 ? { stopReason: "error", errorMessage: "overloaded" } : {},
      ),
    );
    const outcome = await createFoldEngine(h.deps).run(request);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.stage, "summary");
    assert.equal(outcome.reason, "provider-error");
    assert.match(outcome.detail, /overloaded/);
    assert.equal(outcome.usage.length, 2);
    assert.equal(h.committed.length, 0);
  });

  it("reports a refused commit with the summary's usage", async () => {
    const refused: FoldCommitResult<{ summaryId: string }> = {
      ok: false,
      reason: "the fold does not reduce context",
    };
    const h = harness({ commit: async () => refused });
    const outcome = await createFoldEngine(h.deps).run(request);
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.stage, "commit");
    assert.equal(outcome.reason, "commit-refused");
    assert.equal(outcome.detail, refused.reason);
    assert.ok(outcome.usage.length > 0);
  });

  it("forwards progress and the segment settings to the summarizer", async () => {
    const h = harness({
      prepare: () => ({
        ...prepared(),
        continuitySection: "<continuity>keep</continuity>",
      }),
    });
    const phases: string[] = [];
    const outcome = await createFoldEngine(h.deps).run(request, {
      onProgress: (progress) => phases.push(progress.phase),
    });
    assert.equal(outcome.status, "done");
    assert.equal(phases.at(-1), "reduce");
    assert.ok(phases.includes("map"));
    assert.match(
      text(h.fake.calls.at(-1)?.messages.at(-1)),
      /<continuity>keep/,
    );
  });
});

describe("fold engine cancellation", () => {
  it("cancels before any work when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const outcome = await createFoldEngine(h.deps).run(request, {
      signal: controller.signal,
    });
    assert.deepEqual(outcome, { status: "cancelled", usage: [] });
    assert.equal(h.prepareCalls.length, 0);
    assert.equal(h.committed.length, 0);
  });

  it("cancels during summarization without committing and keeps the spent usage", async () => {
    const controller = new AbortController();
    const h = harness(
      {},
      fakeRunner((_call, index) => {
        if (index === 1) controller.abort();
        return {};
      }),
    );
    const engine = createFoldEngine(h.deps);
    const outcome = await engine.run(request, { signal: controller.signal });
    assert.equal(outcome.status, "cancelled");
    if (outcome.status === "cancelled") assert.ok(outcome.usage.length > 0);
    assert.equal(h.committed.length, 0);
    assert.equal(engine.isBusy("s1"), false);
  });

  it("cancels when the signal aborts on the final summary call", async () => {
    const controller = new AbortController();
    const h = harness(
      {},
      fakeRunner((call) => {
        if (isFinal(call)) controller.abort();
        return {};
      }),
    );
    const outcome = await createFoldEngine(h.deps).run(request, {
      signal: controller.signal,
    });
    assert.equal(outcome.status, "cancelled");
    assert.equal(h.committed.length, 0);
  });

  it("finishes a commit that has started even if the signal aborts meanwhile", async () => {
    const controller = new AbortController();
    const h = harness({
      commit: async () => {
        controller.abort();
        return { ok: true, summaryId: "kept" };
      },
    });
    const outcome = await createFoldEngine(h.deps).run(request, {
      signal: controller.signal,
    });
    assert.equal(outcome.status, "done");
    if (outcome.status === "done")
      assert.equal(outcome.commit.summaryId, "kept");
  });
});

describe("selectFoldTarget", () => {
  const anchor = (
    name: string,
    projectedAfterTokens: number,
    valid = true,
    reason?: string,
  ) => ({ name, valid, reason, projectedAfterTokens });

  it("takes the newest valid anchor that fits the budget", () => {
    const result = selectFoldTarget(
      [
        anchor("a", 10_000),
        anchor("b", 40_000),
        anchor("c", 90_000),
        anchor("d", 60_000, false, "open tool batch"),
        anchor("e", 120_000),
      ],
      90_000,
    );
    assert.ok(result.ok);
    assert.equal(result.candidate.name, "c");
    assert.equal(result.withinBudget, true);
  });

  it("falls back to the oldest valid anchor when none fits", () => {
    const result = selectFoldTarget(
      [
        anchor("a", 5, false, "pre-compaction"),
        anchor("b", 200_000),
        anchor("c", 300_000),
      ],
      100_000,
    );
    assert.ok(result.ok);
    assert.equal(result.candidate.name, "b");
    assert.equal(result.withinBudget, false);
  });

  it("lists every refusal when no anchor is valid", () => {
    assert.deepEqual(
      selectFoldTarget(
        [anchor("a", 1, false, "non-reducing"), anchor("b", 2, false)],
        100,
      ),
      { ok: false, reasons: ["a: non-reducing", "b: not valid"] },
    );
    assert.deepEqual(selectFoldTarget([], 100), {
      ok: false,
      reasons: ["no anchors on the active branch"],
    });
  });

  it("accepts an anchor exactly at the budget", () => {
    const result = selectFoldTarget([anchor("a", 50), anchor("b", 100)], 100);
    assert.ok(result.ok);
    assert.equal(result.candidate.name, "b");
  });
});
