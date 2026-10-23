---
version: 1
id: "classifier-eval-2026-10-23"
title: "Live classifier benchmark for continuity capture and milestone folding"
description: "Index of the 2026-10-23 live OpenRouter classifier runs, their spend, and the result restricted to Pi-catalogued models."
type: "analysis"
created: "2026-10-23T15:11:48+02:00"
updated: "2026-10-23T15:11:48+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Live classifier benchmark, 2026-10-23

Harness: `scripts/classifier-eval/` (cases, budget ledger, adapters, runner,
analysis). Cases are synthetic (96: 24 per task, 16 development and 8 holdout,
families disjoint across splits; English, German, Swiss German and mixed).
No private session content was sent. Requests use the production builders
(`buildIntentClassifierContext`, `buildMilestoneClassifierContext`).

## Runs and spend

- `runs/smoke-2026-10-23`: 32 calls, harness and `provider.max_price` check.
- `runs/dev-screen-2026-10-23`: 25 live candidates plus the heuristic,
  development split, 1,664 observations.
- `runs/holdout-2026-10-23`: shortlist `shortlists/holdout-2026-10-23.txt`,
  3 repetitions, 960 observations.
- Ledger `budget-ledger.jsonl` (cap $25): 2,496 reservations, all settled.
  Billed per generation: **$0.1026**; one call held at its reservation
  ($0.0014). Account-level key deltas include unrelated concurrent usage and
  are not used as evidence.

## Reports

- `reports/dev-screen-2026-10-23/report.md`, `reports/holdout-2026-10-23/report.md`:
  all candidates, including uncatalogued benchmark-only models.
- `reports/catalogued-2026-10-23/report.md`: the same observations filtered to
  models in the Pi catalog (`runs-catalogued-2026-10-23/`). Only these can ship.

## Catalogued-only result (holdout n=8 per task, 3 repetitions)

- **Intent kind:** `microsoft-decision-1` and `jev-1.14` both 0 unsafe accepted,
  75% accepted-exact; `jev-1.14` p95 297 ms vs 1,521 ms. `gpt-6-luna` chat is
  more accurate (91.7%) but accepted 2 unsafe answers.
- **Supersession:** `chain(microsoft-decision-1 > gpt-6-luna chat)` 0 unsafe on
  both splits, 87.5% holdout accepted-exact, $0.037 per 1,000, p95 1.6 s.
- **Milestone status:** no single model is safe on both splits. Only
  `confirm(jev-1.14 + gpt-6-luna-decisions)` has 0 unsafe, at 12.5% accepted-exact.
- **Milestone boundary:** `gpt-6-luna` chat 79.2% accepted-exact, 0 unsafe on
  holdout and 1 on development, p95 6.0 s.

## Limits

Eight holdout cases per task give wide confidence intervals; zero observed
unsafe answers does not establish a low unsafe rate. Labels were authored by
models and checked by a blind annotator (46/48 and 48/48 agreement), not by a
human. Several decision routes returned 404/400 or transient 429/504 and have
no holdout evidence.
