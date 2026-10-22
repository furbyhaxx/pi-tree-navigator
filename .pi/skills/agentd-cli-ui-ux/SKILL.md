---
name: agentd-cli-ui-ux
description: Authoritative UI, UX, typography, ANSI styling, command alias grammar, ID-or-name resolution, interactive Clack/Frame hybrid terminal wizards, output tables/trees/cards, and structured log formatting standards for agentd CLIs (agentctl / agent and offline session tools like restructure-session). Load whenever adding, modifying, reviewing, or testing CLI commands, help screens, prompts, wizards, output tables/trees, or logs.
---

# agentd & CLI UI/UX Design Standard

Authoritative design system and interaction contract for `agentd` command-line tools (`agentctl` / `agent` and standalone session/tree CLIs such as `restructure-session`). Grounded in `opencode2` CLI typography, `pi-bolt-subagents/src/ui/frame.ts`, and Pi 1.0 terminal ergonomics.

## 1. Typography & Colour Hierarchy (`opencode2` Grammar)

Never emit flat, unstyled help or output on a colour-capable TTY. Degrade cleanly under `NO_COLOR`, `TERM=dumb`, non-TTY pipes, and `--json` (which emits strict machine-readable JSON/NDJSON with zero ANSI).

| Role | ANSI / Token | Visual Rule & Usage |
|---|---|---|
| Section header | `bold` UPPERCASE | `DESCRIPTION`, `USAGE`, `ALIASES`, `ARGUMENTS`, `FLAGS`, `GLOBAL FLAGS`, `SUBCOMMANDS`, `EXAMPLES` |
| Command / subcommand | `cyan` (`bold cyan` in `USAGE`) | `agent anchor fold <target>`, `tree, outline` |
| Flag / positional name | `green` | `--model, -m`, `--llm`, `target` |
| Type / choice / default | `muted` (`#8a8f98` / 256-col `245`) | `<id\|name>`, `string`, `(default: full)`, `(optional)` — **never** emit raw `\x1b[2m` (SGR 2 is unreadable on mobile SSH) |
| Primary value / subject | `text` (or `bold` for primary key) | `impl-start`, `furbyhaxx/pi-tree-navigator` |
| Secondary metadata | `muted` | durations (`2m 14s`), token counts (`38.4k`), percentages (`12.0%`), shortened paths |
| Chrome & connectors | `dim` (`#5c6068` / 256-col `240`) | ` · `, `─`, `│`, `├─`, `└─`, `⎿`, `◆`, `◇` |
| Semantic state | **Glyph + colour + word** | `✔`/`▣` `green` (`done`), `●`/`▶` `cyan` (`active`), `◐` `yellow` (`partial`), `✗`/`☒` `red` (`failed`), `⚠` `yellow` (`warn`) |

### Help Layout Contract
Every `--help` screen uses a 2-space body indent and aligned two-column rows (`valueColumn = min(42, longestLabel + 4)`):

```text
DESCRIPTION
  Inspect, propose, preview, or clone a structured session tree

USAGE
  agent tree <subcommand> [session|plan] [flags]

ALIASES
  agent anchor clone, agent session restructure

SUBCOMMANDS
  inspect [session]    Inspect session graph, turns, anchors, and SHA-256
  propose [session]    Derive a reviewable phase/handoff plan (heuristic or --llm)
  preview [plan]       Validate and preview fold savings, handoffs, and descendants
  create  [plan]       Materialize a verified clone without modifying the source

FLAGS
  -m, --model <provider/id:thinking>    Run LLM-assisted proposal with explicit model
      --llm                             Refine heuristic tree with current model
  -o, --output <path>                   Output path for proposed plan.json
      --tool-mode <tool=full|calls|omit> Per-tool disclosure rule (repeatable)
      --wizard                          Force interactive step-by-step wizard
      --json                            Emit machine-readable JSON
```

## 2. Forgiving Aliases & Human-First Identifiers

1. **Singular/Plural & Verb Synonyms:**
   - Nouns accept both singular and plural (`anchor`/`anchors`, `session`/`sessions`, `task`/`tasks`, `workspace`/`workspaces`/`ws`, `project`/`projects`/`prj`, `worktree`/`worktrees`/`wt`).
   - Verbs accept standard synonyms: `list`/`ls`, `show`/`get`/`info`/`inspect`, `create`/`add`/`new`, `delete`/`rm`/`clean`, `fold`/`rewind`.
   - Unknown commands within edit distance ≤ 2 print `Did you mean '<match>'?`.
2. **Name-or-ID Resolution Everywhere:**
   - Every target argument accepts **either** the human slug/label (`context-gathered`, `impl-parser`) **or** the opaque ID (`e_8f2a`, `sess_01jq`).
   - Exact ID matches first → exact name/label → unique prefix → case-insensitive match.
   - If ambiguous, print a compact disambiguation table in non-TTY mode or open an inline selector in TTY mode.

## 3. Interactive CLI Wizards (Clack / Frame Hybrid)

When invoked in an interactive TTY (`process.stdout.isTTY && !flags.json`) with missing required arguments or `--wizard`, launch a step-by-step vertical rail wizard instead of failing with a usage error:

```text
┌  agent tree propose
│
◆  Source session
│  ~/…/sessions/2026-10-21_pi-tree-navigator.jsonl · 142 entries · 312k tok
│
◆  Analysis mode
│  Model-assisted (--llm · openai-codex/gpt-5.4:high)
│
●  Tool disclosure policy
│  ❯ ◉ Standard   bash: calls-only · read: omit · others: full (recommended)
│    ◯ Strict     all tools: calls-only (no tool outputs sent)
│    ◯ Full       send all tool calls and results
│    ◯ Custom     configure per tool…
│
│  Estimated payload: 48.2k tok across 1 request (~$0.06)
│  ↑↓ move · space/enter confirm · esc cancel
└
```

### Wizard Rules
- **Rail glyphs:** `┌` header, `│` connector in `dim`, `◆` completed step (`green`), `●` active step (`cyan`), `◇` pending step (`dim`), `└` footer.
- **Completed steps collapse** to two lines: `◆  <Label>` and `│  <muted summary>`.
- **Active step** renders inline search/filter when options > 6, plus a bottom hint line (`↑↓ move · enter confirm · esc cancel`).
- **Cancellation:** `Esc` restores terminal state, prints `└  Cancelled (no files written)`, and exits `0`. `Ctrl+C` exits `130`.

## 4. Tables, Trees, Cards & Structured Logs

- **Borderless Tables (`list`):** Uppercase `dim` headers, 2-space column gap, no ASCII box grids, right-aligned numbers (`tok`, `%`, `cost`), middle-truncated paths (`~/…/file.jsonl`).
- **Containment & Ledger Trees (`tree`, `briefing`):** `├─` / `└─` / `│  ` connectors in `dim`, state badge first, name in `bold`, metadata after ` · ` in `muted`.
- **Structured Log Renderer (`logs`):**
  Render NDJSON spans as aligned human rows when `--json` is off:
  `22:14:03.118  INFO  anchor.fold     anchor=impl-start label=impl-done before=118.4k after=19.2k saved=83.8%`
  `22:14:04.002  WARN  budget.reserve  left=42.1k reserve=50.0k action=hint-emitted`
