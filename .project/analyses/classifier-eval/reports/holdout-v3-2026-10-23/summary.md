---
version: 1
id: "classifier-holdout-v3-2026-10-23"
title: "Expanded holdout (32 cases per task, 3 repetitions): milestone variants and capture policy"
description: "Pre-registered policy comparison on the expanded holdout; chains that looked safe on development leak unsafe answers, confirm policies do not."
type: "analysis"
created: "2026-10-23T16:16:38+02:00"
updated: "2026-10-23T16:16:38+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Expanded holdout v3

## Runs

- `runs/holdout-v3-2026-10-23/milestone`: 2,304 live calls, 0 errors. Models
  `chat:openai/gpt-6-luna`, `decisions:typesafe/jev-1.14`,
  `decisions:openai/gpt-6-luna-decisions`, `decisions:microsoft/microsoft-decision-1`;
  variants `base`, `instructions`, `granular`; 32 holdout cases per task, 3 repetitions.
- `runs/holdout-v3-2026-10-23/capture`: 768 live calls plus the local heuristic, 0 errors.
  Models `decisions:microsoft/microsoft-decision-1`, `decisions:typesafe/jev-1.14`,
  `chat:openai/gpt-6-luna`, `heuristic`; intent and supersession holdout, 3 repetitions.
- Ledger after both runs: $0.5540 billed, $0.0547 held, $24.3913 remaining of $25.

## Analysis inputs

`analyze.ts` combines a development run and the holdout run per report:

- `milestone/`: development = `runs/milestone-spikes-2026-10-23/dev-1` filtered to
  candidates ending in `#base`, `#instructions` or `#granular` (1,152 observations);
  holdout = `runs/holdout-v3-2026-10-23/milestone`. `--top 8`.
- `capture/`: development = `runs/dev-screen-2026-10-23` filtered to the four capture
  candidates and to intent/supersession cases (128 observations); holdout =
  `runs/holdout-v3-2026-10-23/capture`. `--top 4`.

The filtered development copies were temporary; rebuild them with the same filters.

## Selection bias

The report's "recommended pipeline" is the best of up to 120 enumerated pipelines by
holdout score, which is optimistic. Only policies named from development evidence
before this run are compared below (pre-registered: the user's conservative confirm,
the spike report's recommended chain/confirm, the development-best vote and singles).

## Milestone (holdout n=32 per task; development n=16)

Unsafe = accepted unsafe answers over 96 holdout decisions (H) / 48 development (D).

| policy | status H unsafe / acc-exact | status D | boundary H | boundary D | $/1k | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| confirm(jev#instructions + luna-chat#instructions) | 0 / 64.6% | 0 / 81.3% | 0 / 76.0% | 0 / 75.0% | 0.147 | 4-8 s |
| confirm(jev#instructions + luna-decisions#instructions) (closest to E14) | 0 / 43.8% | 0 / 56.3% | 0 / 53.1% | 0 / 60.4% | 0.177-0.186 | 1.0-1.5 s |
| chain(jev#instructions > luna-chat#instructions) | **18** / 77.1% | 0 / 95.8% | 3 / 93.8% | 3 / 93.8% | 0.074 | 3-5 s |
| chain(jev#granular > luna-chat#instructions) | **8** / 82.3% | 0 / 93.8% | 3 / 93.8% | 0 / 100% | 0.099 | 3-7 s |
| vote(ms#instructions, jev#instructions, luna-chat#instructions) | 3 / 70.8% | 0 / 95.8% | 0 / 87.5% | 0 / 77.1% | 0.19 | 3.6-8 s |
| chain(jev#granular > luna-decisions#granular) | 6 / 68.8% | 0 / 89.6% | 0 / 82.3% | 0 / 87.5% | 0.128-0.131 | 0.6-1.1 s |
| single(luna-chat#instructions) | 3 / 92.7% | 0 / 95.8% | 5 / 91.7% | 0 / 93.8% | 0.08 | 3.6-8 s |
| single(luna-decisions#granular) | 0 / 62.5% | 0 / 75.0% | 0 / 59.4% | 0 / 75.0% | 0.17-0.18 | 0.8-1.5 s |

Findings:

1. Escalation chains that were safe on development leak unsafe answers on holdout:
   the second model is asked exactly the hard cases the first abstained on.
2. Only `confirm` policies kept zero unsafe on both splits for status.
   `confirm(jev#instructions + luna-chat#instructions)` dominates the E14 policy
   (luna-decisions as confirmer) on accuracy at lower cost, with higher latency.
3. Eight new holdout cases ("phase done, next phase running") are labelled `continue`
   by convention; reviewers called `milestone` defensible there, and it is scored
   unsafe. Status unsafe counts of singles are therefore strict.

## Capture

| policy | intent H unsafe / acc-exact | intent D | supersession H | supersession D | $/1k |
| --- | --- | --- | --- | --- | --- |
| single(microsoft-decision-1) (preset kind stage) | 0 / 78.1% | 0 / 81.3% | 0 / 65.6% | 0 / 75.0% | 0.010-0.018 |
| chain(microsoft-decision-1 > luna-chat) (preset supersession) | 2 / 94.8% | 0 / 93.8% | **1** / 92.7% | 0 / 93.8% | 0.022-0.042 |
| confirm(microsoft-decision-1 + luna-chat) | 0 / 77.1% | 0 / 81.3% | 0 / 53.1% | 0 / 62.5% | 0.054-0.093 |
| single(luna-chat) | 3 / 96.9% | 0 / 93.8% | 7 / 79.2% | 0 / 87.5% | 0.05-0.08 |
| replay(heuristic) (shipped default) | 45 / 31.3% | 8 / 31.3% | 45 / 31.3% | 11 / 18.8% | 0 |

The preset's kind stage holds (0 unsafe). Its supersession escalation produced one
accepted unsafe supersession in 96 holdout decisions. `replay` rows count missed
protected kinds as unsafe, which is why the heuristic-only default scores 45.

## Open decisions (for the user)

- Milestone auto-fold policy: `confirm(jev#instructions + luna-chat#instructions)` for
  both questions (recommended) versus the E14 confirmer `luna-decisions`.
- Capture preset supersession: keep the luna escalation (92.7%, 1 unsafe in 96) or
  drop it to microsoft alone (65.6%, 0 unsafe).
