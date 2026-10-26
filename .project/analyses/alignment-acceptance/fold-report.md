---
version: 1
id: "alignment-acceptance-fold"
title: "Live fold acceptance after the Bun/TS migration"
description: "Budgeted real-provider acceptance of manual, preflight, agent, automatic, pressure, fallback, undercount and rerecover folds on refactor/align-toolchain (2d8d135), with main-baseline differentials for the two failures."
type: "analysis"
created: "2026-10-26T18:37:29+01:00"
updated: "2026-10-26T18:37:29+01:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Live fold acceptance after the Bun/TS migration

status: "qa-complete"
confidence: "high"

## Summary

Six of eight documented live scenarios pass on `refactor/align-toolchain` at `2d8d135`: manual,
preflight, agent, pressure, fallback and undercount all fold or compact for real and continue
the same request without a driver prompt. `automatic` fails because the fixture's pressure
threshold (8,000) sits below the fixture's own ~39.6k estimate, so deterministic pressure
compaction preempts the milestone classifier; the identical command fails the same way on
`main`, so this is a stale acceptance fixture, not a migration regression. `rerecover` failed
twice on HEAD with two different proximate assertions: an OpenAI Responses summary stream that
ended without a terminal event (fold fell back to compaction, one recovery instead of two) and a
post-answer continuation turn that left the final message without the acceptance marker; `main`
fails the same scenario on the marker assertion. No migration regression was found. Live
automatic milestone evaluation was recovered by an instrumented run with the threshold raised
(it ran the real classifier pair and abstained, as it did before the migration).

## Environment and method

- Branch `refactor/align-toolchain`, HEAD `2d8d1350c971a5be8eed293c1fa8cccf8bea4017`, working
  tree clean for `src`, `scripts`, `docs`, `package.json` at every run (`invocation.json`
  `dirtyPaths: []`).
- Runner: `node scripts/fold-acceptance/run.ts` (Node 26.11.1 type stripping). Bun was not
  needed; the documented `node` command works unchanged.
- Model `openai/gpt-6-luna` (ChatGPT subscription auth, referenced from
  `~/.pi/agent/auth.json`, never copied). Operating window 96,000 except `undercount` (32,000).
  Thinking level off, SDK retries disabled by the runner. Each run creates its own isolated
  agent dir and workspace under `/tmp`.
- Shared ledger: `.project/analyses/classifier-eval/budget-ledger.jsonl` (cap $25), passed as an
  absolute path; runs are sequential because the ledger takes an exclusive lock.
- Dry run first: `node scripts/fold-acceptance/run.ts --scenario manual --dry-run` → zero
  provider calls, ledger untouched (`dry-run/`).
- Baseline differential: worktree of `main` (`b95fb8a`) at `/tmp/ptn-main`, `bun install`,
  same commands with the same ledger and separate output dirs; worktree removed afterwards.
- Instrumentation for the automatic defect: a copy of `run.ts`/`transport.ts`/`fixture.ts` under
  `instrumented/` with only `AUTOMATIC_CONFIG.rewind_at_tokens` raised to 60,000 (above the
  fixture estimate, below the window). No project source, test or config was modified.

## Test matrix

Evidence paths are relative to this directory; each run holds `invocation.json`, `wire.jsonl`
(safe request/response bodies), `calls.jsonl`, `sessions/<id>.jsonl`, and `result.json` or
`failure.json`.

| Scenario | Verdict | Evidence | Requests | Estimate before → after | Continuation |
| --- | --- | --- | --- | --- | --- |
| manual | pass | `manual/` | 5 (3 side + 2 main) | 114,473 → 1,610 | marker answered; provider input 1,516, cacheRead 0; `summaryStrategy: chunked`, 3 calls |
| preflight | pass | `preflight/` | 6 | 114,473 → 1,887 | recovery fold (origin `recovery`) before first main dispatch; unanswered request re-appended verbatim (`reappendedLateMessages: 1`); input 236, cacheRead 1,536 |
| agent | pass | `agent/` | 5 | 71,525 → 1,944 | model called `navigate_tree rewind` (origin `agent`, Strategy A, 1 call); open request preserved in receipt; input 305, cacheRead 1,536 |
| pressure | pass | `pressure/` | 3 | 76,298 → 20,769 | tail-keeping compaction before the answer (78,045 → 21,096, 16,819 kept); in-context, 1 call; input 20,629 |
| fallback | pass | `fallback/` | 8 | 114,473 → 21,295 | anchorless recovery compacts before the first dispatch (115,539 → 20,878, chunked, 3 calls); input 311, cacheRead 20,864 |
| undercount | pass | `undercount/` | 14 | 21,612 → 2,134 | first request measured 136,397 tokens against a 32k window (heuristic admitted it), recovery compaction 137,082 → 24,320, then a model-initiated fold to `audit-start`; input 1,799 |
| automatic | **fail** | `automatic/` | 2 | — | no classifier call, no fold; pressure compaction wrote `origin: pressure` (39,638 → 6,942) and the agent still answered |
| automatic (instrumented, threshold 60k) | policy ran, abstained | `automatic-instrumented/` | 3 | — | real pair: `openrouter/typesafe/jev-1.14` decisions + `openai/gpt-6-luna` confirmer, 200 each, no milestone, `abstained.json`, exit 0 |
| rerecover (run 1) | **fail** | `rerecover/` | 11 | — | fold to `audit-mid` failed (`provider-error: OpenAI Responses stream ended before a terminal response event`) after a ~15-minute stalled chunk call; best-effort compaction (184,302 → 25,065); 1 recovery, assertion expected 2 |
| rerecover (run 2) | **fail** | `rerecover-02/` | 18 | — | fold to `audit-mid` ok, marker answered at input 117,291; a recovery fold to `audit-start` then failed on the same stream error and compacted (second recovery); after more `navigate_tree` calls a later fold to `audit-start` succeeded (third recovery) and the final message lacks the marker |
| rerecover on `main` | **fail** | `main-rerecover/` | 9 | — | both recovery folds to `audit-mid`/`audit-start` succeeded (184k → 117k → 5.7k), marker answered, then a `continue-nudge` turn produced a final message without the marker |
| automatic on `main` | **fail** | `main-automatic/` | 2 | — | identical to HEAD: `origin: pressure` compaction (39,651 → 7,000), no classifier call, no fold |

Reproduce a single run, e.g.:

```sh
node scripts/fold-acceptance/run.ts --scenario pressure \
  --out .project/analyses/alignment-acceptance/fold/pressure-2 \
  --ledger "$PWD/.project/analyses/classifier-eval/budget-ledger.jsonl"
```

`extract-evidence.mjs <run-dir>` prints the calls, fold/compaction receipts, provider-reported
usage and the post-fold continuation for a run.

## Budget

- Ledger before these runs: spent $2.10027835, held $0.266077903, remaining $22.633643747.
- After: spent $2.10045769, held $0.266077903, remaining $22.633464407.
- This acceptance: 86 reservations, 86 settlements, none unknown, **$0.00017934** actual spend —
  one OpenRouter decisions call. Every OpenAI main and side call settled at $0 with
  `costSource: "subscription"`.
- The $0.266077903 hold is a pre-existing unknown settlement from an earlier crashed run
  (`.project/analyses/classifier-eval/budget-ledger.jsonl`); it stays charged until reconciled.
- Costs are reported by the transport, not estimated: native responses carry no price and settle
  as subscription zero, the OpenRouter decision carries a generation cost.

## Defects

### D1 (major, acceptance harness) — `automatic` never reaches the milestone classifier

Expected: automatic acceptance invokes the real configured milestone policy
(`docs/verification.md`, "Automatic acceptance must invoke the real configured milestone
policy"). Actual: the turn boundary takes the deterministic pressure branch first and compacts;
the classifier pair is never called, so the runner fails at `scripts/fold-acceptance/run.ts:769`.

Causal chain:

1. `scripts/fold-acceptance/fixture.ts:21` sets `rewind_at_tokens: 8000`.
2. The 8-block fixture projects ~39.6k admission tokens, so `activeTokens >= rewindAtTokens` at
   the first boundary (`src/auto/auto-fold-planner.ts:141`).
3. The pressure branch returns before the policy check (`src/auto/auto-fold-planner.ts:145-162`).
4. `pressure` defaults to `"compact"` (`src/auto/auto-navigate-config.ts:54`), and
   `AUTOMATIC_CONFIG` does not override it, so relief is a compaction, not a classifier call or
   fold.

Reproduced on `main` (`main-automatic/`): same receipt (`origin: pressure`, 39,651 → 7,000),
same failure. Introduced by `77f542a` (2026-10-24, ancestor of `main`), i.e. before the
migration branch.

Recommended fix: raise `AUTOMATIC_CONFIG.rewind_at_tokens` above the fixture estimate (60,000
validated in `automatic-instrumented/`) so the milestone path is exercised, and add a runner
precondition such as `assert.ok(initialTokens < rewindAtTokens)` for the automatic scenario so a
future pressure default cannot silently disable the classifier check again. Regression test:
extend `tests/scripts/fold-acceptance/run.test.ts` with the precondition assertion (the planner
ordering itself is already covered by `tests/auto/auto-fold-planner.test.ts`).

### D2 (major, acceptance harness + provider) — `rerecover` is not reproducible on either branch

Expected: two recoveries, then an answered request. Actual on HEAD: run 1 did the fold to
`audit-mid`, got `provider-error: OpenAI Responses stream ended before a terminal response
event` on a chunked summary call, fell back to compaction, and needed only one recovery
(`run.ts:256`). Run 2 folded to `audit-mid` and answered with the marker, then a recovery fold to
`audit-start` failed on the same stream error and compacted (second recovery); the model kept
calling `navigate_tree`, a later fold to `audit-start` succeeded (third recovery), and the last
message omits the marker (`run.ts:266`). On `main` both recoveries succeeded and the marker was
answered mid-run, but a `continue-nudge` turn (`src/fold/fold-receipts.ts:99`) appended a final
non-marker message, so `run.ts:266` fails there too.

The stream error is a provider-boundary event, not migrated code: the same 262,633-byte first
chunk body was sent on both branches (main's fold succeeded, HEAD's fold failed with the stream
error), the acceptance transport differs between branches only in formatting and a `FetchFn`
alias, and the same folds succeeded in manual/preflight/agent/pressure/fallback/undercount on
HEAD. No migration regression.

Recommended fix (harness, no product change required for acceptance): assert the marker on any
assistant message after the last fold/compaction instead of only the final one, and treat one
retry-free run as evidence rather than a verdict when a retained run shows a provider stream
error. Product follow-up worth investigating separately: large chunked summary requests
(~66k-330k-byte bodies over the subscription Responses route) intermittently end without a
terminal event after a multi-minute stall; consider a per-call timeout or a request-size cap.

### D3 (minor, evidence bookkeeping) — stale budget hold

`budget-ledger.jsonl` still holds $0.266077903 from an unknown settlement (a crashed run before
this acceptance). It is faithfully charged against the $25 cap but no run reconciles it; a
reconciling settle would return that budget to the shared ledger.

## Evidence notes

- Migrated controllers exercised live: fold runtime/adapters and fold commit (manual, agent,
  preflight, fallback, undercount, rerecover), independent recovery (preflight, fallback,
  undercount, rerecover), pressure-compaction runtime (pressure, automatic, and the recovery
  fallbacks in rerecover), request guard and turn boundary (all runs), automatic folding
  turn-boundary path (pressure branch live; milestone branch only through the instrumented
  run), continuity entry writes (agent, undercount).
- Provider-observed usage is taken from the session messages, not from projection: e.g. pressure
  continuation input 20,629 against a 96k window; fallback continuation input 311 with 20,864
  cached; agent fold summary in-context (Strategy A) with the main continuation reading 1,536
  cached tokens; chunked Strategy B folds (manual, preflight, fallback, undercount) show no
  promise of the main prefix cache and none was observed on the first post-fold request.
- Continuity entries were written in the agent and undercount folds (`continuity: rev 1,
  applied 0`), and the pressure/fallback receipts carry the preserved state fields; no
  reconciliation or classifier retirement ran in these scenarios.
- The shared ledger file is tracked by git and was appended to by these runs; that diff is the
  only tracked-file change.

## Open questions / follow-ups

- A live automatic *fold* (classifier accepts a milestone, engine folds) remains unobserved; the
  recommended pair abstained on this synthetic transcript, exactly as in
  `.project/analyses/independent-fold-recovery/live/summary.md` (2026-10-23, pre-migration).
  After D1 is fixed, decide whether acceptance requires a fold or accepts a recorded abstention.
- Frequency of the OpenAI Responses stream truncation is unknown (both HEAD rerecover runs hit
  it; `main`'s rerecover run and the other six scenarios did not). Worth correlating with summary
  request size before treating it as noise.
- `continue-nudge` behaviour after an already answered fold: the nudge fires because the turn
  ended right after the rewind, and the resulting extra turn can bury the answer. Product-level
  question (not part of this migration review).
- The $0.266077903 hold should be reconciled so the shared ceiling reflects real spend.
