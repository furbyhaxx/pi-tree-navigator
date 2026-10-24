---
version: 2
id: "handoff-consolidation-proposal"
title: "Continuous consolidation of older handoffs"
description: "Decision material for letting completed work fade from active context instead of accumulating as verbatim handoffs."
type: "plan"
created: "2026-10-24T01:12:10+02:00"
updated: "2026-10-24T01:20:00+02:00"
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

## Open

- Slice 2 thresholds (count, share of window, newest K kept verbatim);
  proposed values above, to be validated against real-session measurements
  after slice 1.
