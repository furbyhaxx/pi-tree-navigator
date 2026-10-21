---
version: 1
id: "adaptive-context-session-audit-2026-10-21"
title: "What six real folds preserved, duplicated and failed to carry"
description: "A sanitized local transcript audit distinguishing task continuity, duplicate handoffs, stale external state and justified rereads."
type: "research"
created: "2026-10-21T20:08:37+02:00"
updated: "2026-10-21T20:24:41+02:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Scope and reproducibility

Read-only audit of six successful folds from one private coding session. No historical command was executed, no source session was modified, and no transcript text was sent to a web service. The raw fixture is not included in this repository.

Fixture alias: **sample-A**. SHA-256 of the inspected 1,028-line snapshot:
`55ace888a38e5a3284de0aa130b14542f66636ff4d6d66b2be81d030c88d067d`.
The six summary records are at one-based JSONL lines 89, 135, 253, 332, 447 and 602. Local line references below refer to this exact snapshot, not to a portable public fixture.

The delegated audit followed each summary's parent chain, inspected continuations and parsed direct and nested codemode tool calls. The integrating assistant independently checked summary lengths, verbatim child containment, file-list metadata and the empty-task response. Broader action counts below are the delegated parser's measurements, not a second independent recount.

# Findings

## 1. Task direction usually survived

All six handoffs contained goal, constraints, progress, decisions and next steps. Their continuations' first actions were consistent with those next steps. The audit found no observed constraint violation in these six continuations. One fold preserved an implementation decision subsequently cited by the continuation; another correctly distinguished completed work from integration checks that had not run.

This is evidence of useful task-level continuity in this sample. It is not a quantified semantic-fidelity score: there was no human-labeled inventory of every binding fact, no counterfactual raw-context continuation and no evaluation across projects.

## 2. Full parent reports carry substantial historical text

The six materialized summaries contain 61,815 characters in total.

- Summary 332 contains summary 253 verbatim: 4,815 of 14,503 characters.
- Summary 602 contains summaries 332 and 447 verbatim: 19,933 of 28,295 characters, approximately **70.4%**.
- Summary 602's stored own report is **8,133 characters**. The remaining 20,162 characters include child reports and materialization headings/separators.

Across the six summary records, 24,748 characters are copied child-summary text. That is a measurement across records, not an assertion that all six reports are simultaneously in the active prompt. It also does not establish a duplicate-child-ID bug: full mode intentionally attaches each immediate child once, and the child may itself contain grandchildren.

The largest fold still reduced the displayed context substantially. The issue is the accumulating price of detail preservation, not evidence that this fold did nothing.

Source mechanism: `materializeHandoff` in [handoff.ts](../../../extensions/navigate-tree/handoff.ts), and the full/synthesized parent instruction in [summary-prompt.ts](../../../extensions/navigate-tree/summary-prompt.ts). Full mode is the current preservation policy. Changing it is an architecture/product decision; a research recommendation must not silently change old handoffs or the default.

## 3. Live state can be stale or unavailable after a fold

Three handoffs described workers or reviewers as pending; completion notifications appeared shortly after the summary records. The continuation handled them, but the report was already stale by the time it resumed. This timing alone does not prove an event was dropped: a historical snapshot can legitimately be followed by a newer event.

A stronger contradiction appears at summary 602: its prose says the task list was recreated, while a later task-list query at line 648 returned an empty result and line 659 recreated tasks. The inconsistency is observed. **The cause is unproven:** the transcript does not establish whether the todo extension stores state in memory, branch entries or another service, or whether a reload or tool-owner change intervened.

Implication: summaries should state the revision/time of a task or worker snapshot. Current state should be read from its authoritative owner, with new events reconciled after the summary's watermark. Prose cannot make external state durable.

The user previously chose a project ledger as task authority, recorded in local untracked working notes at `.project/research/task-tracking/README.md` (not bundled with this report). This audit supports continuity tests for that choice; it does not reopen the authority decision or claim that the ledger is implemented.

## 4. Most repeated reads have reasonable explanations

The delegated audit parsed 185 post-fold read actions and 153 unique targets across 648 continuation entries. It found 39 overlaps with earlier reads. Of these, 26 occurred around new task boundaries. In the same-task windows, 13 of 87 reads overlapped a prior read; three appeared to repeat an entire previously read unchanged-file range.

Other repeats followed edits, checked results, answered explicit user requests or complied with repository instructions to reread guidance. Some apparent reorientation reads extended the previously seen range. These categories overlap; do not add them as a partition of 39.

“Unchanged” here means no intervening edit/write action was found. There were no per-read file hashes or complete filesystem snapshots, and shell commands or other processes could have changed the file. Dynamic paths also escaped the parser. **These are candidate avoidable rereads, not proven waste.**

The current evidence does not support “summaries make the agent reread everything” or a blanket reread-suppression feature. Store file revisions and classify read purpose before optimizing this behavior.

## 5. File metadata is a partial index, not a memory-quality score

The audit found 17 file-list entries matching 110 observed read targets, and 34 matching 73 observed edit/write targets across the summarized spans. Some folds' metadata was empty despite visible nested tool activity.

These ratios cannot be called recall of the file-list contract without adjusting the denominator. `readFiles` intentionally excludes modified files; `modifiedFiles` is a separate field. The installed SDK's `extractFileOpsFromMessage` recognizes structured `nestedCalls`, not arbitrary source-code inference. Historical codemode recording, dynamic paths, shell operations and normalization can all affect coverage.

The integrator verified this distinction in the current `computeFileLists` implementation in [summary-prompt.ts](../../../extensions/navigate-tree/summary-prompt.ts) and the installed SDK's `core/compaction/utils.js`. The counts justify treating this metadata as an incomplete navigation aid. They do not prove semantic forgetting or a current regression in nested-call recording.

# What to measure next

Use fixed checkpoints and a human-reviewed reference set before comparing policies:

- Binding requirements and decisions retained or retrieved before dependent actions.
- Correct current versus historical task state; no resurrection of completed work.
- Net projected reduction including replacement reports and recall indexes.
- Exact child-text repetition, with active-prompt and across-record counts separated.
- Reread ranges, file hashes/revisions and purpose; count refresh/verification separately.
- Retrieval success for a fact absent from the latest task wording.
- Full trajectory cost and latency, including summaries, controllers, retrieval and repairs.

A compact source-linked resume manifest is a candidate experiment: requirements, decisions, task-store revision, artifact hashes and unresolved risks alongside a short narrative. It may reduce stale claims and repeated prose, but could lose rationale and add verification overhead. Compare it with the current handoff; do not assume it wins.

See [evaluation.md](evaluation.md) for the proposed request-correctness and semantic-continuity gates. No candidate has passed them yet.
