import * as assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
} from "./retrospective.ts";
import { inspectRetrospectiveSession } from "./retrospective-plan.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const timestamp = "2026-01-01T00:00:00.000Z";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tree-retrospective-"));
  directories.push(dir);
  const source = join(dir, "source.jsonl");
  const records = [
    { type: "session", version: 3, id: "original", cwd: dir, timestamp },
    {
      type: "session_info",
      id: "name",
      parentId: null,
      timestamp,
      name: "Original",
    },
    ...["one", "two", "three", "tail"].map((id, i) => ({
      type: "message",
      id,
      parentId: ["name", "one", "two", "three"][i],
      timestamp,
      message: { role: "user", content: `Question ${id}`, timestamp: 1 },
    })),
  ];
  await writeFile(
    source,
    `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const info = await inspectRetrospectiveSession(source);
  const plan = {
    version: 1,
    source,
    sourceSha256: info.sourceSha256,
    groups: [
      {
        name: "phase",
        firstEntryId: "one",
        lastEntryId: "three",
        summary: "Completed phase; continue with tail.",
        children: [
          {
            name: "first",
            firstEntryId: "one",
            lastEntryId: "one",
            summary: "First task complete.",
          },
          {
            name: "second",
            firstEntryId: "two",
            lastEntryId: "three",
            summary: "Second task complete.",
          },
        ],
      },
    ],
  };
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  return { dir, source, plan, planPath };
}

describe("retrospective clone", () => {
  it("preserves source bytes and messages, nests summaries, and resumes on the tail", async () => {
    const f = await fixture();
    const before = await readFile(f.source);
    const preview = await previewRetrospectiveSession(f.planPath);
    assert.equal((await readdir(f.dir)).length, 2);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    assert.deepEqual(await readFile(f.source), before);
    const clone = SessionManager.open(result.path);
    assert.notEqual(clone.getSessionId(), "original");
    assert.equal(clone.getSessionName(), "Original (restructured)");
    assert.equal(clone.getHeader()?.parentSession, f.source);
    assert.equal(
      clone.getEntries().filter((entry) => entry.type === "message").length,
      4,
    );
    const summaries = clone
      .getEntries()
      .filter((entry) => entry.type === "branch_summary");
    assert.equal(summaries.length, 3);
    const active = clone.buildSessionContext().messages;
    assert.deepEqual(
      active.map((message) => message.role),
      ["branchSummary", "user"],
    );
    const tail = active.at(-1);
    assert.equal(tail?.role === "user" && tail.content, "Question tail");
    const phase = summaries.find(
      (entry) => clone.getLabel(entry.id) === "anchor:phase",
    );
    assert.ok(phase);
    const nested = clone.getBranch(phase.fromId);
    assert.equal(
      nested.filter((entry) => entry.type === "branch_summary").length,
      2,
    );
    for (const id of ["one", "two", "three", "tail"])
      assert.ok(clone.getEntry(id));
    const reloaded = SessionManager.open(result.path);
    assert.deepEqual(
      reloaded.buildSessionContext(),
      clone.buildSessionContext(),
    );
  });

  it("refuses a changed source or changed plan after preview without publishing a clone", async () => {
    const f = await fixture();
    const preview = await previewRetrospectiveSession(f.planPath);
    f.plan.groups[0].summary = "Different summary.";
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await assert.rejects(
      cloneRetrospectiveSession(f.planPath, preview.previewToken),
      /preview/i,
    );
    await writeFile(f.source, `${await readFile(f.source, "utf8")} `);
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /changed|hash|snapshot/i,
    );
    assert.equal((await readdir(f.dir)).length, 2);
  });

  it("refuses overlapping siblings and malformed source records", async () => {
    const f = await fixture();
    f.plan.groups[0].children[1].firstEntryId = "one";
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /overlap|ordered/i,
    );
    await writeFile(f.source, `${await readFile(f.source, "utf8")}not json\n`);
    await assert.rejects(inspectRetrospectiveSession(f.source));
  });
});
