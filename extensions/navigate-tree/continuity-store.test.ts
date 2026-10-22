/**
 * Tests for branch-local ledger persistence and fold-time reconciliation.
 *
 * Node test runner. Run with: pnpm test
 *
 * Branches are real in-memory `SessionManager` branches: the ledger must follow
 * the active leaf, not the file.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExtensionAPI,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  applyOps,
  createLedger,
  LEDGER_DETAILS_KEY,
  type Ledger,
  type LedgerOp,
  serializeLedger,
} from "./continuity-ledger.ts";
import {
  appendOpsEntry,
  CONTINUITY_OPS_CUSTOM_TYPE,
  type ContinuityOpsData,
  readBranchLedger,
  reconcileFoldContinuity,
  type StoredOp,
  spanUserEntryRefs,
  userEntryIndexOf,
} from "./continuity-store.ts";

const user = (sm: SessionManager, text: string): string =>
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as never);

const assistant = (sm: SessionManager, text: string): string =>
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "claude",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as never);

const pi = (sm: SessionManager) =>
  ({
    appendEntry: (customType: string, data?: unknown) =>
      sm.appendCustomEntry(customType, data),
  }) as Pick<ExtensionAPI, "appendEntry">;

const addRule = (text: string, entryId?: string): StoredOp => ({
  op: { op: "add", kind: "rule", text },
  ctx: { origin: "user", ...(entryId !== undefined && { entryId }) },
});

const item = (ledger: Ledger, id: string) => {
  const found = ledger.items.find((candidate) => candidate.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
};

describe("userEntryIndexOf", () => {
  it("resolves user message positions on the branch, nothing else", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "one");
    const a1 = assistant(sm, "reply");
    const u2 = user(sm, "two");
    const branch = sm.getBranch();
    const resolve = userEntryIndexOf(branch);
    assert.equal(resolve(u1), 0);
    assert.equal(resolve(u2), 2);
    assert.equal(resolve(a1), undefined);
    assert.equal(resolve("nope"), undefined);
  });
});

describe("readBranchLedger", () => {
  it("replays ops entries root to leaf and reports the last watermark", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "never edit the lockfile");
    appendOpsEntry(pi(sm), [addRule("Never edit the lockfile", u1)], u1);
    assistant(sm, "ok");
    const u2 = user(sm, "use tabs");
    appendOpsEntry(pi(sm), [addRule("Use tabs", u2)], u2);
    const result = readBranchLedger(sm.getBranch());
    assert.deepEqual(result.warnings, []);
    assert.equal(result.watermark, u2);
    assert.deepEqual(
      result.ledger.items.map((i) => [i.id, i.text, i.source.entryId]),
      [
        ["R1", "Never edit the lockfile", u1],
        ["R2", "Use tabs", u2],
      ],
    );
  });

  it("applies consecutive ops with one context as one revision", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "rules");
    appendOpsEntry(pi(sm), [
      addRule("Rule A", u1),
      addRule("Rule B", u1),
      addRule("Rule C", "other"),
    ]);
    const { ledger } = readBranchLedger(sm.getBranch());
    assert.equal(ledger.rev, 2);
    assert.deepEqual(
      ledger.items.map((i) => i.createdRev),
      [1, 1, 2],
    );
  });

  it("returns an empty ledger for a branch without ledger entries", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "hi");
    assert.deepEqual(readBranchLedger(sm.getBranch()), {
      ledger: createLedger(),
      warnings: [],
    });
  });

  it("a snapshot on a branch_summary replaces the running ledger; later ops apply on top", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "keep");
    const a1 = assistant(sm, "ok");
    appendOpsEntry(pi(sm), [addRule("Carried by the snapshot", u1)], u1);
    const abandoned = readBranchLedger(sm.getBranch()).ledger;
    const snapshot = applyOps(
      abandoned,
      [{ op: "add", kind: "decision", text: "Use sqlite" }],
      { origin: "agent" },
    ).ledger;
    sm.branchWithSummary(
      a1,
      "summary",
      { [LEDGER_DETAILS_KEY]: snapshot },
      true,
    );
    const u2 = user(sm, "more");
    appendOpsEntry(pi(sm), [addRule("After the fold", u2)], u2);
    const result = readBranchLedger(sm.getBranch());
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.ledger.items.map((i) => i.text),
      ["Carried by the snapshot", "Use sqlite", "After the fold"],
    );
    assert.equal(result.watermark, u2);
  });

  it("the watermark of ops before a snapshot does not survive it", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    const a1 = assistant(sm, "ok");
    appendOpsEntry(pi(sm), [addRule("R", u1)], u1);
    const snapshot = readBranchLedger(sm.getBranch()).ledger;
    sm.branchWithSummary(a1, "s", { [LEDGER_DETAILS_KEY]: snapshot }, true);
    assert.equal(readBranchLedger(sm.getBranch()).watermark, undefined);
  });

  it("a branch_summary without a snapshot leaves the ledger as it was", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    appendOpsEntry(pi(sm), [addRule("R", u1)]);
    const a1 = assistant(sm, "ok");
    sm.branchWithSummary(a1, "native summary", undefined, false);
    appendOpsEntry(pi(sm), [addRule("S", u1)]);
    assert.deepEqual(
      readBranchLedger(sm.getBranch()).ledger.items.map((i) => i.text),
      ["R", "S"],
    );
  });

  it("a corrupt snapshot yields a warning and keeps the previous ledger", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    appendOpsEntry(pi(sm), [addRule("Survives", u1)]);
    const a1 = assistant(sm, "ok");
    const summaryId = sm.branchWithSummary(
      a1,
      "s",
      { [LEDGER_DETAILS_KEY]: { version: 1, rev: "bad", items: [] } },
      true,
    );
    appendOpsEntry(pi(sm), [addRule("Added later", u1)]);
    const result = readBranchLedger(sm.getBranch());
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], new RegExp(summaryId));
    assert.deepEqual(
      result.ledger.items.map((i) => i.text),
      ["Survives", "Added later"],
    );
  });

  it("a malformed ops entry is skipped with a warning", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, { ops: [{ op: null }] });
    sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, "garbage");
    sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, {
      ops: [
        {
          op: { op: "supersede", with: { kind: "rule", text: "x" } },
          ctx: { origin: "agent" },
        },
      ],
    });
    appendOpsEntry(pi(sm), [addRule("Fine", u1)]);
    const result = readBranchLedger(sm.getBranch());
    assert.equal(result.warnings.length, 3);
    assert.deepEqual(
      result.ledger.items.map((i) => i.text),
      ["Fine"],
    );
  });

  it("verifies supersession citations against user entries on this branch", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "use spaces");
    const a1 = assistant(sm, "ok");
    appendOpsEntry(pi(sm), [addRule("Use spaces", u1)]);
    const u2 = user(sm, "actually, tabs");
    const supersede = (citedEntryId: string): StoredOp => ({
      op: {
        op: "supersede",
        ids: ["R1"],
        with: { kind: "rule", text: "Use tabs" },
        citedEntryId,
      },
      ctx: { origin: "agent" },
    });
    appendOpsEntry(pi(sm), [supersede(a1)]);
    assert.equal(
      item(readBranchLedger(sm.getBranch()).ledger, "R1").status,
      "active",
      "an assistant entry is not a user citation",
    );
    appendOpsEntry(pi(sm), [supersede(u2)]);
    const { ledger } = readBranchLedger(sm.getBranch());
    assert.equal(item(ledger, "R1").status, "superseded");
    assert.equal(item(ledger, "R2").text, "Use tabs");
  });

  it("follows the active leaf: sibling branches have independent ledgers", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    const a1 = assistant(sm, "ok");
    appendOpsEntry(pi(sm), [addRule("Shared", u1)]);
    const fork = sm.getLeafId() as string;
    appendOpsEntry(pi(sm), [addRule("Only on the first branch", u1)]);
    sm.branch(a1);
    appendOpsEntry(pi(sm), [addRule("Only on the second branch", u1)]);
    assert.deepEqual(
      readBranchLedger(sm.getBranch()).ledger.items.map((i) => i.text),
      ["Only on the second branch"],
    );
    sm.branch(fork);
    assert.deepEqual(
      readBranchLedger(sm.getBranch()).ledger.items.map((i) => i.text),
      ["Shared"],
    );
  });
});

describe("appendOpsEntry", () => {
  it("writes a navigate-tree-continuity-ops entry with serializable contexts only", () => {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "x");
    const withResolver = {
      origin: "user" as const,
      entryId: u1,
      userEntryIndex: () => 0,
    };
    appendOpsEntry(
      pi(sm),
      [{ op: { op: "add", kind: "rule", text: "R" }, ctx: withResolver }],
      u1,
    );
    const entry = sm.getBranch().at(-1) as SessionEntry;
    assert.ok(entry.type === "custom");
    assert.equal(entry.customType, CONTINUITY_OPS_CUSTOM_TYPE);
    const data = JSON.parse(JSON.stringify(entry.data)) as ContinuityOpsData;
    assert.deepEqual(data, {
      ops: [
        {
          op: { op: "add", kind: "rule", text: "R" },
          ctx: { origin: "user", entryId: u1 },
        },
      ],
      watermark: u1,
    });
  });

  it("writes nothing without ops and without a watermark; a bare watermark is kept", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "x");
    const before = sm.getEntries().length;
    appendOpsEntry(pi(sm), []);
    assert.equal(sm.getEntries().length, before);
    appendOpsEntry(pi(sm), [], "w1");
    assert.equal(readBranchLedger(sm.getBranch()).watermark, "w1");
  });
});

describe("spanUserEntryRefs", () => {
  it("lists user messages after the anchor as one-line previews", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "before the anchor");
    const anchor = assistant(sm, "ok");
    const u2 = user(sm, "line one\n\n  line   two");
    assistant(sm, "reply");
    const u3 = user(sm, "x".repeat(2000));
    const refs = spanUserEntryRefs(sm.getBranch(), anchor);
    assert.deepEqual(
      refs.map((ref) => ref.id),
      [u2, u3],
    );
    assert.equal(refs[0].preview, "line one line two");
    assert.ok(refs[1].preview.length <= 400);
  });

  it("is empty when the anchor is not on the branch", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "x");
    assert.deepEqual(spanUserEntryRefs(sm.getBranch(), "missing"), []);
  });
});

describe("reconcileFoldContinuity", () => {
  function seeded() {
    const sm = SessionManager.inMemory("/tmp");
    const u1 = user(sm, "never edit the lockfile");
    appendOpsEntry(pi(sm), [addRule("Never edit the lockfile", u1)]);
    assistant(sm, "ok");
    const u2 = user(sm, "look at the parser first");
    appendOpsEntry(pi(sm), [
      {
        op: {
          op: "add",
          kind: "steering",
          text: "Look at the parser first",
          scopeAnchor: "start",
        },
        ctx: { origin: "user", entryId: u2 },
      },
    ]);
    return { sm, u1, u2 };
  }
  const SUMMARY = "## Goal\nShip it.\n\n## Next Steps\n1. Test.";
  const delta = (body: unknown) =>
    `${SUMMARY}\n\n<continuity-delta>\n${JSON.stringify(body)}\n</continuity-delta>`;

  it("leaves an empty ledger and a delta-free summary untouched", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "x");
    assert.deepEqual(
      reconcileFoldContinuity(sm.getBranch(), SUMMARY, "start"),
      { summaryText: SUMMARY, ledger: createLedger() },
    );
  });

  it("archives the anchor's steering, keeps the rule in force and renders the briefing", () => {
    const { sm } = seeded();
    const result = reconcileFoldContinuity(sm.getBranch(), SUMMARY, "start");
    assert.equal(result.summaryText, SUMMARY);
    assert.equal(item(result.ledger, "R1").status, "active");
    assert.equal(item(result.ledger, "T2").status, "archived");
    assert.ok(result.briefing?.includes("Never edit the lockfile"));
    assert.ok(!result.briefing?.includes("Look at the parser first"));
    assert.deepEqual(result.snapshot, serializeLedger(result.ledger));
    assert.deepEqual(result.report, {
      rev: result.ledger.rev,
      applied: 1,
      rejected: [],
      evicted: [],
    });
    assert.equal(result.notice, undefined);
  });

  it("rejects a delta that archives a user rule per item and still applies the valid ones", () => {
    const { sm } = seeded();
    const result = reconcileFoldContinuity(
      sm.getBranch(),
      delta({
        expiredSteering: ["R1"],
        ratified: [{ kind: "decision", text: "Use sqlite" }],
      }),
      "start",
    );
    assert.equal(result.summaryText, SUMMARY, "the block is stripped");
    assert.equal(item(result.ledger, "R1").status, "active");
    assert.equal(item(result.ledger, "D3").text, "Use sqlite");
    assert.equal(item(result.ledger, "D3").source.origin, "agent");
    assert.equal(result.report?.applied, 2);
    assert.deepEqual(
      result.report?.rejected.map((r) => r.id),
      ["R1"],
    );
    assert.match(result.report?.rejected[0].reason ?? "", /protected/);
    assert.match(
      result.notice ?? "",
      /^Continuity: 1 delta op rejected \(R1 .*protected.*\)\.$/,
    );
    assert.ok(!result.notice?.includes("\n"));
  });

  it("reports a malformed delta, applies nothing from it and strips the block", () => {
    const { sm } = seeded();
    const result = reconcileFoldContinuity(
      sm.getBranch(),
      `${SUMMARY}\n\n<continuity-delta>\nnot json\n</continuity-delta>`,
      "start",
    );
    assert.equal(result.summaryText, SUMMARY);
    assert.match(result.report?.deltaError ?? "", /not valid JSON/);
    assert.equal(result.report?.applied, 1, "only the steering archive");
    assert.match(result.notice ?? "", /^Continuity: delta ignored \(/);
  });

  it("keeps a stray open tag in the prose and reports nothing for it", () => {
    const { sm } = seeded();
    const stray = `${SUMMARY}\nThe model wrote <continuity-delta> in prose.`;
    const result = reconcileFoldContinuity(sm.getBranch(), stray, "start");
    assert.equal(result.summaryText, stray);
    assert.equal(result.report?.deltaError, undefined);
    assert.equal(result.notice, undefined);
  });

  it("an unusable delta on an empty ledger is reported, not applied", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "x");
    const result = reconcileFoldContinuity(
      sm.getBranch(),
      delta({ completed: ["S9"] }),
      "start",
    );
    assert.equal(result.summaryText, SUMMARY);
    assert.deepEqual(result.ledger, createLedger());
    assert.equal(result.briefing, undefined);
    assert.equal(result.snapshot, undefined);
    assert.equal(result.report?.rejected.length, 1);
  });

  it("surfaces replay warnings in the report and keeps the previous ledger", () => {
    const { sm } = seeded();
    sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, "garbage");
    const result = reconcileFoldContinuity(sm.getBranch(), SUMMARY, "start");
    assert.equal(result.report?.warnings?.length, 1);
    assert.equal(item(result.ledger, "R1").status, "active");
  });

  it("embeds no briefing when nothing in the ledger is in force", () => {
    const sm = SessionManager.inMemory("/tmp");
    user(sm, "x");
    const done: LedgerOp[] = [
      { op: "add", kind: "steering", text: "Only here", scopeAnchor: "start" },
    ];
    appendOpsEntry(
      pi(sm),
      done.map((op) => ({ op, ctx: { origin: "user" } })),
    );
    const result = reconcileFoldContinuity(sm.getBranch(), SUMMARY, "start");
    assert.equal(item(result.ledger, "T1").status, "archived");
    assert.equal(result.briefing, undefined);
    assert.ok(result.snapshot, "the archived history is still stored");
  });
});
