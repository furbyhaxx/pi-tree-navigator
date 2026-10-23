---
version: 2
id: "live-navigator-acceptance"
title: "Live navigator acceptance"
description: "Real long-context folds, terminal continuation, proposal and classifier evidence, including failed runs and bounded conclusions."
type: "analysis"
created: "2026-10-23T11:19:35+02:00"
updated: "2026-10-23T11:52:58+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Live acceptance

The final six-session workload passed: **6/6 accepted reports and 24/24 folds** from one
user prompt per session. A separate real terminal run proved the one-time continuation
nudge after a controlled text-only post-fold checkpoint. Earlier failures are retained.
This establishes the observed runs, not guaranteed completion of arbitrary agent work.

Implementation/install baseline was `5abd2d5`. Final live workload source commit is
`b13b377`; later changes to the analyzer tighten evidence correlation without changing
the extension under test. Installation and remote delivery are separate from these results.

## Workload and evidence contract

Six concurrent isolated SDK processes used the configured `openai/gpt-6-luna` route,
`openai-responses`, low thinking; observed registry window 372,000. Each received the same
79-file tracked source corpus in four balanced partitions (448,102 / 462,243 / 444,682 /
455,028 UTF-8 bytes), with a distinct review lens. These are source bytes plus framing,
not synthetic repeated padding. Corpus snapshots were held fixed across all three runs.

Each process received one user prompt. The harness never rescued premature settlement
with another prompt. It required ordered partition loading, four completed folds, exact
SHA-256 values and substantive observations before accepting the final report. Refusals
remain errors; the final harness reports loaded indices and completed-fold counts to
make an incorrect repeated call diagnosable.

Commands:

```sh
node scripts/live-navigator-acceptance.mjs --sessions 6 \
  --corpus /tmp/navigator-live-VaePiv/corpus.json \
  --output .project/analyses/live-acceptance/parallel-03
node scripts/analyze-live-navigator.mjs \
  .project/analyses/live-acceptance/parallel-03 --require-text-only
node scripts/summary-quality-check.mjs <each-session.jsonl> --all
```

The temporary corpus path is historical. Each run's `corpus-manifest.json` records file
and partition hashes; full partition content is preserved in the session tool results.
Default harness invocations build a new corpus from tracked files and report its snapshot
path. Use the original snapshot when comparing the captured run with a rerun.

Wire logs contain serialized request payloads, allowlisted response headers and parsed
provider stream events before Pi normalization. They are not packet captures or original
SSE bytes. Session records are unchanged. Authentication uses existing stores; no credentials
or private user sessions were copied. See `publication-review.md` for the privacy review.

## Three parallel runs

All times below are Europe/Zurich, converted from the UTC timestamps retained in evidence.

| Run | Reports / folds | Cumulative input / peak input |
| --- | --- | --- |
| `parallel-01`, 10:56:16–11:02:50 | 4/6 reports; 22/24 folds; failed | 24,193,496 / 229,628 |
| `parallel-02`, 11:25:43–11:29:38 | 5/6 reports; 22/24 folds; failed | 12,967,943 / 120,258 |
| `parallel-03`, 11:45:22–11:49:02 | 6/6 reports; 24/24 folds; passed | 14,607,097 / 119,729 |

The three workloads total **51,768,536 cumulative input tokens**. This is repeated
provider-observed traffic, not a million-token peak context or a billion-token endurance run.

### Final run

- 181 requests/responses, all observed HTTP 200; 28,285 parsed stream events.
- Serialized request payloads ranged from 6,830 to 508,487 bytes.
- 25 summary requests, all text-only; 24 completed folds (one summary retry).
- Every fold is correlated to its exact summary instruction in wire evidence within
  its persisted instruction-to-handoff interval. Retries for one fold cannot cover another.
- Every completed fold has same-run continuation, a retained active user-origin rule,
  and lower observed next-request input.
- Summary cache-read / previous-input ratio: **99.822%–99.934%**.
- Next-request input reduction: **94.917%–98.144%**.
- 11,735,936 cache-read tokens; 29,448 output tokens.
- All four hashes survive in every final active handoff chain and accepted report.
- All 24 final reports' Blocked sections state no established blockers; no temporary
  summary-turn tool restriction is recorded as a task blocker (`blocked-sections.json`).
- All six session summary smoke checks pass. The prior twelve sessions also pass the
  corrected structural checker, despite their separate workload acceptance failures.

The reports retain path/symbol-based source observations. Their labels such as “verified”
are model-authored, not an independent defect audit. Potential bugs in these review outputs
were not accepted as demonstrated defects, and no test-execution claims were required or
trusted. Structural smoke checks and exact hashes do not prove complete semantic retention.

### Initial failure and fixes

`parallel-01` failed because pending summaries still allowed native tool calls: 47 of
69 summary attempts called tools. The runtime rejected them and retries repeated the
same request, exhausting attempts in two sessions. See `summary-failure/report.md`.

Implemented native text-only constraints for supported OpenAI, Anthropic and Google
adapters, retaining tool declarations/messages and composing output caps without overriding
abort priority. This live acceptance exercises OpenAI Responses; other adapter shapes are
covered offline, not by live calls in this report.

The old summary smoke checker also assumed an obsolete native preamble and capped the
whole ledger/child bundle. It now validates current handoff metadata via `getHandoff`,
checks the own report separately, and preserves the legacy contract. Its real fixture is
unchanged captured evidence.

`parallel-02` removed tool-calling summary failures but one session stopped after two
folds. The model treated temporary summary-only restrictions as task blockers, repeated
a completed fold and requested already-loaded partitions. All 22 requests in that failed
session returned 200. Its first post-fold response called a tool, so the text-only nudge
correctly did not fire. See `remaining-settlement/report.md`.

Commit `1383312` clarifies summary-only restrictions outside the byte-pinned r5d prompt
and gives a distinct refusal when a duplicate label already names a stored handoff.
The refusal still mutates nothing. The harness also returns its real progress state on
misindexed calls. The final run changed these together; it is not an ablation attributing
the improvement to one wording change alone. No thresholds, gates or retry bounds were weakened.

## Real terminal folds and bounded continuation

All four terminal runs used real Pi-Bolt with an isolated agent directory/workspace and
one full 448,102-byte source partition. `launch.json` records the invocation and scratch
paths. Credentials/configuration were referenced through scratch symlinks; user files
were not modified. All test terminal sessions were stopped after capture.

- `tui/`: summary input 114,550; cache read 113,152; next input 1,826. Actual footer
  30.8% before summary, 0.6% after fold while still working. Ctrl+O at 60/130 columns
  and fullscreen mouse toggles were captured.
- `tui-02/`: summary input 114,493; next input 1,898; completion accepted. The model
  ignored the requested text-only checkpoint and called the next tool immediately.
  **This did not exercise the nudge.**
- `tui-nudge/`: the observer constrained exactly the first post-fold request to
  `tool_choice: none`. One nudge fired, followed by the real `finish_review` call and
  acceptance, with no new user prompt. Three summary attempts preceded that fold.
- `tui-final/`: final extension code after `1383312`, with the same controlled checkpoint.
  One summary attempt; summary input **114,700**, cache read **113,152** against previous
  input 113,321; first post-fold input **1,961**. One text-only checkpoint, exactly one
  persisted nudge, then `finish_review` and accepted completion. Eleven requests, all
  HTTP 200; one user message. Summary smoke passes.

The observer changes only one post-fold request's tool-choice field to create the test
condition; it does not fabricate responses, inject continuation prompts or implement the
nudge. The production extension supplies that nudge. This is controlled live verification
of the bounded mechanism, not a claim that all spontaneous stops are recovered.

`tui-final/expanded-60.txt`, `collapsed-60.txt`, `collapsed-130.txt` and the request captures
show terminal rendering and Ctrl+O. These runs do not repeat every settings/clone screen
check from the earlier `5abd2d5` UI acceptance. TUI launch files did not record a git SHA;
this source attribution is reconstructed from the orchestration sequence, not presented
as an original metadata field.

## Classifier measurements

Initial evidence: `classifier/2026-10-23-live-classifier-acceptance.md`, 12 real HTTP-200
calls. The initial 55/61 exploratory score included expected conservative abstention and
a purported reversal fixture that did not actually reverse its choice. It is not grounds
to lower the 0.7 confidence threshold or to claim an authority-contract failure.

A narrow fix retains explicit deterministic markers/excerpts when the model abstains.
`classifier/recheck/2026-10-23-marker-fallback-recheck.md` records **two real HTTP-200
requests and 12/12 contract assertions** at the unchanged threshold:

- A 359-character explicit objective received confidence 0.50; heuristic fallback
  captured the whole objective verbatim with user protection.
- A 1,319-character mixed message received confidence 0.51; fallback captured its
  explicit rule sentence verbatim with user protection.
- No fabricated supersession, no rewrite of the existing rule, no warnings/rejections.

The two-call recheck did not exercise malformed-kind fallback, confident-result regression,
actual user choice reversal, store replay or UI rescue live. Relevant unit coverage remains
separate. Marker-free intent capture is still probabilistic and can abstain.

## Model-assisted proposals

See `proposal/2026-10-23-live-proposal-acceptance.md`. Initial runs made 14 real HTTP-200
requests over an actual 2,060,348-byte session (772,210 input / 13,211 output tokens).
Unsafe ranges and malformed JSON correctly fell back. An adopted plan cloned without
changing the source, but its reports omitted facts present only in display metadata.

Commit `f19e4b6` clarifies real safe start IDs and requires self-contained summary text.
One recheck made 10 real HTTP-200 requests (585,481 input / 8,690 output tokens). Its model
plan passed deterministic validation without fallback, preserved all four hashes and
11/11 checked source references, and cloned/reopened with the source unchanged.

**Quality limit:** the recheck chose one open group and created no new folded handoffs.
It saved no context. New model-generated folded handoff quality under the revised prompt
is **UNVERIFIED** by that recheck; this is not reported as compression success. Existing
handoffs were retained. Human review remains required, and model quality is not made
reliable by a successful transport or validator pass.

## Offline checks and independent review

- Final extension gate at `b13b377`: **1,170/1,170 tests**, TypeScript and Biome passed;
  **34/34 upstream probes** passed. Evidence: `checks/final-offline-gate.txt`.
- Subsequent analyzer-only hardening: **4/4 analyzer tests**, TypeScript and focused
  Biome passed. `checks/wire-coverage-before.txt` reproduces the missed-coverage defect;
  `wire-coverage-after.txt` records the fix. The extension was unchanged by this hardening.
- `checks/state-diagnostics-before.txt` and `state-diagnostics-after.txt` record the
  failing-before/passing-after prompt and duplicate-handoff checks.
- Independent source review found the core request/classifier/proposal/checker changes
  clean. Its analyzer findings were corrected: provider-specific text-only shapes,
  prior non-aborted instruction correlation, and per-fold wire coverage rather than
  aggregate retry counts. The final real workload passes the strengthened analyzer.

## Scope and remaining limits

No default configuration, user session, credential, threshold or preservation policy was
changed by acceptance. The fixed source corpus deliberately represents the baseline under
review, not a regenerated corpus incorporating later fixes. The final run demonstrates
24 successful folds, not guaranteed indefinite operation. Unsupported provider adapters,
history-mirroring providers, unbounded endurance, perfect summary fidelity and model-created
proposal compression are not established by these results. The recorded limitations are
kept separate from the final passing fold and nudge acceptance.
