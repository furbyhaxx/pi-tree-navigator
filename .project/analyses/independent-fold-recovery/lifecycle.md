---
version: 1
id: "independent-fold-recovery-lifecycle"
title: "Recovery continuation through the real SDK loop"
description: "Recovered evidence from local-transport lifecycle experiments; implementation seams and verification gaps."
type: "analysis"
created: "2026-10-23T17:30:18+02:00"
updated: "2026-10-23T17:30:18+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Recovery lifecycle

These experiments use the real installed SDK loop with a local test provider, synthetic sessions and a `simFold` stand-in. They are **not** production-engine or live-provider acceptance. The original investigator exhausted its context before writing a report; the saved scripts and outputs were subsequently inspected independently.

## Observed results

- `repro/output/S1-fold.run1.log`: abort in `context_with_system`, fold at `turn_end`, and return `continue: true` produces zero provider calls and settles aborted. This cannot implement recovery.
- `S1-newrun-custom.run1.log`: an explicit custom-message new run after settlement succeeds. It is unnecessary for successful preflight recovery and risks defeating intentional cancellation if used indiscriminately.
- `S2a.run1.log` and `S2d.run1.log`: await work in `context_with_system`, fold/refresh, and return fresh messages **without aborting**. The main request succeeds; a subsequent tool turn also succeeds in S2d.
- `S2c.run1.log`: user cancellation during that awaited preflight aborts the signal, makes no provider request and performs no fold.
- `S2b.run1.log`: preflight occurs after complete parallel/sequential tool batches; no unpaired calls were observed. This scenario does not itself fold.
- `S3b.run1.log`: after a provider overflow, fold at `agent_before_settle` and return a continuation. The next main request succeeds.
- `S3k.run1.log`: fold at the error's `turn_end`, then request continuation at `agent_before_settle`; the next main request succeeds. A `turn_end` continuation alone does not provide that guarantee.
- `S3j.run1.log`: a recoverable `length` stop permits a `turn_end` fold and continuation.
- `S3d.run1.log`: native compaction makes a side call, writes a compaction and resumes. This is the only saved case combining a side-provider call with history replacement and main continuation, and it exercises native compaction, not our fold engine.

`repro/output/digest.txt` records agreement across three repetitions per scenario. Inspect `repro/scenarios.mjs` and `repro/rig.mjs` for the actual operations behind each label.

## Implementation decision

Use awaited preflight recovery in `context_with_system`: capture the current system/tool messages, run the independent engine, and return its new projection. Do not abort a successfully recovered request. On actual provider overflow, recover through `agent_before_settle`, whose public continuation contract is honored after an error. Preserve user cancellation, enforce a bounded recovery attempt, and never reset private abort flags or inject a fabricated user message.

The normal fold commit must still preserve late/unanswered input, refresh agent messages and notify history-mirroring extensions. An unsuccessful recovery must persist one actionable receipt; failure to commit a boundary draft must not silently lose that receipt.

## Remaining verification

Run the production engine through these hooks using a local transport, including parallel tools, cancellation, late input and failed boundary persistence. Then run the authorized budgeted live-provider and TUI acceptance. No provider feasibility, prompt-cache behavior or production recovery success is established by these lifecycle stand-ins.
