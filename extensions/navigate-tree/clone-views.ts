/**
 * Readable text for the `/anchor clone` screens: inspect, preview, plan outline
 * and the create confirmation.
 *
 * Pure: every function returns plain text lines bounded by a column width and
 * never JSON. Session names, titles and summaries are untrusted and sanitized.
 */
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./frame.ts";
import type { RetrospectivePreview } from "./retrospective.ts";
import type {
  inspectRetrospectiveSession,
  RetrospectiveGroup,
  RetrospectivePlan,
} from "./retrospective-plan.ts";

/** What `inspectRetrospectiveSession` resolves with. */
export type InspectResult = Awaited<
  ReturnType<typeof inspectRetrospectiveSession>
>;

/** Source facts that turn ids into counts and titles; what is absent is left out of the text. */
export interface ViewContext {
  /** Entry id to its position in the source file. */
  readonly entryIndex?: ReadonlyMap<string, number>;
  /** Group name to its plan title. */
  readonly titles?: ReadonlyMap<string, string>;
}

/** Facts about a proposal that the plan itself does not carry. */
export interface OutlineInfo {
  readonly sessionName: string;
  readonly entries: number;
  readonly method: "heuristic" | "model";
  readonly calls: number;
  readonly cost: number;
  readonly warnings: readonly string[];
}

interface ViewGroup {
  readonly name: string;
  readonly title?: string;
  readonly depth: number;
  readonly state: "folded" | "open";
  readonly mode: "full" | "synthesized";
  readonly firstEntryId: string;
  readonly lastEntryId: string;
  readonly summary: string;
}

const LABEL_WIDTH = 10;
const TAG_WIDTH = 8;
const ANCHOR_PREFIX = "anchor:";

const oneLine = (text: string): string =>
  sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;
const shortHash = (sha256: string): string => sha256.slice(0, 12);
const humanize = (name: string): string => name.replaceAll("-", " ");

/** `first` then `text` wrapped so continuation lines align under the text. */
function hanging(first: string, text: string, width: number): string[] {
  const hang = " ".repeat(visibleWidth(first));
  const room = Math.max(1, width - hang.length);
  return wrapTextWithAnsi(oneLine(text), room).map(
    (line, index) => (index === 0 ? first : hang) + line,
  );
}

const field = (label: string, text: string, width: number): string[] =>
  hanging(label.padEnd(LABEL_WIDTH), text, width);

const warning = (text: string, width: number): string[] =>
  hanging("! ", text, width);

/** First wrapped line of a text, ending in an ellipsis when more follows. */
function excerpt(first: string, text: string, width: number): string[] {
  const [head, ...rest] = hanging(first, text, width);
  if (rest.length === 0) return head ? [head] : [];
  return [`${truncateToWidth(head, Math.max(1, width - 1), "")}…`];
}

function fit(lines: readonly string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line.trimEnd(), width, "…"));
}

function stateCounts(
  groups: readonly { readonly state: "folded" | "open" }[],
): string {
  const folded = groups.filter((group) => group.state === "folded").length;
  return [
    folded > 0 && `${folded} folded`,
    groups.length - folded > 0 && `${groups.length - folded} open`,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(", ");
}

function modeSummary(groups: readonly ViewGroup[]): string {
  const modes = ["full", "synthesized"] as const;
  const counts = modes
    .map((mode) => ({
      mode,
      count: groups.filter((group) => group.mode === mode).length,
    }))
    .filter(({ count }) => count > 0);
  if (counts.length === 0) return "none";
  if (counts.length === 1) return counts[0].mode;
  return `mixed (${counts.map(({ mode, count }) => `${count} ${mode}`).join(", ")})`;
}

function entryCount(
  group: ViewGroup,
  context: ViewContext,
): string | undefined {
  const first = context.entryIndex?.get(group.firstEntryId);
  const last = context.entryIndex?.get(group.lastEntryId);
  return first === undefined || last === undefined || last < first
    ? undefined
    : plural(last - first + 1, "entry", "entries");
}

/** The groups as an indented tree: state tag, title, entry count and a one-line summary excerpt. */
function groupLines(
  groups: readonly ViewGroup[],
  width: number,
  context: ViewContext,
): string[] {
  const mixed = new Set(groups.map((group) => group.mode)).size > 1;
  const lines: string[] = [];
  for (const group of groups) {
    const indent = " ".repeat(
      Math.min(2 + group.depth * 2, Math.max(2, width - 24)),
    );
    const tag = `[${group.state}]`.padEnd(TAG_WIDTH);
    const title =
      group.title ?? context.titles?.get(group.name) ?? humanize(group.name);
    const meta = [entryCount(group, context), mixed ? group.mode : undefined]
      .filter((part): part is string => part !== undefined)
      .join(", ");
    lines.push(
      ...hanging(
        `${indent}${tag} `,
        meta ? `${title} (${meta})` : title,
        width,
      ),
    );
    lines.push(
      ...excerpt(`${indent}${" ".repeat(TAG_WIDTH + 1)}`, group.summary, width),
    );
  }
  return lines;
}

function flattenPlan(plan: RetrospectivePlan): ViewGroup[] {
  const groups: ViewGroup[] = [];
  const visit = (children: readonly RetrospectiveGroup[], depth: number) => {
    for (const group of children) {
      groups.push({
        name: group.name,
        title: group.title === undefined ? undefined : oneLine(group.title),
        depth,
        state: group.state,
        mode: group.mode ?? plan.parentHandoffMode,
        firstEntryId: group.firstEntryId,
        lastEntryId: group.lastEntryId,
        summary: group.summary,
      });
      visit(group.children, depth + 1);
    }
  };
  visit(plan.groups, 0);
  return groups;
}

/** Position of every entry id in the source file, for entry counts. */
export function entryIndex(
  entries: readonly { readonly id: string }[],
): ReadonlyMap<string, number> {
  return new Map(entries.map((entry, index) => [entry.id, index]));
}

/** Group name to title for every titled group of a plan, however deeply nested. */
export function planTitles(
  plan: RetrospectivePlan,
): ReadonlyMap<string, string> {
  return new Map(
    flattenPlan(plan).flatMap(({ name, title }) =>
      title === undefined ? [] : [[name, title] as const],
    ),
  );
}

/** Session facts, graph shape, anchors and any unfinished tool calls. */
export function formatInspect(
  inspected: InspectResult,
  width: number,
): string[] {
  const { graph, pendingToolCalls } = inspected;
  const anchors = graph.labels.flatMap(({ label }) =>
    label?.startsWith(ANCHOR_PREFIX) ? [label.slice(ANCHOR_PREFIX.length)] : [],
  );
  const branches = graph.linear
    ? "1, linear history"
    : `${plural(graph.leaves.length, "branch", "branches")}, ${plural(graph.branchingPoints.length, "fork point")}`;
  const lines = [
    ...field("Session", inspected.name, width),
    ...field("Id", inspected.sessionId, width),
    ...field(
      "Entries",
      `${inspected.entries} · ${plural(inspected.turns.length, "user turn")}`,
      width,
    ),
    ...field("Branches", branches, width),
    ...field(
      "Folds",
      graph.summaries.length
        ? plural(graph.summaries.length, "fold summary", "fold summaries")
        : "none",
      width,
    ),
    ...field(
      "Anchors",
      anchors.length ? `${anchors.length}: ${anchors.join(", ")}` : "none",
      width,
    ),
    ...field(
      "Tools",
      pendingToolCalls.length
        ? `${pendingToolCalls.length} unfinished`
        : "all calls finished",
      width,
    ),
    ...field("Hash", shortHash(inspected.sourceSha256), width),
    ...field("File", inspected.source, width),
  ];
  if (pendingToolCalls.length) {
    lines.push(
      "",
      ...warning(
        `Unfinished tool calls: ${pendingToolCalls.join(", ")}. Wait for their results before proposing or cloning.`,
        width,
      ),
    );
  }
  return fit(lines, width);
}

/** The new session, its groups as a tree, the handoff mode, descendant sessions and warnings. */
export function formatPreview(
  preview: RetrospectivePreview,
  width: number,
  context: ViewContext = {},
): string[] {
  const groups: ViewGroup[] = preview.groups.map((group) => ({
    ...group,
    title: undefined,
  }));
  const copied = preview.descendants.filter(
    ({ mode }) => mode === "copied",
  ).length;
  const restructured = preview.descendants.length - copied;
  const family = preview.descendants.length
    ? `${plural(preview.descendants.length, "descendant session")}: ${copied} copied unchanged, ${restructured} restructured`
    : "none";
  const lines = [
    ...field("New", preview.name, width),
    ...field("From", preview.source, width),
    ...field("Hash", shortHash(preview.sourceSha256), width),
    ...field(
      "Entries",
      `${preview.originalEntries} original + ${preview.addedEntries} added`,
      width,
    ),
    ...field(
      "Groups",
      groups.length ? `${groups.length}: ${stateCounts(groups)}` : "none",
      width,
    ),
    ...field("Handoff", modeSummary(groups), width),
    ...field("Family", family, width),
  ];
  if (groups.length)
    lines.push("", "Outline", ...groupLines(groups, width, context));
  for (const text of preview.warnings) lines.push("", ...warning(text, width));
  return fit(lines, width);
}

/** A proposal at a glance: session, method and cost, then the proposed tree and any warnings. */
export function formatPlanOutline(
  plan: RetrospectivePlan,
  info: OutlineInfo,
  width: number,
  context: ViewContext = {},
): string[] {
  const groups = flattenPlan(plan);
  const method = info.calls
    ? `${info.method} · ${plural(info.calls, "model request")} · $${info.cost.toFixed(4)}`
    : `${info.method} · no model requests`;
  const lines = [
    ...field(
      "Session",
      `${info.sessionName} · ${plural(info.entries, "entry", "entries")}`,
      width,
    ),
    ...field("Method", method, width),
    ...field(
      "Groups",
      groups.length ? `${groups.length}: ${stateCounts(groups)}` : "none",
      width,
    ),
    ...field("Handoff", modeSummary(groups), width),
  ];
  if (groups.length)
    lines.push("", "Outline", ...groupLines(groups, width, context));
  for (const text of info.warnings) lines.push("", ...warning(text, width));
  return fit(lines, width);
}

/** Right-hand badge of the inspect screen. */
export const inspectBadge = (inspected: InspectResult): string =>
  plural(inspected.entries, "entry", "entries");

/** Right-hand badge of the preview screen. */
export const previewBadge = (preview: RetrospectivePreview): string =>
  `${plural(preview.groups.length, "group")} · +${preview.addedEntries} entries`;

/** Right-hand badge of the proposal screen. */
export const outlineBadge = (
  plan: RetrospectivePlan,
  info: OutlineInfo,
): string => `${info.method} · ${plural(flattenPlan(plan).length, "group")}`;

/** Body of the final confirmation dialog; the dialog wraps it itself. */
export function formatCreateConfirmation(
  preview: RetrospectivePreview,
): string {
  const groups = preview.groups.length
    ? `${plural(preview.groups.length, "group")} (${stateCounts(preview.groups)})`
    : "no groups";
  const copied = preview.descendants.filter(
    ({ mode }) => mode === "copied",
  ).length;
  const lines = [
    `From ${oneLine(preview.source)}`,
    `Adds ${plural(preview.addedEntries, "entry", "entries")} to the ${preview.originalEntries} original: ${groups}.`,
  ];
  if (preview.descendants.length) {
    lines.push(
      `${plural(preview.descendants.length, "descendant session")}: ${copied} copied unchanged, ${preview.descendants.length - copied} restructured.`,
    );
  }
  lines.push(
    "The original session will remain untouched, and Pi stays in the current session.",
  );
  return lines.join("\n");
}
