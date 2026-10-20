# Code overview and invariants

## Code overview

`extensions/navigate-tree/index.ts` registers the `navigate_tree` tool and owns
live rewind lifecycle handling: in-band summary requests, overflow recovery,
branch creation, agent-context refresh and history-rewrite notifications.

- `helpers.ts`: label conventions, validation and formatting.
- `config.ts`: layered global/trusted-project configuration.
- `context-tokens.ts`, `rewind-hint.ts`: context estimates and rewind hints.
- `summary-prompt.ts`: summary instructions, stored-summary preamble and file lists.
- `retrospective-plan.ts`: strict graph snapshots, branch-local tool accounting,
  inspection and nested-plan parsing.
- `retrospective.ts`: range validation, clone construction, state checks and publication.
- `retrospective-command.ts`: `/tree-clone` inspection, proposal dispatch, preview
  and confirmation.
- `proposal-options.ts`: exact model/thinking selectors and tool disclosure rules.
- `proposal-source.ts`: deterministic outlines and filtered full-text source records.
- `proposal-engine.ts`: optional bounded model analysis and explicit heuristic fallback.
- `proposal-model.ts`: registry-authenticated, provider-neutral side calls.
- `proposal-command.ts`: disclosure confirmation, cancellable generation, editable
  plan review and exclusive private-plan saving.
- `auto-navigate-config.ts`, `auto-navigate.ts`: wildcard `model_overrides`
  matching and sidecar `auto_navigate` anchor/rewind extraction.
- `handoff.ts`: report metadata, full/synthesized materialization, unique recorded
  statistics and honest model-facing work context.
- `handoff-renderer.ts`: guarded native summary-card and tree-row patches.
- `handoff-projection.ts`: shared native projection patch; historical assistant
  usage stays in accounting but cannot act as a post-conversion context baseline.
- `history-outline.ts`: manifest-gated chronological containment in `/tree`, with
  a raw native graph escape and navigation through real entry IDs.
- `descendant-sessions.ts`: bounded family discovery and immutable-body copy plans.
- `scripts/restructure-session.mjs`: offline JSON CLI for the same clone engine.

Tests live beside the extension modules and use Node's test runner. The clone
integration tests reopen generated files through the real Pi `SessionManager`;
no model calls are needed. See [verification.md](verification.md) for gates and
live rewind verification, and [retrospective-cloning.md](retrospective-cloning.md)
for the clone workflow and supported inputs.

## Invariants

- Live rewinds preserve the abandoned branch. Their tool call must finish before
  the in-band summary is collected and the new branch is created.
- `anchor:` labels identify rewind targets. `branch:` labels identify archived
  work. Neither namespace may silently overwrite an existing label.
- Only the active ancestry supplies model context; raw history remains available.
  Compaction and context edits affect projection, not source message payloads.
- A retrospective operation never edits the source file or opens it through a
  writable session manager. It publishes only a new, independently named session.
- Conversion must preserve original payloads and accounting, valid tree references,
  completed tool batches, effective context edits, and replayable runtime state.
  Unsafe plans fail before a clone is published.
- Parent context policy is frozen at fold time. Full mode inserts each child
  handoff once in child order; synthesized mode keeps the reviewed parent report.
  Inclusive statistics union unique source IDs; they never create new billing.
- Chronological containment is presentation metadata, not context ancestry.
  Native tree navigation always targets a real persisted entry ID.
- Descendant copies retain original bodies and receive new header IDs/remapped
  parent paths. The root inherits its source parent rather than linking to it.
- Plans and previews are bound to source bytes. Summaries are reviewed input,
  not evidence that the converter independently checked historical claims.
- Preview and inspection never append content to the inspected session, and
  clone creation never implicitly resumes it or triggers a provider request.
- Model analysis is opt-in. Configured tool exclusions apply before requests;
  invalid disclosure policies block analysis. Generated IDs/ranges/provenance are
  validated locally, and cancellation never publishes a plan or session.
- Existing graph edges remain unless an explicit completed fold redirects a
  continuation. Native rewind summaries can establish completion of tool calls
  through real results in their referenced archived history; no results are invented.
