---
version: 1
id: "fold-reasoning-budget"
title: "Chunked fold summaries fail on reasoning models"
description: "Root cause and live A/B of the 'map call ended with stop reason length' fold failure that blocked sessions at the context window."
type: "analysis"
created: "2026-10-24T00:26:40+02:00"
updated: "2026-10-24T00:26:40+02:00"
createdBy: "agent"
updatedBy: "agent"
---

# Chunked fold summaries fail on reasoning models

## Symptom

Sessions near the window were refused before generation, and manual folds failed
at the summary stage:

```text
invalid-summary: map call 1/1 ended with stop reason "length" and incomplete notes
```

Observed on `claude/claude-opus-5-5` at medium thinking (pi-me session, 422-425k of
425k; agentd-ts manual fold, `map call 1/2`).

## Root cause

`fold-summarizer.ts` sent answer-sized response ceilings (map 3,000, reduce 8,000).
pi-ai adds a thinking budget on top only for budget-based Anthropic models. Adaptive
Anthropic models (`forceAdaptiveThinking`) and OpenAI reasoning models count reasoning
against the same ceiling as the answer. A `length` stop on any map call ended the whole
fold, and recovery then refused the main request.

Models also exceed the requested note size (1,549 output tokens against a 1,000-token
request below), so an answer-sized ceiling was fragile even without reasoning.

## Fix (`10bdbfa`)

- Every side call gets `answer + reasoningAllowance(thinking)`; planning and the
  in-context admission reserve it. Allowances: minimal 1,024, low 4,096, medium 8,192,
  high 16,384, xhigh/max 32,768.
- A `length` stop is retried once with reasoning off and `max(answer + allowance,
  2 x answer)`, within `maxCalls`. Persistent `length` still fails with an explicit detail.
- The fold plan's in-context prediction uses the same ceiling.

## Live evidence (synthetic corpus, `openrouter/anthropic/claude-opus-5.5`)

The failing provider route is extension-registered and unavailable to a bare runtime;
the OpenRouter route is the same model family with the same adaptive-thinking flag.
Private sessions were not sent.

| run | ceiling | result |
|---|---|---|
| old, medium, 20 blocks, default caps | 3,000 | passed (509 reasoning tokens; corpus too regular to pressure the cap) |
| old, medium, 10 blocks, map 1,000 | 1,000 | `length`, exact production error string |
| new, medium, 10 blocks, map 1,000 | 9,192 | map `stop` (1,549 out), reduce `stop`, summary ok |
| new, off, 10 blocks, map 1,000 | 1,000 then 2,000 | `length`, reasoning-off retry `stop`, reduce `stop`, summary ok |

Raw calls: `live/*/calls.jsonl`. Spend went through the shared ledger; costs shown in
`calls.jsonl` are catalog-computed estimates.

## Open

- Live proof on the extension-registered `claude` provider is the user's own retry
  after `/reload`.
- Processes that never reloaded still run the pre-engine guard, which refuses without
  attempting a fold.
