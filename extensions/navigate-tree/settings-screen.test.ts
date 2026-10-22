/**
 * Tests for `/anchor settings`: staged editing, saving and refusals.
 *
 * Node test runner. Every flow runs against real files in a temp dir, and a
 * write is judged by the bytes on disk.
 */

import * as assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CONFIG_DIR_NAME,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createSettingsScreenDeps,
  openSettingsScreen,
  type SettingsScreenDeps,
} from "./settings-screen.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const FILENAME = "tree-navigator.json";

// Row positions in the screen, top to bottom.
const ROW = {
  hint: 0,
  startAnchor: 1,
  parentMode: 2,
  capture: 3,
  classifier: 4,
  proposalModel: 5,
  autoEnabled: 6,
  autoMode: 7,
  controller: 8,
  checkEvery: 9,
  minTokens: 10,
  rewindAt: 11,
  overrides: 12,
} as const;

type Script = (
  screen: { handleInput(data: string): void; render(width: number): string[] },
  lines: string[],
) => void;
const press =
  (...keys: string[]): Script =>
  (screen) => {
    for (const key of keys) screen.handleInput(key);
  };
const down = (n: number): string[] => Array<string>(n).fill(DOWN);
/** Jump to a row from the top, then press the keys there. */
const at = (row: number, ...keys: string[]): Script =>
  press(HOME, ...down(row), ...keys);
const edit = (row: number): Script => at(row, ENTER);

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Setup {
  global?: string;
  project?: string;
  trusted?: boolean;
  columns?: number;
  idle?: boolean;
  inputs?: (string | undefined)[];
  confirms?: boolean[];
  writeFails?: boolean;
  /** Use the screen's own atomic writer instead of the recording one. */
  realWriter?: boolean;
}

function harness(setup: Setup = {}) {
  const root = mkdtempSync(join(tmpdir(), "settings-screen-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const globalPath = join(agentDir, FILENAME);
  const projectPath = join(cwd, ".pi", FILENAME);
  for (const [path, text] of [
    [globalPath, setup.global],
    [projectPath, setup.project],
  ] as const) {
    if (text === undefined) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  const state = { idle: setup.idle ?? true, reloads: 0 };
  const writes: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const dialogs = {
    confirm: [] as [string, string][],
    input: [] as [string, string | undefined][],
  };
  const inputs = [...(setup.inputs ?? [])];
  const confirms = [...(setup.confirms ?? [])];
  const rendered: string[][] = [];
  const scripts: Script[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  const columns = setup.columns ?? 80;
  const ctx = {
    hasUI: true,
    cwd,
    isIdle: () => state.idle,
    async reload() {
      state.reloads++;
    },
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
      custom(
        factory: (...args: unknown[]) => {
          handleInput(data: string): void;
          render(width: number): string[];
        },
      ) {
        const script = scripts.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve) => {
          const tui = { terminal: { rows: 80, columns }, requestRender() {} };
          const screen = factory(tui, theme, undefined, resolve);
          const lines = screen.render(columns);
          rendered.push(lines);
          script(screen, lines);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const deps: SettingsScreenDeps = {
    locations: () => ({
      agentDir,
      projectPath,
      projectTrusted: setup.trusted ?? false,
    }),
    ...(!setup.realWriter && {
      async writeFile(path: string, text: string) {
        writes.push(path);
        if (setup.writeFails) throw new Error("disk is full");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
    }),
  };
  const read = (path: string) => readFileSync(path, "utf8");
  return {
    ctx,
    deps,
    state,
    writes,
    notifications,
    dialogs,
    rendered,
    globalPath,
    projectPath,
    readGlobal: () => read(globalPath),
    readProject: () => read(projectPath),
    run: (...screens: Script[]) => {
      scripts.push(...screens);
      return openSettingsScreen(ctx, deps);
    },
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const text = (lines: readonly string[]): string => lines.join("\n");
/** The one rendered line that holds this label. */
const line = (lines: readonly string[], label: string): string =>
  lines.find((candidate) => candidate.includes(label)) ?? "";

describe("settings screen: saving", () => {
  it("writes exactly the two staged keys, keeping unknown keys and snake_case spelling", async () => {
    const original = {
      rewind_hint_reserve_tokens: 50000,
      custom_note: { keep: [1, 2] },
      model_overrides: { "openai/x": { rewind_hint_reserve_tokens: 70000 } },
    };
    const h = harness({
      global: json(original),
      inputs: ["80k", "5"],
      confirms: [true, false],
    });
    const exit = await h.run(
      edit(ROW.hint),
      edit(ROW.startAnchor),
      press("s"),
      press(ESC),
    );
    assert.equal(exit, "back");
    assert.equal(
      h.readGlobal(),
      json({
        rewind_hint_reserve_tokens: 80000,
        custom_note: { keep: [1, 2] },
        model_overrides: original.model_overrides,
        anchor_start_after_turns: 5,
      }),
    );

    const staged = text(h.rendered[2]);
    assert.match(staged, /rewindHintReserveTokens\s+50k → 80k/);
    assert.match(staged, /anchorStartAfterTurns\s+2 → 5/);
    assert.match(staged, /2 staged · target: global/);

    const [title, message] = h.dialogs.confirm[0];
    assert.equal(title, "Save 2 changes to the global config?");
    assert.ok(message.includes(h.globalPath));
    assert.match(message, /rewindHintReserveTokens: 50k → 80k/);
    assert.match(message, /anchorStartAfterTurns: unset → 5/);

    const saved = text(h.rendered[3]);
    assert.match(saved, /rewindHintReserveTokens\s+80k · global/);
    assert.match(saved, /anchorStartAfterTurns\s+5 · global/);
    assert.ok(!saved.includes("staged"));
    assert.ok(
      h.notifications.some(
        ({ message: m, type }) =>
          type === "info" &&
          /next session start/.test(m) &&
          m.includes(h.globalPath),
      ),
    );
    assert.equal(h.dialogs.confirm[1][0], "Reload now to apply?");
    assert.equal(h.state.reloads, 0);
  });

  it("creates a missing project file and directory, and leaves the global file alone", async () => {
    const h = harness({
      trusted: true,
      inputs: ["100k"],
      confirms: [true, false],
    });
    await h.run(press("t"), edit(ROW.hint), press("s"), press(ESC));
    assert.equal(h.readProject(), json({ rewindHintReserveTokens: 100000 }));
    assert.ok(!existsSync(h.globalPath));
    assert.ok(h.dialogs.confirm[0][1].includes(h.projectPath));
    assert.match(text(h.rendered[1]), /target: project/);
    assert.match(
      text(h.rendered[3]),
      /rewindHintReserveTokens\s+100k · project/,
    );
  });

  it("accepts forgiving numbers and writes the off sentinel as null", async () => {
    const h = harness({
      global: json({ rewindHintReserveTokens: 50000, other: true }),
      inputs: ["OFF", "1 500"],
      confirms: [true, false],
    });
    await h.run(edit(ROW.hint), edit(ROW.minTokens), press("s"), press(ESC));
    assert.equal(
      h.readGlobal(),
      json({
        rewindHintReserveTokens: null,
        other: true,
        auto_navigate: { min_tokens_since_anchor: 1500 },
      }),
    );
  });

  it("converts the auto_navigate boolean shorthand when a sibling key is edited", async () => {
    const h = harness({
      global: json({ auto_navigate: true }),
      confirms: [true, false],
    });
    await h.run(edit(ROW.autoMode), press("s"), press(ESC));
    assert.deepEqual(JSON.parse(h.readGlobal()), {
      auto_navigate: { enabled: true, mode: "anchor-only" },
    });
  });

  it("toggles a flag and cycles a choice without opening an input", async () => {
    const h = harness({ global: json({}), confirms: [true, false] });
    await h.run(
      edit(ROW.parentMode),
      edit(ROW.capture),
      press("s"),
      press(ESC),
    );
    assert.deepEqual(h.dialogs.input, []);
    assert.deepEqual(JSON.parse(h.readGlobal()), {
      parentHandoffMode: "synthesized",
      continuity: { capture: false },
    });
  });

  it("resets by removing every spelling of the key and prunes a container it empties", async () => {
    const h = harness({
      global: json({
        anchorStartAfterTurns: 4,
        anchor_start_after_turns: 6,
        continuity: { capture: false },
        keep: 1,
      }),
      confirms: [true, false],
    });
    await h.run(
      at(ROW.startAnchor, "d"),
      at(ROW.capture, "d"),
      press("s"),
      press(ESC),
    );
    assert.equal(h.readGlobal(), json({ keep: 1 }));
    assert.match(h.dialogs.confirm[0][1], /anchorStartAfterTurns: 6 → removed/);
    assert.match(text(h.rendered[2]), /continuity\.capture\s+false → true/);
  });

  it("warns when a higher layer still overrides what was saved", async () => {
    const h = harness({
      global: json({}),
      project: json({ rewindHintReserveTokens: 90000 }),
      trusted: true,
      inputs: ["80k"],
      confirms: [true, false],
    });
    await h.run(edit(ROW.hint), press("s"), press(ESC));
    assert.match(
      text(h.rendered[1]),
      /rewindHintReserveTokens\s+90k · project/,
    );
    assert.ok(
      h.notifications.some(
        ({ message, type }) =>
          type === "warning" &&
          message ===
            "Still overridden by the project file: rewindHintReserveTokens.",
      ),
    );
  });

  it("offers a reload after saving and ends the command when accepted", async () => {
    const h = harness({
      global: json({}),
      inputs: ["3"],
      confirms: [true, true],
    });
    const exit = await h.run(edit(ROW.startAnchor), press("s"));
    assert.equal(exit, "done");
    assert.equal(h.state.reloads, 1);
  });

  it("does not offer a reload while the agent is working", async () => {
    const h = harness({
      global: json({}),
      inputs: ["3"],
      confirms: [true],
      idle: false,
    });
    await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
    assert.equal(h.dialogs.confirm.length, 1);
    assert.ok(
      h.notifications.some(({ message }) => message.includes("/reload")),
    );
  });

  it("keeps the staged edits and the file when the write fails", async () => {
    const original = json({ keep: 1 });
    const h = harness({
      global: original,
      inputs: ["3"],
      confirms: [true, true],
      writeFails: true,
    });
    await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
    assert.equal(h.readGlobal(), original);
    assert.ok(
      h.notifications.some(
        ({ message, type }) =>
          type === "error" &&
          message.includes(h.globalPath) &&
          message.includes("disk is full"),
      ),
    );
    assert.match(text(h.rendered[2]), /1 staged/);
    assert.equal(h.dialogs.confirm.at(-1)?.[0], "Discard staged changes?");
  });

  it("writes atomically through a symlink and leaves no temp file behind", async () => {
    const h = harness({
      inputs: ["4"],
      confirms: [true, false],
      realWriter: true,
    });
    const target = join(dirname(h.globalPath), "dotfiles", FILENAME);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json({ keep: 1 }));
    symlinkSync(target, h.globalPath);
    await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
    assert.ok(lstatSync(h.globalPath).isSymbolicLink());
    assert.equal(
      readFileSync(target, "utf8"),
      json({ keep: 1, anchorStartAfterTurns: 4 }),
    );
    assert.deepEqual(
      readdirSync(dirname(target)).filter((file) => file.endsWith(".tmp")),
      [],
    );
  });
});

describe("settings screen: refusals", () => {
  it("refuses a value outside the range and names the valid range", async () => {
    const h = harness({ inputs: ["5m", "0", "abc", "foo", "101"] });
    await h.run(
      edit(ROW.hint),
      edit(ROW.startAnchor),
      edit(ROW.classifier),
      edit(ROW.controller),
      edit(ROW.checkEvery),
      press(ESC),
    );
    const warnings = h.notifications
      .filter(({ type }) => type === "warning")
      .map(({ message }) => message);
    assert.equal(warnings.length, 5);
    assert.match(
      warnings[0],
      /"5m" is not valid for rewindHintReserveTokens\. Use 1,000-1,000,000 tokens/,
    );
    assert.match(warnings[1], /"0".*anchorStartAfterTurns\. Use 1-50 turns/);
    assert.match(
      warnings[2],
      /continuity\.intentClassifier\. Use provider\/id of a model, or off/,
    );
    assert.match(
      warnings[3],
      /controller_model\. Use current or provider\/id\[:thinking\]/,
    );
    assert.match(warnings[4], /check_every_turns\. Use 1-100 turns/);
    assert.ok(!text(h.rendered.at(-1) ?? []).includes("staged"));
    assert.ok(!existsSync(h.globalPath));
  });

  it("shows the current value and the valid range in the input prompt", async () => {
    const h = harness({
      global: json({ rewindHintReserveTokens: 50000 }),
      inputs: [undefined],
    });
    await h.run(edit(ROW.hint), press(ESC));
    assert.deepEqual(h.dialogs.input, [
      [
        "rewindHintReserveTokens (global file)",
        "now 50k · 1,000-1,000,000 tokens (e.g. 50k), or off",
      ],
    ]);
  });

  it("writes nothing when the user cancels with staged edits", async () => {
    const original = json({ rewindHintReserveTokens: 50000 });
    const h = harness({
      global: original,
      inputs: ["80k"],
      confirms: [false, true],
    });
    const exit = await h.run(edit(ROW.hint), press(ESC), press(ESC));
    assert.equal(exit, "back");
    assert.equal(h.readGlobal(), original);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.dialogs.confirm, [
      ["Discard staged changes?", "1 staged change has not been saved."],
      ["Discard staged changes?", "1 staged change has not been saved."],
    ]);
    assert.match(text(h.rendered[2]), /50k → 80k/);
  });

  it("writes nothing when the save confirmation is declined", async () => {
    const original = json({ rewindHintReserveTokens: 50000 });
    const h = harness({
      global: original,
      inputs: ["80k"],
      confirms: [false, true],
    });
    await h.run(edit(ROW.hint), press("s"), press(ESC));
    assert.equal(h.readGlobal(), original);
    assert.deepEqual(h.writes, []);
    assert.match(text(h.rendered[2]), /1 staged/);
  });

  it("closes without a question when nothing is staged", async () => {
    const h = harness({ global: json({}) });
    assert.equal(await h.run(press(ESC)), "back");
    assert.deepEqual(h.dialogs.confirm, []);
  });

  it("never overwrites a file that does not parse, and says which file and why", async () => {
    const broken = '{ "rewindHintReserveTokens": 5000, ';
    const h = harness({
      global: broken,
      project: json({ anchorStartAfterTurns: 3 }),
      trusted: true,
      inputs: ["70k"],
      confirms: [true],
    });
    await h.run(
      edit(ROW.hint),
      press("t"),
      edit(ROW.hint),
      press("t"),
      press("s"),
      press(ESC),
    );
    assert.equal(readFileSync(h.globalPath, "utf8"), broken);
    assert.deepEqual(h.writes, []);
    const warnings = h.notifications
      .filter(({ type }) => type === "warning")
      .map(({ message }) => message);
    assert.equal(warnings.length, 3);
    for (const message of warnings) {
      assert.ok(message.includes(h.globalPath));
      assert.match(message, /is not valid JSON/);
    }
    assert.match(text(h.rendered[0]), /target: global · file invalid/);
    assert.deepEqual(
      h.dialogs.confirm.map(([title]) => title),
      ["Discard staged changes?"],
    );
  });

  it("refuses a config whose root is not an object", async () => {
    const h = harness({ global: "[1, 2]", inputs: ["3"] });
    await h.run(edit(ROW.startAnchor), press(ESC));
    assert.equal(readFileSync(h.globalPath, "utf8"), "[1, 2]");
    assert.match(h.notifications[0].message, /must be a JSON object/);
    assert.deepEqual(h.dialogs.input, []);
  });

  it("does not read or edit the project file when the project is not trusted", async () => {
    const project = json({ rewindHintReserveTokens: 1000 });
    const h = harness({ global: json({}), project, trusted: false });
    let afterT: string[] = [];
    await h.run((screen) => {
      screen.handleInput("t");
      afterT = screen.render(80);
      screen.handleInput(ESC);
    });
    assert.equal(readFileSync(h.projectPath, "utf8"), project);
    const first = text(h.rendered[0]);
    assert.match(first, /target: global/);
    assert.match(first, /rewindHintReserveTokens\s+off · default/);
    assert.match(first, /global unset · project untrusted/);
    assert.ok(!first.includes("to project"));
    assert.match(text(afterT), /target: global/);
  });
});

describe("settings screen: rows", () => {
  it("shows each effective value with the layer it comes from", async () => {
    const h = harness({
      global: json({
        rewindHintReserveTokens: 50000,
        continuity: { capture: false },
        model_overrides: { "a/b": {}, "c/d": {} },
      }),
      project: json({
        anchorStartAfterTurns: 99,
        parent_handoff_mode: "synthesized",
        treeProposal: { model: "openai/gpt-6:low" },
        auto_navigate: { enabled: true, check_every_turns: 4 },
        modelOverrides: { "a/b": {}, "e/f": {} },
      }),
      trusted: true,
    });
    await h.run(press(ESC));
    const screen = h.rendered[0];
    assert.match(line(screen, "rewindHintReserveTokens"), /50k · global/);
    assert.match(line(screen, "anchorStartAfterTurns"), /2 · default/);
    assert.match(line(screen, "parentHandoffMode"), /synthesized · project/);
    assert.match(line(screen, "continuity.capture"), /false · global/);
    assert.match(line(screen, "continuity.intentClassifier"), /off · default/);
    assert.match(
      line(screen, "treeProposal.model"),
      /openai\/gpt-6:low · project/,
    );
    assert.match(line(screen, "auto_navigate.enabled"), /true · project/);
    assert.match(
      line(screen, "auto_navigate.mode"),
      /anchor-and-rewind · default/,
    );
    assert.match(
      line(screen, "controller_model"),
      /openai\/gpt-6:low · default/,
    );
    assert.match(line(screen, "check_every_turns"), /4 · project/);
    assert.match(line(screen, "rewind_at_tokens"), /120k · default/);
    assert.match(line(screen, "model_overrides"), /3 entries/);
  });

  it("explains an ignored invalid value instead of hiding it", async () => {
    const h = harness({
      global: json({
        anchorStartAfterTurns: 7,
        rewindHintReserveTokens: 50000,
      }),
      project: json({
        anchorStartAfterTurns: 99,
        rewindHintReserveTokens: "lots",
      }),
      trusted: true,
    });
    await h.run(press(ESC));
    const first = h.rendered[0];
    assert.match(line(first, "anchorStartAfterTurns"), /7 · global/);
    assert.match(line(first, "rewindHintReserveTokens"), /off · project/);
    assert.match(line(first, "↳"), /project: invalid value, treated as off/);
  });

  it("stays inside 60 columns and never cuts a description", async () => {
    const h = harness({ global: json({}), columns: 60 });
    const frames: string[][] = [];
    await h.run((screen) => {
      for (let row = 0; row <= ROW.overrides; row++) {
        frames.push(screen.render(60));
        screen.handleInput(DOWN);
      }
      screen.handleInput(ESC);
    });
    assert.equal(frames.length, ROW.overrides + 1);
    for (const frame of frames) {
      for (const rendered of frame) assert.ok(visibleWidth(rendered) <= 60);
      assert.ok(!frame.at(-3)?.endsWith("…"), `cut: ${frame.at(-3)}`);
      assert.ok(frame.at(-4)?.trim(), "description is on two rows at most");
    }
    assert.match(frames[0][0], /Anchor\/Settings/);
    assert.match(frames[0][0], /target: global/);
    assert.match(frames[0][1], /file: /);
  });

  it("builds the live deps from pi's agent dir and the session's cwd and trust", () => {
    const deps = createSettingsScreenDeps();
    const where = deps.locations({
      cwd: "/work/app",
      isProjectTrusted: () => true,
    } as unknown as ExtensionCommandContext);
    assert.ok(where.agentDir.length > 0);
    assert.equal(
      where.projectPath,
      join("/work/app", CONFIG_DIR_NAME, FILENAME),
    );
    assert.equal(where.projectTrusted, true);
  });
});
