---
version: 1
id: "analysis-stop-after-fold"
title: "Why agents stop after a navigate_tree fold instead of continuing the authorized work"
description: "Root-cause analysis of post-fold stops in pi-tree-navigator: 169 completed rewinds across 24 pi session files were classified by what happened next; the mechanical continuation works, and the stop is decided by the fold's own summary Next Steps plus the continuation wording that promotes it above the user's standing authorization."
type: "analysis"
status: "root-caused"
confidence: "medium"
created: "2026-10-22T17:04:23+02:00"
updated: "2026-10-22T17:04:23+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Post-fold stops: the continuation is honoured, the summary's own Next Steps end the run

status: "root-caused"
confidence: "medium"

## Summary

The `continue: true` continuation is not broken: of 169 completed folds in the local session
corpus, 168 produced an assistant turn after the continuation and 158 of those opened with tool
calls. The stop is written into the fold itself. A rewind is issued at a milestone boundary, so
the `summaryFocus` and the r5d summary record the remaining work as "deliver the final report"
(21 of 169 folds), and `buildRewindDoneText` makes that list the authoritative work order
("execute them next") while declaring retained user messages stale. The model then executes the
only open item - the report - and ends the run: 14 of those 21 report-only folds ended the run
within three assistant turns (all 21 within 12), against 4 of the 148 folds whose summary named
real work.

Fix: state the authority order in the continuation (standing user authorization > plan/todo >
summary's open items), add a `## Standing authorization` section to the summary request, forbid a
report-only `## Next Steps` while authorized work is open, and add a once-per-fold continuation
guard that re-prompts when the first post-fold turn is text-only.

## Reproduction

Corpus and method (read-only; scripts in this directory):

- `~/.pi/agent/sessions/**/*.jsonl`: 1163 session files, 705 MB, all dated 2026-10-20..2026-10-22.
  24 files contain a `customType: "navigate-tree-rewind"` entry (185 such entries in total).
  170 carry `details.status == "done"`; the rest are failed, forced or in-progress endings.
  `python3 scan.py` classifies 169 of the 170 (`~/.pi/agent/sessions` is reachable twice through a
  `/mnt/shared/data/sessions` symlink, so one file is scanned under both paths).
- Ten project directories: `nukular/experiments/spike-memory` (46), `in-core-ai` (32),
  `nukular/nukular-ai` (29), `agentd-ts` (24), `pi-tree-navigator` (11), `pi-claude-auth` (10),
  `pi-me` (5), `hosts/devlap05` (5), `pi-tldr` (4), `/mnt/Projects` (3).
- Models: gpt-6.1-sol 51 folds, gpt-6-astra 41, gemini-4-argon 28, claude-opus-5-5 22,
  gpt-6-luna 16, deepseek-flash 6, DeepSeek-V4.1-Flash 2, claude-sonnet-5-5 2.
- For each fold: the first `assistant` entry after the continuation, whether it carried a tool
  call, and the length of the whole post-fold run segment (assistant turns until the next real
  user message).

Observed classification of the 169 valid folds:

- continued with tool calls on the first post-fold turn: **158 (93.5%)**
- text-only reply, run ended: **10 (5.9%)** (8 followed by a user message, 2 followed by a
  background-job custom message that the model answered once and then stopped)
- no assistant turn: **1** (`spike-memory` 2026-10-21 23:56:29 Europe/Zurich) - a queued user
  message arrived between the continuation and the turn, so the model answered the user instead.
  Not a dropped `continue`.
- post-fold run segment ended within 3 assistant turns: **18 (10.7%)**. 14 of them are the
  report-only summaries below; the other 4 are a blocker the model could not pass (awaiting a
  reviewer, a hardware/user choice), a genuinely finished task, or a queued user message that
  superseded the continuation. None is a mechanical failure.

The decisive split is the content of the summary's `## Next Steps`, hand-classified over all 169
folds (`auth.json`, `trigger.json`, `folds.json` in this directory hold the extracted fields):

| first pending item in `## Next Steps` | folds | run ended within 3 turns |
|---|---|---|
| report / hand-off / wrap-up ("Send the final user-facing outcome report", "Deliver a concise final report directly in chat", "Write the final report to the user") | 21 | **14** |
| real work, or waiting on an external blocker | 148 | 4 (blocked, finished, or superseded) |

Per model, report-only folds: gpt-6-astra 8/8 ended the run within 3 turns; gpt-6.1-sol 4/8;
gpt-6-luna 1/3; claude-sonnet-5-5 1/1; deepseek-flash 0/1. gemini-4-argon and claude-opus-5-5
never produced a report-only fold (0 of 50).

## Root cause

Causal chain, with the observed instances:

1. **The fold fires at a milestone boundary, at the moment the model's own next action was a
   wrap-up report.** The tool description and the always-on system-prompt append say so:
   `extensions/navigate-tree/index.ts:206` `ANCHOR_MANDATE` - "list anchors and rewind **after
   every milestone** or rabbit hole / dead end to keep context low". 138 of 169 folds were
   self-initiated (31 came from the `navigate-tree-auto-rewind` sidecar steer,
   `extensions/navigate-tree/auto-navigate.ts:70`).
2. **The `summaryFocus` - written by the acting model before the summary turn - already declares
   the unit finished.** Observed verbatim (`agentd-ts`, 2026-10-21 15:13:09 Europe/Zurich):
   "Next action ONLY give final user-facing outcome report (no more implementation needed this
   turn)"; (`pi-tree-navigator`, 2026-10-21 23:36:44) "Task is DONE, not awaiting more
   implementation. ... then deliver the final report directly to the user".
3. **The r5d summary turn runs in an explicitly non-acting frame and rewrites that into
   `## Next Steps`.** `extensions/navigate-tree/summary-prompt.ts:24` - "This is a
   summarization task, not a problem-solving task. ... Do NOT continue the conversation, carry
   out requests from its history, investigate, solve pending tasks". The required format
   (`summary-prompt.ts:48`) has no place for standing authorization, and the focus is not
   carried through: 5-gram coverage of the focus inside the produced summary has a median of
   0.09 (p75 0.17, max 0.58, n=169). Only 39 of 169 summaries contain any explicit
   "user instruction" line.
4. **`buildRewindDoneText` promotes that list to the authoritative work order and marks the
   retained user instruction stale.** `index.ts:1946-1960`: "... '### In Progress', '### Blocked',
   or '## Next Steps' are pending - **execute them next without re-confirming with the user** ...
   User messages retained above predate this rewind - **do not re-answer them**." After the
   fold, the only definition of the task that the model has is the summary; the plan and the
   user's authorization are not mentioned in the continuation.
5. **The model does the only open item, legitimately ends the turn, and the run settles.** The
   main agent's own rules (`~/.pi/agent` system prompt, "## Ending a Turn") allow ending "when
   the task is done and verified", and forbid ending "because a milestone feels like a good point
   to report". Both fire the same way once the summary has redefined the task as "report": the
   report is the task, so the turn ends and the authorized plan stays untouched.

Why this is a fold problem and not simply a model problem: the fold *ratifies* the pre-fold
scope decision and removes every counterweight to it. The summary has no authorization section,
the continuation never re-states the authorization, and the retained user messages are declared
predates. The observed case with the clearest mismatch (`agentd-ts`, 2026-10-21 15:13:09): the
retained user message "approved, go ahead" was still in context above the anchor, and the
summary's step 2 says "Show a compact roadmap: **M1 done -> M2 next** ... **Do not begin M2**".
The model reported M1 and stopped; the user re-tasked it manually. 7 of the 21 report-only
summaries name further milestones or roadmap positions while instructing the model to report.
9 of the 21 had an explicit autonomy authorization in scope (retained or collapsed).

## Evidence

Experiments and what they ruled out.

- **Mechanical continuation (H4): refuted.** 168/169 folds have an assistant entry after the
  continuation; 158 of those begin with a tool call. The one exception is a queued user message.
  `turn_end` at `index.ts:3291` / `deliver(drafts, true)` (`index.ts:3311`) maps straight to
  `continue: true`; the only exception is a forced rewind whose summary attempts are exhausted.
  A later `agent_before_settle` (`index.ts:3640`) is only consulted for pending/forced rewinds. No
  later extension or settle path ended a run that the fold had continued.
- **Auto-navigate sidecar (fold source): not the cause.** 31 folds were steered by
  `navigate-tree-auto-rewind`; 1 of them ended within 3 turns, and only 2 produced a report-only
  summary (sidecar focuses are written by the controller model and are usually work-shaped).
  A sidecar-triggered fold can still be refused for insufficient savings and the model resumes
  work (observed: `nukular-ai`, 2026-10-21 14:43:18 - "Rewind wouldn't free meaningful context -
  completing the edits directly").
- **H1, "do not re-answer them" makes the model treat the go-ahead as stale: not supported.**
  95 folds had an autonomy-authorized user message retained above the anchor; 144 of the 148
  work-shaped folds continued normally. No transcript shows the model reasoning that a retained
  instruction predates the rewind. Where a retained authorization and a report-only summary
  coexisted (8 folds, 5 of them stopped within 3 turns) the model stopped because of its own scope
  reading, not because of the clause (the `agentd-ts` example above: the model's focus says
  "Approved M1 ..., NOT M2-M4").
  The clause has no upside once the precedence wording exists, so it is worth deleting, but it is
  not the trigger.
- **H2, "harness default: end turn and report": refuted.** The main agent system prompt forbids
  ending a turn to report a milestone ("Do not end a turn ... because a milestone feels like a
  good point to report"). What the harness supplies is the *rule*, not the scope: the scope comes
  from the summary, and the rule then completes it. The summary template indeed has no
  authorization section (`summary-prompt.ts:36-56`), which is a contributing factor.
- **H3, "structural reply to a user-role custom message": partial.** The terminal message is
  always a completion report, never a question ("Shall I continue?" never appears), so the shape
  matches. But 158 of 169 responses to the same message shape are tool calls, so the shape is not
  what stops the run; the content of the summary is.
- **Authorization preservation: measured.** 17 folds had an autonomy-authorized user message inside
  the collapsed range (in 4 of them that was its only copy). The summary paraphrased it in all 17,
  never verbatim, and 2 of those 17 still ended in a report-only Next Step. Focus-to-summary 5-gram
  coverage median 0.09 confirms the summary is a rewrite, not a transmission.

## Recommended fix

All paths are in this repository.

1. **Continuation wording - `buildRewindDoneText`, `extensions/navigate-tree/index.ts:1946`.**
   Replace the last two sentences with an explicit authority order, e.g. append after the
   context-delta line:

   > Items under '### Done' are complete. Items under '### In Progress', '### Blocked' or
   > '## Next Steps' are the resume point. Continue the latest branch_summary's work without
   > re-confirming with the user.
   > A branch_summary marks a milestone, not the end of the task. Your authority, highest first:
   > the user's standing instruction retained above (including any authorization to work
   > autonomously until the task is complete or a real blocker appears), the authorized plan or
   > todo list, then this summary's open items. If the summary's only open item is a report,
   > hand-off or wrap-up while an authorized instruction or plan item is still open, do that work
   > first and report once, at the end of the authorized scope. Retained user messages already
   > answered above are historical - do not re-answer them; their standing instructions still
   > apply.

   Rationale: this is the only place that re-establishes the authority the fold drops, and it
   removes the "predate this rewind" claim that currently reads as a blanket invalidation.

2. **Summary instruction - `buildSummaryInstruction` / `buildSummaryRequestText`,
   `extensions/navigate-tree/summary-prompt.ts:57-101`.** Do not reflow the byte-exact r5d block
   (the file's own rule). Append a block the way parent mode already appends:

   > After the sections above, append one more section: `## Standing authorization` - quote the
   > user's current authorization and scope verbatim (for example 'work autonomously until
   > done'), or write '(none)', and state whether that scope is complete. In `## Next Steps`,
   > name the next concrete work item of the authorized scope. Do not list a report, hand-off or
   > wrap-up while authorized work remains; a completed milestone is not the end of the task.

3. **`summaryFocus` schema description - `index.ts:4809`.** Extend part (3): "what's left to do as
   a next action - if the user authorized continuing and a plan item follows, name that work
   item, not a report or wrap-up."

4. **Deterministic continuation guard (once per fold), in the `turn_end` handler at
   `index.ts:4325`.** When the turn that ends is the first turn after a delivered rewind
   continuation, that turn produced no tool call, and the summary recorded at least one open item,
   emit one steer with `continue: true`:

   > [navigate_tree] You ended the turn immediately after a rewind. Its branch_summary is a
   > milestone summary, not a stop condition: if the user's standing instruction or the authorized
   > plan still has open work, continue with it now, in this turn. End the turn only when the
   > authorized scope is done and verified, or a real blocker needs the user - and say which.

   Bound it with a `Set` keyed on the fold's `summaryId` so it can fire at most once per fold, and
   skip it when the batch contained a `status:"failed"` ending or a forced rewind. This catches the
   10 immediate stops and 14 of the 18 early stops without touching the 148 work-shaped folds.

Regression tests (project style, extend `extensions/navigate-tree/index.test.ts`, harnesses at
~L2965 and ~L10891):

- `buildRewindDoneText` contains the authority-order sentences and no longer says retained user
  messages "predate this rewind" without the standing-instruction qualifier.
- `buildSummaryRequestText` appends the `## Standing authorization` instruction and leaves the r5d
  body byte-identical (there is already a byte-exactness test in `summary-prompt.test.ts`).
- turn_end guard: rewind delivered, next turn text-only with open items -> exactly one
  `continue: true` steer; a second text-only turn -> no further steer; a post-fold turn with a
  tool call -> no steer; failed/forced fold -> no steer.

Same pattern elsewhere: nothing else in the extension emits a continuation that redefines the
task; `buildLateEntriesNote` (`index.ts:1962`) and `buildForcedRewindText`
(`rewind-hint.ts`) are neutral. The `auto-navigate` steer text "Completed milestone 'X' ready to
fold" (`auto-navigate.ts:70`) asserts completion, which is accurate for its trigger but should
not be reused anywhere a milestone may still have work behind it.

## Open questions / follow-ups

- The counterfactual ("would the agent have continued without the fold?") is not observable from
  the logs. The 14/21 report-only stop rate shows the summary predicts the stop, not that the fold
  causes it. A live A/B on one model (same task, fold vs. no fold at the same milestone) is the
  clean test and needs a scripted pi session, not log archaeology.
- Sample bias: 3 days of logs, 24 sessions, and gpt-6-astra / gpt-6.1-sol dominate the report-only
  folds (16 of 21). gemini-4-argon and claude-opus-5-5 produced none in 50 folds, so the effect is
  model-dependent and the recommended wording should be re-measured per model.
- Artifact `folds.json` and `auth.json` hold truncated session excerpts (user messages, summaries,
  continuations truncated to 600 chars). They are evidence for the counts above; review before
  publishing this directory outside the repository.
- Unrelated observation: one `navigate_tree` rewind was refused for insufficient savings after an
  auto-navigate steer (`nukular-ai` 2026-10-21 14:43:18); the sidecar's `rewind_at_tokens`
  threshold and the extension's own savings floor can disagree, which costs the model a turn.
