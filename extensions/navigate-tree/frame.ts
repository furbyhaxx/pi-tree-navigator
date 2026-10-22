/**
 * Editor-replacing list panel shared by every `/anchor` screen.
 *
 * Ported from pi-bolt-subagents' `FrameList`, extended with a fuzzy search
 * row, a right-hand badge in the top rule and a per-row detail line. The
 * pure `measureFrame` / `renderFrame` pair draws; `FrameList` owns input.
 */
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  decodeKittyPrintable,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  type Keybinding,
  type KeybindingsManager,
  type KeyId,
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Semantic theme subset the frame draws with. */
export type FrameTheme = Pick<Theme, "fg" | "bold" | "italic">;

/** Theme colour tokens a row value may use. */
export type FrameTone =
  | "text"
  | "muted"
  | "dim"
  | "accent"
  | "success"
  | "warning"
  | "error";

/** One list entry. Every string is untrusted text; the frame styles it. */
export interface FrameRow {
  label: string;
  /** Dim suffix after the label, e.g. `(auto)`. */
  labelHint?: string;
  /** Right column, aligned across the whole unfiltered list. */
  value?: string;
  /** Colour of `value`. */
  tone?: FrameTone;
  /** One line shown under the row while it is selected. */
  detail?: string;
  /** Help shown in the description slot while the row is selected. */
  description?: string;
}

/** Hint-bar survival order on narrow terminals: essential hints are dropped last. */
export type FrameKeybindingPriority = "essential" | "navigation" | "optional";

/** Visible key/action pair in the hint bar. */
export interface FrameKeybinding {
  key: string;
  action: string;
  /** Default `optional`. */
  priority?: FrameKeybindingPriority;
}

/** Frozen geometry; measured on open and again only when the terminal resizes. */
export interface FrameLayout {
  width: number;
  terminalRows: number;
  height: number;
  descriptionRows: number;
  listRows: number;
  valueColumn: number;
}

/** Inputs to the pure renderer. `rows` is always the full, unfiltered list. */
export interface FrameOptions {
  width: number;
  terminalRows: number;
  breadcrumbs: readonly string[];
  /** Muted badge right-aligned in the top rule. */
  rightBadge?: string;
  rows: readonly FrameRow[];
  /** Indices into `rows` that pass the filter, in display order; all rows when omitted. */
  visible?: readonly number[];
  query?: string;
  placeholder?: string;
  /** Pre-rendered search input (with its cursor); replaces the query/placeholder text. */
  searchInput?: string;
  /** Position within `visible`. */
  cursor: number;
  /** First visible position within `visible`. */
  scrollOffset: number;
  keybindings: readonly FrameKeybinding[];
  theme: FrameTheme;
  layout?: FrameLayout;
}

const CURSOR_PREFIX = 3;
const DETAIL_INDENT = "      ";
const CHROME_ROWS = 5;
const MIN_HEIGHT = 10;
const MAX_DESCRIPTION_ROWS = 2;
const DEFAULT_PLACEHOLDER = "Type to search…";
const HINT_ORDER: readonly FrameKeybindingPriority[] = [
  "essential",
  "navigation",
  "optional",
];
const HINT_SEPARATOR = "  ";

function isControl(code: number): boolean {
  return (
    code <= 0x08 ||
    (code >= 0x0b && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xfff9 && code <= 0xfffb)
  );
}

/** Strip terminal escape sequences and control characters; tab and newline survive. */
export function sanitizeTerminalText(text: string): string {
  let clean = "";
  for (const char of stripTerminalSequences(text)) {
    if (!isControl(char.codePointAt(0) ?? 0)) clean += char;
  }
  return clean;
}

function singleLine(text: string): string {
  return sanitizeTerminalText(text).replace(/[\n\t]/g, " ");
}

function labelText(row: FrameRow, theme: FrameTheme): string {
  const hint = row.labelHint
    ? ` ${theme.fg("dim", singleLine(row.labelHint))}`
    : "";
  return singleLine(row.label) + hint;
}

function computeValueColumn(
  rows: readonly FrameRow[],
  width: number,
  theme: FrameTheme,
): number {
  const longest = rows.reduce(
    (max, row) => Math.max(max, visibleWidth(labelText(row, theme))),
    0,
  );
  return Math.min(
    width,
    CURSOR_PREFIX + Math.min(longest, Math.floor(width * 0.45)) + 2,
  );
}

function descriptionLines(row: FrameRow | undefined, width: number): string[] {
  if (!row?.description) return [];
  const text = sanitizeTerminalText(row.description).replace(/\t/g, "    ");
  return wrapTextWithAnsi(text, Math.max(1, width - CURSOR_PREFIX)).map(
    (line) => " ".repeat(CURSOR_PREFIX) + line,
  );
}

function rowLines(
  row: FrameRow,
  selected: boolean,
  width: number,
  column: number,
  theme: FrameTheme,
): string[] {
  const label = labelText(row, theme);
  let main = label;
  if (row.value !== undefined) {
    const clipped = truncateToWidth(
      label,
      Math.max(0, column - CURSOR_PREFIX - 2),
      "…",
    );
    const gap = " ".repeat(
      Math.max(0, column - CURSOR_PREFIX - visibleWidth(clipped)),
    );
    main = clipped + gap + theme.fg(row.tone ?? "text", singleLine(row.value));
  }
  const prefix = selected
    ? ` ${theme.fg("accent", "→")} `
    : " ".repeat(CURSOR_PREFIX);
  const lines = [truncateToWidth(prefix + main, width, "…")];
  if (selected && row.detail) {
    lines.push(
      truncateToWidth(
        `${DETAIL_INDENT}${theme.fg("dim", "↳")} ${theme.fg("muted", singleLine(row.detail))}`,
        width,
        "…",
      ),
    );
  }
  return lines;
}

/** Height is reserved for the tallest description and one detail line, so filtering never resizes the frame. */
export function measureFrame(options: FrameOptions): FrameLayout {
  const width = Math.max(0, Math.floor(options.width));
  const cap = Math.max(MIN_HEIGHT, Math.floor(options.terminalRows / 2));
  const maxDescription = options.rows.reduce(
    (max, row) => Math.max(max, descriptionLines(row, width).length),
    0,
  );
  const descriptionRows = Math.min(maxDescription, MAX_DESCRIPTION_ROWS);
  const detailRows = options.rows.some((row) => row.detail) ? 1 : 0;
  const chrome = CHROME_ROWS + (descriptionRows > 0 ? 1 + descriptionRows : 0);
  const height = Math.min(
    cap,
    chrome + Math.max(1, options.rows.length + detailRows),
  );
  return {
    width,
    terminalRows: options.terminalRows,
    height,
    descriptionRows,
    listRows: height - chrome,
    valueColumn: computeValueColumn(options.rows, width, options.theme),
  };
}

function breadcrumbText(
  segments: readonly string[],
  budget: number,
  theme: FrameTheme,
): string {
  if (!segments.length || budget <= 0) return "";
  const current = theme.bold(singleLine(segments[segments.length - 1]));
  const parents = segments.slice(0, -1).map(singleLine).join("/");
  if (!parents) return truncateToWidth(current, budget, "…");
  const remaining = budget - visibleWidth(current) - 1;
  if (remaining < 2) return truncateToWidth(current, budget, "…");
  const prefix =
    visibleWidth(parents) <= remaining
      ? parents
      : `…${sliceByColumn(parents, visibleWidth(parents) - remaining + 1, remaining - 1)}`;
  return `${theme.fg("muted", prefix)}/${current}`;
}

function topRule(
  width: number,
  hidden: number,
  breadcrumbs: readonly string[],
  badge: string | undefined,
  theme: FrameTheme,
): string {
  const rule = (count: number) =>
    theme.fg("borderAccent", "─".repeat(Math.max(0, count)));
  const indicator =
    hidden > 0 ? truncateToWidth(` ↑ ${hidden} more `, width, "") : "";
  const indicatorWidth = visibleWidth(indicator);
  const indicatorStart = indicator
    ? Math.floor((width - indicatorWidth) / 2)
    : width;
  const indicatorEnd = indicator ? indicatorStart + indicatorWidth : 0;

  // The badge sits right of the indicator, keeping one rule cell on each side of it.
  const badgeRoom = Math.min(
    Math.max(0, width - indicatorEnd - 4),
    Math.floor(width * 0.6),
  );
  const badgeText =
    badge && badgeRoom >= 3
      ? truncateToWidth(singleLine(badge), badgeRoom, "…")
      : "";
  const rightWidth = badgeText ? visibleWidth(badgeText) + 3 : 0;

  const leftBudget = (indicator ? indicatorStart : width - rightWidth) - 3;
  const title = breadcrumbText(breadcrumbs, leftBudget, theme);
  const left = title ? `${theme.fg("borderAccent", "─ ")}${title} ` : "";
  const leftWidth = visibleWidth(left);

  let line = left;
  if (indicator) {
    line += rule(indicatorStart - leftWidth) + theme.fg("dim", indicator);
    line += rule(width - indicatorEnd - rightWidth);
  } else {
    line += rule(width - leftWidth - rightWidth);
  }
  if (badgeText) line += ` ${theme.fg("muted", badgeText)} ${rule(1)}`;
  return truncateToWidth(line, width, "");
}

function bottomRule(width: number, hidden: number, theme: FrameTheme): string {
  const indicator =
    hidden > 0 ? truncateToWidth(` ↓ ${hidden} more `, width, "") : "";
  const start = indicator
    ? Math.floor((width - visibleWidth(indicator)) / 2)
    : width;
  const rule = (count: number) =>
    theme.fg("borderAccent", "─".repeat(Math.max(0, count)));
  const line = rule(start) + theme.fg("dim", indicator);
  return line + rule(width - visibleWidth(line));
}

function searchLine(options: FrameOptions): string {
  const { theme } = options;
  let content = options.searchInput;
  if (content === undefined) {
    content = options.query
      ? singleLine(options.query)
      : theme.fg(
          "dim",
          theme.italic(singleLine(options.placeholder ?? DEFAULT_PLACEHOLDER)),
        );
  }
  return ` ${theme.fg("accent", "❯")} ${content}`;
}

/** One hint-bar line that never wraps: whole hints are dropped by priority, last first, and an ellipsis marks the loss. */
function hintLine(
  keybindings: readonly FrameKeybinding[],
  width: number,
  theme: FrameTheme,
): string {
  const hints = keybindings.map(
    ({ key, action }) =>
      `${theme.bold(singleLine(key))} ${theme.fg("dim", singleLine(action))}`,
  );
  const widths = hints.map(visibleWidth);
  const join = (shown: readonly number[]) =>
    ` ${shown.map((index) => hints[index]).join(HINT_SEPARATOR)}`;
  const all = hints.map((_, index) => index);
  const lineWidth = (shown: readonly number[]) =>
    1 +
    shown.reduce((sum, index) => sum + widths[index], 0) +
    HINT_SEPARATOR.length * Math.max(0, shown.length - 1);
  if (lineWidth(all) <= width) return join(all);

  const ellipsis = HINT_SEPARATOR.length + 1;
  const tier = (index: number) =>
    HINT_ORDER.indexOf(keybindings[index].priority ?? "optional");
  const byPriority = [...all].sort((a, b) => tier(a) - tier(b) || a - b);
  const shown: number[] = [];
  for (const index of byPriority) {
    if (shown.length > 0 && lineWidth([...shown, index]) + ellipsis > width)
      break;
    shown.push(index);
  }
  shown.sort((a, b) => a - b);
  return `${join(shown)}${HINT_SEPARATOR}${theme.fg("dim", "…")}`;
}

function frameContent(options: FrameOptions): {
  lines: string[];
  mouseRows: Map<number, number>;
} {
  const layout =
    options.layout &&
    options.layout.width === options.width &&
    options.layout.terminalRows === options.terminalRows
      ? options.layout
      : measureFrame(options);
  const { width } = layout;
  const { theme, rows } = options;
  const visible = options.visible ?? rows.map((_, index) => index);
  const start = Math.max(
    0,
    Math.min(Math.floor(options.scrollOffset), Math.max(0, visible.length - 1)),
  );

  const header = [
    topRule(width, start, options.breadcrumbs, options.rightBadge, theme),
    searchLine(options),
    "",
  ];
  const body: string[] = [];
  const mouseRows = new Map<number, number>();
  let end = start;
  while (end < visible.length && body.length < layout.listRows) {
    const selected = end === options.cursor;
    const lines = rowLines(
      rows[visible[end]],
      selected,
      width,
      layout.valueColumn,
      theme,
    );
    if (body.length > 0 && lines.length > layout.listRows - body.length) break;
    for (const line of lines.slice(0, layout.listRows - body.length)) {
      mouseRows.set(header.length + body.length, visible[end]);
      body.push(line);
    }
    end++;
  }
  if (visible.length === 0) {
    const empty =
      rows.length === 0
        ? "Nothing to show"
        : `No matches for “${singleLine(options.query ?? "")}”`;
    body.push(" ".repeat(CURSOR_PREFIX) + theme.fg("dim", theme.italic(empty)));
  }
  while (body.length < layout.listRows) body.push("");

  const lines = [...header, ...body];
  if (layout.descriptionRows > 0) {
    lines.push("");
    const selectedRow =
      visible[options.cursor] === undefined
        ? undefined
        : rows[visible[options.cursor]];
    const description = descriptionLines(selectedRow, width);
    for (let n = 0; n < layout.descriptionRows; n++) {
      let line = description[n] ?? "";
      if (
        n === layout.descriptionRows - 1 &&
        description.length > layout.descriptionRows
      ) {
        line = `${truncateToWidth(line, Math.max(0, width - 1), "")}…`;
      }
      lines.push(theme.fg("dim", line));
    }
  }
  lines.push(hintLine(options.keybindings, width, theme));
  lines.push(bottomRule(width, Math.max(0, visible.length - end), theme));
  return {
    lines: lines.map((line) => truncateToWidth(line, width, "…")),
    mouseRows,
  };
}

/** Render exactly the measured height, with every line bounded by visible columns. */
export function renderFrame(options: FrameOptions): string[] {
  return frameContent(options).lines;
}

/** Structural subset of the TUI injected by `ctx.ui.custom`. */
export interface FrameHost {
  terminal: { rows: number; columns: number };
  requestRender(): void;
}

/** Action on a row; `index` addresses the original `rows` array, not the filtered view. */
export type FrameAction = (row: FrameRow, index: number) => void;

/** A key active while the list (not the search input) has focus. */
export interface FrameShortcut {
  key: KeyId;
  priority?: FrameKeybindingPriority;
  /** Hint-bar label; a function is resolved for the selected row. */
  action: string | ((row: FrameRow, index: number) => string);
  /** Hidden and ignored on rows where this returns false. */
  enabled?: (row: FrameRow, index: number) => boolean;
  onPress: FrameAction;
}

/** Controller inputs. */
export interface FrameListOptions {
  tui: FrameHost;
  theme: FrameTheme;
  breadcrumbs: readonly string[];
  rows: readonly FrameRow[];
  rightBadge?: string;
  placeholder?: string;
  /** Hint-bar label for Enter. Default `select`. */
  enterAction?: string;
  /** Hint-bar label for Escape in list focus. Default `back`. */
  cancelAction?: string;
  keyboard?: KeybindingsManager;
  /** Initial row index. */
  cursor?: number;
  /** Restore a filter when a wrapper rebuilds the list on resize. */
  query?: string;
  onSelect?: FrameAction;
  onCancel?: () => void;
  shortcuts?: readonly FrameShortcut[];
}

function printable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  const typed = [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && !isControl(code);
  });
  return data && typed ? data : undefined;
}

/**
 * Fixed-height list with a fuzzy search row.
 *
 * Focus is `list` or `search`. In list focus the shortcuts apply, `/` opens the
 * search and any other printable key starts it. Escape clears the search and
 * returns to the list; Escape in list focus cancels.
 */
export class FrameList implements Component, Focusable {
  private readonly input = new Input({ prompt: "" });
  private query = "";
  private visible: number[];
  private position: number;
  private offset = 0;
  private width: number;
  private layout?: FrameLayout;
  private focus: "list" | "search" = "list";
  private hasFocus = false;
  private mouseRows = new Map<number, number>();

  private readonly options: FrameListOptions;

  constructor(options: FrameListOptions) {
    this.options = options;
    this.visible = options.rows.map((_, index) => index);
    this.position = Math.min(
      Math.max(0, options.cursor ?? 0),
      Math.max(0, this.visible.length - 1),
    );
    this.width = options.tui.terminal.columns;
    if (options.query) {
      this.input.handleInput(`\x1b[200~${options.query}\x1b[201~`);
      this.setQuery(options.query);
      this.enterSearch();
    }
  }

  /** Original index of the selected row, or -1 when the filter matches nothing. */
  get cursor(): number {
    return this.visible[this.position] ?? -1;
  }

  /** The active search text. */
  get search(): string {
    return this.query;
  }

  /** Propagates focus to the search input for hardware-cursor positioning. */
  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.focus === "search";
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    this.width = Math.max(0, Math.floor(width));
    this.ensureVisible();
    const { lines, mouseRows } = frameContent(this.renderOptions());
    this.mouseRows = mouseRows;
    return lines;
  }

  /** Select or activate rendered rows, focus search, or navigate with the wheel. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (
      event.x < 0 ||
      event.x >= this.width ||
      event.y < 0 ||
      event.y >= (this.layout?.height ?? 0)
    )
      return undefined;
    if (event.type === "wheel" && event.wheelDelta && this.visible.length > 0) {
      const previous = this.position;
      this.move(this.position + Math.sign(event.wheelDelta));
      return { handled: true, render: previous !== this.position };
    }
    if (
      event.button !== "left" ||
      (event.type !== "press" && event.type !== "click")
    )
      return undefined;
    const index = this.mouseRows.get(event.y);
    if (event.y !== 1 && index === undefined) return undefined;
    // Claim the press so Pi synthesizes a click without starting text selection.
    if (event.type === "press") return { handled: true, render: false };
    if (event.y === 1) {
      this.enterSearch();
    } else if (index !== undefined) {
      const position = this.visible.indexOf(index);
      if (position < 0) return undefined;
      this.focus = "list";
      this.input.focused = false;
      if (index === this.cursor)
        this.options.onSelect?.(this.options.rows[index], index);
      else this.move(position);
    }
    return { handled: true, focus: true, render: true };
  }

  handleInput(data: string): void {
    this.ensureVisible();
    if (matchesKey(data, Key.ctrl("c"))) {
      this.options.onCancel?.();
      return;
    }
    const matches = (id: Keybinding, fallback: KeyId) =>
      this.options.keyboard
        ? this.options.keyboard.matches(data, id)
        : matchesKey(data, fallback);
    const page = this.layout?.listRows ?? 1;
    const row = this.options.rows[this.cursor];

    if (matches("tui.select.up", Key.up)) this.move(this.position - 1);
    else if (matches("tui.select.down", Key.down)) this.move(this.position + 1);
    else if (matches("tui.select.pageUp", Key.pageUp))
      this.move(this.position - page);
    else if (matches("tui.select.pageDown", Key.pageDown))
      this.move(this.position + page);
    else if (matches("tui.select.confirm", Key.enter)) {
      if (row) this.options.onSelect?.(row, this.cursor);
    } else if (matches("tui.select.cancel", Key.escape)) {
      if (this.focus === "search" || this.query) this.leaveSearch();
      else this.options.onCancel?.();
    } else if (this.focus === "search") {
      this.input.handleInput(data);
      this.setQuery(this.input.getValue());
    } else if (matchesKey(data, Key.home)) this.move(0);
    else if (matchesKey(data, Key.end)) this.move(this.visible.length - 1);
    else this.handleListKey(data, row);
    this.options.tui.requestRender();
  }

  private handleListKey(data: string, row: FrameRow | undefined): void {
    const shortcut = this.options.shortcuts?.find((candidate) =>
      matchesKey(data, candidate.key),
    );
    if (shortcut) {
      if (row && (shortcut.enabled?.(row, this.cursor) ?? true))
        shortcut.onPress(row, this.cursor);
      return;
    }
    if (data === "/") {
      this.enterSearch();
      return;
    }
    if (printable(data) !== undefined) {
      this.enterSearch();
      this.input.handleInput(data);
      this.setQuery(this.input.getValue());
    }
  }

  private enterSearch(): void {
    this.focus = "search";
    this.input.focused = this.hasFocus;
  }

  private leaveSearch(): void {
    this.focus = "list";
    this.input.focused = false;
    this.input.setValue("");
    const selected = this.cursor;
    this.setQuery("");
    this.position = Math.max(0, selected);
  }

  private setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    const all = this.options.rows.map((_, index) => index);
    this.visible = query
      ? fuzzyFilter(all, query, (index) => this.searchText(index))
      : all;
    this.position = 0;
    this.offset = 0;
  }

  private searchText(index: number): string {
    const { label, labelHint, value, detail, description } =
      this.options.rows[index];
    return [label, labelHint, value, detail, description]
      .filter((part): part is string => Boolean(part))
      .map(singleLine)
      .join(" ");
  }

  private move(position: number): void {
    this.position = Math.min(
      Math.max(0, position),
      Math.max(0, this.visible.length - 1),
    );
    this.ensureVisible();
  }

  private keybindings(): FrameKeybinding[] {
    const enter = {
      key: "enter",
      action: this.options.enterAction ?? "select",
      priority: "navigation" as const,
    };
    const navigate = {
      key: "↑↓",
      action: "navigate",
      priority: "navigation" as const,
    };
    if (this.focus === "search") {
      return [
        { key: "type", action: "to filter" },
        navigate,
        enter,
        { key: "esc", action: "clear", priority: "essential" },
      ];
    }
    const row = this.options.rows[this.cursor];
    const shortcuts = row
      ? (this.options.shortcuts ?? [])
          .filter((shortcut) => shortcut.enabled?.(row, this.cursor) ?? true)
          .map(({ key, action, priority }) => ({
            key,
            priority,
            action:
              typeof action === "function" ? action(row, this.cursor) : action,
          }))
      : [];
    return [
      navigate,
      enter,
      ...shortcuts,
      { key: "/", action: "search", priority: "essential" },
      {
        key: "esc",
        action: this.query ? "clear" : (this.options.cancelAction ?? "back"),
        priority: "essential",
      },
    ];
  }

  private renderOptions(): FrameOptions {
    const searchInput =
      this.focus === "search"
        ? this.input.render(Math.max(0, this.width - 3))[0]
        : undefined;
    return {
      width: this.width,
      terminalRows: this.options.tui.terminal.rows,
      breadcrumbs: this.options.breadcrumbs,
      rightBadge: this.options.rightBadge,
      rows: this.options.rows,
      visible: this.visible,
      query: this.query,
      placeholder: this.options.placeholder,
      searchInput,
      cursor: this.position,
      scrollOffset: this.offset,
      keybindings: this.keybindings(),
      theme: this.options.theme,
      layout: this.layout,
    };
  }

  private ensureLayout(): FrameLayout {
    const rows = this.options.tui.terminal.rows;
    if (
      !this.layout ||
      this.layout.width !== this.width ||
      this.layout.terminalRows !== rows
    ) {
      this.layout = measureFrame(this.renderOptions());
    }
    return this.layout;
  }

  private ensureVisible(): void {
    const layout = this.ensureLayout();
    this.offset = Math.min(this.offset, this.position);
    const { rows, theme } = this.options;
    const heights = this.visible.map(
      (index, position) =>
        rowLines(
          rows[index],
          position === this.position,
          this.width,
          layout.valueColumn,
          theme,
        ).length,
    );
    let used = heights
      .slice(this.offset, this.position + 1)
      .reduce((sum, height) => sum + height, 0);
    while (this.offset < this.position && used > layout.listRows)
      used -= heights[this.offset++];
  }
}

/** Outcome of `selectFrame`: the chosen row's original index and the shortcut that chose it. */
export interface FrameChoice {
  index: number;
  /** Absent when chosen with Enter. */
  key?: KeyId;
}

/** Screen description for `selectFrame`. */
export interface FrameScreen {
  breadcrumbs: readonly string[];
  rows: readonly FrameRow[];
  rightBadge?: string;
  placeholder?: string;
  enterAction?: string;
  cancelAction?: string;
  cursor?: number;
  shortcuts?: readonly Pick<
    FrameShortcut,
    "key" | "action" | "enabled" | "priority"
  >[];
}

/** Show a frame in place of the editor and resolve with the user's choice, or undefined when cancelled. */
export function selectFrame(
  ctx: ExtensionCommandContext,
  screen: FrameScreen,
): Promise<FrameChoice | undefined> {
  return ctx.ui.custom<FrameChoice | undefined>(
    (tui, theme, keyboard, done) =>
      new FrameList({
        ...screen,
        tui,
        theme,
        keyboard,
        onSelect: (_row, index) => done({ index }),
        onCancel: () => done(undefined),
        shortcuts: screen.shortcuts?.map((shortcut) => ({
          ...shortcut,
          onPress: (_row, index) => done({ index, key: shortcut.key }),
        })),
      }),
  );
}
