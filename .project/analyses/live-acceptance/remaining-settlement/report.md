---
version: 1
id: "live-acceptance-remaining-settlement"
title: "Why parallel-02 agent-1 settled after two folds without submitting"
description: "Read-only forensic analysis of one failed live navigator acceptance run, locating post-fold-2 model state regression."
type: "analysis"
created: "2026-10-23T11:36:39+02:00"
updated: "2026-10-23T11:36:39+02:00"
createdBy: "analyst (pi subagent)"
updatedBy: "analyst (pi subagent)"
---

# Run settled after two folds without submitting: post-fold-2 state regression

status: "root-caused"
confidence: "high"

## Summary

All 22 provider requests returned 200, there were no retries, no extension errors and no
aborted/error stops. Both folds landed correctly and fold 2's handoff was accurate
(partition 1 and 2 hashes, next step "review partition 3").

The run settled for one reason: after fold 2 the model regressed to the belief that fold 2
had *not* landed, repeated the completed fold with the same `newLabel` (rejected), then asked
`load_partition` for index 1 and 2 instead of 3 (rejected), then declared itself blocked. A
correct `load_partition(index=3)` call would have been accepted at every point after 09:27:00.

No functional defect in the extension or harness gate. Two diagnostic-message weaknesses made
recovery unlikely; that is where a minimal fix belongs.

## Reproduction (observation of a past run, not re-run)

Evidence, session `01a16814-9a27-764a-a1d5-2367dbf07417`, source commit `7bac0ab`:

- `../parallel-02/agent-1/outcome.json`: `submitted=false`, `loaded=[1,2]`, `requests=22`,
  `folds=2`, `extensionErrors=[]`, `userMessages=1`, peak input 117345.
- `../parallel-02/agent-1/events.jsonl.gz` (181 events), `../parallel-02/agent-1/wire.jsonl.gz`
  (22 request / 22 response / 2669 stream events), `../parallel-02/agent-1/*.jsonl` (64 entries).
- Model `openai/gpt-6-luna` (`openai-responses`), `thinkingLevel: low`, maxTokens 128000.
  No reasoning items were produced in any response (stream event types contain no
  `response.reasoning*`), so the model had no scratchpad for state tracking.
- Peer sessions agent-2..agent-6: `submitted=true`, `folds=4` each. The duplicate-label
  pattern also occurred there (16-18 rejections per session) and they recovered, including
  agent-4, which repeated a completed fold at 09:26:36 and then loaded `index=3` correctly at
  09:27:38 after its own refusal.

### Final turn sequence (agent-1, Europe/Zurich 11:26-11:27)

| Time (UTC in evidence) | Entry / request | Call | Result |
| --- | --- | --- | --- |
| 09:26:46.000 | assistant, req 14 | `rewind` reviewed-one -> reviewed-two | accepted |
| 09:27:00.583 | summary msg `0f1fd4c7` -> branch_summary `a1d45dbf`, rewind msg `150a901b` status `done` | - | fold 2 landed, ctx 31.2% -> 0.8% |
| 09:27:02.801 | assistant `f0c91337`, req 16 | `navigate_tree list` | 3 labels, reviewed-two at 0.8% |
| 09:27:09.501 | assistant `51f23e00`, req 17 | `rewind` reviewed-one -> reviewed-two (**repeat**) | `9fab9050`: label already exists |
| 09:27:13.109 | assistant `bf24db8f`, req 18 | `load_partition index=1` | `0d3d09b6`: Refused |
| 09:27:19.861 | assistant `499a0f6f`, req 19 | `rewind` reviewed-one -> fold-p2 | `e16eff83`: would free only ~2.0k |
| 09:27:22.362 | assistant `f04058ad`, req 20 | `load_partition index=2` | `42c2e7e8`: Refused |
| 09:27:28.849 | assistant `732e12dc`, req 21 | `rewind` context-gathered -> reviewed-two-fold | `f0f4108d`: would free only ~3.0k |
| 09:27:31.664 | assistant `23b39ebb`, req 22 | `load_partition index=2` | `fae48a4e`: Refused |
| 09:27:35.411 | assistant `02952fc4`, final text | stop | "I'm blocked...", `agent_settled` 09:27:35.418 |

Request constraints of the post-fold-2 continuation (wire request 15, 09:27:00.587, 1251 input
tokens + 1792 cacheRead, usage recorded as fold 2 `nextUsage`): developer prompt, the original
user goal verbatim, one collapsed `function_call` with "No result provided", the **older**
`# Work handoff: reviewed one` (whose `## Next Steps` says "Continue with partition 2" and
whose `### Blocked` says tools are unavailable), the current `# Work handoff: reviewed two`
(`## Next Steps`: "Continue with partition 3..."), and the rewind notice for reviewed-two.
No nudge message, no user message (`userMessages=1`).

## Root cause

Causal chain, all steps observed:

1. Fold 2 completes correctly (`extensions/navigate-tree/index.ts` completeRewind path; session
   entries `a1d45dbf` branch_summary, `150a901b` rewind `done`, labels `reviewed-one`/`reviewed-two`).
2. The continuation request (wire 15) carries two handoffs. The stale one's `## Next Steps`
   points at partition 2; both handoffs assert `### Blocked` ("Required review and
   report-submission tools are unavailable in this turn" / "No source for partitions 3 and 4
   or report-submission capability is available in this turn"). Those statements are artefacts
   of the text-only summary turn, not task blockers.
3. The model's first post-fold turn calls `list` (state unchanged: reviewed-two at 0.8%), then
   re-issues the already-completed fold. `extensions/navigate-tree/index.ts:5319` rejects it
   with a message that only says "pick a fresh newLabel", which reads as "the fold did not
   land" and actively invites a redundant second fold.
4. The model then asks for `load_partition(1)` and twice `load_partition(2)` instead of `(3)`.
   `scripts/live-navigator-acceptance.mjs:104` returns one generic string for both failure
   modes ("load the next partition sequentially, after the previous fold lands"), so the
   refusal is read as "the fold has not landed".
5. Its final text repeats that misdiagnosis and it stops with `stopReason: stop`; nothing
   resumes it (harness deliberately sends no follow-up; `userMessages=1`).

Settlement trigger = model state regression (step 3-4). Contributing = the two
non-state-reporting refusal messages and the false `### Blocked` lines in the handoff.

## Evidence: what was ruled out

- **Provider / transport**: 22 responses, all status 200 (09:25:45 - 09:27:33), 22
  `response.completed`, no `response.failed`/`error` events, `settings.retry.maxRetries=2`
  never used, `extensionErrors=[]`, no `stopReason` other than `toolUse`/`stop`.
- **Continuation nudge**: `CONTINUE_NUDGE_TEXT` (`index.ts:1966`) never fired in any of the six
  sessions (0 occurrences of "You ended the turn immediately after a rewind" in any
  `wire.jsonl.gz`). Suppression is correct by design: `continueNudgeDraft`
  (`index.ts` ~3400-3410) returns early when the first post-fold message contains a `toolCall`,
  which `f0c91337` does. The nudge is not the defect; it simply cannot fire for a wrong tool call.
- **Harness gate bug**: `load_partition` (`scripts/live-navigator-acceptance.mjs:104`) uses
  `part !== loaded.size + 1 || folds().length < part - 1`. At 09:27:13 `loaded.size=2` and
  `folds().length=2` (`3f373c51` and `150a901b`, both `status=done`), so `index=3` would have
  passed `3===3` and `2>=2`. Index 1 and 2 were refused correctly. `submit_report`
  (`:115`) was never called, and could not have been reached anyway.
- **Fold/summary correctness**: fold 2's summary preserves both partition hashes and names
  partition 3 as next; the continuity ledger reached rev 6 with F2-F6 intact; `hashPreserved`
  true for both folds in `outcome.json`.

## Recommended fix

Primary (one line, `scripts/live-navigator-acceptance.mjs:104`): make the refusal state-bearing
so a misindexed call is self-correcting, e.g.

```
`Refused: load_partition(${part}); loaded=[${[...loaded]}]; folds=${folds().length}/4; next loadable index is ${loaded.size + 1}.`
```

Secondary (`extensions/navigate-tree/index.ts:5319`): when the duplicate `newLabel` is the
branch label of an existing completed fold on the active branch, say the milestone already
landed and point at the current branch_summary's `## Next Steps`, instead of inviting a fresh
label (agent-4 created the redundant fold `reviewed-one-alt` this way at 09:26:45).

Third (summary prompt, the text built in `index.ts` around the `[navigate_tree] Summarize only
messages N onwards` request, verified verbatim in wire request 14 input[18]): state that the
summary turn's lack of tools is not a task blocker, so `### Blocked` is not filled with "tools
unavailable in this turn"; both folds in this run recorded that false blocker.

Regression tests: extend `extensions/navigate-tree/index.test.ts:5705` (duplicate-rewind
message assertion) with the already-landed-fold case, and add a harness-side assertion on the
`load_partition` refusal text in `scripts/live-navigator-acceptance.mjs` (there is no test
file for the script today; a unit-level check of the message string is sufficient). No change
to acceptance criteria: the run correctly fails.

## Open questions / follow-ups

- Whether a rerun at a higher thinking level removes the regression is unverified; this run
  produced no reasoning items at `thinkingLevel: low`, which is the most likely capacity limit.
- Stale handoff accumulation: after fold 2 the continuation carried the reviewed-one handoff
  whose `## Next Steps` points at partition 2. Whether the extension should keep only the
  newest branch_summary is a design question for the lead, not a confirmed defect.
- `scripts/live-navigator-acceptance.mjs` has no automated test surface for its gates.
