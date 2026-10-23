---
version: 2
id: "full-window-recovery"
title: "Pre-flight guard refusal at the 372k window: fold prompt stranded, no withholding"
description: "Why /anchor fold appended its prompt and then aborted three times at estimated input 370939/371406/372133 against a 372000 operating window, why nothing was withheld, and why the hint reported 87.1%/48.1k free while the newest anchor showed 91.1%. Separates verified facts from inference."
type: "analysis"
created: "2026-10-23T12:16:52+02:00"
updated: "2026-10-23T12:19:25+02:00"
createdBy: "analyst"
updatedBy: "analyst"
---
# Pre-flight guard refusal at the 372k window

status: "root-caused"
confidence: "medium"

Mechanism verified from source and persisted receipts; exact provider
feasibility of the refused requests is unverified.

## Summary

Verified: the fold was requested as a normal user turn, persisted
(`8d3ec5f3`), and never reached a model turn. Three requests in a row were
aborted by the pre-flight guard `context_with_system` (`index.ts:4455-4472`)
with receipts `{reason: "insufficient request headroom", inputEstimate:
370939/371406/372133, contextWindow: 372000, appliedWithheld: 0}`, the failed
turns were hidden (`index.ts:3539-3557`), and no withholding path was entered.
Also verified: the three numbers shown to the user (hint 87.1%, extension
estimate 84.0%, newest anchor 91.1%) come from three incompatible estimators
and baselines.

Inference, strongly indicated but unverified: the guard's headline number is
about 20% above the real request size, because `estimateRequestTokens`
(`context-tokens.ts:70-87`) multiplies a whole-content 4-char scan by 8/7. The
last delivered request on this branch carried a recorded prompt of 307,702
tokens; that is *not* the refused requests' input and no request-body capture
exists. Whether the refused requests would have been accepted by the provider
depends on the adapter's output reservation, which is unavailable offline.

## Title note

The operating window changed from 425,000 to 372,000 at 2026-10-23 11:09:54
CEST (`model_change` `2b5f1563` to `openai/gpt-6-astra`, whose user override in
`~/.pi/agent/models.json` sets `contextWindow = 372000`; catalog default
272,000). That is a contributing condition, not the identified cause: the
refusal is produced by the estimator/guard geometry below.

## Reproduction (offline, read-only)

Environment: repo `/mnt/Projects/furbyhaxx/pi-tree-navigator` at `229afe0`;
installed extension copy `~/.pi/agent/git/github.com/furbyhaxx/pi-tree-navigator`
byte-identical for `context-tokens.ts`, `index.ts`, `rewind-hint.ts`
(sha256 `d4e0fc72…`, `8156e606…`, `26a39e0b…`); Node v26.11.1.

```
node .project/analyses/full-window-recovery/branch-estimates.ts "$SESSION" \
  dd70a166 2252f711 6d83d656
```

The script lives inside the repo, so it resolves the repo's `node_modules`
without any link. It reads the session with `parseSessionEntries` +
`buildSessionProjection` + `projectHandoffs` and the extension's own estimators,
prints aggregate counts/estimates only (no prompt or tool-result text), and
never constructs a `SessionManager`.

Session integrity at read time: sha256 `3bad2eed…f833`, 14,382,219 bytes,
mtime 2026-10-23 11:48:56+02:00, last entry `4068dcb1` at
2026-10-23T09:48:56.558Z — file end and mtime agree; no evidence of concurrent
modification. Re-checked after the analysis: identical hash, size and mtime.

## Persisted sequence (IDs and types only)

`8afb00ed` assistant(toolUse, recorded prompt 307,702) → `dd70a166` toolResult
(14,884 chars) → `bfebe242` assistant(error, aborted) → `977df139`
context_edit → **`7f588868` navigate-tree-rewind failed, 370,939** →
`c44be9c4` custom → `cad5ed52` subagent-notification → `c182d5c1`
assistant(error) → `bceef70c` context_edit → **`b4bbb8e1` failed, 371,406** →
`8d3ec5f3` **user fold prompt (283 chars, fold anchor `s4-g3-g6-merged`,
matches `helpers.ts:32` / `continuity-capture.ts:453`)** → `f26c69aa` facets →
`2252f711` navigate-tree-rewind-hint (87.1%, 48.1k left, 50.0k reserve) →
`2746fcf9` assistant(error) → `83b7efb8` context_edit → **`d20cec82` failed,
372,133** → `4068dcb1` thinking_level_change.

The command does not fold by itself: `requestFold` (`index.ts:2095-2109`)
calls `pi.sendUserMessage`. No pending fold is persisted (the
`navigate-tree-rewind-outcome` entries are from 2026-10-22), and the receipts'
`reason` is the pre-flight one, not a recovery-path reason — so at least this
much is observed: no pending fold, no second request attempted, guard abort,
no withholding.

## Verified mechanism

1. Guard (`index.ts:4455-4472`): a request is refused when
   `requestAccounting(...).tokens + 1024 + 4096 > ctx.model.contextWindow`, i.e.
   `inputEstimate > 366,880` at 372,000.
2. `requestAccounting` (`index.ts:1010-1036`) = `estimateRequestTokens(messages)
   + ceil(ANCHOR_MANDATE.length/3.5)` (46). `estimateRequestTokens`
   (`context-tokens.ts:70-87`) returns
   `max(ceil(content*8/7), usage + ceil(tail*8/7))`.
3. The 46-token mandate term is a double count **if** the runtime system prompt
   already contains `ANCHOR_MANDATE` (injected by the `before_agent_start`
   handler, `index.ts:4474+`). That is source-conditional, not observed: no
   request payload or system prompt was captured. Magnitude 46 tokens either
   way.
4. Abort path: receipt map `index.ts:2164-2185`; `before_provider_request`
   returns `{}` while a receipt exists (`index.ts:2198`), so
   `capRecoveryOutput` never runs; `turn_end` hides the turn and writes the
   failure row (`index.ts:3539-3557`). The fold prompt therefore stays at the
   leaf, unanswered, and the in-band fold (a model tool call) can never run.
5. No withholding: `planWithhold` (`index.ts:1163`) is called only from
   `startRewindCompaction` (`index.ts:2495`, `index.ts:2555`), i.e. after an
   overflow *reply*. The pre-flight path contains no withholding call, so
   `appliedWithheld: 0` and the message's "No tool results were withheld" state
   the code path rather than a failed attempt.
6. Hint reserve geometry: the hint fires at free ≤ 50,000
   (`~/.pi/agent/tree-navigator.json`, `rewind_hint_reserve_tokens = 50000`; no
   project `tree-navigator.json` at `/mnt/Projects/nukular/nukular-ai/.pi/`,
   no per-model override for `openai/gpt-6-astra`; `compaction.enabled` false
   globally and per project, so `rewindCompactionTarget`
   (`index.ts:2306-2335`) is active). Under the receipt formula, the guard's
   content ceiling is `floor((366,880-46)*7/8) = 320,979`, i.e. free ≥ 51,021 —
   about 1,021 tokens *above* the reserve the hint uses. So the hint's advice
   lands inside the guard's refusal band. This is arithmetic on the source
   constants plus the assumed formula; the prohibition itself is observed.

## Numbers: what is computed and what is inverted

* Receipt arithmetic is an **inversion, not a reproduction**. Assuming
  `inputEstimate = ceil(C*8/7) + 46`, each receipt yields a unique integer
  `C = 324,531 / 324,940 / 325,576`. That is consistency with the formula, not
  an independent measurement of the refused request.
* Independently computed (real projection functions, no inversion): the plain
  4-char scan `estimateContentTokens` at the corresponding branch leaves is
  323,489 (`dd70a166`) and 324,534 (`2252f711`) — each exactly 1,042 tokens
  below the inverted `C` (+0.3%). The constant offset is an unexplained
  runtime-only component (live system prompt/tool schema, appends not persisted
  at that instant); it is not a wire measurement.
* `estimateRequestTokens` on the same reconstruction returns 407,258-408,452,
  which does **not** match the receipts: `convertToLlm` re-converts messages the
  runtime has already converted (the host passes the current array with one
  leading system message, `dist/core/extensions/runner.js:1035-1049`). So the
  reconstruction's `requestEstimate`/`guardTotal` columns are a replication
  artifact and must not be read as the guard's number.
* Recorded provider usage (persisted, delivered requests only): 279,240 →
  307,702 prompt tokens across 2026-10-23 11:30-11:35 CEST; `prompt /
  4-char-scan` = 0.956-0.962 over those turns, i.e. the scan already over-reads
  by ~4% on this model. There is no capture of the refused requests' payload and
  no provider response for them, so their real input, and whether they would
  have been accepted, are unverified. The 8/7 factor plausibly turned a ~4%
  conservative estimate into a refusal; that is inference from the delivered
  turns, not measurement of the refused ones.
* Estimator divergence (observed on screen and reproducible):
  * hint 87.1% / 48.1k left — pi's `getContextUsage` →
    `estimateProjectedContextTokens` (4-char scan, `agent-session.js:3471+`,
    `compaction.js:137`): ~323,900 of 372,000.
  * extension `estimateContextTokens` at the same leaf = 312,660 (84.0%),
    baseline 307,882 (recorded usage) + tail 4,778.
  * newest anchor `s4-m3-executors-merged` (`6d83d656`,
    `2026-10-22 20:29:29` CEST) = 338,916 (91.1% of today's 372k) — a recorded
    usage baseline from when the window was 425,000 (79.7% then).
  * Arithmetic from the published numbers: `323,900*8/7 = 370,171`, close to
    the 370,939 receipt once the ~630 content delta and the 46 term are added.
* Anchor rows vs leaf are **mixed baselines**: `list`/anchor rendering computes
  `effectiveTargetTokensOnBranch` per anchor (`index.ts:700-718`,
  `index.ts:830-862`) and `savableTokens = max(0, total - anchor)`. At this leaf
  the five newest anchors render `savable = 0` because their baselines exceed
  the current leaf estimate. That 0 is a rendering artifact of incomparable
  baselines, **not** evidence that folding to those anchors would free nothing.
  Actual same-projection savings for those anchors is unverified; it would need
  a single estimator applied to both projections.

## Recommended fix (all conditional on the estimate being tightened safely)

1. Do **not** simply drop the whole-scan term from `estimateRequestTokens`.
   Prefer a calibrated estimate: recorded-usage baseline + 8/7 on the tail, and
   only trust that baseline when it is still valid for the current
   model/tool/system/context-edit state (same validity question
   `invalidateStaleUsage` and `planWithhold`'s `realTokens` calibration already
   face). Keep the whole-scan 8/7 as the fallback when the baseline is stale or
   absent (`context-tokens.ts:70-87`).
2. Give the pre-flight guard recovery instead of an unconditional abort
   (`index.ts:4455-4472`): clamp the output reservation with
   `capRecoveryOutput`; if that does not fit, attempt `planWithhold` on the
   newest tool results; abort only when both fail. This reuses the post-overflow
   machinery; it needs a verified target rather than 1024+4096 alone.
3. Reject the estimate/config combination at load: warn when
   `rewindHintReserveTokens < 5,166 + contextWindow/8` (≈51.1k at 372k), since
   the hint can otherwise only advise an action the guard refuses. Extend
   `buildReserveOrderWarning` (`rewind-hint.ts:143`, raised at
   `index.ts:4404`).
4. Do not append the fold prompt when the guard would refuse: `/anchor fold`
   should check first and report, or fold out-of-band. Today it strands a user
   turn (`8d3ec5f3`).
5. Anchor rows: render one estimator against the window each baseline was
   measured in, and flag rows whose baseline predates withheld edits; drop the
   `max(0, total-anchor)` savings figure when baselines differ.
6. Regression tests: a pre-flight fixture whose recorded usage is comfortably
   below the ceiling but whose inflated estimate exceeds it must send (or
   withhold) rather than abort; a fixture that fits only after one withheld
   result must withhold; a config test that reserve 50,000 with window 372,000
   warns. Keep a test that an infeasible request *with a stale baseline* still
   aborts.

## Open questions / follow-ups

* Exact feasibility of the refused requests: needs a request-body capture
  (`before_provider_request` payload) including the adapter's output
  reservation. `gpt-6-astra` records `maxTokens 128,000`; if the adapter
  reserves that much, 312k-class input would not fit 372k either, and the
  protective remedy is the output clamp rather than the abort. Unverified.
* The constant 1,042-token offset between reconstruction and inverted `C`.
* Why a 372,000 override coexists with a 272,000 catalog default is a user
  configuration question; a lower real limit changes the arithmetic, not the
  estimator divergence.
