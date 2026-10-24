---
version: 1
id: "independent-fold-live-acceptance"
title: "Independent fold live acceptance: running results"
description: "Budgeted synthetic manual, preflight and agent scenarios; failed evidence retained. Acceptance remains incomplete."
type: "analysis"
created: "2026-10-23T19:21:08+02:00"
updated: "2026-10-24T19:02:56+02:00"
createdBy: "coding-agent"
updatedBy: "coding-agent"
---

# Independent fold live acceptance

These runs use the production extension and real SDK with synthetic seeded service-audit history. Historical fixture assistant messages are explicitly synthetic, not provider observations. Runtime provider responses and serialized transport bodies are captured in each run's `wire.jsonl`; no private session or credential stores are copied. All main and side calls pass through the reviewed budget transport, with SDK retries disabled.

The fixture sets a 96,000-token operating window. Projected context figures below are estimates, not measured provider input. Each run's `invocation.json` records source commit, dirty source paths, options and start time. The retained session records are in `sessions/`.

## Results

- `manual-dry-01`: zero-network dry run passed; no ledger changes.
- `manual-01`: passed. Initial estimate 114,473 → final 2,214 tokens. Three independent summary requests ran before the first main dispatch. Seven requests total. Ledger spend increased from $0.639614463 to $0.655601816. Source precedes the current-evidence projection hardening.
- `preflight-01`: passed on `80ffe57`. Initial estimate 114,473 already exceeds the 96,000-token window; independent summarization precedes the first main dispatch. The unanswered request is re-appended verbatim after the handoff, and the main model responds without a new user prompt. Final estimate 1,885 tokens; six requests total. Ledger spend increased to $0.671319048.
- `agent-01`: **failed**, on `80ffe57`. The model called the rewind tool, the independent summary completed and a handoff was committed. The subsequent model did not satisfy the latest user's requested response. Failure receipt and full evidence retained; no follow-up prompt was injected.
- `agent-02`: passed on `2f059aa`, after deterministic active-request preservation (`0196d1c`). The acceptance assertions and prompt were unchanged. Initial estimate 71,525 → final 2,050 tokens; five requests, one independent summary. The main model answered the requested marker after folding without a driver follow-up. Billed cost for this run: $0.010506412.

## Agent failure diagnosis

The summary request body contains the latest user message, including `UNANSWERED-ACCEPTANCE-7d9a` and the instruction to reply with `ACCEPTANCE-CONTINUED` after folding. Its HTTP response is 200. The generated handoff omits this instruction and instead describes a future comparison as blocked pending artifacts. The main model follows that handoff, requests the artifacts and omits the requested response marker.

This is loss of the active request through summarization, not a failure to dispatch or resume the main model. The acceptance assertion remains unchanged. Commit `0196d1c` preserves open user requests verbatim with original source IDs in the continuation and prices their full size in the shared preview. Repeated folds carry typed request details instead of recursively copying old continuations. Tool calls and custom notifications do not close a request. Regression coverage includes a summarizer that omits the request, and the unchanged `agent-02` live rerun passes.

## Offline integration

After canonical boundary and current-evidence hardening, 25 targeted tests passed across `fold-inputs.test.ts`, `preflight-recovery.test.ts`, `recovery-cut.test.ts` and `scripts/fold-acceptance/run.test.ts`; TypeScript passed. These cover edited evidence, interleaved-input refusal, archived tool completion, cancellation and real SDK/local-provider execution. They are distinct from live-provider evidence.

## Budget and open work

At the latest ledger read: $0.692649261 billed, $0.266077903 held, $24.041272836 remaining from the authorized $25 ceiling. Holds remain charged against available budget until reconciled.

Agent-request preservation passed its targeted live rerun. Final-source recovery/automatic scenarios, late-input persistence hardening and interactive TUI acceptance remain open. The individual passing runs do not complete the full acceptance scope.

## Final-source acceptance (2026-10-23, evening)

Added after the snapshot above; all runs use the shared ledger and synthetic fixtures.

| Run | Result |
| --- | --- |
| `tui-dark-130-01` | passed: plan at 60/130 cols, search, advanced-label cancel, Esc cancel, real fold 76.2% → 0.8%, redraw, summary card |
| `tui-light-60-01` | passed: regular/light/60 cols, plan ~73.2k → ~9.7k, folded freed ~72.6k, footer 76.2% → 0.8%, one side call |
| `automatic-01` | failed: the model navigated itself, so the check saw nothing since its own newest anchor |
| `automatic-02` | failed: with `navigate_tree` inactive the controller correctly refuses to run |
| `automatic-03` | policy ran (jev-1.14 decisions + gpt-6-luna confirmer), pair abstained, no fold |
| `automatic-04` | recorded abstention: `abstained.json`, exit 0, no fold claimed |

Budget after these runs: billed $0.7273 of the authorized $25.

**Open limits.** Automatic milestone folding is wired and its classifier pair runs
live, but no live automatic fold was observed: on the synthetic transcripts the
recommended confirm policy abstained. That is a safe outcome, not a passing
compression result. Abstention is currently silent in the TUI; a persisted
warning is still missing.

The parity suite now documents that the recorded supersession benchmark predates
the retirement-verification stage, so replaying it through the shipped policy
abstains instead of reproducing the recorded retirement.

The installed build remains `229afe0`. Folding inside this working session is
impossible until the engine build is installed and reloaded: its pre-request
guard aborts at 367k/372k, which is the originally reported deadlock.

## Pressure compaction (2026-10-24)

`pressure-01` (source `695f1a5`, `openai/gpt-6-luna`, 96k window, 16 blocks,
`rewind_at_tokens` 64,000, `keep_recent_share` 0.25): **not executed**. The first
main request returned OpenRouter `402 Insufficient credits`; no summary or
compaction ran and the call settled at $0. This is an account-balance blocker,
not a product result. Pressure compaction remains unverified against a real
provider; offline coverage is the SDK-loop host tests in `index.test.ts`.
