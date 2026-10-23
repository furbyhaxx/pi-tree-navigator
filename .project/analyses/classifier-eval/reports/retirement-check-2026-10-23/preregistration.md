---
version: 1
id: "retirement-check-preregistration-2026-10-23"
title: "Retirement verifier spike: pre-registration"
description: "Protocol, selection rule and budget mechanics of the retirement-verifier benchmark, committed before any live call; the selected top 3 are appended before the holdout run."
type: "analysis"
created: "2026-10-23T16:37:25+02:00"
updated: "2026-10-23T16:37:25+02:00"
createdBy: "worker"
updatedBy: "worker"
---

# Pre-registration

Decision E18: a retirement proposed by the capture preset applies only when another
classifier confirms that specific item is replaced. This spike picks that verifier.

## Request and cases

- Request: `buildRetirementCheckContext` (`extensions/navigate-tree/retirement-check.ts`): state
  `{message, item, otherItems}`, one choice question `retires`, choices `yes` / `no`. Frozen at
  commit 72852aa; not tuned on development results.
- Cases: `scripts/classifier-eval/retirement-cases.ts`, one per (supersession case, active item).
  Development: 69 cases (7 positive, 60 negative, 2 ambiguous). Holdout: 152 cases (13 positive,
  134 negative, 5 ambiguous). Ambiguous items are those where the parent reference accepts both
  the item and `none`; either verdict is correct and never unsafe.
- Unsafe: the verifier answers `yes` with confidence >= 0.7 on a negative (for decision models and
  chat alike, as `scoring.ts` scores accepted answers). A missed positive is wrong but safe.

## Development screen

- Split `development`, 2 repetitions, retries 0, concurrency 4, timeout 60 s.
- Candidates: `shortlists/retirement-dev-2026-10-23.txt`: the 18 catalogued decision models the
  runner accepts plus `chat:openai/gpt-6-luna`. The brief named four uncatalogued ids to drop
  (drex-max, pplx-decider-v1.2, pplx-decider-flash-v1.2, span-02); `liquid/d1-ultra` is also absent from
  the Pi catalog and is dropped too.
- `chat:openai/gpt-6-luna` is eligible but flagged: it is the escalator the verifier would check, so
  its errors are correlated with the proposals it verifies.
- Selection rule, lexicographic, over both repetitions pooled:
  1. fewest unsafe accepted answers (zero first);
  2. highest accepted-exact rate on the positive cases;
  3. lowest cost per 1,000 decisions (recorded cost, reserved bound where unknown);
  4. lowest p95 latency;
  5. model label.
- The top 3 by this rule are the holdout verifiers. Nothing else is added or dropped afterwards.

## Holdout

- Split `holdout` (152 cases), 3 repetitions, same settings, the 3 selected verifiers only.
- Offline end-to-end simulation on holdout v3: existing observations of
  `runs/holdout-v3-2026-10-23/capture` for `decisions:microsoft/microsoft-decision-1` and
  `chat:openai/gpt-6-luna` on the 32 holdout supersession cases (3 repetitions), plus the verifier
  observation of the proposed (case, item) pair in the same repetition. Pipeline: ms answers `contradicts`;
  if it abstains (confidence < 0.7, invalid, error) luna answers; an accepted item is a proposed retirement.
  `verify escalated`: only a retirement proposed by luna is checked. `verify every`: every proposed
  retirement is checked. A retirement applies only when the verifier answers `yes` with
  confidence >= 0.7; a rejected, abstained, failed or missing check leaves the item active.
  A pair with no verifier observation is reported, never imputed.

## Budget mechanics

The shared ledger records an immutable cap of 25 USD, and the runner refuses `--cap` values other than
the recorded one. The unit's cap is enforced by a scratch copy of the ledger whose cap header is the
starting spent + held + 1.50 USD; its new events are appended to the shared ledger after each run.
Starting point (dry run, 2026-10-23 16:37): spent 0.554046879 + held 0.054682903 = 0.608729782 USD,
so the unit cap is 2.108729782 USD.
