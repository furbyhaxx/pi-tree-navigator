# Chronological handoffs and retrospective cloning

Turn a linear or branched session into a chronological, nested work history. Conversion creates
new session files; it never changes the source. Completed phases fold into work
handoffs, while the current branch can remain open inside an implementation phase.
The source and clone are independently resumable.

A handoff records the goal/topic/scope, work done, decisions and reversals,
deliverables, verification and its limits, commits, still-open or deferred work,
and key facts needed next. Summaries describe historical work; they do not undo
filesystem changes or ask the agent to repeat completed tasks.

## What users and agents see

The extension patches Pi's native summary card in memory. The default card shows
the title, goal, outcome, messages/tool calls, recorded input/output/cache tokens,
and recorded inclusive cost. Ctrl+O or a fullscreen mouse click expands the full
report. Statistics describe unique recorded source entries, not new charges.
Parent totals include their children; do not add parent and child totals together.

For converted sessions, `/tree` opens a chronological containment outline:

```text
Orientation and architecture design (folded)
Specification and examples (folded)
Implementation campaign (open)
  Step 3 execution and verification (folded)
    Earlier completed subphases...
  [current] Branch and worktree cleanup (open)
    user: ...
    assistant: ...
```

Enter or Space folds/unfolds a group. `r` resumes **after its handoff**. Enter on
an original message uses Pi's normal navigation. `/` searches and reveals matching
descendants; Escape clears the search or closes the selector. F2 switches to the
raw native conversation graph, including its original labels and filters.
Containment is distinct from context ancestry: a child displayed under a phase
can be resumed at its historical point, before that phase's final handoff existed.

The agent receives the **full selected handoff text**, never the collapsed UI
placeholder. Navigator-owned projected summaries become honest work-context
messages, without Pi's alternative-branch preamble. Native persisted summaries
remain available to Pi and exports. With the extension unloaded, Pi's stock card
and model conversion apply. Independent history-mirroring providers may rebuild
from persisted records rather than this context hook; that provider behavior
needs separate live validation.

Native rendering and tree patches are guarded, session-scoped and reversible.
An incompatible host falls back to native rendering. They do not patch installed
files or require a different Pi-Bolt build.

## Parent context policy

Choose `parentHandoffMode` in global or trusted-project `tree-navigator.json`:

```json
{ "parentHandoffMode": "full" }
```

- `full` (default): keep the parent's own report and its completed child handoffs
  once each in child order, recursively. Children retain historical states;
  the parent report explains the later outcome and superseding decisions.
- `synthesized`: keep only the parent's relevance-focused report. Child reports
  stay in the archived history. The parent may need a longer report; live parent
  summaries have no fixed 4,000-character cap. Preserve what remains relevant
  rather than repeatedly squeezing every phase into the same length.

A valid trusted-project value overrides the global value. Invalid values warn
and fall back to the other valid layer, then `full`. The chosen policy is frozen
in each handoff. Changing the setting does not silently rewrite old context.
A retrospective plan has its own default policy and optional per-group override.

Synthesis is not a mechanical truncation. For retrospective conversion, provide
a reviewed parent report informed by the child reports. The converter does not
make model calls or establish that the report's claims are true.

## Workflow

1. Inspect the source to obtain its hash and stable entry IDs.
2. Derive a heuristic tree locally, optionally refine it with a model, and review
   the resulting nested range/report plan.
3. Preview the groups, handoffs, context policies and descendant session list.
4. Review every report, then create the clone. Creation does not switch sessions
   or send a provider request.

### Inside Pi

```text
/tree-clone inspect /absolute/path/to/session.jsonl
/tree-clone propose /absolute/path/to/session.jsonl
/tree-clone propose /absolute/path/to/session.jsonl --llm
/tree-clone propose /absolute/path/to/session.jsonl --model openai/gpt-6-luna:high
/tree-clone preview /absolute/path/to/plan.json
/tree-clone create /absolute/path/to/plan.json
```

`inspect` without a path inspects the current persisted session. Inspection and
preview use Pi's editor dialog as a viewer; edits there are ignored. `create`
requires an idle UI session and confirmation. No command appends preview content
to the source. Quoted paths support spaces.

`propose` without a path uses the current session. It derives names, titles and
nesting from existing labels, user turns and rewind summaries. Where completion
is not established, heuristic groups stay open rather than inventing a report.
The model receives that baseline and the permitted textual history to refine
markers, labels, nesting, goals, outcomes and completed handoffs.

Model analysis requires explicit `--llm` or `--model` and a disclosure/charge
confirmation. It uses Pi's model registry and existing credentials without
switching the current session model. The default model and thinking level are
the current session's; `provider/model:thinking` overrides both for the side call.
Escape cancels generation. No clone is created by proposing a tree.

The proposal shows a tree outline, then an editable plan. Cancelling the editable
review saves nothing. Accepted plans are saved as new `0600` files in the source's
`.tree-clone-plans/` directory, or the explicit `--output <plan.json>` path.
Existing files are never overwritten. Source changes during generation require
a new proposal. Preview and clone confirmation are separate steps.

### Proposal input and model configuration

Global and trusted-project `tree-navigator.json` accept:

```json
{
  "treeProposal": {
    "model": "openai/gpt-6-luna:high",
    "tools": {
      "bash": "calls-only",
      "read": "omit",
      "grep": "full"
    }
  }
}
```

- With no configured model, or `"model": "current"`, use the current session
  model and thinking level. A selector without `:thinking` reuses the current
  thinking level, clamped to the target model's supported levels. An explicit
  unsupported thinking level is rejected. No model is selected or contacted for
  heuristic-only proposals.
- Full textual history is the default, including archived branches, assistant
  text/thinking, tool arguments/results, existing reports, labels and markers.
  Image/binary content and opaque signatures are omitted and reported.
- `full` includes a tool's textual call and result; `calls-only` retains arguments
  but omits result bodies/details; `omit` removes arguments and results. Exact
  tool names are matched through tool-call IDs; minimal graph metadata remains.
  The `bash` rule also covers native `!`/`!!` shell records and their context edits.
- Tool rules merge per name across trusted layers. Command flags
  `--omit-tool <name>`, `--calls-only-tool <name>` and `--full-tool <name>` override
  that request. Model selection can be overridden with `--model`.
- Invalid disclosure settings block model requests rather than silently sending
  more history. Untrusted project configuration is never read.
- These rules filter structured tool records, not copies already quoted in user
  messages, assistant prose or historical summaries. Review sensitive history
  before authorizing a provider request.

A history that fits the model's budget is refined directly in one request.
Large histories use multiple bounded requests and hierarchical consolidation;
permitted textual records are not silently truncated. Consolidation is limited
to three rounds and must reduce evidence size by at least 25% per round;
otherwise it stops with an explicit heuristic fallback and recorded usage.
An outline that cannot fit the selected model is rejected before any model request. Progress and proposal
usage are reported separately from the source session's historical accounting.
Provider failures, malformed output, unknown entry IDs or unsafe generated graph
cuts produce an explicit heuristic fallback; cancellation does not save a plan.
Model output cannot replace the source path/hash, and every proposed range passes
the deterministic converter's integrity checks before saving. Summary accuracy
still requires human review.

### Offline CLI

From this checkout with installed dependencies and Node 22.19+:

```bash
node scripts/restructure-session.mjs inspect /path/to/session.jsonl
node scripts/restructure-session.mjs propose /path/to/session.jsonl --output /path/to/plan.json
node scripts/restructure-session.mjs propose /path/to/session.jsonl --model openai/gpt-6-luna:high --calls-only-tool bash --output /path/to/plan.json
node scripts/restructure-session.mjs preview /path/to/plan.json
node scripts/restructure-session.mjs create /path/to/plan.json <preview-token>
```

Success prints JSON; failure prints an error and exits nonzero. Preview writes
nothing. Its token binds the normalized plan, source bytes, descendant membership
and hashes, and reviewed descendant plans. Any change requires a new preview.

CLI `propose` prints the proposal, outline, warnings and observed analysis usage;
`--output` also saves its plan. Explicit `--llm`/`--model` authorizes provider
requests without an interactive dialog. The CLI reads global proposal settings
only; use flags for project-specific rules. Its default model/thinking comes from
the source's recorded state when the global model is absent/current. A standalone
CLI may not have providers registered by interactive extensions; select a model
available in its registry. Other CLI operations remain offline.

## Plan

```json
{
  "version": 1,
  "source": "./original.jsonl",
  "sourceSha256": "<SHA-256 from inspect>",
  "nameSuffix": " (restructured)",
  "parentHandoffMode": "full",
  "recurse": false,
  "groups": [
    {
      "name": "implementation",
      "title": "Implementation campaign",
      "state": "open",
      "firstEntryId": "<phase start>",
      "lastEntryId": "<current tail>",
      "children": [
        {
          "name": "parser",
          "title": "Parser implementation",
          "state": "folded",
          "mode": "full",
          "firstEntryId": "<first included entry>",
          "lastEntryId": "<last included entry>",
          "goal": "Parse the input dialect.",
          "outcome": "Parser delivered and regression-tested.",
          "summary": "## Goal\n...\n\n## Delivered\n...\n\n## Decisions\n...\n\n## Rejected or Superseded\n...\n\n## Verification\n...\n\n## Commits\n...\n\n## Open or Deferred\n...\n\n## Key Facts\n..."
        },
        {
          "name": "current-tests",
          "title": "Integration tests",
          "state": "open",
          "firstEntryId": "<next work starts here>",
          "lastEntryId": "<current tail>"
        }
      ]
    }
  ]
}
```

- Ranges are inclusive IDs in append order, not line numbers. Siblings are ordered
  and disjoint; children fit inside their parent. Gaps stay verbatim. Open ranges
  can annotate existing graph regions without flattening them. Folded ranges
  require a single external incoming parent; rewinds inside that region are allowed.
  A cut with unrelated incoming branches is refused instead of silently rewired.
- Names are unique kebab-case, at most 40 characters. Reserved labels cannot be
  reused. Titles may be readable prose.
- `state` defaults to `folded`. Folded groups require non-empty reviewed reports.
  Open groups keep their raw history and completed child handoffs; an open child
  requires an open parent. `[current]` follows the current enclosing open group.
- `mode` overrides the plan's `parentHandoffMode`. The plan defaults to `full`.
- `goal` and `outcome` are optional display facts; otherwise they are extracted
  from report headings. Do not invent them when the history does not establish them.
- Child reports are inserted in chronological child order after the parent's own
  final report. Raw messages remain on their archived branches. This is an ordered
  handoff bundle, not a verbatim chronological interleaving of every parent sentence.
- Nesting is limited to 32 levels. Heuristic proposals keep deeper history raw
  inside the last supported open phase and report the annotation-depth limit.
  Every generated/saved plan passes schema parsing. Unknown fields are rejected.
- Relative `source` and `descendantPlans` paths resolve from the plan file.

## Descendant session families

Creation **copies descendant session histories unchanged by default**, including
nested worker/reviewer sessions. Each copy gets a new header ID/timestamp and its
`parentSession` points to its copied parent. Transcript bodies, including names,
usage and custom records, remain byte-identical. The root clone inherits the
source's `parentSession`: it is a sibling if the source has a parent, otherwise
it remains top-level. Source provenance is recorded separately.

Discovery follows actual canonical file-path links. It scans the source directory
and, for a conventional `sessions/--project--/` store, its sibling encoded project
directories. It does not search the whole filesystem or infer relationships from
agent names. Missing external sidecars and provider histories are not copied.

Opt into restructuring the descendants too using the plan:

```json
{
  "recurse": true,
  "descendantPlans": ["./worker-plan.json", "./reviewer-plan.json"]
}
```

Each descendant needs its own reviewed plan and source hash. The converter refuses
missing plans rather than silently treating recursive work as done. Root and child
plans use the same supported-input rules; already-branched descendants can still
be copied unchanged, and restructuring one uses the same graph-safety rules.
No automatic analysis or paid model requests are triggered by `recurse`.

## Integrity and limits

- Inspection and restructuring accept version-3 native session trees. Parents
  must precede children; duplicate IDs, missing targets and invalid references
  are refused. Existing rewind ancestry, summary `fromId` references (including
  Pi's `root` sentinel), labels and archived histories remain intact. New folds
  redirect continuations only at their explicit boundaries.
- Ordinary descendant copying preserves bodies without trying to restructure them.
- Every original entry ID/payload/timestamp/accounting record is retained inside
  its cloned session. Synthetic reports do not claim additional model usage.
- Compactions keep their original summary and retained-entry reference. Unsafe
  crossed boundaries are rejected even on archived branches. No compaction may
  hide newly created handoffs on the final active path. Open-only annotations do
  not invalidate an unchanged original compaction.
- Context edits stay with their targets across folds. Tool calls stay with their
  results. Orphan results, duplicate outstanding call IDs and unfinished source
  tool batches are refused for restructuring.
- Model/thinking state, system sections and tool declarations are restored and
  checked at original positions and summary continuations. Incompatible plain
  system-text replacements are refused.
- Original assistant usage still contributes to historical billing. While this
  extension is loaded, those pre-conversion measurements are invalidated as live
  context-size baselines, including Pi's native pre-request estimate. New assistant
  turns supply fresh measurements; no recorded usage is erased from the files.
- New files are staged with `0600` permissions and flushed before exclusive
  publication. Root context is checked by reopening through Pi. Source/family
  hashes and membership are checked before publishing. Failures roll back only
  the new files from that attempt; original files are never opened for writing.
- Each file publishes atomically; a process crash halfway through a multi-file
  family is not a filesystem-wide transaction. Parent/source paths in remaining
  copies still do not modify or reparent the original family.
- POSIX publication syncs containing directories. Post-publication temporary-file
  cleanup or sync failures are reported with the successful output paths.
- Pause activity while reviewing and creating a snapshot. Later source activity
  does not propagate to an existing clone.
- Extension custom state remains historical. Worker processes, external provider
  sessions and filesystem work are not recreated by copying their session records.

Resume the untouched original to go back. Use Pi's session-management UI to remove
unwanted clones. A conversion never replaces the original in place.
