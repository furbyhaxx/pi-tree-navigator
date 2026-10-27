---
version: 2
id: "research-task-tracking-proposal"
title: "Durable nested task tracking for pi-tree-navigator: architecture and widget proposal"
description: "Synthesis of pi ecosystem, agent harness and paper research into architecture options, a recommended v1, subagent assignment design, fold-summary integration, tool surface, transcript entries and an above-editor task widget wireframe."
type: "research"
created: "2026-10-20T14:28:08+02:00"
updated: "2026-10-20T14:54:05+02:00"
createdBy: "claude-agent"
updatedBy: "claude-agent"
status: "proposal"
inputs:
  - "inputs/pi-ecosystem.md"
  - "inputs/harness-patterns.md"
  - "inputs/papers-and-ui.md"
---

# Durable nested task tracking for pi-tree-navigator

Design input, not a committed plan. Product code was not changed.

## 1. Problem

Agents stop using todo tools, or forget to mark items done, because the task
state does not survive the moments that matter: folds (`navigate_tree rewind`),
`/tree` navigation, forks and compaction. Every surveyed pi extension restores
state as "last snapshot on `getBranch()` wins" (inputs/pi-ecosystem.md §4.1).
A fold moves the leaf to the anchor and appends a `branch_summary`, so every
snapshot written inside the folded range is now on the abandoned branch. The
result is a silent revert: done work reappears as pending, the summary prose
disagrees with the widget, and short IDs get reused ("ghost IDs").

`plan-mode` (pi example) is the counter-example: it parses `Plan:` blocks and
`[DONE:n]` markers from assistant prose and restores from `getEntries()`
instead of the active branch. Both break under folds and forks.

Evidence that this matters beyond pi (inputs/papers-and-ui.md §8):

- CONPACT: compactors kept 17% of injected side constraints. Re-injecting
  them from a separate store restored retention to over 90%.
- ARC: ID-addressable recall reached 99.40% vs 88.12% for the best
  summary-based baseline.
- Claude Code documents "task status can lag" as a known failure of its
  shared task list (inputs/harness-patterns.md §1.2).

Design rule taken from all three: **task state is structured data with an
authority outside the prose. Summaries project it; they never carry it.**

## 2. What the research says works

| Pattern | Seen in | Keep? |
|---|---|---|
| Tool-result `details` snapshot, replayed from `getBranch()` | pi `todo.ts`, rpiv-todo, pi-todo-herdr | Yes, as the per-mutation record. Branch-correct for free. |
| Fold carries state in `branch_summary.details` | pi core supports it; nobody uses it | Yes. This is the missing piece. |
| Re-inject a hidden state block at the summary boundary | `@narumitw/pi-progress` | Yes, for the model-facing copy. |
| Files as authority + branch pointer entry | `pi-goal-x`, `cabi/pi-todos`, doompi-task | Yes, for persistent plans only. Not branch-correct. |
| Free-text `[DONE:n]` parsing | `plan-mode` | No. |
| `getEntries()` restore | `plan-mode` | No. Reads abandoned branches. |
| Shared mutable task file with lock-based claiming | Claude Code teams | No for v1. Causes status lag. |
| Append-only events, status derived at read time | OpenHands, LangGraph | Yes. |
| Stable identity for resume; fork is additive | Claude Code, LangGraph | Yes. |
| Nesting as an ID path | LangGraph `checkpoint_ns` | Yes. |
| Stale-task reminders | rpiv-todo, pi-todo-herdr | Yes. |
| Typed attachments (fact / decision / note / file) | Magentic-One ledger, ADRs, PROV | Yes. |

## 3. Concept model

Four layers. They have different lifetimes and different authorities, and
they must not share one store.

| Layer | Lifetime | Authority | Branch-correct |
|---|---|---|---|
| **Todo list** | Project, scoped to a session or plan node | Project ledger (§4 D); session entries are receipts | No; history is viewable per receipt |
| **Plan** | Project, many per namespace | Files under `.project/plans/` | No (single timeline) |
| **Backlog** | Project | One file per feature under `.project/backlog/` | No |
| **Roadmap** | Project | `.project/roadmap.md`, rolls up backlog status | No |

A todo list is standalone or bound to a plan node (`planRef`). Binding
narrows the list to a slice of the plan. Plan sync is automatic and never
waits for a human:
- When a bound task is done (or its subagent result is accepted by the
  parent agent), the plan node is updated in the same step.
- Every plan write is a ledger transaction with actor, origin session and
  revision, so any change can be reviewed or reverted later.
- The widget shows a dim `· synced plan r13` note. Nothing prompts.

All acceptance in this design is done by the parent agent, not by the
user. The user can step in through `/tasks`, but nothing waits for them.

### 3.1 Task record

```ts
type TaskStatus =
  | "todo" | "active" | "blocked" | "waiting" // waiting = needs user input
  | "done" | "cancelled" | "failed";

interface Task {
  id: string;            // stable internal id, never reused: "t_01J…"
  key: string;           // short handle shown to model and user: "S4a"
  parentId?: string;
  title: string;
  status: TaskStatus;
  blockedBy?: string[];  // task ids; "blocked" is derived when any is open
  owner?: Owner;         // { kind: "main" | "subagent" | "user", id }
  acceptance?: string[]; // copied verbatim into folds and assignments
  attachments: AttachmentRef[];
  planRef?: { planId: string; nodeId: string; rev: number };
  verified?: { by: string; at: string } ; // set when the owner of acceptance accepts
  createdAt: string; updatedAt: string;
}
```

- `key` comes from a monotonic counter that is part of the snapshot, so
  rewinds cannot hand out a key twice. The model addresses tasks by key;
  storage uses `id`.
- `◐` is a derived parent state (some children done), not a stored status.
- Parent status rolls up from children unless set explicitly.

### 3.2 Attachments

Four kinds, kept apart because they have different truth conditions
(inputs/papers-and-ui.md §9.3):

- **note**: Markdown, append-only.
- **fact**: `{ text, kind: "given" | "lookup" | "derived", source }`. A fact
  without a source is flagged.
- **decision**: ADR-shaped `{ context, decision, consequences, status:
  "accepted" | "superseded" | "reversed", supersedes? }`. Never edited in
  place.
- **file**: `{ path, sha256?, role: "input" | "output" }`.

v1 embeds attachments in the snapshot with size caps (for example 4 KB per
note). Do not reference transcript entries by id: `/fork` copies only the
active ancestry, so a reference into a folded range dangles. If snapshots get
too large, v2 moves bodies into a content-addressed blob store and keeps only
hashes in the snapshot.

## 4. Architecture options

### A. Branch-local event log with fold checkpoints (not chosen)

Kept for comparison. Its receipt mechanics (tool-result `details`, summary
`details`) are reused by option D for historical views.

- Agent mutations go through the task tool. Each tool result carries
  `details: { v: 1, rev, ops, snapshot }`, the documented channel for state
  that follows the active branch.
- User edits from the TUI are written with `pi.appendEntry` while the agent
  is idle (`customType: "navigate-tree-tasks"`).
- A fold writes the full snapshot into the **same** `branch_summary` entry it
  already creates: `details.treeNavigator.tasks`.
- The reducer walks `getBranch()` from the leaf back to the most recent
  checkpoint (summary snapshot, tool-result snapshot or user entry) and applies
  later ops.

Pros:
- Branch-correct by construction, with no second authority.
- A fold is atomic: state and summary land in one entry, so there is no crash
  window between them.
- Fork copies the path, so the copy starts with the right state.

Cons:
- Session-scoped. Plans that outlive a session need layer C.
- Only folds made by `navigate_tree` carry state. Native `/tree` summaries
  need the hook in §6.3.

### B. Sidecar store per session family, branch pointer in the session

A JSONL ledger beside the session file, plus a pointer entry (the `pi-goal-x`
pattern).

Pros:
- Survives everything, and other processes can read it (useful for
  subagents).

Cons:
- Not branch-correct. `/tree` back to an earlier point shows future state.
- Two branches share one store and interfere.
- Forks need explicit copy semantics, and garbage collection is unsolved.

### C. Project file store for Plans, Backlog and Roadmap

Markdown with YAML frontmatter under `.project/`. Stable ids in a strict,
parseable checklist grammar, a `version` revision for optimistic concurrency,
and round-trip-safe writes.

Pros:
- Human-readable and reviewable in git.
- Matches the existing `.project/` artifact convention.
- Manus' `todo.md` recitation pattern.

Cons:
- Single timeline.
- Concurrent writers need revision checks.

### Decision (2026-10-20): project ledger is the authority

The user chose a **project ledger** as the single authority for todo state,
with **C for plans, backlog and roadmap**, linked by `planRef`.

Option A is demoted. Session entries are *receipts*: they record which ledger
revision a point in the conversation saw. They never hold canonical state.

The reason: files are not rolled back by `/tree` or by a fold. A branch-local
list would show work as open even though it exists on disk, which invites
duplicate work (§12a).

### D. Project ledger (chosen)

- **Location:** `$XDG_STATE_HOME/pi-tree-navigator/projects/<project-id>/`.
  - `ledger.jsonl`: append-only, one transaction per line.
  - `snapshot.json`: a materialized view, rebuildable from the ledger.
  - `lock`: pid lock, held only while a transaction is written.
- **Project identity:** a stable id stored in `.pi/tree-navigator.json`
  (`projectId`), created on first use. Worktrees and checkouts resolve to the
  same id through that file. Agent profiles and sessions never create
  projects implicitly.
- **Transactions:** `{ txId, idempotencyKey, baseRev, rev, actor, origin:
  { sessionId, entryId }, ops }`.
  - Commit means: append the line, fsync, then update `snapshot.json`.
  - A stale `baseRev` is rejected.
  - A repeated `idempotencyKey` returns the original result, so retries are
    safe.
- **One writer:** the main session's coordinator is the only writer.
  Children submit reports (§8). A second main session that tries to write
  while the lock is held is rejected with a clear error. Concurrent writers
  are not merged.
- **Export:** `/tasks export` writes the ledger slice for a session into the
  session directory, so an exported session can be inspected without the
  ledger.
- **Missing ledger:** session receipts still render as historical views. An
  explicit `/tasks import` can rebuild a ledger from the newest receipt. A
  receipt is never promoted to canonical state silently.

The second-opinion reviews narrowed this further:

- Revision-checked, idempotent mutations.
- Folds observe; they never transition tasks (§6.1).
- Unknown schemas fail loudly instead of yielding an empty list.

## 5. Behavior at tree boundaries (proposed invariants)

These belong in `docs/architecture.md` once implemented.

1. **The ledger is the only authority.** Tools, widget and re-injection all
   read the current ledger state. Session entries are receipts
   (`{ projectId, rev }` plus a bounded historical snapshot).
2. **Folds observe; they do not transition.** A fold records the ledger
   revision that is current when it runs. If the fold write fails, task
   state is unaffected.
3. **Navigation never rewinds the ledger.** After `/tree` to an earlier
   point, the current state is still shown. When the receipt at the new
   leaf is older than the ledger, the next request gets a bounded
   reconciliation note: what changed since that revision.
4. **Forks and clones do not reclaim assignments.** Assignment records found
   in copied entries are provenance only. Continuing them needs an explicit
   claim or a new attempt.
5. **Compaction changes nothing in the ledger.** Only the model-facing copy
   is lost, and it is re-injected (§6.4).
5. **Prose is never authoritative.** Status lines in summaries are generated
   deterministically from the snapshot.
6. **Failures are explicit.** Missing or unknown-version state produces a
   visible error and a "task state not preserved" line in the tool result,
   never a silently empty list.

## 6. Fold and summary integration

### 6.1 Settling tasks at fold time

The fold is the natural place to reconcile, because the agent is already
summarizing. Add an optional parameter to `navigate_tree rewind`:

```json
{ "action": "rewind", "rewindTo": "impl-start", "newLabel": "s3-done",
  "summaryFocus": "…",
  "tasks": [{ "key": "S3", "status": "done" }, { "key": "S4b", "status": "active" }] }
```

The listed ops are committed to the ledger as an ordinary transaction
*before* the fold starts. The fold then records the resulting revision. If
the fold fails afterwards, the task changes stand, and that is correct.

If tasks touched in the folded range are still `active` and not listed, the
fold proceeds. The tool result then names them, for example `2 tasks still
active: S3, S4b`, so the model sees the gap at the moment it can fix it.

### 6.2 Deterministic task block in the summary text

`REWIND_SUMMARY_PROMPT` is byte-exact and must not change. The task block is
appended by code after generation, not written by the model:

```md
## Tasks (snapshot r42 · authoritative store: call `tasks` for details)
Done: S1, S2, S4a
Active: S3 Vault backend (owner worker as-7)
Blocked: S5 Rotate keys (by S4)
Open: S4b, S4c, S6, S7, SR1–SR3
Acceptance (S3): vault client passes integration test `vault_roundtrip`
Do not infer task status from the prose above. Call `tasks` before changing status.
```

Rules:
- Status lines only, with keys and short titles.
- Acceptance criteria and constraints of open tasks are copied verbatim (the
  CONPACT fix).
- Attachments are not inlined. They are retrieved on demand by key.
- When the list is long, collapse done subtrees ("Done: S1–S2, S4a (3)").

### 6.3 Native `/tree` summaries and other extensions

- When pi's own `/tree` writes a summary, `navigate_tree` is not involved.
  Handle `session_tree` and append a receipt entry after the summary.
- If the receipt write fails, nothing is lost, because the ledger holds the
  state. Only the historical view for that point is missing.
- Separately, emitting `session_before_tree` from `navigate_tree` would let
  third-party task extensions contribute. That is a recommendation from
  inputs/pi-ecosystem.md §Recommendation and independent of this design.

### 6.4 Re-injection after compaction and folds

The model-facing copy is a compact index. It is injected through the
`context` event in two cases:
- the first request after a fold or compaction boundary;
- when the list is stale.

Stale means either of these:
- Tasks are `active`, and the agent ended a turn that edited files or ran
  tools without any task op.
- N turns (default 6) have passed without a task op while tasks are open.

The reminder is one line, for example: `Tasks: S3 active for 14 turns; S5
blocked by S4. Update with task_update or say why not.` This mirrors rpiv-todo
and pi-todo-herdr, which use the same mechanism to address "agents forget to
mark tasks done".

Persist nothing from inside the `context` handler (pi-progress does; the input
note flags it as a smell).

## 7. Tool surface

Two tools, split by read and write. Reads run in parallel; writes run with
`executionMode: "sequential"`.

**`tasks`** (read)

```
tasks {}                               → index of the active list (keys, status, owner, blocked-by)
tasks { key: "S4", depth: 2 }          → subtree with acceptance criteria
tasks { key: "S3", attachments: true } → full record with notes, facts, decisions, files
tasks { plan: "secrets-redesign" }     → plan slice (layer C), read-only view
```

**`task_update`** (write, batched, atomic)

```json
{ "baseRev": 41,
  "ops": [
    { "op": "add", "parent": "S4", "title": "Web UI", "acceptance": ["…"] },
    { "op": "status", "key": "S4a", "status": "done" },
    { "op": "block", "key": "S5", "by": ["S4"] },
    { "op": "attach", "key": "S3", "decision": { "context": "…", "decision": "…" } },
    { "op": "move", "key": "S6", "parent": null } ] }
```

- A stale `baseRev` is rejected with the current revision and the conflicting
  ops, so the model re-reads instead of overwriting.
- Errors name the valid transition (SWE-agent: the interface's error messages
  shape behavior).
- `baseRev` is optional for single-op calls. A missing `baseRev` means "apply
  if the key still exists".

Plan/backlog/roadmap writes go through a third tool, **`plan`**, added in
phase 3. Its persistence semantics differ (files, git-visible), so it must not
look like a session todo op.

Tool renderers follow the house rules:
- `renderShell: "self"`, with state on the bullet only.
- `⎿` on the first body line.
- Metadata joined with `dim(" · ")`.

```
● task_update S4a → done · S5 blocked by S4
  ⎿ 6/19 done · rev 42
```

## 8. Subagent assignment

### 8.1 Model

- **Exactly one writer per task.** Assigning a subtree to a subagent makes the
  child the writer of *progress claims* for that subtree. The parent remains
  the only writer of the authoritative snapshot and of acceptance.
- **The assignment is a record, not a message:**

```ts
interface Assignment {
  id: string;            // "as-7"
  taskIds: string[];     // subtree root(s); the child sees only this slice
  agentId?: string;      // pi-bolt-subagents record id, once spawned
  baseRev: number;       // parent revision the slice was cut from
  acceptance: string[];
  decisions: string[];   // decision attachment ids the child must honor
  lease?: { expiresAt: string };
  state: "open" | "running" | "returned" | "accepted" | "rejected" | "expired";
}
```

- **The brief is generated from the slice:** goal, subtree, acceptance
  criteria, constraints and decisions, verbatim. Cognition's finding is that
  subagents fail when they lack the decisions, not the instruction.

### 8.2 Flow

1. Parent: `task_update { op: "assign", key: "S3", agent: "worker" }`
   creates the assignment and returns the brief.
2. The spawn goes through `pi-bolt-subagents`, which already exposes
   `subagents:rpc:spawn` on `pi.events`. Alternatively, the model calls the
   `Agent` tool with the brief, and `subagents:created` links the agent id.
3. Child: its own tree-navigator instance seeds a local todo list from the
   slice. The child's progress ops are appended to
   `<parent-session-dir>/assignments/<as-id>.jsonl`. The child owns this file
   and is its only writer.
4. Parent: watches the assignment file and shows progress in the widget.
   This is display only; nothing is written to the parent snapshot yet.
5. On `subagents:completed` / `subagents:failed`, the parent reconciles in
   one `task_update` with actor `subagent:<id>`:
   - The base revision must match. If the parent touched the subtree
     meanwhile, the result is flagged as a conflict and not merged.
   - Child "done" becomes `done`, unverified, until the parent accepts it
     (`task_update { op: "accept", key: "S3" }`).
   - Duplicate or stale results are rejected.

### 8.3 Gaps in pi-bolt-subagents (owned by the user)

- **No assignment handle reaches the child.** The child needs it to find its
  slice. Options:
  - an environment variable such as `PI_TASK_ASSIGNMENT`;
  - a field in child-context metadata;
  - a structured block in the prompt, which is the brittle fallback.
  An env var or metadata field needs an upstream change.
- **Live progress events are missing.** The lifecycle emits `created`,
  `started`, `completed`, `failed`, `compacted` and `steered`, but tokens and
  duration arrive only at completion. The widget row
  `[11m11s • 226k tok]` plus model and activity line needs a throttled
  `subagents:progress` event: `{ id, model, elapsedMs, tokens, activity }`,
  at most 1 Hz.

Until both exist, the widget shows the elapsed time since `subagents:started`
and leaves out the token count, model and activity line.

## 9. Above-editor widget

Registered once with `ctx.ui.setWidget("navigate-tree-tasks", factory,
{ placement: "aboveEditor" })`, then mutated in place, with
`tui.requestRender()` called on change. It must be a component factory:
static-line widgets are capped at 10 lines.

### 9.1 Wide (≥ 80 columns)

```
● Todos (6/19) · plan secrets-redesign                                  alt+t
├─ ◐ Secrets Redesign                                                    5/10
│  ├─ ▣ S1   Inventory secret call sites
│  ├─ ▣ S2   Define SecretRef type
│  ├─ ▶ S3   Vault backend                               [11m11s • 226k tok]
│  │  ⎿ openai-codex/gpt-6.1-sol · worker · as-7
│  │    reading crates/vault/src/client.rs
│  ├─ ◐ S4   Migrate consumers                                         1/3
│  │  ├─ ▣ S4a  CLI
│  │  ├─ ▶ S4b  Daemon
│  │  └─ ☐ S4c  Web UI
│  ├─ ☒ S5   Rotate keys                                      [blocked S4]
│  ├─ ☐ S6   Docs
│  └─ ☐ S7   Remove legacy env path
└─ ☐ Scheme router                                                       0/3
   └─ ☐ SR1–SR3  3 open
```

### 9.2 Height budget (default 12 rows, configurable)

When the tree exceeds the budget, rows are dropped in this order:

1. Activity lines of non-focused subagents.
2. Completed subtrees, collapsed to one row: `▣ S1–S2  2 done`.
3. Untouched open siblings, collapsed: `☐ S6–S7  2 open`.
4. Whole top-level groups that have no active or blocked descendant,
   collapsed to their header row with a count.
5. A final overflow row: `… 7 more · /tasks`.

The rows that are never dropped are the focus path: everything active or
blocked, plus its ancestors.

### 9.3 Narrow (< 58 columns)

```
● Todos 6/19                              alt+t
├ ◐ Secrets Redesign                       5/10
│ ├ ▶ S3 Vault backend            11m · 226k
│ │ ⎿ gpt-6.1-sol
│ ├ ◐ S4 Migrate consumers               1/3
│ ├ ☒ S5 Rotate keys                 ⊣ S4
│ └ … 6 more
└ ☐ Scheme router                         0/3
```

- Tree guides shrink to one column plus a space.
- The provider prefix is dropped from model names.
- Activity lines are hidden.
- Right-aligned metadata shortens (`[blocked S4]` → `⊣ S4`).
- Titles truncate with `truncateToWidth`, and every row is fitted with
  `visibleWidth`.

### 9.4 Collapsed (one line, toggled with `alt+t`)

```
● Todos 6/19 · ▶ S3 Vault backend 11m · ☒ S5 blocked · ▶ S4b
```

`alt+t` is free in pi's default keybindings: `ctrl+t` toggles thinking and
`ctrl+shift+t` opens the tree. Register it through `pi.registerShortcut` so
the user can rebind it.

### 9.5 Glyphs and theme tokens

| State | Glyph | Glyph token | Title token | Notes |
|---|---|---|---|---|
| todo | `☐` | `dim` | `muted` | |
| active | `▶` | `warning` | `text` | orange in most themes |
| partial parent (derived) | `◐` | `warning` | `text` | count right-aligned |
| done | `▣` | `success` | `muted` | recedes visually |
| done, unverified | `▣` | `success` | `muted` + dim ` · unreviewed` | subagent result awaiting accept |
| blocked | `☒` | `error` | `text` | `[blocked S4]` in `error` |
| waiting for user | `◇` | `warning` | `text` | `[needs input]` |
| failed | `✗` | `error` | `muted` | distinct from blocked |
| cancelled | `⊘` | `dim` | `dim` | |

- Header bullet `●`: `warning` while anything is active, `error` if anything
  is blocked and nothing is active, `success` when all are done, `dim` when
  idle.
- Tree guides `├─ │ └─`: `borderMuted`.
- Metadata `[11m11s • 226k tok]` and the `⎿` model line: `dim`. Model name:
  `muted`.
- Keys (`S4a`): `muted`. Selection in the overlay: `accent` with the
  `selectedBg` background.
- Only theme tokens, no raw ANSI.
- `glyphs = "ascii"` fallback: `[ ] [>] [~] [x] [!] [?] [-] [/]`.
  `▶`, `▣` and `◐` are East Asian Ambiguous-width in some terminals, which can
  break alignment there. UNVERIFIED for the user's terminals: check with
  `visibleWidth` and a CJK-locale terminal.

### 9.6 Interactivity

Widgets do not take focus. Interaction goes through a command and an overlay:

- `alt+t`: cycle full → collapsed → hidden.
- `/tasks`: opens a `ctx.ui.custom` overlay with the same tree, and focus.
  - Arrows move, `←` / `→` collapse and expand.
  - `enter` opens the detail pane: acceptance, notes, facts, decisions, files
    and owner.
  - `space` cycles status. User edits are ledger transactions with actor
    `user`. A receipt entry is appended while idle.
  - `a` assigns, `b` blocks on another key, `/` filters.
  - `g` jumps to the transcript entry that last changed the task, using the
    existing navigation, which only targets real persisted entry ids.
- Mouse support is optional, following the skill's mouse guidance. It is not
  needed for v1.

## 10. Transcript entries

| Event | Representation |
|---|---|
| Agent mutation | `task_update` tool row (§7). Details hold the transaction id, ops and resulting revision (the receipt). |
| User edit from overlay | Receipt `custom` entry `navigate-tree-tasks`, rendered with `registerEntryRenderer` as `● Tasks edited by user · S5 unblocked`. Not sent to the model. |
| Fold checkpoint | Inside the existing handoff card. One extra line: `⎿ tasks 6/19 · 1 active · 1 blocked · carried open: S4b`. |
| Re-injection | Hidden context block, not persisted. |
| Subagent return | `task_update` with actor `subagent:<id>`. The row shows `◇ accept?` until accepted. |

## 11. Phasing

1. **v1, ledger-backed todos.**
   - Project id, ledger with lock and idempotency, materialized snapshot.
   - `tasks` / `task_update`, the widget and `/tasks`.
   - Receipts in tool results and fold summaries, the deterministic summary
     block, the reconciliation note, re-injection and stale nudges.
   - `/tasks export` and `/tasks import`.
   - The tests that matter:
     - A task finished inside a folded range is still done after the fold.
     - After a `/tree` jump to before that point, it is still done, and the
       note names the change.
     - A stale `baseRev` is rejected.
     - A failed fold write leaves the committed task update intact.
     - A retried transaction with the same idempotency key applies once.
2. **v2, subagent assignment.**
   - Assignment records, slice briefs, the child ledger and reconciliation.
   - Needs the two pi-bolt-subagents hooks in §8.3.
3. **v3, persistent layers.**
   - Plans, backlog and roadmap under `.project/`, the `plan` tool, `planRef`
     binding and automatic plan sync.
   - An optional GitHub Projects adapter for backlog and roadmap, since the
     repository's AGENTS.md already uses a `gh project` kanban.

## 12. Open decisions

1. **Plan storage format.** Markdown checklist with ids (human-editable,
   needs a strict grammar) versus a JSONL ledger with a generated Markdown
   view (robust, less editable). Recommended: Markdown. It fits the existing
   `.project/` artifact convention.
2. **Plan sync policy.** Decided (2026-10-20): automatic, non-blocking,
   audited through the ledger and revertible. No approval step.
3. **Child assignment handle.** An env var or metadata field in
   pi-bolt-subagents, versus a prompt block. Recommended: an upstream change
   in pi-bolt-subagents.
4. **Tool names.** `todo` is claimed by many packages, and two owners give
   competing guidance (inputs/pi-ecosystem.md §4.4). Recommended: `tasks` /
   `task_update`, plus a startup warning when another `todo` tool is loaded.

## 12a. Dissenting review: who is authoritative? (decided: ledger)

Two independent second-opinion reviews disagree on the core authority question:

- **Review 1 (branch-local v1).** Snapshots on the active branch are the
  authority, and the fold carries them atomically inside the summary entry.
  No shared ledger. This was the original recommendation and is superseded.
- **Review 2 (ledger-authoritative v1).** A project ledger is the only
  authority. Folds store an immutable *receipt*: the ledger revision plus a
  bounded historical snapshot. Navigation shows "state at checkpoint" next
  to "current state" and never rolls either back. Its arguments:
  - Branch-local state answers "is S3 done?" wrongly after `/tree` to an
    earlier point, because files are not rolled back. The work exists, but
    the list says open, and that invites duplicate work.
  - Writing a fold and a ledger update together is a dual write. If the fold
    is only an observation of a revision that is already committed, a failed
    fold cannot corrupt task state.
  - It splits each task into three parts:
    - the *definition* (scope and criteria, with a revision);
    - the *attempt* (`assigned → running → submitted → accepted/rejected`,
      with an assignment generation that fences stale writers);
    - the *acceptance*, bound to a commit or tree identity and a
      verification result.
  - Clones and forks must not reclaim the assignments they carry.
  - Defer typed facts and decisions, live progress delivery and
    overlapping subtree claims.

Synthesis:

- Review 2's attempt/acceptance split, assignment generations, idempotency
  keys and artifact-bound acceptance are adopted for v2 in either variant.
- The open choice is the v1 authority:
  - **branch-local**: simpler, sessions are self-contained, but the list can
    show finished work as open after `/tree` navigation;
  - **ledger**: one truth, matching the filesystem, but sessions are no
    longer self-contained, and it needs export and missing-ledger handling.
- Review 2's acceptance tests apply in both variants:
  - Fold twice, reopen a task, then resume before it completes.
  - Cancel and reassign a task, then deliver the old child's result.
  - Retry the same submission after a crash.
  - Fail the fold write after a committed task update.
  - Resume a fork or clone that carries assignment metadata.
  - Change the criteria after submission; stale acceptance is rejected.

## 13. Verification status

- Every runtime claim about pi comes from docs, types and extension source.
  Nothing was exercised at runtime.
  - `session_tree` re-seeding is UNVERIFIED.
  - Calling `appendEntry` during tool execution is avoided by design, because
    tool-result `details` is the documented channel.
- The pi-bolt-subagents event names were read from
  `~/.pi/agent/git/github.com/furbyhaxx/pi-bolt-subagents/src/index.ts`. The
  RPC channels are in `src/cross-extension-rpc.ts`.
- Paper findings: abstract-level for most sources. The figures quoted here
  come from CONPACT and ARC abstracts, which were read in full. See
  inputs/papers-and-ui.md §15.
- Harness claims are vendor-documented, not hands-on verified.
