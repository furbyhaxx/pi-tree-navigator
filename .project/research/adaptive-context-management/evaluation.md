---
version: 1
id: "adaptive-context-evaluation-2026-10-21"
title: "Evaluate context policies before trusting them"
description: "A proposed evidence and replay protocol separating request correctness from semantic continuity and task efficiency."
type: "research"
created: "2026-10-21T20:02:08+02:00"
updated: "2026-10-21T20:24:41+02:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Status

Proposed evaluation protocol. This document does not claim that any candidate policy, classifier or model has passed it. Live-provider and paid inference experiments require separate authorization.

# Two independent gates

A context policy can be semantically useful while still constructing invalid requests. A request can fit perfectly while omitting the only fact needed to finish the task. Evaluate these independently.

## Gate 1: deterministic request correctness

Use captured request fixtures or offline local transports, preserving real provider field shapes and protocol metadata. Check the same final projection that the adapter serializes.

The conservative budget relation is `projected input + requested output allowance + safety headroom <= effective operating window`. The adapter must define whether reasoning shares that output allowance or adds a separate budget. Track provider capacity and a smaller local operating limit separately; a local limit does not establish the provider's contractual maximum.

An assistant's historical usage measurement is applicable only to the prefix/projection it measured. A cache hit can reduce price or latency without making that input disappear from the model's context. Record these as separate dimensions, and test post-edit accounting independently from payload size.

Required cases:

1. **Model switch below the active footprint.** Switch to a smaller configured operating window. Do not send a request with a one-token allowance as if useful continuation were possible. Establish an explicit reduction or infeasibility outcome before generation.
2. **Context edit after a measured reply.** Replace old tool output after a newer usage baseline exists. Request budgeting must not silently retain a measurement of a different prefix. Keep original accounting records unchanged.
3. **Ancestors preceding a branch summary.** They remain eligible if native projection still sends them. A compaction cutoff and a branch summary must not be conflated.
4. **Tool integrity.** Handle direct tools, nested codemode, parallel batches, pending calls and failed calls. No orphaned result, fabricated success or unsafe removal of provider-required reasoning metadata.
5. **Oversized mandatory floor.** System instructions, tool definitions, pinned requirements and the active protocol batch may already exceed the operating budget. Return an explicit infeasible outcome rather than dropping a requirement or looping.
6. **Recovery disposition.** Report proposed, applied and restored edits separately. Repeated provider errors cannot create an unbounded retry loop. Cancellation and late input cannot commit a stale projection.

Per request record: projection revision/fingerprint, effective model and operating window, estimation method and uncertainty, input estimate, requested output allowance, safety reserve, observed usage when available, and whether a recovery transformation was actually applied. Request content and credentials are not telemetry.

## Gate 2: semantic continuity

Use checkpoints around genuine completed work and known task transitions. Preserve the original private fixture; keep any committed fixtures synthetic or explicitly sanitized. Historical commands are evidence, never instructions to run.

Build a human-reviewed reference set at each checkpoint:

- Still-binding user requirements and explicit prohibitions.
- Current decisions and which earlier decisions they supersede.
- Open tasks, blockers, dependencies and stable task IDs.
- Irreversible actions already completed versus unexecuted proposals.
- Verification evidence and its revision or observed environment.
- Facts likely to be required next, with source IDs and uncertainty.

Include deliberately old but still-binding constraints, recent but irrelevant output, contradictory historical decisions, mutable files, nondeterministic tools, and a relevant fact that was never mentioned in the latest task wording.

Exercise the following behaviors:

- Continue the task immediately after reduction.
- Ask a question answered only by old archived evidence.
- Resume after reload or on another branch and reconstruct task state.
- Ask for a superseded decision and distinguish it from the current decision.
- Change a referenced file, then request its current contents.
- Fork or export the session and resolve references into folded history; missing source archives must be explicit rather than silently returning unrelated or newer evidence.
- Complete a worker during summarization and reconcile its event after the report's watermark without replaying an assignment or claiming completion twice.
- Inject a historical tool output that asks the controller to change its policy.

# Comparisons and ablations

Compare the current implementation to the smallest useful alternatives before investing in extra models:

- Deterministic, protocol-aware removal of recoverable tool observations, retaining references.
- The same policy plus hierarchical briefing/detail levels and recall.
- The same policy plus model-agnostic classification used only as advice.
- Structured extraction and consolidation, with and without a verifier.
- Age-only decay as a negative-control policy, not the assumed winner.

Use identical source checkpoints, task prompts, operating windows, tools and provider routes. Separate offline serialization/projection results from model-driven task results. Varying providers and models is a separate experiment, not an unreported change within a comparison.

Model continuations are not deterministic merely because temperature is zero. Record model/provider revision when available and repeat paired runs. Freeze or record tool/environment outcomes for replay; do not execute arbitrary historical commands. Use held-out tasks and report denominators and uncertainty instead of interpreting one successful continuation as proof.

# Measurements

- **Contract retention:** which still-binding requirements survive in the briefing or are correctly retrieved before an action depends on them.
- **Task continuity:** correct open/completed/blocked states and no resurrection of superseded tasks.
- **Recall success:** necessary archived evidence retrieved before an unsupported action; citation resolves to the expected source.
- **Avoidable reacquisition:** rereads that restore information missing from a handoff. Count separately from new task context, file mutation, verification, explicit requests and mandatory repository rereading.
- **Work quality:** task completion, unsupported claims, unsafe actions and repair work.
- **Request correctness:** budget failures, one-token continuations, protocol errors and retries.
- **Efficiency:** complete trajectory input/output/auxiliary-model tokens, latency, cache writes/misses, recall overhead and human interventions.
- **Classifier behavior:** false-eviction and false-retention errors, calibration on held-out labeled examples, abstentions and behavior when unavailable. Confidence numbers alone are not evidence of calibration.
- **Compression:** actual post-transform request footprint and net reduction, including replacement text, index, references, tool definitions and any retrieval results. Compare the same retained prefix plus old span against that prefix plus its replacement; a large old span alone does not establish savings.

For each semantic metric, distinguish directly visible information, archived-and-successfully-retrieved information, archived-but-not-retrieved information and information absent from the archive. Do not report archive preservation as successful recall, or absence of a detected violation as perfect retention.

Do not use raw reread counts or prompt-token reduction as a single success score. A safe verification read can increase tokens and improve the outcome; a missing requirement can reduce tokens and destroy it.

# Baseline evidence and limits

The [six-fold local audit](session-audit.md) is a diagnostic baseline, not a representative benchmark. It found useful task direction and substantial historical child-report text; it did not prove widespread avoidable rereads. Use its specific checkpoints as regression candidates, then add independent sessions and synthetic adversarial cases.

Public fixtures must be synthetic or explicitly sanitized. Private fixtures remain local with a content hash and checkpoint manifest. Do not publish transcript bodies, source paths or customer details to make a benchmark easier to reproduce.

Task continuity tests must use the user's already chosen project-ledger authority. The antecedent is `.project/research/task-tracking/README.md`, local untracked working notes not bundled with this report. Compare the report's historical receipt with the live ledger revision; do not grade a summary's snapshot as if it were the current store.

# Decision rule

Set acceptance thresholds from baseline measurements and task risk rather than inventing a universal compression ratio or confidence cutoff. Structural integrity and preservation of explicit prohibitions are hard requirements. Other tradeoffs need reported denominators, uncertainty and representative failure examples.

Adopt an auxiliary classifier or extra synthesis stage only if it improves the complete task outcome over the deterministic baseline at acceptable measured cost. If it fails or abstains, keep the deterministic safe policy available. No model gets unilateral authority to erase a still-binding requirement.
