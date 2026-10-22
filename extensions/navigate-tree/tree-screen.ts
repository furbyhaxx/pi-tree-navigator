/**
 * `/anchor tree`: outline of the active branch, root to leaf.
 *
 * `treeItems` turns the session into rows: folded handoffs (with the archived
 * work they replaced and the handoffs they contain), anchors, user turns and
 * the current position. `openTreeScreen` drives the list and moves the session
 * leaf with `g`; nothing here ever deletes an entry.
 */
import type {
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type FrameRow,
  type FrameScreen,
  sanitizeTerminalText,
  selectFrame,
} from "./frame.ts";
import type { HandoffData } from "./handoff.ts";
import { compactCount, handoffUsage, handoffView } from "./handoff-renderer.ts";
import {
  BRANCH_LABEL_PREFIX,
  extractTextContent,
  LABEL_PREFIX,
  stripBranchSummaryBoilerplate,
  toOneLine,
} from "./helpers.ts";

type Summary = Extract<SessionEntry, { type: "branch_summary" }>;

/** An anchor on the active branch, as `AnchorCommandDeps.listAnchors` reports it. */
export interface TreeAnchor {
  name: string;
  /** Share of the context window at the anchor (0-100); 0 when the window is unknown. */
  percent: number;
  auto?: boolean;
}

/** What the screen needs besides the session; `AnchorCommandDeps` satisfies it as is. */
export interface TreeScreenDeps {
  contextBadge?(ctx: ExtensionCommandContext): string | undefined;
  listAnchors?(ctx: ExtensionCommandContext): readonly TreeAnchor[];
}

export type TreeItemKind = "handoff" | "anchor" | "user" | "archived" | "leaf";

/** One outline row with everything the list, the details and the confirm need. */
export interface TreeItem {
  kind: TreeItemKind;
  /** Entry `g` moves the session leaf to. */
  targetId: string;
  depth: number;
  /** The row of the session's current position. */
  current: boolean;
  text: string;
  /** Handoffs and anchors carry `text` in the label; the other kinds draw it dim. */
  dim: boolean;
  hint?: string;
  value?: string;
  detail?: string;
  /** Shown by Enter. */
  details: string;
  /** What `g` goes to, worded for dialogs and notices. */
  subject: string;
}

export const TREE_BUSY_NOTICE =
  "The agent is working: wait until it finishes, then move around the session.";

const MAX_INDENT_LEVELS = 3;
const MAX_NESTING = 8;
const PREVIEW_CHARS = 120;
const FIELD_CHARS = 400;
const MESSAGE_CHARS = 1500;
const SUBJECT_CHARS = 60;
const GLYPH: Record<TreeItemKind, string> = {
  handoff: "▣",
  anchor: "◆",
  user: "›",
  archived: "↳",
  leaf: "●",
};
const TIP_TYPES: ReadonlySet<SessionEntry["type"]> = new Set([
  "message",
  "custom_message",
  "branch_summary",
]);

const FILTERS = ["all", "anchors", "users"] as const;
type TreeFilter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<TreeFilter, string> = {
  all: "all rows",
  anchors: "handoffs and anchors",
  users: "user turns",
};

const oneLine = (text: string): string =>
  sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function messageText(entry: SessionEntry): string {
  if (entry.type !== "message" || !("content" in entry.message)) return "";
  return sanitizeTerminalText(extractTextContent(entry.message.content)).trim();
}

function previewOf(entry: SessionEntry): string {
  if (entry.type === "message") {
    const text = toOneLine(messageText(entry), PREVIEW_CHARS);
    if (text) return `${entry.message.role}: ${text}`;
    return entry.message.role === "assistant"
      ? "assistant (tool calls)"
      : entry.message.role;
  }
  return entry.type.replaceAll("_", " ");
}

function handoffTitle(entry: Summary, data: HandoffData | undefined): string {
  const lines = stripBranchSummaryBoilerplate(entry.summary)
    .split("\n")
    .map((line) => oneLine(line.replace(/^#+\s*/, "")));
  const title = [data?.title, ...lines]
    .map((candidate) => oneLine(candidate ?? ""))
    .find(Boolean);
  return (title ?? "Branch summary").replace(/^Work handoff:\s*/i, "");
}

function handoffDetails(
  title: string,
  entry: Summary,
  data: HandoffData | undefined,
  archivedName: string | undefined,
): string {
  const lines = [`${title} (folded)`];
  if (data) {
    lines.push(
      `Goal: ${clip(oneLine(data.goal), FIELD_CHARS)}`,
      `Outcome: ${clip(oneLine(data.outcome), FIELD_CHARS)}`,
      handoffUsage(data),
    );
    if (data.children.length)
      lines.push(`Contains ${plural(data.children.length, "nested handoff")}.`);
  } else {
    lines.push(
      clip(oneLine(stripBranchSummaryBoilerplate(entry.summary)), FIELD_CHARS),
    );
  }
  if (archivedName !== undefined)
    lines.push(
      `The full work is archived as '${archivedName}': press g on its row to open it.`,
    );
  return lines.join("\n");
}

/** The outline of the active branch, root to leaf; `anchors` supplies each anchor's share of the window. */
export function treeItems(
  sm: ExtensionCommandContext["sessionManager"],
  anchors: readonly TreeAnchor[] = [],
): TreeItem[] {
  const branch = sm.getBranch();
  const entries = sm.getEntries();
  const archivedTurns = new Map<string, string[]>();
  for (const { id } of entries) {
    const label = sm.getLabel(id);
    if (!label?.startsWith(BRANCH_LABEL_PREFIX)) continue;
    const name = label.slice(BRANCH_LABEL_PREFIX.length);
    archivedTurns.set(name, [...(archivedTurns.get(name) ?? []), id]);
  }
  const archivedTurnOf = (entry: Summary, name: string): string | undefined => {
    const holders = archivedTurns.get(name) ?? [];
    if (holders.length < 2) return holders[0];
    const fromPath = new Set(sm.getBranch(entry.fromId).map(({ id }) => id));
    return holders.find((id) => fromPath.has(id)) ?? holders.at(-1);
  };
  const items: TreeItem[] = [];

  const addHandoff = (
    entry: Summary,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): void => {
    const data = handoffView(entry, entries);
    const title = handoffTitle(entry, data);
    const own = sm.getLabel(entry.id);
    const name =
      data?.name ??
      (own?.startsWith(LABEL_PREFIX)
        ? own.slice(LABEL_PREFIX.length)
        : undefined);
    const turn = name === undefined ? undefined : archivedTurnOf(entry, name);
    const shownName = oneLine(name ?? "");
    const outcome = data ? oneLine(data.outcome) : "";
    items.push({
      kind: "handoff",
      targetId: entry.id,
      depth,
      current: false,
      text: title,
      dim: false,
      value: data
        ? `folded · ${compactCount(data.stats.input + data.stats.output + data.stats.cacheRead + data.stats.cacheWrite)} tok · ${compactCount(data.stats.messages)} msg`
        : "folded",
      ...(outcome ? { detail: `outcome: ${outcome}` } : {}),
      details: handoffDetails(
        title,
        entry,
        data,
        turn === undefined ? undefined : shownName,
      ),
      subject: `the fold “${clip(title, SUBJECT_CHARS)}”`,
    });
    if (turn !== undefined && name !== undefined) {
      items.push({
        kind: "archived",
        targetId: turn,
        depth: depth + 1,
        current: false,
        text: `archived: ${shownName}`,
        dim: true,
        details: `Archived work of '${shownName}': the complete branch this fold replaced in the context. Press g to go to its last turn; nothing is deleted.`,
        subject: `the archived work of '${shownName}'`,
      });
    }
    if (depth >= MAX_NESTING) return;
    const inside = new Set(ancestors).add(entry.id);
    for (const id of data?.children ?? []) {
      const child = sm.getEntry(id);
      if (child?.type === "branch_summary" && !inside.has(child.id))
        addHandoff(child, depth + 1, inside);
    }
  };

  for (const entry of branch) {
    if (entry.type === "branch_summary") {
      addHandoff(entry, 0, new Set());
      continue;
    }
    if (entry.type === "message" && entry.message.role === "user") {
      const text = messageText(entry);
      items.push({
        kind: "user",
        targetId: entry.id,
        depth: 0,
        current: false,
        text: toOneLine(text, PREVIEW_CHARS) ?? "(no text)",
        dim: true,
        details: `Your message:\n${clip(text || "(no text)", MESSAGE_CHARS)}`,
        subject: `your message “${clip(oneLine(text), SUBJECT_CHARS)}”`,
      });
    }
    const label = sm.getLabel(entry.id);
    if (label?.startsWith(LABEL_PREFIX)) {
      const rawName = label.slice(LABEL_PREFIX.length);
      const name = oneLine(rawName);
      const known = anchors.find((anchor) => anchor.name === rawName);
      const share =
        known && known.percent > 0 ? `${known.percent.toFixed(1)}%` : "—";
      items.push({
        kind: "anchor",
        targetId: entry.id,
        depth: 0,
        current: false,
        text: name,
        dim: false,
        ...(known?.auto && { hint: "(auto)" }),
        ...(known && { value: share }),
        detail: `at: ${previewOf(entry)}`,
        details: `Anchor '${name}'${known ? `: ${share} of the window` : ""}${known?.auto ? " (set automatically)" : ""}.\nat: ${previewOf(entry)}`,
        subject: `anchor '${name}'`,
      });
    }
  }

  const tip = branch.findLast((entry) => TIP_TYPES.has(entry.type));
  if (tip) {
    const at = items.findLastIndex((item) => item.targetId === tip.id);
    if (at >= 0) items[at].current = true;
    else
      items.push({
        kind: "leaf",
        targetId: tip.id,
        depth: 0,
        current: true,
        text: previewOf(tip),
        dim: true,
        details: `You are here: ${previewOf(tip)}`,
        subject: "the current position",
      });
  }
  return items;
}

/** The frame row of one item; no JSON, no control characters, indent capped for narrow screens. */
export function treeRow(item: TreeItem): FrameRow {
  const indent = "  ".repeat(Math.min(item.depth, MAX_INDENT_LEVELS));
  const lead = `${indent}${GLYPH[item.kind]}${item.current ? " [current]" : ""}`;
  if (item.dim) return { label: lead, labelHint: item.text };
  const row: FrameRow = { label: `${lead} ${item.text}` };
  if (item.hint !== undefined) row.labelHint = item.hint;
  if (item.value !== undefined) row.value = item.value;
  if (item.kind === "handoff") row.tone = "muted";
  if (item.detail !== undefined) row.detail = item.detail;
  return row;
}

/** `<n> folds · <m> anchors`; folds counts the handoffs on the branch, not those nested inside them. */
export function treeSummary(items: readonly TreeItem[]): string {
  const folds = items.filter(
    ({ kind, depth }) => kind === "handoff" && depth === 0,
  ).length;
  const anchors = items.filter(({ kind }) => kind === "anchor").length;
  return `${plural(folds, "fold")} · ${plural(anchors, "anchor")}`;
}

const keyOf = (item: TreeItem): string =>
  `${item.kind}:${item.targetId}:${item.depth}`;

/** The current row always stays, so a filter never hides where the session is. */
const passes = (item: TreeItem, filter: TreeFilter): boolean =>
  item.current ||
  filter === "all" ||
  (filter === "users") === (item.kind === "user");

function confirmText(item: TreeItem): string {
  const move =
    item.kind === "user"
      ? "The session leaf moves to just before this message, so the conversation continues from there."
      : "The session leaf moves there, so new messages continue from that point.";
  return `${move}\nNothing is deleted: the rest of the session stays, and /tree or /anchor tree can bring you back.`;
}

/** True when the session leaf moved. */
async function goTo(
  ctx: ExtensionCommandContext,
  item: TreeItem,
): Promise<boolean> {
  const refuseWhileBusy = (): boolean => {
    if (ctx.isIdle()) return false;
    ctx.ui.notify(TREE_BUSY_NOTICE, "warning");
    return true;
  };
  if (item.current) {
    ctx.ui.notify(
      "You are already here. Select another row and press g to go there.",
      "info",
    );
    return false;
  }
  if (refuseWhileBusy()) return false;
  const confirmed = await ctx.ui.confirm(
    `Go to ${item.subject}?`,
    confirmText(item),
  );
  if (!confirmed || refuseWhileBusy()) return false;
  try {
    const { cancelled } = await ctx.navigateTree(item.targetId);
    if (cancelled) {
      ctx.ui.notify(
        "The move was cancelled; the session stays where it is.",
        "warning",
      );
      return false;
    }
  } catch (error) {
    ctx.ui.notify(
      `Could not move there: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return false;
  }
  ctx.ui.notify(`Moved to ${item.subject}. Nothing was deleted.`, "info");
  return true;
}

/** Browse the active branch until the user leaves; "done" after the session leaf moved. */
export async function openTreeScreen(
  ctx: ExtensionCommandContext,
  deps: TreeScreenDeps = {},
): Promise<"back" | "done"> {
  let filter: TreeFilter = "all";
  let focus: string | undefined;
  while (true) {
    const items = treeItems(ctx.sessionManager, deps.listAnchors?.(ctx) ?? []);
    const shown = items.filter((item) => passes(item, filter));
    const focused = shown.findIndex((item) => keyOf(item) === focus);
    const badge = [treeSummary(items), deps.contextBadge?.(ctx)].filter(
      (part): part is string => Boolean(part),
    );
    const screen: FrameScreen = {
      breadcrumbs: ["Anchor", "Tree"],
      rightBadge: badge.join(" · "),
      placeholder: `Search the outline · showing ${FILTER_LABEL[filter]}`,
      enterAction: "view",
      rows: shown.map(treeRow),
      cursor:
        focused >= 0
          ? focused
          : Math.max(
              0,
              shown.findIndex((item) => item.current),
            ),
      shortcuts: [
        { key: "g", action: "go" },
        { key: "f", action: "filter" },
      ],
    };
    const choice = await selectFrame(ctx, screen);
    if (!choice) return "back";
    const item = shown[choice.index];
    if (!item) continue;
    focus = keyOf(item);
    if (choice.key === "f") {
      filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length];
    } else if (choice.key === "g") {
      if (await goTo(ctx, item)) return "done";
    } else {
      ctx.ui.notify(item.details, "info");
    }
  }
}
