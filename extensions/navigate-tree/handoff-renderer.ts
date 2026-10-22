import {
  BranchSummaryMessageComponent,
  type ExtensionAPI,
  keyText,
  type SessionEntry,
  type Theme,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  MouseRegion,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getHandoff, type HandoffData, makeHandoff } from "./handoff.ts";

type Summary = Extract<SessionEntry, { type: "branch_summary" }>;

/** Resolve owned persisted summaries without changing the session projection. */
export function handoffView(
  entry: Summary,
  entries: readonly SessionEntry[],
  visiting = new Set<string>(),
): HandoffData | undefined {
  const data = getHandoff(entry);
  if (data) return data;
  if (
    visiting.has(entry.id) ||
    (typeof entry.details === "object" &&
      entry.details !== null &&
      "treeNavigator" in entry.details)
  )
    return undefined;
  const label = entries.findLast(
    (item) => item.type === "label" && item.targetId === entry.id,
  );
  if (
    !entry.fromHook ||
    label?.type !== "label" ||
    !label.label?.startsWith("anchor:")
  )
    return undefined;
  visiting.add(entry.id);
  const byId = new Map(entries.map((item) => [item.id, item]));
  const sources = new Set<string>();
  const children: string[] = [];
  const include = (item: SessionEntry) => {
    sources.add(item.id);
    if (item.type !== "branch_summary") return;
    const child = handoffView(item, entries, visiting);
    if (!child) return;
    children.push(item.id);
    for (const id of child.sourceIds) sources.add(id);
  };
  const details = entry.details as Record<string, unknown> | undefined;
  const first = entries.findIndex((item) => item.id === details?.firstEntryId);
  const last = entries.findIndex((item) => item.id === details?.lastEntryId);
  if (details?.retrospective === true && first >= 0 && last >= first) {
    for (const item of entries.slice(first, last + 1)) include(item);
  } else {
    const walked = new Set<string>();
    let cursor = byId.get(entry.fromId);
    while (cursor && cursor.id !== entry.parentId && !walked.has(cursor.id)) {
      walked.add(cursor.id);
      include(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  visiting.delete(entry.id);
  return makeHandoff({
    name: label.label.slice("anchor:".length),
    report: entry.summary,
    mode: "full",
    children: [...new Set(children)],
    sourceEntries: entries.filter((item) => sources.has(item.id)),
  });
}

/** `1.2k` / `3.4M` style count. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact inclusive accounting, shared by transcript cards and native tree rows. */
export function handoffUsage(data: HandoffData): string {
  const s = data.stats;
  return `${s.messages} messages · ${s.toolCalls} tool calls · tokens in ${compactCount(s.input)} / out ${compactCount(s.output)} / cache read ${compactCount(s.cacheRead)} / write ${compactCount(s.cacheWrite)} · recorded inclusive $${s.cost.toFixed(4)}`;
}

/** Native tree row body; the native list still owns selection and clipping. */
export function handoffRow(data: HandoffData): string {
  return `${data.title} — ${data.outcome} · ${handoffUsage(data)}`.replace(
    /\s+/g,
    " ",
  );
}

/** Build a themed card body; the native component retains expansion state. */
export function handoffCard(
  data: HandoffData,
  stored: string,
  expanded: boolean,
  theme: Theme,
  markdownTheme: ConstructorParameters<typeof Markdown>[3],
): Container {
  const body = new Container();
  body.addChild(
    new Text(theme.fg("customMessageLabel", theme.bold(data.title)), 0, 0),
  );
  for (const text of [`Goal: ${data.goal}`, `Outcome: ${data.outcome}`]) {
    body.addChild({
      render(width) {
        if (width <= 0) return [];
        const lines = wrapTextWithAnsi(
          theme.fg("customMessageText", text),
          width,
        );
        if (expanded || lines.length <= 3) return lines;
        const kept = lines.slice(0, 3);
        kept[2] = truncateToWidth(`${kept[2]} …`, width);
        return kept;
      },
      invalidate() {},
    });
  }
  body.addChild(new Text(theme.fg("muted", handoffUsage(data)), 0, 0));
  body.addChild(
    new Text(
      theme.fg(
        "dim",
        `${keyText("app.tools.expand")} to ${expanded ? "collapse" : "expand"}`,
      ),
      0,
      0,
    ),
  );
  if (expanded) {
    body.addChild(
      new Text(
        theme.fg(
          "muted",
          `Child context: ${data.mode === "full" ? "full reports" : "parent synthesis only"} · ${data.children.length} child handoffs`,
        ),
        0,
        0,
      ),
    );
    body.addChild(new Markdown(stored, 0, 0, markdownTheme));
  }
  return body;
}

type NativeCard = {
  message: { fromId: string; summary: string };
  expanded: boolean;
  markdownTheme: ConstructorParameters<typeof Markdown>[3];
  clear(): void;
  addChild(child: MouseRegion): void;
  setExpanded(expanded: boolean): void;
};
type Hook = (this: NativeCard, ...args: unknown[]) => unknown;
const patchKey = Symbol.for("pi-tree-navigator.handoff-renderer.original");
type PatchedHook = Hook & { [patchKey]?: Hook };

function patch(
  prototype: Record<string, unknown>,
  key: string,
  wrap: (original: Hook) => Hook,
): () => void {
  const previous = prototype[key];
  if (typeof previous !== "function") throw new Error(`Missing native ${key}`);
  const original = (previous as PatchedHook)[patchKey] ?? (previous as Hook);
  const replacement: PatchedHook = wrap(original);
  replacement[patchKey] = original;
  prototype[key] = replacement;
  return () => {
    if (prototype[key] === replacement) prototype[key] = original;
  };
}

/** Install reversible, reload-safe native hooks against a current session lookup. */
export function installHandoffPatches(options: {
  entries: () => readonly SessionEntry[];
  theme: () => Theme;
  warn: () => void;
}): () => void {
  const restores: (() => void)[] = [];
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    options.warn();
  };
  try {
    restores.push(
      patch(
        BranchSummaryMessageComponent.prototype as unknown as Record<
          string,
          unknown
        >,
        "updateDisplay",
        (original) =>
          function (...args) {
            try {
              if (
                !this.message ||
                typeof this.setExpanded !== "function" ||
                typeof this.clear !== "function" ||
                typeof this.addChild !== "function" ||
                typeof this.expanded !== "boolean"
              )
                throw new Error("Native card shape changed");
              const entries = options.entries();
              const matches = entries.filter(
                (entry): entry is Summary =>
                  entry.type === "branch_summary" &&
                  entry.fromId === this.message.fromId &&
                  entry.summary === this.message.summary,
              );
              const data =
                matches.length === 1
                  ? handoffView(matches[0], entries)
                  : undefined;
              if (data) {
                const body = handoffCard(
                  data,
                  this.message.summary,
                  this.expanded,
                  options.theme(),
                  this.markdownTheme,
                );
                this.clear();
                this.addChild(
                  new MouseRegion(body, (event) => {
                    if (event.type !== "click" || event.button !== "left")
                      return undefined;
                    this.setExpanded(!this.expanded);
                    return { handled: true };
                  }),
                );
                return;
              }
            } catch {
              warn();
            }
            return original.apply(this, args);
          },
      ),
    );
    const selector = new TreeSelectorComponent(
      [],
      null,
      1,
      () => {},
      () => {},
    );
    const prototype = Object.getPrototypeOf(selector.getTreeList()) as Record<
      string,
      unknown
    >;
    restores.push(
      patch(
        prototype,
        "getEntryDisplayText",
        (original) =>
          function (...args) {
            try {
              const node = args[0] as { entry?: SessionEntry } | undefined;
              if (node?.entry?.type === "branch_summary") {
                const entries = options.entries();
                const entry = entries.find(
                  (item) => item.id === node.entry?.id,
                );
                const data =
                  entry?.type === "branch_summary"
                    ? handoffView(entry, entries)
                    : undefined;
                if (data) {
                  const theme = options.theme();
                  const text = theme.fg("customMessageLabel", handoffRow(data));
                  return args[1] ? theme.bold(text) : text;
                }
              }
            } catch {
              warn();
            }
            return original.apply(this, args);
          },
      ),
    );
  } catch {
    warn();
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/** Register session-scoped native rendering without changing persisted or model data. */
export function registerHandoffRenderer(pi: ExtensionAPI): void {
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    dispose = installHandoffPatches({
      entries: () => ctx.sessionManager.getEntries(),
      theme: () => ctx.ui.theme,
      warn: () =>
        ctx.ui.notify(
          "Tree navigator native handoff display is incompatible; using native rendering where unavailable.",
          "warning",
        ),
    });
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
