/**
 * Tests for the pure Session Continuity Ledger core.
 *
 * Node test runner. Run with: pnpm test
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOps,
  archiveSteeringForAnchor,
  ContinuityError,
  type ContinuityErrorCode,
  checkFilePointers,
  createLedger,
  type Ledger,
  type LedgerOp,
  MAX_ITEM_TEXT_CHARS,
  MAX_LEDGER_ITEMS,
  MAX_QUOTE_CHARS,
  type OpContext,
  parseLedger,
  reconcileFold,
  rewindLedger,
  serializeLedger,
  TRUNCATION_MARKER,
} from "./continuity-ledger.ts";

const USER: OpContext = { origin: "user", entryId: "e1" };
const AGENT: OpContext = { origin: "agent" };

function build(
  ledger: Ledger,
  ops: readonly LedgerOp[],
  ctx: OpContext,
): Ledger {
  const result = applyOps(ledger, ops, ctx);
  assert.deepEqual(result.rejected, []);
  return result.ledger;
}

const item = (ledger: Ledger, id: string) => {
  const found = ledger.items.find((candidate) => candidate.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
};

const rejectedWith =
  (code: ContinuityErrorCode, itemId?: string) => (e: unknown) =>
    e instanceof ContinuityError &&
    e.code === code &&
    (itemId === undefined || e.itemId === itemId);

describe("protected items", () => {
  const seeded = build(
    createLedger(),
    [
      {
        op: "add",
        kind: "rule",
        text: "Never edit the lockfile",
        quote: "don't touch pnpm-lock",
      },
      { op: "add", kind: "fact", text: "CI runs on node 22" },
    ],
    USER,
  );

  for (const origin of ["agent", "classifier"] as const) {
    it(`${origin} ops cannot archive, rewrite or complete a user rule, and the rejection names it`, () => {
      const result = applyOps(
        seeded,
        [
          { op: "archive", id: "R1" },
          { op: "update", id: "R1", text: "Edit the lockfile freely" },
          { op: "complete", id: "R1" },
        ],
        { origin },
      );
      assert.equal(result.applied.length, 0);
      assert.equal(result.rejected.length, 3);
      for (const { reason } of result.rejected) {
        assert.equal(reason.code, "protected_item");
        assert.equal(reason.itemId, "R1");
        assert.match(reason.message, /R1/);
      }
      assert.equal(result.ledger, seeded);
    });
  }

  it("lets the user rewrite their own rule and agents change unprotected items", () => {
    const edited = build(
      seeded,
      [{ op: "update", id: "R1", text: "Never edit lockfiles" }],
      { origin: "user", entryId: "e2" },
    );
    assert.equal(item(edited, "R1").text, "Never edit lockfiles");
    const archived = build(seeded, [{ op: "archive", id: "F2" }], AGENT);
    assert.equal(item(archived, "F2").status, "archived");
  });

  it("protects agent items once the user pins them, and refuses agent pinning", () => {
    const withAgentRule = build(
      seeded,
      [{ op: "add", kind: "rule", text: "Prefer small commits" }],
      AGENT,
    );
    assert.equal(
      applyOps(withAgentRule, [{ op: "pin", id: "R3" }], AGENT).rejected[0]
        ?.reason.code,
      "protected_item",
    );
    const pinned = build(withAgentRule, [{ op: "pin", id: "R3" }], USER);
    const blocked = applyOps(pinned, [{ op: "archive", id: "R3" }], AGENT);
    assert.equal(blocked.rejected[0]?.reason.itemId, "R3");
  });

  it("allows only one active objective; replacing it is a supersession", () => {
    const l1 = build(
      createLedger(),
      [{ op: "add", kind: "objective", text: "Ship the parser" }],
      USER,
    );
    const second = applyOps(
      l1,
      [{ op: "add", kind: "objective", text: "Ship the linter" }],
      USER,
    );
    assert.equal(second.rejected[0]?.reason.code, "invalid_op");
    const replaced = build(
      l1,
      [
        {
          op: "supersede",
          ids: ["G1"],
          with: { kind: "objective", text: "Ship the linter" },
        },
      ],
      { origin: "user", entryId: "e2" },
    );
    assert.equal(item(replaced, "G2").status, "active");
  });
});

describe("supersession", () => {
  const entries = new Map([
    ["e1", 1],
    ["e5", 5],
  ]);
  const ctx: OpContext = {
    origin: "classifier",
    userEntryIndex: (id) => entries.get(id),
  };
  const seeded = build(
    createLedger(),
    [{ op: "add", kind: "rule", text: "Use spaces for indentation" }],
    USER,
  );
  const replacement = {
    kind: "rule",
    text: "Use tabs for indentation",
    quote: "actually, tabs",
  } as const;

  it("accepts a newer cited user entry and records the lineage both ways", () => {
    const result = applyOps(
      seeded,
      [{ op: "supersede", ids: ["R1"], with: replacement, citedEntryId: "e5" }],
      ctx,
    );
    assert.deepEqual(result.rejected, []);
    const old = item(result.ledger, "R1");
    const heir = item(result.ledger, "R2");
    assert.equal(old.status, "superseded");
    assert.equal(old.supersededBy, "R2");
    assert.deepEqual(heir.supersedes, ["R1"]);
    assert.equal(heir.status, "active");
    assert.deepEqual(heir.source, { entryId: "e5", origin: "user" });
    assert.equal(parseLedger(serializeLedger(result.ledger)).items.length, 2);
  });

  it("rejects missing, non-user, own-source and not-newer citations", () => {
    const attempts: (string | undefined)[] = [
      undefined,
      "assistant-entry",
      "e1",
    ];
    for (const citedEntryId of attempts) {
      const result = applyOps(
        seeded,
        [
          {
            op: "supersede",
            ids: ["R1"],
            with: replacement,
            ...(citedEntryId && { citedEntryId }),
          },
        ],
        ctx,
      );
      assert.equal(result.ledger, seeded);
      assert.ok(
        rejectedWith("invalid_citation", "R1")(result.rejected[0]?.reason),
      );
    }
    const later = build(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Use spaces" }],
      { origin: "user", entryId: "e5" },
    );
    const older = applyOps(
      later,
      [{ op: "supersede", ids: ["R1"], with: replacement, citedEntryId: "e1" }],
      ctx,
    );
    assert.ok(
      rejectedWith("invalid_citation", "R1")(older.rejected[0]?.reason),
    );
  });

  it("lets agents supersede unprotected items without a citation", () => {
    const l1 = build(
      createLedger(),
      [{ op: "add", kind: "fact", text: "Node 20" }],
      AGENT,
    );
    const l2 = build(
      l1,
      [
        {
          op: "supersede",
          ids: ["F1"],
          with: { kind: "fact", text: "Node 22" },
        },
      ],
      AGENT,
    );
    assert.equal(item(l2, "F1").supersededBy, "F2");
  });
});

describe("reconcileFold", () => {
  it("rejects each invalid delta entry by itself while valid ones still apply", () => {
    const withRule = build(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Keep the public API stable" }],
      { origin: "pin" },
    );
    const base = build(
      withRule,
      [
        {
          op: "add",
          kind: "sub-goal",
          text: "Port the parser",
          scopeAnchor: "port",
        },
        {
          op: "add",
          kind: "steering",
          text: "Skip the slow tests",
          scopeAnchor: "port",
        },
      ],
      USER,
    );
    const result = reconcileFold(
      base,
      {
        completed: ["S2", "S99"],
        expiredSteering: ["R1", "T3"],
        superseded: [
          { ids: ["R1"], with: { kind: "rule", text: "Break the API" } },
        ],
        ratified: [{ kind: "decision", text: "Use a streaming parser" }],
      },
      { anchorName: "port", origin: "classifier" },
    );
    assert.deepEqual(
      result.rejected.map((r) => [r.op.op, r.reason.code, r.reason.itemId]),
      [
        ["archive", "protected_item", "R1"],
        ["complete", "unknown_item", "S99"],
        ["supersede", "invalid_citation", "R1"],
      ],
    );
    assert.deepEqual(
      result.applied.map((a) => [a.effect, a.item.id]),
      [
        ["archived", "T3"],
        ["completed", "S2"],
        ["added", "D4"],
      ],
    );
    assert.equal(item(result.ledger, "R1").status, "active");
    assert.equal(item(result.ledger, "S2").status, "completed");
    assert.equal(item(result.ledger, "D4").source.origin, "classifier");
    assert.equal(result.ledger.rev, base.rev + 1);
  });

  it("archives the folded anchor's steering and reports it as applied", () => {
    const base = build(
      createLedger(),
      [
        {
          op: "add",
          kind: "steering",
          text: "Use the staging db",
          scopeAnchor: "impl-start",
        },
        {
          op: "add",
          kind: "steering",
          text: "Review before merge",
          scopeAnchor: "other-work",
        },
      ],
      USER,
    );
    const result = reconcileFold(
      base,
      {},
      { anchorName: "impl-start", origin: "agent" },
    );
    assert.deepEqual(
      result.applied.map((a) => [a.effect, a.item.id, a.item.text]),
      [["archived", "T1", "Use the staging db"]],
    );
    assert.equal(item(result.ledger, "T1").status, "archived");
    assert.equal(item(result.ledger, "T2").status, "active");
    assert.equal(result.ledger.items.length, 2);
  });
});

describe("archiveSteeringForAnchor", () => {
  it("archives unpinned steering of the anchor, keeps pinned and others, and never deletes", () => {
    const base = build(
      createLedger(),
      [
        { op: "add", kind: "steering", text: "A", scopeAnchor: "one" },
        { op: "add", kind: "steering", text: "B", scopeAnchor: "one" },
        { op: "add", kind: "steering", text: "C", scopeAnchor: "two" },
      ],
      USER,
    );
    const pinned = build(base, [{ op: "pin", id: "T2" }], USER);
    const result = archiveSteeringForAnchor(pinned, "one");
    assert.deepEqual(
      result.applied.map((a) => a.item.id),
      ["T1"],
    );
    assert.deepEqual(
      result.ledger.items.map((i) => i.status),
      ["archived", "active", "active"],
    );
    assert.equal(
      archiveSteeringForAnchor(result.ledger, "one").ledger,
      result.ledger,
    );
  });
});

describe("ids and rewinds", () => {
  it("never reuses an id after rewinding to an earlier snapshot", () => {
    const l0 = build(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Rule one" }],
      USER,
    );
    const snapshot = JSON.parse(JSON.stringify(serializeLedger(l0)));
    const l1 = build(
      l0,
      [
        { op: "add", kind: "fact", text: "first" },
        { op: "add", kind: "fact", text: "second" },
      ],
      AGENT,
    );
    const rewound = rewindLedger(parseLedger(snapshot), l1);
    const l2 = build(
      rewound,
      [{ op: "add", kind: "fact", text: "third" }],
      AGENT,
    );
    const used = l1.items.map((i) => i.id);
    assert.deepEqual(used, ["R1", "F2", "F3"]);
    assert.equal(l2.items.at(-1)?.id, "F4");
    assert.ok(l2.rev > l1.rev);
    assert.equal(l2.items.length, 2);
  });
});

describe("duplicates and caps", () => {
  it("reports an equal active item as a duplicate and returns its id without a new revision", () => {
    const l1 = build(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Use  Tabs." }],
      USER,
    );
    const result = applyOps(
      l1,
      [{ op: "add", kind: "rule", text: " use tabs. " }],
      AGENT,
    );
    assert.deepEqual(
      result.applied.map((a) => [a.effect, a.item.id]),
      [["duplicate", "R1"]],
    );
    assert.equal(result.ledger, l1);
    const other = build(
      l1,
      [{ op: "add", kind: "fact", text: "Use Tabs." }],
      AGENT,
    );
    assert.equal(other.items.length, 2);
  });

  it("truncates oversize text and quotes with a visible marker", () => {
    const l1 = build(
      createLedger(),
      [
        {
          op: "add",
          kind: "rule",
          text: "x".repeat(2000),
          quote: "q".repeat(2000),
        },
      ],
      USER,
    );
    const [rule] = l1.items;
    assert.equal(rule?.text.length, MAX_ITEM_TEXT_CHARS);
    assert.ok(rule?.text.endsWith(TRUNCATION_MARKER));
    assert.equal(rule?.quote?.length, MAX_QUOTE_CHARS);
    assert.ok(rule?.quote?.endsWith(TRUNCATION_MARKER));
  });

  it("rejects additions with an explicit error once the ledger is full", () => {
    const ops: LedgerOp[] = Array.from(
      { length: MAX_LEDGER_ITEMS },
      (_, i) => ({
        op: "add",
        kind: "fact",
        text: `fact ${i}`,
      }),
    );
    const full = build(createLedger(), ops, AGENT);
    const result = applyOps(
      full,
      [{ op: "add", kind: "fact", text: "one more" }],
      AGENT,
    );
    assert.ok(rejectedWith("ledger_full")(result.rejected[0]?.reason));
    assert.equal(result.ledger, full);
  });
});

describe("file pointers", () => {
  const sha = (c: string) => c.repeat(64);
  const base = build(
    createLedger(),
    [
      {
        op: "add",
        kind: "file",
        file: {
          path: "src/a.ts",
          lines: "10-40",
          sha256: sha("a"),
          why: "parser entry",
        },
      },
      {
        op: "add",
        kind: "file",
        file: { path: "src/b.ts", sha256: sha("b"), why: "config" },
      },
      {
        op: "add",
        kind: "file",
        file: { path: "src/c.ts", sha256: sha("c"), why: "gone" },
      },
      { op: "add", kind: "file", file: { path: "src/d.ts", why: "no hash" } },
    ],
    USER,
  );

  it("flags pointers whose hash differs or whose file is missing, and leaves unhashed ones alone", () => {
    const hashes: Record<string, string> = {
      "src/a.ts": sha("z"),
      "src/b.ts": sha("b"),
    };
    const result = checkFilePointers(base, (path) => hashes[path]);
    assert.deepEqual(
      result.applied.map((a) => [a.effect, a.item.id]),
      [
        ["stale", "P1"],
        ["stale", "P3"],
      ],
    );
    assert.equal(item(result.ledger, "P1").text, "src/a.ts:10-40");
    assert.deepEqual(
      result.ledger.items.map((i) => i.status),
      ["stale", "active", "stale", "active"],
    );
    const again = checkFilePointers(result.ledger, (path) => hashes[path]);
    assert.equal(again.ledger, result.ledger);
  });
});

describe("parseLedger and serialization", () => {
  const rich = (() => {
    let ledger = build(
      createLedger(),
      [
        {
          op: "add",
          kind: "objective",
          text: "Ship the parser",
          quote: "ship it",
        },
        { op: "add", kind: "rule", text: "Use tabs" },
        {
          op: "add",
          kind: "steering",
          text: "Skip slow tests",
          scopeAnchor: "impl",
        },
        {
          op: "add",
          kind: "file",
          file: { path: "src/a.ts", sha256: "a".repeat(64), why: "entry" },
        },
      ],
      USER,
    );
    ledger = build(ledger, [{ op: "pin", id: "T3" }], USER);
    return build(
      ledger,
      [
        {
          op: "supersede",
          ids: ["R2"],
          with: { kind: "rule", text: "Use spaces" },
        },
      ],
      { origin: "user", entryId: "e2" },
    );
  })();

  it("round-trips through plain JSON", () => {
    const stored = JSON.parse(
      JSON.stringify({ continuity: serializeLedger(rich) }),
    );
    assert.deepEqual(parseLedger(stored.continuity), rich);
  });

  const garbage: [string, unknown, ContinuityErrorCode][] = [
    ["undefined", undefined, "invalid_ledger"],
    ["a string", JSON.stringify(rich), "invalid_ledger"],
    ["an array", [], "invalid_ledger"],
    ["an empty object", {}, "unsupported_version"],
    ["version 2", { ...rich, version: 2 }, "unsupported_version"],
    ["missing items", { version: 1, rev: 0, nextId: 1 }, "invalid_ledger"],
    ["a negative rev", { ...rich, rev: -1 }, "invalid_ledger"],
    ["an unknown field", { ...rich, extra: true }, "invalid_ledger"],
    [
      "a stray item field",
      {
        ...rich,
        items: [{ ...rich.items[0], note: "x" }, ...rich.items.slice(1)],
      },
      "invalid_ledger",
    ],
    ["an id at nextId", { ...rich, nextId: 2 }, "invalid_ledger"],
    [
      "a kind/id mismatch",
      {
        ...rich,
        items: [{ ...rich.items[0], id: "R1" }, ...rich.items.slice(1)],
      },
      "invalid_ledger",
    ],
    [
      "duplicate ids",
      { ...rich, items: [rich.items[0], rich.items[0]] },
      "invalid_ledger",
    ],
    [
      "a one-way lineage",
      {
        ...rich,
        items: rich.items.map((i) =>
          i.id === "R2"
            ? { ...i, supersededBy: undefined, status: "active" }
            : i,
        ),
      },
      "invalid_ledger",
    ],
    [
      "an unknown status",
      {
        ...rich,
        items: [{ ...rich.items[0], status: "gone" }, ...rich.items.slice(1)],
      },
      "invalid_ledger",
    ],
    [
      "steering without scope",
      {
        ...rich,
        items: rich.items.map((i) => {
          const { scopeAnchor: _s, ...rest } = i;
          return i.kind === "steering" ? rest : i;
        }),
      },
      "invalid_ledger",
    ],
    [
      "too many items",
      {
        ...rich,
        items: Array.from(
          { length: MAX_LEDGER_ITEMS + 1 },
          () => rich.items[0],
        ),
      },
      "invalid_ledger",
    ],
  ];
  for (const [name, value, code] of garbage) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseLedger(value), rejectedWith(code));
    });
  }
});
