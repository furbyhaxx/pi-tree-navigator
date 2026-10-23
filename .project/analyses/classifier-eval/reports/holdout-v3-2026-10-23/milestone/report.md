# Classifier evaluation report

Gate (minimum confidence): 0.7. Runs: `/tmp/hv3/msdev` (1152), `/mnt/Projects/furbyhaxx/pi-tree-navigator/.project/analyses/classifier-eval/runs/holdout-v3-2026-10-23/milestone` (2304). Observations: 3456, models: 12.

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
| milestone-status | `single(decisions:openai/gpt-6-luna-decisions#granular)` (recommended) | `vote(decisions:microsoft/microsoft-decision-1#instructions, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` (recommended) |
| milestone-boundary | `single(chat:openai/gpt-6-luna#base)` (recommended) | `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular)` (recommended) |

## intent

Cases: development 16, holdout 32.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=32: unsafe accepted 15, accepted-exact 31.3%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 8, accepted-exact 31.3%. No sufficient row has zero unsafe accepted on holdout; fewest is 15.

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
| 1 | `heuristic-only` | 32 | 15 | 31.3% | 100.0% | 38.9% | 8 | 31.3% | 0.00 | 0/0 | $0.0000 | 0 | fallback |

Enumerated over: no model (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: no observations for this task
- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#base`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#base`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#base`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task

## supersession

Cases: development 16, holdout 32.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=32: unsafe accepted 15, accepted-exact 31.3%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 11, accepted-exact 18.8%. No sufficient row has zero unsafe accepted on holdout; fewest is 15.

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
| 1 | `heuristic-only` | 32 | 15 | 31.3% | 100.0% | 48.4% | 11 | 18.8% | 0.00 | 0/0 | $0.0000 | 0 | fallback |

Enumerated over: no model (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: no observations for this task
- `chat:openai/gpt-6-luna#granular`: no observations for this task
- `chat:openai/gpt-6-luna#instructions`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#base`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#granular`: no observations for this task
- `decisions:microsoft/microsoft-decision-1#instructions`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#base`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#granular`: no observations for this task
- `decisions:openai/gpt-6-luna-decisions#instructions`: no observations for this task
- `decisions:typesafe/jev-1.14#base`: no observations for this task
- `decisions:typesafe/jev-1.14#granular`: no observations for this task
- `decisions:typesafe/jev-1.14#instructions`: no observations for this task

## milestone-status

Cases: development 16, holdout 32.

- **Recommended single model:** `single(decisions:openai/gpt-6-luna-decisions#granular)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 62.5%, coverage 87.5%, $0.1656 per 1,000, p95 815 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 75.0%. Best sufficient row; zero unsafe accepted on holdout.
- **Recommended pipeline:** `vote(decisions:microsoft/microsoft-decision-1#instructions, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 89.6%, coverage 96.4%, $0.2916 per 1,000, p95 3576 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 95.8%. Best sufficient row; zero unsafe accepted on holdout.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 62.5% | 87.5% | 92.9% | 0 | 75.0% | 1.00 | 0/0 | $0.1656 | 815 |  |
| 2 | `single(decisions:openai/gpt-6-luna-decisions#base)` | 32 | 0 | 50.0% | 71.9% | 100.0% | 3 | 50.0% | 1.00 | 0/0 | $0.0899 | 742 |  |
| 3 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 32 | 0 | 46.9% | 70.3% | 100.0% | 0 | 62.5% | 1.00 | 0/0 | $0.1138 | 750 |  |
| 4 | `single(chat:openai/gpt-6-luna#instructions)` | 32 | 3 | 92.7% | 100.0% | 96.4% | 0 | 95.8% | 1.00 | 0/0 | $0.0835 | 3576 |  |
| 5 | `single(decisions:typesafe/jev-1.14#base)` | 32 | 4 | 59.4% | 81.8% | 97.5% | 1 | 52.1% | 1.00 | 0/0 | $0.0525 | 385 |  |
| 6 | `single(chat:openai/gpt-6-luna#base)` | 32 | 6 | 93.8% | 100.0% | 96.9% | 7 | 89.6% | 1.00 | 0/0 | $0.0963 | 3341 |  |
| 7 | `single(decisions:typesafe/jev-1.14#granular)` | 32 | 6 | 50.0% | 82.8% | 90.6% | 0 | 70.8% | 1.00 | 0/0 | $0.0692 | 356 |  |
| 8 | `single(chat:openai/gpt-6-luna#granular)` | 32 | 8 | 79.2% | 100.0% | 89.6% | 2 | 87.5% | 1.00 | 0/0 | $0.1208 | 4603 |  |
| 9 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 32 | 12 | 69.8% | 91.1% | 93.1% | 1 | 83.3% | 1.00 | 0/0 | $0.0425 | 559 |  |
| 10 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 32 | 12 | 54.2% | 84.4% | 91.4% | 12 | 43.8% | 1.00 | 0/0 | $0.0484 | 630 |  |
| 11 | `single(decisions:typesafe/jev-1.14#instructions)` | 32 | 18 | 65.6% | 92.2% | 89.8% | 0 | 81.3% | 1.00 | 0/0 | $0.0630 | 412 |  |
| 12 | `single(decisions:microsoft/microsoft-decision-1#base)` | 32 | 18 | 51.0% | 84.9% | 89.0% | 18 | 50.0% | 1.00 | 0/0 | $0.0324 | 443 |  |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | development | 16 | 0.0% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.067 | 0.052 | 1512 | 81% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#base` | holdout | 32 | 0.0% | 0.0% | 91.7%-99.7% (n=64 answers) | 0.024 | 0.011 | 1788 | 94% of 32 | generation 88, response 8 |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.061 | 0.056 | 2113 | 88% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 32 | 0.0% | 0.0% | 81.0%-95.6% (n=64 answers) | 0.101 | 0.096 | 2140 | 97% of 32 | generation 90, response 6 |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.020 | 0.013 | 1460 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 32 | 0.0% | 0.0% | 89.3%-99.1% (n=64 answers) | 0.036 | 0.028 | 1782 | 91% of 32 | generation 90, response 6 |
| `decisions:microsoft/microsoft-decision-1#base` | development | 16 | 18.8% | 0.0% | 54.6%-84.4% (n=32 answers) | 0.213 | 0.175 | 340 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#base` | holdout | 32 | 15.1% | 0.0% | 70.0%-88.9% (n=64 answers) | 0.109 | 0.094 | 352 | 97% of 32 | generation 88, response 8 |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.209 | 0.208 | 357 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 32 | 15.6% | 0.0% | 75.4%-92.4% (n=64 answers) | 0.102 | 0.090 | 369 | 97% of 32 | generation 88, response 8 |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 7.3% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.033 | 0.058 | 348 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 32 | 8.9% | 0.0% | 79.1%-94.6% (n=64 answers) | 0.074 | 0.053 | 356 | 97% of 32 | generation 88, response 8 |
| `decisions:openai/gpt-6-luna-decisions#base` | development | 16 | 31.3% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.094 | 0.103 | 269 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#base` | holdout | 32 | 28.1% | 0.0% | 85.0%-97.5% (n=64 answers) | 0.086 | 0.150 | 287 | 100% of 32 | generation 90, response 6 |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.065 | 0.084 | 281 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 32 | 12.5% | 0.0% | 79.1%-94.6% (n=64 answers) | 0.083 | 0.066 | 299 | 100% of 32 | generation 87, response 9 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 21.9% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.047 | 0.138 | 275 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 32 | 29.7% | 0.0% | 85.0%-97.5% (n=64 answers) | 0.075 | 0.132 | 290 | 100% of 32 | generation 90, response 6 |
| `decisions:typesafe/jev-1.14#base` | development | 16 | 26.0% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.084 | 0.099 | 229 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#base` | holdout | 32 | 18.2% | 0.0% | 81.0%-95.6% (n=64 answers) | 0.062 | 0.049 | 237 | 100% of 32 | generation 89, response 7 |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 11.5% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.069 | 0.103 | 225 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 32 | 17.2% | 0.0% | 79.1%-94.6% (n=64 answers) | 0.115 | 0.116 | 238 | 94% of 32 | generation 89, response 7 |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.034 | 0.081 | 228 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 32 | 7.8% | 0.0% | 77.2%-93.5% (n=64 answers) | 0.094 | 0.072 | 237 | 97% of 32 | generation 93, response 3 |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | status | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#base` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | 100.0% | 87.5% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | 100.0% | 95.8% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | 100.0% | 96.9% | 3 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#base` | status | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#base` | boundary | none | - | 21 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 93.8% | 0 | 92.7% | 93.3% | 0 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | none | - | 15 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | 97.9% | 98.9% | 0 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.75 | 83.3% | 3 | 85.4% | 85.4% | 12 |  |
| `decisions:openai/gpt-6-luna-decisions#base` | status | 0.65 | 87.5% | 3 | 96.9% | 100.0% | 0 |  |
| `decisions:openai/gpt-6-luna-decisions#base` | boundary | 0.85 | 12.5% | 12 | 34.4% | 100.0% | 0 |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 93.8% | 0 | 90.6% | 82.8% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 93.8% | 0 | 93.8% | 100.0% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 100.0% | 0 | 90.6% | 96.6% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 93.8% | 0 | 81.3% | 100.0% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#base` | status | 0.55 | 93.8% | 3 | 100.0% | 100.0% | 0 |  |
| `decisions:typesafe/jev-1.14#base` | boundary | 0.75 | 39.6% | 8 | 49.0% | 97.9% | 1 |  |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 93.8% | 0 | 95.8% | 90.2% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.50 | 87.5% | 0 | 79.2% | 92.1% | 6 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | 96.9% | 100.0% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.55 | 87.5% | 3 | 93.8% | 80.0% | 18 |  |

### Pipelines (top 10 of 120)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `vote(decisions:microsoft/microsoft-decision-1#instructions, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 89.6% | 96.4% | 98.4% | 0 | 95.8% | 3.00 | 0/0 | $0.2916 | 3576 |  |
| 2 | `vote(decisions:microsoft/microsoft-decision-1#instructions, chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular)` | 32 | 0 | 88.5% | 95.8% | 98.4% | 0 | 95.8% | 3.00 | 0/0 | $0.2468 | 4603 |  |
| 3 | `vote(decisions:typesafe/jev-1.14#base, chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular)` | 32 | 0 | 88.5% | 95.8% | 98.4% | 0 | 91.7% | 3.00 | 0/0 | $0.2567 | 4603 |  |
| 4 | `vote(decisions:typesafe/jev-1.14#base, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 87.5% | 95.3% | 98.4% | 0 | 83.3% | 3.00 | 0/0 | $0.3016 | 3576 |  |
| 5 | `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 84.4% | 93.8% | 98.3% | 0 | 93.8% | 3.00 | 0/0 | $0.3121 | 3576 |  |
| 6 | `vote(chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#instructions, chat:openai/gpt-6-luna#granular)` | 32 | 0 | 79.2% | 90.6% | 98.3% | 0 | 89.6% | 3.00 | 0/0 | $0.3181 | 4603 |  |
| 7 | `vote(chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 79.2% | 95.8% | 93.5% | 0 | 93.8% | 3.00 | 0/0 | $0.3699 | 4603 |  |
| 8 | `confirm(chat:openai/gpt-6-luna#instructions + chat:openai/gpt-6-luna#granular)` | 32 | 0 | 76.0% | 89.1% | 98.2% | 0 | 87.5% | 2.00 | 0/0 | $0.2043 | 6874 |  |
| 9 | `vote(decisions:microsoft/microsoft-decision-1#instructions, chat:openai/gpt-6-luna#granular, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 76.0% | 94.3% | 93.4% | 0 | 93.8% | 3.00 | 0/0 | $0.3289 | 4603 |  |
| 10 | `vote(decisions:typesafe/jev-1.14#base, chat:openai/gpt-6-luna#granular, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 76.0% | 94.3% | 93.4% | 0 | 77.1% | 3.00 | 0/0 | $0.3389 | 4603 |  |

Enumerated over: `chat:openai/gpt-6-luna#instructions`, `decisions:typesafe/jev-1.14#instructions`, `decisions:openai/gpt-6-luna-decisions#granular`, `decisions:typesafe/jev-1.14#granular`, `decisions:openai/gpt-6-luna-decisions#instructions`, `decisions:microsoft/microsoft-decision-1#instructions`, `decisions:typesafe/jev-1.14#base`, `chat:openai/gpt-6-luna#granular` (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: ranked 10 of 12 on development; only the top 8 are enumerated
- `decisions:microsoft/microsoft-decision-1#base`: ranked 12 of 12 on development; only the top 8 are enumerated
- `decisions:microsoft/microsoft-decision-1#granular`: ranked 11 of 12 on development; only the top 8 are enumerated
- `decisions:openai/gpt-6-luna-decisions#base`: ranked 9 of 12 on development; only the top 8 are enumerated

## milestone-boundary

Cases: development 16, holdout 32.

- **Recommended single model:** `single(chat:openai/gpt-6-luna#base)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 84.4%, coverage 99.5%, $0.0973 per 1,000, p95 7258 ms, errors/unsupported 0/0; development: unsafe accepted 3, accepted-exact 81.3%. Best sufficient row; zero unsafe accepted on holdout.
- **Recommended pipeline:** `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 92.7%, coverage 97.9%, $0.2829 per 1,000, p95 9646 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 100.0%. Best sufficient row; zero unsafe accepted on holdout.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:openai/gpt-6-luna#base)` | 32 | 0 | 84.4% | 99.5% | 91.1% | 3 | 81.3% | 1.00 | 0/0 | $0.0973 | 7258 |  |
| 2 | `single(decisions:typesafe/jev-1.14#instructions)` | 32 | 0 | 78.1% | 89.6% | 99.4% | 3 | 81.3% | 1.00 | 0/0 | $0.0668 | 303 |  |
| 3 | `single(decisions:typesafe/jev-1.14#granular)` | 32 | 0 | 66.7% | 84.9% | 98.2% | 0 | 79.2% | 1.00 | 0/0 | $0.0763 | 317 |  |
| 4 | `single(decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 59.4% | 81.3% | 94.2% | 0 | 75.0% | 1.00 | 0/0 | $0.1843 | 1452 |  |
| 5 | `single(decisions:microsoft/microsoft-decision-1#granular)` | 32 | 3 | 78.1% | 93.8% | 95.0% | 0 | 62.5% | 1.00 | 0/0 | $0.0542 | 616 |  |
| 6 | `single(decisions:openai/gpt-6-luna-decisions#instructions)` | 32 | 3 | 59.4% | 82.8% | 96.2% | 0 | 68.8% | 1.00 | 0/0 | $0.1194 | 1238 |  |
| 7 | `single(chat:openai/gpt-6-luna#granular)` | 32 | 4 | 87.5% | 100.0% | 92.7% | 3 | 93.8% | 1.00 | 0/0 | $0.1353 | 9324 |  |
| 8 | `single(chat:openai/gpt-6-luna#instructions)` | 32 | 5 | 91.7% | 100.0% | 95.8% | 0 | 93.8% | 1.00 | 0/0 | $0.0809 | 8046 |  |
| 9 | `single(decisions:typesafe/jev-1.14#base)` | 32 | 5 | 51.0% | 77.6% | 94.6% | 3 | 52.1% | 1.00 | 0/0 | $0.0562 | 304 |  |
| 10 | `single(decisions:microsoft/microsoft-decision-1#instructions)` | 32 | 6 | 66.7% | 86.5% | 94.6% | 3 | 81.3% | 1.00 | 0/0 | $0.0450 | 477 |  |
| 11 | `single(decisions:openai/gpt-6-luna-decisions#base)` | 32 | 6 | 34.4% | 64.1% | 95.1% | 3 | 43.8% | 1.00 | 0/0 | $0.0955 | 1119 |  |
| 12 | `single(decisions:microsoft/microsoft-decision-1#base)` | 32 | 26 | 41.7% | 82.8% | 79.9% | 19 | 39.6% | 1.00 | 0/0 | $0.0349 | 445 |  |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.086 | 0.076 | 1478 | 100% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#base` | holdout | 32 | 0.5% | 0.0% | 81.0%-95.6% (n=64 answers) | 0.082 | 0.070 | 1866 | 91% of 32 | generation 86, response 10 |
| `chat:openai/gpt-6-luna#granular` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.030 | 0.026 | 2176 | 100% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#granular` | holdout | 32 | 0.0% | 0.0% | 85.0%-97.5% (n=64 answers) | 0.070 | 0.063 | 2437 | 91% of 32 | generation 82, response 14 |
| `chat:openai/gpt-6-luna#instructions` | development | 16 | 0.0% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.029 | 0.023 | 1595 | 94% of 16 | generation 48 |
| `chat:openai/gpt-6-luna#instructions` | holdout | 32 | 0.0% | 0.0% | 87.1%-98.4% (n=64 answers) | 0.038 | 0.029 | 2034 | 97% of 32 | generation 85, response 11 |
| `decisions:microsoft/microsoft-decision-1#base` | development | 16 | 14.6% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.200 | 0.161 | 351 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#base` | holdout | 32 | 17.2% | 0.0% | 63.2%-84.0% (n=64 answers) | 0.172 | 0.125 | 350 | 94% of 32 | generation 89, response 7 |
| `decisions:microsoft/microsoft-decision-1#granular` | development | 16 | 18.8% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.066 | 0.085 | 370 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#granular` | holdout | 32 | 6.3% | 0.0% | 87.1%-98.4% (n=64 answers) | 0.062 | 0.046 | 373 | 100% of 32 | generation 85, response 11 |
| `decisions:microsoft/microsoft-decision-1#instructions` | development | 16 | 6.3% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.050 | 0.058 | 359 | 100% of 16 | generation 48 |
| `decisions:microsoft/microsoft-decision-1#instructions` | holdout | 32 | 13.5% | 0.0% | 75.4%-92.4% (n=64 answers) | 0.072 | 0.063 | 353 | 91% of 32 | generation 87, response 9 |
| `decisions:openai/gpt-6-luna-decisions#base` | development | 16 | 28.1% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.075 | 0.186 | 283 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#base` | holdout | 32 | 35.9% | 0.0% | 77.2%-93.5% (n=64 answers) | 0.115 | 0.150 | 285 | 100% of 32 | generation 88, response 8 |
| `decisions:openai/gpt-6-luna-decisions#granular` | development | 16 | 12.5% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.064 | 0.113 | 283 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#granular` | holdout | 32 | 18.8% | 0.0% | 83.0%-96.6% (n=64 answers) | 0.112 | 0.137 | 296 | 100% of 32 | generation 86, response 10 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | development | 16 | 18.8% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.054 | 0.127 | 280 | 100% of 16 | generation 48 |
| `decisions:openai/gpt-6-luna-decisions#instructions` | holdout | 32 | 17.2% | 0.0% | 81.0%-95.6% (n=64 answers) | 0.058 | 0.086 | 288 | 100% of 32 | generation 89, response 7 |
| `decisions:typesafe/jev-1.14#base` | development | 16 | 27.1% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.086 | 0.135 | 224 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#base` | holdout | 32 | 22.4% | 0.0% | 87.1%-98.4% (n=64 answers) | 0.088 | 0.118 | 229 | 97% of 32 | generation 91, response 5 |
| `decisions:typesafe/jev-1.14#granular` | development | 16 | 10.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.040 | 0.067 | 233 | 94% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#granular` | holdout | 32 | 15.1% | 0.0% | 81.0%-95.6% (n=64 answers) | 0.080 | 0.103 | 241 | 94% of 32 | generation 92, response 4 |
| `decisions:typesafe/jev-1.14#instructions` | development | 16 | 6.3% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.039 | 0.052 | 226 | 100% of 16 | generation 48 |
| `decisions:typesafe/jev-1.14#instructions` | holdout | 32 | 10.4% | 0.0% | 83.0%-96.6% (n=64 answers) | 0.041 | 0.063 | 233 | 94% of 32 | generation 85, response 11 |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna#base` | status | 0.50 | 100.0% | 0 | 100.0% | 96.9% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#base` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#granular` | status | 0.50 | 100.0% | 0 | 100.0% | 91.7% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#granular` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna#instructions` | status | 0.50 | 100.0% | 0 | 100.0% | 96.9% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna#instructions` | boundary | 0.50 | 100.0% | 0 | 100.0% | 94.8% | 5 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#base` | status | 0.90 | 62.5% | 6 | 71.9% | 95.7% | 3 |  |
| `decisions:microsoft/microsoft-decision-1#base` | boundary | none | - | 15 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1#granular` | status | 0.50 | 97.9% | 0 | 99.0% | 93.7% | 0 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#granular` | boundary | 0.60 | 72.9% | 9 | 94.8% | 96.7% | 3 |  |
| `decisions:microsoft/microsoft-decision-1#instructions` | status | 0.50 | 100.0% | 0 | 100.0% | 90.6% | 3 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1#instructions` | boundary | 0.95 | 62.5% | 6 | 59.4% | 100.0% | 0 |  |
| `decisions:openai/gpt-6-luna-decisions#base` | status | 0.50 | 100.0% | 0 | 100.0% | 96.9% | 3 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#base` | boundary | 0.75 | 43.8% | 6 | 37.5% | 83.3% | 6 |  |
| `decisions:openai/gpt-6-luna-decisions#granular` | status | 0.50 | 100.0% | 0 | 93.8% | 90.0% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#granular` | boundary | 0.50 | 75.0% | 0 | 78.1% | 100.0% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | status | 0.50 | 93.8% | 0 | 93.8% | 96.7% | 0 | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions#instructions` | boundary | 0.50 | 87.5% | 0 | 84.4% | 96.3% | 3 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#base` | status | 0.60 | 79.2% | 9 | 92.7% | 96.6% | 3 |  |
| `decisions:typesafe/jev-1.14#base` | boundary | none | - | 6 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:typesafe/jev-1.14#granular` | status | 0.50 | 100.0% | 0 | 95.8% | 93.5% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#granular` | boundary | 0.55 | 81.3% | 4 | 81.3% | 96.2% | 3 |  |
| `decisions:typesafe/jev-1.14#instructions` | status | 0.50 | 100.0% | 0 | 97.9% | 96.8% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14#instructions` | boundary | 0.90 | 75.0% | 6 | 71.9% | 100.0% | 0 |  |

### Pipelines (top 10 of 120)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular)` | 32 | 0 | 92.7% | 97.9% | 98.4% | 0 | 100.0% | 3.00 | 0/0 | $0.2829 | 9646 |  |
| 2 | `chain(decisions:typesafe/jev-1.14#instructions > decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 90.6% | 96.9% | 98.4% | 3 | 93.8% | 1.21 | 0/0 | $0.1028 | 858 |  |
| 3 | `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 88.5% | 95.8% | 98.4% | 0 | 93.8% | 3.00 | 0/0 | $0.3320 | 8046 |  |
| 4 | `vote(decisions:microsoft/microsoft-decision-1#instructions, decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions)` | 32 | 0 | 87.5% | 94.3% | 99.4% | 0 | 77.1% | 3.00 | 0/0 | $0.1927 | 8046 |  |
| 5 | `vote(decisions:microsoft/microsoft-decision-1#granular, decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#instructions)` | 32 | 0 | 85.4% | 94.3% | 98.3% | 0 | 85.4% | 3.00 | 0/0 | $0.2019 | 8046 |  |
| 6 | `vote(decisions:microsoft/microsoft-decision-1#granular, decisions:typesafe/jev-1.14#granular, chat:openai/gpt-6-luna#instructions)` | 32 | 0 | 85.4% | 94.3% | 98.3% | 0 | 79.2% | 3.00 | 0/0 | $0.2114 | 8046 |  |
| 7 | `vote(decisions:typesafe/jev-1.14#instructions, chat:openai/gpt-6-luna#granular, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 85.4% | 95.8% | 95.7% | 0 | 93.8% | 3.00 | 0/0 | $0.3863 | 9324 |  |
| 8 | `vote(chat:openai/gpt-6-luna#instructions, chat:openai/gpt-6-luna#granular, decisions:openai/gpt-6-luna-decisions#granular)` | 32 | 0 | 85.4% | 95.8% | 95.7% | 0 | 87.5% | 3.00 | 0/0 | $0.4005 | 9646 |  |
| 9 | `chain(decisions:typesafe/jev-1.14#instructions > decisions:typesafe/jev-1.14#granular)` | 32 | 0 | 84.4% | 93.8% | 98.3% | 3 | 93.8% | 1.21 | 0/0 | $0.0818 | 549 |  |
| 10 | `chain(decisions:typesafe/jev-1.14#instructions > decisions:openai/gpt-6-luna-decisions#instructions)` | 32 | 0 | 84.4% | 93.8% | 98.3% | 3 | 89.6% | 1.21 | 0/0 | $0.0909 | 1198 |  |

Enumerated over: `chat:openai/gpt-6-luna#instructions`, `decisions:typesafe/jev-1.14#granular`, `decisions:openai/gpt-6-luna-decisions#granular`, `decisions:openai/gpt-6-luna-decisions#instructions`, `decisions:microsoft/microsoft-decision-1#granular`, `chat:openai/gpt-6-luna#granular`, `decisions:microsoft/microsoft-decision-1#instructions`, `decisions:typesafe/jev-1.14#instructions` (top 8, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna#base`: ranked 9 of 12 on development; only the top 8 are enumerated
- `decisions:microsoft/microsoft-decision-1#base`: ranked 12 of 12 on development; only the top 8 are enumerated
- `decisions:openai/gpt-6-luna-decisions#base`: ranked 11 of 12 on development; only the top 8 are enumerated
- `decisions:typesafe/jev-1.14#base`: ranked 10 of 12 on development; only the top 8 are enumerated

## Limitations

- Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.
- Samples are small: results with fewer than 8 holdout cases per task are marked insufficient (0 single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.
- Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: generation 3267, response 189, local 0, unknown 0.
- Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.
- The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.
- Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.
- Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).
