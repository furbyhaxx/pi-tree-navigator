---
version: 2
id: "live-acceptance-classifier-2026-10-23"
title: "Live continuity classification: exploratory results and marker-fallback recheck"
description: "Corrected interpretation of the preserved exploratory batch and two additional real-provider calls against the updated classifier."
type: "analysis"
created: "2026-10-23T10:57:01+02:00"
updated: "2026-10-23T11:32:26+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Live continuity classification

status: "qa-complete"
confidence: "high"

## Summary

The retained initial batch reports **55/61 exploratory checks passed**, with 12 captured HTTP 200 responses. Those six failed expectations do **not** establish confidence-threshold defects. Per coordinator/independent review, low-confidence marker-free objective and supersession abstention are intended behavior. The previous recommendations to lower 0.7 are withdrawn.

The updated production classifier preserves deterministic markers/excerpts when its kind answer abstains, without changing confident results or supersession thresholds. A new two-call batch at the default **0.7** exercised that fallback live in both cases: a 359-character explicit goal and a 1319-character mixed instruction. **12/12 contract checks passed**, including verbatim protected capture and no fabricated supersession.

## Preserved initial evidence

Command originally used:

```sh
node .project/analyses/live-acceptance/classifier/verify-classifier-live.ts
```

Do not rerun this original script to verify the new behavior: it contains exploratory expectations and overwrites its evidence file. The new script creates exclusive per-run directories instead.

- `evidence.json`: retained unchanged; 12 logical calls and 12 raw request/response body pairs. Request authorization values were redacted in that original artifact.
- `verify-classifier-live.ts`: retained unchanged, including its original assertions and fixture shortcomings.
- Original output: `checks: 55/61 passed, 6 failed`.
- Registry discovery reported 30 available classifier routes, including `openrouter/typesafe/jev-1.14`. The script exercised that route explicitly; availability does not mean it was enabled in navigator configuration.
- Node v26.11.1; installed Pi packages 1.3.0.

SHA-256, checked before and after the recheck:

```text
4f3894a79b9f6240c0ba070931fb666ac9af44dde0a0c0376ac0c58bb5198e1e  evidence.json
03601460f46c7064ef7833962fc28bbffeeeedf859833b9cb230ad4e57073421  verify-classifier-live.ts
```

### Research observations, not contract failures

| Initial observation | Corrected interpretation |
|---|---|
| Marker-free objective: model chose objective with confidence 0.40; capture emitted no op | Expected abstention below 0.7, not evidence that the threshold is defective. |
| Decision comparison: `contradicts.choice=D1`, confidence 0.22 in the retained default-threshold response; capture emitted `add` | Expected supersession abstention. The older decision shown to the model was capped to 200 characters before its decisive clause. |
| Diagnostic minConfidence 0.3 captured more | Changing a gate changes output; it does not demonstrate those extra captures are correct or justify lowering the production threshold. |
| Long mixed message classified as rule, with 500-character text and 400-character quote | Documented bounded verbatim heads, not complete preservation of every instruction in a long message. |

**Additional fixture correction:** both original supersession messages actually choose PostgreSQL. The second changes only the introductory paragraph. The original report's SQLite-to-PostgreSQL description and claim of two contradictory active choices were incorrect. This fixture does not prove explicit database-choice reversal. Its expected supersession assertions are exploratory and invalid as a mandatory contract.

The initial batch did verify rule, decision, scoped steering, ephemeral rejection, bounded verbatim capture, and reducer protection checks. It did not prove every later briefing loses an uncaptured instruction. Fold reconciliation and current-ledger UI can rescue information; those paths were not exercised here.

## Updated production behavior

`extensions/navigate-tree/continuity-capture.ts:335-374` now separates kind abstention from confident ephemeral results and invokes `heuristicClassifier` on abstention. The heuristic can preserve an explicit objective marker or rule/decision excerpts and cannot invent supersession. `DEFAULT_MIN_CONFIDENCE` remains 0.7; the contradiction gate remains unchanged.

No product changes were made by this recheck. The coordinator supplied the implementation; verification imported that production file directly.

## New contract recheck

```sh
node .project/analyses/live-acceptance/classifier/recheck/recheck.mjs > .project/analyses/live-acceptance/classifier/recheck/run.log 2>&1
```

Exit status: **0**. Route: `openrouter/typesafe/jev-1.14`, rediscovered with `getAvailableOfType('classifier')`. Two requests only; no alternate routes, threshold changes, retries, or repeat calls to obtain desired confidence.

| Case | Provider result | Production capture | Contract |
|---|---|---|---|
| Explicit goal, 359 characters, three paragraphs | `sub-goal`, confidence 0.50 | `by: heuristic`, `objective`; full original text/quote protected | pass |
| Mixed rule, 1319 characters, instructions plus pasted trace | `rule`, confidence 0.51 | `by: heuristic`, ephemeral whole message plus one explicit rule excerpt; exact sentence protected | pass |

Both calls returned HTTP 200 / `stop`. Both retained the unrelated active user rule unchanged, emitted only `add`, and produced no supersession or warning. The reducer rejected no operations. Live abstention fallback was observed in **both** cases.

New evidence: `recheck/run-2026-10-23T09-31-58.823Z/`; filenames use UTC to prevent collisions. This run began at 11:31:58 Europe/Zurich. Request and response body files preserve the actual transmitted/received content; no headers were collected. `ModelRegistry.classify` receives a public `fetch` option that records bodies and delegates to the original fetch. Logical contexts, normalized responses, verdicts, ops and reduced ledgers are separately retained. This is transport-body evidence, not merely logical input/output.

## Gaps and follow-ups

- Two samples establish these executions, not a classifier-quality distribution. No recommendations to lower confidence thresholds follow from them.
- Malformed-kind fallback and confident-result non-regression were not exercised by the new live calls; both observed answers were low-confidence valid choices.
- The initial fixture did not verify actual SQLite-to-PostgreSQL reversal. No additional reversal calls were made because this recheck was restricted to two marker cases.
- Store/session-file replay, interactive current UI, fold reconciliation, and the 15-second integration timeout remain outside this recheck. Reducer checks do not prove store replay.
- The initial investigation used read-only git status/log commands despite the no-git brief. No git commands were run during this recheck; no git state was modified.
- The brief's no-git requirement overrides repository guidance to pull/integrate. The explicit auth/models paths override generic skill advice to derive the agent directory.

BLOCKERS: none.
