# Classifier evaluation report

Gate (minimum confidence): 0.7. Runs: `/mnt/Projects/furbyhaxx/pi-tree-navigator/.project/analyses/classifier-eval/runs/dev-screen-2026-10-23` (1664). Observations: 1664, models: 26.

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
| intent | `single(chat:google/gemini-2.5-flash-lite)` (insufficient-evidence) | `heuristic-only` (no-safe-candidate) |
| supersession | `single(chat:google/gemini-2.5-flash-lite)` (insufficient-evidence) | `heuristic-only` (no-safe-candidate) |
| milestone-status | `single(chat:google/gemini-2.5-flash-lite)` (insufficient-evidence) | `chain(decisions:jaredpalmer/kev-4b > decisions:openai/gpt-6-luna-decisions)` (insufficient-evidence) |
| milestone-boundary | `single(chat:google/gemini-2.5-flash-lite)` (insufficient-evidence) | `chain(decisions:jaredpalmer/kev-4b > chat:openai/gpt-6-luna)` (insufficient-evidence) |

## intent

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:google/gemini-2.5-flash-lite)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 87.5%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=8: unsafe accepted 4, accepted-exact 25.0%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 8, accepted-exact 31.3%. No sufficient row has zero unsafe accepted on holdout; fewest is 4.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:google/gemini-2.5-flash-lite)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:cloudflare/clef-flash)` | 0 | 0 | 0.0% | - | - | 0 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:cloudflare/clef-omni)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:cloudflare/clef)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:inception/mercury-decide)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:liquid/d1-ultra)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(decisions:liquid/d1)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:nace-ai/drex-v1.5)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:nace-ai/drex-v2.0)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:perplexity/pplx-decider-flash-v1.2)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:perplexity/pplx-decider-v1.1-27b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:perplexity/pplx-decider-v1.2)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:respan/span-01)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:respan/span-02)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:scaledown/classify-1)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:togethercomputer/tev1-4b-experimental)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:upstage/solar-decide-flash)` | 0 | 0 | 0.0% | - | - | 0 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:upstage/solar-decide)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | development | 16 | 0.0% | 11.8% | 65.7%-96.7% (n=17 answers) | 0.007 | 0.070 | 513 | - | generation 14, local 2 |
| `chat:google/gemini-2.5-flash-lite` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.053 | 0.038 | 1080 | - | generation 16 |
| `chat:openai/gpt-6-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef` | development | 16 | 29.4% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.058 | 0.219 | 332 | - | generation 16 |
| `decisions:cloudflare/clef` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-flash` | development | 16 | 58.8% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.140 | 0.254 | 287 | - | generation 16 |
| `decisions:cloudflare/clef-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-omni` | development | 16 | 64.7% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.199 | 0.283 | 316 | - | generation 16 |
| `decisions:cloudflare/clef-omni` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:inception/mercury-decide` | development | 16 | 5.9% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.027 | 0.065 | 301 | - | generation 16 |
| `decisions:inception/mercury-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | development | 16 | 94.1% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.311 | 0.477 | 325 | - | generation 16 |
| `decisions:jaredpalmer/kev-4b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1` | development | 16 | 23.5% | 0.0% | 81.6%-100.0% (n=17 answers) | 0.045 | 0.148 | 207 | - | generation 16 |
| `decisions:liquid/d1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1-ultra` | development | 16 | 17.6% | 5.9% | 73.0%-99.0% (n=17 answers) | 0.068 | 0.166 | 299 | - | generation 15, unknown 1 |
| `decisions:liquid/d1-ultra` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 17.6% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.030 | 0.082 | 283 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-max` | development | 16 | 11.8% | 0.0% | 81.6%-100.0% (n=17 answers) | 0.016 | 0.066 | 362 | - | generation 16 |
| `decisions:nace-ai/drex-max` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | development | 16 | 23.5% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.081 | 0.141 | 294 | - | generation 16 |
| `decisions:nace-ai/drex-v1.5` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | development | 16 | 17.6% | 11.8% | 59.0%-93.8% (n=17 answers) | 0.080 | 0.172 | 475 | - | generation 14, local 2 |
| `decisions:nace-ai/drex-v2.0` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | development | 16 | 17.6% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.058 | 0.131 | 266 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | development | 16 | 35.3% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.147 | 0.212 | 175 | - | generation 16 |
| `decisions:perplexity/pplx-decider-flash-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.1-27b` | development | 16 | 0.0% | 100.0% | 0.0%-18.4% (n=17 answers) | - | - | 24 | - | local 16 |
| `decisions:perplexity/pplx-decider-v1.1-27b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | development | 16 | 23.5% | 0.0% | 81.6%-100.0% (n=17 answers) | 0.051 | 0.133 | 238 | - | generation 16 |
| `decisions:perplexity/pplx-decider-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-01` | development | 16 | 0.0% | 100.0% | 0.0%-18.4% (n=17 answers) | - | - | 33 | - | local 16 |
| `decisions:respan/span-01` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-02` | development | 16 | 29.4% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.054 | 0.173 | 309 | - | generation 16 |
| `decisions:respan/span-02` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:scaledown/classify-1` | development | 16 | 0.0% | 100.0% | 0.0%-18.4% (n=17 answers) | - | - | 30 | - | local 16 |
| `decisions:scaledown/classify-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | development | 16 | 35.3% | 0.0% | 59.0%-93.8% (n=17 answers) | 0.072 | 0.171 | 232 | - | generation 16 |
| `decisions:togethercomputer/tev1-4b-experimental` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.13` | development | 16 | 11.8% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.066 | 0.128 | 198 | - | generation 16 |
| `decisions:typesafe/jev-1.13` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14` | development | 16 | 11.8% | 0.0% | 73.0%-99.0% (n=17 answers) | 0.034 | 0.062 | 240 | - | generation 16 |
| `decisions:typesafe/jev-1.14` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide` | development | 16 | 23.5% | 0.0% | 65.7%-96.7% (n=17 answers) | 0.100 | 0.096 | 638 | - | generation 16 |
| `decisions:upstage/solar-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | development | 16 | 52.9% | 0.0% | 46.9%-86.7% (n=17 answers) | 0.114 | 0.113 | 731 | - | generation 16 |
| `decisions:upstage/solar-decide-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `heuristic` | development | 16 | 100.0% | 0.0% | 17.3%-58.7% (n=17 answers) | - | - | 0 | - | local 16 |
| `heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | kind | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:google/gemini-2.5-flash-lite` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `chat:openai/gpt-6-luna` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:cloudflare/clef` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:cloudflare/clef-flash` | kind | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef-flash` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:cloudflare/clef-omni` | kind | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef-omni` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:inception/mercury-decide` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:inception/mercury-decide` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:jaredpalmer/kev-4b` | kind | 0.50 | 25.0% | 1 | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:liquid/d1` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:liquid/d1-ultra` | kind | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1-ultra` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:microsoft/microsoft-decision-1` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:nace-ai/drex-max` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-max` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:nace-ai/drex-v1.5` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v1.5` | contradicts | 0.65 | 0.0% | 1 | - | - | - | insufficient |
| `decisions:nace-ai/drex-v2.0` | kind | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v2.0` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:openai/gpt-6-luna-decisions` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions` | contradicts | 0.70 | 0.0% | 1 | - | - | - | insufficient |
| `decisions:perplexity/pplx-decider-flash-v1.2` | kind | 0.65 | 68.8% | 1 | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:perplexity/pplx-decider-v1.1-27b` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.1-27b` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:perplexity/pplx-decider-v1.2` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.2` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:respan/span-01` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-01` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:respan/span-02` | kind | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-02` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:scaledown/classify-1` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:scaledown/classify-1` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:togethercomputer/tev1-4b-experimental` | kind | 0.50 | 87.5% | 1 | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:typesafe/jev-1.13` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.13` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:typesafe/jev-1.14` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:upstage/solar-decide` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:upstage/solar-decide` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `decisions:upstage/solar-decide-flash` | kind | 0.55 | 75.0% | 1 | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |
| `heuristic` | kind | 0.50 | 0.0% | 8 | - | - | - |  |
| `heuristic` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer; insufficient |

### Pipelines (top 10 of 25)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `heuristic-only` | 8 | 4 | 25.0% | 100.0% | 33.3% | 8 | 31.3% | 0.00 | 0/0 | $0.0000 | 0 | fallback |
| 2 | `chain(decisions:inception/mercury-decide > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(decisions:inception/mercury-decide > decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(decisions:inception/mercury-decide > decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:nace-ai/drex-max > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:nace-ai/drex-max > decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(decisions:typesafe/jev-1.13 > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `confirm(decisions:inception/mercury-decide + chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `confirm(decisions:inception/mercury-decide + decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `confirm(decisions:inception/mercury-decide + decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `decisions:inception/mercury-decide`, `chat:openai/gpt-6-luna`, `decisions:nace-ai/drex-max`, `decisions:typesafe/jev-1.13` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated.

Excluded from pipeline enumeration:

- `chat:google/gemini-2.5-flash-lite`: ranked 6 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef`: ranked 12 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-flash`: ranked 20 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-omni`: ranked 21 of 23 on development; only the top 4 are enumerated
- `decisions:jaredpalmer/kev-4b`: ranked 22 of 23 on development; only the top 4 are enumerated
- `decisions:liquid/d1`: ranked 9 of 23 on development; only the top 4 are enumerated
- `decisions:liquid/d1-ultra`: ranked 13 of 23 on development; only the top 4 are enumerated
- `decisions:microsoft/microsoft-decision-1`: ranked 7 of 23 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v1.5`: ranked 11 of 23 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v2.0`: ranked 15 of 23 on development; only the top 4 are enumerated
- `decisions:openai/gpt-6-luna-decisions`: ranked 8 of 23 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-flash-v1.2`: ranked 17 of 23 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-v1.1-27b`: no successful development call (every call was an error or unsupported)
- `decisions:perplexity/pplx-decider-v1.2`: ranked 10 of 23 on development; only the top 4 are enumerated
- `decisions:respan/span-01`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-02`: ranked 14 of 23 on development; only the top 4 are enumerated
- `decisions:scaledown/classify-1`: no successful development call (every call was an error or unsupported)
- `decisions:togethercomputer/tev1-4b-experimental`: ranked 18 of 23 on development; only the top 4 are enumerated
- `decisions:typesafe/jev-1.14`: ranked 5 of 23 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide`: ranked 16 of 23 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide-flash`: ranked 19 of 23 on development; only the top 4 are enumerated
- `heuristic`: ranked 23 of 23 on development; only the top 4 are enumerated

## supersession

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:google/gemini-2.5-flash-lite)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 0, accepted-exact 68.8%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `heuristic-only` [no-safe-candidate] - holdout n=8: unsafe accepted 5, accepted-exact 37.5%, coverage 100.0%, $0.0000 per 1,000, p95 0 ms, errors/unsupported 0/0; development: unsafe accepted 11, accepted-exact 18.8%. No sufficient row has zero unsafe accepted on holdout; fewest is 5.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:google/gemini-2.5-flash-lite)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:cloudflare/clef-flash)` | 0 | 0 | 0.0% | - | - | 0 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:cloudflare/clef-omni)` | 0 | 0 | 0.0% | - | - | 0 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:cloudflare/clef)` | 0 | 0 | 0.0% | - | - | 0 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:inception/mercury-decide)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:liquid/d1-ultra)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(decisions:liquid/d1)` | 0 | 0 | 0.0% | - | - | 0 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:nace-ai/drex-v1.5)` | 0 | 0 | 0.0% | - | - | 0 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:nace-ai/drex-v2.0)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:perplexity/pplx-decider-flash-v1.2)` | 0 | 0 | 0.0% | - | - | 0 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:perplexity/pplx-decider-v1.1-27b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:perplexity/pplx-decider-v1.2)` | 0 | 0 | 0.0% | - | - | 0 | 56.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:respan/span-01)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:respan/span-02)` | 0 | 0 | 0.0% | - | - | 0 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:scaledown/classify-1)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:togethercomputer/tev1-4b-experimental)` | 0 | 0 | 0.0% | - | - | 1 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:upstage/solar-decide-flash)` | 0 | 0 | 0.0% | - | - | 0 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:upstage/solar-decide)` | 0 | 0 | 0.0% | - | - | 1 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | development | 16 | 0.0% | 25.0% | 54.6%-84.4% (n=32 answers) | 0.049 | 0.065 | 538 | - | generation 12, local 4 |
| `chat:google/gemini-2.5-flash-lite` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.062 | 0.051 | 1439 | - | generation 15, response 1 |
| `chat:openai/gpt-6-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef` | development | 16 | 46.9% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.146 | 0.278 | 303 | - | generation 16 |
| `decisions:cloudflare/clef` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-flash` | development | 16 | 59.4% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.159 | 0.206 | 278 | - | generation 16 |
| `decisions:cloudflare/clef-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-omni` | development | 16 | 65.6% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.167 | 0.274 | 261 | - | generation 16 |
| `decisions:cloudflare/clef-omni` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:inception/mercury-decide` | development | 16 | 3.1% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.011 | 0.041 | 334 | - | generation 16 |
| `decisions:inception/mercury-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | development | 16 | 81.3% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.245 | 0.348 | 328 | - | generation 16 |
| `decisions:jaredpalmer/kev-4b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1` | development | 16 | 21.9% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.118 | 0.108 | 218 | - | generation 16 |
| `decisions:liquid/d1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1-ultra` | development | 16 | 12.5% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.041 | 0.129 | 217 | - | generation 16 |
| `decisions:liquid/d1-ultra` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 12.5% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.032 | 0.099 | 329 | - | generation 16 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-max` | development | 16 | 9.4% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.017 | 0.071 | 356 | - | generation 16 |
| `decisions:nace-ai/drex-max` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | development | 16 | 25.0% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.120 | 0.151 | 256 | - | generation 16 |
| `decisions:nace-ai/drex-v1.5` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | development | 16 | 37.5% | 0.0% | 84.3%-99.4% (n=32 answers) | 0.111 | 0.216 | 289 | - | generation 16 |
| `decisions:nace-ai/drex-v2.0` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | development | 16 | 34.4% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.090 | 0.152 | 267 | - | generation 16 |
| `decisions:openai/gpt-6-luna-decisions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | development | 16 | 15.6% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.076 | 0.088 | 180 | - | generation 16 |
| `decisions:perplexity/pplx-decider-flash-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.1-27b` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 16 | - | local 16 |
| `decisions:perplexity/pplx-decider-v1.1-27b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | development | 16 | 25.0% | 0.0% | 89.3%-100.0% (n=32 answers) | 0.050 | 0.143 | 239 | - | generation 15, response 1 |
| `decisions:perplexity/pplx-decider-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-01` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 29 | - | local 16 |
| `decisions:respan/span-01` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-02` | development | 16 | 28.1% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.103 | 0.132 | 290 | - | generation 16 |
| `decisions:respan/span-02` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:scaledown/classify-1` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 32 | - | local 16 |
| `decisions:scaledown/classify-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | development | 16 | 34.4% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.141 | 0.155 | 222 | - | generation 16 |
| `decisions:togethercomputer/tev1-4b-experimental` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.13` | development | 16 | 18.8% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.052 | 0.107 | 189 | - | generation 16 |
| `decisions:typesafe/jev-1.13` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14` | development | 16 | 18.8% | 0.0% | 79.9%-98.3% (n=32 answers) | 0.049 | 0.085 | 226 | - | generation 15, response 1 |
| `decisions:typesafe/jev-1.14` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide` | development | 16 | 6.3% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.113 | 0.127 | 3133 | - | generation 16 |
| `decisions:upstage/solar-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | development | 16 | 50.0% | 0.0% | 45.3%-77.1% (n=32 answers) | 0.172 | 0.153 | 597 | - | generation 16 |
| `decisions:upstage/solar-decide-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `heuristic` | development | 16 | 100.0% | 0.0% | 22.9%-54.7% (n=32 answers) | - | - | 0 | - | local 16 |
| `heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | kind | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:google/gemini-2.5-flash-lite` | contradicts | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef` | kind | 0.50 | 56.3% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef` | contradicts | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef-flash` | kind | 0.50 | 43.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef-flash` | contradicts | 0.50 | 87.5% | 1 | - | - | - |  |
| `decisions:cloudflare/clef-omni` | kind | 0.50 | 43.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:cloudflare/clef-omni` | contradicts | 0.50 | 81.3% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:inception/mercury-decide` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:inception/mercury-decide` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:jaredpalmer/kev-4b` | kind | 0.50 | 25.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:jaredpalmer/kev-4b` | contradicts | 0.50 | 56.3% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1` | kind | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1-ultra` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:liquid/d1-ultra` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:microsoft/microsoft-decision-1` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-max` | kind | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:nace-ai/drex-max` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v1.5` | kind | 0.50 | 81.3% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v1.5` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v2.0` | kind | 0.50 | 68.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:nace-ai/drex-v2.0` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions` | kind | 0.50 | 75.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-flash-v1.2` | kind | 0.50 | 87.5% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-flash-v1.2` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.1-27b` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.1-27b` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.2` | kind | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.2` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-01` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-01` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-02` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-02` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:scaledown/classify-1` | kind | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:scaledown/classify-1` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:togethercomputer/tev1-4b-experimental` | kind | 0.50 | 87.5% | 2 | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | contradicts | 0.75 | 75.0% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.13` | kind | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.13` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | kind | 0.50 | 81.3% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:typesafe/jev-1.14` | contradicts | 0.50 | 93.8% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:upstage/solar-decide` | kind | 0.95 | 62.5% | 1 | - | - | - |  |
| `decisions:upstage/solar-decide` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:upstage/solar-decide-flash` | kind | 0.70 | 31.3% | 4 | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | contradicts | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `heuristic` | kind | 0.50 | 0.0% | 11 | - | - | - |  |
| `heuristic` | contradicts | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |

### Pipelines (top 10 of 25)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `heuristic-only` | 8 | 5 | 37.5% | 100.0% | 56.3% | 11 | 18.8% | 0.00 | 0/0 | $0.0000 | 0 | fallback |
| 2 | `chain(decisions:inception/mercury-decide > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(decisions:inception/mercury-decide > decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(decisions:inception/mercury-decide > decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:microsoft/microsoft-decision-1 > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:microsoft/microsoft-decision-1 > decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 100.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `chain(decisions:nace-ai/drex-max > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 93.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `confirm(decisions:inception/mercury-decide + chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `confirm(decisions:inception/mercury-decide + decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `confirm(decisions:inception/mercury-decide + decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 0 | 75.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `decisions:inception/mercury-decide`, `chat:openai/gpt-6-luna`, `decisions:nace-ai/drex-max`, `decisions:microsoft/microsoft-decision-1` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated.

Excluded from pipeline enumeration:

- `chat:google/gemini-2.5-flash-lite`: ranked 7 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef`: ranked 16 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-flash`: ranked 18 of 23 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-omni`: ranked 19 of 23 on development; only the top 4 are enumerated
- `decisions:jaredpalmer/kev-4b`: ranked 21 of 23 on development; only the top 4 are enumerated
- `decisions:liquid/d1`: ranked 11 of 23 on development; only the top 4 are enumerated
- `decisions:liquid/d1-ultra`: ranked 5 of 23 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v1.5`: ranked 13 of 23 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v2.0`: ranked 14 of 23 on development; only the top 4 are enumerated
- `decisions:openai/gpt-6-luna-decisions`: ranked 15 of 23 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-flash-v1.2`: ranked 6 of 23 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-v1.1-27b`: no successful development call (every call was an error or unsupported)
- `decisions:perplexity/pplx-decider-v1.2`: ranked 10 of 23 on development; only the top 4 are enumerated
- `decisions:respan/span-01`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-02`: ranked 12 of 23 on development; only the top 4 are enumerated
- `decisions:scaledown/classify-1`: no successful development call (every call was an error or unsupported)
- `decisions:togethercomputer/tev1-4b-experimental`: ranked 23 of 23 on development; only the top 4 are enumerated
- `decisions:typesafe/jev-1.13`: ranked 8 of 23 on development; only the top 4 are enumerated
- `decisions:typesafe/jev-1.14`: ranked 9 of 23 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide`: ranked 22 of 23 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide-flash`: ranked 17 of 23 on development; only the top 4 are enumerated
- `heuristic`: ranked 20 of 23 on development; only the top 4 are enumerated

## milestone-status

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:google/gemini-2.5-flash-lite)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 6, accepted-exact 62.5%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(decisions:jaredpalmer/kev-4b > decisions:openai/gpt-6-luna-decisions)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 1, accepted-exact 50.0%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:google/gemini-2.5-flash-lite)` | 0 | 0 | 0.0% | - | - | 6 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 4 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:cloudflare/clef-flash)` | 0 | 0 | 0.0% | - | - | 4 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:cloudflare/clef-omni)` | 0 | 0 | 0.0% | - | - | 2 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:cloudflare/clef)` | 0 | 0 | 0.0% | - | - | 3 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:inception/mercury-decide)` | 0 | 0 | 0.0% | - | - | 5 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:liquid/d1-ultra)` | 0 | 0 | 0.0% | - | - | 5 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(decisions:liquid/d1)` | 0 | 0 | 0.0% | - | - | 6 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 6 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 2 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:nace-ai/drex-v1.5)` | 0 | 0 | 0.0% | - | - | 6 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:nace-ai/drex-v2.0)` | 0 | 0 | 0.0% | - | - | 3 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 1 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:perplexity/pplx-decider-flash-v1.2)` | 0 | 0 | 0.0% | - | - | 10 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:perplexity/pplx-decider-v1.1-27b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:perplexity/pplx-decider-v1.2)` | 0 | 0 | 0.0% | - | - | 2 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:respan/span-01)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:respan/span-02)` | 0 | 0 | 0.0% | - | - | 10 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:scaledown/classify-1)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:togethercomputer/tev1-4b-experimental)` | 0 | 0 | 0.0% | - | - | 9 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 2 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:upstage/solar-decide-flash)` | 0 | 0 | 0.0% | - | - | 3 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:upstage/solar-decide)` | 0 | 0 | 0.0% | - | - | 6 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | development | 16 | 0.0% | 12.5% | 48.3%-79.6% (n=32 answers) | 0.227 | 0.221 | 592 | - | generation 13, response 1, local 2 |
| `chat:google/gemini-2.5-flash-lite` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.122 | 0.110 | 1302 | - | generation 16 |
| `chat:openai/gpt-6-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef` | development | 16 | 40.6% | 0.0% | 36.4%-69.1% (n=32 answers) | 0.162 | 0.254 | 335 | - | generation 14, response 2 |
| `decisions:cloudflare/clef` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-flash` | development | 16 | 56.3% | 0.0% | 33.6%-66.4% (n=32 answers) | 0.193 | 0.166 | 303 | - | generation 13, response 3 |
| `decisions:cloudflare/clef-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-omni` | development | 16 | 59.4% | 0.0% | 36.4%-69.1% (n=32 answers) | 0.177 | 0.134 | 267 | - | generation 13, response 3 |
| `decisions:cloudflare/clef-omni` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:inception/mercury-decide` | development | 16 | 12.5% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.155 | 0.185 | 399 | - | generation 15, response 1 |
| `decisions:inception/mercury-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | development | 16 | 81.3% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.212 | 0.189 | 358 | - | generation 16 |
| `decisions:jaredpalmer/kev-4b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1` | development | 16 | 31.3% | 0.0% | 48.3%-79.6% (n=32 answers) | 0.218 | 0.202 | 234 | - | generation 16 |
| `decisions:liquid/d1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1-ultra` | development | 16 | 28.1% | 0.0% | 51.4%-82.0% (n=32 answers) | 0.195 | 0.208 | 236 | - | generation 13, response 3 |
| `decisions:liquid/d1-ultra` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 18.8% | 0.0% | 54.6%-84.4% (n=32 answers) | 0.214 | 0.182 | 343 | - | generation 15, response 1 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-max` | development | 16 | 25.0% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.102 | 0.096 | 370 | - | generation 13, response 3 |
| `decisions:nace-ai/drex-max` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | development | 16 | 37.5% | 0.0% | 36.4%-69.1% (n=32 answers) | 0.230 | 0.224 | 318 | - | generation 15, response 1 |
| `decisions:nace-ai/drex-v1.5` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | development | 16 | 46.9% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.168 | 0.155 | 278 | - | generation 15, response 1 |
| `decisions:nace-ai/drex-v2.0` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | development | 16 | 31.3% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.094 | 0.102 | 269 | - | generation 13, response 3 |
| `decisions:openai/gpt-6-luna-decisions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | development | 16 | 18.8% | 0.0% | 36.4%-69.1% (n=32 answers) | 0.317 | 0.338 | 190 | - | generation 14, response 2 |
| `decisions:perplexity/pplx-decider-flash-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.1-27b` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 17 | - | local 16 |
| `decisions:perplexity/pplx-decider-v1.1-27b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | development | 16 | 15.6% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.109 | 0.152 | 249 | - | generation 14, response 2 |
| `decisions:perplexity/pplx-decider-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-01` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 30 | - | local 16 |
| `decisions:respan/span-01` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-02` | development | 16 | 12.5% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.286 | 0.290 | 274 | - | generation 14, response 2 |
| `decisions:respan/span-02` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:scaledown/classify-1` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 28 | - | local 16 |
| `decisions:scaledown/classify-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | development | 16 | 21.9% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.281 | 0.270 | 238 | - | generation 13, response 3 |
| `decisions:togethercomputer/tev1-4b-experimental` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.13` | development | 16 | 34.4% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.121 | 0.048 | 219 | - | generation 14, response 2 |
| `decisions:typesafe/jev-1.13` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14` | development | 16 | 28.1% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.081 | 0.104 | 221 | - | generation 14, response 2 |
| `decisions:typesafe/jev-1.14` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide` | development | 16 | 9.4% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.160 | 0.131 | 5480 | - | generation 15, response 1 |
| `decisions:upstage/solar-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | development | 16 | 50.0% | 0.0% | 51.4%-82.0% (n=32 answers) | 0.188 | 0.148 | 660 | - | generation 13, response 3 |
| `decisions:upstage/solar-decide-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `heuristic` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | - | - | local 16 |
| `heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | status | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:google/gemini-2.5-flash-lite` | boundary | none | - | 4 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna` | status | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `chat:openai/gpt-6-luna` | boundary | none | - | 3 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:cloudflare/clef` | status | 0.80 | 81.3% | 2 | - | - | - |  |
| `decisions:cloudflare/clef` | boundary | 0.90 | 0.0% | 13 | - | - | - |  |
| `decisions:cloudflare/clef-flash` | status | 0.85 | 12.5% | 3 | - | - | - |  |
| `decisions:cloudflare/clef-flash` | boundary | 0.80 | 6.3% | 13 | - | - | - |  |
| `decisions:cloudflare/clef-omni` | status | 0.90 | 12.5% | 3 | - | - | - |  |
| `decisions:cloudflare/clef-omni` | boundary | 0.80 | 0.0% | 12 | - | - | - |  |
| `decisions:inception/mercury-decide` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:inception/mercury-decide` | boundary | none | - | 8 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:jaredpalmer/kev-4b` | status | 0.50 | 56.3% | 1 | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | boundary | 0.70 | 6.3% | 12 | - | - | - |  |
| `decisions:liquid/d1` | status | 0.80 | 81.3% | 2 | - | - | - |  |
| `decisions:liquid/d1` | boundary | 0.95 | 18.8% | 9 | - | - | - |  |
| `decisions:liquid/d1-ultra` | status | 0.75 | 87.5% | 2 | - | - | - |  |
| `decisions:liquid/d1-ultra` | boundary | 0.95 | 18.8% | 8 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | status | none | - | 1 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:microsoft/microsoft-decision-1` | boundary | none | - | 7 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:nace-ai/drex-max` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:nace-ai/drex-max` | boundary | 0.85 | 31.3% | 5 | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | status | 0.75 | 75.0% | 1 | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | boundary | 0.95 | 0.0% | 13 | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | status | 0.80 | 62.5% | 2 | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | boundary | 0.90 | 12.5% | 11 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | status | 0.65 | 87.5% | 1 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | boundary | 0.85 | 12.5% | 4 | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | status | 0.95 | 56.3% | 2 | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | boundary | none | - | 13 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:perplexity/pplx-decider-v1.1-27b` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.1-27b` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.2` | status | 0.95 | 68.8% | 1 | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:respan/span-01` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-01` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-02` | status | 0.95 | 68.8% | 2 | - | - | - |  |
| `decisions:respan/span-02` | boundary | none | - | 10 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:scaledown/classify-1` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:scaledown/classify-1` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:togethercomputer/tev1-4b-experimental` | status | 0.95 | 43.8% | 3 | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | boundary | none | - | 10 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:typesafe/jev-1.13` | status | 0.75 | 87.5% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.13` | boundary | 0.90 | 12.5% | 7 | - | - | - |  |
| `decisions:typesafe/jev-1.14` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:typesafe/jev-1.14` | boundary | 0.70 | 50.0% | 4 | - | - | - |  |
| `decisions:upstage/solar-decide` | status | 0.80 | 81.3% | 1 | - | - | - |  |
| `decisions:upstage/solar-decide` | boundary | none | - | 6 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:upstage/solar-decide-flash` | status | 0.70 | 43.8% | 3 | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | boundary | 0.80 | 31.3% | 6 | - | - | - |  |
| `heuristic` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `heuristic` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |

### Pipelines (top 10 of 20)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(decisions:jaredpalmer/kev-4b > decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 1 | 50.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(decisions:jaredpalmer/kev-4b > decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 50.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(decisions:perplexity/pplx-decider-v1.2 > decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 2 | 68.8% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(decisions:perplexity/pplx-decider-v1.2 > decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 2 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:perplexity/pplx-decider-v1.2 > decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 2 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:typesafe/jev-1.14 > decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 1 | 62.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `confirm(decisions:jaredpalmer/kev-4b + decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `confirm(decisions:jaredpalmer/kev-4b + decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `confirm(decisions:perplexity/pplx-decider-v1.2 + decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `confirm(decisions:perplexity/pplx-decider-v1.2 + decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `decisions:typesafe/jev-1.14`, `decisions:jaredpalmer/kev-4b`, `decisions:openai/gpt-6-luna-decisions`, `decisions:perplexity/pplx-decider-v1.2` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:google/gemini-2.5-flash-lite`: ranked 15 of 22 on development; only the top 4 are enumerated
- `chat:openai/gpt-6-luna`: ranked 11 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef`: ranked 10 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-flash`: ranked 12 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-omni`: ranked 7 of 22 on development; only the top 4 are enumerated
- `decisions:inception/mercury-decide`: ranked 13 of 22 on development; only the top 4 are enumerated
- `decisions:liquid/d1`: ranked 18 of 22 on development; only the top 4 are enumerated
- `decisions:liquid/d1-ultra`: ranked 14 of 22 on development; only the top 4 are enumerated
- `decisions:microsoft/microsoft-decision-1`: ranked 16 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-max`: ranked 5 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v1.5`: ranked 19 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v2.0`: ranked 9 of 22 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-flash-v1.2`: ranked 22 of 22 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-v1.1-27b`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-01`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-02`: ranked 21 of 22 on development; only the top 4 are enumerated
- `decisions:scaledown/classify-1`: no successful development call (every call was an error or unsupported)
- `decisions:togethercomputer/tev1-4b-experimental`: ranked 20 of 22 on development; only the top 4 are enumerated
- `decisions:typesafe/jev-1.13`: ranked 6 of 22 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide`: ranked 17 of 22 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide-flash`: ranked 8 of 22 on development; only the top 4 are enumerated
- `heuristic`: no successful development call (every call was an error or unsupported)

## milestone-boundary

Cases: development 16, holdout 8.

- **Recommended single model:** `single(chat:google/gemini-2.5-flash-lite)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 2, accepted-exact 68.8%. Every row has too few holdout cases; the first row is provisional.
- **Recommended pipeline:** `chain(decisions:jaredpalmer/kev-4b > chat:openai/gpt-6-luna)` [insufficient-evidence] - holdout n=0: unsafe accepted 0, accepted-exact 0.0%, coverage -, - per 1,000, p95 - ms, errors/unsupported 0/0; development: unsafe accepted 1, accepted-exact 81.3%. Every row has too few holdout cases; the first row is provisional.

### Single models

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `single(chat:google/gemini-2.5-flash-lite)` | 0 | 0 | 0.0% | - | - | 2 | 68.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `single(chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 1 | 81.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `single(decisions:cloudflare/clef-flash)` | 0 | 0 | 0.0% | - | - | 2 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `single(decisions:cloudflare/clef-omni)` | 0 | 0 | 0.0% | - | - | 1 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `single(decisions:cloudflare/clef)` | 0 | 0 | 0.0% | - | - | 1 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `single(decisions:inception/mercury-decide)` | 0 | 0 | 0.0% | - | - | 5 | 62.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `single(decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `single(decisions:liquid/d1-ultra)` | 0 | 0 | 0.0% | - | - | 2 | 25.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `single(decisions:liquid/d1)` | 0 | 0 | 0.0% | - | - | 5 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `single(decisions:microsoft/microsoft-decision-1)` | 0 | 0 | 0.0% | - | - | 6 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 11 | `single(decisions:nace-ai/drex-max)` | 0 | 0 | 0.0% | - | - | 2 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 12 | `single(decisions:nace-ai/drex-v1.5)` | 0 | 0 | 0.0% | - | - | 4 | 6.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 13 | `single(decisions:nace-ai/drex-v2.0)` | 0 | 0 | 0.0% | - | - | 3 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 14 | `single(decisions:openai/gpt-6-luna-decisions)` | 0 | 0 | 0.0% | - | - | 1 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 15 | `single(decisions:perplexity/pplx-decider-flash-v1.2)` | 0 | 0 | 0.0% | - | - | 11 | 12.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 16 | `single(decisions:perplexity/pplx-decider-v1.1-27b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 17 | `single(decisions:perplexity/pplx-decider-v1.2)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 18 | `single(decisions:respan/span-01)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 19 | `single(decisions:respan/span-02)` | 0 | 0 | 0.0% | - | - | 7 | 43.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 20 | `single(decisions:scaledown/classify-1)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 21 | `single(decisions:togethercomputer/tev1-4b-experimental)` | 0 | 0 | 0.0% | - | - | 5 | 18.8% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 22 | `single(decisions:typesafe/jev-1.13)` | 0 | 0 | 0.0% | - | - | 1 | 37.5% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 23 | `single(decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 1 | 50.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 24 | `single(decisions:upstage/solar-decide-flash)` | 0 | 0 | 0.0% | - | - | 4 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 25 | `single(decisions:upstage/solar-decide)` | 0 | 0 | 0.0% | - | - | 6 | 31.3% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 26 | `single(heuristic)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 1.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

### Models in detail

| model | split | cases | abstain | invalid | first-attempt acc (95% CI) | brier | ece | p50 ms | consistency | cost sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | development | 16 | 0.0% | 18.8% | 54.6%-84.4% (n=32 answers) | 0.104 | 0.065 | 609 | - | generation 12, response 1, local 3 |
| `chat:google/gemini-2.5-flash-lite` | holdout | 0 | - | - | - | - | - | - | - |  |
| `chat:openai/gpt-6-luna` | development | 16 | 0.0% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.083 | 0.067 | 1374 | - | generation 14, response 2 |
| `chat:openai/gpt-6-luna` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef` | development | 16 | 53.1% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.156 | 0.150 | 337 | - | generation 15, response 1 |
| `decisions:cloudflare/clef` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-flash` | development | 16 | 75.0% | 0.0% | 42.3%-74.5% (n=32 answers) | 0.263 | 0.254 | 288 | - | generation 16 |
| `decisions:cloudflare/clef-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:cloudflare/clef-omni` | development | 16 | 71.9% | 0.0% | 30.9%-63.6% (n=32 answers) | 0.187 | 0.170 | 282 | - | generation 15, response 1 |
| `decisions:cloudflare/clef-omni` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:inception/mercury-decide` | development | 16 | 6.3% | 0.0% | 61.2%-89.0% (n=32 answers) | 0.144 | 0.159 | 365 | - | generation 15, response 1 |
| `decisions:inception/mercury-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | development | 16 | 90.6% | 0.0% | 39.3%-71.8% (n=32 answers) | 0.258 | 0.195 | 324 | - | generation 14, response 2 |
| `decisions:jaredpalmer/kev-4b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1` | development | 16 | 40.6% | 0.0% | 45.3%-77.1% (n=32 answers) | 0.230 | 0.173 | 253 | - | generation 14, response 2 |
| `decisions:liquid/d1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:liquid/d1-ultra` | development | 16 | 37.5% | 0.0% | 64.7%-91.1% (n=32 answers) | 0.142 | 0.083 | 229 | - | generation 15, response 1 |
| `decisions:liquid/d1-ultra` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | development | 16 | 18.8% | 0.0% | 57.9%-86.7% (n=32 answers) | 0.205 | 0.159 | 317 | - | generation 15, response 1 |
| `decisions:microsoft/microsoft-decision-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-max` | development | 16 | 25.0% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.124 | 0.153 | 354 | - | generation 15, response 1 |
| `decisions:nace-ai/drex-max` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | development | 16 | 59.4% | 0.0% | 33.6%-66.4% (n=32 answers) | 0.216 | 0.213 | 262 | - | generation 15, response 1 |
| `decisions:nace-ai/drex-v1.5` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | development | 16 | 50.0% | 6.3% | 36.4%-69.1% (n=32 answers) | 0.242 | 0.176 | 321 | - | generation 14, response 1, local 1 |
| `decisions:nace-ai/drex-v2.0` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | development | 16 | 28.1% | 0.0% | 71.9%-95.0% (n=32 answers) | 0.075 | 0.186 | 271 | - | generation 15, response 1 |
| `decisions:openai/gpt-6-luna-decisions` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | development | 16 | 18.8% | 0.0% | 36.4%-69.1% (n=32 answers) | 0.312 | 0.354 | 178 | - | generation 14, response 2 |
| `decisions:perplexity/pplx-decider-flash-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.1-27b` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 19 | - | local 16 |
| `decisions:perplexity/pplx-decider-v1.1-27b` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | development | 16 | 40.6% | 0.0% | 75.8%-96.8% (n=32 answers) | 0.106 | 0.140 | 262 | - | generation 14, response 2 |
| `decisions:perplexity/pplx-decider-v1.2` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-01` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 27 | - | local 16 |
| `decisions:respan/span-01` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:respan/span-02` | development | 16 | 9.4% | 0.0% | 51.4%-82.0% (n=32 answers) | 0.226 | 0.202 | 329 | - | generation 14, response 2 |
| `decisions:respan/span-02` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:scaledown/classify-1` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | 27 | - | local 16 |
| `decisions:scaledown/classify-1` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | development | 16 | 40.6% | 0.0% | 54.6%-84.4% (n=32 answers) | 0.213 | 0.165 | 221 | - | generation 15, response 1 |
| `decisions:togethercomputer/tev1-4b-experimental` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.13` | development | 16 | 34.4% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.124 | 0.157 | 211 | - | generation 15, response 1 |
| `decisions:typesafe/jev-1.13` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:typesafe/jev-1.14` | development | 16 | 28.1% | 0.0% | 68.2%-93.1% (n=32 answers) | 0.085 | 0.123 | 235 | - | generation 15, response 1 |
| `decisions:typesafe/jev-1.14` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide` | development | 16 | 18.8% | 0.0% | 48.3%-79.6% (n=32 answers) | 0.223 | 0.204 | 9732 | - | generation 13, response 3 |
| `decisions:upstage/solar-decide` | holdout | 0 | - | - | - | - | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | development | 16 | 78.1% | 0.0% | 33.6%-66.4% (n=32 answers) | 0.257 | 0.226 | 744 | - | generation 14, response 2 |
| `decisions:upstage/solar-decide-flash` | holdout | 0 | - | - | - | - | - | - | - |  |
| `heuristic` | development | 16 | 0.0% | 100.0% | 0.0%-10.7% (n=32 answers) | - | - | - | - | local 16 |
| `heuristic` | holdout | 0 | - | - | - | - | - | - | - |  |

### Confidence gate chosen on development

The lowest threshold in the sweep with zero unsafe accepted on development; holdout is read at that threshold, never tuned.

| model | question | gate | dev cov | dev unsafe raw | holdout cov | holdout sel-acc | holdout unsafe | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chat:google/gemini-2.5-flash-lite` | status | 0.95 | 12.5% | 1 | - | - | - |  |
| `chat:google/gemini-2.5-flash-lite` | boundary | 0.95 | 18.8% | 1 | - | - | - |  |
| `chat:openai/gpt-6-luna` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `chat:openai/gpt-6-luna` | boundary | 0.95 | 81.3% | 1 | - | - | - |  |
| `decisions:cloudflare/clef` | status | 0.50 | 81.3% | 1 | - | - | - |  |
| `decisions:cloudflare/clef` | boundary | 0.75 | 12.5% | 11 | - | - | - |  |
| `decisions:cloudflare/clef-flash` | status | 0.50 | 56.3% | 2 | - | - | - |  |
| `decisions:cloudflare/clef-flash` | boundary | 0.80 | 0.0% | 11 | - | - | - |  |
| `decisions:cloudflare/clef-omni` | status | 0.75 | 43.8% | 4 | - | - | - |  |
| `decisions:cloudflare/clef-omni` | boundary | 0.65 | 0.0% | 13 | - | - | - |  |
| `decisions:inception/mercury-decide` | status | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:inception/mercury-decide` | boundary | 0.95 | 50.0% | 4 | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | status | 0.50 | 31.3% | 4 | - | - | - |  |
| `decisions:jaredpalmer/kev-4b` | boundary | 0.55 | 6.3% | 10 | - | - | - |  |
| `decisions:liquid/d1` | status | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:liquid/d1` | boundary | 0.85 | 18.8% | 6 | - | - | - |  |
| `decisions:liquid/d1-ultra` | status | 0.90 | 43.8% | 2 | - | - | - |  |
| `decisions:liquid/d1-ultra` | boundary | 0.80 | 37.5% | 4 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | status | 0.85 | 75.0% | 2 | - | - | - |  |
| `decisions:microsoft/microsoft-decision-1` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:nace-ai/drex-max` | status | 0.85 | 68.8% | 2 | - | - | - |  |
| `decisions:nace-ai/drex-max` | boundary | 0.80 | 37.5% | 3 | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | status | 0.95 | 31.3% | 4 | - | - | - |  |
| `decisions:nace-ai/drex-v1.5` | boundary | 0.95 | 0.0% | 10 | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | status | 0.95 | 12.5% | 5 | - | - | - |  |
| `decisions:nace-ai/drex-v2.0` | boundary | 0.80 | 12.5% | 8 | - | - | - |  |
| `decisions:openai/gpt-6-luna-decisions` | status | 0.50 | 100.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:openai/gpt-6-luna-decisions` | boundary | 0.75 | 43.8% | 2 | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | status | 0.80 | 75.0% | 2 | - | - | - |  |
| `decisions:perplexity/pplx-decider-flash-v1.2` | boundary | none | - | 13 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:perplexity/pplx-decider-v1.1-27b` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.1-27b` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:perplexity/pplx-decider-v1.2` | status | 0.50 | 93.8% | 1 | - | - | - |  |
| `decisions:perplexity/pplx-decider-v1.2` | boundary | 0.70 | 37.5% | 2 | - | - | - |  |
| `decisions:respan/span-01` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-01` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:respan/span-02` | status | none | - | 4 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:respan/span-02` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:scaledown/classify-1` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:scaledown/classify-1` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `decisions:togethercomputer/tev1-4b-experimental` | status | 0.80 | 37.5% | 3 | - | - | - |  |
| `decisions:togethercomputer/tev1-4b-experimental` | boundary | 0.95 | 25.0% | 5 | - | - | - |  |
| `decisions:typesafe/jev-1.13` | status | 0.65 | 68.8% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.13` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:typesafe/jev-1.14` | status | 0.50 | 81.3% | 3 | - | - | - |  |
| `decisions:typesafe/jev-1.14` | boundary | none | - | 2 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:upstage/solar-decide` | status | 0.95 | 56.3% | 4 | - | - | - |  |
| `decisions:upstage/solar-decide` | boundary | none | - | 5 | - | - | - | no threshold up to 0.95 reaches zero unsafe accepted on development |
| `decisions:upstage/solar-decide-flash` | status | 0.80 | 6.3% | 6 | - | - | - |  |
| `decisions:upstage/solar-decide-flash` | boundary | 0.80 | 0.0% | 5 | - | - | - |  |
| `heuristic` | status | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |
| `heuristic` | boundary | 0.50 | 0.0% | 0 | - | - | - | vacuous: no unsafe development answer |

### Pipelines (top 10 of 20)

| # | candidate | n | unsafe | acc-exact | cov | sel-acc | dev unsafe | dev acc-exact | calls | err/unsup | $/1k | p95 ms | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `chain(decisions:jaredpalmer/kev-4b > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 1 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 2 | `chain(decisions:jaredpalmer/kev-4b > decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 1 | 50.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 3 | `chain(decisions:perplexity/pplx-decider-v1.2 > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 87.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 4 | `chain(decisions:perplexity/pplx-decider-v1.2 > decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 37.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 5 | `chain(decisions:perplexity/pplx-decider-v1.2 > decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 1 | 62.5% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 6 | `chain(decisions:typesafe/jev-1.14 > chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 2 | 81.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 7 | `confirm(decisions:jaredpalmer/kev-4b + chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 8 | `confirm(decisions:jaredpalmer/kev-4b + decisions:typesafe/jev-1.14)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 9 | `confirm(decisions:perplexity/pplx-decider-v1.2 + chat:openai/gpt-6-luna)` | 0 | 0 | 0.0% | - | - | 0 | 31.3% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |
| 10 | `confirm(decisions:perplexity/pplx-decider-v1.2 + decisions:jaredpalmer/kev-4b)` | 0 | 0 | 0.0% | - | - | 0 | 0.0% | 0.00 | 0/0 | - | - | insufficient (holdout n=0 < 8); 8 missing |

Enumerated over: `decisions:perplexity/pplx-decider-v1.2`, `decisions:jaredpalmer/kev-4b`, `chat:openai/gpt-6-luna`, `decisions:typesafe/jev-1.14` (top 4, chosen by the development ranking: the ranking rule applied to development metrics at the analysis gate, among models with at least the minimum cases and one successful call; holdout is never consulted). Chains and confirm-chains run the cheaper model (by development cost per 1,000) first; the reverse order is not enumerated. Replay of the shipped heuristic fallback applies to intent tasks only.

Excluded from pipeline enumeration:

- `chat:google/gemini-2.5-flash-lite`: ranked 9 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef`: ranked 7 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-flash`: ranked 12 of 22 on development; only the top 4 are enumerated
- `decisions:cloudflare/clef-omni`: ranked 8 of 22 on development; only the top 4 are enumerated
- `decisions:inception/mercury-decide`: ranked 16 of 22 on development; only the top 4 are enumerated
- `decisions:liquid/d1`: ranked 17 of 22 on development; only the top 4 are enumerated
- `decisions:liquid/d1-ultra`: ranked 11 of 22 on development; only the top 4 are enumerated
- `decisions:microsoft/microsoft-decision-1`: ranked 19 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-max`: ranked 10 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v1.5`: ranked 14 of 22 on development; only the top 4 are enumerated
- `decisions:nace-ai/drex-v2.0`: ranked 13 of 22 on development; only the top 4 are enumerated
- `decisions:openai/gpt-6-luna-decisions`: ranked 5 of 22 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-flash-v1.2`: ranked 22 of 22 on development; only the top 4 are enumerated
- `decisions:perplexity/pplx-decider-v1.1-27b`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-01`: no successful development call (every call was an error or unsupported)
- `decisions:respan/span-02`: ranked 21 of 22 on development; only the top 4 are enumerated
- `decisions:scaledown/classify-1`: no successful development call (every call was an error or unsupported)
- `decisions:togethercomputer/tev1-4b-experimental`: ranked 18 of 22 on development; only the top 4 are enumerated
- `decisions:typesafe/jev-1.13`: ranked 6 of 22 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide`: ranked 20 of 22 on development; only the top 4 are enumerated
- `decisions:upstage/solar-decide-flash`: ranked 15 of 22 on development; only the top 4 are enumerated
- `heuristic`: no successful development call (every call was an error or unsupported)

## Limitations

- Reference labels are synthetic and model-authored, not human-adjudicated; accuracy measures agreement with those labels.
- Samples are small: results with fewer than 8 holdout cases per task are marked insufficient (104 single-model rows here), Wilson intervals cover first attempts only, and repetitions add consistency evidence, not independent cases.
- Cost: "generation" is the only billing-grade source; "response" and "local" are usage priced at the catalog or free, and "unknown" costs are priced at their reserved bound. Observations by source: generation 1321, response 72, local 270, unknown 1.
- Policies replay recorded answers for the same case and repetition. Calls are assumed independent and deterministic given the record; provider outages, rate limits and caching are not modelled.
- The ranking is applied to many policies on the holdout split, so the top policy's holdout numbers are optimistic; development numbers are shown beside them and models are shortlisted on development only.
- Replay builds a fresh shipped classifier per decision, so the sticky post-failure heuristic mode of a long-lived instance is not exercised. Non-replay policies score abstention as no decision, not as the heuristic fallback.
- Latency is as recorded under benchmark conditions. Chain and confirm-chain latencies are summed; a vote's latency is the slowest member (parallel dispatch).
