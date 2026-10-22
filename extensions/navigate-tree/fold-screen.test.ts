/**
 * Tests for `/anchor fold`: the four-step wizard and the focus parsing.
 *
 * Node test runner. The context is faked: frame screens run through a scripted
 * `custom`, dialogs answer from queues, and every call is recorded.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AnchorRow } from "./anchor-command.ts";
import {
  type FoldRequestOptions,
  type FoldScreenDeps,
  foldRow,
  openFoldScreen,
  parseFocus,
} from "./fold-screen.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const COLUMNS = 60;
const MIN_SAVINGS = 4000;
const MIN_FOCUS = 20;
const FOCUS =
  "Latest instruction: finish the parser fix\nDone since 'impl-start': parser rewritten\nRemaining: add tests";

const anchor = (
  name: string,
  savableTokens: number,
  extra: Partial<AnchorRow> = {},
): AnchorRow => ({
  name,
  percent: 10,
  tokens: 20_000 - savableTokens,
  savableTokens,
  ...extra,
});

/** Root to leaf: `start` frees the most, `recent` too little to be worth a fold. */
const sampleAnchors = (): AnchorRow[] => [
  anchor("start", 42_000, { auto: true }),
  anchor("impl-start", 12_300, { afterPreview: "Implement the parser" }),
  anchor("recent", 900),
];

interface Answers {
  confirms?: boolean[];
  inputs?: (string | undefined)[];
  editors?: (string | undefined)[];
}

type Script = (
  screen: { handleInput(data: string): void },
  lines: string[],
) => void;
const press =
  (...keys: string[]): Script =>
  (screen) => {
    for (const key of keys) screen.handleInput(key);
  };

function harness(
  answers: Answers = {},
  anchors: AnchorRow[] = sampleAnchors(),
) {
  const state = { idle: true, anchors };
  const notifications: { message: string; type?: string }[] = [];
  const dialogs = {
    input: [] as [string, string | undefined][],
    editor: [] as [string, string | undefined][],
    confirm: [] as [string, string][],
  };
  const folds: [string, FoldRequestOptions | undefined][] = [];
  const created: string[] = [];
  const confirms = [...(answers.confirms ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const editors = [...(answers.editors ?? [])];
  const rendered: string[][] = [];
  const scripts: Script[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    isIdle: () => state.idle,
    ui: {
      notify: (message: string, type?: string) =>
        void notifications.push({ message, type }),
      async confirm(title: string, message: string) {
        dialogs.confirm.push([title, message]);
        return confirms.shift() ?? false;
      },
      async input(title: string, placeholder?: string) {
        dialogs.input.push([title, placeholder]);
        return inputs.shift();
      },
      async editor(title: string, prefill?: string) {
        dialogs.editor.push([title, prefill]);
        return editors.shift();
      },
      custom(
        factory: (...args: unknown[]) => {
          handleInput(data: string): void;
          render(width: number): string[];
        },
      ) {
        const script = scripts.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve) => {
          const tui = {
            terminal: { rows: 40, columns: COLUMNS },
            requestRender() {},
          };
          const screen = factory(tui, theme, undefined, resolve);
          const lines = screen.render(COLUMNS);
          rendered.push(lines);
          script(screen, lines);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const deps: FoldScreenDeps = {
    listAnchors: () => [...state.anchors],
    setAnchor(_ctx, name) {
      created.push(name);
      state.anchors.push(anchor(name, 0));
      return { ok: true };
    },
    suggestLabel: (_ctx, picked) => `${picked.name}-folded`,
    requestFold: (_ctx, name, opts) => void folds.push([name, opts]),
    minSavingsTokens: MIN_SAVINGS,
    minFocusLength: MIN_FOCUS,
  };
  return {
    ctx,
    deps,
    state,
    notifications,
    dialogs,
    folds,
    created,
    rendered,
    run: (...screens: Script[]) => {
      scripts.push(...screens);
      return openFoldScreen(ctx, deps);
    },
  };
}

describe("fold anchor rows", () => {
  it("lists anchors newest first with the savings, and mutes one that frees too little", async () => {
    const h = harness();
    await h.run(press(ESC));
    const text = h.rendered[0].join("\n");
    assert.ok(text.indexOf("recent") < text.indexOf("impl-start"));
    assert.ok(text.indexOf("impl-start") < text.indexOf("start (auto)"));
    assert.match(text, /impl-start\s+−12\.3k tok/);
    assert.match(text, /◆ recent\s+too little to fold/);
    assert.match(h.rendered[0][0], /step 1\/4 · 2 of 3 foldable/);
    const selected = h.rendered[0].find((line) => line.includes("→"));
    assert.match(
      selected ?? "",
      /impl-start/,
      "the cursor starts on the newest foldable anchor",
    );
    const [recent, picked] = [anchor("r", 900), anchor("p", 4000)].map((row) =>
      foldRow(row, h.deps),
    );
    assert.equal(recent.tone, "muted");
    assert.equal(recent.value, "too little to fold");
    assert.equal(picked.tone, "text");
    assert.equal(picked.value, "−4.0k tok");
  });

  it("keeps every line within 60 columns", async () => {
    const h = harness({}, [
      anchor("a-rather-long-milestone-name-for-a-phone", 30_000, {
        afterPreview: "A long instruction that cannot possibly fit in one line",
      }),
    ]);
    await h.run(press(ESC));
    for (const line of h.rendered[0])
      assert.ok(visibleWidth(line) <= COLUMNS, line);
  });
});

describe("fold wizard", () => {
  it("requests exactly the picked anchor, label and focus once", async () => {
    const h = harness({ inputs: [""], editors: [FOCUS], confirms: [true] });
    const exit = await h.run(press(ENTER));
    assert.equal(exit, "done");
    assert.deepEqual(h.folds, [
      ["impl-start", { label: "impl-start-folded", focus: FOCUS }],
    ]);
    assert.match(h.dialogs.input[0][0], /^Fold 2\/4:.*'impl-start-folded'/);
    assert.equal(h.dialogs.input[0][1], "impl-start-folded");
    assert.equal(
      h.dialogs.editor[0][1],
      "Latest instruction:\nDone since 'impl-start':\nRemaining:",
    );
    const [title, message] = h.dialogs.confirm[0];
    assert.match(title, /^Fold 4\/4: fold to 'impl-start'\?/);
    assert.match(message, /Frees: about 12\.3k tok/);
    assert.match(message, /Label: impl-start-folded/);
    assert.match(message, /Focus: “Latest instruction: finish the parser fix/);
    assert.match(message, /summary is written by the model/);
  });

  it("takes a typed label in kebab-case and leaves the focus to the agent when the template is untouched", async () => {
    const template =
      "Latest instruction:\nDone since 'impl-start':\nRemaining:";
    const h = harness({
      inputs: ["  Parser Done! "],
      editors: [template],
      confirms: [true],
    });
    await h.run(press(ENTER));
    assert.deepEqual(h.folds, [["impl-start", { label: "parser-done" }]]);
    assert.match(h.dialogs.confirm[0][1], /Focus: the agent writes it/);
  });

  it("treats an empty focus like the untouched template", async () => {
    const h = harness({ inputs: [""], editors: ["  \n "], confirms: [true] });
    await h.run(press(DOWN, ENTER));
    assert.deepEqual(h.folds, [["start", { label: "start-folded" }]]);
  });

  it("cannot pick an anchor that frees too little, and says what to do", async () => {
    const h = harness({ inputs: [undefined] });
    await h.run(press(UP, ENTER), press(ESC));
    assert.deepEqual(h.folds, []);
    assert.deepEqual(h.dialogs.input, []);
    assert.deepEqual(h.notifications, [
      {
        message:
          "'recent' would free only about 900 tok; a fold needs at least 4.0k. Pick an older anchor, or fold once more work has piled up.",
        type: "warning",
      },
    ]);
  });

  it("goes back one step on Esc and requests nothing", async () => {
    const h = harness({ inputs: ["", undefined], editors: [undefined] });
    const exit = await h.run(press(ENTER), press(ESC));
    assert.equal(exit, "back");
    assert.deepEqual(h.folds, []);
    assert.deepEqual(
      h.dialogs.input.map(([title]) => title.slice(0, 7)),
      ["Fold 2/", "Fold 2/"],
    );
    assert.equal(h.dialogs.editor.length, 1);
    assert.equal(h.dialogs.confirm.length, 0);
    assert.equal(h.rendered.length, 2);
    const selected = h.rendered[1].find((line) => line.includes("→"));
    assert.match(selected ?? "", /impl-start/);
  });

  it("returns from the focus step to the label step with the label kept", async () => {
    const h = harness({
      inputs: ["my-label", undefined],
      editors: [undefined],
    });
    await h.run(press(ENTER), press(ESC));
    assert.match(h.dialogs.input[1][0], /Enter keeps 'my-label'/);
    assert.deepEqual(h.folds, []);
  });

  it("reasks the label with a notice that names the valid shape", async () => {
    const h = harness({
      inputs: ["!!!", "start", "x".repeat(41), "good-label"],
      editors: [FOCUS],
      confirms: [true],
    });
    await h.run(press(ENTER));
    const [symbols, duplicate, tooLong] = h.notifications.map(
      ({ message }) => message,
    );
    assert.match(symbols, /^'!!!' cannot be a label: use lowercase kebab-case/);
    assert.match(
      symbols,
      /at most 40 characters \(e\.g\. 'impl-start-folded'\)/,
    );
    assert.match(duplicate, /^An anchor named 'start' already exists/);
    assert.match(tooLong, /^'x{41}' cannot be a label/);
    assert.equal(h.notifications.length, 3);
    assert.equal(h.dialogs.input.length, 4);
    assert.deepEqual(h.folds, [
      ["impl-start", { label: "good-label", focus: FOCUS }],
    ]);
  });

  it("asks for more when the focus is too short and reopens what was typed", async () => {
    const short = "Latest instruction: fix it";
    const h = harness({
      inputs: [""],
      editors: [short, FOCUS],
      confirms: [true],
    });
    await h.run(press(ENTER));
    assert.equal(h.dialogs.editor[1][1], short);
    assert.match(
      h.notifications[0].message,
      /^That focus has 6 characters of your own words; it needs at least 20/,
    );
    assert.equal(h.folds.length, 1);
    assert.equal(h.folds[0][1]?.focus, FOCUS);
  });

  it("returns to the focus step when the confirmation is declined and keeps the draft", async () => {
    const h = harness({
      inputs: [""],
      editors: [FOCUS, undefined],
      confirms: [false],
    });
    await h.run(press(ENTER), press(ESC));
    assert.equal(h.dialogs.editor[1][1], FOCUS);
    assert.deepEqual(h.folds, []);
  });

  it("says the request is queued while the agent is working", async () => {
    const h = harness({ inputs: [""], editors: [FOCUS], confirms: [true] });
    h.state.idle = false;
    await h.run(press(ENTER));
    assert.match(
      h.dialogs.confirm[0][1],
      /queued as a follow-up and runs when it finishes/,
    );
    assert.equal(h.folds.length, 1);
  });

  it("goes back to the list when the anchor shrank below the minimum during the wizard", async () => {
    const h = harness({ inputs: [""], editors: [FOCUS] });
    const editor = h.ctx.ui.editor;
    h.ctx.ui.editor = (title, prefill) => {
      h.state.anchors[1].savableTokens = 100;
      return editor(title, prefill);
    };
    await h.run(press(ENTER), press(ESC));
    assert.deepEqual(h.dialogs.confirm, []);
    assert.deepEqual(h.folds, []);
    assert.match(
      h.notifications[0].message,
      /^'impl-start' would free only about 100 tok/,
    );
  });
});

describe("fold wizard without anchors", () => {
  it("shows one muted row and sets an anchor with a", async () => {
    const h = harness({ inputs: ["impl-start"] }, []);
    await h.run(press("a"), press(ESC));
    const first = h.rendered[0].join("\n");
    assert.match(
      first,
      /No anchors yet\. Press a to set one at the current leaf\./,
    );
    assert.match(first, /a set anchor/);
    assert.deepEqual(h.created, ["impl-start"]);
    assert.deepEqual(h.notifications, [
      { message: "Anchor 'impl-start' set at the current leaf.", type: "info" },
    ]);
    assert.match(h.rendered[1].join("\n"), /impl-start\s+too little to fold/);
  });

  it("explains how to continue when Enter is pressed on the empty row", async () => {
    const h = harness({}, []);
    await h.run(press(ENTER), press(ESC));
    assert.match(h.notifications[0].message, /Press a to set one/);
    assert.deepEqual(h.created, []);
  });

  it("shows the reason when the anchor cannot be set", async () => {
    const h = harness({ inputs: ["Bad Name"] }, []);
    h.deps.setAnchor = () => ({
      ok: false,
      reason: "Anchor names are lowercase kebab-case.",
    });
    await h.run(press("a"), press(ESC));
    assert.deepEqual(h.notifications, [
      { message: "Anchor names are lowercase kebab-case.", type: "warning" },
    ]);
  });
});

describe("parseFocus", () => {
  const parse = (raw: string) => parseFocus(raw, "impl", MIN_FOCUS);

  it("leaves the focus to the agent for an empty or untouched template", () => {
    assert.deepEqual(parse(""), { kind: "agent" });
    assert.deepEqual(
      parse("Latest instruction:\nDone since 'impl':\nRemaining:"),
      { kind: "agent" },
    );
  });

  it("counts only the user's own words, not the template labels", () => {
    assert.deepEqual(parse("Latest instruction: fix it"), {
      kind: "short",
      length: 6,
    });
    assert.deepEqual(parse("ship the parser fix today"), {
      kind: "focus",
      text: "ship the parser fix today",
    });
  });

  it("keeps the filled lines and drops the blank labels and control characters", () => {
    assert.deepEqual(
      parse(
        "Latest instruction: ship the parser fix\n\x1b[31mDone since 'impl':\x1b[0m parser rewritten\nRemaining:",
      ),
      {
        kind: "focus",
        text: "Latest instruction: ship the parser fix\nDone since 'impl': parser rewritten",
      },
    );
  });
});
