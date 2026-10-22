import * as assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  handleTreeProposal,
  parseProposalArguments,
  saveTreeProposal,
  validateTreeProposal,
} from "./proposal-command.ts";
import { buildHeuristicPlan } from "./proposal-source.ts";
import {
  parseRetrospectivePlan,
  readSessionSnapshot,
} from "./retrospective-plan.ts";
import { clearRuntimeConfig, writeRuntimeConfig } from "./runtime-config.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tree-proposal-command-"));
  directories.push(dir);
  const source = join(dir, "source.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const data = `${[
    { type: "session", version: 3, id: "original", cwd: dir, timestamp },
    {
      type: "message",
      id: "request",
      parentId: null,
      timestamp,
      message: { role: "user", content: "Build a parser", timestamp: 1 },
    },
    {
      type: "message",
      id: "followup",
      parentId: "request",
      timestamp,
      message: { role: "user", content: "Verify its output", timestamp: 2 },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
  await writeFile(source, data);
  return { dir, source, data, snapshot: await readSessionSnapshot(source) };
}

const ESC = "\x1b";

/** A UI whose `custom` screens are driven by scripted keys; `editors` answer the raw JSON editor. */
function reviewUi(
  f: { dir: string; source: string },
  screens: string[][],
  options: {
    columns?: number;
    editors?: ((text: string) => string | undefined)[];
  } = {},
) {
  const columns = options.columns ?? 80;
  const state = {
    modelCalls: 0,
    frames: [] as string[][],
    editors: [] as string[],
    notifications: [] as { message: string; type?: string }[],
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  const scripts = [...screens];
  const answers = [...(options.editors ?? [])];
  const ctx = {
    cwd: f.dir,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionFile: () => f.source,
      getSessionId: () => f.source,
    },
    ui: {
      notify(message: string, type?: string) {
        state.notifications.push({ message, type });
      },
      async editor(_title: string, text: string) {
        state.editors.push(text);
        return answers.shift()?.(text);
      },
      custom(
        factory: (...args: unknown[]) => {
          handleInput(data: string): void;
          render(width: number): string[];
        },
      ) {
        const keys = scripts.shift();
        assert.ok(keys, "unexpected extra screen");
        return new Promise((resolve, reject) => {
          let closed = false;
          const tui = { terminal: { rows: 40, columns }, requestRender() {} };
          const screen = factory(tui, theme, undefined, (value: unknown) => {
            closed = true;
            resolve(value);
          });
          state.frames.push(screen.render(columns));
          for (const key of keys) {
            if (closed) break;
            screen.handleInput(key);
          }
          if (!closed) reject(new Error("screen left open by its script"));
        });
      },
    },
    modelRegistry: {
      streamSimple() {
        state.modelCalls++;
        throw new Error("must not call");
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    get modelCalls() {
      return state.modelCalls;
    },
    frames: state.frames,
    editors: state.editors,
    notifications: state.notifications,
  };
}

describe("tree proposal command", () => {
  it("uses the same session runtime disclosure policy before any model request", async () => {
    const f = await fixture();
    const ui = reviewUi(f, []);
    writeRuntimeConfig(f.source, {
      treeProposal: { tools: { bash: "invalid-policy" } },
    });
    try {
      await assert.rejects(
        handleTreeProposal(`--llm ${f.source}`, ui.ctx, {} as ExtensionAPI),
        /full|calls-only|omit/,
      );
      assert.equal(ui.modelCalls, 0);
      assert.equal(ui.frames.length, 0);
    } finally {
      clearRuntimeConfig(f.source);
    }
  });
  it("parses quoted paths, model thinking and exact per-tool disclosure overrides", () => {
    assert.deepEqual(
      parseProposalArguments(
        '"a source.jsonl" --model test/model:high --omit-tool read --calls-only-tool bash --output "a plan.json"',
      ),
      {
        source: "a source.jsonl",
        output: "a plan.json",
        llm: true,
        input: {
          model: "test/model:high",
          tools: { read: "omit", bash: "calls-only" },
        },
      },
    );
    assert.equal(parseProposalArguments("--llm").llm, true);
    assert.equal(parseProposalArguments("a.jsonl").llm, false);
    assert.deepEqual(
      parseProposalArguments([
        "source with spaces.jsonl",
        "--omit-tool=read",
        "--full-tool",
        "read",
      ]).input.tools,
      { read: "full" },
    );
    for (const value of [
      '"unfinished',
      "a b",
      "--unknown value",
      "--model",
      "--omit-tool --llm",
    ])
      assert.throws(() => parseProposalArguments(value));
  });

  it("saves a private new plan, never overwrites a file, and refuses stale sources", async () => {
    const f = await fixture();
    const plan = buildHeuristicPlan(f.snapshot);
    const output = join(f.dir, "plan.json");
    assert.equal(await saveTreeProposal(f.snapshot, plan, output), output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(saveTreeProposal(f.snapshot, plan, output), /EEXIST/);
    assert.equal(await readFile(f.source, "utf8"), f.data);
    let groups = [...plan.groups];
    for (let index = 0; index < 35; index++)
      groups = [
        {
          name: `nested-${index}`,
          state: "open",
          firstEntryId: "request",
          lastEntryId: "followup",
          summary: "Open",
          children: groups,
        },
      ];
    await assert.rejects(
      saveTreeProposal(
        f.snapshot,
        { ...plan, groups },
        join(f.dir, "too-deep.json"),
      ),
      /32 nesting levels/,
    );
    await writeFile(f.source, `${f.data}\n`);
    await assert.rejects(
      saveTreeProposal(f.snapshot, plan, join(f.dir, "stale.json")),
      /Source changed/,
    );
    assert.deepEqual((await readdir(f.dir)).sort(), [
      "plan.json",
      "source.jsonl",
    ]);
  });

  it("explicitly falls back from unsafe model ranges while retaining observed usage and call count", async () => {
    const f = await fixture();
    const plan = buildHeuristicPlan(f.snapshot);
    const result = validateTreeProposal(f.snapshot, {
      plan: {
        ...plan,
        groups: [
          {
            name: "invented",
            state: "folded",
            firstEntryId: "missing",
            lastEntryId: "missing",
            summary: "Untrusted",
            children: [],
          },
        ],
      },
      method: "model",
      calls: 2,
      usage: [],
      warnings: [],
    });
    assert.equal(result.method, "heuristic");
    assert.equal(result.calls, 2);
    assert.match(result.warnings.join(" "), /graph-safety/);
    assert.deepEqual(result.plan, parseRetrospectivePlan(plan));
  });

  it("a cancelled review writes nothing and never requests a model for heuristic proposals", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [[ESC]]);
    await handleTreeProposal("", ui.ctx, {} as ExtensionAPI);
    assert.equal(ui.modelCalls, 0);
    assert.deepEqual(await readdir(f.dir), ["source.jsonl"]);
    assert.equal(await readFile(f.source, "utf8"), f.data);
    assert.match(ui.notifications.at(-1)?.message ?? "", /no plan was saved/);
  });

  it("shows the proposal as a readable outline and saves it with s", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [["s"]]);
    await handleTreeProposal("--output saved.json", ui.ctx, {} as ExtensionAPI);
    const text = ui.frames[0].join("\n");
    assert.doesNotMatch(text, /[{}]|sourceSha256/);
    assert.match(text, /Anchor\/Clone\/Propose/);
    assert.match(text, /Method\s+heuristic/);
    assert.match(text, /e edit plan/);
    assert.match(text, /s save/);
    assert.match(text, /esc cancel/);
    assert.equal(ui.editors.length, 0);
    const saved = JSON.parse(await readFile(join(f.dir, "saved.json"), "utf8"));
    assert.deepEqual(
      saved,
      JSON.parse(
        JSON.stringify(parseRetrospectivePlan(buildHeuristicPlan(f.snapshot))),
      ),
    );
    assert.match(ui.notifications.at(-1)?.message ?? "", /Saved heuristic/);
  });

  it("fits the outline in 60 columns", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [[ESC]], { columns: 60 });
    await handleTreeProposal("", ui.ctx, {} as ExtensionAPI);
    assert.ok(ui.frames[0].every((line) => visibleWidth(line) <= 60));
    assert.ok(ui.frames[0].join("\n").includes("[open]"));
  });

  it("e opens the raw JSON plan; an invalid edit is refused and the outline stays", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [["e"], ["s"]], { editors: [() => "{ not json"] });
    await handleTreeProposal("--output saved.json", ui.ctx, {} as ExtensionAPI);
    assert.equal(ui.editors.length, 1);
    assert.match(ui.editors[0], /"sourceSha256"/);
    assert.equal(ui.frames.length, 2);
    assert.match(ui.notifications[0].message, /edited plan was not applied/);
    assert.equal(ui.notifications[0].type, "warning");
    const saved = JSON.parse(await readFile(join(f.dir, "saved.json"), "utf8"));
    assert.equal(
      saved.nameSuffix,
      parseRetrospectivePlan(buildHeuristicPlan(f.snapshot)).nameSuffix,
    );
  });

  it("a valid edit is validated against the source, shown again and then saved", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [["e"], ["e"], ["s"]], {
      editors: [
        (text) =>
          JSON.stringify({ ...JSON.parse(text), sourceSha256: "0".repeat(64) }),
        (text) =>
          JSON.stringify({ ...JSON.parse(text), nameSuffix: " (reviewed)" }),
      ],
    });
    await handleTreeProposal("--output saved.json", ui.ctx, {} as ExtensionAPI);
    assert.match(
      ui.notifications[0].message,
      /retain the inspected source path and hash/,
    );
    const saved = JSON.parse(await readFile(join(f.dir, "saved.json"), "utf8"));
    assert.equal(saved.nameSuffix, " (reviewed)");
    assert.equal(saved.sourceSha256, f.snapshot.sha256);
  });

  it("cancelling the editor returns to the outline, and Escape there writes nothing", async () => {
    const f = await fixture();
    const ui = reviewUi(f, [["e"], [ESC]], { editors: [() => undefined] });
    await handleTreeProposal("--output saved.json", ui.ctx, {} as ExtensionAPI);
    assert.equal(ui.editors.length, 1);
    assert.deepEqual(await readdir(f.dir), ["source.jsonl"]);
  });
});
