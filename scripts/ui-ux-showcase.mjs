#!/usr/bin/env node
/**
 * Interactive & static TUI showcase for the proposed pi-tree-navigator & agentd UI/UX.
 *
 * Run interactively (TTY):
 *   node scripts/ui-ux-showcase.mjs
 *
 * Render all screens statically:
 *   node scripts/ui-ux-showcase.mjs --all [--width 96]
 */

import { stdout, stdin, argv, env } from "node:process";

const noColor = "NO_COLOR" in env || env.TERM === "dumb" || argv.includes("--no-color");

const sgr = (open, close) => (text) => (noColor ? String(text) : `\x1b[${open}m${text}\x1b[${close}m`);
const fg256 = (code) => (text) => (noColor ? String(text) : `\x1b[38;5;${code}m${text}\x1b[39m`);

const theme = {
  bold: sgr(1, 22),
  italic: sgr(3, 23),
  text: (t) => String(t),
  muted: fg256(246),
  dim: fg256(241),
  accent: fg256(75),
  borderAccent: fg256(68),
  success: fg256(78),
  warning: fg256(214),
  error: fg256(203),
};

// Strip ANSI sequences to measure visible width accurately.
function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(str) {
  return [...stripAnsi(str)].length;
}

function truncateToWidth(str, maxWidth, ellipsis = "…") {
  if (maxWidth <= 0) return "";
  if (visibleWidth(str) <= maxWidth) return str;
  const plain = [...stripAnsi(str)];
  return plain.slice(0, Math.max(0, maxWidth - ellipsis.length)).join("") + ellipsis;
}

function borderLine(width, breadcrumbs, hiddenCount, direction, rightBadge = "") {
  const indicator = hiddenCount > 0 ? ` ${direction} ${hiddenCount} more ` : "";
  const right = rightBadge ? ` ${rightBadge} ` : "";
  const leftTitle =
    breadcrumbs.length > 0
      ? theme.borderAccent("─ ") +
        breadcrumbs
          .map((seg, idx) => (idx === breadcrumbs.length - 1 ? theme.bold(seg) : theme.muted(seg)))
          .join(theme.dim("/")) +
        " "
      : "";
  const leftLen = visibleWidth(leftTitle);
  const indLen = visibleWidth(indicator);
  const rightLen = visibleWidth(right);

  if (indLen === 0) {
    const dashes = Math.max(1, width - leftLen - rightLen - (rightLen ? 1 : 0));
    return (
      leftTitle +
      theme.borderAccent("─".repeat(dashes)) +
      (right ? theme.muted(right) + theme.borderAccent("─") : "")
    );
  }

  const centerStart = Math.max(leftLen + 2, Math.floor((width - indLen) / 2));
  const leftDashes = Math.max(1, centerStart - leftLen);
  const remaining = Math.max(1, width - leftLen - leftDashes - indLen - rightLen - (rightLen ? 1 : 0));
  return (
    leftTitle +
    theme.borderAccent("─".repeat(leftDashes)) +
    theme.dim(indicator) +
    theme.borderAccent("─".repeat(remaining)) +
    (right ? theme.muted(right) + theme.borderAccent("─") : "")
  );
}

function renderFrameScreen({
  width,
  breadcrumbs,
  rightBadge,
  query = "",
  searchPlaceholder = "Type to search…",
  rows,
  cursor = 0,
  scrollOffset = 0,
  listRows = 7,
  keybindings,
}) {
  const filtered = query
    ? rows.filter((r) =>
        `${r.label} ${r.value ?? ""} ${r.detail ?? ""} ${r.description ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : rows;

  const safeCursor = filtered.length ? Math.max(0, Math.min(cursor, filtered.length - 1)) : -1;
  const longestLabel = rows.reduce(
    (max, r) => Math.max(max, visibleWidth(r.label + (r.labelHint ? ` ${r.labelHint}` : ""))),
    0,
  );
  const valueCol = Math.min(width - 16, 3 + Math.min(longestLabel, Math.floor(width * 0.52)) + 3);

  const lines = [];
  lines.push(borderLine(width, breadcrumbs, scrollOffset, "↑", rightBadge));

  const searchLine = query
    ? ` ${theme.accent("❯")} ${theme.text(query)}${theme.accent("█")}`
    : ` ${theme.accent("❯")} ${theme.dim(theme.italic(searchPlaceholder))}`;
  lines.push(searchLine);
  lines.push("");

  const body = [];
  let idx = scrollOffset;
  while (idx < filtered.length && body.length < listRows) {
    const r = filtered[idx];
    const selected = idx === safeCursor;
    const prefix = selected ? ` ${theme.accent("→")} ` : "   ";
    const lbl = r.label + (r.labelHint ? ` ${theme.dim(r.labelHint)}` : "");
    let mainLine;
    if (r.value !== undefined) {
      const pad = " ".repeat(Math.max(2, valueCol - 3 - visibleWidth(lbl)));
      mainLine = `${prefix}${selected ? theme.bold(lbl) : lbl}${pad}${r.value}`;
    } else {
      mainLine = `${prefix}${selected ? theme.bold(lbl) : lbl}`;
    }
    body.push(mainLine);
    if (selected && r.detail && body.length < listRows) {
      body.push(`      ${theme.dim("↳")} ${theme.muted(r.detail)}`);
    }
    idx++;
  }
  if (filtered.length === 0) {
    body.push(`   ${theme.dim(theme.italic(`No entries match "${query}"`))}`);
  }
  while (body.length < listRows) body.push("");
  lines.push(...body);

  lines.push("");
  const activeDesc = safeCursor >= 0 ? filtered[safeCursor]?.description ?? "" : "Esc to clear filter";
  lines.push(`   ${theme.dim(activeDesc)}`);

  const kbLine =
    " " +
    keybindings
      .map(({ key, action }) => `${theme.bold(key)} ${theme.dim(action)}`)
      .join("  ");
  lines.push(kbLine);

  const hiddenBelow = Math.max(0, filtered.length - idx);
  lines.push(borderLine(width, [], hiddenBelow, "↓"));
  return lines.join("\n");
}

const SCREENS = [
  {
    id: "root",
    title: "1. /anchor (Root Hub)",
    frame: {
      breadcrumbs: ["Anchor"],
      rightBadge: "ctx 22.7% · 84.4k/372k",
      searchPlaceholder: "Type to search views or actions…",
      listRows: 7,
      rows: [
        {
          label: "Session tree & phases",
          labelHint: "(3 phases · 2 anchors)",
          value: `${theme.success("●")} Phase 2 open`,
          detail: "Chronological containment outline · [current] inside Phase 2 (+30.1k saved last fold)",
          description: "Browse phases, anchors, and folded handoffs; toggle raw graph with F2.",
        },
        {
          label: "Active anchors",
          labelHint: "(2 on branch)",
          value: "start · context-gathered",
          detail: "Oldest: start (4.1%) · Newest: context-gathered (22.7% · +69.1k tok)",
          description: "Inspect anchors on the active branch, set a new anchor, or fold work to an anchor.",
        },
        {
          label: "Current briefing & continuity ledger",
          labelHint: "(rev 14)",
          value: "1 goal · 4 rules · 2 tasks",
          detail: "Durable objective, pinned user constraints, active decisions, and file pointers",
          description: "Inspect or pin/supersede goals, instructions, decisions, and facts that survive every fold.",
        },
        {
          label: "Fold current work now…",
          value: `${theme.accent("→")} anchor:context-gathered`,
          detail: "Estimated fold: 114.5k → ~84.4k tok (−30.1k tok · 3 turns)",
          description: "Trigger an immediate in-band summary fold to a chosen anchor with custom focus.",
        },
        {
          label: "Retrospective clone & restructure",
          labelHint: "(4 steps)",
          value: "inspect · propose · preview · create",
          detail: "Turn a linear or branched session into nested phase handoffs without touching source",
          description: "Open the guided retrospective session cloning workflow.",
        },
        {
          label: "Settings",
          value: `reserve 50k · mode full · auto off`,
          detail: "Global & trusted-project tree-navigator.json (0 staged changes)",
          description: "Configure reserve tokens, start anchor turn, handoff policy, and sidecar models.",
        },
      ],
      keybindings: [
        { key: "↑↓", action: "navigate" },
        { key: "enter", action: "open" },
        { key: "n", action: "set anchor" },
        { key: "r", action: "quick fold" },
        { key: "esc/ctrl+c", action: "cancel" },
      ],
    },
  },
  {
    id: "tree",
    title: "2. /anchor tree (Chronological Containment Outline)",
    frame: {
      breadcrumbs: ["Anchor", "Tree"],
      rightBadge: "F2 raw graph · 22.7%/372k",
      searchPlaceholder: "Search phases, anchors, messages, or files…",
      listRows: 8,
      rows: [
        {
          label: "▸ ▣ Phase 1: Repository Orientation & Invariants",
          labelHint: "(folded)",
          value: `18 msgs · 7 tools · ${theme.muted("$0.0412")}`,
          detail: "Goal: Audit tools, slash commands, and TUI surfaces · Outcome: Clean inventory delivered",
          description: "Folded phase handoff. Enter/Space unfolds raw turns; r resumes right after this handoff.",
        },
        {
          label: "▾ ◐ Phase 2: UI/UX Redesign & Continuity Ledger",
          labelHint: "(open)",
          value: `6 msgs · 4 tools · ${theme.muted("+29.8k tok")}`,
          detail: "Active phase · started at anchor:context-gathered (22.7%)",
          description: "Enclosing open phase on the active branch. Enter/Space collapses children.",
        },
        {
          label: "  ├─ ◆ anchor:start",
          labelHint: "(turn 2)",
          value: `4.1% · ${theme.muted("15.2k tok")}`,
          detail: "after: \"Analyze our pi-tree-navigator and present me…\"",
          description: "Automatic low-floor session anchor. Press r to fold work back to this point.",
        },
        {
          label: "  ├─ ◆ anchor:context-gathered",
          labelHint: "(turn 6)",
          value: `22.7% · ${theme.muted("84.4k tok")}`,
          detail: "▣ Work handoff: analysis complete (−30.1k tok freed)",
          description: "Rewind anchor carrying the Phase 1 branch_summary and continuity snapshot rev 14.",
        },
        {
          label: "  └─ ● [current] Proposing /anchor UI, skills & ledger",
          labelHint: "(leaf)",
          value: `30.8% · ${theme.muted("114.5k tok")}`,
          detail: "assistant: building runnable showcase and two UI/UX project skills",
          description: "Current active conversation leaf. Press n to drop a named milestone anchor here.",
        },
      ],
      keybindings: [
        { key: "↑↓", action: "navigate" },
        { key: "enter/space", action: "toggle/jump" },
        { key: "r", action: "resume after handoff" },
        { key: "n", action: "anchor leaf" },
        { key: "f2", action: "raw graph" },
        { key: "esc", action: "back" },
      ],
    },
  },
  {
    id: "list",
    title: "3. /anchor list (Active Branch Anchors & Savings)",
    frame: {
      breadcrumbs: ["Anchor", "List"],
      rightBadge: "2 anchors · 114.5k active",
      searchPlaceholder: "Filter anchors by name or prompt preview…",
      listRows: 6,
      rows: [
        {
          label: "◆ start",
          labelHint: "(auto · turn 2)",
          value: `4.1%  (${theme.muted("15.2k tok")}) · ${theme.success("−99.3k savable")}`,
          detail: "after: \"Analyze our pi-tree-navigator and present me: - which tools…\"",
          description: "Press r to fold 99.3k tokens since 'start' into a branch summary.",
        },
        {
          label: "◆ context-gathered",
          labelHint: "(branch_summary · turn 6)",
          value: `22.7% (${theme.muted("84.4k tok")}) · ${theme.success("−30.1k savable")}`,
          detail: "after: \"# Work handoff: analysis complete — Goal: Analyze pi-tree-navigator…\"",
          description: "Press r to fold 30.1k tokens since 'context-gathered' into a chained summary.",
        },
        {
          label: "+ Set new anchor at current leaf…",
          value: `${theme.accent("30.8%")} (${theme.muted("114.5k tok")})`,
          detail: "Suggested slug: 'ux-and-continuity-proposal'",
          description: "Label the current conversation leaf as a new milestone anchor (kebab-case, ≤40 chars).",
        },
      ],
      keybindings: [
        { key: "↑↓", action: "navigate" },
        { key: "r", action: "fold to anchor" },
        { key: "n/enter", action: "new anchor" },
        { key: "j", action: "jump in tree" },
        { key: "esc", action: "back" },
      ],
    },
  },
  {
    id: "current",
    title: "4. /anchor current (Durable Session Continuity Ledger)",
    frame: {
      breadcrumbs: ["Anchor", "Current"],
      rightBadge: "Ledger rev 14 · 1.4k tok",
      searchPlaceholder: "Filter goals, rules, decisions, or file pointers…",
      listRows: 8,
      rows: [
        {
          label: "◎ Overall Objective",
          labelHint: "[pinned · turn 1]",
          value: "Endless-session tree navigation & UX unification",
          detail: "Standardize /anchor TUI on FrameList and preserve user intent across all folds",
          description: "Session-root objective. Injected into every fold briefing; never auto-decays.",
        },
        {
          label: "◐ Sub-goal S2",
          labelHint: "[active · anchor:context-gathered]",
          value: "Design /anchor suite, two UI skills & continuity engine",
          detail: "Deliver wireframes, runnable script, .pi/skills/*, and ledger architecture",
          description: "Active phase goal. Transitions to 'completed' or 'superseded' at fold boundary.",
        },
        {
          label: "◆ Rule R1 (User Instruction)",
          labelHint: "[binding · turn 8]",
          value: "Use unified FrameList layout for all slash commands",
          detail: "Match pi-bolt-subagents /agents & /settings; replace CLI-like flag-style clone command",
          description: "Classified as durable user guidance (jev p=0.96). Protected from fold compression.",
        },
        {
          label: "◆ Decision D4",
          labelHint: "[accepted · 2026-10-20]",
          value: "Project ledger is task authority; session entries are receipts",
          detail: "Supersedes branch-local todo snapshots; prevents ghost IDs and done-work revert",
          description: "ADR-style decision record with supersession lineage. Press Enter to view or supersede.",
        },
        {
          label: "◇ Steering Note (Ephemeral)",
          labelHint: "[decays on fold · turn 8]",
          value: "\"create node scripts I can run in my terminal\"",
          detail: "Scoped to current anchor; folds into 'Delivered' once scripts/ui-ux-showcase.mjs ships",
          description: "Classified as current-anchor steering (jev p=0.91). Will archive on fold.",
        },
        {
          label: "⌁ File Pointer F3",
          labelHint: "[verified sha256:8f2a…]",
          value: "pi-bolt-subagents/src/ui/frame.ts:1-250",
          detail: "Canonical FrameList geometry, border overflow indicators, and frozen height contract",
          description: "Source-linked pointer. Press Enter to preview or x to unpin.",
        },
      ],
      keybindings: [
        { key: "↑↓", action: "navigate" },
        { key: "enter", action: "inspect/edit" },
        { key: "p", action: "pin/unpin" },
        { key: "s", action: "supersede" },
        { key: "+", action: "add rule/note" },
        { key: "esc", action: "back" },
      ],
    },
  },
  {
    id: "settings",
    title: "5. /anchor settings (Staged Multi-Scope Settings Panel)",
    frame: {
      breadcrumbs: ["Anchor", "Settings"],
      rightBadge: `${theme.warning("● 2 staged")}`,
      searchPlaceholder: "Filter settings by name or description…",
      listRows: 8,
      rows: [
        {
          label: "Rewind hint reserve tokens",
          labelHint: "(project ●)",
          value: `${theme.accent("‹ 60000 ›")} ${theme.warning("● staged")}`,
          detail: "Fires hint & enables overflow recovery when ≤60k tokens remain in window",
          description: "Tokens left in context window (1000–1000000 or 'off') before rewind hint triggers.",
        },
        {
          label: "Auto-start anchor turn",
          labelHint: "(default)",
          value: "‹ 2 ›",
          detail: "Writes silent anchor:start after turn 2 (or run end if shorter)",
          description: "Turn count (1–50) for automatic low-floor 'anchor:start' milestone.",
        },
        {
          label: "Parent handoff mode",
          labelHint: "(global)",
          value: "‹ full ›",
          detail: "full: keep child handoffs once each · synthesized: relevance-focused parent report",
          description: "Controls how nested folds materialize child phase handoffs into model context.",
        },
        {
          label: "Intent classifier (jev)",
          labelHint: "(project ●)",
          value: `${theme.accent("‹ typesafe/jev-latest ›")} ${theme.warning("● staged")}`,
          detail: "Classifies user turns: objective | durable-rule | decision | steering | question",
          description: "Classifier model for tagging user messages before fold boundaries (Enter to pick).",
        },
        {
          label: "Continuity compiler model",
          labelHint: "(global)",
          value: "openai-codex/gpt-5.4 · medium",
          detail: "Reconciles ledger deltas (goals, rules, supersessions) on navigate_tree rewind",
          description: "Model + thinking level used to update the structured continuity ledger at fold time.",
        },
        {
          label: "Auto-navigate sidecar",
          labelHint: "(default)",
          value: `${theme.muted("off")}`,
          detail: "mode: anchor-and-rewind · check every 6 turns · rewind at 120k tok",
          description: "Automatically place milestone anchors and steer rewinds on long autonomous runs.",
        },
        {
          label: "Proposal tool disclosure",
          labelHint: "(2 rules)",
          value: "bash: calls-only · read: omit",
          detail: "Applied to /anchor clone propose --llm and auto-navigate controller requests",
          description: "Press Enter to configure per-tool disclosure (full, calls-only, omit).",
        },
      ],
      keybindings: [
        { key: "↑↓", action: "navigate" },
        { key: "←→", action: "change" },
        { key: "enter", action: "edit/pick" },
        { key: "d", action: "default" },
        { key: "ctrl+s", action: "save scope" },
        { key: "esc", action: "back" },
      ],
    },
  },
];

// The real row builders (TypeScript, pi-tui); absent without node_modules or Node >= 22.18.
const liveRows = await import("../extensions/navigate-tree/tool-renderer.ts").catch(() => undefined);

const piRoles = {
  toolTitle: theme.accent,
  accent: theme.accent,
  toolOutput: theme.text,
  error: theme.error,
  dim: theme.dim,
  muted: theme.muted,
};
const piTheme = { fg: (role, text) => (piRoles[role] ?? theme.text)(text), bold: theme.bold };

function renderLiveRows(width) {
  const rule = theme.borderAccent("─".repeat(width));
  const out = [rule, theme.bold("8. Live tool & ledger rows (real renderers)"), rule, ""];
  if (!liveRows) return [...out, theme.muted("  tool-renderer.ts could not be imported; skipped"), ""].join("\n");
  const { renderToolCall, renderToolResult, renderContinuityOps } = liveRows;
  const shell = (component) => component.render(Math.max(1, width - 2)).map((line) => ` ${line}`);
  const text = (body) => ({ content: [{ type: "text", text: body }] });
  const tool = (args, result, isError = false, expanded = false) =>
    out.push(
      ...shell(renderToolCall(args, piTheme, expanded)),
      ...shell(renderToolResult(result, { expanded, isPartial: false }, piTheme, isError)),
      "",
    );
  const ledger = (ops, expanded = false) =>
    out.push("", ...renderContinuityOps({ data: { ops } }, { expanded }, piTheme).render(width));
  const user = { origin: "user" };
  const rule1 = { op: { op: "add", kind: "rule", text: "From now on always answer in German", quote: "From now on always answer in German" }, ctx: user };
  const decision = { op: { op: "add", kind: "decision", text: "Use Postgres for the ledger store", quote: "ok, postgres it is" }, ctx: user };

  const list = {
    ...text("[list] · 3 labels · ctx 12.0% of 1.0M\n\n  4.1%  context-gathered\n  9.5%  impl-start\n 12.0%  tests-green"),
    details: { count: 3, contextTokens: 120000, contextWindow: 1_000_000, reflectionOk: true },
  };
  tool({ action: "anchor", name: "context-gathered" }, {
    ...text("[anchor 'context-gathered'] set at 4.1% of 1.0M (after: “Analyze our pi-tree-navigator…”)"),
    details: { label: "context-gathered", entryId: "e1", contextTokens: 41000 },
  });
  tool({ action: "list" }, list);
  tool({ action: "pin", kind: "decision", text: "Ledger rows render dim, one line collapsed, so the transcript stays readable on a phone." }, {
    ...text("[pin] D4 decision recorded"),
    details: { id: "D4", kind: "decision", effect: "added", rev: 3 },
  });
  tool({ action: "pin", kind: "file", path: "extensions/navigate-tree/tool-renderer.ts", lines: "40-90", why: "row builders" }, {
    ...text("[pin] P1 file recorded"),
    details: { id: "P1", kind: "file", effect: "added", rev: 4 },
  });
  tool({ action: "rewind", rewindTo: "context-gathered", newLabel: "analysis-complete", summaryFocus: "x" }, {
    ...text("Rewind accepted."),
    details: { status: "summary-requested", rewindTo: "context-gathered", newLabel: "analysis-complete" },
  });
  tool({ action: "rewind", rewindTo: "nope", newLabel: "done" }, {
    ...text("No label 'nope' on the active branch. Use action='list' to see available labels."),
    details: { refusal: true },
  }, true);
  out.push(theme.muted("  expanded (ctrl+o):"), "");
  tool({ action: "list" }, list, false, true);
  out.push(theme.muted("  ledger entries (host adds the blank above):"));
  ledger([rule1, decision]);
  ledger([{ op: { op: "add", kind: "fact", text: "The sidecar needs Node 22.18 or newer" }, ctx: { origin: "agent" } }]);
  ledger(Array.from({ length: 10 }, (_, i) => ({ op: { op: "add", kind: "fact", text: `captured fact number ${i + 1}` }, ctx: user })));
  out.push("", theme.muted("  expanded:"));
  ledger([
    rule1,
    decision,
    { op: { op: "supersede", ids: ["D1"], with: { kind: "decision", text: "Use SQLite", quote: "actually, sqlite" } }, ctx: user },
    { op: { op: "archive", id: "T1" }, ctx: { origin: "agent" } },
  ], true);
  out.push("");
  return out.join("\n");
}

function renderCliAndTranscriptShowcase(width) {
  const rule = theme.borderAccent("─".repeat(width));
  return [
    rule,
    `${theme.bold("6. CLI Typography (opencode2 style) & Interactive Hybrid Wizard")}`,
    rule,
    "",
    `${theme.bold("DESCRIPTION")}`,
    `  Inspect, propose, preview, or clone a structured session tree with preserved continuity`,
    "",
    `${theme.bold("USAGE")}`,
    `  ${theme.accent(theme.bold("agent anchor"))} ${theme.accent("<subcommand>")} ${theme.muted("[target] [flags]")}`,
    "",
    `${theme.bold("SUBCOMMANDS")}`,
    `  ${theme.accent("tree")}      ${theme.muted("[session]")}          Browse chronological phase & anchor containment tree`,
    `  ${theme.accent("list")}      ${theme.muted("[session]")}          Show active-branch anchors, token share, and savable tokens`,
    `  ${theme.accent("current")}   ${theme.muted("[session]")}          Print active continuity ledger (goals, rules, decisions, files)`,
    `  ${theme.accent("clone")}     ${theme.muted("<action> [path]")}    Guided retrospective session restructuring (inspect|propose|preview|create)`,
    `  ${theme.accent("settings")}  ${theme.muted("[key] [value]")}      Inspect or update global/project tree-navigator config`,
    "",
    `${theme.bold("INTERACTIVE WIZARD (agent anchor clone propose)")}`,
    `  ${theme.dim("┌")}  ${theme.bold("agent anchor clone propose")}`,
    `  ${theme.dim("│")}`,
    `  ${theme.success("◆")}  ${theme.text("Source session")}`,
    `  ${theme.dim("│")}  ${theme.muted("~/…/sessions/2026-10-21_pi-tree-navigator.jsonl · 142 entries · 312.4k tok")}`,
    `  ${theme.dim("│")}`,
    `  ${theme.success("◆")}  ${theme.text("Refinement mode")}`,
    `  ${theme.dim("│")}  ${theme.muted("Model-assisted (openai-codex/gpt-5.4 · high) + Jev intent tags")}`,
    `  ${theme.dim("│")}`,
    `  ${theme.accent("●")}  ${theme.bold("Review proposed phase structure (4 phases, −78.2% active context)")}`,
    `  ${theme.dim("│")}  ${theme.accent("❯")} ${theme.success("▣")} 1. Orientation & Invariants     ${theme.muted("(e_001..e_034 · folded · 18 msgs)")}`,
    `  ${theme.dim("│")}    ${theme.success("▣")} 2. Adaptive Budget Recovery     ${theme.muted("(e_035..e_089 · folded · 41 msgs)")}`,
    `  ${theme.dim("│")}    ${theme.success("▣")} 3. Retrospective Clone Engine   ${theme.muted("(e_090..e_126 · folded · 62 msgs)")}`,
    `  ${theme.dim("│")}    ${theme.warning("◐")} 4. UI/UX & Continuity Redesign  ${theme.muted("(e_127..e_142 · open   · 16 msgs)")}`,
    `  ${theme.dim("│")}`,
    `  ${theme.dim("│")}  ${theme.bold("enter")} ${theme.dim("save & preview")}  ${theme.bold("space")} ${theme.dim("toggle fold/open")}  ${theme.bold("e")} ${theme.dim("edit title/report")}  ${theme.bold("esc")} ${theme.dim("cancel")}`,
    `  ${theme.dim("└")}`,
    "",
    rule,
    `${theme.bold("7. Transcript Tool Rows & Handoff Cards (renderShell: \"self\", zero background slabs)")}`,
    rule,
    "",
    `${theme.success("●")} ${theme.bold("navigate_tree")} anchor ${theme.accent("\"context-gathered\"")} ${theme.dim("·")} ${theme.muted("22.7% (84.4k / 372k)")}`,
    `  ${theme.dim("⎿")}  Anchored after ${theme.muted("\"Analyze our pi-tree-navigator and present me…\"")} ${theme.dim("·")} ${theme.muted("3 rules pinned")}`,
    "",
    `${theme.success("●")} ${theme.bold("navigate_tree")} rewind ${theme.dim("→")} ${theme.accent("\"context-gathered\"")} as ${theme.accent("\"analysis-complete\"")} ${theme.dim("·")} ${theme.muted("30.8% → 22.7% (−30.1k tok)")}`,
    `  ${theme.dim("⎿")}  ${theme.bold("▣ Work handoff: analysis complete")} ${theme.dim("·")} ${theme.muted("18 messages · 7 tool calls · in 84.4k / out 1.9k · $0.0412")}`,
    `     ${theme.muted("Goal:")}     Analyze pi-tree-navigator tools, slash commands, and UX/UI.`,
    `     ${theme.muted("Outcome:")}  Full surface inventory completed; identified flag-style clone command UX friction.`,
    `     ${theme.muted("Ledger:")}   ${theme.success("✔")} 1 objective · ${theme.success("✔")} 3 user rules kept · ${theme.warning("↻")} 1 steering note archived · 2 open tasks`,
    `     ${theme.dim("ctrl+o or click to expand full report, ledger diff & 7 read files")}`,
    "",
    renderLiveRows(width),
  ].join("\n");
}

const widthArgIdx = argv.indexOf("--width");
const termWidth =
  widthArgIdx >= 0 && argv[widthArgIdx + 1]
    ? Number.parseInt(argv[widthArgIdx + 1], 10)
    : Math.min(104, Math.max(68, stdout.columns || 92));

if (argv.includes("--all") || !stdin.isTTY || !stdout.isTTY) {
  for (const screen of SCREENS) {
    stdout.write(`\n${theme.bold(screen.title)}\n`);
    stdout.write(renderFrameScreen({ width: termWidth, ...screen.frame }) + "\n");
  }
  stdout.write("\n" + renderCliAndTranscriptShowcase(termWidth) + "\n");
  process.exit(0);
}

// Interactive TUI mode
let screenIdx = 0;
let cursor = 0;
let query = "";
let searching = false;

function draw() {
  stdout.write("\x1b[2J\x1b[H");
  const tabs = SCREENS.map((s, idx) =>
    idx === screenIdx ? theme.bold(theme.accent(`[${idx + 1}:${s.id}]`)) : theme.muted(` ${idx + 1}:${s.id} `),
  ).join(" ");
  stdout.write(`${theme.bold("pi-tree-navigator UI/UX Interactive Prototype")}  ${tabs}\n`);
  stdout.write(
    `${theme.dim("Keys: 1-5 or ←/→ switch screen · ↑/↓ move cursor · / filter · a print all · q/ctrl+c quit")}\n\n`,
  );
  const current = SCREENS[screenIdx];
  stdout.write(
    renderFrameScreen({
      width: Math.min(108, Math.max(64, stdout.columns || 92)),
      ...current.frame,
      cursor,
      query,
    }) + "\n",
  );
}

stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");
draw();

stdin.on("data", (key) => {
  if (key === "\x03" || (!searching && key === "q")) {
    stdout.write("\x1b[0m\n");
    process.exit(0);
  }
  if (!searching && key === "a") {
    stdin.setRawMode(false);
    for (const screen of SCREENS) {
      stdout.write(`\n${theme.bold(screen.title)}\n`);
      stdout.write(renderFrameScreen({ width: termWidth, ...screen.frame }) + "\n");
    }
    stdout.write("\n" + renderCliAndTranscriptShowcase(termWidth) + "\n");
    process.exit(0);
  }
  if (searching) {
    if (key === "\x1b" || key === "\r" || key === "\n") {
      searching = false;
      if (key === "\x1b") query = "";
    } else if (key === "\x7f" || key === "\b") {
      query = query.slice(0, -1);
      cursor = 0;
    } else if (key.length === 1 && key >= " " && key <= "~") {
      query += key;
      cursor = 0;
    }
    draw();
    return;
  }

  if (key === "/") {
    searching = true;
    draw();
  } else if (key >= "1" && key <= String(SCREENS.length)) {
    screenIdx = Number(key) - 1;
    cursor = 0;
    query = "";
    draw();
  } else if (key === "\x1b[C") {
    screenIdx = (screenIdx + 1) % SCREENS.length;
    cursor = 0;
    query = "";
    draw();
  } else if (key === "\x1b[D") {
    screenIdx = (screenIdx - 1 + SCREENS.length) % SCREENS.length;
    cursor = 0;
    query = "";
    draw();
  } else if (key === "\x1b[A") {
    cursor = Math.max(0, cursor - 1);
    draw();
  } else if (key === "\x1b[B") {
    cursor = Math.min(SCREENS[screenIdx].frame.rows.length - 1, cursor + 1);
    draw();
  } else if (key === "\x1b") {
    if (query) {
      query = "";
      draw();
    } else {
      stdout.write("\x1b[0m\n");
      process.exit(0);
    }
  }
});
