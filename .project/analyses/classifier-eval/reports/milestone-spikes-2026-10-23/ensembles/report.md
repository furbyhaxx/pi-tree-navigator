# Classifier evaluation report

Gate (minimum confidence): 0.7. Runs: `/tmp/spk/ens` (768). Observations: 768, models: 8.

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
| milestone-status | `single(chat:openai/gpt-6-luna#granular)` (insufficient-evidence) | `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` (insufficient-evidence) |
| milestone-boundary | `single(chat:openai/gpt-6-luna#granular)` (insufficient-evidence) | `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` (insufficient-evidence) |

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

Enumerated over: no model (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task

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

Enumerated over: no model (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task

## milestone-status

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:openai/gpt-6-luna#granular)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 2, accepted-exact 87.5%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 2, accepted-exact 87.5%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 2 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 0 | 0 | 0.0% | - | - | 12 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 0 | 0 | 0.0% | - | - | 1 | 83.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 0 | 70.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.061 | 0.056 | 2113 | 88% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.020 | 0.013 | 1460 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.209 | 0.208 | 357 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 7.3% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.033 | 0.058 | 348 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.065 | 0.084 | 281 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 21.9% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.047 | 0.138 | 275 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 11.5% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.069 | 0.103 | 225 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.034 | 0.081 | 228 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | none | - | 15 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.75 | 83.3% | 3 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.55 | 87.5% | 3 | - | - | - |  |

### Pipelines (top 10 of 120)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 2 | 87.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 95.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:microsoft/microsoft-decision-1#granular > chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 12 | 68.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:microsoft/microsoft-decision-1#granular > chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 12 | 70.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 12 | 62.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 12 | 62.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 12 | 64.6% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 12 | 62.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `chat:openai/gpt-6-luna#instructions`, `decisions:typesafe/jev-1.14#instructions`, `decisions:openai/gpt-6-luna-decisions#granular`, `decisions:typesafe/jev-1.14#granular`, `decisions:openai/gpt-6-luna-decisions#instructions`, `decisions:microsoft/microsoft-decision-1#instructions`, `chat:openai/gpt-6-luna#granular`, `decisions:microsoft/microsoft-decision-1#granular` (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

## milestone-boundary

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:openai/gpt-6-luna#granular)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 3, accepted-exact 93.8%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 3, accepted-exact 93.8%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 3 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 0 | 0 | 0.0% | - | - | 3 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 0 | 79.2% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 3 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.030 | 0.026 | 2176 | 100% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.029 | 0.023 | 1595 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.066 | 0.085 | 370 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 6.3% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.050 | 0.058 | 359 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 12.5% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.064 | 0.113 | 283 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 18.8% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.054 | 0.127 | 280 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 10.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.040 | 0.067 | 233 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 6.3% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.039 | 0.052 | 226 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 97.9% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | 0.60 | 72.9% | 9 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.95 | 62.5% | 6 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.55 | 81.3% | 4 | - | - | - |  |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.90 | 75.0% | 6 | - | - | - |  |

### Pipelines (top 10 of 120)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(chat:openai/gpt-6-luna#granular > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 3 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(chat:openai/gpt-6-luna#instructions > chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(chat:openai/gpt-6-luna#instructions > decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:microsoft/microsoft-decision-1#granular > chat:openai/gpt-6-luna#granular)` | 0 | 0 | 0.0% | - | - | 3 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:microsoft/microsoft-decision-1#granular > chat:openai/gpt-6-luna#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:openai/gpt-6-luna-decisions#granular)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:openai/gpt-6-luna-decisions#instructions)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:typesafe/jev-1.14#granular)` | 0 | 0 | 0.0% | - | - | 0 | 79.2% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `chain(decisions:microsoft/microsoft-decision-1#granular > decisions:typesafe/jev-1.14#instructions)` | 0 | 0 | 0.0% | - | - | 3 | 85.4% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `chat:openai/gpt-6-luna#instructions`, `decisions:typesafe/jev-1.14#granular`, `decisions:openai/gpt-6-luna-decisions#granular`, `decisions:openai/gpt-6-luna-decisions#instructions`, `decisions:microsoft/microsoft-decision-1#granular`, `chat:openai/gpt-6-luna#granular`, `decisions:microsoft/microsoft-decision-1#instructions`, `decisions:typesafe/jev-1.14#instructions` (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

## Limitations

- Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.
- Samples are small: results with fewer than 8 holdout cases per task are marked insufficient (16 single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.
- Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: generation 768, response 0, local 0, unknown 0.
- Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.
- The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.
- Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.
- Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).
