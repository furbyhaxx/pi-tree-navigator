---
version: 1
id: alignment-acceptance-tui-report
title: TUI acceptance pass for the toolchain/strict-index refactor
description: Live Pi-Bolt pass of every /anchor surface at 36, 57, 60, 80, 130 and 140 columns on branch refactor/align-toolchain (2d8d135), with main (b95fb8a) as the regression baseline.
type: analysis
created: 2026-10-26T17:53:23+01:00
updated: 2026-10-26T18:11:54+01:00
createdBy: analyst
updatedBy: analyst
---

# TUI acceptance pass for the toolchain/strict-index refactor

status: "qa-complete"
confidence: "high"

## Summary

All `/anchor` surfaces render and respond correctly on `refactor/align-toolchain` (2d8d135)
at 36, 57, 60, 80, 130 and 140 columns, including the split settings screen, the split fold
plan, the moved tool renderer and the strict-index guards. No regression against main
(b95fb8a) was found. Four defects do reproduce on main as well: narrow-width truncation that
lets two long anchor labels look identical, Space starting a search instead of toggling a
setting, letter shortcuts shadowing type-to-filter, and tool rows that omit the documented
header glyph/name. Report them as pre-existing UI debt, not refactor fallout.

## Reproduction

Machine: local Linux, tmux 3.x, Pi-Bolt 1.4.0 (Pi-Bolt 1.0.3). Model
`openrouter/~anthropic/claude-haiku-latest` with `--thinking low`; only a handful of live
turns plus three summary calls. Disposable synthetic sessions only.

Under test (branch `refactor/align-toolchain`, HEAD 2d8d135):

```sh
S=$(mktemp -d /tmp/ptn-alignment-qa-XXXXXX)
mkdir -p "$S/agent" "$S/workspace" "$S/sessions2"
ln -s ~/.pi/agent/auth.json "$S/agent/auth.json"
ln -s ~/.pi/agent/models.json "$S/agent/models.json"
printf '%s' '{"quietStartup":true,"theme":"dark","tuiMode":"fullscreen","thinking":"low","compaction":{"enabled":false}}' > "$S/agent/settings.json"
tmux new-session -d -s ptn-qa -x 130 -y 45 -c "$S/workspace" \
  "env PI_CODING_AGENT_DIR=$S/agent PI_OFFLINE=1 pi-bolt --offline --no-extensions \
   --no-context-files --no-skills --no-prompt-templates \
   -e /mnt/Projects/furbyhaxx/pi-tree-navigator/src/index.ts \
   --model 'openrouter/~anthropic/claude-haiku-latest' --thinking low \
   --tools navigate_tree --session-dir $S/sessions2 --tui-mode fullscreen --name alignment-qa2"
```

`--no-extensions` prevents a second copy of the installed package from loading; the explicit
`-e` path still registers. The scratch agent dir keeps `~/.pi` untouched (auth and models are
symlinks, settings are a throwaway file). `autoNavigate` was left at its default `false`.

Baseline (main, b95fb8a): the pre-existing worktree `/tmp/ptn-main`, launched the same way
with `-e /tmp/ptn-main/extensions/navigate-tree/index.ts`. `git worktree add /tmp/ptn-main
main` failed because that worktree already existed before this run; it was left untouched.

Captures: `.project/analyses/alignment-acceptance/captures/` (`tmux capture-pane -ep`),
109 files. All claims below cite a capture or the session JSONL.

## Test matrix

| Surface | 36 | 57 | 60 | 80 | 130 | 140 | Notes |
|---|---|---|---|---|---|---|---|
| `/anchor` hub | pass `76` | pass `81` | pass `61` | pass `84` | pass `03` | pass `86` | 36: breadcrumb loses `Anchor` (D1) |
| `tree`: rows, nav, `f` filter, Enter details | pass `75` | pass `82` | pass `60` | pass `85` | pass `04`,`08`,`09`,`43`,`44`,`45` | pass `87` | handoff row + card details verified |
| `list`: rows, Enter, create anchor | pass `77` | pass `81` | pass `62` | - | pass `11`,`13`,`14`,`46` | - | creation is Enter on `+ Set new anchor…`, not `n` |
| `current`: ledger row, Enter details | pass `78` | - | pass `63` | - | pass `16`,`17`,`47` | - | ledger survives the fold |
| `fold` plan: open, `e` label, focus editor, Esc cancel | pass `80` | - | pass `70` | - | pass `32`,`33`,`34`,`35`,`36`,`37` | - | edited label/focus shown in the block |
| `fold` run: progress, cancel, result, footer | - | - | pass `71`,`72`,`73`,`74` | - | pass `38` | - | footer 2.4%→0.4% (130), 3.3%→0.4% (60) |
| `settings`: rows, enum, boolean, scalar, groups | pass `79` | pass `83` | pass `65` | - | pass `48`,`104`-`116` | pass `88` | tools and model_overrides submenus open |
| model picker / policy editor | - | - | pass `66`,`67` | - | pass `49`,`50`,`51`,`52` | - | Esc cancel stages nothing |
| stage / discard / `/anchor settings show` | - | - | - | - | pass `53`-`57` | - | `1 staged` badge, discard prompt |
| `clone` menu + inspect small session | - | - | pass `68` | - | pass `58`,`59` | - | "Inspected …: 123 entries and 40 user turns" |
| `navigate_tree` list/anchor rows, rewind receipt | - | - | - | - | pass `30`,`89`,`101` | - | expanded output via Ctrl+O |
| Ctrl+O expansion toggle | - | - | - | - | pass `41`,`42`,`102` | - | toast `Tool output: expanded/collapsed` |

Widths follow AGENTS.md "TUI widths" (36, 57, 80, 140) plus the 60/130 that
`docs/verification.md` requires for plan/progress/result cards.

## Defects (all reproduce on main; none are regressions)

### D1 — narrow widths cut the context badge and can merge two anchor names (minor)

- Steps: `/anchor tree` at 60 columns with two long anchors (`qa-milestone-folded`,
  `qa-milestone-folded-folded`); `/anchor list` at 36.
- Expected (AGENTS.md "Narrow terminals"): anchor identity (label plus context %) survives
  every width.
- Actual: badge truncates to `ctx 0.4% of 1.…` at 60 and `…` at 57; at 36 both anchors render
  as `◆ qa-milestone-…`, so the two rows are indistinguishable. Breadcrumb loses its root
  (`…hor/Tree`, `…hor/List`).
- Evidence: `captures/60-tree-60.txt`, `75-tree-36.txt`, `77-list-36.txt`, `82-tree-57.txt`.
- Baseline: same truncation on main — `91-main-hub-36.txt`, `92-main-list-36.txt`,
  `93-main-list-long-label-36.txt` (`◆ qa-milestone-…`), `95-main-tree-60.txt`
  (`ctx 0.3% of 1…`). Suspected file: `src/ui/frame-rendering.ts` (badge/breadcrumb budget).

### D2 — Space in `/anchor settings` starts a search instead of toggling (minor)

- Steps: settings, move to `continuity.capture`, press Space.
- Expected (AGENTS.md "Uniform semantics"): Space toggles.
- Actual: the search field opens with a single space; the value is unchanged.
- Evidence: `captures/107-settings-boolean-space-130.txt`; baseline `108-main-settings-space-130.txt`
  shows the same. Cause: `src/ui/frame.ts:250-264` treats Space as printable before any
  toggle shortcut exists. Enter and Right do toggle.

### D3 — single-letter shortcuts shadow type-to-filter (minor)

- Steps: settings top screen, type `treeProposal.tools` to filter.
- Expected (AGENTS.md "Lists are searchable"): typing filters.
- Actual: the leading `t` triggers the layer switch, so the screen moves to
  `target: project` and the remaining text is lost; `/` plus the same text filters correctly.
  Same ordering in `src/ui/frame.ts:250-255`; identical code on main
  (`/tmp/ptn-main/extensions/navigate-tree/frame.ts:630-638`).
- Evidence: `captures/110-settings-filtered-130.txt`, `111-settings-tools-group-130.txt`.

### D4 — tool rows do not use the documented header grammar (cosmetic, pre-existing)

- Collapsed `navigate_tree` rows render as ` list` / ` anchor qa-milestone` (a title on a
  filled slab) without the `● navigate_tree … · metrics` header from the UI skill; the rewind
  row is ` rewind qa-milestone-folded → qa-tool-fold` with a focus note, and its receipt is
  the raw `[navigate_tree] Rewind to … accepted …` text.
- A tool-initiated rewind is queued after the turn, so its result carries no handoff metrics;
  the handoff numbers appear only in `/anchor tree` details.
- Evidence: `captures/101-transcript-rewind-row-130.txt`, `89-tool-rows-expanded-130.txt`;
  baseline `90-main-tool-rows-130.txt` is identical. Registration itself works (rows appear
  after the move to `src/tool`). Suspected files: `src/tool/navigate-tree-tool.ts`
  (`renderShell` not set) and `src/ui/tool-renderer.ts` (header composed by pi, not the
  renderer).

### Brief inaccuracy (not a defect)

The brief says `list` creates an anchor with `n`. No `n` shortcut exists on either branch
(`openAnchorList` binds only `r`); pressing `n` opens the filter, here selecting
`+ Set new anchor at current leaf…`. Creation via Enter → input works (`captures/13`, `14`).

## Evidence details worth knowing

- Real folds reduce and report honestly: 130-col run `~24.0k → ~12.5k` plan, result
  `✓ folded as 'qa-milestone-folded' · freed ~20.6k tok (now ~3.4k) · in-context · 1 call`,
  footer `2.4% → 0.4%` (`38-fold-result-130.txt`); 60-col run `~32.8k → ~13.0k` plan,
  result `freed ~28.7k tok (now ~4.0k)`, footer `3.3% → 0.4%`
  (`70-fold-plan-60.txt`, `74-fold-result-60.txt`). The plan's after-token estimate is ~4x
  the observed after value; that is engine math behind `openState`, not a rendering change,
  so it is recorded as an observation, not a regression.
- Cancelling a running fold shows `■ cancelled — nothing was changed` with
  `enter back to plan / esc close` (`72-fold-cancelled-60.txt`); re-running the fold from the
  same panel succeeds.
- Esc in the fold plan before starting returns to the editor leaving tokens and anchors
  unchanged (`36-fold-plan-escaped-130.txt`).
- Staged-settings flow is intact: `1 staged · target: global`, `discard staged changes?` with
  Yes/No, `u unstage`, enum cycles `digest → full`, boolean `true → false`, scalar
  `off → 1k` (`53`–`56`, `105`, `106`).
- Ledger rows and the `ledger · +rule …` custom entry render at every width tested; the
  continuity rule survived two folds.
- `/anchor clone inspect` on a small synthetic session prints
  `Inspected "alignment-qa": 123 entries and 40 user turns.`
- No `/anchor` screen panicked or emitted stack traces; no strict-index `undefined` row
  artifacts were observed.

## Open questions / follow-ups

- G1: the plan's projected after-tokens (12.5k) versus actual (3.4k) deserves an engine-level
  check; only two data points here.
- G2: `docs/verification.md` asks for plan/progress/cancellation/result cards at 60 and 130.
  All were driven, but the intermediate "cancelling" frame was not captured before the abort
  completed; only the cancelled result card exists at 60.
- G3: `Space toggles` (AGENTS.md) and type-to-filter are contradicted by the frame's key
  handling on both branches. Either the frame should let Space/letters through to the search
  only after `/`, or the docs should state the shortcut precedence.
- G4: during the run another process appended 99 lines to
  `.project/analyses/classifier-eval/budget-ledger.jsonl` and created its `.lock`; not mine,
  untouched.

## Cleanup

tmux sessions `ptn-qa` and `ptn-main` killed; the `mktemp` scratch directory, its synthetic
sessions, the copied small session file and the temporary prompt files were deleted. The
pre-existing worktree `/tmp/ptn-main` was not created by this run and was left in place.
Project sources were not modified.
