---
version: 1
id: "independent-folding-engine-design"
title: "Independent folding engine: design and units"
description: "Execution model, interfaces and delivery units for the shared fold engine used by manual, automatic, agent and recovery folds."
type: "plan"
created: "2026-10-23T13:42:45+02:00"
updated: "2026-10-23T13:42:45+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Independent folding engine

User decision (2026-10-23): one shared engine for every fold entry point, delivered in
full. A fold must never depend on another main-agent turn succeeding.

## Execution model

```text
entry point ──> FoldRequest ──> engine (per-session lock)
  /anchor fold        │           1 snapshot at a safe point
  rewind tool         │           2 deterministic gates (target, label, batches,
  auto controller     │             pre-compaction, savings floor)
  overflow / guard    │           3 summarize (side call, fold-summarizer.ts)
                      │             A in-context (cache prefix) if admitted
                      │             B chunked map-reduce otherwise
                      │           4 commitFold (validation, materialize, prospective
                      │             budget, branch, labels, late input, refresh, tree)
                      └────────── 5 outcome: continuation / failure receipt
```

Safe points:

- **Idle:** run immediately. The UI shows progress; Esc cancels. Commit with direct
  session writes, refresh agent messages, emit `session_tree`, append the outcome
  message. Trigger a turn only when unanswered user input is preserved (recovery).
- **Running:** run inside the next `turn_end` boundary handler (awaited, like the
  old summary turn). Commit, return the continuation draft with `continue: true`.
- **Overflow or pre-request guard abort:** the aborted turn's `turn_end` runs a
  recovery fold (Strategy B when A cannot be admitted), then continues.

## Decisions

- **E1** The in-band summary turn is removed: no summary-request message, request
  freeze, tool-call gate or hidden attempts. The runner sets native `toolChoice: none`.
- **E2** Strategy A context = system messages captured from the latest
  `context_with_system` event + `convertToLlm(buildContextMessages(sm))` + the summary
  request, same model, thinking level and `sessionId`. pi 1.3 carries the system prompt
  and tool declarations as system messages inside `messages`.
- **E3** Summary model defaults to the session model (cache reuse); a configured
  summary model is optional.
- **E4** Late input: user or custom messages after the snapshot point, and trailing
  unanswered user messages in recovery, are re-appended after the summary and named
  in the continuation. They are never folded away.
- **E5** Restart safety: `branch:<label>` on the old leaf before branching; failures
  write an outcome entry. Nothing is written before commit, so a crash mid-summary
  leaves the original history.
- **E6** Overflow recovery (#101) folds directly instead of forcing the model to call
  `rewind`; tool-result withholding is no longer needed for the summary to fit.
- **E7** Recovery/automatic target selection is deterministic: the newest valid anchor
  whose projected post-fold request leaves the configured reserve; otherwise the oldest
  valid anchor; no valid anchor is a failure receipt with the reason.
- **E8** One admission estimate (U5) for list, hint, anchors, controller, guard, the
  engine's Strategy A admission and the commit gate.
- **E9** Classifiers answer semantic questions only (benchmark decides models);
  safety gates stay deterministic.
- **E10** (user, 2026-10-23) `/anchor fold` opens a one-screen recommended plan:
  target, label, projected result and summary strategy; Enter folds, `e` edits
  label/focus, arrows choose another anchor; progress line with Esc cancel.
- **E11** (user) Recovery is on by default; milestone-driven automatic folding stays
  opt-in until the benchmark shows a reliable controller.
- **E12** (user) A fold requested while the agent works runs at the next turn boundary.
- **E13** (user) Continuity capture ships heuristics-only by default. The benchmarked
  'Split + chain' policy (microsoft decision-1 for kind and supersession, gpt-6-luna
  escalation when supersession abstains) is a tunable preset: stages can be disabled,
  swapped or given instruction overrides.
- **E14** (user) Opt-in milestone auto-fold starts from conservative confirm (status:
  jev-1.14 and gpt-6-luna-decisions agree; boundary: gpt-6-luna chat), pending spikes
  on instructions, granular chained questions and tree context, and an expanded holdout.

- **E15** (user, 2026-10-23) Drop both rewind call-shape rules: a `rewind` may share
  its message with other calls and may appear anywhere in a codemode script. The fold
  runs at `turn_end` after every sibling/nested call finished. Not documented in the
  tool description because it no longer exists (applied in U4a.2).
- **E16** Candidate projection (U4b/U4c/U4d share it): `projectedAfterTokens` must come
  from the same materialization `commitFold` previews (full-mode child handoffs, the
  continuity briefing, late input, continuation), with a placeholder summary sized at
  the reduce output cap. An anchor estimate alone under-prices folds that re-attach
  child handoffs (the 141.5k -> 218.4k refusal). Extract a pure preview from
  `commitFold` and reuse it. Recommendation budget: window minus the resolved hint
  reserve, or 25% of the window when the hint is off.
- **E17** (user, 2026-10-23, supersedes E14's confirmer) Opt-in milestone auto-fold uses
  `confirm(jev-1.14#instructions + gpt-6-luna chat#instructions)` for both status and
  boundary: 0 unsafe on development and expanded holdout; status 64.6%, boundary 76.0%
  accepted-exact; p95 4-8 s per check (`reports/holdout-v3-2026-10-23/summary.md`).
- **E18** (user, 2026-10-23) The capture preset keeps the gpt-6-luna escalation for
  supersession (92.7%, 1 unsafe in 96 on holdout v3) and adds a retirement safety
  check: a retirement proposed by the escalation applies only when another classifier
  confirms that specific item is replaced. Verifier chosen by a pre-registered live
  spike (selected on development, reported on holdout).

## Units

| Unit | Scope | Status |
|---|---|---|
| U1 | `fold-summarizer.ts` | merged |
| U5 | unified admission estimate | merged |
| U2 | extract `commitFold` from `completeRewind`, behavior unchanged | merged (fold-point boundary fixed in 38916ac) |
| U3 | `fold-engine.ts`: request, lock, snapshot, inputs, summarize, commit (DI) | merged |
| U4a | rewind tool on the engine; delete the in-band summary turn | U4a.1 host merged (a4e0182); U4a.2 in progress |
| U4b | `/anchor fold`: one-screen recommended plan, progress, cancel | UI module merged; wiring with U4a |
| M1 | `milestone-policy.ts`: E17 confirm policy, tunable, production builders | in progress |
| R1 | retirement-verification spike for E18, then preset integration | in progress |
| U4c | auto controller executes through the engine | later |
| U4d | overflow and guard-abort recovery through the engine | later |
| U6 | live acceptance: refused full window, pre-compaction anchor, auto fold, TUI | later |

## Acceptance cases to keep

- A session whose next main request is already refused by the admission guard folds
  and continues without a user prompt.
- A pre-compaction anchor is priced by its real footprint and refused before work.
- A materialization that does not reduce context keeps the original history.
- Oversized evidence is chunked without truncation or fails with an explicit reason.
