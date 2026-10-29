---
version: 1
id: "extension-audit-runtime"
title: "Runtime preservation and recovery review"
description: "Independent read-only findings, retained for coordinator verification and prioritization."
type: "analysis"
created: "2026-10-29T18:13:15+01:00"
updated: "2026-10-29T18:13:15+01:00"
createdBy: "agt_01m649dv26mk0kag9k9y14kr30"
updatedBy: "Pi coding assistant"
---

## Verdict

Fix the live-fold preservation and recovery ownership defects before treating the runtime invariants as satisfied. I reproduced eight issues without provider calls or source edits.

Paths below are relative to `/mnt/Projects/furbyhaxx/pi-tree-navigator`.

## Findings

### 1. [major] A fold can resurrect context-edited-away messages

**Where:** `src/fold/fold-preview.ts:198–212`; `src/fold/fold-commit.ts:133–156`.

**Trigger:** A `context_edit` appended after the target anchor omits or replaces a message before that anchor. Fold the later span.

**Evidence:** Using the real in-memory `SessionManager`, I:
1. Appended a synthetic user message.
2. Created a later anchor.
3. Appended `appendContextEdit(userId, null)`.
4. Added substantial completed work and called `commitFold`.

Observed:
```json
{
  "ok": true,
  "omittedMessageVisibleBefore": false,
  "omittedMessageVisibleAfter": true
}
```

**Why:** The prospective branch and committed branch retain the target’s ancestry but discard effective edits residing on the abandoned ancestry. Neither the preview nor commit carries cross-boundary edits forward. Canonical projection therefore restores the original payload. This affects provider-envelope repairs, redactions and deliberate context omissions, not merely token estimates.

**Fix:** Compute and preserve effective edits affecting retained messages, using appended entries on the new branch. Include those exact entries in the preview. Refuse cases that cannot preserve the effective projection safely.

**Coverage gap:** Existing projection/input tests establish that evidence respects edits before a fold; they do not establish that committing the fold preserves edits to retained ancestors.

### 2. [major] Live folds discard effective model, thinking and system checkpoints

**Where:** `src/fold/fold-commit.ts:133–156,204`; `src/core/pi-internals.ts:125–139`.

**Trigger:** Change the model, thinking level or persisted system sections after an anchor, then fold to that anchor.

**Evidence:** A real `commitFold` returned `ok: true`. Before the fold, replay reported the latest assistant model, thinking `"high"` and system section:
```json
{"policy":"new-critical-policy"}
```
Afterward, replay reported the anchor’s older model, thinking `"low"` and:
```json
{"policy":"old"}
```

**Why:** The commit branches directly to the anchor and restores only a carried compaction and selected late messages. Runtime checkpoints in the folded span disappear from active ancestry. `refreshAgentMessages` then loads the old projected system state; reopening the session also replays the old settings.

The retrospective implementation already recognizes this requirement in `retrospective-clone.ts:147`, but live folding has no equivalent preservation step.

**Fix:** Capture effective runtime state at the fold boundary and append the minimal checkpoints needed to preserve it. Materialize and price these checkpoints in the preview. Preserve subsequent late state changes or refuse stale work.

### 3. [major] Recovery’s pressure-compaction fallback bypasses the session lock

**Where:** `src/recovery/independent-recovery.ts:164–189,231,247–253`; `src/recovery/pressure-compaction-runtime.ts:231,311`.

**Trigger:** Recovery runs while another fold owns `runningFolds`, for example when a main request starts during an idle manual summary.

**Evidence:** I seeded `runningFolds` with the session ID and invoked `recoverIndependently` against an in-memory session without usable anchors. Its injected pressure-compaction dependency was called:
```json
{"locked":true,"pressureCalled":true}
```

There is a second entry route: a fold returning `"busy"` is treated as an ordinary failure and falls through to pressure compaction.

**Why:** `compactUnderPressure` unconditionally adds the session ID to the shared `Set`; it never checks whether another operation owns it. Its `finally` unconditionally deletes that ID. Two operations can consequently summarize concurrently, and either can clear the other’s lock. Recovery’s pressure `isCurrent` callback also does not bind the original leaf.

**Fix:** Give all fold/compaction paths one checked lock with explicit ownership. A busy result must abstain or wait safely, not start a different mutation path. Validate the pressure snapshot before commit, including leaf/branch identity.

**Coverage gap:** Existing engine and adapter serialization tests cover two fold calls, not fold-versus-recovery-compaction ownership.

### 4. [major] Preflight sends a still-oversized request after successful relief

**Where:** `src/recovery/request-guard.ts:113–134`; `src/recovery/pressure-compaction-runtime.ts:262–298`.

**Trigger:** Pressure compaction reduces context but leaves the request above the operating window.

**Evidence:** With a controlled successful recovery dependency, `onContextWithSystem` returned:
```json
{
  "calls": 1,
  "aborted": false,
  "returnedTokens": 40054,
  "window": 10000
}
```

This was a controller-level reproduction, not a provider test. The production prerequisite is real: pressure compaction explicitly permits an above-target result and gates savings, rather than requiring the request to fit.

**Why:** The guard checks admission before recovery, then returns `recovered` without checking its complete request size. The three-attempt recovery policy can only help later, after an avoidable provider request fails.

**Fix:** Re-account the recovered request, including its receipt and system state, before returning it. Continue decreasing-context recovery within the bounded attempt policy, or refuse generation. Best-effort relief should not imply permission to send a request already known to exceed the window.

### 5. [major] Duplicate capture loses user authority

**Where:** `src/continuity/continuity-ledger-reducer.ts:197–204`; protection check at `src/continuity/continuity-ledger-model.ts:219–221`.

**Trigger:** An agent first records a decision. A user later explicitly states the same normalized decision.

**Evidence:** I applied:
1. Agent-origin `add decision`.
2. User-origin `add decision` with identical text and a user entry ID.
3. Agent-origin `archive` of the resulting item.

Observed:
```json
{
  "source": {"origin":"agent"},
  "agentArchiveApplied":1,
  "status":"archived"
}
```

**Why:** Deduplication returns the existing item unchanged before considering the incoming authority. Capturing a genuine user decision therefore does not protect it if an agent happened to record the same text first. A subsequent fold delta can rewrite or archive it.

**Fix:** A duplicate from a stronger user origin must preserve that authority and its provenance, either by promoting the existing item or creating a protected representation. Keep genuinely unchanged duplicates revision-free.

**Coverage gap:** Duplicate tests and protected-origin tests pass separately; there is no authority-transition test connecting them.

### 6. [major] Chunked summaries omit hidden messages that the main model actually receives

**Where:** `src/fold/fold-inputs.ts:43–46`; also affects `buildConsolidationSegment`.

**Trigger:** Another extension appends a model-facing custom message with `display: false`, then a fold uses Strategy B or consolidation summarizes that prefix.

**Evidence:** With the real SDK converter:
```json
{
  "wireContainsHidden": true,
  "summaryRecords": []
}
```

The fixture contained a single hidden custom result after the anchor. SDK `convertToLlm`, in `node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:89–94`, converts custom messages regardless of `display`.

**Why:** `display` controls transcript presentation. `recordBody` incorrectly treats it as permission to exclude content from model evidence. Hidden extension instructions, findings or task results can disappear from the summary without any warning. Strategy A and Strategy B consequently summarize different semantic histories.

**Fix:** Include all canonically model-visible custom messages. Exclude only explicit known non-evidence types or messages omitted by canonical projection.

**Coverage gap:** `tests/fold/fold-inputs.test.ts` deliberately includes a hidden note and expects it to be absent. This is a case where the existing passing test encodes the faulty assumption.

### 7. [major, completeness] Retrospective folds drop this package’s own active continuity ledger

**Where:** `src/retrospective/retrospective-clone.ts:300–318`; replay semantics in `src/continuity/continuity-store.ts:110–143`.

**Trigger:** A retrospective folded range contains continuity ops or an existing ledger snapshot.

**Evidence:** I constructed a valid in-memory source containing one user-origin rule, folded its user/ops range with `buildClone`, and replayed the clone’s active ancestry:
```json
{
  "before":["Rule: never deploy without approval"],
  "after":[],
  "sourceOpsStillArchived":true
}
```

**Why:** Newly generated branch summaries have retrospective/handoff metadata but no continuity snapshot. Once the original ops are archived, branch-local replay no longer sees them. Subsequent capture cannot recover the archived user message either.

**Qualification:** `retrospective.ts:116–119` warns that extension-specific custom state stays on its original branch. Thus this limitation is partially disclosed. Nevertheless, the package loses its own protected user ledger during its own clone operation; generic disclosure does not establish continuity preservation.

**Fix:** Carry the effective first-party ledger onto generated handoffs, respecting branch-local semantics and subsequent ops. Alternatively, reject affected conversions with a specific actionable warning until supported. Arbitrary third-party custom state can remain explicitly unsupported.

### 8. [minor] Manual folds do not apply the malformed-tool-envelope safety gate

**Where:** `src/fold/fold-runtime.ts:71–137`; `src/fold/fold-preview.ts:105–122`.

**Trigger:** A loaded or externally edited session has an outstanding tool call at the retained anchor, without a corresponding result, followed by substantial text work.

**Evidence:** With the real runtime and a local fake summary transport:
```json
{
  "beforeCut":{
    "ok":false,
    "detail":"the recovery cut is unsafe: tool call without its result"
  },
  "resultStatus":"done",
  "summaryCalls":2,
  "afterCut":{
    "ok":false,
    "detail":"the recovery cut is unsafe: tool call without its result"
  }
}
```

**Why:** Recovery calls `recoveryCutOf`; ordinary manual preparation does not perform equivalent envelope validation. The shared engine therefore does not enforce its documented malformed-envelope refusal invariant.

**Fix:** Validate the selected current projection and fold boundaries before summary calls for every entry point, preserving the existing archived-completion semantics for legitimate rewind targets.

**Qualification:** This reproduction starts with malformed session history. I did not establish that normal current SDK tool execution creates that history.

## Coordinator validation

All eight findings were independently reproduced again by the coordinator. Source checks confirmed the relevant commit, projection, reducer, clone and recovery control flow. Reusable synthetic fixtures and actual output are retained:

```sh
bash .project/analyses/extension-audit/evidence/repro-runtime.sh
bun .project/analyses/extension-audit/evidence/repro-runtime-preservation.ts
```

Outputs: `evidence/pi-tree-audit-runtime.log` and `evidence/pi-tree-audit-runtime-preservation.log`. These are local controller/SessionManager reproductions, not live provider or real concurrent scheduling evidence. The oversized result was 40054 tokens; the omitted message changed from absent to present; the lock-held recovery still called pressure compaction. No product source changed.

## What I checked

- Read the architecture invariants and relevant independent-engine, consolidation and factory-state designs.
- Traced controller/event registration, fold preparation/commit, recovery fallbacks, automatic/consolidation gates, continuity capture/replay/reduction, retrospective construction/publication, and tool dispatch.
- Checked installed SDK behavior for custom-message conversion, session branching, context getters and session replacement.
- Ran the in-memory reproductions described above using `bun -` heredocs. Summary calls used local fake registry transports only.
- Ran:
  ```sh
  bun test tests/fold/fold-engine.test.ts \
    tests/fold/fold-adapters.test.ts \
    tests/continuity/continuity-ledger-reducer.test.ts \
    tests/retrospective/retrospective.test.ts
  ```
  **Result: 67 pass, 0 fail.**
- No source edits, provider calls or process-global configuration changes.

## Verification gaps and integration notes

- The findings above do not depend on the coordinator’s separately reproduced projection-patch ownership, system-frame hoisting or anchor-enumeration performance issues.
- I independently confirmed the missing proposal-runner timeout by source inspection, but leave that finding to the coordinator’s ongoing investigation.
- I did not reproduce an actual SDK shutdown causing a late commit. Installed session replacement awaits `abort()` before shutdown, and several controllers reject stale context access; absence of an extension-owned shutdown controller alone is insufficient evidence of a defect.
- No full gate, live provider acceptance, interactive UI review or crash-durability experiment was run here.
- Final status inspection showed the coordinator’s untracked `.project/analyses/extension-audit/`; I left it untouched.

## Confidence

**High** for the reproduced preservation, authority and hidden-message defects. **High** for the recovery control-flow defects, with real concurrent SDK scheduling and provider behavior still requiring integration tests. **Medium** on prioritizing the disclosed retrospective custom-state limitation as a major product-completeness issue.
