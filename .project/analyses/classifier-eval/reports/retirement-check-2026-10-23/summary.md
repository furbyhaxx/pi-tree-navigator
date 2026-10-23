---
version: 1
id: "retirement-check-2026-10-23"
title: "Retirement verifier spike for the capture preset (E18)"
description: "Pre-registered live screen of 19 candidate verifiers on retirement cases, holdout run of the top 3, and an offline end-to-end simulation of chain(microsoft > luna) with a verifier."
type: "analysis"
created: "2026-10-23T17:08:03+02:00"
updated: "2026-10-23T17:08:03+02:00"
createdBy: "worker"
updatedBy: "worker"
---

# Retirement verifier spike (E18)

Protocol and selection rule: `preregistration.md` (committed in 68c42ed, top 3 recorded in a1114ca/d0d66d1,
both before the holdout run). Nothing here is wired into the shipped preset.

## Request and cases

- `buildRetirementCheckContext` (`extensions/navigate-tree/retirement-check.ts`): state `{message, item, otherItems}`,
  one choice question `retires` with `yes` / `no`: does the message explicitly replace or reverse that one item,
  not merely relate to it, refine it, add an exception or change another item. Tested through the production
  `classifierAsk` and `chatAsk` of `intent-policy.ts` with stub registries. `retirementConfirmed(answers, 0.7)` is the
  single definition of a confirmation.
- `scripts/classifier-eval/retirement-cases.ts`: 221 cases, one per (supersession case, active item), split and
  family inherited. Development 69 (7 positive, 60 negative, 2 ambiguous); holdout 152 (13 positive, 134 negative,
  5 ambiguous). Ambiguous means the parent reference accepts both the item and `none`. Run with
  `run.ts --cases scripts/classifier-eval/retirement-cases.ts --tasks retirement-check`; the existing runner, billing
  and ledger apply unchanged. `retirement-cases.test.ts` checks derivation, labels, split/family, and that no label,
  case id or reference text reaches a request.
- Unsafe: the verifier answers `yes` with confidence >= 0.7 on a negative. A missed positive is wrong but safe.

## Development screen (2 repetitions, 69 cases, selection rule applied)

`runs/retirement-check-2026-10-23/dev`: 2,415 live calls. Selected rows are the top 3.

| rank | model | unsafe / negatives | positives accepted-exact | negatives accepted-exact | ambiguous yes | errors / decisions | $/1k | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (selected) | `decisions:liquid/d1` | 0 / 120 | 14 / 14 (100.0%) | 118 / 120 | 2 / 4 | 0 / 138 | 0.0069 | 635 |
| 2 (selected) | `decisions:microsoft/microsoft-decision-1` | 0 / 120 | 14 / 14 (100.0%) | 120 / 120 | 2 / 4 | 0 / 138 | 0.0115 | 730 |
| 3 (selected) | `decisions:typesafe/jev-1.13` | 0 / 120 | 14 / 14 (100.0%) | 120 / 120 | 0 / 4 | 0 / 138 | 0.0263 | 286 |
| 4 | `decisions:typesafe/jev-1.14` | 0 / 120 | 14 / 14 (100.0%) | 120 / 120 | 0 / 4 | 0 / 138 | 0.0263 | 294 |
| 5 | `decisions:upstage/solar-decide` | 0 / 120 | 14 / 14 (100.0%) | 81 / 120 | 0 / 4 | 0 / 138 | 0.0292 | 9630 |
| 6 | `decisions:cloudflare/clef-omni` | 0 / 120 | 14 / 14 (100.0%) | 58 / 120 | 0 / 4 | 0 / 138 | 0.0554 | 591 |
| 7 | `decisions:openai/gpt-6-luna-decisions` | 0 / 120 | 12 / 14 (85.7%) | 88 / 120 | 0 / 4 | 0 / 138 | 0.0354 | 388 |
| 8 | `decisions:cloudflare/clef` | 0 / 120 | 12 / 14 (85.7%) | 100 / 120 | 0 / 4 | 0 / 138 | 0.0886 | 1023 |
| 9 | `decisions:nace-ai/drex-v1.5` | 0 / 120 | 10 / 14 (71.4%) | 102 / 120 | 2 / 4 | 0 / 138 | 0.0111 | 841 |
| 10 | `decisions:nace-ai/drex-v2.0` | 0 / 120 | 10 / 14 (71.4%) | 99 / 120 | 1 / 4 | 14 / 138 | 0.0150 | 943 |
| 11 | `decisions:perplexity/pplx-decider-v1.1-27b` | 0 / 60 | 0 / 7 (0.0%) | 0 / 60 | 0 / 2 | 69 / 69 | 0.0000 | 27 |
| 12 | `decisions:respan/span-01` | 0 / 60 | 0 / 7 (0.0%) | 0 / 60 | 0 / 2 | 69 / 69 | 0.0000 | 48 |
| 13 | `decisions:scaledown/classify-1` | 0 / 60 | 0 / 7 (0.0%) | 0 / 60 | 0 / 2 | 69 / 69 | 0.0000 | 628 |
| 14 | `decisions:upstage/solar-decide-flash` | 0 / 120 | 0 / 14 (0.0%) | 2 / 120 | 0 / 4 | 0 / 138 | 0.0292 | 1197 |
| 15 | `decisions:inception/mercury-decide` | 2 / 120 | 14 / 14 (100.0%) | 118 / 120 | 2 / 4 | 0 / 138 | 0.0065 | 455 |
| 16 | `chat:openai/gpt-6-luna` | 2 / 120 | 13 / 14 (92.9%) | 100 / 120 | 4 / 4 | 19 / 138 | 1.5774 | 1761 |
| 17 | `decisions:cloudflare/clef-flash` | 2 / 120 | 12 / 14 (85.7%) | 18 / 120 | 0 / 4 | 0 / 138 | 0.0140 | 680 |
| 18 | `decisions:jaredpalmer/kev-4b` | 4 / 120 | 10 / 14 (71.4%) | 54 / 120 | 0 / 4 | 0 / 138 | 0.0116 | 1219 |
| 19 | `decisions:togethercomputer/tev1-4b-experimental` | 8 / 120 | 14 / 14 (100.0%) | 80 / 120 | 2 / 4 | 0 / 138 | 0.0139 | 261 |

`pplx-decider-v1.1-27b` (404), `respan/span-01` and `scaledown/classify-1` (400, state shape) failed every call, as
`respan/span-01` and `pplx-decider-v1.1-27b` did in the earlier dev screen; they ran one repetition.
`gpt-6-luna` chat lost 19 of 138 calls in the first seconds of its session (`Request timed out` / `Connection error`,
about 1 s each, no retry per the runner contract); the reserved bound of those calls inflates its cost column.
`drex-v2.0` lost 14 calls to HTTP 429. `gpt-6-luna` chat (flagged: correlated with the escalator) and
`mercury-decide`, `clef-flash`, `kev-4b`, `tev1-4b` each accepted `yes` on at least one negative.

## Holdout: the 3 selected verifiers (3 repetitions, 152 cases)

`runs/retirement-check-2026-10-23/holdout`: 1,368 live calls, 0 errors.

| rank | model | unsafe / negatives | positives accepted-exact | negatives accepted-exact | ambiguous yes | errors / decisions | $/1k | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (selected) | `decisions:microsoft/microsoft-decision-1` | 0 / 402 | 39 / 39 (100.0%) | 402 / 402 | 0 / 15 | 0 / 456 | 0.0120 | 397 |
| 2 (selected) | `decisions:liquid/d1` | 0 / 402 | 35 / 39 (89.7%) | 398 / 402 | 0 / 15 | 0 / 456 | 0.0073 | 316 |
| 3 (selected) | `decisions:typesafe/jev-1.13` | 0 / 402 | 35 / 39 (89.7%) | 402 / 402 | 0 / 15 | 0 / 456 | 0.0270 | 309 |

No verifier answered `yes` on any of the 402 holdout negatives at any confidence (development: only `liquid/d1`,
once, at 0.19). Lowest `yes` confidence on a positive: `microsoft` 0.73, `d1` 0.60, `jev-1.13` 0.08 (its four
misses; one was a `no` at 0.20), so the 0.7 gate is close to the `microsoft` positives.

## End-to-end simulation on holdout v3

Inputs: `runs/holdout-v3-2026-10-23/capture` observations of `decisions:microsoft/microsoft-decision-1` and
`chat:openai/gpt-6-luna` on the 32 holdout supersession cases (96 decisions), and the verifier observation of the
proposed (case, item) pair in the same repetition. Replay follows the holdout-v3 `chain(ms > luna)` policy (a question
goes to luna when microsoft does not accept it; a decision is accepted-exact when both `kind` and `contradicts` are
accepted and correct), so the no-verification row reproduces the published 92.7% and 1 unsafe. The shipped preset
never escalates `kind`; that does not affect the verifier rows. A retirement applies only on `yes` >= 0.7; a `no`,
low-confidence `yes`, failed or missing check keeps the item. `escalated` checks the retirements whose answer came from
luna; `every` checks all. Columns: `accepted-exact` counts a rejected proposal as withheld (the table's convention
for abstentions); `if a rejection keeps the item` counts it as an accepted `none`, which is what the ledger
actually does. `unsafe stopped` are rejected wrong retirements, `positives blocked` rejected true replacements,
`ambiguous rejected` rejected items the reference accepts either way. Added latency is p95 over checked decisions;
`p95 total` is over all 96. 0 proposed pairs lacked a verifier observation, 0 checks failed.

| verifier | variant | accepted-exact | if a rejection keeps the item | unsafe | checked (confirmed / rejected / failed) | unsafe stopped | positives blocked | ambiguous rejected | p95 added ms | p95 total ms | $/1k | added $/1k | missing pairs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `decisions:liquid/d1` | no verification | 92.7% (89/96) | 92.7% (89/96) | 1 | 0 (0 / 0 / 0) | 0 | 0 | 0 | - | 3933 | 0.0418 | 0.0000 | 0 |
| `decisions:liquid/d1` | verify escalated only | 89.6% (86/96) | 93.8% (90/96) | 0 | 4 (0 / 4 / 0) | 1 | 0 | 3 | 214 | 3933 | 0.0421 | 0.0003 | 0 |
| `decisions:liquid/d1` | verify every retirement | 79.2% (76/96) | 89.6% (86/96) | 0 | 49 (32 / 17 / 0) | 1 | 4 | 12 | 316 | 4143 | 0.0454 | 0.0037 | 0 |
| `decisions:microsoft/microsoft-decision-1` | no verification | 92.7% (89/96) | 92.7% (89/96) | 1 | 0 (0 / 0 / 0) | 0 | 0 | 0 | - | 3933 | 0.0418 | 0.0000 | 0 |
| `decisions:microsoft/microsoft-decision-1` | verify escalated only | 89.6% (86/96) | 93.8% (90/96) | 0 | 4 (0 / 4 / 0) | 1 | 0 | 3 | 341 | 3933 | 0.0423 | 0.0005 | 0 |
| `decisions:microsoft/microsoft-decision-1` | verify every retirement | 83.3% (80/96) | 93.8% (90/96) | 0 | 49 (36 / 13 / 0) | 1 | 0 | 12 | 375 | 4204 | 0.0479 | 0.0061 | 0 |
| `decisions:typesafe/jev-1.13` | no verification | 92.7% (89/96) | 92.7% (89/96) | 1 | 0 (0 / 0 / 0) | 0 | 0 | 0 | - | 3933 | 0.0418 | 0.0000 | 0 |
| `decisions:typesafe/jev-1.13` | verify escalated only | 89.6% (86/96) | 93.8% (90/96) | 0 | 4 (0 / 4 / 0) | 1 | 0 | 3 | 418 | 3933 | 0.0429 | 0.0011 | 0 |
| `decisions:typesafe/jev-1.13` | verify every retirement | 79.2% (76/96) | 89.6% (86/96) | 0 | 49 (32 / 17 / 0) | 1 | 4 | 12 | 285 | 4163 | 0.0555 | 0.0137 | 0 |

Of the 49 proposed retirements, 45 came from microsoft (0 unsafe) and 4 from luna: one unsafe (`G4` on
`supersession-ml-musing-en`, repetition 2) and three on `supersession-ml-ambiguous-smoke-en` (`R2`, reference `R2` or
`none`). All three verifiers rejected all four.

## Recommendation

Use `decisions:microsoft/microsoft-decision-1` as the verifier, asking only about retirements proposed by the luna
escalation (E18 as worded), at gate 0.7, failing closed: `no`, abstention or error keeps the item.

- Safety: 0 `yes` on 402 holdout negatives and 120 development negatives (95% upper bound 0.75% on the holdout
  negatives alone, rule of three). In the replay it stops the one unsafe retirement of the preset (unsafe 1 to 0, all three verifiers do).
- Quality: it accepted `yes` on 39 of 39 holdout positives and 14 of 14 development positives, so it blocks no true
  replacement in either mode. With the rejection kept as `none`, accepted-exact is 93.8% against 92.7%.
- Cost: 0.0005 USD per 1,000 decisions and +341 ms p95 on the 4 of 96 decisions that are checked. It is already the
  preset's first-stage model, so no new model or credential is needed. For luna's proposals it is a different model
  than the proposer.
- `verify every retirement` is not supported: the 45 microsoft proposals held no unsafe answer, it costs 0.0061 USD
  per 1,000 and +375 ms on 51% of decisions, and with `d1` or `jev-1.13` it blocks 4 true replacements. With
  microsoft it rejects 12 ambiguous items only.
- Alternative when an independent family is wanted: `typesafe/jev-1.13` (0 unsafe of 402, +0.0011 USD per 1,000
  escalated-only, p95 added 418 ms); it accepted `yes` on 35 of 39 positives. `liquid/d1` is the cheapest
  (0.0073 USD per 1,000) with the same 35 of 39.

## Gaps and risks

- One wrong retirement in 96 decisions (one case, one repetition) is the only unsafe event the replay can remove,
  and luna proposed a retirement in only 4 of the 96 decisions (2 distinct cases). The verifier's safety rests on the
  402 holdout and 120 development negative decisions, not on the replay.
- Cases are synthetic and come from the same 48 supersession cases that qualified the preset; positives are scarce
  (13 holdout items). Ambiguous items are scored neutral by construction.
- The request wording and `otherItems` were frozen before the screen (no A/B). Verifiers saw the other active items.
- `microsoft` is also the proposer for 45 of 49 proposals; independence matters only in `verify every` mode.
- The runner's chat adapter prompt is a copy of `chatAsk`'s (existing `parity.ts` covers that); this spike did not
  rerun parity. The production builder path is covered by stub tests, not by a live call.
- Key-usage deltas in `run.json` include other workers' spend on the shared OpenRouter key (one holdout session shows
  1.29 USD against 0.02 USD of ledger spend), so they cannot reconcile this unit; the ledger settles from per-generation
  billing.
- `liquid/d1-ultra` is also not in the Pi catalog and was dropped with the four ids named in the brief.

## Budget

Unit allowance 1.50 USD. The shared ledger records an immutable 25 USD cap and the runner rejects any other `--cap`, so
every session ran against a scratch copy of the ledger whose cap header was starting spent + held + 1.50 =
0.608729782 + 1.50 = 2.108729782 USD, after a `--dry-run` against the same scratch (each said `OK`; the summed
reservations are worst-case bounds far above actual cost, 0.77 USD for one repetition of `gpt-6-luna`, so models ran in
groups whose summed reservation fit the remaining allowance). The new events were appended to the shared ledger after each session; it replays with cap 25.

Added by this unit: 3,783 reservations, 0.0800 USD spent, 0.2114 USD held for the 19 timed-out `gpt-6-luna` calls
(unknown outcome), 0.2913 USD in total. Ledger after: 0.634000277 spent + 0.266077903 held, 24.0999 USD remaining of 25.

## Reproduce

    node scripts/classifier-eval/retirement-report.ts screen --run .project/analyses/classifier-eval/runs/retirement-check-2026-10-23/dev --top 3
    node scripts/classifier-eval/retirement-report.ts simulate \
      --capture .project/analyses/classifier-eval/runs/holdout-v3-2026-10-23/capture \
      --verifier-run .project/analyses/classifier-eval/runs/retirement-check-2026-10-23/holdout --split holdout
