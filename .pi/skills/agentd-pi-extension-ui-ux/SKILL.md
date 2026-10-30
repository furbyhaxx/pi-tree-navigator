---
name: agentd-pi-extension-ui-ux
description: Authoritative TUI, slash-command (/anchor), editor-replacing FrameList panel, transcript tool/entry renderer, above-editor status widget, and keyboard/mouse UX standard for agentd Pi extensions and pi-tree-navigator. Load whenever designing, implementing, reviewing, or testing Pi extension commands, panels, cards, or renderers.
---

# agentd Pi Extension UI/UX Design Standard

Authoritative terminal UI/UX standard for `pi-tree-navigator` and `agentd` Pi extensions. Grounded in `pi-bolt-subagents/src/ui/frame.ts`, Pi 1.0's `/settings`, and `extending-pi-agent`.

## 1. Non-Negotiable Visual Rules

1. **Theme Tokens Only:** Always style through `theme.fg`, `theme.bg`, and `theme.style` using semantic tokens (`text`, `muted`, `dim`, `accent`, `borderAccent`, `border`, `success`, `warning`, `error`, `selectedBg`, `customMessageBg`, `customMessageLabel`, `customMessageText`, `toolTitle`, `toolOutput`). Never emit raw `\x1b[2m` or hardcoded ANSI escapes.
2. **Strict Width Budgeting (60 to 200+ cols):** Measure with `visibleWidth`, clip with `truncateToWidth`, wrap with `wrapTextWithAnsi`, slice with `sliceByColumn`. Every rendered line must be `<= width`.
3. **Status = Glyph + Colour + Word:** Never rely on colour alone (`● active`, `▣ folded`, `◆ pinned`, `⚠ near reserve`, `✗ failed`).
4. **Zero-Row Discipline:** Above-editor widgets return `[]` when there is nothing actionable to surface.
5. **No Raw JSON Editor Dumps for Normal Workflows:** Never dump `JSON.stringify(..., null, 2)` into `ctx.ui.editor()` for inspection, previews, or settings. Use `FrameList` screens with structured rows, and offer `e edit raw JSON` only as an explicit power-user escape hatch.

## 2. Unified Editor-Replacing Frame Layout (`FrameList`)

Every slash command screen (`/anchor`, `/agents`, `/tasks`, `/jobs`, `/settings`) renders inside one unified `FrameList` component via `ctx.ui.custom()`:

```text
─ Anchor / Tree ─────────────── ↑ 3 more ──────────── 38.4% of 372k (auto) ─
 ❯ Type to search anchors, phases, or ledger items…

 → ▾ ◐ Phase 2: Ledger & Fold Continuity (open)             +41.2k · 14 turns
     ├─ ◆ anchor:context-gathered                           22.7% · 84.4k tok
     │    ↳ "Analyze our pi-tree-navigator and present me…" · 3 constraints
     └─ ● [current] Designing /anchor UI & continuity       38.4% · 142.8k tok
   ▸ ▣ Phase 1: Initial Repository Orientation (folded)      12.4k · $0.0840

   Open phase containing 1 anchor and the active leaf. Enter toggles, r rewinds.
 ↑↓ navigate  enter toggle/open  r rewind here  n new anchor  f2 raw  esc back
─────────────────────────────── ↓ 4 more ───────────────────────────────────
```

### Frame Anatomy & Frozen Geometry Contract
- **Top Border:** `─ {Breadcrumb1}/{Breadcrumb2} ─── ↑ N more ─── {rightContextBadge} ─` in `borderAccent`. Parents in `muted`, active leaf in `bold`, scroll indicator `↑ N more` centred in `dim`, optional right status badge (`● 2 staged` in `warning` or context meter in `muted`).
- **Search Input Row:** ` ❯ <query>` with placeholder `Type to search…` in `dim italic`. Fuzzy-matches across label, summary preview, constraints, and tags. `Esc` clears search first; second `Esc` pops the screen stack.
- **Body Rows (Frozen Height):**
  - Computed once when the screen opens (and on terminal resize): `height = min(cap, chrome + contentRows + maxSelectedExpansion)`.
  - Filtering to fewer items pads with blank lines so the panel **never jumps vertically**.
  - Cursor prefix is 3 columns: ` → ` in `accent` when selected, `   ` when unselected.
  - Two-column `valueColumn` is computed from the **entire unfiltered list** (`min(width, 3 + min(longestLabel, floor(width * 0.45)) + 2)`), preventing horizontal column jitter while scrolling.
  - Selected row may expand 1–2 `   ↳ ...` detail rows already reserved in `measureFrame()`.
- **Description Slot:** Fixed 1–2 rows in `dim` (separated by one blank row above) showing contextual help for the highlighted row or inline validation errors (`✗ …` in `error`).
- **Keybinding Footer Row:** ` {bold key} {dim action}` pairs separated by two spaces (`↑↓ navigate  enter select  ←→ change  esc back`), derived from the active focus mode.
- **Bottom Border:** `─────────────────── ↓ N more ───────────────────` in `borderAccent` with centred `↓ N more` in `dim`.

## 3. Tool & Transcript Rendering (`renderShell: "self"`)

All extension tools (`navigate_tree`) and custom transcript entries render without default background slabs (`renderShell: "self"`):

```text
● navigate_tree anchor "context-gathered" · 22.7% (84.4k / 372k)
  ⎿  Anchored after "Analyze our pi-tree-navigator…" · 3 active constraints pinned

● navigate_tree rewind → "context-gathered" as "analysis-complete" · 30.8% → 22.7% (−30.1k tok)
  ⎿  ▣ Work handoff: analysis complete · 18 msgs · 7 tools · $0.0412
     Goal: Analyze pi-tree-navigator tools, slash commands, and UX/UI.
     Outcome: Inventory complete; 2 CLI/parser sharp edges identified.
     Ledger: 1 overall goal · 2 active constraints · 1 next step preserved
     click or ctrl+o to expand full handoff & file operations
```

### Transcript Rules
- **Call Line:** `<state glyph> <bold tool name> <primary action/target> · <muted metrics>`
- **State Glyphs:** `⠋` (`accent` braille spinner while running/summarizing), `●` (`success` when complete), `●` (`error` when refused/failed), `●` (`warning` when aborted).
- **Body Indentation:** 2 spaces + `⎿  ` in `dim` on the first line; 5 spaces on continuation lines.
- **Collapsed vs Expanded:** Collapsed cards show at most 4 summary lines (Title/stats, Goal, Outcome, Ledger continuity) + `ctrl+o to expand`. Expanded view renders full Markdown sections, child handoffs, and `<read-files>` / `<modified-files>`.

## 4. Settings Screen Contract (`/anchor settings`)

- Every setting in `tree-navigator.json` is an interactive row in `FrameList` (`←→` cycles values, `Enter` edits, Alt+d or `⌫` inherits from the lower scope). Printable keys always filter.
- Settings open in Session scope. Save/apply and scope selection are ordinary searchable action rows, reachable with arrows and Enter; Alt shortcuts are optional accelerators.
- Edits stage in memory and commit via a framed scope picker: Session (in memory), Global or trusted Project. Count pending edits independently of the selected target so switching scope cannot hide unsaved work.
- Pause/resume automatic folding is an immediate session-only action, independent of staged settings and per-model enablement. Recovery, capture, hints, start anchors and manual/tool folds remain active; reload/session switch clears the pause.
