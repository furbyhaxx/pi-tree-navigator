/**
 * Tests for `/anchor current`: row building and the edit flows.
 *
 * Node test runner. Flows run against a real in-memory `SessionManager`, so a
 * write is judged by replaying the branch, like the live extension does.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  applyOps,
  ContinuityError,
  createLedger,
  type Ledger,
  type LedgerOp,
} from "./continuity-ledger.ts";
import {
  CONTINUITY_OPS_CUSTOM_TYPE,
  readBranchLedger,
  type StoredOp,
} from "./continuity-store.ts";
import {
  briefingText,
  type CurrentScreenDeps,
  createUserOpsWriter,
  currentBadge,
  currentItems,
  currentRows,
  LEDGER_BUSY_NOTICE,
  openCurrentScreen,
  type UserOpsResult,
} from "./current-screen.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const WORDS = "From now on always answer in German";

const sampleLedger = (): Ledger => {
  const as = (origin: "user" | "agent" | "pin" | "classifier") => ({ origin });
  const step = (
    ledger: Ledger,
    ops: LedgerOp[],
    origin: Parameters<typeof as>[0],
  ) => applyOps(ledger, ops, as(origin)).ledger;
  let ledger = step(
    createLedger(),
    [{ op: "add", kind: "objective", text: "Ship the continuity screen" }],
    "user",
  );
  ledger = step(
    ledger,
    [
      { op: "add", kind: "fact", text: "The index lives in SQLite" },
      { op: "add", kind: "decision", text: "Use SQLite for the index" },
      {
        op: "add",
        kind: "sub-goal",
        text: "Write the tests",
        scopeAnchor: "impl",
      },
      {
        op: "add",
        kind: "file",
        file: { path: "src/db.ts", lines: "10-40", why: "schema of the index" },
      },
    ],
    "agent",
  );
  ledger = step(
    ledger,
    [
      {
        op: "add",
        kind: "rule",
        text: WORDS,
        quote: "ok, from now on: answer in German please",
      },
      { op: "add", kind: "rule", text: "Never edit the lockfile" },
      {
        op: "add",
        kind: "steering",
        text: "Keep it short",
        scopeAnchor: "impl",
      },
    ],
    "user",
  );
  ledger = step(
    ledger,
    [{ op: "add", kind: "rule", text: "Prefer tabs" }],
    "classifier",
  );
  ledger = step(
    ledger,
    [
      { op: "pin", id: "R9" },
      { op: "markStale", id: "P5" },
    ],
    "user",
  );
  ledger = step(ledger, [{ op: "archive", id: "T8" }], "user");
  return ledger;
};

describe("current screen rows", () => {
  it("orders live items by kind then id and marks origin, pin and staleness", () => {
    const ledger = sampleLedger();
    const items = currentItems(ledger, false);
    assert.deepEqual(
      items.map(({ id }) => id),
      ["G1", "R6", "R7", "R9", "D3", "S4", "F2", "P5"],
    );
    const rows = currentRows(items);
    const byId = (id: string) =>
      rows[items.findIndex((item) => item.id === id)];
    assert.equal(byId("G1").label, "G1 Ship the continuity screen");
    assert.equal(byId("G1").value, "user");
    assert.equal(byId("R6").value, "user");
    assert.equal(byId("R7").value, "user");
    assert.equal(byId("R9").value, "classifier · pinned");
    assert.equal(byId("D3").value, "agent");
    assert.equal(byId("S4").value, "agent · @impl");
    assert.equal(byId("P5").label, "P5 src/db.ts:10-40");
    assert.equal(byId("P5").value, "agent · stale");
    assert.equal(byId("P5").detail, "why: schema of the index");
    assert.equal(
      byId("R6").detail,
      "said “ok, from now on: answer in German please”",
    );
    assert.equal(byId("R7").detail, undefined);
    assert.match(
      byId("R6").description ?? "",
      /Protected: the agent cannot change it/,
    );
    assert.match(byId("D3").description ?? "", /The agent can still change it/);
    assert.match(byId("S4").description ?? "", /c marks it done/);
    assert.ok(!(byId("R6").description ?? "").includes("c marks"));
  });

  it("appends superseded and archived items as read-only history on request", () => {
    const ledger = sampleLedger();
    const items = currentItems(ledger, true);
    assert.deepEqual(items.at(-1)?.id, "T8");
    const row = currentRows(items).at(-1);
    assert.equal(row?.value, "history · archived · user · @impl");
    assert.match(row?.description ?? "", /read-only/);
  });

  it("shows one muted row for an empty ledger and a badge that leads with the revision", () => {
    const rows = currentRows([]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tone, "muted");
    assert.equal(
      rows[0].labelHint,
      'No continuity items yet. Say "from now on …" or press a to add one.',
    );
    assert.equal(currentBadge(createLedger(), false), "rev 0 · empty");
    assert.equal(
      currentBadge(sampleLedger(), true),
      "rev 6 · 1 goal · 3 rules · 1 task · 1 decision · 1 stale · +history",
    );
  });
});

interface Answers {
  confirms?: boolean[];
  inputs?: (string | undefined)[];
  editors?: (string | undefined)[];
  selects?: (string | undefined)[];
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

function harness(answers: Answers = {}, seed = true) {
  const sm = SessionManager.inMemory("/tmp");
  const pi = {
    appendEntry: (customType: string, data?: unknown) =>
      sm.appendCustomEntry(customType, data),
  } as Pick<ExtensionAPI, "appendEntry">;
  const state = { idle: true, capture: true };
  if (seed) {
    const u1 = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: WORDS }],
      timestamp: Date.now(),
    } as never);
    const stored = (
      op: LedgerOp,
      origin: "user" | "agent",
      entryId?: string,
    ): StoredOp => ({
      op,
      ctx: { origin, ...(entryId !== undefined && { entryId }) },
    });
    sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, {
      ops: [
        stored(
          { op: "add", kind: "rule", text: WORDS, quote: WORDS },
          "user",
          u1,
        ),
        stored(
          { op: "add", kind: "decision", text: "Use SQLite for the index" },
          "agent",
        ),
        stored(
          { op: "add", kind: "sub-goal", text: "Write the tests" },
          "agent",
        ),
      ],
    });
  }
  const notifications: { message: string; type?: string }[] = [];
  const dialogs = {
    confirm: [] as [string, string][],
    editor: [] as [string, string | undefined][],
    select: [] as string[][],
  };
  const confirms = [...(answers.confirms ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const editors = [...(answers.editors ?? [])];
  const selects = [...(answers.selects ?? [])];
  const rendered: string[][] = [];
  const scripts: Script[] = [];
  const theme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
  };
  const ctx = {
    hasUI: true,
    isIdle: () => state.idle,
    sessionManager: sm,
    ui: {
      notify: (message: string, type?: string) =>
        void notifications.push({ message, type }),
      async confirm(title: string, message: string) {
        dialogs.confirm.push([title, message]);
        return confirms.shift() ?? false;
      },
      async input() {
        return inputs.shift();
      },
      async editor(title: string, prefill?: string) {
        dialogs.editor.push([title, prefill]);
        return editors.shift();
      },
      async select(_title: string, options: string[]) {
        dialogs.select.push(options);
        return selects.shift();
      },
      custom(
        factory: (...args: unknown[]) => {
          handleInput(d: string): void;
          render(w: number): string[];
        },
      ) {
        const script = scripts.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve) => {
          const tui = {
            terminal: { rows: 40, columns: 80 },
            requestRender() {},
          };
          const screen = factory(tui, theme, undefined, resolve);
          const lines = screen.render(80);
          rendered.push(lines);
          script(screen, lines);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const deps: CurrentScreenDeps = {
    readLedger: (c) => readBranchLedger(c.sessionManager.getBranch()).ledger,
    applyUserOps: createUserOpsWriter(pi, () => state.capture),
  };
  const opsEntries = (): SessionEntry[] =>
    sm
      .getEntries()
      .filter(
        (e) =>
          e.type === "custom" && e.customType === CONTINUITY_OPS_CUSTOM_TYPE,
      );
  return {
    sm,
    ctx,
    deps,
    state,
    notifications,
    dialogs,
    rendered,
    opsEntries,
    ledger: () => readBranchLedger(sm.getBranch()).ledger,
    item: (id: string) =>
      readBranchLedger(sm.getBranch()).ledger.items.find((i) => i.id === id),
    run: (...screens: Script[]) => {
      scripts.push(...screens);
      return openCurrentScreen(ctx, deps);
    },
  };
}

const lastOps = (h: ReturnType<typeof harness>) =>
  (h.opsEntries().at(-1) as { data: { ops: StoredOp[] } }).data.ops;

describe("current screen writes", () => {
  it("retracts a captured rule after naming it in a confirmation and keeps it in history", async () => {
    const h = harness({ confirms: [true] });
    const before = h.opsEntries().length;
    await h.run(press("x"), press(ESC));
    assert.equal(h.opsEntries().length, before + 1);
    assert.deepEqual(lastOps(h), [
      { op: { op: "archive", id: "R1" }, ctx: { origin: "user" } },
    ]);
    assert.equal(h.item("R1")?.status, "archived");
    const [title, message] = h.dialogs.confirm[0];
    assert.match(title, /R1/);
    assert.match(title, /rule/);
    assert.match(message, /From now on always answer in German/);
    assert.match(message, /stays in the session history/);
    assert.ok(!h.rendered[1].join("\n").includes("R1 From now on"));
    assert.deepEqual(
      h.notifications.map(({ type }) => type),
      ["info"],
    );
  });

  it("writes nothing when the confirmation is declined", async () => {
    const h = harness({ confirms: [false] });
    const before = h.sm.getEntries().length;
    await h.run(press("x"), press(ESC));
    assert.equal(h.sm.getEntries().length, before);
    assert.equal(h.item("R1")?.status, "active");
    assert.deepEqual(h.notifications, []);
  });

  it("refuses writes while the agent is working, before asking anything", async () => {
    const h = harness({ confirms: [true] });
    h.state.idle = false;
    const before = h.sm.getEntries().length;
    await h.run(press("x"), press("p"), press(ESC));
    assert.equal(h.sm.getEntries().length, before);
    assert.deepEqual(h.dialogs.confirm, []);
    assert.deepEqual(h.notifications, [
      { message: LEDGER_BUSY_NOTICE, type: "warning" },
      { message: LEDGER_BUSY_NOTICE, type: "warning" },
    ]);
  });

  it("refuses a write at the moment of writing when the agent started during the confirmation", async () => {
    const h = harness();
    const writer = createUserOpsWriter(
      { appendEntry: () => assert.fail("wrote") },
      () => true,
    );
    h.state.idle = false;
    const result = writer(h.ctx, [{ op: "archive", id: "R1" }], "user");
    assert.equal(result.refused, LEDGER_BUSY_NOTICE);
    assert.equal(h.item("R1")?.status, "active");
  });

  it("refuses writes when continuity capture is off, before asking anything, but keeps browsing", async () => {
    const h = harness({ confirms: [true] });
    h.state.capture = false;
    const before = h.sm.getEntries().length;
    await h.run(press("x"), press(ESC));
    assert.equal(h.sm.getEntries().length, before);
    assert.deepEqual(h.dialogs.confirm, []);
    assert.match(h.notifications[0].message, /continuity\.capture/);
    assert.equal(h.notifications[0].type, "warning");
    assert.ok(h.rendered[0].join("\n").includes("R1 From now on"));
  });

  it("pinning keeps the agent out: the reducer still rejects its ops afterwards", async () => {
    const h = harness();
    const decision = h.item("D2");
    assert.equal(decision?.pinned, undefined);
    assert.equal(
      applyOps(h.ledger(), [{ op: "update", id: "D2", text: "Use Postgres" }], {
        origin: "agent",
      }).applied.length,
      1,
      "an unpinned agent decision is open to the agent",
    );
    await h.run(press(DOWN, "p"), press(ESC));
    assert.deepEqual(lastOps(h), [
      { op: { op: "pin", id: "D2" }, ctx: { origin: "user" } },
    ]);
    assert.equal(h.item("D2")?.pinned, true);
    for (const op of [
      { op: "archive", id: "D2" },
      { op: "update", id: "D2", text: "Use Postgres" },
      { op: "unpin", id: "D2" },
    ] as const) {
      for (const origin of ["agent", "classifier"] as const) {
        const result = applyOps(h.ledger(), [op], { origin });
        assert.equal(result.applied.length, 0, `${origin} ${op.op}`);
        assert.equal(result.rejected[0].reason.code, "protected_item");
      }
    }
    await h.run(press(DOWN, "p"), press(ESC));
    assert.equal(h.item("D2")?.pinned, undefined);
  });

  it("edits the text and leaves the user's quote untouched", async () => {
    const h = harness({ editors: ["From now on answer in French"] });
    await h.run(press("e"), press(ESC));
    assert.deepEqual(h.dialogs.editor[0][1], WORDS);
    assert.deepEqual(lastOps(h), [
      {
        op: { op: "update", id: "R1", text: "From now on answer in French" },
        ctx: { origin: "user" },
      },
    ]);
    assert.equal(h.item("R1")?.text, "From now on answer in French");
    assert.equal(h.item("R1")?.quote, WORDS);
    assert.ok(h.rendered[1].join("\n").includes(`said “${WORDS}”`));
  });

  it("ignores an unchanged or empty edit", async () => {
    const h = harness({ editors: [`  ${WORDS} `, "   "] });
    const before = h.sm.getEntries().length;
    await h.run(press("e"), press("e"), press(ESC));
    assert.equal(h.sm.getEntries().length, before);
    assert.deepEqual(h.notifications, []);
  });

  it("completes goals with c and ignores c on rules", async () => {
    const h = harness();
    const before = h.opsEntries().length;
    await h.run(press("c", DOWN, DOWN, "c"), press(ESC));
    assert.equal(h.opsEntries().length, before + 1);
    assert.deepEqual(lastOps(h), [
      { op: { op: "complete", id: "S3" }, ctx: { origin: "user" } },
    ]);
    assert.equal(h.item("R1")?.status, "active");
    assert.equal(h.item("S3")?.status, "completed");
  });

  it("adds an item as a pinned user entry and puts the cursor on it", async () => {
    const h = harness({
      selects: ["fact"],
      inputs: ["  The CI runs on Node 22  "],
    });
    await h.run(press("a"), press(ESC));
    assert.deepEqual(h.dialogs.select[0], [
      "rule",
      "decision",
      "sub-goal",
      "fact",
    ]);
    assert.deepEqual(lastOps(h), [
      {
        op: { op: "add", kind: "fact", text: "The CI runs on Node 22" },
        ctx: { origin: "pin" },
      },
    ]);
    const added = h.item("F4");
    assert.equal(added?.pinned, true);
    assert.equal(added?.source.origin, "pin");
    const selected = h.rendered[1].find((line) => line.includes("→"));
    assert.match(selected ?? "", /F4 The CI runs on Node 22/);
    assert.equal(
      applyOps(h.ledger(), [{ op: "archive", id: "F4" }], { origin: "agent" })
        .applied.length,
      0,
    );
  });

  it("adds through the last row and reports a duplicate without writing", async () => {
    const h = harness({ selects: ["rule"], inputs: [WORDS.toUpperCase()] });
    const before = h.sm.getEntries().length;
    await h.run(press(DOWN, DOWN, DOWN, ENTER), press(ESC));
    assert.equal(h.sm.getEntries().length, before);
    assert.match(
      h.notifications[0].message,
      /^R1 already holds this rule; nothing added\.$/,
    );
  });

  it("shows the reducer's reason when an op is rejected", async () => {
    const h = harness({ confirms: [true] });
    const reason = new ContinuityError(
      "not_live",
      "cannot archive R1: it is archived",
      "R1",
    );
    h.deps.applyUserOps = (): UserOpsResult => ({
      applied: [],
      rejected: [{ op: { op: "archive", id: "R1" }, reason }],
    });
    await h.run(press("x"), press(ESC));
    assert.deepEqual(h.notifications, [
      { message: "cannot archive R1: it is archived", type: "warning" },
    ]);
  });

  it("shows the full item on enter, with source entry and revisions", async () => {
    const h = harness();
    await h.run(press(ENTER), press(ESC));
    const message = h.notifications[0].message;
    const entryId = h.item("R1")?.source.entryId ?? "missing";
    assert.match(message, /^R1 rule · active · protected\n/);
    assert.ok(message.includes(`source: user (entry ${entryId})`));
    assert.ok(message.includes("created rev 1 · updated rev 1"));
    assert.ok(!message.includes("{"));
  });

  it("toggles history with h and shows retracted items read-only", async () => {
    const h = harness({ confirms: [true] });
    await h.run(press("x"), press("h"), press(DOWN, DOWN, ENTER), press(ESC));
    assert.ok(h.rendered[2].join("\n").includes("history · archived · user"));
    assert.match(h.rendered[2][0], /\+history/);
    assert.match(h.notifications.at(-1)?.message ?? "", /^R1 rule · archived/);
  });

  it("keeps every line within the width and renders an empty ledger with the add row", async () => {
    const h = harness({}, false);
    await h.run(press(ESC));
    const text = h.rendered[0].join("\n");
    assert.ok(
      text.includes(
        'No continuity items yet. Say "from now on …" or press a to add one.',
      ),
    );
    assert.ok(text.includes("+ Add an item…"));
    assert.ok(h.rendered[0][0].includes("rev 0 · empty"));
    for (const line of h.rendered[0]) assert.ok(visibleWidth(line) <= 80, line);
  });
});

describe("current screen briefing", () => {
  it("renders the briefing, or a sentence when nothing is in force", () => {
    assert.equal(briefingText(createLedger()), "No continuity items yet.");
    const text = briefingText(sampleLedger());
    assert.match(text, /^\[navigate_tree continuity ledger rev 6\]/);
    assert.ok(text.includes("R7 Never edit the lockfile"));
    assert.ok(!text.includes("T8"));
  });
});
