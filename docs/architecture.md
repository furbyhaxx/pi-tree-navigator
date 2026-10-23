# Code overview and invariants

## Code overview

`extensions/navigate-tree/index.ts` registers the `navigate_tree` tool and owns
live rewind lifecycle handling: in-band summary requests, overflow recovery,
branch creation, agent-context refresh and history-rewrite notifications.

- `helpers.ts`: label conventions, validation and formatting.
- `config.ts`: layered global/trusted-project/runtime configuration.
- `runtime-config.ts`: session-ID-scoped in-memory overrides, cleared at session
  start/reload; shared by settings, live navigation and clone proposals.
- `context-tokens.ts`, `rewind-hint.ts`: the single admission estimate (newest
  valid usage plus the scaled tail, else the whole request) shared by the request
  guard, hints, anchor rows and controller; rewind hints and recovery diagnostics.
- `output-budget.ts`: conservative wire-level output caps for overflow recovery;
  request metadata is scoped to the session/model/run, never persisted.
- `summary-prompt.ts`: summary instructions, stored-summary preamble and file lists.
- `summary-request.ts`: immutable, adapter-specific text-only request constraints
  for pending summaries; tool declarations and message arrays remain unchanged.
- `retrospective-plan.ts`: strict graph snapshots, branch-local tool accounting,
  inspection and nested-plan parsing.
- `retrospective.ts`: range validation, clone construction, state checks and publication.
- `anchor-command.ts`, `frame.ts`: the unified `/anchor` command and the shared
  editor-replacing `FrameList` panel (breadcrumb rule, fuzzy search, frozen height).
- `tree-screen.ts`, `fold-screen.ts`: real-entry navigation and the confirmed
  anchor/label/focus fold request; neither screen generates a summary itself.
- `current-screen.ts`: branch-local ledger inspection and user-authorized edits.
- `settings-screen.ts`, `settings-model-picker.ts`: staged scope-aware settings
  with parser validation, model/thinking selection and editable tool policies.
- `clone-screen.ts`, `clone-views.ts`: readable clone/proposal review with explicit
  raw-JSON escape hatches; no implicit provider requests or session switches.
- `retrospective-command.ts`: `/anchor clone` inspection, proposal dispatch, preview
  and confirmation.
- `continuity-ledger.ts`, `continuity-briefing.ts`: pure session continuity ledger
  (goals, rules, decisions, steering, file pointers) with user-authority invariants,
  fold reconciliation and model-facing briefing.
- `continuity-store.ts`: branch-local persistence. Ledger state is the replay of
  `navigate-tree-continuity-ops` entries on the active branch, replaced by the
  snapshot in `branch_summary.details.continuity` at each fold. The fold embeds the
  briefing in the stored handoff and reports rejected agent ops.
- `continuity-capture.ts`: deterministic capture of user intent (rules, decisions,
  objective, steering, `ask_user` answers) with a heuristic classifier and an
  optional model classifier. User words are stored verbatim.
- `proposal-options.ts`: exact model/thinking selectors and tool disclosure rules.
- `proposal-source.ts`: deterministic outlines and filtered full-text source records.
- `proposal-engine.ts`: optional bounded model analysis and explicit heuristic fallback.
- `proposal-model.ts`: registry-authenticated, provider-neutral side calls.
- `proposal-command.ts`: disclosure confirmation, cancellable generation, readable
  plan review, optional advanced editing and exclusive private-plan saving.
- `auto-navigate-config.ts`, `auto-navigate.ts`: wildcard `model_overrides`
  matching and sidecar `auto_navigate` anchor/rewind extraction.
- `handoff.ts`: report metadata, full/synthesized materialization, unique recorded
  statistics and honest model-facing work context.
- `handoff-renderer.ts`: guarded native summary-card and tree-row patches.
- `handoff-projection.ts`: shared native projection patch; stale assistant usage
  is invalidated for budgeting without changing historical accounting. Context
  edits (including edits to the baseline itself), compactions and runtime-state
  changes cannot reuse measurements of a superseded prefix.
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
  Recovery eligibility follows the canonical projection, not summary markers.
- Infeasible recovery plans apply no partial tool-result replacements. Diagnostics
  distinguish proposed changes from applied ones. The final complete-request
  estimate must leave usable output and headroom when navigator recovery owns it.
- Live folds preview materialized child reports, late input and continuation
  overhead before branching. Non-reducing or over-budget estimates fail while
  keeping the original history and preservation policy.
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
- Continuity ledger state is branch-local: the replay of ops entries since the
  last fold snapshot. A fold replaces it with the snapshot on its `branch_summary`;
  a rewind to an earlier branch therefore restores that branch's ledger.
- Ledger authority: items with a user origin (rules, decisions, the objective) are
  never deleted, archived or rewritten by agent or classifier ops. Supersession must
  cite a newer user entry. Rejected ops are reported in the fold result, not applied.
- Continuity capture and fold reconciliation are fail-open: a classifier, store or
  delta failure never blocks a turn or a fold, and a malformed delta applies nothing.
