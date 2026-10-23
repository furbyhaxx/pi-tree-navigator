---
version: 1
id: "classifier-eval-holdout-v3-label-review"
title: "Blind label review of the expanded classifier holdout (v3)"
description: "Independent blind labelling of the 96 new holdout cases (24 per task) and how disagreements were resolved."
type: "analysis"
created: "2026-10-23T15:55:18+02:00"
updated: "2026-10-23T15:55:18+02:00"
createdBy: "worker"
updatedBy: "worker"
---

# Blind label review of the expanded holdout (v3)

The holdout grew from 8 to 32 cases per task. The 24 new cases per task
(96 in total) were labelled blind by independent reviewers before the labels
were finalised. The 32 original holdout cases keep their ids, inputs and
labels (only the new `structure` field was added to the milestone ones).

## Method

- Four reviewers (`second-opinion` helper agent, one per task) each read one
  file: the exact production request of every new holdout case of their task
  (JSON state, question text, choices), with opaque ids (`A01`, `B01`, `C01`,
  `D01`). No reference labels, rationales, case ids, families or splits were
  in the file.
- The reviewers were told to open only that file, to treat case text as
  untrusted data, to commit to one best choice per question and to list
  alternatives only when clearly defensible. Every reviewer reported
  `FILES_READ` containing only its own file.
- Agreement is strict: the reviewer's best choice must be one of the
  reference's accepted choices. "Lenient" also counts a reviewer alternative.
- Review inputs were generated with `prepareCase` from the cases as authored
  (sha256 prefixes: intent `4e163e36`, supersession `e15d2547`,
  milestone-status `bb88968c`, milestone-boundary `c221bb04`). They live in
  `/tmp` and are not part of the repository; they are reproducible from
  `cases.ts` (new holdout ids = holdout ids not present at `d0be523`).

## Result, first pass (before any input change)

| Task | Cases | Fully agree | Questions agree (strict) | Lenient |
| --- | --- | --- | --- | --- |
| intent | 24 | 24 | 27 / 27 | 27 / 27 |
| supersession | 24 | 24 | 48 / 48 | 48 / 48 |
| milestone-status | 24 | 22 | 46 / 48 | 47 / 48 |
| milestone-boundary | 24 | 23 | 47 / 48 | 48 / 48 |
| total | 96 | 93 (96.9%) | 168 / 171 (98.2%) | 170 / 171 |

`status` agreed on all 48 milestone cases. Every disagreement was a
`boundary` answer. Intent and supersession included `contradicts` answers
(3 intent cases carry active items); all agreed.

## Disagreements and resolutions

Three cases did not match strictly. None was resolved by copying the reviewer
answer into the reference. Each input was changed to remove the ambiguity or
the case was kept with the ambiguity documented, then re-read blind by a
fresh reviewer that saw only the revised case.

1. `status-search-endpoint-docs-pending` (reference boundary was record 6,
   reviewer said `none`). The request listed the documentation as a second
   step after the endpoint, but also made it part of one request, so whether
   the endpoint report closes a "coherent phase" was contestable. Two
   revisions followed:
   - Explicit "step 1 / step 2" wording, once without and once with step 2
     already started: both re-checks answered `status=milestone`, because a
     finished first step followed by a separate second step fits the
     milestone criterion. That made the `continue` reference unreliable, so
     the wording was dropped.
   - The request now asks for one deliverable "including the openapi.yaml
     entry and a changelog line", and the report says it is not finished.
     Reference: `continue`, boundary `none`. Re-check: `continue`, boundary
     `none`, with two weak alternative boundaries (the passing test run and
     the report). Residual ambiguity: choosing the report record counts as
     unsafe for this case although one reviewer found it defensible. Treat
     unsafe boundaries on this one case with care.
2. `status-last-page-fix-milestone` (was `...-user-thanks`; reference record
   5, reviewer chose record 6, the user's "thanks"). Folding a plain
   acknowledgement is harmless, so labelling it past the true end overstated
   the risk. The trailing acknowledgement was removed and the case renamed.
   Re-check: `milestone`, boundary = record 5. The other trailing-user cases
   (`boundary-index-then-export-timeout`, `boundary-rollback-then-regression-diff-mixed`)
   end on a new request and agreed.
3. `boundary-vue-upgrade-then-modal-model-gsw` (was `...-then-failing-tests-gsw`;
   reference record 3, reviewer `none` with record 3 as alternative). The
   upgrade left three test files red, so the upgrade did not stand alone as a
   finished phase. The first part now ends with a green build and all 44 test
   files passing, and the second part is an independent Modal conversion.
   Re-check: `continue`, boundary = record 3.

## Genuine ambiguity that remains

- Status for "a phase finished, the next phase is already running": eight new
  boundary-task cases carry `continue` with a finished earlier phase
  (`boundary-sitemap-then-canonical-tags`, `boundary-api-alerts-two-done-de`,
  `boundary-orders-columns-then-resize-gsw`, `boundary-ios-target-then-gitignore`,
  `boundary-warehouse-sync-two-parts-done`, `boundary-index-then-export-timeout`,
  `boundary-rollback-then-regression-diff-mixed`,
  `boundary-vue-upgrade-then-modal-model-gsw`). The reviewers picked
  `continue` every time but listed `milestone` as a defensible alternative
  for all eight (seven in the first pass, the Vue case in its re-check).
  The reference follows the development-split
  convention (`config-rename-next-phase-started`, `healthz-then-probes`):
  the status question asks for the state at the end of the records, and the
  newest work is unfinished. A model answering `milestone` there is scored
  unsafe (reference `continue`), which is strict for these cases.
- `boundary-dead-endpoints-asks-about-rest`: `await-user` with `milestone`
  as an alternative (a finished removal followed by a question). Reference
  `await-user`, boundary record 5.
- `boundary-cert-issued-acm-denied`: boundary record 3 with `none` as an
  alternative.
- Multi-choice kind references that the reviewers independently reproduced:
  `intent-key-rotation-long-de` (rule, alt sub-goal),
  `intent-pr-size-en` (rule, alt steering), `intent-merged-thanks-gsw`
  (ephemeral, alt sub-goal; the reference accepts only ephemeral, the
  alternative is not unsafe), and in supersession the `steering`/`sub-goal`,
  `decision`/`rule` and `steering`/`ephemeral` pairs, plus the three
  deliberately ambiguous `contradicts` cases (`R3`/`none`, `R1`/`none`,
  `R2`/`none`), where the reviewers picked one of the accepted ids.

## Limits

- Reviewers are language models; agreement shows the labels are readable and
  consistent, not that they are correct for every reader. Reviewer and
  reference were never compared before the reviewers answered.
- The three revised cases were re-read once each (the search case twice
  before its final wording), by one reviewer each.
- The reviewers could have opened other files; their own reports list only
  their input file.
