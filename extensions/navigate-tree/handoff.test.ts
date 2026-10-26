import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getHandoff,
  handoffContext,
  handoffStats,
  makeHandoff,
  materializeHandoff,
} from "./handoff.ts";

const data = (name: string) =>
  makeHandoff({
    name,
    report: `## Goal\n${name} goal\n\n### Done\n${name} outcome`,
    mode: "full",
    children: [],
    sourceEntries: [],
  });

describe("work handoffs", () => {
  it("carries nested child reports once, while synthesis keeps only its reviewed report", () => {
    const child = materializeHandoff(data("child"), [
      { id: "leaf", summary: "LEAF_FACT" },
    ]);
    const parent = materializeHandoff(data("parent"), [
      { id: "child", summary: child },
      { id: "child", summary: child },
    ]);
    assert.equal(parent.split("LEAF_FACT").length - 1, 1);
    assert.match(parent, /parent outcome/);
    assert.match(parent, /child outcome/);
    const synthesized = materializeHandoff(
      { ...data("parent"), mode: "synthesized" },
      [{ id: "child", summary: child }],
    );
    assert.match(synthesized, /parent outcome/);
    assert.doesNotMatch(synthesized, /LEAF_FACT/);
  });

  it("indexes unique children with bounded own metadata and never embeds descendants", () => {
    const metadata = {
      ...data("metadata"),
      title: "Metadata title",
      goal: "Metadata goal",
      outcome: "Metadata outcome",
    };
    const children = [
      { id: "meta", summary: "SECRET_METADATA_BODY", handoff: metadata },
      {
        id: "plain",
        summary: `# Work handoff: Plain phase
## Goal
Plain goal
## Outcome
${"Delivered\u0000\t".repeat(80)}
## Details
SECRET_PLAIN_BODY
## Child handoffs in chronological order
# Work handoff: Grandchild
## Goal
SECRET_GRANDCHILD`,
      },
    ];
    const output = materializeHandoff({ ...data("parent"), mode: "digest" }, [
      ...children,
      children[0],
    ]);
    const lines = output.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0],
      "- Metadata title · goal: Metadata goal · outcome: Metadata outcome · entry meta",
    );
    assert.match(
      lines[1],
      /^- Plain phase · goal: Plain goal · outcome: Delivered/,
    );
    assert.match(lines[1], /… · entry plain$/);
    assert.ok(
      lines.every((line) => line.length <= 300 && !/\p{Cc}/u.test(line)),
    );
    assert.doesNotMatch(output, /SECRET_|Grandchild/);
    assert.equal(
      materializeHandoff({ ...data("parent"), mode: "digest" }, [
        { id: "empty", summary: "" },
      ])
        .split("\n")
        .at(-1),
      "- entry empty",
    );
  });

  it("counts unique recorded usage without charging nested inclusive totals again", () => {
    const entry: SessionEntry = {
      type: "usage",
      id: "u",
      parentId: null,
      timestamp: "2026-01-01",
      kind: "cache_warm",
      provider: "test",
      model: "test",
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 14,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    assert.deepEqual(handoffStats([entry, entry]), {
      messages: 0,
      toolCalls: 0,
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 10,
      usageRecords: 1,
    });
  });

  it("passes the complete projected report to the model without a false branch preamble", () => {
    const handoff = data("phase");
    const entry: SessionEntry = {
      type: "branch_summary",
      id: "s",
      parentId: null,
      fromId: "old",
      timestamp: "2026-01-01",
      summary: materializeHandoff(handoff, []),
      details: { treeNavigator: handoff },
    };
    assert.deepEqual(getHandoff(entry), handoff);
    const projected = [
      {
        role: "branchSummary" as const,
        summary: entry.summary,
        fromId: "old",
        timestamp: 1,
      },
    ];
    const wire = JSON.stringify(convertToLlm(handoffContext(entry, projected)));
    assert.match(wire, /phase goal/);
    assert.match(wire, /phase outcome/);
    assert.doesNotMatch(wire, /came back|explored a different/);
    assert.deepEqual(handoffContext(entry, []), []);
    assert.deepEqual(
      handoffContext({ ...entry, details: undefined }, projected),
      projected,
    );
  });
});
