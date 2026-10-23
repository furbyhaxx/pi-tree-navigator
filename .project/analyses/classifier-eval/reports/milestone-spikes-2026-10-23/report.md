# Classifier evaluation report

Gate (minimum confidence): 0.7. Runs: `/mnt/Projects/furbyhaxx/pi-tree-navigator/.worktrees/feat-milestone-spike-variants/.project/analyses/classifier-eval/runs/milestone-spikes-2026-10-23/dev-1` (1920). Observations: 1920, models: 36.

Ranking rule (lexicographic):
1. sufficient evidence (holdout n >= minimum) before insufficient
2. fewer unsafe accepted decisions on holdout (zero first)
3. higher accepted-exact rate on holdout
4. lower cost per 1,000 decisions (actual where known, bound otherwise)
5. lower p95 latency

Pipelines:
- `single`: One model behind the confidence gate; abstentions make no decision.
- `chain`: A then B: B is consulted only for questions A did not accept (abstained, invalid, error or unsupported); cost adds up and latency sums.
- `confirm`: A's accepted answer stands only when B accepts the same choice; B is consulted only when A accepted something.
- `vote`: Three models in parallel (latency is the slowest); an answer stands when at least two accept the same choice.
- `replay`: The shipped createModelClassifier fed the recorded answers: abstention or failure falls back to the heuristic, which never supersedes; every verdict commits.
- `baseline`: No classifier model configured: the shipped heuristic alone decides.

`$/1k` is cost per 1,000 decisions: actual where known, `(m)` partly and `(b)` fully priced at the reserved bound. `n` is distinct holdout cases. Unsafe, acc-exact, cov and sel-acc are measured on holdout; accepted-exact counts decisions whose every question is correct and accepted.

## Recommendations

| task | single model | pipeline |
| --- | --- | --- |
| intent | none | `heuristic-only` (no-safe-candidate) |
| supersession | none | `heuristic-only` (no-safe-candidate) |
| milestone-status | `single(chat:openai/gpt-6-luna#base)` (insufficient-evidence) | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular+tree-luna)` (insufficient-evidence) |
| milestone-boundary | `single(chat:openai/gpt-6-luna#base)` (insufficient-evidence) | `chain(chat:openai/gpt-6-luna#granular+tree-heuristic > chat:openai/gpt-6-luna#instructions+tree-luna)` (insufficient-evidence) |

## intent

Cases: development 16, holdout 8.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=8: unsafe accepted 4, accepted-exact 25.0%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 8, accepted-exact 31.3%. No sufficient row has zero unsafe accepted on holdout; fewest is 4.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Pipelines (top 1 of 1)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `heuristic-only` | 8 | 4 | 25.0% | 100.0% | 33.3% | 8 | 31.3% | 0.00 | 0/0 | $0.0000 | 0 | fallback |

Enumerated over: no model (top 6, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: no observations for this task
- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#granular+tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#granular+tree-luna`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `chat:openai/gpt-6-luna#instructions+tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#instructions+tree-luna`: no observations for this task
- `chat:openai/gpt-6-luna#tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#base`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular+tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions+tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#base`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular+tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#base`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#granular+tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#granular+tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions+tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions+tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#tree-luna`: no observations for this task

## supersession

Cases: development 16, holdout 8.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=8: unsafe accepted 5, accepted-exact 37.5%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 11, accepted-exact 18.8%. No sufficient row has zero unsafe accepted on holdout; fewest is 5.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Pipelines (top 1 of 1)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `heuristic-only` | 8 | 5 | 37.5% | 100.0% | 56.3% | 11 | 18.8% | 0.00 | 0/0 | $0.0000 | 0 | fallback |

Enumerated over: no model (top 6, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: no observations for this task
- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#granular+tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#granular+tree-luna`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `chat:openai/gpt-6-luna#instructions+tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#instructions+tree-luna`: no observations for this task
- `chat:openai/gpt-6-luna#tree-heuristic`: no observations for this task
- `chat:openai/gpt-6-luna#tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#base`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular+tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions+tree-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#tree-heuristic`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#base`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular+tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#tree-heuristic`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#base`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#granular+tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#granular+tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions+tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions+tree-luna`: no observations for this task
- `decisions:typesafe/jev-1.14#tree-heuristic`: no observations for this task
- `decisions:typesafe/jev-1.14#tree-luna`: no observations for this task

## milestone-status

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:openai/gpt-6-luna#base)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 7, accepted-exact 89.6%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular+tree-luna)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 93.8%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:openai/gpt-6-luna#base)` | 0 | 0 | 0.0% | - | - | 7 | 89.6% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 2 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(chat:openai/gpt-6-luna#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(chat:openai/gpt-6-luna#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(chat:openai/gpt-6-luna#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 3 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(chat:openai/gpt-6-luna#tree-luna)` | 0 | 0 | 0.0% | - | - | 2 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1#base)` | 0 | 0 | 0.0% | - | - | 18 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 0 | 0 | 0.0% | - | - | 12 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:microsoft/microsoft-decision-1#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 4 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:microsoft/microsoft-decision-1#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 3 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 0 | 0 | 0.0% | - | - | 1 | 83.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:microsoft/microsoft-decision-1#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 1 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:microsoft/microsoft-decision-1#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 6 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:microsoft/microsoft-decision-1#tree-luna)` | 0 | 0 | 0.0% | - | - | 9 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:openai/gpt-6-luna-decisions#base)` | 0 | 0 | 0.0% | - | - | 3 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:openai/gpt-6-luna-decisions#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:openai/gpt-6-luna-decisions#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(decisions:openai/gpt-6-luna-decisions#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 27 | `single(decisions:openai/gpt-6-luna-decisions#tree-luna)` | 0 | 0 | 0.0% | - | - | 1 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 28 | `single(decisions:typesafe/jev-1.14#base)` | 0 | 0 | 0.0% | - | - | 1 | 52.1% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 29 | `single(decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 0 | 70.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 30 | `single(decisions:typesafe/jev-1.14#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 31 | `single(decisions:typesafe/jev-1.14#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 32 | `single(decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 33 | `single(decisions:typesafe/jev-1.14#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 34 | `single(decisions:typesafe/jev-1.14#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 35 | `single(decisions:typesafe/jev-1.14#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 36 | `single(decisions:typesafe/jev-1.14#tree-luna)` | 0 | 0 | 0.0% | - | - | 2 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | development | 16 | 0.0% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.067 | 0.052 | 1512 | 81% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.061 | 0.056 | 2113 | 88% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | development | 16 | 0.0% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.060 | 0.055 | 2264 | - | generation 16 |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular+tree-luna` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.031 | 0.024 | 4477 | - | generation 16 |
| `chat:openai/gpt-6-luna#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.020 | 0.013 | 1460 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.030 | 0.022 | 1898 | - | generation 16 |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | development | 16 | 0.0% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.000 | 0.009 | 3977 | - | generation 16 |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#tree-heuristic` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.091 | 0.075 | 1445 | - | generation 16 |
| `chat:openai/gpt-6-luna#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#tree-luna` | development | 16 | 0.0% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.062 | 0.047 | 3620 | - | generation 16 |
| `chat:openai/gpt-6-luna#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#base` | development | 16 | 18.8% | 0.0% | 54.6%-84.4% (n=32 answers) | 0.213 | 0.175 | 340 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.209 | 0.208 | 357 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | development | 16 | 18.8% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.189 | 0.225 | 365 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | development | 16 | 18.8% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.169 | 0.158 | 2353 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 7.3% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.033 | 0.058 | 348 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | development | 16 | 6.3% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.039 | 0.087 | 316 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | development | 16 | 9.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.042 | 0.084 | 2364 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | development | 16 | 18.8% | 0.0% | 51.4%-82.0% (n=32 answers) | 0.207 | 0.201 | 351 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | development | 16 | 18.8% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.292 | 0.288 | 2350 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#base` | development | 16 | 31.3% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.094 | 0.103 | 269 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.065 | 0.084 | 281 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.057 | 0.066 | 278 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.049 | 0.093 | 2307 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 21.9% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.047 | 0.138 | 275 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | development | 16 | 15.6% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.034 | 0.126 | 290 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | development | 16 | 18.8% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.058 | 0.160 | 2605 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | development | 16 | 31.3% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.108 | 0.173 | 284 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | development | 16 | 37.5% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.135 | 0.151 | 2311 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | development | 16 | 26.0% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.084 | 0.099 | 229 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 11.5% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.069 | 0.103 | 225 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | development | 16 | 12.5% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.056 | 0.089 | 232 | - | generation 16 |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | development | 16 | 18.8% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.076 | 0.122 | 2183 | - | generation 16 |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.034 | 0.081 | 228 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.035 | 0.073 | 233 | - | generation 16 |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | development | 16 | 9.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.034 | 0.082 | 2231 | - | generation 16 |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | development | 16 | 28.1% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.111 | 0.097 | 194 | - | generation 16 |
| `decisions:typesafe/jev-1.14#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-luna` | development | 16 | 37.5% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.120 | 0.123 | 2539 | - | generation 16 |
| `decisions:typesafe/jev-1.14#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | status | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#base` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | boundary | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular+tree-luna` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#tree-heuristic` | status | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#tree-heuristic` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#tree-luna` | status | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#tree-luna` | boundary | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#base` | status | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#base` | boundary | none | - | 21 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | none | - | 15 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | status | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | boundary | none | - | 4 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | boundary | 0.95 | 43.8% | 4 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.75 | 83.3% | 3 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | boundary | 0.75 | 81.3% | 1 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | boundary | 0.80 | 68.8% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | status | 0.95 | 68.8% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | boundary | none | - | 7 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | status | 0.95 | 62.5% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | boundary | none | - | 10 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:openai/gpt-6-luna-decisions#base` | status | 0.65 | 87.5% | 3 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#base` | boundary | 0.85 | 12.5% | 12 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | boundary | 0.85 | 25.0% | 3 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | boundary | 0.85 | 12.5% | 4 | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | status | 0.55 | 93.8% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | boundary | 0.75 | 39.6% | 8 | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | status | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.55 | 87.5% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | boundary | 0.65 | 87.5% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | boundary | 0.65 | 87.5% | 2 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | status | 0.60 | 93.8% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | boundary | 0.75 | 37.5% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-luna` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-luna` | boundary | 0.95 | 0.0% | 6 | - | - | - |  |

### Pipelines (top 10 of 56)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(chat:openai/gpt-6-luna#instructions+tree-heuristic > chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(chat:openai/gpt-6-luna#instructions+tree-heuristic > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(chat:openai/gpt-6-luna#instructions+tree-luna > chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(decisions:typesafe/jev-1.14#instructions > chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `chain(decisions:typesafe/jev-1.14#instructions > chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `chain(decisions:typesafe/jev-1.14#instructions > chat:openai/gpt-6-luna#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `chain(decisions:typesafe/jev-1.14#instructions > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `chat:openai/gpt-6-luna#instructions+tree-luna`, `chat:openai/gpt-6-luna#instructions`, `chat:openai/gpt-6-luna#instructions+tree-heuristic`, `chat:openai/gpt-6-luna#granular+tree-luna`, `decisions:typesafe/jev-1.14#instructions`, `decisions:typesafe/jev-1.14#instructions+tree-heuristic` (top 6, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: ranked 33 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#granular`: ranked 26 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#granular+tree-heuristic`: ranked 17 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#tree-heuristic`: ranked 28 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#tree-luna`: ranked 25 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#base`: ranked 36 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular`: ranked 35 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic`: ranked 31 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular+tree-luna`: ranked 30 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions`: ranked 18 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic`: ranked 19 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions+tree-luna`: ranked 20 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#tree-heuristic`: ranked 32 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#tree-luna`: ranked 34 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#base`: ranked 29 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#granular`: ranked 10 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic`: ranked 11 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#granular+tree-luna`: ranked 8 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#instructions`: ranked 14 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic`: ranked 13 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna`: ranked 16 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#tree-heuristic`: ranked 23 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#tree-luna`: ranked 24 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#base`: ranked 21 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular`: ranked 12 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular+tree-heuristic`: ranked 9 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular+tree-luna`: ranked 15 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#instructions+tree-luna`: ranked 7 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#tree-heuristic`: ranked 22 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#tree-luna`: ranked 27 of 36 on development; only the top 6 are enumerated

## milestone-boundary

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:openai/gpt-6-luna#base)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 3, accepted-exact 81.3%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(chat:openai/gpt-6-luna#granular+tree-heuristic > chat:openai/gpt-6-luna#instructions+tree-luna)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 100.0%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:openai/gpt-6-luna#base)` | 0 | 0 | 0.0% | - | - | 3 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 3 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(chat:openai/gpt-6-luna#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(chat:openai/gpt-6-luna#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 1 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(chat:openai/gpt-6-luna#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(chat:openai/gpt-6-luna#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 2 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(chat:openai/gpt-6-luna#tree-luna)` | 0 | 0 | 0.0% | - | - | 3 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1#base)` | 0 | 0 | 0.0% | - | - | 19 | 39.6% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:microsoft/microsoft-decision-1#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:microsoft/microsoft-decision-1#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 0 | 0 | 0.0% | - | - | 3 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:microsoft/microsoft-decision-1#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 2 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:microsoft/microsoft-decision-1#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 6 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:microsoft/microsoft-decision-1#tree-luna)` | 0 | 0 | 0.0% | - | - | 6 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:openai/gpt-6-luna-decisions#base)` | 0 | 0 | 0.0% | - | - | 3 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:openai/gpt-6-luna-decisions#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:openai/gpt-6-luna-decisions#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(decisions:openai/gpt-6-luna-decisions#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 27 | `single(decisions:openai/gpt-6-luna-decisions#tree-luna)` | 0 | 0 | 0.0% | - | - | 1 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 28 | `single(decisions:typesafe/jev-1.14#base)` | 0 | 0 | 0.0% | - | - | 3 | 52.1% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 29 | `single(decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 0 | 79.2% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 30 | `single(decisions:typesafe/jev-1.14#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 31 | `single(decisions:typesafe/jev-1.14#granular+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 32 | `single(decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 3 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 33 | `single(decisions:typesafe/jev-1.14#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 34 | `single(decisions:typesafe/jev-1.14#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 1 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 35 | `single(decisions:typesafe/jev-1.14#tree-heuristic)` | 0 | 0 | 0.0% | - | - | 1 | 56.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 36 | `single(decisions:typesafe/jev-1.14#tree-luna)` | 0 | 0 | 0.0% | - | - | 2 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.086 | 0.076 | 1478 | 100% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.030 | 0.026 | 2176 | 100% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | development | 16 | 0.0% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.000 | 0.006 | 2288 | - | generation 16 |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#granular+tree-luna` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.031 | 0.026 | 4273 | - | generation 16 |
| `chat:openai/gpt-6-luna#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.029 | 0.023 | 1595 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.023 | 0.033 | 2098 | - | generation 16 |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.029 | 0.022 | 3570 | - | generation 16 |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#tree-heuristic` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.085 | 0.073 | 1576 | - | generation 16 |
| `chat:openai/gpt-6-luna#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#tree-luna` | development | 16 | 0.0% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.106 | 0.097 | 3206 | - | generation 16 |
| `chat:openai/gpt-6-luna#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#base` | development | 16 | 14.6% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.200 | 0.161 | 351 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.066 | 0.085 | 370 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | development | 16 | 18.8% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.069 | 0.108 | 380 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | development | 16 | 18.8% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.040 | 0.071 | 2230 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 6.3% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.050 | 0.058 | 359 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | development | 16 | 6.3% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.056 | 0.069 | 319 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.078 | 0.088 | 2204 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | development | 16 | 21.9% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.205 | 0.142 | 346 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | development | 16 | 31.3% | 0.0% | 51.4%-82.0% (n=32 answers) | 0.222 | 0.250 | 2210 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#base` | development | 16 | 28.1% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.075 | 0.186 | 283 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 12.5% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.064 | 0.113 | 283 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | development | 16 | 6.3% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.023 | 0.071 | 282 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | development | 16 | 12.5% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.054 | 0.099 | 2140 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 18.8% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.054 | 0.127 | 280 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | development | 16 | 9.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.029 | 0.101 | 242 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | development | 16 | 15.6% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.042 | 0.121 | 2117 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | development | 16 | 28.1% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.095 | 0.136 | 276 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | development | 16 | 34.4% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.109 | 0.111 | 2159 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | development | 16 | 27.1% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.086 | 0.135 | 224 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#base` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 10.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.040 | 0.067 | 233 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | development | 16 | 12.5% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.048 | 0.099 | 227 | - | generation 16 |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | development | 16 | 18.8% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.034 | 0.057 | 2129 | - | generation 16 |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 6.3% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.039 | 0.052 | 226 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | development | 16 | 3.1% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.038 | 0.060 | 217 | - | generation 16 |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | development | 16 | 9.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.048 | 0.067 | 2140 | - | generation 16 |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | development | 16 | 25.0% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.089 | 0.119 | 233 | - | generation 16 |
| `decisions:typesafe/jev-1.14#tree-heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-luna` | development | 16 | 31.3% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.141 | 0.109 | 2111 | - | generation 16 |
| `decisions:typesafe/jev-1.14#tree-luna` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#base` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular+tree-heuristic` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular+tree-luna` | boundary | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-heuristic` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions+tree-luna` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#tree-heuristic` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#tree-luna` | boundary | 0.95 | 75.0% | 3 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#base` | status | 0.90 | 62.5% | 6 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#base` | boundary | none | - | 15 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 97.9% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | 0.60 | 72.9% | 9 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic` | boundary | 0.65 | 68.8% | 4 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular+tree-luna` | boundary | 0.60 | 68.8% | 4 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.95 | 62.5% | 6 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic` | boundary | 0.95 | 62.5% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions+tree-luna` | boundary | 0.90 | 68.8% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | status | 0.85 | 62.5% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-heuristic` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | status | 0.70 | 68.8% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#tree-luna` | boundary | none | - | 8 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:openai/gpt-6-luna-decisions#base` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#base` | boundary | 0.75 | 43.8% | 6 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular+tree-luna` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` | boundary | 0.50 | 87.5% | 1 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna` | boundary | 0.50 | 87.5% | 1 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#tree-heuristic` | boundary | 0.80 | 31.3% | 2 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#tree-luna` | boundary | 0.80 | 31.3% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | status | 0.60 | 79.2% | 9 | - | - | - |  |
| `decisions:typesafe/jev-1.14#base` | boundary | none | - | 6 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.55 | 81.3% | 4 | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-heuristic` | boundary | 0.50 | 87.5% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular+tree-luna` | boundary | 0.55 | 81.3% | 2 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.90 | 75.0% | 6 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions+tree-heuristic` | boundary | 0.90 | 68.8% | 2 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions+tree-luna` | boundary | 0.85 | 68.8% | 2 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | status | 0.65 | 75.0% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-heuristic` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:typesafe/jev-1.14#tree-luna` | status | 0.65 | 68.8% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14#tree-luna` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |

### Pipelines (top 10 of 56)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(chat:openai/gpt-6-luna#granular+tree-heuristic > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(chat:openai/gpt-6-luna#instructions+tree-heuristic > chat:openai/gpt-6-luna#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `chain(chat:openai/gpt-6-luna#instructions+tree-heuristic > chat:openai/gpt-6-luna#instructions+tree-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `chain(chat:openai/gpt-6-luna#instructions+tree-heuristic > decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `chain(decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic > chat:openai/gpt-6-luna#granular+tree-heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `chat:openai/gpt-6-luna#granular+tree-heuristic`, `chat:openai/gpt-6-luna#instructions`, `chat:openai/gpt-6-luna#instructions+tree-heuristic`, `chat:openai/gpt-6-luna#instructions+tree-luna`, `decisions:openai/gpt-6-luna-decisions#granular+tree-heuristic`, `decisions:openai/gpt-6-luna-decisions#instructions+tree-heuristic` (top 6, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: ranked 30 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#granular`: ranked 27 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#granular+tree-luna`: ranked 17 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#tree-heuristic`: ranked 24 of 36 on development; only the top 6 are enumerated
- `chat:openai/gpt-6-luna#tree-luna`: ranked 31 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#base`: ranked 36 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular`: ranked 13 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular+tree-heuristic`: ranked 14 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular+tree-luna`: ranked 15 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions`: ranked 28 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions+tree-heuristic`: ranked 19 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#instructions+tree-luna`: ranked 25 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#tree-heuristic`: ranked 34 of 36 on development; only the top 6 are enumerated
- `decisions:microsoft/microsoft-decision-1#tree-luna`: ranked 35 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#base`: ranked 33 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#granular`: ranked 9 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#granular+tree-luna`: ranked 10 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#instructions`: ranked 11 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#instructions+tree-luna`: ranked 12 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#tree-heuristic`: ranked 22 of 36 on development; only the top 6 are enumerated
- `decisions:openai/gpt-6-luna-decisions#tree-luna`: ranked 23 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#base`: ranked 32 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular`: ranked 7 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular+tree-heuristic`: ranked 8 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#granular+tree-luna`: ranked 16 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#instructions`: ranked 29 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#instructions+tree-heuristic`: ranked 18 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#instructions+tree-luna`: ranked 20 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#tree-heuristic`: ranked 21 of 36 on development; only the top 6 are enumerated
- `decisions:typesafe/jev-1.14#tree-luna`: ranked 26 of 36 on development; only the top 6 are enumerated

## Limitations

- Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.
- Samples are small: results with fewer than 8 holdout cases per task are marked insufficient (72 single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.
- Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: generation 1920, response 0, local 0, unknown 0.
- Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.
- The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.
- Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.
- Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).
