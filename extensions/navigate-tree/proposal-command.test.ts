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

describe("tree proposal command", () => {
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
    let modelCalls = 0;
    const ctx = {
      cwd: f.dir,
      hasUI: true,
      isIdle: () => true,
      isProjectTrusted: () => false,
      sessionManager: { getSessionFile: () => f.source },
      ui: {
        notify() {},
        async editor() {
          return undefined;
        },
      },
      modelRegistry: {
        streamSimple() {
          modelCalls++;
          throw new Error("must not call");
        },
      },
    } as unknown as ExtensionCommandContext;
    await handleTreeProposal("", ctx, {} as ExtensionAPI);
    assert.equal(modelCalls, 0);
    assert.deepEqual(await readdir(f.dir), ["source.jsonl"]);
    assert.equal(await readFile(f.source, "utf8"), f.data);
  });
});
