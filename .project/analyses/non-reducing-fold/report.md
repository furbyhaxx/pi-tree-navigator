---
version: 1
id: "non-reducing-fold"
title: "Fold refused as non-reducing at 141515 -> 218367: a pre-compaction anchor priced at the compaction baseline"
description: "Why navigate_tree rewind to anchor 'live-acceptance-shipped' estimated growth from 141515 to 218367 tokens: the label points at an entry that predates the session's compaction, so the materialized fold's projection drops compaction filtering and restores ~157k tokens of summarized history, while the anchors list and the rewind acceptance priced that same anchor at 27,991 tokens (7.5% of 372k). Both gate numbers reproduced exactly offline."
type: "analysis"
created: "2026-10-23T13:24:05+02:00"
updated: "2026-10-23T13:31:00+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---
# Fold refused as non-reducing: a pre-compaction anchor priced at the compaction baseline

status: "root-caused"
confidence: "high"

## Summary

The gate's arithmetic is correct; the fold target was the problem. The anchor
`anchor:live-acceptance-shipped` is a label entry (`22ed4097`) whose
`targetId` is `841a49e8`, an assistant message from 10:01:16, i.e. *before* the
session's compaction `e40ab65b` (10:10:33). A fold there parents its
`branch_summary` to `841a49e8`, which is not a descendant of the compaction, so
the prospective projection loses compaction filtering and re-includes the entire
pre-compaction history: `216382` tokens with an empty report, `218367` with the
~7.9k-char materialized handoff. `foldEstimateBefore` (`141515`) is the live,
compaction-aware projection and reproduces exactly, as does `218367`.

The defect is upstream: `effectiveTargetTokensOnBranch` prices a pre-compaction
anchor at `min(raw, compaction-baseline)` = `27991` tokens, so the anchor list
showed `7.5% of 372k` and the rewind's `MIN_REWIND_SAVINGS_TOKENS` check passed
with ~83k apparent savings — for a fold that actually grows context by ~77k.
`completeRewind` then failed closed and blamed the summary.

## Reproduction (offline, read-only, no SessionManager)

Session copied to a private `mktemp -d` first (`sha256 ceb589bc…`); the live
file was never opened for writing and no manager was constructed on it. The
copy was deleted after the run.

```
cd /mnt/Projects/furbyhaxx/pi-tree-navigator
cp <live-session>.jsonl "$TMPDIR/session.jsonl"
node .project/analyses/non-reducing-fold/repro.mjs "$TMPDIR/session.jsonl"
```

Environment: repo `3572f9d` on `feat/independent-folding-engine`, Node v26.11.1,
extension files identical between the repo and the copy the live agent loads
(`~/.pi/agent/git/github.com/furbyhaxx/pi-tree-navigator` at `229afe0`;
`index.ts`, `handoff-projection.ts`, `handoff.ts`, `context-tokens.ts`,
`continuity-store.ts` byte-identical). The live host is pi-bolt; its embedded
`buildSessionProjection`, `contextEntriesOfPath` and `estimateTokens` are
equivalent to the repo's pi 1.3.0 dev dependency (source extracted from the
binary and compared).

Output (state = entries persisted up to the failed attempt `328ef699`):

```
label entry        22ed4097 -> targetId 841a49e8
path positions     target 178 compaction 187
target is pre-compaction: true
instruction `first` 23 (live instruction said 23)
foldEstimateBefore 141515 (live: 141515)
  of which system    38596
foldEstimateAfter   { entries: 180, compactionOnPath: false, tokens: 216382 }
  +7940-char handoff 218367 (live: 218367)
counterfactual: parent = newest post-compaction entry { entries: 39, compactionOnPath: true, tokens: 68579 }
```

Failure record: `context_edit 11da7b48` +
`navigate-tree-rewind-outcome 6f498889`, `rewindTo live-acceptance-shipped`,
`newLabel architecture-agreed`, `hiddenIds [328ef699, efef72ad]`.

## Root cause

Causal chain, each step verified:

1. The `/anchor` label `22ed4097` (`2026-10-23T10:11:06.960Z`, written after the
   compaction) carries `targetId: "841a49e8"` — an assistant message at
   `2026-10-23T10:01:16.901Z`, inside the compaction's kept range.
2. `findLabeledEntry` (`index.ts:689-698`) resolves the label to `841a49e8`;
   independently confirmed by the summary instruction's `first = 23`
   (`index.ts:5408-5416`): `841a49e8` is the only projection entry whose
   provider-visible message count + 1 is 23.
3. `completeRewind` sets `preview.parentId = pending.target` (`index.ts:3022`),
   then `buildSessionProjection(prospectiveEntries, previewId)`
   (`index.ts:3029-3034`). The leaf is `841a49e8`, which is *before* the
   compaction on the branch (`path` index 178 vs 187), so
   `buildContextEntries` sees no compaction on that path and returns the raw
   path: 180 projection entries, compaction filtering skipped.
4. `foldEstimateBefore` (`index.ts:3047-3056`) uses
   `sm.buildSessionProjection()` at the live leaf, which *is* compacted: 176
   entries, `29983` pre-target content + `72936` folded segment (minus the four
   rewind-turn entries) + `38596` effective system message = `141515`.
5. `foldEstimateAfter` = `216382` (base) + handoff/continuation ≈ `218367` ≥
   before, so `index.ts:3072-3077` refuses and keeps the original history.

Contribution of the resurrected history: `path[0..157]` (the entries the
compaction had summarized away) = `156783` tokens, `path[158..178]` (kept range
up to the target) = `21060` tokens; the compaction summary message it replaces
is `4956`. The compaction-aware counterfactual (same report, target at the
newest post-compaction entry) is `68579`.

Why the fold was even offered: `effectiveTargetTokensOnBranch`
(`index.ts:715-751`) returns `min(raw, charEstimate)` for a target at or before
the compaction, where `charEstimate` is the projection at `compaction.id` —
measured `27991` tokens = exactly `7.5% of 372000`, the number the live anchor
list printed for every anchor including `live-acceptance-shipped`. The rewind
tool then computed `apparentSavings = beforeTokens - tokensAtTarget` ≈ 111k −
28k and passed the `MIN_REWIND_SAVINGS_TOKENS` floor
(`index.ts:5368-5390`). The same function feeds the anchor list
(`index.ts:763`), the anchor-creation hints (`index.ts:855`) and auto-navigate's
fold decisions (`index.ts:4810`, `index.ts:4905`).

The clamp's assumption — "the active branch already compressed those older
turns" (`index.ts:716-719`) — holds for *display* and for nothing else: a fold
branches *at* the target, so the compaction entry stops being an ancestor and
the summarization on this branch is undone.

Inference (not observed end-to-end): the materialized handoff for this fold was
about 7,940 characters (model summary 5,333 chars + file-operation block +
continuity briefing, bounded by `FOLD_BRIEFING_MAX_TOKENS = 2500`,
`continuity-store.ts:42`). 7,940 is the exact length that reproduces `218367`,
which is why the match is treated as confirmation rather than coincidence.

## Evidence

Reproduced exactly: `141515` before, `218367` after (with a 7,940-char report),
`27991` = 7.5% compaction baseline, `first = 23`.
Ruled out: duplicate briefings (children list empty in every handoff of this
session; all stored reports are 2.5-7.8k chars), `stripContinuityBriefing`
losses, stale-usage handling (`projectHandoffs` is content-neutral here),
context edits (the branch had none before the failure), the host/extension build
(identical), and estimator-version drift (pi 1.3.0 vs the live bundle).
Cross-check: the failed summary turn's recorded usage is 2,649 input + 143,616
cache read ≈ 146k prompt tokens, consistent with the `141515` content estimate.

## Recommended fix

Primary, at `index.ts:721-751`: price a fold to a target at or before the latest
compaction by its real fold footprint — `estimateAtEntry(entries, targetId)`,
which is already compaction-free — instead of `min(raw, compactionBaseline)`.
That single change makes the anchor list show `live-acceptance-shipped` at
~48% of 372k, and makes `apparentSavings` negative so the rewind is refused up
front by the existing savings floor instead of accepting a fold that must fail.

Secondary, `index.ts:3074`: when the target is before the latest compaction, say
so and name the nearest post-compaction anchor; "does not reduce projected
context … Try again" invites a retry that cannot succeed.

Regression test (extend `index.test.ts`, alongside the existing
`allows rewinding to a pre-compaction anchor without false negative savings`,
`index.test.ts:10257`, whose premise this finding reverses):
a session with a compaction, a label whose target precedes it, and a later leaf.
Assert that (a) `collectActiveAnchors` reports that anchor's un-compacted
footprint, not the compaction baseline; (b) `rewind` to it is rejected at
request time with the pre-compaction reason and no pending rewind is created;
(c) if it is ever allowed, `completeRewind`'s `foldEstimateAfter` equals the
projection `repro.mjs` prints (`216382` for this fixture shape), so accept and
fold cannot disagree again.

## Open questions / follow-ups

- Why `/anchor` labelled a pre-compaction entry (`index.ts:800-900` anchor
  target resolution) while the branch had a newer milestone: whether the anchor
  action should refuse or relocate targets before the latest compaction cut.
- Whether folding to a pre-compaction anchor should instead re-emit the
  compaction entry so the summarized history stays collapsed; that is a larger
  change and needs its own decision.
- `effectiveTargetTokensOnBranch`'s clamp is also used for anchor hints and
  auto-navigate steers (`index.ts:855`, `4810`, `4905`), so the same mispricing
  can steer the agent into the same refusal; all three need the corrected
  footprint.
