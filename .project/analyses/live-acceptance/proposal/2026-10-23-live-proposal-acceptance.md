---
version: 1
id: "live-proposal-acceptance"
title: "Live provider acceptance of model-refined tree proposals"
description: "Real openai/gpt-6-luna proposals over a 2.06 MB settled session: initial full-history and calls-only attempts, captured wire evidence, fallback reasons, and a recheck run on commit f19e4b6 with an adopted model plan and source-preserving clone."
type: "analysis"
created: "2026-10-23T11:15:07+02:00"
updated: "2026-10-23T11:28:44+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Live provider acceptance of model-refined tree proposals

status: "qa-complete"
confidence: "high" for the observed behavior of every run in this directory; "medium" for generalization (three full-history and two calls-only samples, one recheck)

## Summary

The proposal pipeline works end to end: registry resolution, real provider traffic,
the multi-request extraction path over 450 KB tool results, disclosure filtering,
save, preview, clone and `SessionManager` reopen all completed with the source file
byte-identical. Before commit f19e4b6, model refinement was unreliable on this
session: two full-history attempts produced no adopted model plan (unsafe folded
starts; truncated evidence JSON) and two calls-only attempts produced one adopted
plan with one-line handoffs. After f19e4b6 the recheck full-history proposal was
adopted by the deterministic validation with a self-contained 2,814-byte summary
carrying all four partition hashes, but it folded nothing: the plan is one open
group, so it adds 4 entries and saves no context.

## Triage (lead, 2026-10-23)

The lead's independent triage holds after review: D1, D2, D3 and D5 are the
documented safety fallback and validator-asymmetry behavior, not implementation
defects, and `goal`/`outcome` are display metadata by design, with the handoff text
intentionally built from `summary` only (D4). The initial evidence stays as recorded;
the findings below are retained with their triage verdict so later readers do not
re-derive the same fallbacks as bugs. Commit f19e4b6 addressed the two actionable
gaps by prompting for `safeFoldStartIds` and for self-contained summaries; the
remaining suggestions (retry a malformed batch, downgrade only offending groups) are
still unaddressed by design and are listed as options, not defects.

## Environment and source

- Node v26.11.1, `@earendil-works/pi-coding-agent` 1.3.0.
- Initial attempts at repo commit `5abd2d5`; recheck at `f19e4b6`
  (`fix(proposal): explain safe starts and self-contained handoffs`).
- Model `openai/gpt-6-luna:low` via `ModelRuntime.create({authPath, modelsPath})` +
  `new ModelRegistry(runtime)`; `resolveProposalModel` returned
  `contextWindow` 372000, `maxOutputTokens` 93000.
- Source: `.project/analyses/live-acceptance/parallel-01/agent-2/2026-10-23T08-56-15-857Z_01a167f9-...jsonl`,
  2,060,348 bytes, SHA-256 `2d5f3e01d17e7aebd12b5c4bcfdd88858dfe4e085403d5193fcb55fe394f28d4`,
  128 entries, 82 safe cuts, 0 pending tool calls, 4 accepted partition payloads
  (447,831 / 462,112 / 444,592 / 454,710 chars) plus 3 refused `load_partition` calls.
- Caveat from the lead: this session settled with 3/4 folds and `submit_report`
  rejected. It is a real long-context input, not evidence of a successful parallel
  fold run. Nothing else in this report depends on that acceptance.
- The source was copied byte for byte into each attempt directory (`input/source-copy.jsonl`,
  same SHA-256); every plan, preview and clone was produced against the copy. No
  product source, config or credential file was modified; no git operation was run.

## Commands

```bash
cd /mnt/Projects/furbyhaxx/pi-tree-navigator
# initial attempts (pre-f19e4b6 module state)
node .project/analyses/live-acceptance/proposal/run-proposal-acceptance.ts --tag attempt2 --runs full,calls-only
node .project/analyses/live-acceptance/proposal/run-proposal-acceptance.ts \
  --plan .project/analyses/live-acceptance/proposal/plans/attempt2-run-2-calls-only.json
node .project/analyses/live-acceptance/proposal/analyze-model-plans.ts \
  --run attempt1-run-1-full --run attempt1-run-2-calls-only    # then attempt2-*
# recheck on f19e4b6, separate directory, nothing earlier overwritten
node .project/analyses/live-acceptance/proposal/run-proposal-acceptance.ts \
  --out .project/analyses/live-acceptance/proposal/recheck --tag recheck --runs full
node .project/analyses/live-acceptance/proposal/analyze-model-plans.ts \
  --out .project/analyses/live-acceptance/proposal/recheck --run recheck-run-1-full
```

`run-proposal-acceptance.ts` uses the exported product functions only:
`readSessionSnapshot` -> `resolveProposalModel` -> `createProposalModelRunner`
(a `ModelRegistry.streamSimple` proxy adds `onPayload` / `onResponse` /
`onProviderStreamEvent`) -> `proposeTree` -> `validateTreeProposal` ->
`saveTreeProposal` -> `previewRetrospectiveSession` ->
`cloneRetrospectiveSession` -> `SessionManager.open`. `--plan` re-runs
preview/clone on a saved plan without provider traffic; `--verify-clone` reopens a
clone and re-checks the source hash; `--out` redirects artifacts.

## Test matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Model resolution, credentials, thinking `low` | pass | `attempt2-evidence-summary.json`, `recheck/recheck-evidence-summary.json` |
| Wire capture: payload, status, safe headers, parsed stream events | pass | 15 requests total, all HTTP 200; header keys only `cf-ray`, `date`, `server` |
| Multi-request path over real 450 KB partitions | pass (transport) | request payloads 233,275-295,164 bytes, 9,425 stream events in attempt 1 |
| Full-history model plan adopted (pre-f19e4b6) | fail 0/2 | F1, F2 |
| Full-history model plan adopted (f19e4b6) | pass 1/1 | recheck: `method: model`, `validatedMethod: model` |
| Calls-only disclosure applied on the wire | pass | `withheldMarkerInWire` true, `partitionTextInWire` false, max payload 193,362 vs 295,138 bytes |
| Calls-only model plan adopted | pass 1/2 | `attempt2-run-2-calls-only`, 5 groups, 3 folded; F3 for the other attempt |
| Plan validated locally, previewed | pass | `reuse-clone-check.json` (addedEntries 21), recheck preview (addedEntries 4) |
| Clone created with new ID and reopened | pass | `f0d5bb09-...` (149 entries), recheck `baacdc04-...` (132 entries), `reopenIdMatches` true |
| Original source bytes unchanged | pass | SHA-256 `2d5f3e01...` before and after every attempt, original and each copy |
| Model claims grounded in source | pass | 4/4 SHA-256 claims equal the corpus manifest and occur in source; 11/11 file/symbol claims occur in the claimed partition (recheck: 11/11 against the whole source) |
| Handoff content preserved by a model fold (f19e4b6) | not exercised | recheck plan has 0 folded groups |

## Findings (initial acceptance, pre-f19e4b6)

### F1 (major, triaged: documented safety fallback) Full-history model plan discarded: folded ranges start at tool results

Triage: not a defect. `validateRanges` correctly rejects a folded range whose start
splits a tool call from its result, and `validateTreeProposal` documents the
heuristic fallback. Kept as the initial acceptance failure.

Repro: attempt 1, `--runs full`. `proposeTree` returned `method: "model"`, 10 calls,
585,539 input / 9,766 output tokens ($0.0634, 222 s), and
`validateTreeProposal` replaced it with the heuristic plan.

Expected: the refined plan survives validation, folded groups included.
Actual: `Model plan failed graph-safety validation; using the heuristic proposal:
partition-one: boundary splits a tool call from its results`.

Evidence (`attempt1-model-plan-analysis.json`, boundaries): the model folded
`partition-one` 3d38b573..7dc36582 (indices 9..28), `partition-two` a675aa9b..160dd9cb
(41..52), `partition-three` 82ebaedc..b1bfa130 (70..89). Each start is a
`toolResult(load_partition)` whose parent index is not in `safeCuts`; the preceding
assistant tool call would stay outside the folded range. `unsafeStarts` lists all
three. The same search shows a valid plan is reachable with the same grouping by
starting at indices 4, 29 and 53 (`search.combinedError: null`), so the intent was
expressible and only the start selection was wrong.

Chain: model picks a successor-of-cut ID from `safeCutAfterIds` as a range start
(`proposal-engine.ts:154` before f19e4b6) -> `validateStructure` does not test
`safeCuts` (`proposal-engine.ts:49-110`) -> `validateTreeProposal` calls
`validateRetrospectivePlan` (`proposal-command.ts:160`) -> `validateRanges`
(`retrospective.ts:83-120`) rejects the cut -> whole model plan replaced
(`proposal-command.ts:178`). Result: 13 open groups, 0 folded, i.e. no context
reduction, and the paid refinement is discarded.

### F2 (major, triaged: provider output + documented fallback) Full-history model plan discarded: truncated evidence JSON, no retry

Triage: not a defect. The product detects unparsable evidence through a bounded
fallback rather than accepting a partial plan; the retry suggestion below is an
option, not a fix for a wrong result.

Attempt 2, `--runs full`: 2 requests, 80,709 input / 1,089 output tokens ($0.0086).
The second response was HTTP 200 with `status: "completed"`, `incomplete_details:
null`, and 948 parsed stream events, but its text is 4,499 bytes ending mid-string
(`{"evidence":"{... final excerpt is truncated."}` with no closing quotes), so
`JSON.parse` fails at position 4499. `proposeTree` catches it, warns
`Model refinement failed (invalid JSON)`, and returns the heuristic plan
(`proposal-engine.ts:257-321`). The remaining evidence batches were not attempted.

### F3 (minor, triaged: documented fallback) Calls-only model plan discarded: reversed range

Attempt 1, `--runs calls-only` (1 request, 52,981 input / 1,061 output):
`partition-two` was `95f5bb3d..160dd9cb`, entry indices 59..52, i.e. end before
start. `validateStructure` rejected it (`Invalid model range order or containment`,
`proposal-engine.ts:77`) and the heuristic plan was used. Disclosure filtering itself
worked.

### F4 (major quality, triaged: report-only materialization by design) Model folds rendered one-line handoffs

Triage: `goal`/`outcome` are display metadata and the handoff text is built from
`summary` by design; f19e4b6 now states this in the prompt and requires a
self-contained summary. Evidence of the earlier behavior is kept below.

The adopted model plan (`plans/attempt2-run-2-calls-only.json`) folds 24-37 entries
per partition, yet the generated handoffs are 124-137 bytes:

```
# Work handoff: Review partition 1

Partition 1 review and fold summary completed; the possible edit race was explicitly left unverified.
```

`makeHandoff` stores `outcome` (`handoff.ts:133-167`) but `materializeHandoff`
renders `title` + `report` only (`handoff.ts:169-173`), and `report` is
`group.summary`. The source session's own folds for 22-35 entries are 2,515 / 3,439 /
4,305 bytes. Before f19e4b6 the prompt did not say what `summary` must contain, so
the model wrote a one-line status and the folded context lost the partition hashes
and findings.

### F5 (minor, triaged: validator asymmetry by design) Inner and outer validation differ

Triage: the outer check is the authoritative one; the inner check is intentionally
cheap. Kept as a cost observation.

`validateStructure` (`proposal-engine.ts:49`) is weaker than `validateRanges`
(`retrospective.ts:83`): safe-cut, branch-parent and context-edit rules are enforced
only after every model request has been paid for. In attempt 1 all 10 requests
completed before the plan was thrown away; in attempt 2 the same class of error
(reversed range) was caught for free but only after the model had already answered.

## Recheck on commit f19e4b6

One full-history proposal on the exact same agent-2 source, run from the updated
checkout production module, artifacts in `recheck/` (earlier captures untouched).

- Model/path: `openai/gpt-6-luna:low`, full textual history, 10 provider requests,
  all HTTP 200, payloads 12,030-295,164 bytes, 8,382 parsed stream events,
  585,481 input / 8,690 output tokens, $0.0629, 201 s.
- Method before deterministic validation: `proposeTree` returned `method: "model"`.
  After `validateTreeProposal`: `validatedMethod: "model"` — no fallback, no
  fallback warning. `adoptedEqualsModel: true`.
- Plan: one open group `historical-review` (0 folded, max depth 0) covering entries
  0..127, 4 added entries on clone (tree-phase, provenance, `anchor:historical-review`,
  session_info). Its `summary` is 2,814 bytes and is the whole model-facing text.
- Summaries preserve real evidence: it names all four partitions with the exact
  SHA-256 values `4d6e7d18...`, `42ed6114...`, `1bb6fe38...`, `22ec7a2a...`; 4/4
  hashes equal the corpus manifest and occur in the source; 11/11 file/symbol claims
  (`continuity-capture.test.ts`, `matchesModelPattern`, `mergeAutoNavigateField`,
  `foldTo`, `rewindLedger`, ...) occur in the source; 0 unverified claims;
  0 label collisions.
- Boundaries: the single group is open, so no folded-range start is checked; the plan
  passes `validateRetrospectivePlan` (no error) and the preview
  (`sourceMatchesSnapshot`, `shaMatches`, `groups` count, 0 descendants).
- Source-preserving clone: `recheck/input/2026-10-23T09-28-08-938Z_baacdc04-...jsonl`,
  session id `baacdc04-a0ec-49e8-9644-cf4092cbe4de` (new), 132 entries = 128 + 4,
  name `01a167f9-... (restructured)`, reopened via `SessionManager.open`
  (`reopenIdMatches: true`, `entryCountMatches: true`), provenance
  `sourceSha256 2d5f3e01...`, 3 retained source handoffs and 0 new handoffs;
  original and copy SHA-256 unchanged.
- Remaining observation, not a fallback: the adopted plan folds nothing, so it saves
  no context and replaces the 13 heuristic open phases with one open group. The
  model's own summary states that the first three folds landed but the task was never
  accepted, which is a defensible reason to keep phases open; the run therefore
  demonstrates prompt compliance and safe adoption, not a useful fold.
- Harness note: the script's post-run `package-versions.json` path was resolved
  relative to `--out` and failed after the run had already been written; the path is
  fixed and the file was regenerated with `--runs none`. No provider call was repeated
  and no evidence was overwritten.

## Root cause

Initial failures: model plan defects caught by a closed, correct validator (F1, F3)
and a provider-side malformed evidence object (F2); the product's safe fallback is
not the bug. The actionable gap was informational — the model was not told which
entries can start a folded range and was not told that `summary` is the whole
handoff — and f19e4b6 closed it: `safeFoldStartIds` plus explicit boundary and
summary instructions. The recheck confirms both instructions reached the model and
that the adopted plan now carries hashes and findings in the rendered text. F4 is
design, not a defect.

## Suggested options (not defects)

1. `proposal-engine.ts` evidence batching: retry a malformed batch once before
   falling back (F2) — optional robustness, would have cost one extra call.
2. `proposal-command.ts:160-181`: on graph-safety failure, downgrade only the
   offending folded groups to open instead of replacing the whole plan (F1) — optional,
   changes fallback semantics the lead has already classified as acceptable.
3. Regression tests worth having for the f19e4b6 behavior: the outline must contain
   `safeFoldStartIds` whose entries' parents are safe cuts; a folded `firstEntryId`
   outside that set must still be rejected by the outer validation; the final prompt
   must state that only `summary` is model-facing.

## Verification gaps

- Three full-history samples (two pre-fix, one post-fix) and two calls-only samples.
  The model's boundary and folding choices vary; the recheck did not exercise a folded
  range under the new prompt.
- Handoff summary quality is not machine-verifiable (the product's own preview
  warning). The 11/11 symbol and 4/4 hash checks show the claims exist in the named
  partition; they do not prove the findings are correct.
- Attempt 1's aggregate summary file was overwritten while developing the wrapper.
  Its raw wire, model outputs, plans and clone remain, and its per-call token counts
  were recomputed from `attempt1-*-model-outputs.jsonl` into `usage-per-run.json`.
- Cancellation/GUI paths were out of scope (previously exercised).

## Artifacts

Initial attempts: `run-proposal-acceptance.ts`, `analyze-model-plans.ts`,
`attempt2-evidence-summary.json`, `attempt{1,2}-model-plan-analysis.json`,
`attempt{1,2}-run-*-wire.jsonl.gz` (payloads, status, safe headers, stream events),
`attempt{1,2}-run-*-model-outputs.jsonl`, `usage-per-run.json`, `plans/`,
`input/source-copy.jsonl`, `input/*.jsonl` (three clones), `clone-structure.json`,
`reuse-clone-check.json`, `attempt1-clone-reopen.json`, `package-versions.json`.

Recheck (f19e4b6): `recheck/recheck-evidence-summary.json`,
`recheck/recheck-run-1-full-wire.jsonl.gz`,
`recheck/recheck-run-1-full-model-outputs.jsonl`, `recheck/model-plan-analysis.json`,
`recheck/plans/recheck-run-1-full.json`, `recheck/input/source-copy.jsonl`,
`recheck/input/2026-10-23T09-28-08-938Z_baacdc04-...jsonl`, `recheck/package-versions.json`.

Totals: 15 provider requests, 1,357,691 input tokens, 21,901 output tokens, $0.1467,
all HTTP 200.

## Open questions / follow-ups

- Should a model plan that folds nothing be accepted silently, or should the outline
  screen flag "no context reduction"? The recheck adopted such a plan without warning.
- `matchesModelPattern` and `mergeAutoNavigateField` exist in the repository
  (`extensions/navigate-tree/auto-navigate-config.ts:278`, `config.ts:448`) and the
  model attributed them to the right partitions; unrelated to this acceptance.
