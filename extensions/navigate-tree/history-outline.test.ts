import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildHistoryOutline,
  registerHistoryOutline,
} from "./history-outline.ts";

function fixture() {
  const sm = SessionManager.inMemory();
  const a = sm.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const b = sm.appendMessage({ role: "user", content: "needle", timestamp: 2 });
  const c = sm.appendMessage({ role: "user", content: "last", timestamp: 3 });
  const parent = sm.appendCustomEntry("tree-phase", {
    name: "parent",
    title: "Parent",
    state: "open",
  });
  const child = sm.appendCustomEntry("tree-phase", {
    name: "child",
    title: "Child",
    state: "open",
  });
  const folded = sm.appendCustomEntry("tree-phase", {
    name: "folded",
    title: "Folded",
    state: "folded",
  });
  const summary = sm.branchWithSummary(folded, "report");
  const history = {
    version: 1,
    sourceOrder: [a, b, c],
    groups: [
      {
        name: "parent",
        title: "Parent",
        entryId: parent,
        startId: parent,
        state: "open",
        sourceIds: [a, b],
        children: [
          {
            name: "child",
            title: "Child",
            entryId: child,
            startId: child,
            state: "open",
            sourceIds: [b],
            children: [],
          },
        ],
      },
      {
        name: "folded",
        title: "Folded",
        entryId: summary,
        startId: folded,
        state: "folded",
        sourceIds: [c],
        children: [],
      },
    ],
  };
  sm.appendCustomEntry("tree-clone-provenance", { history });
  const tail = sm.appendMessage({
    role: "user",
    content: "tail",
    timestamp: 4,
  });
  return { sm, a, b, c, parent, child, summary, tail, history };
}

test("chronology preserves nested single children, unique originals, open current tail and search paths", () => {
  const f = fixture();
  const outline = buildHistoryOutline(f.sm.getEntries(), f.tail);
  assert.ok(outline);
  assert.deepEqual(
    outline.rows.map((r) => r.id),
    [f.parent, f.a, f.child, f.b, f.summary, f.tail],
  );
  assert.equal(outline.rows.find((r) => r.id === f.child)?.depth, 1);
  assert.equal(outline.rows.find((r) => r.id === f.tail)?.depth, 2);
  assert.deepEqual(
    outline.rows.filter((r) => r.current).map((r) => r.id),
    [f.child, f.tail],
  );
  const expanded = new Set([f.parent, f.child, f.summary]);
  const all = buildHistoryOutline(f.sm.getEntries(), f.tail, expanded);
  assert.equal(new Set(all?.rows.map((r) => r.id)).size, all?.rows.length);
  for (const id of [f.a, f.b, f.c])
    assert.equal(all?.rows.filter((r) => r.id === id).length, 1);
  assert.deepEqual(
    buildHistoryOutline(
      f.sm.getEntries(),
      f.tail,
      new Set(),
      "needle",
    )?.rows.map((r) => r.id),
    [f.parent, f.child, f.b],
  );
  assert.deepEqual(
    buildHistoryOutline(f.sm.getEntries(), f.tail, new Set())?.rows.map(
      (r) => r.id,
    ),
    [f.parent, f.summary],
  );
});

test("invalid manifests fall back", () => {
  const f = fixture();
  assert.equal(buildHistoryOutline([], null), undefined);
  for (const groups of [
    null,
    [null],
    [{ ...f.history.groups[0], entryId: f.a }],
    [{ ...f.history.groups[0], sourceIds: [f.b, f.a] }],
  ]) {
    const bad = fixture();
    bad.sm.appendCustomEntry("tree-clone-provenance", {
      history: { ...bad.history, groups },
    });
    assert.equal(buildHistoryOutline(bad.sm.getEntries(), bad.tail), undefined);
  }
  f.sm.appendCustomEntry("tree-clone-provenance", {
    history: { ...f.history, sourceOrder: [f.a, f.a] },
  });
  assert.equal(buildHistoryOutline(f.sm.getEntries(), f.tail), undefined);
});

test("native patch navigates real IDs, supports raw escape and session replacement, restores own methods", async () => {
  const base = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { TreeSelectorComponent } = await import(
    new URL("./modes/interactive/components/tree-selector.js", base).href
  );
  const { initTheme } = await import(
    new URL("./modes/interactive/theme/theme.js", base).href
  );
  initTheme();
  const { theme } = await import(
    new URL("./modes/interactive/theme/theme.js", base).href
  );
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  registerHistoryOutline({
    on: (name: string, handler: (...args: unknown[]) => Promise<void>) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const f = fixture();
  const ctx = (sm: SessionManager) =>
    ({
      hasUI: true,
      mode: "tui",
      sessionManager: sm,
      ui: { theme },
    }) as unknown as ExtensionContext;
  const original = TreeSelectorComponent.prototype.render;
  await handlers.get("session_start")?.({}, ctx(f.sm));
  const selected: string[] = [];
  let cancelled = false;
  const selector = new TreeSelectorComponent(
    f.sm.getTree(),
    f.tail,
    40,
    (id: string) => selected.push(id),
    () => {
      cancelled = true;
    },
  );
  for (const width of [60, 130]) {
    const lines = selector.render(width);
    assert.ok(lines.some((l: string) => l.includes("chronological")));
    assert.ok(lines.every((l: string) => visibleWidth(l) <= width));
  }
  selector.handleInput("r");
  assert.deepEqual(selected, [f.child]);
  selector.handleInput("/");
  selector.handleInput("needle");
  selector.handleInput("\r");
  selector.handleInput("\u001b[B");
  selector.handleInput("\u001b[B");
  selector.handleInput("\r");
  assert.equal(selected.at(-1), f.b);
  selector.handleInput("\u001b");
  selector.handleInput("/");
  selector.handleInput("Folded");
  selector.handleInput("\r");
  selector.handleInput("r");
  assert.equal(selected.at(-1), f.summary);
  selector.handleInput("\r");
  selector.handleInput("\u001b");
  selector.handleInput("\u001bOQ");
  assert.ok(
    !selector.render(60).some((l: string) => l.includes("chronological")),
  );
  selector.handleInput("\u001bOQ");
  assert.ok(
    selector.render(60).some((l: string) => l.includes("chronological")),
  );
  selector.handleInput("\u001b");
  assert.equal(cancelled, true);
  const other = SessionManager.inMemory();
  other.appendMessage({ role: "user", content: "other", timestamp: 1 });
  await handlers.get("session_start")?.({}, ctx(other));
  assert.ok(
    !selector.render(60).some((l: string) => l.includes("chronological")),
  );
  await handlers.get("session_shutdown")?.({});
  assert.equal(TreeSelectorComponent.prototype.render, original);
  await handlers.get("session_start")?.({}, ctx(f.sm));
  const foreign = () => ["foreign"];
  TreeSelectorComponent.prototype.render = foreign;
  await handlers.get("session_shutdown")?.({});
  assert.equal(TreeSelectorComponent.prototype.render, foreign);
  TreeSelectorComponent.prototype.render = original;
});
