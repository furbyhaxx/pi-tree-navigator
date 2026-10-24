---
version: 4
id: "handoff-consolidation-proposal"
title: "Continuous consolidation of older handoffs"
description: "Decision material for letting completed work fade from active context instead of accumulating as verbatim handoffs."
type: "plan"
created: "2026-10-24T01:12:10+02:00"
updated: "2026-10-24T15:09:40+02:00"
createdBy: "agent"
updatedBy: "agent"
---

# Continuous consolidation of older handoffs

## Problem

Handoff weight on active branches only grows.

| Session | Handoffs on branch | Tokens | Share of context |
|---|---|---|---|
| pi-me | 12 | ~59k | 20% |
| agentd-ts | 3 | ~73k | 18%, one handoff is 275k characters |

Two mechanisms cause it:

1. **Nested re-embedding.** In the default `parentHandoffMode: "full"`,
   `materializeHandoff` (`handoff.ts`) appends every child handoff inside the
   folded span verbatim under "Child handoffs in chronological order". A fold
   over earlier folds therefore carries all of them again, recursively. This is
   the 275k-character case.
2. **Prefix accumulation.** Handoffs before the fold target are never touched.
   Folds usually target a recent anchor, so older handoffs pile up as siblings
   in the retained prefix (the pi-me case).

`synthesized` mode already fixes (1) for users who opt in: the parent report
replaces the children. Nothing addresses (2).

## Proposal: two slices

```
slice 1 (now)   fold materialization: children become a digest, not verbatim
slice 2 (next)  background prefix consolidation: old handoffs merge into one
```

### Slice 1: `digest` child materialization

- New `parentHandoffMode: "digest"`, proposed as the new default.
- The summarizer still sees the full child reports as evidence (unchanged), so
  the parent report can carry what still matters.
- Materialization keeps the parent report plus one bounded line per child:
  `title · goal · outcome · entry id`. Children stay on disk and reachable
  through `/anchor tree` and the archived branch.
- Deterministic, no extra model call, no new commit shape. Existing handoffs
  keep their frozen mode; only new folds use the new default.
- Expected effect: a fold over N earlier handoffs costs ~parent + N×~60 tokens
  instead of parent + the sum of all child reports.

### Slice 2: background prefix consolidation

- Trigger: retained handoffs in the active prefix exceed a budget (proposed:
  more than 4 handoffs or more than 10% of the window), checked at idle or
  turn boundaries, never mid-tool-batch.
- Operation: one side call merges the oldest handoffs (all but the newest K,
  proposed K=2) into one "project history" handoff. Active continuity ledger,
  open user requests and pinned items are carried deterministically, as in
  every fold.
- Commit: branch from the anchor before the oldest merged handoff, write the
  consolidated handoff, then replay the untouched tail entries in order. This
  is a new commit shape ("prefix rewrite + tail replay"). It needs the same
  envelope, persistence and non-reduction gates as folds, and a refusal path.
- Opt-in initially, like milestone auto-folding.

## Options

| Option | Fixes | Cost / risk | Effort |
|---|---|---|---|
| A. Default to existing `synthesized` | (1) | Loses child detail in context; quality depends on one report | trivial |
| B. Slice 1 `digest` default | (1) | Child detail reduced to one line each; deterministic | small |
| C. Slice 1 + slice 2 | (1) and (2) | New commit shape; extra side calls; tail replay must be exact | medium-large |
| D. Status quo | — | Growth continues; recovery folds get slower and fail more | none |

Recommendation: B now, then C. B removes the dominant growth with no new
failure modes. C is the user's "completed work fades" idea, but tail replay is
new persistence surface and should land after B is measured in real sessions.

## Decisions (user, 2026-10-24)

1. New folds default to `digest` (slice 1, implemented now).
2. Slice 2 is built next and is **on by default** once it passes acceptance
   (the recommendation was opt-in; the user chose default-on).

3. Slice 1 shipped as `5308c7d`; the user's global config was switched to
   `digest` (backup `tree-navigator.json.bak-20261024T150312`).
4. Slice 2: build now with the proposed values (more than 4 handoffs or more
   than 10% of the window, newest 2 kept verbatim), default on, tunable.

## Slice 2 design (supersedes "prefix rewrite + tail replay")

Use Pi's native `compaction` entry instead of a new commit shape.
`buildContextEntries` (`pi-coding-agent/dist/core/session-manager.js`)
projects the latest compaction as its summary, then the path entries from
`firstKeptEntryId` up to the compaction, then everything after it. Nothing is
rewritten or replayed; the entry is append-only.

```
before: [start … H1 … H2 … H3 … H4 … H5 … H6 … work]
after : [compaction(summary of start..H4)] H5 … H6 … work
         firstKeptEntryId = H5 (oldest of the newest 2 handoffs)
```

- **Planner (pure):** count handoff (`branch_summary`) messages in the current
  projection and their estimated tokens. Trigger when count > `max_handoffs`
  (4) or handoff tokens > `max_window_share` (0.10) of the window. Cut at the
  entry of the oldest of the newest `keep_newest` (2) handoffs. Refuse unsafe
  cuts with the existing recovery-cut checks (tool call before the cut with
  its result after it, unanswered input before the cut). Skip when the prefix
  saving is below the minimum fold saving.
- **Summarizer:** `summarizeFold` hardcodes the r5d fold instruction
  (`buildSummaryRequestText`); add an instruction override so consolidation
  can ask for a project-history summary (decisions, user rules, delivered
  state, rejected approaches, commits; drop step-level detail). Evidence is
  the projected prefix, which starts with the previous compaction summary, so
  repeated consolidations accumulate correctly. Reasoning cap low, as folds.
- **Commit:** `sm.appendCompaction(summary, firstKeptId, tokensBefore,
  details: { navigateTree: { consolidation, handoffs, strategy, usage } })`,
  guarded by `trySessionWrite`; refresh agent messages; emit
  `session_compact` for history-mirroring providers, as folds emit
  `session_tree`.
- **Trigger:** idle and turn boundaries only, after any queued fold, never
  mid-tool-batch; one per crossing; per-session engine lock shared with folds.
- **Unaffected:** the continuity ledger replays raw `sm.getBranch()` ops, not
  the projection. Raw history stays on disk.
- **Consequence:** anchors before `firstKeptEntryId` become pre-compaction
  targets, which folds already refuse. Anchors at or after the cut must stay
  foldable (test).
- **Config:** `consolidation: { enabled: true, max_handoffs: 4,
  max_window_share: 0.1, keep_newest: 2 }`, plus `/anchor settings` rows.

## Slice 2 correction: carry the compaction forward (v4)

v3 misses one consequence. `appendCompaction` parents the entry at the
current leaf, so every existing anchor lies before it on the path.
`precedesLatestCompaction` (`index.ts`) then refuses all of them, and a fold
that branched there anyway would drop the compaction and restore the
consolidated history. After the first consolidation, manual, pressure and
recovery folds would have no valid target.

Fix: a fold whose target lies inside the latest compaction's kept range
(`firstKeptEntryId` at or before the target, target before the compaction)
re-appends a copy of that compaction on the new branch.

```
old path : … H5(firstKept) … A … C(compaction) … leaf
fold to A: … H5 … A ─ branch_summary ─ C'(copy of C) ─ late input …
context  : [C' summary] H5 … A, branch_summary, late input
```

- `commitFold`: after the summary label, `appendCompaction(C.summary,
  C.firstKeptEntryId, C.tokensBefore, {...C.details, carriedFrom: C.id},
  C.fromHook)` through `trySessionWrite`; failure goes to `refuseWrite`.
- `previewFoldCommit`: add the same copy as a preview child of the preview
  `branch_summary` and project from it, or pricing restores the history.
- `projectAtEntry` / `estimateAtEntry`: include the copy when it applies,
  so anchor rows, recommendations and pressure targets price correctly.
- `precedesLatestCompaction`: true only when the target is before the
  kept range (or the kept entry is not on the branch). Those targets stay
  refused.
- Keeping `fromHook` and the original details preserves Pi's own file-list
  handling for native compactions; the fix applies to them too.

Summarizer seam: `summarizeFold` builds `buildSummaryRequestText` (r5d) for
the in-context request and the final reduce. Add an optional
`instruction(first)` override used in both places; consolidation passes a
project-history instruction that still starts with `## Goal`, because
`extractSummaryText` requires it. r5d stays byte-exact.

Units: (1) pure planner + `consolidation` config + settings rows;
(2) summarizer override + consolidation prompt; (3) carry-forward in
`index.ts`; (4) host trigger and commit in `index.ts`. 1 and 2 run in
parallel; 3 then 4.

## Open

- Thresholds are initial values; re-measure on real sessions after release.
