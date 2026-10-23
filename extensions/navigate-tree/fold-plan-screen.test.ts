/**
 * Tests for the `/anchor fold` plan screen.
 *
 * Node test runner. The context is faked: the screen runs through a scripted
 * `custom`, dialogs answer from queues, and every dep call is recorded.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type FoldPlan,
  type FoldPlanCandidate,
  type FoldPlanDeps,
  type FoldPlanResult,
  foldPlanResult,
  openFoldPlanScreen,
} from "./fold-plan-screen.ts";
import type { FoldSummaryProgress } from "./fold-summarizer.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const MIN_FOCUS = 20;
const MODEL = "openai/gpt-6-luna:low";

const candidate = (
  name: string,
  extra: Partial<FoldPlanCandidate> = {},
): FoldPlanCandidate => ({
  name,
  valid: true,
  beforeTokens: 90_000,
  projectedAfterTokens: 30_000,
  contextWindow: 372_000,
  strategy: "in-context",
  suggestedLabel: `${name}-folded`,
  ...extra,
});

/** Root to leaf: the middle anchor is recommended, the leaf one frees too little. */
const sampleCandidates = (): FoldPlanCandidate[] => [
  candidate("start", { auto: true, strategy: "chunked" }),
  candidate("impl-start", { afterPreview: "Implement the parser" }),
  candidate("recent", {
    valid: false,
    reason: "Would free only about 0.9k tok; a fold needs at least 4.0k.",
    projectedAfterTokens: 89_000,
  }),
];

interface Screen {
  handleInput(data: string): void;
  render(width: number): string[];
}
type Script = (screen: Screen) => Promise<void>;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const unwrapped = (text: string): string => text.replace(/\n\s+/g, " ");

function harness(
  options: {
    candidates?: FoldPlanCandidate[];
    running?: boolean;
    recommended?: number | undefined;
    columns?: number;
    answers?: {
      inputs?: (string | undefined)[];
      editors?: (string | undefined)[];
    };
    onAbort?: FoldPlanResult;
    queue?: ReturnType<FoldPlanDeps["queue"]>;
  } = {},
) {
  const columns = options.columns ?? 60;
  const candidates = options.candidates ?? sampleCandidates();
  const notifications: { message: string; type?: string }[] = [];
  const dialogs = {
    input: [] as [string, string | undefined][],
    editor: [] as [string, string | undefined][],
  };
  const inputs = [...(options.answers?.inputs ?? [])];
  const editors = [...(options.answers?.editors ?? [])];
  const scripts: Script[] = [];
  const heights: number[] = [];
  const calls = {
    start: [] as {
      plan: FoldPlan;
      signal: AbortSignal;
      onProgress(progress: FoldSummaryProgress): void;
    }[],
    queue: [] as FoldPlan[],
  };
  let release: (result: FoldPlanResult) => void = () => {};
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) =>
        void notifications.push({ message, type }),
      async input(title: string, placeholder?: string) {
        dialogs.input.push([title, placeholder]);
        return inputs.shift();
      },
      async editor(title: string, prefill?: string) {
        dialogs.editor.push([title, prefill]);
        return editors.shift();
      },
      custom(factory: (...args: unknown[]) => Screen) {
        const script = scripts.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve, reject) => {
          let closed = false;
          const tui = {
            terminal: { rows: 40, columns },
            requestRender() {},
          };
          const screen = factory(tui, theme, undefined, (value: unknown) => {
            closed = true;
            resolve(value);
          });
          script(screen)
            .then(() => {
              if (!closed) reject(new Error("the script left the screen open"));
            })
            .catch(reject);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const deps: FoldPlanDeps = {
    candidates: () => [...candidates],
    recommend: () => ("recommended" in options ? options.recommended : 1),
    isAgentRunning: () => options.running ?? false,
    summaryModel: () => MODEL,
    minFocusLength: MIN_FOCUS,
    start(_ctx, plan, { signal, onProgress }) {
      calls.start.push({ plan, signal, onProgress });
      return new Promise((resolve) => {
        release = resolve;
        const aborted = options.onAbort;
        if (aborted) signal.addEventListener("abort", () => resolve(aborted));
      });
    },
    queue(_ctx, plan) {
      calls.queue.push(plan);
      return options.queue ?? { ok: true };
    },
  };
  /** Render, check the width budget and the frozen height, and return the text. */
  const view = (screen: Screen): string => {
    const lines = screen.render(columns);
    for (const line of lines) assert.ok(visibleWidth(line) <= columns, line);
    heights.push(lines.length);
    return lines.join("\n");
  };
  return {
    ctx,
    deps,
    calls,
    dialogs,
    notifications,
    heights,
    view,
    release: (result: FoldPlanResult) => release(result),
    run: (...screens: Script[]) => {
      scripts.push(...screens);
      return openFoldPlanScreen(ctx, deps);
    },
  };
}

const done = (
  extra: Partial<Extract<FoldPlanResult, { status: "done" }>> = {},
): FoldPlanResult => ({
  status: "done",
  label: "impl-start-folded",
  beforeTokens: 90_000,
  afterTokens: 30_000,
  strategy: "in-context",
  calls: 1,
  ...extra,
});

describe("fold plan screen", () => {
  it("starts the recommended anchor with its suggested label and shows the progress", async () => {
    const h = harness();
    const exit = await h.run(async (screen) => {
      const plan = h.view(screen);
      assert.match(plan, /Anchor\/Fold/);
      assert.match(plan, /2 of 3 foldable/);
      assert.match(plan, /rewind to impl-start/);
      assert.match(plan, /label impl-start-folded/);
      assert.match(plan, /~90\.0k → ~30\.0k tok of 372k \(8\.1%\)/);
      assert.match(plan, new RegExp(`in-context via ${MODEL}`));
      assert.match(plan, /focus: agent writes it/);
      const rows = plan.split("\n");
      assert.ok(
        rows.findIndex((line) => line.includes("→ ◆ impl-start")) >
          rows.findIndex((line) => line.includes("◆ recent")),
        "newest anchor first, cursor on the recommended one",
      );
      assert.match(plan, /◆ impl-start \(recommended\)\s+−60\.0k tok/);
      assert.match(plan, /after: “Implement the parser”/);

      screen.handleInput(ENTER);
      assert.deepEqual(
        h.calls.start.map(({ plan }) => plan),
        [{ anchor: "impl-start", label: "impl-start-folded" }],
      );
      assert.match(h.view(screen), /folding · preparing/);
      h.calls.start[0].onProgress({ phase: "map", call: 2, plannedCalls: 5 });
      assert.match(h.view(screen), /folding · map · call 2\/5/);
      screen.handleInput(DOWN);
      assert.match(
        h.view(screen),
        /rewind to impl-start/,
        "no switching while folding",
      );

      h.release(done());
      await tick();
      assert.match(
        unwrapped(h.view(screen)),
        /✓ folded as 'impl-start-folded' · freed ~60\.0k tok \(now ~30\.0k\) · in-context · 1 call/,
      );
      screen.handleInput(ENTER);
    });
    assert.equal(exit, "done");
    assert.equal(new Set(h.heights).size, 1, "the panel never changes height");
  });

  it("aborts the signal on Esc while folding and reports the cancellation", async () => {
    const h = harness({ onAbort: { status: "cancelled" } });
    const exit = await h.run(async (screen) => {
      screen.handleInput(ENTER);
      assert.equal(h.calls.start[0].signal.aborted, false);
      screen.handleInput(ESC);
      assert.equal(h.calls.start[0].signal.aborted, true);
      assert.match(h.view(screen), /cancelling the fold/);
      await tick();
      assert.match(h.view(screen), /cancelled — nothing was changed/);
      screen.handleInput(ESC);
    });
    assert.equal(exit, "back");
  });

  it("shows a failed fold's stage and detail, and a start that throws", async () => {
    const h = harness();
    const exit = await h.run(async (screen) => {
      screen.handleInput(ENTER);
      h.release({
        status: "failed",
        stage: "summary",
        reason: "provider-error",
        detail: "model returned 529",
      });
      await tick();
      assert.match(h.view(screen), /✗ failed at summary: model returned 529/);
      screen.handleInput(ENTER);
    });
    assert.equal(exit, "back");

    const thrown = harness();
    thrown.deps.start = async () => {
      throw new Error("socket closed");
    };
    await thrown.run(async (screen) => {
      screen.handleInput(ENTER);
      await tick();
      assert.match(thrown.view(screen), /✗ failed at gate: socket closed/);
      screen.handleInput(ESC);
    });
  });

  it("queues instead of starting while the agent runs, and says so", async () => {
    const h = harness({ running: true });
    const exit = await h.run(async (screen) => {
      const plan = h.view(screen);
      assert.match(plan, /agent working · folds at the next turn boundary/);
      assert.match(plan, /enter queue fold/);
      screen.handleInput(ENTER);
      assert.deepEqual(h.calls.queue, [
        { anchor: "impl-start", label: "impl-start-folded" },
      ]);
      assert.equal(h.calls.start.length, 0);
      assert.match(
        h.view(screen),
        /✓ queued — folds at the next turn boundary/,
      );
      assert.doesNotMatch(h.view(screen), /folding/);
      screen.handleInput(ENTER);
    });
    assert.equal(exit, "done");
  });

  it("keeps the screen open with the reason when the queue refuses", async () => {
    const h = harness({
      running: true,
      queue: { ok: false, reason: "A fold is already queued." },
    });
    await h.run(async (screen) => {
      screen.handleInput(ENTER);
      assert.match(h.view(screen), /✗ A fold is already queued\./);
      screen.handleInput(ESC);
    });
  });

  it("does not fold an anchor that is not foldable and explains why", async () => {
    const h = harness();
    const exit = await h.run(async (screen) => {
      screen.handleInput(UP);
      const plan = h.view(screen);
      assert.match(plan, /→ ◆ recent\s+not foldable/);
      assert.match(plan, /✗ cannot fold to recent/);
      assert.match(plan, /Would free only about 0\.9k tok/);
      assert.doesNotMatch(plan, /enter fold/);
      screen.handleInput(ENTER);
      assert.match(h.view(screen), /✗ Would free only about 0\.9k tok/);
      screen.handleInput("e");
      assert.equal(h.dialogs.input.length, 0);
      screen.handleInput(ESC);
    });
    assert.equal(exit, "back");
    assert.equal(h.calls.start.length + h.calls.queue.length, 0);
  });

  it("falls back to the newest valid anchor without a recommendation", async () => {
    const h = harness({ recommended: undefined });
    await h.run(async (screen) => {
      assert.match(h.view(screen), /→ ◆ impl-start/);
      screen.handleInput(ESC);
    });
  });

  it("explains how to set an anchor when there are none", async () => {
    const h = harness({ candidates: [] });
    const exit = await h.run(async (screen) => {
      const plan = h.view(screen);
      assert.match(plan, /No anchors yet\./);
      assert.match(unwrapped(plan), /\/anchor list and press n/);
      screen.handleInput(ENTER);
      assert.match(h.view(screen), /no anchor to fold to/);
      screen.handleInput(ESC);
    });
    assert.equal(exit, "back");
    assert.equal(h.calls.start.length, 0);
  });

  it("edits the label and the focus; the focus stays across anchors, the label does not", async () => {
    const focus = "Latest instruction: finish the parser; remaining: tests";
    const h = harness({
      answers: {
        inputs: ["My New Label!"],
        editors: ["too short", focus],
      },
    });
    const exit = await h.run(
      async (screen) => {
        screen.handleInput("e");
      },
      async (screen) => {
        assert.match(h.view(screen), /label my-new-label/);
        assert.match(h.view(screen), /focus: “Latest instruction/);
        screen.handleInput(DOWN);
        const other = h.view(screen);
        assert.match(other, /rewind to start/);
        assert.match(other, /label start-folded/);
        assert.match(other, /focus: “Latest instruction/);
        screen.handleInput(UP);
        assert.match(h.view(screen), /label my-new-label/);
        screen.handleInput(ENTER);
        h.release(done({ label: "my-new-label" }));
        await tick();
        screen.handleInput(ENTER);
      },
    );
    assert.equal(exit, "done");
    assert.deepEqual(h.calls.start[0].plan, {
      anchor: "impl-start",
      label: "my-new-label",
      focus,
    });
    assert.deepEqual(
      h.dialogs.editor.map(([, prefill]) => prefill),
      ["", "too short"],
      "a too short focus reopens the editor with what was typed",
    );
    assert.equal(h.notifications.length, 1);
    assert.match(
      h.notifications[0].message,
      /9 characters; it needs at least 20/,
    );
  });

  it("refuses a label that is taken or not kebab-case, and an empty focus lets the agent write it", async () => {
    const h = harness({
      answers: { inputs: ["start", "x".repeat(60), ""], editors: [""] },
    });
    h.deps.candidates = () => sampleCandidates();
    await h.run(
      async (screen) => screen.handleInput("e"),
      async (screen) => {
        assert.match(h.view(screen), /label impl-start-folded/);
        assert.match(h.view(screen), /focus: agent writes it/);
        screen.handleInput(ESC);
      },
    );
    assert.deepEqual(
      h.notifications.map(({ message }) => message.slice(0, 40)),
      [
        "An anchor named 'start' already exists o",
        "'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ],
    );
  });

  it("keeps every line within 60 and 130 columns, with long names, in every state", async () => {
    for (const columns of [60, 130]) {
      const long = "a-rather-long-milestone-name-for-a-phone";
      const h = harness({
        columns,
        candidates: [
          candidate(long, {
            afterPreview:
              "A long instruction that cannot possibly fit in one line",
            suggestedLabel: `${long}-and-a-longer-label`.slice(0, 40),
            strategy: "chunked",
            contextWindow: 1_048_576,
          }),
          candidate("before-the-compaction", {
            valid: false,
            reason: `${"The anchor precedes the latest compaction, so folding would restore compacted history. ".repeat(3)}`,
          }),
        ],
        recommended: 0,
      });
      h.deps.summaryModel = () =>
        "openrouter/some-vendor/a-very-long-model-name:high";
      await h.run(async (screen) => {
        h.view(screen);
        screen.handleInput(UP);
        h.view(screen);
        screen.handleInput(DOWN);
        screen.handleInput(ENTER);
        h.view(screen);
        h.calls.start[0].onProgress({
          phase: "reduce",
          call: 12,
          plannedCalls: 12,
        });
        h.view(screen);
        h.release({
          status: "failed",
          stage: "commit",
          reason: "commit-refused",
          detail: "x".repeat(300),
        });
        await tick();
        h.view(screen);
        screen.handleInput(ESC);
      });
      assert.equal(new Set(h.heights).size, 1, `frozen height at ${columns}`);
    }
  });
});

describe("foldPlanResult", () => {
  it("summarizes every outcome status for the screen", () => {
    const usage: never[] = [];
    const figures = { label: "l", beforeTokens: 9, afterTokens: 3 };
    assert.deepEqual(
      foldPlanResult(
        {
          status: "done",
          text: "s",
          strategy: "chunked",
          calls: 4,
          chunks: 3,
          usage,
          commit: { ok: true },
        },
        figures,
      ),
      { status: "done", ...figures, strategy: "chunked", calls: 4 },
    );
    assert.deepEqual(
      foldPlanResult(
        {
          status: "failed",
          stage: "gate",
          reason: "prepare",
          detail: "d",
          usage,
        },
        figures,
      ),
      { status: "failed", stage: "gate", reason: "prepare", detail: "d" },
    );
    assert.deepEqual(foldPlanResult({ status: "cancelled", usage }, figures), {
      status: "cancelled",
    });
    assert.deepEqual(foldPlanResult({ status: "busy" }, figures), {
      status: "busy",
    });
  });
});
