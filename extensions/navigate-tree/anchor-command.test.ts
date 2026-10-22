import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type AnchorCommandDeps,
  type AnchorRow,
  registerAnchorCommand,
} from "./anchor-command.ts";
import { applyOps, createLedger, type Ledger } from "./continuity-ledger.ts";
import { CLONE_USAGE } from "./retrospective-command.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

const ANCHORS: AnchorRow[] = [
  {
    name: "start",
    percent: 4.1,
    tokens: 15_200,
    savableTokens: 99_300,
    afterPreview: "Analyze our pi-tree-navigator",
    auto: true,
  },
  {
    name: "context-gathered",
    percent: 22.7,
    tokens: 84_400,
    savableTokens: 30_100,
  },
];

async function sessionFile() {
  const directory = await mkdtemp(join(tmpdir(), "anchor-command-"));
  directories.push(directory);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const path = join(directory, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "original", cwd: directory, timestamp },
    {
      type: "session_info",
      id: "name",
      parentId: null,
      timestamp,
      name: "Original",
    },
    {
      type: "message",
      id: "one",
      parentId: "name",
      timestamp,
      message: { role: "user", content: "Question", timestamp: 1 },
    },
  ];
  await writeFile(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return { directory, path };
}

type Registered = Parameters<ExtensionAPI["registerCommand"]>[1];
interface Screen {
  handleInput(data: string): void;
}
type Script = (screen: Screen, lines: string[]) => void;

interface Options {
  hasUI?: boolean;
  width?: number;
  screens?: Script[];
  inputs?: (string | undefined)[];
  cwd?: string;
  sessionFile?: string;
  anchors?: AnchorRow[];
  openTree?: boolean;
  ledger?: Ledger;
  setAnchorResult?: { ok: true } | { ok: false; reason: string };
}

function setup(options: Options = {}) {
  const commands: { name: string; options: Registered }[] = [];
  const calls = {
    folds: [] as string[],
    anchors: [] as string[],
    trees: 0,
    listed: 0,
  };
  const deps: AnchorCommandDeps = {
    listAnchors() {
      calls.listed++;
      return options.anchors ?? ANCHORS;
    },
    setAnchor(_ctx, name) {
      calls.anchors.push(name);
      return options.setAnchorResult ?? { ok: true };
    },
    requestFold(_ctx, anchorName) {
      calls.folds.push(anchorName);
    },
    contextBadge: () => "ctx 38.4% of 372k",
    ...(options.openTree ? { openTree: () => void calls.trees++ } : {}),
    ...(options.ledger
      ? {
          readLedger: () => options.ledger,
          applyUserOps: () => ({ applied: [], rejected: [] }),
        }
      : {}),
  };
  const pi = {
    registerCommand(name: string, commandOptions: Registered) {
      commands.push({ name, options: commandOptions });
    },
  } as unknown as ExtensionAPI;
  registerAnchorCommand(pi, deps);

  const width = options.width ?? 80;
  const screens = [...(options.screens ?? [])];
  const rendered: string[][] = [];
  const notifications: { message: string; type?: string }[] = [];
  const editors: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  const ctx = {
    cwd: options.cwd ?? tmpdir(),
    hasUI: options.hasUI ?? true,
    isIdle: () => true,
    sessionManager: { getSessionFile: () => options.sessionFile },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      async editor(title: string) {
        editors.push(title);
        return undefined;
      },
      async confirm() {
        return false;
      },
      async input() {
        return (options.inputs ?? []).shift();
      },
      custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keyboard: unknown,
          done: (result: unknown) => void,
        ) => Screen & { render(width: number): string[] },
      ) {
        const script = screens.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve) => {
          const tui = {
            terminal: { rows: 40, columns: width },
            requestRender() {},
          };
          const screen = factory(tui, theme, undefined, resolve);
          const lines = screen.render(width);
          rendered.push(lines);
          script(screen, lines);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const command = commands[0]?.options;
  return {
    commands,
    command,
    ctx,
    calls,
    rendered,
    notifications,
    editors,
    run: (args: string) => command.handler(args, ctx),
    remainingScreens: () => screens.length,
  };
}

const press =
  (...keys: string[]): Script =>
  (screen) => {
    for (const key of keys) screen.handleInput(key);
  };

describe("/anchor registration and completion", () => {
  it("registers only the anchor command, with the argument shape first", () => {
    const { commands } = setup();
    assert.deepEqual(
      commands.map((command) => command.name),
      ["anchor"],
    );
    assert.match(
      commands[0].options.description ?? "",
      /^\[tree\|list\|current\|fold\|clone\|settings\] — /,
    );
  });

  it("completes subcommands fuzzily and keeps earlier tokens when chaining", async () => {
    const { command } = setup();
    const complete = async (text: string) =>
      (await command.getArgumentCompletions?.(text))?.map(
        (item) => item.value,
      ) ?? null;

    assert.deepEqual(await complete(""), [
      "tree ",
      "list ",
      "current ",
      "fold ",
      "clone ",
      "settings ",
    ]);
    assert.equal((await complete("cl"))?.[0], "clone ");
    assert.deepEqual(await complete("stg"), ["settings "]);
    assert.equal((await complete("ls"))?.[0], "list ");
    assert.equal(await complete("zzzz"), null);

    assert.deepEqual(await complete("clone "), [
      "clone inspect ",
      "clone propose ",
      "clone preview ",
      "clone create ",
    ]);
    assert.equal((await complete("clone pre"))?.[0], "clone preview ");
    assert.deepEqual(await complete("restructure pro"), [
      "restructure propose ",
    ]);
    assert.equal(await complete("clone inspect "), null);
    assert.equal(await complete("list "), null);

    assert.deepEqual(await complete("clone propose x.jsonl --f"), [
      "clone propose x.jsonl --full-tool ",
    ]);
    assert.deepEqual(await complete("clone propose --"), [
      "clone propose --llm ",
      "clone propose --model ",
      "clone propose --output ",
      "clone propose --omit-tool ",
      "clone propose --calls-only-tool ",
      "clone propose --full-tool ",
    ]);
  });
});

describe("/anchor dispatch", () => {
  it("resolves aliases, singular and plural forms", async () => {
    const expectations: [string, RegExp][] = [
      ["list", /Active anchors/],
      ["ls", /Active anchors/],
      ["anchors", /Active anchors/],
      ["LISTS", /Active anchors/],
      ["tree", /\/anchor tree is not available yet/],
      ["outline", /\/anchor tree is not available yet/],
      ["phases", /\/anchor tree is not available yet/],
      ["current", /\/anchor current is not available yet/],
      ["briefing", /\/anchor current is not available yet/],
      ["ledger", /\/anchor current is not available yet/],
      ["state", /\/anchor current is not available yet/],
      ["fold", /guided-fold slice/],
      ["rewind", /guided-fold slice/],
      ["settings", /\/anchor settings is not available yet/],
      ["setting", /\/anchor settings is not available yet/],
      ["config", /\/anchor settings is not available yet/],
      ["set", /\/anchor settings is not available yet/],
      ["clone", /^Usage: \/anchor clone \[/],
      ["restructure", /^Usage: \/anchor clone \[/],
      ["clones", /^Usage: \/anchor clone \[/],
    ];
    for (const [token, expected] of expectations) {
      const test = setup({ hasUI: false });
      await test.run(token);
      assert.match(test.notifications.at(-1)?.message ?? "", expected, token);
      assert.notEqual(test.notifications.at(-1)?.type, "warning", token);
    }
  });

  it("suggests the closest subcommand within edit distance 2 and prints usage", async () => {
    for (const [typo, suggestion] of [
      ["lst", "list"],
      ["setings", "settings"],
      ["clon", "clone"],
      ["foldd", "fold"],
      ["curent", "current"],
    ]) {
      const test = setup({ hasUI: false });
      await test.run(typo);
      const last = test.notifications.at(-1);
      assert.equal(last?.type, "warning");
      assert.ok(
        last?.message.includes(`Did you mean '/anchor ${suggestion}'?`),
        `${typo}: ${last?.message}`,
      );
      assert.ok(last?.message.includes("Usage: /anchor"));
    }

    const far = setup({ hasUI: false });
    await far.run("zzzzzzzz");
    assert.ok(!far.notifications[0].message.includes("Did you mean"));
    assert.ok(far.notifications[0].message.includes("Usage: /anchor"));
  });

  it("prints usage without UI, naming clone and --full-tool", async () => {
    const test = setup({ hasUI: false });
    await test.run("");
    await test.run("   ");
    assert.equal(test.notifications.length, 2);
    for (const { message } of test.notifications) {
      assert.ok(message.startsWith("Usage: /anchor [tree|list"));
      assert.ok(message.includes(CLONE_USAGE));
      assert.ok(message.includes("--full-tool"));
    }
    assert.equal(test.rendered.length, 0);
  });

  it("runs /anchor clone inspect <path> with the former clone-command semantics", async () => {
    const files = await sessionFile();
    const headless = setup({ hasUI: false, cwd: files.directory });
    await headless.run('clone inspect "session.jsonl"');
    assert.match(headless.notifications[0].message, /Inspected "Original"/);
    assert.match(
      headless.notifications[0].message,
      /Rerun \/anchor clone inspect <session\.jsonl>/,
    );
    assert.equal(headless.editors.length, 0);

    const ui = setup({ cwd: files.directory });
    await ui.run("restructure inspect session.jsonl");
    assert.deepEqual(ui.editors, [
      "Retrospective session inspection (read-only)",
    ]);
    assert.match(ui.notifications[0].message, /1 user turns/);
    assert.equal(ui.rendered.length, 0);
  });
});

const ledgerWithRules = (): Ledger =>
  applyOps(
    createLedger(),
    [
      { op: "add", kind: "rule", text: "Always answer in German" },
      { op: "add", kind: "rule", text: "Never edit the lockfile" },
    ],
    { origin: "user" },
  ).ledger;

describe("/anchor screens", () => {
  for (const width of [60, 130]) {
    it(`opens the hub at ${width} columns, shows every stub and closes on escape`, async () => {
      const test = setup({ width, screens: [press(ESC)] });
      await test.run("");
      const lines = test.rendered[0];
      for (const line of lines)
        assert.ok(
          visibleWidth(line) <= width,
          `${visibleWidth(line)}: ${line}`,
        );
      const text = lines.join("\n");
      for (const label of [
        "Session tree & phases",
        "Active anchors",
        "Current briefing & cont",
        "Fold current work now…",
        "Retrospective clone & r",
        "Settings",
      ]) {
        assert.ok(text.includes(label), label);
      }
      assert.ok(lines[0].includes("ctx 38.4% of 372k"));
      assert.ok(lines[0].startsWith("─ Anchor "));
      assert.ok(text.includes("not available yet"));
      assert.equal(test.remainingScreens(), 0);
    });
  }

  it("opens each stub from the hub, names its slice and returns to the hub", async () => {
    const test = setup({
      screens: [
        press(DOWN, DOWN, ENTER),
        press(DOWN, ENTER),
        press(DOWN, DOWN, ENTER),
        press(ESC),
      ],
    });
    await test.run("");
    assert.deepEqual(
      test.notifications.map(
        ({ message }) => message.match(/[a-z-]+ slice/)?.[0],
      ),
      ["continuity-ledger slice", "guided-fold slice", "settings slice"],
    );
    assert.equal(test.rendered.length, 4);
  });

  it("delegates the tree row to openTree when provided and ends the command", async () => {
    const test = setup({ openTree: true, screens: [press(ENTER)] });
    await test.run("");
    assert.equal(test.calls.trees, 1);
    assert.equal(test.notifications.length, 0);
    const treeRow = test.rendered[0].find((line) =>
      line.includes("Session tree & phases"),
    );
    assert.ok(!treeRow?.includes("not available yet"));
  });

  it("lists anchors with savings and asks the agent to fold with r", async () => {
    const test = setup({ screens: [press(DOWN, "r")] });
    await test.run("list");
    const text = test.rendered[0].join("\n");
    assert.ok(text.includes("◆ start (auto)"));
    assert.ok(text.includes("4.1% · 15.2k · −99.3k savable"));
    assert.ok(text.includes("22.7% · 84.4k · −30.1k savable"));
    assert.ok(text.includes("+ Set new anchor at current leaf…"));
    assert.ok(text.includes("↳ after: “Analyze our pi-tree-navigator”"));
    assert.ok(test.rendered[0][0].includes("2 anchors · ctx 38.4% of 372k"));
    assert.deepEqual(test.calls.folds, ["context-gathered"]);
    assert.equal(test.remainingScreens(), 0);
  });

  it("ignores r on the new-anchor row", async () => {
    const test = setup({ screens: [press(DOWN, DOWN, "r", ESC)] });
    await test.run("list");
    assert.deepEqual(test.calls.folds, []);
    assert.equal(test.notifications.length, 0);
    assert.equal(test.rendered.length, 1);
  });

  it("shows the full anchor line on enter and stays in the list", async () => {
    const test = setup({ screens: [press(ENTER), press(ESC)] });
    await test.run("list");
    assert.equal(
      test.notifications[0].message,
      "Anchor 'start' after “Analyze our pi-tree-navigator”: 4.1% of the window (15.2k tok); folding to it would free about 99.3k tok.",
    );
    assert.deepEqual(test.calls.folds, []);
  });

  it("validates new anchor names and refuses duplicates before touching the session", async () => {
    const test = setup({
      inputs: ["Bad Name", "start", "", "fresh-name"],
      screens: [
        press(DOWN, DOWN, ENTER),
        press(ENTER),
        press(ENTER),
        press(ENTER),
        press(ESC),
      ],
    });
    await test.run("list");
    assert.deepEqual(
      test.notifications.map(({ type }) => type),
      ["warning", "warning", "info"],
    );
    assert.match(
      test.notifications[0].message,
      /^Invalid anchor name "Bad Name"/,
    );
    assert.match(
      test.notifications[1].message,
      /^An anchor named 'start' already exists/,
    );
    assert.match(
      test.notifications[2].message,
      /^Anchor 'fresh-name' set at the current leaf/,
    );
    assert.deepEqual(test.calls.anchors, ["fresh-name"]);
  });

  it("reports a refused setAnchor", async () => {
    const test = setup({
      inputs: ["new-one"],
      setAnchorResult: { ok: false, reason: "No session entries yet." },
      screens: [press(DOWN, DOWN, ENTER), press(ESC)],
    });
    await test.run("list");
    assert.deepEqual(test.notifications, [
      { message: "No session entries yet.", type: "warning" },
    ]);
  });

  it("shows the live ledger line in the hub and opens the current screen from it", async () => {
    const test = setup({
      ledger: ledgerWithRules(),
      screens: [press(DOWN, DOWN, ENTER), press(ESC), press(ESC)],
    });
    await test.run("");
    const row = test.rendered[0].find((line) =>
      line.includes("Current briefing & cont"),
    );
    assert.ok(row?.includes("2 rules · rev 1"), row);
    assert.ok(!row?.includes("not available yet"));
    assert.ok(test.rendered[1][0].startsWith("─ Anchor/Current "));
    assert.ok(test.rendered[1][0].includes("rev 1 · 2 rules"));
    assert.ok(
      test.rendered[1].join("\n").includes("R1 Always answer in German"),
    );
    assert.equal(test.rendered.length, 3);
    assert.equal(test.notifications.length, 0);
  });

  it("opens /anchor current and its aliases straight into the screen", async () => {
    for (const token of ["current", "briefing", "ledger", "state"]) {
      const test = setup({ ledger: ledgerWithRules(), screens: [press(ESC)] });
      await test.run(token);
      assert.equal(test.rendered.length, 1, token);
      assert.ok(test.rendered[0][0].includes("Current"), token);
    }
  });

  it("prints the briefing for /anchor current without a UI, or says the ledger is empty", async () => {
    const filled = setup({ hasUI: false, ledger: ledgerWithRules() });
    await filled.run("current");
    assert.equal(filled.notifications[0].type, "info");
    assert.match(
      filled.notifications[0].message,
      /^\[navigate_tree continuity ledger rev 1\]\n\nBinding rules:\nR1 Always answer in German/,
    );

    const empty = setup({ hasUI: false, ledger: createLedger() });
    await empty.run("ledger");
    assert.deepEqual(empty.notifications, [
      { message: "No continuity items yet.", type: "info" },
    ]);
  });

  it("offers inspect, propose, preview and create without arguments and runs the chosen flow", async () => {
    const files = await sessionFile();
    const test = setup({
      cwd: files.directory,
      sessionFile: files.path,
      screens: [press(ENTER), press(ESC)],
    });
    await test.run("clone");
    const text = test.rendered[0].join("\n");
    for (const label of [
      "Inspect a session",
      "Propose a tree plan",
      "Preview a plan",
      "Create a clone from a plan",
    ]) {
      assert.ok(text.includes(label), label);
    }
    assert.deepEqual(test.editors, [
      "Retrospective session inspection (read-only)",
    ]);
    assert.equal(test.rendered.length, 2);
  });

  it("prompts for a plan path from the clone menu like the old command", async () => {
    const test = setup({
      inputs: [undefined],
      screens: [press(DOWN, DOWN, ENTER), press(ESC)],
    });
    await test.run("clone");
    assert.match(
      test.notifications.at(-1)?.message ?? "",
      /No plan path provided\. Usage: \/anchor clone/,
    );
  });
});
