import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { summarizeLedgerForUi } from "./continuity-briefing.ts";
import {
  briefingText,
  type CurrentScreenDeps,
  openCurrentScreen,
} from "./current-screen.ts";
import {
  BEFORE_COMPACTION_NOTE,
  blockedByCompaction,
  type FoldScreenDeps,
} from "./fold-screen.ts";
import { type FrameRow, selectFrame } from "./frame.ts";
import { isValidName, MAX_NAME_LENGTH } from "./helpers.ts";
import {
  CLONE_PROPOSE_FLAGS,
  CLONE_SUBCOMMANDS,
  CLONE_USAGE,
  runCloneSubcommand,
} from "./retrospective-command.ts";
import {
  createSettingsScreenDeps,
  describeSettings,
  openSettingsScreen,
  type SettingsScreenDeps,
} from "./settings-screen.ts";
import { openTreeScreen, treeItems, treeSummary } from "./tree-screen.ts";

/** One anchor on the active branch, as listed by `/anchor list`. */
export interface AnchorRow {
  name: string;
  /** Share of the context window at the anchor (0-100); 0 when the window is unknown. */
  percent: number;
  tokens: number;
  /** Tokens a fold back to this anchor would free. */
  savableTokens: number;
  /** The anchor precedes the latest compaction: a fold there restores the compacted history. */
  beforeCompaction?: boolean;
  afterPreview?: string;
  /** Written by the extension itself rather than by the agent or the user. */
  auto?: boolean;
}

/** Session access the command needs; supplied by the extension entry point. */
export interface AnchorCommandDeps extends FoldScreenDeps, CurrentScreenDeps {
  settings?: SettingsScreenDeps;
  contextBadge?(ctx: ExtensionCommandContext): string | undefined;
  /**
   * Open the one-screen fold plan. `preselect` is the anchor list `r` chose;
   * the host wraps its recommendation so that anchor is selected.
   */
  openFoldPlan(
    ctx: ExtensionCommandContext,
    preselect?: string,
  ): Promise<"back" | "done">;
  /** `/anchor fold [anchor|recommended] [label]` without a UI: print the plan, or fold. */
  foldWithoutUi(ctx: ExtensionCommandContext, args: string): Promise<void>;
}

type SubcommandName =
  | "tree"
  | "list"
  | "current"
  | "fold"
  | "clone"
  | "settings";

const SUBCOMMANDS: readonly {
  name: SubcommandName;
  aliases: readonly string[];
  summary: string;
}[] = [
  {
    name: "tree",
    aliases: ["outline", "phases"],
    summary: "session tree & phases",
  },
  { name: "list", aliases: ["ls", "anchors"], summary: "active anchors" },
  {
    name: "current",
    aliases: ["briefing", "ledger", "state"],
    summary: "current briefing & continuity ledger",
  },
  { name: "fold", aliases: ["rewind"], summary: "fold current work now" },
  {
    name: "clone",
    aliases: ["restructure"],
    summary: "retrospective clone & restructure",
  },
  { name: "settings", aliases: ["config", "set"], summary: "settings" },
];

const ANCHOR_USAGE = `Usage: /anchor [tree|list|current|fold|clone|settings]. Run /anchor alone to open the menu.\n/anchor fold [anchor|recommended] [new-label]: without a UI, no anchor prints the plan and an anchor folds.\n${CLONE_USAGE}`;

const HUB: readonly {
  view: SubcommandName;
  row: FrameRow;
}[] = [
  {
    view: "tree",
    row: {
      label: "Session tree & phases",
      description:
        "Browse the chronological outline of phases, anchors and folded handoffs.",
    },
  },
  {
    view: "list",
    row: {
      label: "Active anchors",
      description:
        "List the anchors on the active branch, set a new one or fold to one.",
    },
  },
  {
    view: "current",
    row: {
      label: "Current briefing & continuity ledger",
      description:
        "Browse, edit and retract the goals, rules and decisions that survive every fold.",
    },
  },
  {
    view: "fold",
    row: {
      label: "Fold current work now…",
      description: "Fold the work since an anchor into a branch summary.",
    },
  },
  {
    view: "clone",
    row: {
      label: "Retrospective clone & restructure",
      value: "inspect · propose · preview · create",
      description:
        "Turn a session into nested phase handoffs in a new session; the source is never modified.",
    },
  },
  {
    view: "settings",
    row: {
      label: "Settings",
      description:
        "Configure reserves, handoff policy and sidecar models in tree-navigator.json.",
    },
  },
];

const CLONE_ROWS: Record<(typeof CLONE_SUBCOMMANDS)[number]["name"], FrameRow> =
  {
    inspect: {
      label: "Inspect a session",
      value: "read-only overview",
      description:
        "/anchor clone inspect [session.jsonl]: summarize a session file; the current session when no path is given.",
    },
    propose: {
      label: "Propose a tree plan",
      value: "heuristic or --llm",
      description:
        "/anchor clone propose [session.jsonl]: derive a reviewable plan; nothing is created or switched.",
    },
    preview: {
      label: "Preview a plan",
      value: "review planned changes",
      description:
        "/anchor clone preview <plan.json>: review the clone a plan would create.",
    },
    create: {
      label: "Create a clone from a plan",
      value: "asks to confirm",
      description:
        "/anchor clone create <plan.json>: write a new session after confirmation; the original stays untouched.",
    },
  };

function resolveSubcommand(token: string): SubcommandName | undefined {
  const word = token.toLowerCase();
  const forms = [word, word.endsWith("s") ? word.slice(0, -1) : `${word}s`];
  return SUBCOMMANDS.find((command) =>
    forms.some(
      (form) => form === command.name || command.aliases.includes(form),
    ),
  )?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function suggestSubcommand(token: string): SubcommandName | undefined {
  const word = token.toLowerCase();
  let best: { name: SubcommandName; distance: number } | undefined;
  for (const command of SUBCOMMANDS) {
    for (const candidate of [command.name, ...command.aliases]) {
      const distance = editDistance(word, candidate);
      if (distance > 2 || distance >= word.length) continue;
      if (!best || distance < best.distance)
        best = { name: command.name, distance };
    }
  }
  return best?.name;
}

function fuzzyItems<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  toItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
  const found = query ? fuzzyFilter([...items], query, text) : [...items];
  return found.length ? found.map(toItem) : null;
}

function completions(argumentText: string): AutocompleteItem[] | null {
  const input = argumentText.trimStart();
  const match = /^(\S+)(\s+)([\s\S]*)$/.exec(input);
  if (!match) {
    return fuzzyItems(
      SUBCOMMANDS,
      input,
      (command) => `${command.name} ${command.aliases.join(" ")}`,
      (command) => ({
        value: `${command.name} `,
        label: command.name,
        description: command.summary,
      }),
    );
  }

  const [, head, gap, rest] = match;
  if (resolveSubcommand(head) !== "clone") return null;
  const prefix = `${head}${gap}`;
  const verb = /^(\S*)$/.exec(rest);
  if (verb) {
    return fuzzyItems(
      CLONE_SUBCOMMANDS,
      verb[1],
      (command) => command.name,
      (command) => ({
        value: `${prefix}${command.name} `,
        label: command.name,
        description: `${command.path} — ${command.summary}`,
      }),
    );
  }
  const flag = /^(propose\s[\s\S]*?)(--[\w-]*)$/.exec(rest);
  if (!flag) return null;
  const flags = CLONE_PROPOSE_FLAGS.filter((candidate) =>
    candidate.startsWith(flag[2]),
  );
  return flags.length
    ? flags.map((candidate) => ({
        value: `${prefix}${flag[1]}${candidate} `,
        label: candidate,
      }))
    : null;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatPercent(percent: number): string {
  return percent > 0 ? `${percent.toFixed(1)}%` : "—";
}

function anchorRow(anchor: AnchorRow, deps: AnchorCommandDeps): FrameRow {
  return {
    label: `◆ ${anchor.name}`,
    labelHint: anchor.auto ? "(auto)" : undefined,
    value: `${formatPercent(anchor.percent)} · ${formatTokens(anchor.tokens)} · −${formatTokens(anchor.savableTokens)} savable`,
    detail: anchor.afterPreview ? `after: “${anchor.afterPreview}”` : undefined,
    description: blockedByCompaction(anchor, deps)
      ? `${BEFORE_COMPACTION_NOTE} Enter shows the full line.`
      : `Press r to fold the work since '${anchor.name}'. Enter shows the full line.`,
  };
}

function anchorSummary(anchor: AnchorRow, deps: AnchorCommandDeps): string {
  const after = anchor.afterPreview ? ` after “${anchor.afterPreview}”` : "";
  const fold = blockedByCompaction(anchor, deps)
    ? `. ${BEFORE_COMPACTION_NOTE}`
    : `; folding to it would free about ${formatTokens(anchor.savableTokens)} tok.`;
  return `Anchor '${anchor.name}'${after}: ${formatPercent(anchor.percent)} of the window (${formatTokens(anchor.tokens)} tok)${fold}`;
}

function listBadge(
  ctx: ExtensionCommandContext,
  deps: AnchorCommandDeps,
  anchors: readonly AnchorRow[],
): string {
  const count = `${anchors.length} anchor${anchors.length === 1 ? "" : "s"}`;
  const context = deps.contextBadge?.(ctx);
  return context ? `${count} · ${context}` : count;
}

async function promptNewAnchor(
  ctx: ExtensionCommandContext,
  deps: AnchorCommandDeps,
  existing: readonly AnchorRow[],
): Promise<void> {
  const input = await ctx.ui.input(
    `New anchor name (kebab-case, max ${MAX_NAME_LENGTH} characters)`,
    "e.g. impl-start",
  );
  const name = input?.trim();
  if (!name) return;
  if (!isValidName(name)) {
    ctx.ui.notify(
      `Invalid anchor name "${name}": use lowercase kebab-case, at most ${MAX_NAME_LENGTH} characters (e.g. impl-start).`,
      "warning",
    );
    return;
  }
  if (existing.some((anchor) => anchor.name === name)) {
    ctx.ui.notify(
      `An anchor named '${name}' already exists on the active branch; pick a fresh name.`,
      "warning",
    );
    return;
  }
  const result = deps.setAnchor(ctx, name);
  ctx.ui.notify(
    result.ok ? `Anchor '${name}' set at the current leaf.` : result.reason,
    result.ok ? "info" : "warning",
  );
}

/** "done" ends the whole command; "back" returns to the screen that opened this one. */
type ScreenExit = "back" | "done";

async function openAnchorList(
  ctx: ExtensionCommandContext,
  deps: AnchorCommandDeps,
): Promise<ScreenExit> {
  let cursor = 0;
  while (true) {
    const anchors = deps.listAnchors(ctx);
    const choice = await selectFrame(ctx, {
      breadcrumbs: ["Anchor", "List"],
      rightBadge: listBadge(ctx, deps, anchors),
      placeholder: "Filter anchors by name or preview…",
      rows: [
        ...anchors.map((anchor) => anchorRow(anchor, deps)),
        {
          label: "+ Set new anchor at current leaf…",
          description: `Label the current leaf as a milestone anchor (kebab-case, at most ${MAX_NAME_LENGTH} characters).`,
        },
      ],
      cursor,
      shortcuts: [
        {
          key: "r",
          action: "fold",
          enabled: (_row, index) => index < anchors.length,
        },
      ],
    });
    if (!choice) return "back";
    cursor = choice.index;
    const anchor = anchors[choice.index];
    if (!anchor) {
      await promptNewAnchor(ctx, deps, anchors);
    } else if (choice.key === "r") {
      if ((await deps.openFoldPlan(ctx, anchor.name)) === "done") return "done";
    } else {
      ctx.ui.notify(anchorSummary(anchor, deps), "info");
    }
  }
}

async function openCloneMenu(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<ScreenExit> {
  let cursor = 0;
  while (true) {
    const choice = await selectFrame(ctx, {
      breadcrumbs: ["Anchor", "Clone"],
      placeholder: "Search clone steps…",
      enterAction: "run",
      rows: CLONE_SUBCOMMANDS.map((command) => CLONE_ROWS[command.name]),
      cursor,
    });
    if (!choice) return "back";
    cursor = choice.index;
    await runCloneSubcommand(CLONE_SUBCOMMANDS[choice.index].name, ctx, pi);
  }
}

async function openView(
  view: SubcommandName,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  deps: AnchorCommandDeps,
): Promise<ScreenExit> {
  switch (view) {
    case "list":
      return openAnchorList(ctx, deps);
    case "clone":
      return openCloneMenu(ctx, pi);
    case "tree":
      return openTreeScreen(ctx, deps);
    case "current":
      await openCurrentScreen(ctx, deps);
      return "back";
    case "fold":
      return deps.openFoldPlan(ctx);
    case "settings":
      return openSettingsScreen(
        ctx,
        deps.settings ?? createSettingsScreenDeps(),
      );
  }
}

async function openHub(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  deps: AnchorCommandDeps,
): Promise<void> {
  let cursor = 0;
  while (true) {
    const anchors = deps.listAnchors(ctx);
    const rows = HUB.map(({ view, row }): FrameRow => {
      if (view === "list")
        return {
          ...row,
          labelHint: `(${anchors.length} on branch)`,
          value: anchors.length
            ? `latest: ${anchors.at(-1)?.name}`
            : "none yet",
        };
      if (view === "current") {
        const ledger = deps.readLedger(ctx);
        return {
          ...row,
          value: ledger
            ? summarizeLedgerForUi(ledger).line
            : "No continuity items yet.",
        };
      }
      if (view === "tree")
        return { ...row, value: treeSummary(treeItems(ctx.sessionManager)) };
      if (view === "fold") return { ...row, value: "anchor · label · focus" };
      if (view === "settings")
        return { ...row, value: "global · project · runtime" };
      return row;
    });
    const choice = await selectFrame(ctx, {
      breadcrumbs: ["Anchor"],
      rightBadge: deps.contextBadge?.(ctx),
      placeholder: "Type to search views or actions…",
      enterAction: "open",
      cancelAction: "close",
      rows,
      cursor,
    });
    if (!choice) return;
    cursor = choice.index;
    if ((await openView(HUB[choice.index].view, ctx, pi, deps)) === "done")
      return;
  }
}

function formatAnchorLines(
  anchors: readonly AnchorRow[],
  deps: AnchorCommandDeps,
): string {
  if (!anchors.length) return "No anchors on the active branch.";
  const lines = anchors.map(
    (anchor) =>
      `  ${formatPercent(anchor.percent)}  ${anchor.name}  ${formatTokens(anchor.tokens)} tok  −${formatTokens(anchor.savableTokens)} savable${blockedByCompaction(anchor, deps) ? "  (before compaction)" : ""}`,
  );
  return ["Active anchors (root → leaf):", ...lines].join("\n");
}

/** Register the single `/anchor` command: hub, anchor list and retrospective clone. */
export function registerAnchorCommand(
  pi: ExtensionAPI,
  deps: AnchorCommandDeps,
): void {
  pi.registerCommand("anchor", {
    description:
      "[tree|list|current|fold|clone|settings] — browse anchors, fold work and restructure sessions",
    getArgumentCompletions: completions,
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed) {
        if (ctx.hasUI) await openHub(ctx, pi, deps);
        else ctx.ui.notify(ANCHOR_USAGE, "info");
        return;
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const token = match?.[1] ?? trimmed;
      const rest = match?.[2] ?? "";
      const subcommand = resolveSubcommand(token);
      if (!subcommand) {
        const suggestion = suggestSubcommand(token);
        const hint = suggestion ? ` Did you mean '/anchor ${suggestion}'?` : "";
        ctx.ui.notify(
          `Unknown subcommand "${token}".${hint}\n${ANCHOR_USAGE}`,
          "warning",
        );
        return;
      }

      if (subcommand === "clone") {
        if (!rest && ctx.hasUI) await openCloneMenu(ctx, pi);
        else await runCloneSubcommand(rest, ctx, pi);
      } else if (subcommand === "list") {
        if (ctx.hasUI) await openAnchorList(ctx, deps);
        else
          ctx.ui.notify(formatAnchorLines(deps.listAnchors(ctx), deps), "info");
      } else if (subcommand === "tree" && !ctx.hasUI) {
        const items = treeItems(ctx.sessionManager, deps.listAnchors(ctx));
        ctx.ui.notify(
          [
            treeSummary(items),
            ...items.map(
              (item) =>
                `${"  ".repeat(item.depth)}${item.current ? "[current] " : ""}${item.text}`,
            ),
          ].join("\n"),
          "info",
        );
      } else if (subcommand === "fold") {
        if (!ctx.hasUI) await deps.foldWithoutUi(ctx, rest);
        else {
          const preselect = rest.trim().split(/\s+/)[0];
          await deps.openFoldPlan(
            ctx,
            preselect && preselect !== "recommended" ? preselect : undefined,
          );
        }
      } else if (subcommand === "settings") {
        if (!ctx.hasUI || rest === "show")
          ctx.ui.notify(
            await describeSettings(
              ctx,
              deps.settings ?? createSettingsScreenDeps(),
            ),
            "info",
          );
        else await openView(subcommand, ctx, pi, deps);
      } else if (ctx.hasUI) {
        await openView(subcommand, ctx, pi, deps);
      } else {
        const ledger =
          subcommand === "current" ? deps.readLedger(ctx) : undefined;
        if (ledger) ctx.ui.notify(briefingText(ledger), "info");
        else if (subcommand === "current")
          ctx.ui.notify("No continuity items yet.", "info");
      }
    },
  });
}
