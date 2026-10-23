---
version: 1
id: "live-acceptance-summary-failure"
title: "Pending rewind summaries can call tools because the summary request still offers them"
description: "Initial long-context failures: summary requests offered tools, and hidden blocked attempts led to identical retries."
type: "analysis"
created: "2026-10-23T11:10:16+02:00"
updated: "2026-10-23T11:52:58+02:00"
createdBy: "analyst (pi subagent)"
updatedBy: "coding-agent"
---
# Pending rewind summaries can call tools because the summary request still offers them

status: "root-caused"
confidence: "high"

## Summary

The in-band summary turn is an ordinary agent-loop request: it is sent with all three
tools declared and no `tool_choice`, so the provider is free to answer with a tool call.
The model does exactly that in 47 of 69 summary requests across the six live sessions.
The `tool_call` gate blocks the call, but the extension then hides the assistant turn,
the blocked tool results and re-sends a byte-identical payload, so the
model never learns it was blocked and repeats the same decision. Two sessions ran out of
the three attempts on their last fold and gave up (early `submit_report`, one meaningless
anchor). The last model-visible text before generation ends on the model's own
`summaryFocus` ("Next action: submit_report …") plus a JSON delta template, several
hundred tokens after "Do NOT use any tool".

## Reproduction

No new calls were made; the two failing sessions are the evidence. Both used
`openai` / `gpt-6-luna` / `openai-responses` (`outcome.json`), commit `5abd2d5`.

```
python3 .project/analyses/live-acceptance/summary-failure/scan-requests.py \
  .project/analyses/live-acceptance/parallel-01/agent-2/wire.jsonl.gz
# req 38 08:59:49 len=21 instrIdx=[20] hash=6cc90ac8f66f  tc=None tools=[navigate_tree, load_partition, submit_report]  calls=[function_call submit_report]
# req 39 09:00:01 len=21 instrIdx=[20] hash=6cc90ac8f66f  tc=None  calls=[function_call submit_report]
# req 40 09:00:15 len=21 instrIdx=[20] hash=6cc90ac8f66f  tc=None  calls=[function_call navigate_tree anchor reviewed-three]
# req 41 09:00:19 len=20 instrIdx=[]   rewind tool result now: "Summarization failed: no summary after 3 attempts (last: called a tool)."
```

Agent-3 is the same shape at `req 42,43,44` (three `submit_report` calls, identical
payload hash `fe3a4b6bbe3de565`), then `req 45/46` anchor `reviewed-four` + a rejected
`submit_report`. Both outcomes: `"submitted": false`, `folds` length 3, `loaded [1,2,3,4]`.

Full-payload SHA-256 (whole `payload`, not just `input`) is identical for every attempt
group in all six sessions: agent-1 `84bf5bb7…`×3, agent-2 `741ea00d…`×3, agent-3
`fe3a4b6b…`×3, agent-4 `41296479…`×3, agent-5 `580c9e64…`×3, agent-6 `3be05443…`×3.

## Root cause

1. The pending-summary request is a normal cached continuation: the instruction is a
   `custom_message` appended after the rewind tool result
   (`extensions/navigate-tree/summary-prompt.ts:98`,
   drafted at `index.ts:1515`). Nothing at the request boundary changes the tool
   configuration: `tool_choice` is absent (`undefined` → provider default `auto`) and all
   three tools stay declared. Verified: `tool_choice` present in **0 of 271** requests
   across the six sessions; `tools` length 3 in every summary request.
2. The gate blocks the call but hides everything the model could learn from:
   `tool_call` returns `{block: true, reason: SUMMARY_PENDING_BLOCK_REASON}`
   (`index.ts:3224`), the loop still produces a tool result
   (`navigate_tree: blocked: the model tried to call a tool instead of summarizing.`,
   session `agent-2` ids `a0a7a613`, `569ca83f`, `906d29ce`), and `turn_end` hides that
   assistant turn and its result, bumps `attempts`, and re-sends the same messages
   (`index.ts:3787`). The design comment says so explicitly: "every failed attempt is
   hidden from the model, so this text is TUI-only" (`index.ts:1368-1373`).
3. Hence the retry is a fixed point: identical payload, same prompt, `temperature 1`.
   Whether it breaks is luck. 4 of 6 sessions eventually got a summary and recovered
   (agent-1 attempts `[1,1,1,3]`, agent-4/5/6 each had a 3-call group followed by a
   successful re-rewind); the two that hit it on their **last** fold lost the fold and
   reported early.
4. Prompt priority amplifies it. The instruction's last ~1.2k characters are the
   model-written `summaryFocus` ("… Next action: submit_report with all four ordered
   partition hashes/findings.") followed by the continuity-ledger block. `Do NOT use any
   tool` sits ~1.4k characters earlier, and the developer message keeps a standing
   mandate that appears to win hierarchy: `ANCHOR_MANDATE` (`index.ts:209`) "list anchors
   and rewind after every milestone". Of the 25 summary attempts whose focus names
   `submit_report` (the final folds), 21 called a tool and 19 called `submit_report`.
   The acceptance prompt itself asks for that focus:
   `scripts/live-navigator-acceptance.mjs:137` — "The summaryFocus must … name the next
   partition to review (after partition 4, submit_report)".
   This is a contributing factor, not the defect: any user-supplied focus can name a
   tool call, so the request boundary must not depend on the prompt tail.

Ruled out: stale instructions. Maximum summary instructions visible in any request is
**1** in all six sessions (checked every item of every request); after a failed pending
the instruction entry is hidden (`agent-2` id `d84e15da`, replaced with `null` at
09:00:19.125) and requests 41/45 show none.

## Evidence

- `parallel-01/agent-2/outcome.json`, `agent-3/outcome.json`: 3 of 4 folds, `submitted
  false`; fold `summaryAttempts` 2/1/3 and 3/1/1.
- `wire.jsonl.gz` both dirs: `req 38/39/40` and `req 42/43/44` are the exhausted groups;
  emitted items are `function_call submit_report` (5×) and `navigate_tree anchor`.
- Session jsonl (`agent-2`): 14 `context_edit` entries, the last four at 09:00:19.125
  hiding the attempt assistant + its `blocked` result and the instruction entry.
- Full request: `payload` keys are `include, input, model, prompt_cache_key, reasoning,
  store, stream, tools` — no `tool_choice`; `tools` = `navigate_tree, load_partition,
  submit_report`.
- Instruction tail verbatim (agent-2 req 40): `Additional focus: … "work autonomously
  until … submit_report accepts the result." … Next action: submit_report …` then
  `Continuity ledger rev N … <continuity-delta>{…}</continuity-delta>`.
- Aggregate tool-call rate per summary request: agent-1 11/15, agent-2 6/9, agent-3 8/11,
  agent-4 7/11, agent-5 11/15, agent-6 4/8 → 47/69 (68%).

## Recommended fix

**A. Request boundary (the deterministic part).** `before_provider_request` is the only
supported per-request lever for the main loop: its result *replaces* the payload
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:693`,
`:1087`; runner applies `currentPayload = handlerResult`, and the documented example is
`examples/extensions/provider-payload.ts:9`). The handler already exists at
`index.ts:2184` but returns early unless a rewind-compaction target exists
(`index.ts:2210`). Add, before that early return, a pending branch that forces the
provider's native "no tools" field on the payload, gated on `livePending(sm, sessionId)`
and on the payload actually carrying tools:

- `openai-responses`, `azure-openai-responses`, `openai-completions`,
  `openai-codex-responses`: `tool_choice: "none"` — adapters write
  `params.tool_choice = options.toolChoice` (`pi-ai/dist/api/openai-responses.js:280`,
  `openai-completions.js:616`, `azure-openai-responses.js:167`,
  `openai-codex-responses.js:399`).
- `anthropic-messages`: `tool_choice: { type: "none" }`
  (`pi-ai/dist/api/anthropic-messages.js:1021`).
- `google-generative-ai`, `google-vertex`: `config.toolConfig.functionCallingConfig.mode
  = "NONE"` (`google-generative-ai.js:307`, `google-shared.js:372-380`).
- `bedrock-converse-stream`: no "none" exists; `toolChoice === "none"` drops the whole
  tool declaration (`bedrock-converse-stream.js:915-918`). Leave unchanged and rely on B.
- Any other API: leave the payload untouched (fail-open), matching the existing
  openai-only guard at `index.ts:2212`.

Why this is safe: the declared tools stay in the payload ("tool envelopes" unchanged),
`input` is untouched and appended-only, so the cached prefix is unaffected;
`tool_choice` is a request parameter, not cached input (inferred from the API contract
and the `prompt_cache_key`/`cacheRead` accounting — UNVERIFIED by a paid call).
The hook runs before the HTTP call and never touches the signal, so cancellation and the
existing `requestBudgetFailures` abort path are unaffected. Revert happens automatically:
`livePending` is false on the next request, so `tool_choice` is only forced on the summary
attempts themselves, identical on every retry.

**B. Append-only closing directive (provider-independent fallback).**
`buildSummaryRequestText` (`summary-prompt.ts:104`) currently ends on the continuity
block/template. Append one final line after everything, e.g.
`\n\nReply with only the summary text above; do not call a tool.` Appending at the end
cannot invalidate a cached prefix and fixes the "instruction is 1.4k characters from the
end, focus imperative is at the end" problem for the Bedrock case and for non-OpenAI APIs.

**C. Make attempts 2 and 3 informative (optional, only if A/B are not enough).** The
block reason already reaches the transcript; returning it instead of hiding it would end
the fixed point, at the cost of a per-attempt visible row (and it stays inside the span
that gets collapsed).

Rejected alternatives: `pi.setActiveTools([])` — tool declarations are snapshotted into
the request and removing them breaks the cached prefix and the harness tool envelope;
`context_with_system` rewriting the system message — same cache cost;
issuing the summary as a side call with `registry.streamSimple(..., {toolChoice:"none"})`
(provider-neutral, proven at `proposal-model.ts:79`) — abandons the in-band
cache-served design of #90 and adds a full extra request per fold.

**Regression test.** Extend `index.test.ts` next to the existing payload helper
(`index.test.ts:9199` `providerPayload`): with a pending rewind, feed an
`openai-responses`-shaped payload `{model, input, tools:[…]}` and assert the result has
`tool_choice === "none"`, the same `tools` array and the same `input`; add an
`anthropic-messages` case asserting `{type:"none"}`, a bedrock case asserting the payload
is returned unchanged, and a no-pending control asserting the payload is unchanged.
Prompt-side: assert `buildSummaryRequestText(...).trimEnd()` ends with the closing
directive (test file `summary-prompt.test.ts`).

Same pattern elsewhere: `capRecoveryOutput` (`output-budget.ts`) is the existing
precedent for a payload edit and already gates to openai APIs; the pending gate must not
reuse the compaction-target early return.

## Open questions / follow-ups

- Acceptance-harness prompt (`scripts/live-navigator-acceptance.mjs:137`, owned by
  another worker) tells the model to name `submit_report` as the next action in the last
  fold's `summaryFocus`. With A in place it is harmless; still worth rephrasing to "the
  next work item is the final report submission" so the fixture stops teaching a
  tool-call imperative.
- Cosmetic: `SUMMARY_PENDING_BLOCK_REASON` (`index.ts:1373`) always says
  `navigate_tree: blocked:` even when the blocked tool was `submit_report` or
  `load_partition`; TUI-only, so low priority.
- If the summary keeps failing on a provider without a "none" control, the extension
  currently gives up after 3 identical attempts with the user's work still un-collapsed;
  whether a failed final fold should auto-retry once with the instruction re-appended is
  a product decision, not covered here.
- Not measured: token/cache effect of adding `tool_choice` (no paid calls made).
