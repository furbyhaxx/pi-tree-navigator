# Retrospective session cloning

Turn a linear session into nested summary branches after the work has happened.
The source is never edited: conversion creates a new session ID and a suffixed
session name beside the original. Both sessions remain independently resumable.

This is a real context transformation. The active path contains handoff summaries
in place of completed work; `/tree` still exposes the full archived branches.
It does not undo filesystem changes or rerun historical tools.

## Workflow

1. Inspect the session to obtain its source hash and stable entry IDs.
2. Ask your agent to read the transcript and prepare a JSON plan, optionally using
   an existing session analysis as a starting point.
3. Preview the plan. Review the ranges **and the summaries**, including decisions,
   unresolved questions, verification limits, and the final state of each phase.
4. Create the clone. Resume it explicitly when ready; conversion does not switch
   your current session or send a model request.

The converter does not generate or verify the factual accuracy of summaries.
An analysis report's conceptual boundaries may need adjustment to preserve tool
batches, context edits, or compaction-retained ranges. Do not invent missing
handoffs or describe later work as already complete in an earlier subphase.

### Inside Pi

Load this fork, then run:

```text
/tree-clone inspect /absolute/path/to/session.jsonl
/tree-clone preview /absolute/path/to/plan.json
/tree-clone create /absolute/path/to/plan.json
```

`inspect` without a path inspects the current persisted session. The command uses
Pi's editor dialog to display inspection data or the full preview; changes typed
into that dialog are not saved. `create` shows the preview and asks for confirmation
before writing the new session. It requires an idle interactive session.

Commands never append preview messages to the source session. Paths containing
spaces may be quoted. A plan's relative `source` is resolved from its directory;
command paths are resolved from the current working directory.

### Offline CLI

From this checkout (Node 22.19+ and installed dependencies):

```bash
node scripts/restructure-session.mjs inspect /path/to/session.jsonl
node scripts/restructure-session.mjs preview /path/to/plan.json
node scripts/restructure-session.mjs create /path/to/plan.json <preview-token>
```

All successful commands print JSON. Failures print an actionable error to stderr
and exit nonzero. Preview makes no filesystem changes. Its `previewToken` binds
the complete plan and source hash: changing either requires another preview.
Use the CLI for headless operation. Keep private plans outside your Git checkout,
for example beside the source session in a private directory.

## Plan format

```json
{
  "version": 1,
  "source": "./original.jsonl",
  "sourceSha256": "<64-character SHA-256 from inspect>",
  "nameSuffix": " (restructured)",
  "groups": [
    {
      "name": "design",
      "firstEntryId": "<first entry included in the phase>",
      "lastEntryId": "<last entry included in the phase>",
      "summary": "## Goal\nDesign the API.\n\n## Progress\n...\n\n## Next Steps\n...",
      "children": [
        {
          "name": "requirements",
          "firstEntryId": "<first included entry>",
          "lastEntryId": "<last included entry>",
          "summary": "The agreed requirements and unresolved questions..."
        }
      ]
    }
  ]
}
```

- Endpoints are **inclusive** entry IDs, not line numbers. `inspect` shows each
  user message's ID and predecessor: the predecessor of the next user message
  is often a useful end boundary, provided validation accepts it.
- Siblings must be ordered and disjoint. Children must fit inside their parent.
  Nesting is limited to 32 levels. Gaps remain verbatim.
- Names are unique kebab-case, at most 40 characters. Existing `anchor:<name>`
  or `branch:<name>` labels cannot be reused.
- Every group requires its own non-empty summary. A parent summary must preserve
  the important outcomes of its children; the active path sees the parent, not
  its children's summaries as well.
- Leave current/unresolved work outside completed groups when it should remain
  verbatim on the active path. A group may end at the session's last entry.
- `children` and `nameSuffix` are optional. The suffix defaults to
  ` (restructured)` and cannot be empty.
- Unknown plan fields are rejected to catch misspellings.

## Resulting tree

For a phase with two subphases, the clone contains the archived detailed branches,
a child-summary path, and a sibling phase-summary continuation:

```text
phase start
  +-- original subphase A entries [branch:a]
  +-- summary A [anchor:a]
  |     +-- original subphase B entries [branch:b]
  |     +-- summary B [anchor:b] -- phase endpoint [branch:phase]
  +-- phase summary [anchor:phase] -- remaining conversation
```

`/tree` labels let you select full work or summary continuations. The normal
`navigate_tree list` and `rewind` actions recognize the new `anchor:` labels.
Pi's tree is a conversation graph, not a folder outline: nested folds follow
its native branching semantics.

## Safety and supported inputs

- **Version-3 linear sessions only.** Already-branched or legacy files are refused;
  first export a single branch or migrate a separate copy through Pi. Conversion
  never asks Pi to open the source in writable mode.
- Every original entry ID, payload, timestamp, usage and cost record is preserved.
  Only selected parent links change in the clone. Synthetic summaries do not
  claim additional model usage; session totals still include archived history.
- Original compactions keep their summaries and retained-entry references. A cut
  that makes a retained entry leave its compaction's ancestry is rejected, even
  on an archived branch. Move the cut before that retained entry or merge ranges.
- All compactions must be inside completed top-level groups, so none can hide
  the newly created summaries on the final active path.
- A context edit and its target must stay together across every fold. A tool call
  and all its results must stay together across every cut. Orphan results and
  duplicate outstanding call IDs are rejected. Inspection reports unfinished
  calls; creation refuses them until the source run has finished.
- Model and thinking settings are carried forward. Named system sections and
  tool declarations are replayed using explicit deltas. Plain system text may
  only be appended; an incompatible replacement is refused. Effective runtime
  state is compared at original entries and summary continuations.
- The new file has a new ID, `parentSession` provenance, and a suffixed name. A
  provenance entry records the source hash, full plan, and changed parent links.
- Publication uses a private `0600` temporary file, flushes it, reloads it with
  Pi to check context, and publishes with an exclusive filesystem link. An
  existing destination cannot be overwritten. Failure removes the temporary
  file. POSIX publication also syncs the containing directory. A cleanup or
  directory-sync failure after publication is reported as a warning alongside
  the successful clone path. The source hash is checked again immediately before
  publication.
- Conversion is a snapshot. Pause activity in the source while preparing and
  applying the plan; any observed source change causes refusal. Later activity
  in the original does not update an existing clone.
- Extension-specific custom state stays on its original branch. External provider
  histories, sidecar files, worker processes and filesystem state are not cloned.
  A new Pi session ID is not a promise that every third-party extension recreates
  its external state. Check those extensions before continuing automated work.

There is no in-place apply or restore command. To go back, resume the untouched
original. The clone can be removed using Pi's normal session-management UI.
