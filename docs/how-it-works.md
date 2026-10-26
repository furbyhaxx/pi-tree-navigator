# How folding works


A typical autonomous loop:

```text
anchor impl-start
  -> work and tool results accumulate
rewind impl-start as impl-end, with a summary focus
  -> queued until the turn boundary
  -> independent summarization and validation
  -> branch_summary committed; original branch archived
  -> main agent continues with the reduced context
```

A rewind may share its assistant message with other tools and appear anywhere
inside a codemode script. The engine runs after that turn's sibling/nested calls
finish. There is no sole-tool-call or first-nested-call restriction.

### Independent folding

Every entry point uses the same per-session engine:

1. **Snapshot and plan.** Validate the anchor and fresh label, identify the actual
   projected span, preserve unanswered input, and reject unsafe or pre-compaction
   targets. Candidate previews materialize the configured child handoffs,
   continuity briefing and continuation with an output-sized placeholder.
2. **Summarize independently.** Registry-owned calls use the selected model,
   credentials and thinking level. The default is the session model.
   - **In-context:** reuse the captured system/tool declarations and projected
     prefix when the complete summary request fits. Session affinity is retained;
     actual cache reuse is provider-dependent and must be measured.
   - **Chunked:** split selected evidence into bounded extraction requests, then
     bounded reductions. Oversized records are split, not silently truncated.
     A call limit prevents unbounded reduction. A truncated or invalid in-context
     result can fall back to chunking; provider failure and cancellation do not
     silently start another strategy.
3. **Validate the actual result.** The byte-pinned r5d instructions and standing
   authorization section remain. Before branching, preview the real report with
   child reports, ledger, late input and continuation. Refuse a non-reducing or
   over-budget result rather than dropping preserved detail to make it fit.
4. **Commit and refresh.** Revalidate the snapshot, preserve the abandoned branch,
   write the handoff and labels, reappend late input in order, refresh agent
   messages, and signal `session_tree`. A running agent receives a continuation
   at its boundary; no fabricated user prompt is needed.

A queued request is not a completed fold. The outcome reports completion,
cancellation or the failed stage. Cancellation before commit keeps the original
branch; persistence failures during commit are reported separately.

The normal agent conversation no longer receives a summary instruction or runs
a special no-tools summary turn. It is not frozen and no hidden summary attempts
are appended. Old sessions retain readable summary-request/outcome cards and
historical failed tool-result projection through the read-only legacy adapter.

Successful outcomes record the projected context and the summarizer strategy,
calls and usage. Projected token counts are estimates, not provider tokenization.
After a real subsequent request, its recorded usage supplies the observed size.

### Runtime integration

The public `context` hook supplies the canonical edited session projection before
each main request. `context_with_system` captures effective system/tool messages
and provides the pre-request recovery seam. Tool-triggered folds run at
`turn_end`, after complete tool batches.

The extension still captures `AgentSession` instances and refreshes
`agent.state.messages`; notifying history-mirroring providers also uses the
session's extension runner. These integration points are checked by
`scripts/pi-upstream-probe.mjs`. A fold written to disk alone does not establish
that the running agent has received it.

**One-time continuation nudge.** When the first successful post-fold answer is
text-only while the handoff still lists open work, the extension can request one
continuation. It does not repeat indefinitely, override cancellation, or treat an
unanswered user request as permission to continue unrelated work.

### History-mirroring providers (pi-claude-bridge)

[pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge) serves each turn from its own Claude Code session and rebuilds that session from pi's history only when pi signals a rewrite (`session_tree` / `session_compact`). A tool-driven rewind skipped that signal, so the Claude Code query parked at the `navigate_tree` call kept answering with the whole pre-rewind context: the footer stayed at the old percentage because the real request did too (#79).

After every rewind the extension emits `session_tree` with the payload pi's own `navigateTree` emits (`newLeafId`, `oldLeafId`, `summaryEntry`, `fromExtension: true`), after the `agent.state.messages` refresh. The bridge then rebuilds its session from the rewound chain on the next request. `details.historyRewriteNotified` on the continuation message records whether the event went out (`false` when the runner is unreachable or the emit threw; the rewind itself is complete either way).

Cache behavior on the bridge:

- **Independent summary calls.** Registry side requests and chunked evidence are unverified on this history-mirroring provider. A provider that ignores the supplied side-call context is not supported by inference from normal API tests.
- **First turn after the rewind.** That turn is a bridge session rebuild, which per the bridge's README usually misses the prompt cache past the system prompt. It is a one-time write of the rewound chain (tens of k) instead of re-reading the full pre-rewind context on every turn.
