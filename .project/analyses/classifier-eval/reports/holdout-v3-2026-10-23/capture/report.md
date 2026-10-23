# Classifier evaluation report

Gate (minimum confidence): 0.7. Runs: `/tmp/hv3/capdev` (128), `/mnt/Projects/furbyhaxx/pi-tree-navigator/.project/analyses/classifier-eval/runs/holdout-v3-2026-10-23/capture` (768). Observations: 896, models: 4.

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
| intent | `single(decisions:microsoft/microsoft-decision-1)` (recommended) | `chain(decisions:microsoft/microsoft-decision-1 > decisions:typesafe/jev-1.14)` (recommended) |
| supersession | `single(decisions:microsoft/microsoft-decision-1)` (recommended) | `single(decisions:microsoft/microsoft-decision-1)` (recommended) |
| milestone-status | none | none |
| milestone-boundary | none | none |

## intent

Cases: development 16, holdout 32.

- **Recommended single model:** `single(decisions:microsoft/microsoft-decision-1)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 78.1%, coverage 80.6%, $0.0100 per 1,000, p95 689 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 81.3%. Best sufficient row; zero unsafe accepted on holdout.
- **Recommended pipeline:** `chain(decisions:microsoft/microsoft-decision-1 > decisions:typesafe/jev-1.14)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 80.2%, coverage 82.4%, $0.0153 per 1,000, p95 911 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 87.5%. Best sufficient row; zero unsafe accepted on holdout.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 78.1% | 80.6% | 96.6% | 0 | 81.3% | 1.00 | 0/0 | $0.0100 | 689 |  |
| 2 | `single(decisions:typesafe/jev-1.14)` | 32 | 0 | 71.9% | 73.1% | 98.7% | 0 | 87.5% | 1.00 | 0/0 | $0.0240 | 275 |  |
| 3 | `single(heuristic)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |
| 4 | `single(chat:openai/gpt-6-luna)` | 32 | 3 | 96.9% | 100.0% | 97.2% | 0 | 93.8% | 1.00 | 0/0 | $0.0512 | 2124 |  |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.053 | 0.038 | 1080 | - | generation 16 |
| `chat:openai/gpt-6-luna` | holdout | 32 | 0.0% | 0.0% | 85.8%-99.5% (n=36 answers) | 0.027 | 0.013 | 1411 | 94% of 32 | generation 93, response 3 |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 17.6% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.030 | 0.082 | 283 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 32 | 19.4% | 0.0% | 78.2%-97.1% (n=36 answers) | 0.072 | 0.079 | 285 | 100% of 32 | generation 92, response 4 |
| `decisions:typesafe/jev-1.14` | development | 16 | 11.8% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.034 | 0.062 | 240 | - | generation 16 |
| `decisions:typesafe/jev-1.14` | holdout | 32 | 26.9% | 0.0% | 74.7%-95.6% (n=36 answers) | 0.064 | 0.069 | 217 | 100% of 32 | generation 92, response 4 |
| `heuristic` | development | 16 | 100.0% | 0.0% | 17.3%-58.7% (n=17 answers) | - | - | 0 | - | local 16 |
| `heuristic` | holdout | 32 | 100.0% | 0.0% | 24.8%-55.1% (n=36 answers) | - | - | 0 | 100% of 32 | local 96 |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna` | kind | 0.50 | 100.0% | 0 | 100.0% | 99.0% | 1 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | contradicts | 0.50 | 100.0% | 0 | 100.0% | 83.3% | 2 | vacuous: no unsafe development answer; insufficient |
| `decisions:microsoft/microsoft-decision-1` | kind | 0.50 | 93.8% | 0 | 94.8% | 96.7% | 0 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | contradicts | 0.50 | 0.0% | 0 | 83.3% | 60.0% | 4 | vacuous: no unsafe development answer; insufficient |
| `decisions:typesafe/jev-1.14` | kind | 0.50 | 93.8% | 0 | 90.6% | 96.6% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | contradicts | 0.50 | 0.0% | 0 | 100.0% | 75.0% | 3 | vacuous: no unsafe development answer; insufficient |
| `heuristic` | kind | 0.50 | 0.0% | 8 | 0.0% | - | 0 |  |
| `heuristic` | contradicts | 0.50 | 0.0% | 0 | 0.0% | - | 0 | vacuous: no unsafe development answer; insufficient |

### Pipelines (top 10 of 25)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(decisions:microsoft/microsoft-decision-1 > decisions:typesafe/jev-1.14)` | 32 | 0 | 80.2% | 82.4% | 96.6% | 0 | 87.5% | 1.19 | 0/0 | $0.0153 | 911 |  |
| 2 | `vote(decisions:microsoft/microsoft-decision-1, decisions:typesafe/jev-1.14, chat:openai/gpt-6-luna)` | 32 | 0 | 80.2% | 80.6% | 98.9% | 0 | 87.5% | 3.00 | 0/0 | $0.0852 | 2124 |  |
| 3 | `chain(heuristic > decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 78.1% | 80.6% | 96.6% | 0 | 81.3% | 2.00 | 0/0 | $0.0100 | 689 |  |
| 4 | `single(decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 78.1% | 80.6% | 96.6% | 0 | 81.3% | 1.00 | 0/0 | $0.0100 | 689 |  |
| 5 | `confirm(decisions:microsoft/microsoft-decision-1 + chat:openai/gpt-6-luna)` | 32 | 0 | 77.1% | 76.9% | 100.0% | 0 | 81.3% | 1.88 | 0/0 | $0.0536 | 2560 |  |
| 6 | `vote(heuristic, decisions:microsoft/microsoft-decision-1, chat:openai/gpt-6-luna)` | 32 | 0 | 77.1% | 76.9% | 100.0% | 0 | 81.3% | 3.00 | 0/0 | $0.0612 | 2124 |  |
| 7 | `single(decisions:typesafe/jev-1.14)` | 32 | 0 | 71.9% | 73.1% | 98.7% | 0 | 87.5% | 1.00 | 0/0 | $0.0240 | 275 |  |
| 8 | `chain(heuristic > decisions:typesafe/jev-1.14)` | 32 | 0 | 71.9% | 73.1% | 98.7% | 0 | 87.5% | 2.00 | 0/0 | $0.0240 | 277 |  |
| 9 | `confirm(decisions:typesafe/jev-1.14 + chat:openai/gpt-6-luna)` | 32 | 0 | 70.8% | 71.3% | 100.0% | 0 | 87.5% | 1.81 | 0/0 | $0.0645 | 2606 |  |
| 10 | `vote(heuristic, decisions:typesafe/jev-1.14, chat:openai/gpt-6-luna)` | 32 | 0 | 70.8% | 71.3% | 100.0% | 0 | 87.5% | 3.00 | 0/0 | $0.0752 | 2124 |  |

Enumerated over: `chat:openai/gpt-6-luna`, `decisions:typesafe/jev-1.14`, `decisions:microsoft/microsoft-decision-1`, `heuristic` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated.

## supersession

Cases: development 16, holdout 32.

- **Recommended single model:** `single(decisions:microsoft/microsoft-decision-1)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 65.6%, coverage 82.3%, $0.0182 per 1,000, p95 450 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 75.0%. Best sufficient row; zero unsafe accepted on holdout.
- **Recommended pipeline:** `single(decisions:microsoft/microsoft-decision-1)` [recommended] - holdout n=32: unsafe accepted 0, accepted-exact 65.6%, coverage 82.3%, $0.0182 per 1,000, p95 450 ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 75.0%. Best sufficient row; zero unsafe accepted on holdout.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 65.6% | 82.3% | 96.8% | 0 | 75.0% | 1.00 | 0/0 | $0.0182 | 450 |  |
| 2 | `single(heuristic)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |
| 3 | `single(decisions:typesafe/jev-1.14)` | 32 | 3 | 36.5% | 67.2% | 95.3% | 0 | 62.5% | 1.00 | 0/0 | $0.0374 | 258 |  |
| 4 | `single(chat:openai/gpt-6-luna)` | 32 | 7 | 79.2% | 100.0% | 89.6% | 0 | 87.5% | 1.00 | 0/0 | $0.0803 | 7530 |  |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.062 | 0.051 | 1439 | - | generation 15, response 1 |
| `chat:openai/gpt-6-luna` | holdout | 32 | 0.0% | 0.0% | 79.1%-94.6% (n=64 answers) | 0.094 | 0.079 | 1687 | 75% of 32 | generation 86, response 10 |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 12.5% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.032 | 0.099 | 329 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 32 | 17.7% | 0.0% | 83.0%-96.6% (n=64 answers) | 0.068 | 0.072 | 335 | 97% of 32 | generation 89, response 7 |
| `decisions:typesafe/jev-1.14` | development | 16 | 18.8% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.049 | 0.085 | 226 | - | generation 15, response 1 |
| `decisions:typesafe/jev-1.14` | holdout | 32 | 32.8% | 0.0% | 77.2%-93.5% (n=64 answers) | 0.107 | 0.132 | 220 | 91% of 32 | generation 86, response 10 |
| `heuristic` | development | 16 | 100.0% | 0.0% | 22.9%-54.7% (n=32 answers) | - | - | 0 | - | local 16 |
| `heuristic` | holdout | 32 | 100.0% | 0.0% | 36.6%-60.4% (n=64 answers) | - | - | 0 | 100% of 32 | local 96 |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:openai/gpt-6-luna` | kind | 0.50 | 100.0% | 0 | 100.0% | 86.5% | 0 | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | contradicts | 0.50 | 100.0% | 0 | 100.0% | 92.7% | 7 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | kind | 0.50 | 93.8% | 0 | 86.5% | 92.8% | 0 | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | contradicts | 0.50 | 100.0% | 0 | 90.6% | 100.0% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | kind | 0.50 | 81.3% | 0 | 82.3% | 87.3% | 0 | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | contradicts | 0.50 | 93.8% | 0 | 89.6% | 96.5% | 3 | vacuous: no unsafe development answer |
| `heuristic` | kind | 0.50 | 0.0% | 11 | 0.0% | - | 0 |  |
| `heuristic` | contradicts | 0.50 | 0.0% | 0 | 0.0% | - | 0 | vacuous: no unsafe development answer |

### Pipelines (top 10 of 25)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 65.6% | 82.3% | 96.8% | 0 | 75.0% | 1.00 | 0/0 | $0.0182 | 450 |  |
| 2 | `chain(heuristic > decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 65.6% | 82.3% | 96.8% | 0 | 75.0% | 2.00 | 0/0 | $0.0182 | 450 |  |
| 3 | `confirm(decisions:microsoft/microsoft-decision-1 + chat:openai/gpt-6-luna)` | 32 | 0 | 53.1% | 72.9% | 97.9% | 0 | 62.5% | 1.94 | 0/0 | $0.0934 | 7855 |  |
| 4 | `vote(heuristic, decisions:microsoft/microsoft-decision-1, chat:openai/gpt-6-luna)` | 32 | 0 | 53.1% | 72.9% | 97.9% | 0 | 62.5% | 3.00 | 0/0 | $0.0985 | 7530 |  |
| 5 | `confirm(decisions:microsoft/microsoft-decision-1 + decisions:typesafe/jev-1.14)` | 32 | 0 | 32.3% | 60.9% | 97.4% | 0 | 56.3% | 1.94 | 0/0 | $0.0532 | 666 |  |
| 6 | `vote(heuristic, decisions:microsoft/microsoft-decision-1, decisions:typesafe/jev-1.14)` | 32 | 0 | 32.3% | 60.9% | 97.4% | 0 | 56.3% | 3.00 | 0/0 | $0.0556 | 463 |  |
| 7 | `confirm(heuristic + chat:openai/gpt-6-luna)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |
| 8 | `confirm(heuristic + decisions:microsoft/microsoft-decision-1)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |
| 9 | `confirm(heuristic + decisions:typesafe/jev-1.14)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |
| 10 | `single(heuristic)` | 32 | 0 | 0.0% | 0.0% | - | 0 | 0.0% | 1.00 | 0/0 | $0.0000 | 2 |  |

Enumerated over: `chat:openai/gpt-6-luna`, `decisions:microsoft/microsoft-decision-1`, `decisions:typesafe/jev-1.14`, `heuristic` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated.

## milestone-status

Cases: development 16, holdout 32.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** none (No observations for this task.)

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

### Pipelines (top 0 of 0)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Enumerated over: no model (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1`: no observations for this task
- `decisions:typesafe/jev-1.14`: no observations for this task
- `heuristic`: no observations for this task

## milestone-boundary

Cases: development 16, holdout 32.

- **Recommended single model:** none (No observations for this task.)
- **Recommended pipeline:** none (No observations for this task.)

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

### Pipelines (top 0 of 0)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Enumerated over: no model (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Fewer than three eligible models: no majority vote enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:openai/gpt-6-luna`: no observations for this task
- `decisions:microsoft/microsoft-decision-1`: no observations for this task
- `decisions:typesafe/jev-1.14`: no observations for this task
- `heuristic`: no observations for this task

## Limitations

- Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.
- Samples are small: results with fewer than 8 holdout cases per task are marked insufficient (0 single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.
- Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: generation 632, response 40, local 224, unknown 0.
- Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.
- The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.
- Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.
- Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).
