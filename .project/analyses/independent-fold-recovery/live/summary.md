---
version: 1
id: "independent-fold-live-acceptance"
title: "Independent fold live acceptance: running results"
description: "Budgeted synthetic manual, preflight and agent scenarios; failed evidence retained. Acceptance remains incomplete."
type: "analysis"
created: "2026-10-23T19:21:08+02:00"
updated: "2026-10-23T19:58:23+02:00"
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
