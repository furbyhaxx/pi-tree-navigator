import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  FrameList,
  type FrameListOptions,
  type FrameOptions,
  type FrameRow,
  type FrameTheme,
  measureFrame,
  renderFrame,
  sanitizeTerminalText,
} from "./frame.ts";

const CODES: Record<string, number> = {
  text: 37,
  muted: 90,
  dim: 2,
  accent: 36,
  success: 32,
  warning: 33,
  error: 31,
  borderAccent: 34,
};
const theme: FrameTheme = {
  fg: (color, text) => `\x1b[${CODES[color] ?? 99}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
};

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);

function makeRows(count: number): FrameRow[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `row ${index + 1}`,
    value: `value ${index + 1}`,
    detail: `detail line ${index + 1}`,
    description: `Description for row ${index + 1}.`,
  }));
}

function options(
  rows: readonly FrameRow[],
  width: number,
  overrides: Partial<FrameOptions> = {},
): FrameOptions {
  return {
    width,
    terminalRows: 40,
    breadcrumbs: ["Anchor", "List"],
    rows,
    cursor: 0,
    scrollOffset: 0,
    keybindings: [
      { key: "↑↓", action: "navigate" },
      { key: "enter", action: "select" },
      { key: "esc", action: "back" },
    ],
    theme,
    ...overrides,
  };
}

function list(
  rows: readonly FrameRow[],
  extra: Partial<FrameListOptions> = {},
) {
  const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
  const events: string[] = [];
  const frame = new FrameList({
    tui,
    theme,
    breadcrumbs: ["Anchor"],
    rows,
    onSelect: (row, index) => events.push(`select:${row.label}:${index}`),
    onCancel: () => events.push("cancel"),
    ...extra,
  });
  return { frame, events, tui };
}

describe("renderFrame", () => {
  for (const width of [60, 130]) {
    it(`bounds every line to ${width} columns and renders exactly the measured height`, () => {
      const rows = makeRows(30);
      const opts = options(rows, width, {
        rightBadge: "38.4% of 372k (auto)",
        scrollOffset: 4,
        cursor: 6,
      });
      const layout = measureFrame(opts);
      const lines = renderFrame({ ...opts, layout });
      assert.equal(lines.length, layout.height);
      for (const line of lines)
        assert.ok(
          visibleWidth(line) <= width,
          `${visibleWidth(line)} > ${width}: ${line}`,
        );
      const text = plain(lines);
      assert.match(
        text[0],
        /^─ Anchor\/List ─+ ↑ 4 more ─+ 38\.4% of 372k \(auto\) ─$/,
      );
      assert.equal(visibleWidth(text[0]), width);
      assert.match(text.at(-1) ?? "", /^─+ ↓ \d+ more ─+$/);
    });
  }

  it("lays out search, rows, selected detail, description and hint bar", () => {
    const rows = makeRows(3);
    const lines = plain(renderFrame(options(rows, 60, { cursor: 1 })));
    assert.equal(lines[1], " ❯ Type to search…");
    assert.equal(lines[2], "");
    assert.match(lines[3], /^ {3}row 1 {2,}value 1$/);
    assert.match(lines[4], /^ → row 2 {2,}value 2$/);
    assert.match(lines[5], /^ {6}↳ detail line 2$/);
    assert.match(lines[6], /^ {3}row 3 {2,}value 3$/);
    assert.ok(lines.includes("   Description for row 2."));
    assert.equal(lines.at(-2), " ↑↓ navigate  enter select  esc back");
    assert.ok(!lines.some((line) => line.includes("detail line 1")));
  });

  it("aligns the value column to the full list, not the visible rows", () => {
    const rows: FrameRow[] = [
      { label: "a", value: "one" },
      { label: "a considerably longer label", value: "two" },
    ];
    const opts = options(rows, 80);
    const layout = measureFrame(opts);
    const all = plain(renderFrame({ ...opts, layout }));
    const filtered = plain(renderFrame({ ...opts, layout, visible: [0] }));
    const column = (lines: string[]) =>
      lines.find((line) => line.includes("one"))?.indexOf("one");
    assert.equal(column(all), column(filtered));
    assert.ok((column(filtered) ?? 0) > 20);
  });

  it("keeps the height when the filter leaves fewer or no rows", () => {
    const rows = makeRows(12);
    const opts = options(rows, 80);
    const layout = measureFrame(opts);
    const full = renderFrame({ ...opts, layout });
    const few = renderFrame({ ...opts, layout, visible: [3, 5], query: "row" });
    const none = renderFrame({ ...opts, layout, visible: [], query: "zzz" });
    assert.equal(few.length, full.length);
    assert.equal(none.length, full.length);
    assert.ok(
      plain(none).some((line) => line.includes("No matches for “zzz”")),
    );
    assert.ok(
      plain(renderFrame({ ...opts, rows: [], layout: undefined })).some(
        (line) => line.includes("Nothing to show"),
      ),
    );
  });

  it("shows overflow counts in both rules", () => {
    const rows = makeRows(30);
    const opts = options(rows, 80);
    const layout = measureFrame(opts);
    const top = plain(renderFrame({ ...opts, layout }));
    assert.ok(!top[0].includes("more"));
    assert.match(top.at(-1) ?? "", /↓ \d+ more/);
    const scrolled = plain(
      renderFrame({ ...opts, layout, scrollOffset: 5, cursor: 5 }),
    );
    assert.match(scrolled[0], /↑ 5 more/);
  });

  it("clips the badge and breadcrumbs instead of overflowing narrow terminals", () => {
    const opts = options(makeRows(30), 24, {
      rightBadge: "a very long context badge text",
      scrollOffset: 3,
      cursor: 3,
    });
    for (const line of renderFrame(opts))
      assert.ok(visibleWidth(line) <= 24, line);
  });

  it("styles through the theme only and strips escape sequences from row text", () => {
    const rows: FrameRow[] = [
      {
        label: "evil\x1b[31m red\x1b]0;title\x07",
        value: "v\u0000al",
        description: "x\x1b[2Jy",
      },
    ];
    const lines = renderFrame(options(rows, 60));
    const known = new Set(
      Object.values(CODES).map(String).concat(["39", "1", "22", "3", "23"]),
    );
    for (const line of lines) {
      for (const part of line.split("\x1b").slice(1)) {
        const code = /^\[(\d+)m/.exec(part)?.[1];
        assert.ok(
          code !== undefined && known.has(code),
          `raw escape in ${JSON.stringify(line)}`,
        );
      }
    }
    const text = plain(lines).join("\n");
    assert.ok(text.includes("evil red"));
    assert.ok(text.includes("xy"));
    assert.equal(sanitizeTerminalText("a\tb\nc\r\u0007d"), "a\tb\ncd");
  });
});

describe("FrameList", () => {
  it("never changes height while filtering or moving the cursor", () => {
    const { frame } = list(makeRows(20));
    const heights = new Set<number>();
    const feed = (data: string) => {
      frame.handleInput(data);
      heights.add(frame.render(80).length);
    };
    heights.add(frame.render(80).length);
    for (const key of [
      "\x1b[B",
      "\x1b[B",
      "\x1b[6~",
      "/",
      "r",
      "o",
      "w",
      " ",
      "1",
      "\x1b[A",
      "z",
      "z",
      "z",
      "\x1b",
      "\x1b[B",
    ])
      feed(key);
    assert.equal(heights.size, 1);
  });

  it("filters fuzzily and reports original indices", () => {
    const rows: FrameRow[] = [
      { label: "alpha" },
      { label: "beta" },
      { label: "gamma" },
    ];
    const { frame, events } = list(rows);
    frame.render(80);
    for (const key of "gam") frame.handleInput(key);
    assert.equal(frame.search, "gam");
    frame.handleInput("\r");
    assert.deepEqual(events, ["select:gamma:2"]);
    assert.match(
      plain(frame.render(80)).join("\n"),
      /enter select {2}esc clear/,
    );
  });

  it("clears a non-empty search on the first escape and cancels on the next", () => {
    const { frame, events } = list(makeRows(5));
    frame.render(80);
    frame.handleInput("/");
    frame.handleInput("x");
    frame.handleInput("\x1b");
    assert.equal(frame.search, "");
    assert.deepEqual(events, []);
    assert.match(plain(frame.render(80))[1], /Type to search/);
    frame.handleInput("\x1b");
    assert.deepEqual(events, ["cancel"]);
  });

  it("keeps the selected row selected when the search is cleared", () => {
    const rows: FrameRow[] = [
      { label: "alpha" },
      { label: "beta" },
      { label: "gamma" },
    ];
    const { frame, events } = list(rows);
    frame.render(80);
    for (const key of "gam") frame.handleInput(key);
    frame.handleInput("\x1b");
    assert.equal(frame.cursor, 2);
    frame.handleInput("\r");
    assert.deepEqual(events, ["select:gamma:2"]);
  });

  it("does not start a search from control keys", () => {
    const { frame } = list(makeRows(3));
    frame.render(80);
    for (const key of ["\t", "\x1b[C", "\x1b[D"]) frame.handleInput(key);
    assert.match(plain(frame.render(80))[1], /Type to search/);
    assert.ok(!plain(frame.render(80)).at(-2)?.includes("to filter"));
  });

  it("cancels on ctrl+c from either focus", () => {
    const { frame, events } = list(makeRows(2));
    frame.render(80);
    frame.handleInput("\x03");
    frame.handleInput("a");
    frame.handleInput("\x03");
    assert.deepEqual(events, ["cancel", "cancel"]);
  });

  it("dispatches shortcuts only on rows where they are enabled and typing otherwise searches", () => {
    const pressed: string[] = [];
    const rows: FrameRow[] = [{ label: "anchor" }, { label: "new" }];
    const { frame } = list(rows, {
      shortcuts: [
        {
          key: "r",
          action: "fold",
          enabled: (_row, index) => index === 0,
          onPress: (row) => pressed.push(row.label),
        },
      ],
    });
    frame.render(80);
    assert.match(plain(frame.render(80)).at(-2) ?? "", /r fold/);
    frame.handleInput("r");
    frame.handleInput("\x1b[B");
    assert.ok(!(plain(frame.render(80)).at(-2) ?? "").includes("r fold"));
    frame.handleInput("r");
    assert.deepEqual(pressed, ["anchor"]);
    assert.equal(frame.search, "");
    frame.handleInput("n");
    assert.equal(frame.search, "n");
  });

  it("re-measures only when the terminal size changes", () => {
    const { frame, tui } = list(makeRows(30));
    const small = frame.render(80).length;
    tui.terminal.rows = 100;
    assert.ok(frame.render(80).length > small);
  });
});
