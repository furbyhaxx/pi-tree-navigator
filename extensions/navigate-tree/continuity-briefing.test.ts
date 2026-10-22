/**
 * Tests for the continuity ledger briefing, fold capture section and delta parsing.
 *
 * Node test runner. Run with: pnpm test
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTINUITY_DELTA_TAG,
  extractContinuityDelta,
  parseContinuityDelta,
  renderBriefing,
  renderFoldCaptureSection,
  summarizeLedgerForUi,
} from "./continuity-briefing.ts";
import {
  applyOps,
  ContinuityError,
  checkFilePointers,
  createLedger,
  type Ledger,
  type LedgerOp,
  type OpContext,
  reconcileFold,
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

function sample(): Ledger {
  let ledger = build(
    createLedger(),
    [
      { op: "add", kind: "objective", text: "Ship the parser rewrite" },
      {
        op: "add",
        kind: "rule",
        text: "Never edit the lockfile",
        quote: "don't touch\npnpm-lock",
      },
      { op: "add", kind: "rule", text: "Keep the public API stable" },
      { op: "add", kind: "decision", text: "Use a streaming parser" },
      {
        op: "add",
        kind: "sub-goal",
        text: "Port the tokenizer",
        scopeAnchor: "port",
      },
      {
        op: "add",
        kind: "steering",
        text: "Skip slow tests",
        scopeAnchor: "port",
      },
      {
        op: "add",
        kind: "steering",
        text: "Review before merge",
        scopeAnchor: "other",
      },
    ],
    USER,
  );
  ledger = build(
    ledger,
    Array.from(
      { length: 12 },
      (_, i): LedgerOp => ({
        op: "add",
        kind: "fact",
        text: `Fact number ${i} about the repository layout and tooling`,
      }),
    ),
    AGENT,
  );
  return build(
    ledger,
    [
      {
        op: "add",
        kind: "file",
        file: {
          path: "src/lex.ts",
          lines: "1-80",
          sha256: "a".repeat(64),
          why: "tokenizer entry",
        },
      },
      {
        op: "add",
        kind: "file",
        file: { path: "src/parse.ts", why: "grammar" },
      },
    ],
    USER,
  );
}

describe("renderBriefing", () => {
  it("renders sections in kind order with quotes, never superseded or archived items", () => {
    let ledger = sample();
    ledger = build(
      ledger,
      [
        { op: "archive", id: "T7" },
        {
          op: "supersede",
          ids: ["R3"],
          with: { kind: "rule", text: "Allow API breaks in v2" },
        },
      ],
      { origin: "user", entryId: "e2" },
    );
    const { text, overBudget, omitted } = renderBriefing(ledger, {
      maxTokens: 10_000,
    });
    assert.equal(overBudget, false);
    assert.deepEqual(omitted, { fact: 0, file: 0, steering: 0 });
    const lines = text.split("\n");
    assert.equal(lines[0], "[navigate_tree continuity ledger rev 4]");
    const headings = lines.filter((l) => /^[A-Z][a-z ]+:$/.test(l));
    assert.deepEqual(headings, [
      "Objective:",
      "Active goals:",
      "Binding rules:",
      "Decisions:",
      "Active steering:",
      "Facts:",
      "Files:",
    ]);
    assert.match(text, /G1 Ship the parser rewrite/);
    assert.match(
      text,
      /R2 Never edit the lockfile\n {2}> "don't touch pnpm-lock"/,
    );
    assert.match(text, /S5 \[@port\] Port the tokenizer/);
    assert.doesNotMatch(text, /Keep the public API stable|Review before merge/);
    assert.match(text, /R\d+ Allow API breaks in v2/);
  });

  it("is deterministic regardless of item order", () => {
    const ledger = sample();
    const shuffled = { ...ledger, items: [...ledger.items].reverse() };
    assert.equal(
      renderBriefing(shuffled, { maxTokens: 10_000 }).text,
      renderBriefing(ledger, { maxTokens: 10_000 }).text,
    );
  });

  it("drops facts first, oldest first, and says so", () => {
    const ledger = sample();
    const full = renderBriefing(ledger, { maxTokens: 10_000 });
    const tight = renderBriefing(ledger, {
      maxTokens: full.estimatedTokens - 40,
    });
    assert.equal(tight.overBudget, false);
    assert.ok(tight.omitted.fact > 0);
    assert.equal(tight.omitted.file, 0);
    assert.equal(tight.omitted.steering, 0);
    assert.match(tight.text, /\[omitted for budget: \d+ facts?\]/);
    assert.doesNotMatch(tight.text, /F8 Fact number 0 /);
    assert.match(tight.text, /F19 Fact number 11 /);
  });

  it("never drops objective, goals, rules or decisions, and flags overBudget", () => {
    const ledger = sample();
    const { text, overBudget, omitted } = renderBriefing(ledger, {
      maxTokens: 5,
    });
    assert.equal(overBudget, true);
    for (const id of ["G1", "R2", "R3", "D4", "S5"]) {
      assert.match(text, new RegExp(`\\b${id}\\b`));
    }
    assert.equal(omitted.fact, 12);
    assert.equal(omitted.file, 2);
    assert.equal(omitted.steering, 2);
    assert.match(
      text,
      /\[omitted for budget: 12 facts, 2 file pointers, 2 steering\]/,
    );
  });

  it("shows stale file pointers marked and never drops them", () => {
    const stale = checkFilePointers(sample(), () => "f".repeat(64)).ledger;
    const { text, omitted } = renderBriefing(stale, { maxTokens: 5 });
    assert.match(text, /P\d+ src\/lex\.ts:1-80 — tokenizer entry \[STALE: /);
    assert.equal(omitted.file, 1);
    assert.doesNotMatch(text, /src\/parse\.ts/);
  });

  it("labels rules the user did not author", () => {
    const ledger = build(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Prefer small commits" }],
      AGENT,
    );
    assert.match(
      renderBriefing(ledger, { maxTokens: 1000 }).text,
      /R1 \[agent\] Prefer small commits/,
    );
  });
});

describe("renderFoldCaptureSection", () => {
  it("lists rules, decisions and the folded anchor's steering, and documents a parseable schema", () => {
    const section = renderFoldCaptureSection(sample(), "port");
    assert.match(section, /Binding rules:/);
    assert.match(section, /R3 Keep the public API stable/);
    assert.match(section, /D4 Use a streaming parser/);
    assert.match(
      section,
      /Steering scoped to port[^\n]*:\nT6 \[@port\] Skip slow tests/,
    );
    assert.doesNotMatch(section, /Review before merge/);
    assert.doesNotMatch(section, /Fact number/);
    const delta = parseContinuityDelta(section);
    assert.deepEqual(delta?.completed, ["S2"]);
    assert.equal(delta?.superseded?.[0]?.ids[0], "R3");
    const applied = reconcileFold(createLedger(), delta ?? {}, {
      anchorName: "port",
      origin: "agent",
    }).applied;
    assert.deepEqual(
      applied.map((a) => [a.effect, a.item.kind]),
      [["added", "decision"]],
    );
  });
});

describe("parseContinuityDelta", () => {
  const block = (body: string) =>
    `<${CONTINUITY_DELTA_TAG}>${body}</${CONTINUITY_DELTA_TAG}>`;
  const malformed = (e: unknown) =>
    e instanceof ContinuityError && e.code === "invalid_delta";

  it("returns undefined without a block", () => {
    assert.equal(
      parseContinuityDelta("## Goal\nDone. No ledger changes."),
      undefined,
    );
  });

  it("ignores prose around the block and accepts a fenced body", () => {
    const text = `## Summary\nWe ported the lexer {not json}.\n\n${block('\n```json\n{"completed":["S2"],"expiredSteering":["T6"],"ratified":[{"kind":"fact","text":"Lexer is table driven"}]}\n```\n')}\n\nNext: parser. [1] done`;
    assert.deepEqual(parseContinuityDelta(text), {
      completed: ["S2"],
      expiredSteering: ["T6"],
      ratified: [{ kind: "fact", text: "Lexer is table driven" }],
    });
    assert.deepEqual(parseContinuityDelta(block("{}")), {});
  });

  const bad: [string, string][] = [
    ["invalid JSON", block('{"completed": ["S2",]}')],
    ["a non-object body", block('["S2"]')],
    ["an unclosed tag", `text <${CONTINUITY_DELTA_TAG}>{"completed":[]}`],
    ["two blocks", block("{}") + block("{}")],
    ["an unknown key", block('{"remove":["R1"]}')],
    ["a bad id list", block('{"completed":"S2"}')],
    ["an unknown kind", block('{"ratified":[{"kind":"wish","text":"x"}]}')],
    ["a missing superseding item", block('{"superseded":[{"ids":["R1"]}]}')],
  ];
  for (const [name, text] of bad) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseContinuityDelta(text), malformed);
    });
  }
});

describe("summarizeLedgerForUi", () => {
  it("counts active items into a one-line badge", () => {
    const ledger = build(
      createLedger(),
      [
        { op: "add", kind: "objective", text: "Ship it" },
        { op: "add", kind: "rule", text: "Rule one" },
        { op: "add", kind: "rule", text: "Rule two" },
        { op: "add", kind: "rule", text: "Rule three" },
        { op: "add", kind: "rule", text: "Rule four" },
        { op: "add", kind: "sub-goal", text: "Task one" },
        { op: "add", kind: "sub-goal", text: "Task two" },
        { op: "add", kind: "sub-goal", text: "Task three" },
      ],
      USER,
    );
    const done = build(ledger, [{ op: "complete", id: "S8" }], USER);
    const summary = summarizeLedgerForUi(done);
    assert.equal(summary.line, "1 goal · 4 rules · 2 tasks · rev 2");
    assert.equal(summarizeLedgerForUi(createLedger()).line, "empty · rev 0");
  });
});

describe("extractContinuityDelta", () => {
  const block = `<${CONTINUITY_DELTA_TAG}>{"completed":["S1"]}</${CONTINUITY_DELTA_TAG}>`;

  it("strips a complete block and returns the parsed delta", () => {
    const out = extractContinuityDelta(`## Goal\nDone.\n\n${block}\n`);
    assert.deepEqual(out.delta?.completed, ["S1"]);
    assert.equal(out.text, "## Goal\nDone.");
    assert.equal(out.error, undefined);
  });

  it("ignores a stray unclosed tag in prose instead of throwing", () => {
    const text = `Mentioned <${CONTINUITY_DELTA_TAG}> in prose only.`;
    assert.deepEqual(extractContinuityDelta(text), { text });
  });

  it("reports malformed JSON, strips the block and applies nothing", () => {
    const out = extractContinuityDelta(
      `Summary\n<${CONTINUITY_DELTA_TAG}>{nope</${CONTINUITY_DELTA_TAG}>`,
    );
    assert.equal(out.delta, undefined);
    assert.ok(out.error instanceof ContinuityError);
    assert.equal(out.text, "Summary");
  });

  it("keeps the text intact and reports an error when the block count is ambiguous", () => {
    const text = `${block}\n${block}`;
    const out = extractContinuityDelta(text);
    assert.equal(out.text, text);
    assert.ok(out.error instanceof ContinuityError);
  });
});

describe("renderFoldCaptureSection user entry refs", () => {
  it("lists citable user entry ids, newest last, capped", () => {
    const refs = Array.from({ length: 60 }, (_, n) => ({
      id: `u${n}`,
      preview: `message ${n}`,
    }));
    const text = renderFoldCaptureSection(createLedger(), "impl", refs);
    assert.match(text, /citedEntryId when one of them changed/);
    assert.match(text, /- u59: message 59/);
    assert.doesNotMatch(text, /- u0: /);
  });
});
