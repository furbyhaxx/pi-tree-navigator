---
title: "OpenRouter decision/classifier models"
question: "Which classifiers merit a benchmark?"
created: "2026-10-23"
updated: "2026-10-23"
status: "final"
confidence: "high"
version: 1
id: "2026-10-23-openrouter-decision-models"
description: "Rankings, classifier API, candidate inventory and cost bounds."
type: "research"
createdBy: "researcher"
updatedBy: "researcher"
---

# OpenRouter decision/classifier models

## TL;DR
- **Popularity, not accuracy:** 22 Oct requests: Jev 1.13 942M, Jev 1.14 338M, Perplexity Decider V1.2 57.8M. Author share is latest full week; category spend is sample-corrected over 30 days using sampled task labels. [1][2]
- `/api/alpha/decisions` accepts one state plus named `noul`, `choice`, ordinal `score`, or image `box` questions. One request supports multiple questions; no text-span output. The documented Jev example returns 476 input, 70 output tokens and `usage.cost=0.000019992` for three questions; raw `usage.cost` is optional. [3]
- Test shortlist: `respan/span-02` (behavior scoring; 131k; $0.01/M input), `scaledown/classify-1` (1M; $0.04/M), `typesafe/jev-1.14` (262k; $0.042/M), `perplexity/pplx-decider-flash-v1.2` (262k; $0.01/M). Full 30 IDs, routes and full-context reserves: adjacent CSVs. Exact excerpts/turn indexes need application extraction or schema-constrained chat (`google/gemini-2.5-flash-lite`, `openai/gpt-6-luna`); narrative handoff remains separate. [4][5]
- **Billing:** generation lookup documents `api_type=decisions` and `total_cost` USD; preserve raw `usage.cost` when present, then audit by generation ID. `/api/v1/key` gives aggregate usage/remaining. Do not substitute catalog-derived cost. [3][6]
- **Bound:** no `pricing.request` rate was listed; completion prices are $0/M. Reserve full route context at the highest eligible prompt rate, including question/provider framing. Maximum token charge: `1,050,000 × $0.10/M = $0.105` (`openai/gpt-6-luna-decisions`). `provider.max_price` filters prompt/completion $/M and request $/call, not total spend; keep a $25 key/ledger cap. Standard adds 5.5% at credit purchase. [4][6]
- All decision-route latency/throughput fields were null. Benchmark exact spans, authority/supersession, milestones, unsafe-fold errors, abstention, cost and latency. Classifier-to-escalation is a hypothesis, not a proven gain. [4]

## Caveats
No published question/body limit. Reserve context, not characters, assuming it includes the full upstream prompt; key cap is the hard stop. Context `0`/unrouted aliases have unknown bounds. models.dev had no Jev or `*decid*` matches; absence is unknown. [3][7]

## Sources (accessed 2026-10-23)
[1] https://openrouter.ai/rankings/decisions.
[2] https://openrouter.ai/docs/cookbook/administration/data-api.
[3] https://openrouter.ai/openapi.json and https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md.
[4] https://openrouter.ai/api/v1/models?output_modalities=decisions; https://openrouter.ai/api/v1/models/{id}/endpoints (snapshot).
[5] https://openrouter.ai/docs/features/structured-outputs.
[6] https://openrouter.ai/pricing; https://openrouter.ai/docs/api-reference/limits; https://openrouter.ai/docs/guides/routing/provider-selection.
[7] https://models.dev/api.json and https://models.dev/models.json.

BLOCKERS: none.
