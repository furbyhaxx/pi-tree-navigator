---
version: 1
id: "classifier-marker-fallback-recheck-2026-10-23"
title: "Two-call live marker fallback recheck"
description: "Default-threshold production classifier preserves a goal marker and a rule excerpt after observed low-confidence kind answers."
type: "analysis"
created: "2026-10-23T11:33:53+02:00"
updated: "2026-10-23T11:33:53+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Two-call live marker fallback recheck

status: "qa-complete"
confidence: "high"

## Reproduction

From `/mnt/Projects/furbyhaxx/pi-tree-navigator`:

```sh
node .project/analyses/live-acceptance/classifier/recheck/recheck.mjs > .project/analyses/live-acceptance/classifier/recheck/run.log 2>&1
```

Exit **0**. `ModelRuntime.create` used the specified existing auth/models paths without reading credential contents into the script; its optional model cache was isolated in the evidence directory. `new ModelRegistry(runtime)` and `getAvailableOfType('classifier')` rediscovered `openrouter/typesafe/jev-1.14`. No substitute model was selected.

## Contract checks

**12/12 passed**, exactly two provider requests, both HTTP 200 / `stop`, at unchanged `DEFAULT_MIN_CONFIDENCE=0.7`.

- **Explicit goal:** 359 characters, three paragraphs. Provider chose `sub-goal`, confidence **0.50**. Production returned `by: heuristic`, `kind: objective`; reducer stored the entire original message verbatim as protected text and quote.
- **Long mixed instructions:** 1319 characters, explicit `From now on` rule plus investigation requests and pasted logs. Provider chose `rule`, confidence **0.51**. Production returned an ephemeral whole-message verdict with one heuristic rule excerpt; reducer stored that sentence exactly, protected.
- Both contradiction answers were `none`, confidence **1**. No fabricated supersession: both captures emitted only `add`, and the unrelated existing user rule stayed byte-for-byte unchanged. No warnings or reducer rejections.

Thus the new abstention fallback was exercised live in **both** cases. No threshold changes, retries or repeated calls sought these outcomes.

## Evidence

`run-2026-10-23T09-31-58.823Z/` contains fixtures, unmodified request/response body files, logical contexts/results, capture ops, reduced ledgers and assertions. The timestamped directory name is UTC; local start was **11:31:58 Europe/Zurich**.

The public `classify(..., { fetch })` transport option records actual serialized request bodies and raw response bytes, then delegates to the real fetch. No authorization, cookie or other headers are inspected or saved. A separate offline check confirmed **2/2** wire bodies exactly match the saved logical state/questions/answers.

Production `continuity-capture.ts` SHA-256:

```text
2ef0317aa033f0348ef2bf5be926e359af482e885a516165ca644859fb71c2e2
```

Served model: `typesafe/jev-1.14-20261014`.

## Research interpretation and gaps

The preserved original 55/61 exploratory result is unchanged. Its low-confidence expectations do not justify lowering 0.7; the original supersession fixture also chose PostgreSQL twice and exposed only a truncated old item. The corrected parent report withdraws the earlier defect claims and threshold recommendations.

This batch does not test malformed answers, confident-result non-regression, store replay, actual database-choice reversal, fold reconciliation, current UI or integration timeouts. No inference that uncaptured text disappears from all later briefings is supported.

No product/config/credential changes or git commands were made during this recheck. No processes were left running.

BLOCKERS: none.
