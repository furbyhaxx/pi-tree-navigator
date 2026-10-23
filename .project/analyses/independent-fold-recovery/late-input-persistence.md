---
version: 1
id: "independent-fold-recovery-late-input-persistence"
title: "commitFold reports success after a late-input append fails"
description: "commitFold swallows every failed re-append of input that arrived during a fold and still returns ok: true. Reproduced with a synthetic session and with the real SDK (memory written before disk): wrong count and missing note, request lost on reload, and a dangling parent chain when later appends succeed. Includes rollback durability and a validated recovery."
type: "analysis"
status: "root-caused"
confidence: "high"
created: "2026-10-23T20:11:00+02:00"
updated: "2026-10-23T20:11:00+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# commitFold reports success after a late-input append fails

status: "root-caused"
confidence: "high"

Scope: one defect. Source: `extensions/navigate-tree/index.ts` blob `2d0bd10` (unchanged from `2f059aa`
through HEAD `ea4145b`), SDK `@earendil-works/pi-coding-agent` 1.3.0, Node v26.11.1. No production file or
test was edited; everything ran against scratch copies.

## Summary

- `commitFold` catches each throwing late re-append and continues (`index.ts:1975-1996`), then returns
  `ok: true` (`index.ts:2012`). The only trace is `reappended`, which feeds the "still unanswered" note
  (`index.ts:2029`): the note vanishes or counts wrong. `index.test.ts:4027` pins this behaviour.
- The suspicion needs one correction. The active branch loses the request in memory only when the throw
  precedes the SDK's memory write (injected or wrapped appends). With the real SDK a disk failure leaves the
  entry in memory but not in the file, so the request is lost on reload. If a later append succeeds, it
  names the failed entry as parent and the reloaded active branch shrinks to the entries after the gap.
- Rollback with `sm.branch()` is observable in-process and not durable. It becomes durable only through a
  later append whose parent is the restored leaf: the existing marker-undo label write, whose boolean result
  says whether that happened.
- Fix: stop at the first failed append, restore the leaf, write the marker undo, return `ok: false`, and say so
  when the rollback could not be written. A 58-line patch passes all scenarios in a scratch copy.

## Reproduction

```
D=.project/analyses/independent-fold-recovery/late-input-persistence
$D/run.sh baseline            # S0 passes, S1 S1b S2 S3 S4 S5 fail (the bug)
$D/run.sh candidate           # all pass with candidate-fix.patch applied to a scratch copy of index.ts
$D/run.sh candidate+label     # also applies candidate-writelabel.patch (follow-up F1)
$D/run.sh baseline followup   # S6, a related hazard
node $D/sdk-timing.mjs        # SDK-only facts E1-E6, no extension code
```

`run.sh` appends `late-input.block.ts` to a scratch copy of `index.test.ts` and uses its fixtures
(`setup`, `setupRewindable`, the `commitFold: engine shape` input). Failures are injected only after
`branchWithSummary` returned. Deterministic: repeated baseline runs gave identical results. Raw output is in
`late-input-persistence/output/`.

Injections: `pre-push` throws before the SDK touches memory (the injection of the existing test). `disk-*`
makes the real SDK `appendFileSync` fail with EACCES (`chmod 444` on a disposable file-backed session) after
its memory push; `persistent` stays failed, `transient` lasts for one append.

Expected: `ok: true` only if every late entry is on the active branch and in the session file; otherwise
refuse and keep the original branch. Actual (baseline, HEAD):

| Scenario | Result |
|---|---|
| S0 no failure | `ok`, reappended 1/1, tail `branch_summary,label,LATE,receipt` |
| S1 in-memory, one late user append throws (decisive) | `ok: true`, reappended 0/1, no note; active branch has no LATE request |
| S1b same, late = user + custom | `ok: true`, reappended 1/2; note says "The message ..." and refers to the custom entry; request gone |
| S5 host path (queued fold at `turn_end`, S1 injection) | receipt `status: "done"`, `reappendedLateMessages: 1`; receipt text says retained user messages are historical ("do not re-answer them") |
| S2 file-backed, EACCES persistent | `ok: true`, 0/1, no note; memory has LATE (leaf advanced), file lacks it; reload: branch reaches summary, no LATE |
| S3 file-backed, one EACCES, later appends succeed | `ok: true`, 1/2; reload: 2-entry active branch, anchor and summary unreachable, context `[custom, custom]` |
| S4 custom append fails, persistent | `ok: true`, 1/2; reload has the user copy, not the custom entry |

## Root cause

1. Late entries are collected in `previewFoldCommit` (`index.ts:1728`, `collectLateEntries` at `1556`). They sit
   only on the abandoned segment, so the commit re-appends them after `branchWithSummary` (`index.ts:1948`).
2. The loop wraps each append in `try { ... reappended++ } catch { /* Fail-open */ }` (`index.ts:1975-1996`).
   Nothing records which entry failed, and the loop keeps appending.
3. The result is `ok: true` with `reappended` (`index.ts:2012-2019`). `reappended` drives the continuation note
   (`index.ts:2029`), the receipt (`index.ts:2432`) and the continue-nudge check (`index.ts:3874`). The
   receipt then reports a landed fold. `buildRewindDoneText` (`index.ts:1598`) tells the model that retained
   user messages are answered history; an unflagged late request is demoted. The model's reaction is inferred,
   not observed.
4. SDK order (`session-manager.js:815-820`, identical in 0.87.0, 1.3.0, 1.4.0): `_appendEntry` pushes to
   `fileEntries` and `byId`, sets `leafId`, and only then calls `_persist`. A persistence throw therefore
   leaves the entry in memory and absent from the file; nothing retries it (E2). `appendLabelChange` also
   skips its label-map update when that throw happens (E5).
5. A later append takes the leaf, the failed in-memory entry, as parent. On disk that parent does not exist, so
   `getBranch()` from the reloaded leaf stops at the gap (E3, S3). This is why "continue after a failed append"
   corrupts the chain, not only the count.

Contributing: the comment at `index.ts:1910` ("every step after the branch is guarded") and the pinned test
`index.test.ts:4027-4056`.

## Evidence

- E1: `SessionManager.inMemory` has `persist = false`; its appends cannot fail. Only a wrapper can reproduce
  the failure there (S1), which is the pre-push class.
- E2: persistent EACCES: `appendMessage` throws, leaf is the failed entry, in-memory branch has 3 entries, file 2.
- E3: after a transient failure the next append is written with `parentId` of the missing entry; reopening gives
  `getBranch()` of 1 entry and context `["custom"]` against `["user","assistant","user","custom"]` in memory.
- E4: `branch()` only sets `leafId` (`session-manager.js:1161`). Reopening after `branch(old)` opens on the
  summary (`_buildIndex`, `:732-741`, takes the last file entry). After one append from the restored leaf the
  reopened leaf is that entry and the old branch is intact.
- E6: retrying a failed append through the same manager gives the same dangling parent (F1).
- Candidate patch, same scenarios: S1, S1b, S5 refuse (`status: "failed"`, "Nothing was collapsed."), active
  branch is the original with the late entries, completion marker undone. S3 refuses and the reloaded active
  branch is the old branch with both late entries (durable). S2 and S4 refuse; the writes still fail, so the
  reason adds "the rollback was not written to the session file, so a reload may reopen the folded branch
  without that input", which the reload confirms.
- Ruled out: "the active branch always loses the request" (false for real SDK failures, S2); "`sm.branch`
  rollback is durable" (E4); "SessionManager.inMemory can show a disk failure" (E1).
- Checks on the patched copy: `tsc --noEmit` (index.ts) and `biome check` exit 0. Full `index.test.ts` in
  scratch: 39 failures at baseline (forced-rewind #101 suites and two README text suites, already failing in
  the repo checkout), 40 with the patch; the one addition is the pinned test at `index.test.ts:4027`.

## Recommended fix

Where: `commitFold` (`index.ts:1913-2034`). Patch: `late-input-persistence/candidate-fix.patch`.

```ts
// helper next to leafBeforeBranch; also replaces the inline restore in the branchWithSummary catch
const restoreAbandonedBranch = (): boolean => {
  let restored = Boolean(leafBeforeBranch);
  try { if (leafBeforeBranch && sm.getLeafId() !== leafBeforeBranch) sm.branch(leafBeforeBranch); }
  catch { restored = false; }
  if (!branchLabelWritten || !branchLabelEntryId) return false;
  return input.writeLabel(branchLabelEntryId, undefined) && restored;   // first write from the restored leaf
};
// late loop: on the first throw record it and `break`
// after the loop: if (lateFailure) { const durable = restoreAbandonedBranch();
//   return { ok: false, reason: `the input that arrived during the fold could not be re-appended (${why}); the fold was rolled back and original history was kept${durable ? "" : "; the rollback was not written to the session file, so a reload may reopen the folded branch without that input"}` }; }
```

Recovery semantics (answers the durability question):

- Never append after a failed append (S3).
- Observable at once: `getLeafId`, `getBranch` and `buildSessionContext` return the original branch. Agent
  messages stay untouched because `refreshAgentMessages` (`index.ts:2005`) and `emitSessionTree` run after the
  loop.
- Durable only after the marker undo (or any later append) from the restored leaf succeeds. If `writeLabel`
  returns false, or no `branchLabelEntryId` was given, persistence is uncertain: report it. The original late
  entries stay in the file on the abandoned branch either way.
- `ok: false` maps to `failed`/`commit-refused` in the engine, and "Nothing was collapsed." holds for the live
  process. A summary entry stays unreachable in the file; label scans read the active branch only
  (`findLabeledEntry`, `index.ts:601-610`), so a retry with the same names is not blocked (read, not run).
- Rejected: keeping the fold with a degraded `ok: true` (input would exist only in memory; needs a new outcome
  and receipt state). Optional, not needed for correctness: retry once after `sm.branch(lastDurableId)` to save
  the paid summary on transient errors.

Tests: replace `index.test.ts:4027-4056` (it asserts the bug) with a refusal test; add S1 to
`commitFold: engine shape` (refused, no `branch_summary` on the active branch, original late ids on it,
`getLabel(leaf) === undefined`); add the file-backed S3 and S2 cases. `late-input.block.ts` is formatted and
type-checks when appended to `index.test.ts`. The working-tree README ("Commit and refresh": persistence
failures during commit are reported separately) becomes true for late input.

Same pattern elsewhere: see F1.

## Open questions / follow-ups

- F1 (related defect, separate fix). `writeLabel` (`index.ts:3027-3043`) retries `sm.appendLabelChange` after
  `pi.setLabel` throws. After a persistence failure that retry gets the failed entry as parent. S6, through the
  production host: one transient failure on the `anchor:` label append gives receipt `done` and a reloaded
  active branch of 2 entries (context `["custom"]`). `candidate-writelabel.patch` (restore the leaf before the
  retry, 6 lines) makes S6 pass; the durable anchor above depends on this writer. `appendFoldMessage`
  (`index.ts:3404-3430`) has the same shape (`pi.sendMessage`, then `sm.appendCustomMessageEntry`); not run.
- F2. `foldFailedDraft` always appends "Nothing was collapsed." (`index.ts:2454`), also when the reason
  discloses an unwritten rollback. Wording decision for the worker.
- F3. `index.test.ts` has 39 failing tests at HEAD, unrelated to this unit.
- Gaps: no real `AgentSession` or `_commitBoundaryDrafts` run (host path uses the repo's fakes); only EACCES
  was injected, so ENOSPC torn lines (a partial line gluing to the next append) are UNVERIFIED; the bundled
  SDK in the installed pi runtime was not inspected (three SDK versions agree); `collectLateEntries` returns
  `[]` if `getBranch` throws (`index.ts:1560-1564`), likely unreachable after the earlier reads, UNVERIFIED.

BLOCKERS: none
