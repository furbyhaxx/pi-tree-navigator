---
version: 1
id: "milestone-classifier-spikes-2026-10-23"
title: "Milestone classifier spikes: instructions, granular questions, session structure"
description: "Development-split results for milestone-status and milestone-boundary request variants on four catalogued models, with offline ensembles and spend."
type: "analysis"
created: "2026-10-23T15:54:20+02:00"
updated: "2026-10-23T15:54:20+02:00"
createdBy: "worker"
updatedBy: "worker"
---

# Milestone classifier spikes (development split only)

Holdout was not run. Runs: `runs/milestone-spikes-2026-10-23/{smoke,smoke-2,dev-1}`.
Cases: the 32 development milestone cases (16 per task, both questions scored in every case),
unchanged `cases.ts` of d0be523. Models: `decisions:typesafe/jev-1.14`,
`decisions:openai/gpt-6-luna-decisions`, `decisions:microsoft/microsoft-decision-1`,
`chat:openai/gpt-6-luna`. Gate 0.7. Each candidate key is `<model>#<variant>`.

## Variants (`scripts/classifier-eval/milestone-variants.ts`)

- `base`: production builder, `structure` stripped. 128 of 128 first-repetition requests have the same
  `requestSha256` as the earlier dev-screen observation of the same model and case.
- `instructions`: same two questions and choice keys; crisper status criteria (open work, contradicted claims and
  unsure all mean continue; await-user outranks milestone) and boundary instructions (the completion report, none when the
  only claim is contradicted).
- `granular`: one request with yes/no questions `asks-user`, `blocked`, `open-work`, `finished` and one
  `report:<id>` per assistant record. Code combines them: any yes on asks-user, blocked or open-work decides
  await-user, blocked or continue alone; milestone needs all four answered, only `finished` yes, with the lowest of the
  four confidences; boundary is the newest record reported as a finished phase, with the lowest confidence of it and every
  later `no`; a missing or invalid answer at or after the report omits the boundary. Raw answers are kept in `raw`.
- `tree-heuristic`: case `structure` if present, else objective (first user record), later user records as goals and
  the last anchor, derived from the records. The cases carry no structure yet, so the derived one was used.
- `tree-luna`: `chat:openai/gpt-6-luna` writes objective, goals and anchors from the records (one call per case, shared by
  every model; 32 calls, $0.0037 billed, 2.3 s mean). Its cost and latency are added to every observation that uses it.
- Combinations: `instructions+tree-*` and `granular+tree-*`.

## Results, first repetition (n = 16 per task, all variants)

Accepted-exact counts a case only when both questions are correct and accepted (confidence >= 0.7); unsafe is the
number of accepted unsafe answers over both questions.

| candidate#variant | n per task | status task: accepted-exact | unsafe | boundary task: accepted-exact | unsafe | $/1k calls | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `decisions:microsoft/microsoft-decision-1#base` | 16 | 8/16 (50.0%) | 6 | 7/16 (43.8%) | 6 | $0.032 | 334 | 842 |
| `decisions:microsoft/microsoft-decision-1#granular` | 16 | 7/16 (43.8%) | 4 | 10/16 (62.5%) | 0 | $0.051 | 367 | 738 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | 16 | 7/16 (43.8%) | 4 | 10/16 (62.5%) | 0 | $0.052 | 369 | 481 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | 16 | 8/16 (50.0%) | 3 | 10/16 (62.5%) | 0 | $0.170 | 2275 | 4551 |
| `decisions:microsoft/microsoft-decision-1#instructions` | 16 | 13/16 (81.3%) | 0 | 13/16 (81.3%) | 1 | $0.042 | 350 | 834 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | 16 | 13/16 (81.3%) | 1 | 13/16 (81.3%) | 1 | $0.044 | 319 | 411 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | 16 | 12/16 (75.0%) | 1 | 13/16 (81.3%) | 2 | $0.161 | 2254 | 4601 |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | 16 | 8/16 (50.0%) | 6 | 5/16 (31.3%) | 6 | $0.033 | 349 | 711 |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | 16 | 5/16 (31.3%) | 9 | 2/16 (12.5%) | 6 | $0.151 | 2252 | 4540 |
| `decisions:openai/gpt-6-luna-decisions#base` | 16 | 8/16 (50.0%) | 1 | 7/16 (43.8%) | 1 | $0.090 | 275 | 543 |
| `decisions:openai/gpt-6-luna-decisions#granular` | 16 | 12/16 (75.0%) | 0 | 12/16 (75.0%) | 0 | $0.175 | 281 | 388 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | 16 | 12/16 (75.0%) | 0 | 14/16 (87.5%) | 0 | $0.178 | 281 | 384 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | 16 | 13/16 (81.3%) | 0 | 12/16 (75.0%) | 0 | $0.299 | 2177 | 4495 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | 16 | 10/16 (62.5%) | 0 | 11/16 (68.8%) | 0 | $0.114 | 278 | 457 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | 16 | 11/16 (68.8%) | 0 | 13/16 (81.3%) | 0 | $0.117 | 281 | 851 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | 16 | 10/16 (62.5%) | 0 | 11/16 (68.8%) | 0 | $0.239 | 2173 | 4454 |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | 16 | 6/16 (37.5%) | 1 | 7/16 (43.8%) | 1 | $0.093 | 284 | 533 |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | 16 | 4/16 (25.0%) | 1 | 5/16 (31.3%) | 1 | $0.215 | 2177 | 4483 |
| `chat:openai/gpt-6-luna#base` | 16 | 16/16 (100.0%) | 0 | 13/16 (81.3%) | 1 | $0.111 | 1606 | 3364 |
| `chat:openai/gpt-6-luna#granular` | 16 | 15/16 (93.8%) | 0 | 15/16 (93.8%) | 1 | $0.222 | 1923 | 3652 |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | 16 | 14/16 (87.5%) | 1 | 16/16 (100.0%) | 0 | $0.243 | 2288 | 4462 |
| `chat:openai/gpt-6-luna#granular+tree-luna` | 16 | 15/16 (93.8%) | 0 | 15/16 (93.8%) | 1 | $0.366 | 4477 | 9410 |
| `chat:openai/gpt-6-luna#instructions` | 16 | 15/16 (93.8%) | 0 | 15/16 (93.8%) | 0 | $0.150 | 1491 | 2907 |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | 16 | 15/16 (93.8%) | 0 | 15/16 (93.8%) | 0 | $0.163 | 1902 | 3130 |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | 16 | 16/16 (100.0%) | 0 | 15/16 (93.8%) | 0 | $0.287 | 3977 | 5772 |
| `chat:openai/gpt-6-luna#tree-heuristic` | 16 | 14/16 (87.5%) | 3 | 13/16 (81.3%) | 2 | $0.116 | 1575 | 3009 |
| `chat:openai/gpt-6-luna#tree-luna` | 16 | 15/16 (93.8%) | 2 | 12/16 (75.0%) | 3 | $0.249 | 3443 | 5461 |
| `decisions:typesafe/jev-1.14#base` | 16 | 9/16 (56.3%) | 0 | 9/16 (56.3%) | 1 | $0.053 | 223 | 296 |
| `decisions:typesafe/jev-1.14#granular` | 16 | 11/16 (68.8%) | 0 | 13/16 (81.3%) | 0 | $0.072 | 231 | 295 |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | 16 | 12/16 (75.0%) | 0 | 12/16 (75.0%) | 0 | $0.074 | 227 | 444 |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | 16 | 10/16 (62.5%) | 0 | 10/16 (62.5%) | 0 | $0.194 | 2178 | 4408 |
| `decisions:typesafe/jev-1.14#instructions` | 16 | 13/16 (81.3%) | 0 | 12/16 (75.0%) | 1 | $0.064 | 216 | 279 |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | 16 | 13/16 (81.3%) | 0 | 14/16 (87.5%) | 1 | $0.065 | 227 | 299 |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | 16 | 13/16 (81.3%) | 0 | 12/16 (75.0%) | 1 | $0.185 | 2168 | 4430 |
| `decisions:typesafe/jev-1.14#tree-heuristic` | 16 | 7/16 (43.8%) | 1 | 9/16 (56.3%) | 1 | $0.055 | 200 | 427 |
| `decisions:typesafe/jev-1.14#tree-luna` | 16 | 4/16 (25.0%) | 2 | 5/16 (31.3%) | 2 | $0.174 | 2170 | 4435 |

## Results, three repetitions (n = 48 per task)

`base`, `instructions` and `granular` were repeated twice more because the same request gave different answers across
runs (`chat:openai/gpt-6-luna#base` on `status-migration-premature-counts`: milestone in smoke-2, continue in dev-1,
identical request hash; earlier benchmark: milestone). One repetition per cell is too noisy to rank on.

| candidate#variant | n per task | status task: accepted-exact | unsafe | boundary task: accepted-exact | unsafe | $/1k calls | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `decisions:microsoft/microsoft-decision-1#base` | 48 | 24/48 (50.0%) | 18 | 19/48 (39.6%) | 19 | $0.032 | 342 | 504 |
| `decisions:microsoft/microsoft-decision-1#granular` | 48 | 21/48 (43.8%) | 12 | 30/48 (62.5%) | 0 | $0.051 | 365 | 550 |
| `decisions:microsoft/microsoft-decision-1#instructions` | 48 | 40/48 (83.3%) | 1 | 39/48 (81.3%) | 3 | $0.042 | 355 | 441 |
| `decisions:openai/gpt-6-luna-decisions#base` | 48 | 24/48 (50.0%) | 3 | 21/48 (43.8%) | 3 | $0.090 | 275 | 350 |
| `decisions:openai/gpt-6-luna-decisions#granular` | 48 | 36/48 (75.0%) | 0 | 36/48 (75.0%) | 0 | $0.175 | 283 | 413 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | 48 | 30/48 (62.5%) | 0 | 33/48 (68.8%) | 0 | $0.114 | 278 | 806 |
| `chat:openai/gpt-6-luna#base` | 48 | 43/48 (89.6%) | 7 | 39/48 (81.3%) | 3 | $0.093 | 1512 | 2871 |
| `chat:openai/gpt-6-luna#granular` | 48 | 42/48 (87.5%) | 2 | 45/48 (93.8%) | 3 | $0.122 | 2133 | 3917 |
| `chat:openai/gpt-6-luna#instructions` | 48 | 46/48 (95.8%) | 0 | 45/48 (93.8%) | 0 | $0.078 | 1491 | 2762 |
| `decisions:typesafe/jev-1.14#base` | 48 | 25/48 (52.1%) | 1 | 25/48 (52.1%) | 3 | $0.053 | 225 | 296 |
| `decisions:typesafe/jev-1.14#granular` | 48 | 34/48 (70.8%) | 0 | 38/48 (79.2%) | 0 | $0.072 | 229 | 302 |
| `decisions:typesafe/jev-1.14#instructions` | 48 | 39/48 (81.3%) | 0 | 39/48 (81.3%) | 3 | $0.064 | 226 | 319 |

## Findings

1. `instructions` helps every model; it costs 21 to 31% more per call for the decisions models and nothing extra for
   `chat:openai/gpt-6-luna`. Over three repetitions, unsafe accepted status answers are 0 for all four models (96 attempts
   each; base: 2 for `chat:openai/gpt-6-luna`, 7 for `microsoft-decision-1`); `chat:openai/gpt-6-luna` goes from 89.6% / 81.3% to
   95.8% / 93.8% accepted-exact with 0 unsafe in both tasks, `microsoft-decision-1` from 50% / 40% (18 and 19 unsafe, both questions) to
   83% / 81% (1 and 3 unsafe), `jev-1.14` from 52% / 52% to 81% / 81%. In the first repetition the remaining unsafe answers
   are boundary answers on cases labelled `none` (phase text inside tool output, a script written but not run, a
   transient outage).
2. `granular` removes unsafe accepted answers for `jev-1.14` (0 and 0 in 96 attempts, 71% / 79% accepted-exact) and
   `gpt-6-luna-decisions` (0 and 0, 75% / 75%), and is the most accurate variant for the latter. It does not help
   `microsoft-decision-1` (12 unsafe in the status task, all from per-record boundary answers) and is no better than
   `instructions` for `chat:openai/gpt-6-luna` (2 and 3 unsafe). Cost is 1.3 to 1.9 times the base call.
   The losses are safe ones: abstentions (the lowest of up to four confidences gates milestone) and one systematic miss,
   `status-env-migration-milestone-de` (a finished German migration), answered continue by granular on three models and
   by `chat:openai/gpt-6-luna#instructions`.
3. `tree-heuristic` gives no gain: neutral for `microsoft-decision-1`, worse for `chat:openai/gpt-6-luna` (3 and 2
   unsafe vs 0 and 1 for base in the first repetition), lower status-task accuracy for `jev-1.14` (7/16 vs 9/16) and
   `gpt-6-luna-decisions` (6/16 vs 8/16). The derived structure repeats what the records already say.
4. `tree-luna` is the worst variant on its own: `jev-1.14` 4/16 and 5/16 accepted-exact, `microsoft-decision-1` 5/16 and
   2/16 with 9 and 6 unsafe. On cases labelled `none`, the classifiers named a record in 35 of 76 attempts with it against
   23 of 76 for base, and 17 of those 35 were records Luna had marked as anchors. It adds about $0.12 per 1,000 calls and
   2 s median latency (4 s p95).
5. Combinations do not beat the part that carries them: `instructions+tree-heuristic` and `instructions+tree-luna`
   match `instructions`; `granular+tree-*` match `granular`, at 1 to 4 times the cost for `tree-luna`. The
   structure needs real earlier folds and goals (the other worker's `structure` on the cases) to be tested fairly;
   these runs measure only structure derived from the same records.
6. Same request, different answers: `chat:openai/gpt-6-luna` changed its answer on identical requests across runs. Any
   holdout needs at least three repetitions per cell.

## Offline ensembles over the instructions and granular candidates (three repetitions)

Policies replay recorded answers (`ensembles/report.md`, `--top 8`); every row has 48 decisions per task.
Chains escalate to the second model only on abstention. Columns: decisions, unsafe accepted, accepted-exact, coverage,
calls per decision, $ per 1,000 decisions, p95 ms. Per task and kind, the four rows with fewest unsafe answers and highest
accepted-exact (ties by cost). milestone-status first, then milestone-boundary.

| candidate | n | unsafe | acc-exact | cov | calls | $/1k | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  _milestone-status_ | | | | | | | |
| confirm(gpt-6-luna#instructions + gpt-6-luna#granular) | 48 | 0 | 87.5% | 95.8% | 2.00 | $0.198 | 6284 |
| confirm(jev-1.14#instructions + gpt-6-luna#instructions) | 48 | 0 | 81.3% | 90.6% | 2.00 | $0.141 | 2843 |
| confirm(microsoft-decision-1#instructions + gpt-6-luna#instructions) | 48 | 0 | 79.2% | 89.6% | 2.00 | $0.121 | 3004 |
| confirm(jev-1.14#instructions + gpt-6-luna#granular) | 48 | 0 | 79.2% | 89.6% | 2.00 | $0.182 | 5029 |
| chain(jev-1.14#instructions > gpt-6-luna#instructions) | 48 | 0 | 95.8% | 100.0% | 1.19 | $0.077 | 1896 |
| chain(gpt-6-luna#instructions > gpt-6-luna#granular) | 48 | 0 | 95.8% | 100.0% | 1.00 | $0.079 | 2614 |
| chain(gpt-6-luna#instructions > gpt-6-luna-decisions#granular) | 48 | 0 | 95.8% | 100.0% | 1.00 | $0.079 | 2614 |
| chain(gpt-6-luna#instructions > gpt-6-luna-decisions#instructions) | 48 | 0 | 95.8% | 100.0% | 1.00 | $0.079 | 2614 |
| vote(microsoft-decision-1#instructions, jev-1.14#instructions, gpt-6-luna#instructions) | 48 | 0 | 95.8% | 97.9% | 3.00 | $0.183 | 2614 |
| vote(microsoft-decision-1#instructions, jev-1.14#granular, gpt-6-luna#instructions) | 48 | 0 | 95.8% | 100.0% | 3.00 | $0.192 | 2614 |
| vote(microsoft-decision-1#instructions, gpt-6-luna#instructions, gpt-6-luna#granular) | 48 | 0 | 95.8% | 100.0% | 3.00 | $0.240 | 4795 |
| vote(microsoft-decision-1#instructions, gpt-6-luna#instructions, gpt-6-luna-decisions#granular) | 48 | 0 | 95.8% | 100.0% | 3.00 | $0.293 | 2614 |
|  _milestone-boundary_ | | | | | | | |
| confirm(gpt-6-luna#instructions + gpt-6-luna#granular) | 48 | 0 | 87.5% | 93.8% | 2.00 | $0.203 | 5756 |
| confirm(jev-1.14#granular + gpt-6-luna#granular) | 48 | 0 | 79.2% | 89.6% | 2.00 | $0.199 | 3689 |
| confirm(microsoft-decision-1#instructions + gpt-6-luna#instructions) | 48 | 0 | 75.0% | 87.5% | 2.00 | $0.121 | 3124 |
| confirm(jev-1.14#instructions + gpt-6-luna#instructions) | 48 | 0 | 75.0% | 87.5% | 2.00 | $0.142 | 3021 |
| chain(microsoft-decision-1#granular > gpt-6-luna#instructions) | 48 | 0 | 100.0% | 100.0% | 1.38 | $0.080 | 2507 |
| chain(jev-1.14#granular > gpt-6-luna#instructions) | 48 | 0 | 100.0% | 100.0% | 1.21 | $0.089 | 2140 |
| chain(gpt-6-luna-decisions#instructions > gpt-6-luna#granular) | 48 | 0 | 100.0% | 100.0% | 1.31 | $0.156 | 3445 |
| chain(gpt-6-luna#instructions > gpt-6-luna#granular) | 48 | 0 | 93.8% | 100.0% | 1.00 | $0.078 | 2762 |
| vote(jev-1.14#instructions, gpt-6-luna#instructions, gpt-6-luna#granular) | 48 | 0 | 100.0% | 100.0% | 3.00 | $0.268 | 3418 |
| vote(jev-1.14#instructions, jev-1.14#granular, gpt-6-luna#instructions) | 48 | 0 | 93.8% | 96.9% | 3.00 | $0.216 | 2762 |
| vote(microsoft-decision-1#instructions, gpt-6-luna#instructions, gpt-6-luna#granular) | 48 | 0 | 93.8% | 96.9% | 3.00 | $0.246 | 3418 |
| vote(microsoft-decision-1#granular, gpt-6-luna#instructions, gpt-6-luna#granular) | 48 | 0 | 93.8% | 96.9% | 3.00 | $0.255 | 3418 |

`confirm` (both models must agree) keeps 0 unsafe at 75 to 88% accepted-exact for two calls; the chains with
`gpt-6-luna#instructions` as the last stage reach 96 to 100% accepted-exact with 0 unsafe at 1.0 to 1.4 calls per
decision. These are selected on development data and are optimistic.

## Spend

Ledger `budget-ledger.jsonl` (this worktree's copy): settled $0.2331 and $0.0533 held at their reservations (calls
of the first smoke run whose connection failed in the first seconds, cost unknown), together $0.2864; 2,048
reservations; remaining $24.6096 of $25. Structure generation billed $0.0037 of that. `smoke` has 15 errors from a
transient connection failure at start-up (`smoke-2` repeats it with 45 of 45 ok); it is kept as evidence.
Attributed costs in `dev-1` observations of `tree-luna` variants include the shared structure cost per call, so
summing them overstates real spend.

## Recommendation

Merit holdout, three repetitions, `--variants base,instructions,granular`: `chat:openai/gpt-6-luna`
(instructions; granular as the alternative), `decisions:typesafe/jev-1.14` (granular, instructions),
`decisions:openai/gpt-6-luna-decisions` (granular), and `decisions:microsoft/microsoft-decision-1` (instructions only).
Offline: `chain(jev-1.14#instructions > gpt-6-luna#instructions)` and `confirm(jev-1.14#instructions + gpt-6-luna#instructions)`.
Not worth holdout now: `tree-heuristic`, `tree-luna` and their combinations, until the cases carry a real
`structure` (earlier folds and goals) and the structure is not derived from the records being judged.

## Limits

- Development only, 16 cases per task. The instructions and granular questions were written after reading the development
  cases and their failure classes (premature claims, user pushback, blocked, phase text in tool output); their development numbers are
  optimistic until holdout confirms them.
- Labels are authored, not human-adjudicated. Counts of unsafe answers are small (0 to 3) and one repetition apart.
- `raw` (granular sub-answers), `variant` and `structure` are extra fields on observation and structure lines; the
  analysis ignores them and recomputes nothing from them.
