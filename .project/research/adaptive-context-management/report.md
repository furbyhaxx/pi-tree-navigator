---
version: 1
id: "adaptive-context-management-2026-10-21"
title: "Adaptive context management for a branch-based coding agent"
description: "Evidence, alternatives and evaluation criteria for reliable budgeting, progressive detail, classifiers, recall and task continuity."
type: "research"
created: "2026-10-21T20:02:08+02:00"
updated: "2026-10-21T20:24:41+02:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Recommendation

Keep the native Pi session tree. First make request budgeting and recovery agree on the actual projected context. Then evaluate a smaller active briefing over source-linked reports and raw history. Use classifiers only as optional advice after that deterministic baseline works.

Do not implement chronological decay as “old enough means one line.” Older execution detail can become less visible; still-binding requirements, decisions, open work and relevant negative results cannot expire merely because time passed. Preserving raw history makes an omission reversible, but does not prove the agent will recognize the omission and retrieve it.

This is **research and decision material**, not an approved architecture or implementation. No source code, installed package, configuration or private session was changed by this research. No live-provider/classifier inference or semantic benchmark was run. Six research perspectives and two independent critics informed the synthesis; see [sources.md](sources.md) for primary references, revisions, evidence limits and disagreements.

# 1. Separate the failures

The preceding local investigation at `a0db202` and this research identify different problems. A single “context full” label hides them.

| Layer | Observed or source-verified issue | Consequence |
|---|---|---|
| SDK/request budget | Historical usage can remain a baseline after the measured projection changed; the common clamp permits one output token. | A smaller payload may still receive an unusable allowance. |
| Navigator recovery | `planWithhold` stops at `branch_summary`, although native projection retains earlier ancestors. | Eligible older results are never considered. |
| Navigator reporting | An infeasible proposed withholding plan applies no replacements but reports failure after withholding. | The diagnostic describes an action that did not happen. |
| Handoff policy | Full parents inline child reports; minimum apparent savings does not include the final replacement size. | Folds can retain more detail than expected; net reduction is not guaranteed. |
| Sidecar coverage | An anchor is offered only when its complete relevant evidence fits the controller request. | A large segment can leave semantic automation unable to choose a rewind. |

The first reported failure involved excessive **reserved output**, not a million tokens of actual input. The earlier fixes added bounded recovery for supported output-reservation errors. The subsequent failure was different: at sample-A line 821, recorded usage contains **564,679 input/cache tokens**, one output token and `stopReason: "length"`, against the locally configured **425,000-token operating limit**. The integrator independently checked those usage fields. This does not establish the provider's contractual maximum or independently validate the adapter's accounting normalization.

The SDK and extension therefore both have responsibilities. Correcting only summary prose cannot repair stale budgeting or an incorrect projection boundary. Reloading code is not a substitute for validating the next request's fit.

## Where the volume was

The inspected active branch contained approximately 1.23 million conversational characters:

```text
Tool results                  60%
Tool-call scripts/arguments    22%
Assistant text/thinking         9%
Summaries                       3%
User messages                   3%
Extension messages              3%
```

These are character shares, not tokenizer-exact token shares or safe-removal percentages. System instructions, tool schemas and provider framing add overhead. The large observation share motivates a tool-content baseline; it does not authorize removing 60% of the prompt.

Source seams: `index.ts` (`planWithhold`, `staleUsageFlags`, `completeRewind`, `maybeRunAutoNavigate`), `context-tokens.ts`, `handoff.ts`, and installed Pi `utils/estimate.js`, `api/simple-options.js`, session projection and compaction estimation. [Source assessment](sources.md#provider-and-budgeting-references) distinguishes SDK, host and extension behavior.

# 2. What the real summaries did

The [six-fold local audit](session-audit.md) qualifies the suspicion that summaries cause widespread forgetting:

- All six continuations began consistently with their next steps; no constraint violation was observed in the sampled continuations. This is not an exhaustive fidelity evaluation or a counterfactual comparison.
- Most repeat reads had legitimate explanations: new tasks, changed files, verification, explicit requests or repository instructions. In same-task windows, 13 of 87 reads overlapped earlier reads; only three appeared to repeat a full unchanged-file range. No per-read hashes prove those files were unchanged.
- The largest stored own report was **8,133 characters**, growing to **28,295 characters** when materialized. Verbatim child reports accounted for **70.4%** of that result.
- Pending-worker reports quickly became historical snapshots. One report's task-list claim disagreed with a later empty-store response. The inconsistency is observed; the exact todo-state loss mechanism is unproven.
- File metadata was incomplete relative to parsed activity, but read-only lists intentionally exclude modified files and historical nested recording varies. It is not a semantic recall score.

The strongest targets are request correctness, bounded projected detail and authoritative state reconciliation. Do not suppress file reads simply because the file appeared earlier. A small fresh read can be safer and cheaper than carrying its old contents through every turn.

# 3. What the research supports

The [source review](sources.md) covers eleven papers and revision-pinned Pi, OpenHands and Codex implementations.

- **Long context is not equivalent to reliable use.** Lost in the Middle found positional sensitivity in its evaluated retrieval/QA tasks. LongMemEval separates extraction, temporal reasoning, updates and abstention. Test those behaviors rather than treating token capacity as memory quality.
- **Hierarchical summaries are possible, not automatically faithful.** Recursively Summarizing Books used trained decomposition and human feedback. It does not validate repeatedly paraphrasing the latest summary without original evidence.
- **Archive plus active view is established prior art.** MemGPT and OpenHands separate retained history from model-visible context. OpenHands protects valid manipulation boundaries and distinguishes soft hygiene from a hard fit requirement.
- **Emergency fitting and semantic summarization should be separate.** Codex has a tool-output trimming path distinct from normal compaction. Request safety should not depend on a semantic sidecar first understanding the entire oversized history.
- **Compression can discard useful process information.** The very recent MemDev-Bench preprint reports both benefits and memory-induced failures, including fewer agent steps with raw trajectories. GACC-Bench reports harm from conditioning compression on the wrong goal. These are cautions, not replicated Pi results.
- **Addressable recall is promising but not lossless cognition.** ARC's strong needle-retrieval result is much less decisive on its harder long-context benchmark. Coding agents also need clues they were never explicitly asked to retrieve.

No reviewed result proves that a classifier, a one-line capsule or a receipt safely preserves all task dependencies. A direct masking-versus-summary baseline remains an evidence gap and belongs in our evaluation.

# 4. A projection pipeline over the existing tree

Proposed direction, not a new memory service:

```text
Immutable session tree + source records
                  |
          Canonical active projection
                  |
   Current instructions + live task-state receipt
                  |
       Select detail and protect protocol
          ^       |
 optional semantic advice
                  |
       Recompute budget + validate adapter replay
                  |
         Send, reduce further, or declare infeasible
```

One effective request model should account for the model/provider, local operating limit, effective system state, tools, projected messages and output/reasoning allowance. A historical usage baseline is valid only for the prefix/request shape it measured. Preserve original billing records while invalidating their use as context-size baselines after relevant edits or model/configuration changes.

The conservative relation is:

```text
projected input + requested output allowance + safety headroom
    <= effective operating window
```

Reasoning may share the output allowance or require adapter-specific handling. A local estimate remains an estimate; no universal safety margin is established here. Provider cache hits reduce computation or price, not the amount of input occupying context.

If current instructions, protected requirements, required tools and active protocol state already exceed the budget, say so before generation. Do not send a one-token continuation, silently drop a prohibition, or start an unbounded recovery loop.

## Detail levels and chronological decay

Keep four distinct surfaces:

1. **Current briefing:** present goal, binding constraints, accepted decisions, active tasks, unresolved questions and immediate next action.
2. **Source-linked facts and decisions:** status, authority/source, effective time, supersession and uncertainty. A sourced assertion is not automatically true or still applicable.
3. **Phase reports:** readable rationale, delivered work, rejected approaches and verification evidence, expandable in the existing tree.
4. **Raw archive:** exact original calls/results and messages, retrievable without rerunning a tool.

Reduce detail at pressure, completion or explicit supersession boundaries. Avoid a rewrite every turn: it adds inference and cache churn. Generate a smaller view from original evidence plus current state, rather than repeatedly shortening an already shortened report. Age is a secondary signal.

A compiler-style dependency graph is a useful experiment: current tasks, requirements and unresolved decisions are roots, with references to supporting evidence. But “unmarked” is not proof of irrelevance; implicit future dependencies need uncertainty and retrieval tests.

**Existing decisions remain intact:** the user previously chose a project ledger as task authority. Local antecedent: `.project/research/task-tracking/README.md` (untracked working notes, not bundled with this report). Session entries are historical receipts; they must not become a second task store. That ledger proposal is not implemented by the current navigator. The current `full` handoff policy also prioritizes child detail intentionally. Keep it available and do not silently rewrite frozen reports or change its default.

# 5. Tool results, scripts and thinking

The smallest promising semantic experiment is a deterministic receipt for an eligible **completed** observation:

```text
Source: session/entry reference; tool and call ID; recorded status
Omitted: output extent; relevant paths/symbols; selected error/head/tail text
Meaning: execution ran; omitted content is not evidence of success
Action: inspect original output without rerunning the command
```

This can avoid invented summaries, but selected lines may miss the only important clue. Many tools have no universal exit-code field; use structured status only when it exists, otherwise mark it unknown. Do not parse arbitrary prose into a fabricated success result.

Safe boundaries matter more than age:

- Preserve outstanding calls and active parallel batches; do not leave orphan calls/results.
- Retain identifiers and valid envelopes when replacing completed result bodies. Removing both sides requires adapter-aware replay validation.
- Scripts and arguments can encode the method and side effects needed to interpret a result. Do not assume they are disposable because their text is large.
- Do not generically strip signed thinking, encrypted reasoning or thought signatures. Use documented adapter-specific handling; raw reasoning is not a durable verified fact.
- Batch pressure-driven changes enough to obtain meaningful savings. Earlier-prefix edits can invalidate caches, but keeping an overflowing request to protect a cache is not a valid alternative.
- Recompute **net** projected size after replacement. A fold's old span being large does not prove its replacement is smaller.

Source references must resolve after reload, fork, clone and export. An entry ID alone can dangle when a fork copies only active ancestry. Use a source-session/archive locator with stable identity and explicit missing-source behavior; do not silently substitute current filesystem content for historical evidence.

# 6. Classifier, extractor and synthesizer are different jobs

```text
Classifier  -> chooses/ranks among supplied labels or candidates
Extractor   -> proposes source-linked structured assertions
Synthesizer -> renders a concise briefing from selected evidence
Policy      -> validates, protects and decides the allowed projection
```

Pi's classifier surface supports choices, scores and boolean probabilities. Jev can advise on categories; it cannot produce arbitrary extracted fact strings through that surface. A chat model with locally validated structured output can supply the same advisory contract, preserving model/provider flexibility. Strict-schema enforcement varies by adapter/model; validate every result.

Useful candidate questions include relevance, likely durable decisions and possible supersession. But relational questions need both old and new evidence. Splitting a history into independent chunks cannot prove a cross-chunk decision was superseded. Build candidate relations first, preserve conflicts, and let uncertainty retain evidence.

Confidence scores are not workload calibration. Measure false eviction, missed supersession, abstention and failure when the classifier is unavailable. Never let a model unilaterally remove a binding requirement. Prompt-injection text in a tool result remains untrusted data, even when another model labels it important.

**Recommendation:** optional, bounded semantic assistance after the deterministic baseline. No whole-history classifier call on every turn, no provider-specific dependency, and no extra extractor/verifier by default. Disclose selected data, route and usage before enabling auxiliary analysis. A second model's agreement is not independent proof of truth.

# 7. UX: explain what changed without interrupting work

Proposed compact receipt in the native outline; fields below are placeholders, not measured figures or shipped controls:

```text
API review — folded because of context pressure
Input estimate: before -> after | output allowance: reserved
Kept in context: constraints, open work, current decisions
Archived from view: selected completed observations
[inspect sources] [keep detail] [pause automatic changes] [raw tree]
```

Show estimated versus provider-recorded counts, actual applied changes and omission reasons. Keep inclusive historical billing separate from live context size. A visually collapsed report may still be entirely in model context; make that distinction visible.

Routine approved automation should be quiet and non-modal. Offer details and session-level pause rather than many thresholds. A recovery failure should name the irreducible floor or unsupported condition, not claim a transformation occurred when it did not.

A fold captures a task-store revision and event watermark. Reconcile later worker results against live state; do not wait indefinitely for all background workers or let stale reports reclaim assignments. Use IDs from the chosen task authority rather than invented parallel UI IDs.

“Undo” means restoring a context view or inspecting the original branch. It does **not** roll back files, external side effects or task-ledger history. Rehydration restores recorded evidence; refreshing a mutable file is a separate read.

# 8. Current and next slices

```text
Done   Evidence sweep, six-fold audit, independent criticism
Now    Deterministic request correctness and honest diagnostics
Next   Compare full detail with receipts + source-linked recall
Later  Optional semantic advice, adaptive detail and further UX
```

## Current: deterministic request correctness

Recommended implementation scope once implementation is authorized:

- Define one projection-aware baseline-validity rule across context reporting, recovery planning and request budgeting, including edits to the baseline assistant itself.
- Walk actual projected ancestors across branch summaries; honor real compaction cutoffs and current edits.
- Refuse unusable output allowances or an infeasible protected floor before sending. Keep recovery bounded and model/session-safe.
- Report proposed versus applied withholding correctly. Check replacement size before committing a fold, preserving history on failure.
- Surface controller coverage/fallback limits explicitly. Do not restore semantic rewind authority over evidence that was not supplied.

Tests that matter: model switch below active footprint; edits targeting/preceding a usage baseline; removable results before a branch summary; impossible protected floor; no partial edits on failed planning; correct diagnostics; provider-valid pending/parallel tool history. This slice does not require a classifier or a change to `full` mode.

## Next: one bounded observation-management comparison

Compare current full handoffs against deterministic completed-output receipts plus explicit source inspection, at matched operating budgets. Include hidden old constraints, a subtle middle-output error, changed files, abandoned attempts, cancelled workers and an unmentioned future dependency.

Test whether the agent actually retrieves or abstains before acting on omitted evidence. Measure whole-task success, repairs, net request reduction, retrieval overhead, latency and cache effects. If receipts lose crucial process information, test selected source-linked extraction rather than merely making receipts shorter.

Only after this comparison should we decide whether another handoff mode or an optional classifier improves outcomes. Do not pick universal confidence, compression or retrieval-rate thresholds from a paper or reviewer suggestion.

# 9. Decision material and verification gaps

Three options remain for future context policy:

- **Deterministic safety only:** least complexity and directly fixes request mechanics; older semantic bulk can remain large.
- **Safety plus layered briefing/recall:** recommended experiment; smaller active view with preserved detail, but retrieval may miss unknown dependencies.
- **Continuous model-driven rewriting:** most adaptive in principle; highest inference, calibration, privacy and cache risk. Defer until measured benefits justify it.

No new architecture choice is required to finish this research. Before implementation, agree the current deterministic slice; before changing preservation defaults, review the second option's measured fidelity.

[Evaluation protocol](evaluation.md) separates deterministic request correctness from semantic continuity. No proposed policy has passed it. Live provider accounting, classifier accuracy, cache effects, summary fidelity across representative projects and interactive usability remain **UNVERIFIED**. Source implementations and paper results are evidence for experiments, not proof of this extension's future behavior.
