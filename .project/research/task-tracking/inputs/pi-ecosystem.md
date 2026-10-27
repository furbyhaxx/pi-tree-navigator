---
version: 1
id: research-pi-task-tracking-surfaces
title: "Pi task/todo tracking surfaces and durable-plan extensions"
description: "Inventory and comparison of Pi 1.3.0 task/todo surfaces and the extension ecosystem, judged by whether task state is authoritative outside the transcript and whether a fold can preserve it."
type: research
question: "Which task/todo tracking surfaces does Pi expose today, which pi extensions implement durable plans, task trees, agent progress and TUI rendering, what works and what fails when state is transcript-derived, and can a fold preserve task state?"
created: "2026-10-20T13:45:55+02:00"
updated: "2026-10-20T13:45:55+02:00"
createdBy: researcher
updatedBy: researcher
status: final
confidence: high
---

# Pi task/todo tracking surfaces and durable-plan extensions

Scope: Pi coding agent `@earendil-works/pi-coding-agent` **1.3.0** (published 2026-10-15, MIT) as installed in this repo
(`node_modules/@earendil-works/*@1.3.0`), plus the published extension ecosystem as of 2026-10-20. All claims below were
checked against the installed package, its shipped docs, or published package sources/READMEs on 2026-10-20. No live Pi
session was driven; runtime-only claims are marked `UNVERIFIED`.

## TL;DR

- Pi has **no built-in task/todo model**. Everything task-shaped is an extension. The only core surfaces are the `todo.ts`
  and `plan-mode` **examples** and the generic APIs: agent tools, session entries, widgets/status, renderers, lifecycle events [9][10][2][6].
- Core's state story is one sentence: **tool-result `details` follow the active branch; `appendEntry()` is durable but still
  branch-local; anything outside one session needs external storage** [1][7]. Every mechanism Pi offers writes to the
  session tree, so nothing in core is session-global or fold-surviving by itself.
- The whole ecosystem is built on branch-local state. `@juicesharp/rpiv-todo` (2.13.9), `opensec-pi-todo`, `@capdiem/pi-todo`,
  `@narumitw/pi-progress`, `@casualjim/pi-todo-herdr`, `@firstpick/pi-extension-todo-progress`, `pi-todo-lite`,
  `pi-todo-list` all replay from `sessionManager.getBranch()` [12][13][14][16][17][18][19].
- Consequence for a fold (rewind with summary): the abandoned path's snapshots stop being on the active branch, so every
  one of those extensions **silently reverts to the last task snapshot before the fold target**. The model may still read
  the fold's prose summary and believe the task list survived; the widget and the model diverge [12][13][14][25].
- Only file-backed designs are authoritative outside the transcript: `cabi/pi-todos`, `mitsuhiko/agent-stuff` `todos.ts`,
  `@agimon-ai/doompi-task` (`tasks.json`), `pi-goal-x` (`.pi/goals/*.md` + a branch "focus" entry) [20][21][22][23]. They
  survive rewinds but their scope is arbitrary: `doompi-task` is per session-tree, so a fork starts empty `UNVERIFIED`;
  `pi-goal-x` deliberately binds an external goal to a branch through one custom entry [23].
- A fold *can* preserve task state, with three core-supported mechanisms: (a) `branch_summary.details` carries arbitrary
  JSON from an extension-provided summary, and (b) `session_tree` hands the handler `oldLeafId`, so the just-abandoned path
  is still readable via `getBranch(oldLeafId)` and can be re-seeded as a custom entry on the new leaf [4][6][7][8].
- **Gap in this repo today:** `navigate_tree` writes `branch_summary.details.treeNavigator` and emits `session_tree`
  itself, but never emits `session_before_tree`, so no other extension can contribute state to a fold, and no task state is
  read from the folded branch [25].

## Findings

### 1. What Pi 1.3.0 actually exposes

| Need | Surface | Location / signature |
|---|---|---|
| Agent-callable operation | `pi.registerTool({ name, parameters, execute })`; result `content` for the model, `details` for rendering and state reconstruction | `docs/extensions.md` [1], `dist/core/extensions/types.d.ts:453` [6] |
| Branch-local task state | tool-result `details`; replay with `ctx.sessionManager.getBranch()` | `docs/extensions.md:227-237` [1] |
| Durable, non-context data | `pi.appendEntry(customType, data)` → `SessionManager.appendCustomEntry`, *"append a custom entry (for extensions) as child of current leaf, then advance leaf"* | `types.d.ts:1272` [6], `session-manager.d.ts:273` [7] |
| Model-visible injected state | `pi.sendMessage({ customType, content, display, details })` → `custom_message` entry | [6], `docs/session-format.md` [2] |
| Live list near the editor | `ctx.ui.setWidget(key, lines \| factory, { placement: "aboveEditor" \| "belowEditor" })` | `types.d.ts:47-105` [6], `docs/tui.md` [5] |
| One-line status | `ctx.ui.setStatus(key, text)`, `setFooter(fn)`, `setWorkingIndicator()` | [5][6] |
| Durable transcript card | `pi.appendEntry()` + `pi.registerEntryRenderer(customType, fn)` | `types.d.ts:1250-1254` [6] |
| Custom message rendering | `pi.registerMessageRenderer(customType, fn)`; `registerToolRenderer`, `renderCall`/`renderResult` | [6] |
| Full-screen task view | `ctx.ui.custom(factory, { overlay: true })` | `docs/tui.md` [5] |
| Lifecycle hooks | `session_start` (`startup\|reload\|new\|resume\|fork`), `session_tree`, `session_before_tree`, `session_before_compact`, `session_compact`, `turn_end`, `agent_settled`, `context` | `types.d.ts:576-870, 1198` [6] |
| History edits | `context_edit` entry: append-only, branch-relative replacement/omission of one earlier entry | `docs/session-format.md` [2] |

Two structural constraints matter more than the surface list:

- `ExtensionContext.sessionManager` is a **`ReadonlySessionManager`** (`getBranch`, `getEntries`, `getTree`, `getLeafId`, …).
  Extensions cannot append or move the leaf except through `pi.appendEntry`, `pi.sendMessage`, `pi.setLabel`, or a command
  context [6].
- `navigateTree()` exists only on `ExtensionCommandContext`, not on `ExtensionContext` [6]; the request to expose it to
  agents is issue #5932 (open since 2026-08-23) [26]. That is why an agent-callable rewind (`navigate_tree`) has to be
  reimplemented in an extension, and why it must re-emit `session_tree` by hand [25].

### 2. State model: branch-local, never session-global

Documented and enforced behaviour:

- Entries form a tree via `id`/`parentId`; the active branch is what the model sees [2].
- `appendCustomEntry` attaches to **the current leaf** and advances it [7]. There is no API to append at an arbitrary
  parent, so "state at the fold point" means "append after the fold".
- `branchWithSummary(fromId, summary, details)` moves the leaf to `fromId` and appends `branch_summary` as its child [7];
  Pi's own `navigateTree` refreshes the finalized context, restores tools from the transcript, then emits `session_tree`
  with `{ newLeafId, oldLeafId, summaryEntry, fromExtension }` [8].
- `/tree` keeps the whole file; `/fork` writes a **new file containing only root→leaf**; `/clone` copies the active branch
  [3][7]. So history-derived state transfers across `/fork` only for the branch that was copied, and abandoned-branch
  state is unreachable in the new file.
- Compaction keeps the entries, changes the projection: entries before `firstKeptEntryId` stay on the branch but leave the
  model context [2]. Branch summarization replaces the abandoned path's presence in context with a summary [4].

The official guidance is explicit: *"Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during
`session_start`. Do not rebuild it from every file entry because abandoned branches represent alternative histories."* [1]

### 3. Ecosystem: what exists and where its state lives

Registry scale: `keywords:pi-package` returns **12,413** packages on 2026-10-20 [11]; 32 of the first 250 matches are
task/plan/progress/goal shaped. The task-relevant subset, with the state mechanism that matters here:

| Package (version, date) | State authority | Branch / fold behaviour | TUI surface |
|---|---|---|---|
| `@juicesharp/rpiv-todo` 2.13.9 (2026-10-17), MIT [12] | tool-result `details`: full post-mutation snapshot on every call; `replayFromBranch()` walks `getBranch()` and keeps the last snapshot | reverts to the last snapshot on the new branch after a rewind; survives `/reload`, compaction; invisible stale-task reminder to the model | widget above editor + `/todos`, collapse key |
| `opensec-pi-todo` 2.13.1, Apache-2.0, Bun-only build of rpiv-todo 2.12.0 [13] | same, verified in `dist-bun/core.cjs`: `getBranch()` → last `toolResult` with `toolName === "todo"`; hooks `session_start`, `session_compact`, `session_tree` | same | same |
| `@narumitw/pi-progress` 0.6.2 (2026-10-20), MIT [14] | branch replay + **re-injects a hidden state block at the summary boundary** through the `context` event; persists a "restored boundary" custom entry per summary epoch | most sophisticated: state is re-materialised after compaction/branch summary instead of relying on the surviving `toolResult` being in context | widget, branch-aware restore |
| `@capdiem/pi-todo` 0.3.2 (2026-09-01), MIT [15] | tool-result `details`, `getBranch` replay, `baseVersion` stale-write guard, snapshot semantics | branch-correct; rewind reverts list | widget above editor |
| `@casualjim/pi-todo-herdr` 0.3.11 (2026-10-19), MIT [16] | tool-result `details` snapshots, restored from `getBranch()` over `set_tasks`/`update_task`/`rm_task` | README claims survival across "reload, resume, fork, tree navigation, and context compaction" — which in this design means *the branch's* state, i.e. rewind reverts | hierarchical task-tree widget + optional Herdr sidebar |
| `@firstpick/pi-extension-todo-progress` 0.3.4 (2026-10-13), MIT [17] | `appendEntry` goal/todo snapshots + `getBranch` restore on `session_tree` | durable goal across turns, same branch-local limit | widget; external T3 Tasks panel adapter |
| `setwhite/pi-todo-lite` (2026-10-18), MIT [18] | whole-table replacement in `details`, replayed after compaction and branch switch | branch-correct, reverts on rewind | widget, collapse key, `/todos export` |
| `fitchmultz/pi-todo-list` (2026-10-20), MIT [19] | nested items in the "session journal" | branch-correct; README warns the branch can move before a save fails | widget + `/todos` views |
| `cabi/pi-todos`, Apache-2.0 [20] | **one Markdown file per todo in `.pi/todos/`**, pid-locked, `assigned_to_session`, GC | survives crash, restart, new session, compaction, handover; *not* branch-correct — a rewind leaves the files as they are | `/todos` manager |
| `mitsuhiko/agent-stuff` `extensions/todos.ts` [21] | one Markdown file per todo in `.pi/todos`, optional `.lock`, `assigned_to_session` | same trade-off as above; ancestor of `cabi/pi-todos` | `/todos` overlay manager |
| `@agimon-ai/doompi-task` 0.0.1-alpha.128 (2026-10-11), MIT [22] | **`~/.pi/agent/doom-task/<session>/tasks.json`**, dependency-aware graph, 30-day TTL; *"Task is authoritative across transcript compaction because the graph is file-backed"* | survives rewind/compaction; fork starts a new `<session>` store `UNVERIFIED` | `/tasks` TUI view, task graph + delegation |
| `pi-goal-x` 0.32.3 (2026-10-02), MIT [23] | goal/task plan as files under `.pi/goals/`, plus one `appendEntry` **focus entry** binding goal → branch | external state survives everything; the branch only remembers which goal it was on — a hybrid worth copying | `/goal`, widget |
| Pi examples `todo.ts`, `plan-mode` [9][10] | `todo.ts`: tool-result `details` replayed from `getBranch()`; `plan-mode`: `appendEntry("plan-mode")` **and** `getEntries()` replay + `[DONE:n]` text scanning | `todo.ts` is the canonical branch-correct demo; `plan-mode` is the canonical counter-example (see §4) | `todo.ts`: `/todos` screen; `plan-mode`: widget + status |

### 4. What fails

**4.1 Transcript-derived state and a fold.** All branch-replay extensions share one algorithm: last snapshot on
`getBranch()` wins. A fold moves the leaf to the anchor and appends a `branch_summary`; the snapshots written after the
anchor are now only on the abandoned branch. Verified in code for `opensec-pi-todo` (`replayFromBranch`), `pi-todo-herdr`
(`state.ts:546-557`) and `pi-progress` (`reconstructProgress`) [13][16][14]. Failure symptoms, in order of severity:

1. Silent revert: the panel drops back to the pre-fold list; completed-during-fold work reappears as pending.
2. Divergence: the fold's summary text still says what was done, so the model's belief and the widget disagree.
3. Ghost IDs: `nextId` reverts with the snapshot, so ids the summary refers to may no longer exist and new tasks can reuse
   them; the model's follow-up `update`/`delete` calls then fail or hit the wrong task [12][13].

**4.2 Reading the whole file instead of the branch.** The `plan-mode` example restores with
`ctx.sessionManager.getEntries()` and takes the last `custom` entry with `customType === "plan-mode"` [10]. After a rewind
that entry belongs to a branch the user abandoned; the status line and widget then show a plan that is not on the active
branch. This is precisely the pattern the docs warn against [1]. `getEntries()` also cannot see anything after a `/fork`
in the new file.

**4.3 Free-text extraction.** `plan-mode` derives its step list by parsing a `Plan:` block out of assistant text and marks
steps done by scanning for `[DONE:n]` in later assistant messages [10]. Reported consequences: demo `Plan:` text being
captured as real todos and polluting context (issue #8503, closed 2026-08-25) and steps never getting checked off (issue
#7919, closed 2026-08-11) [24]. Title-level evidence only; bodies were not read.

**4.4 Tool-name ownership.** Many packages register `todo`. rpiv-todo's README says to install only one of rpiv-todo /
opensec-pi-todo [12][13]; pi-progress tells users to remove `@narumitw/pi-todo` first [14]; `@capdiem/pi-todo` says to
remove any other owner of `todo` [15]. Two loaded owners means two tools with competing guidance and two widgets.

**4.5 Session-entry state cannot be "out of scope".** Everything an extension persists with `appendEntry` is a normal tree
node: it survives `/reload` and compaction, is copied by `/fork` only along the copied path, and is invisible to other
sessions. A reported gap — custom entries cannot declare themselves excluded from transcript scans — was filed as issue
#9651 (closed 2026-09-16) [24]; regardless of its resolution, `appendEntry` remains branch-local. External files are the
only way to be authoritative across sessions [20][22][23].

### 5. Can a fold preserve task state?

Yes, and core supports three distinct mechanisms. They differ in who owns the state and what the model sees.

**(a) Fold-carried state in the summary entry.** `branch_summary` accepts `details?: unknown`, and
`SessionBeforeTreeResult` lets an extension supply `{ summary, details, usage }`; Pi's own `navigateTree` writes exactly
that (`summaryDetails = extensionSummary.details`) [4][6][8]. The default folder stores only
`{ readFiles, modifiedFiles }` [4]. So a fold could carry `details.tasks` and every reader would get it from the summary
node. Today `navigate_tree` writes `details.treeNavigator` (handoff metadata) and nothing task-shaped, and it does not
emit `session_before_tree`, so other extensions cannot contribute [25].

**(b) Re-seed at `session_tree`.** The event payload carries `oldLeafId` and `newLeafId` [6]. Because `branch()` only moves
the leaf and never deletes entries [7], a handler can read the abandoned path with
`ctx.sessionManager.getBranch(event.oldLeafId)`, extract the last task snapshot, and `pi.appendEntry("tasks", snapshot)` so
the snapshot becomes a child of the summary on the new branch. This is branch-correct by construction: the new branch
starts with the exact state the fold consumed, and a later `/fork` copies it. API-level design from `types.d.ts` and
`session-manager.d.ts`; not exercised at runtime here `UNVERIFIED`.

**(c) Re-materialise in the projection.** `pi-progress` shows the model-facing variant: after compaction or a branch
summary, the `toolResult` that held the list is outside the kept range or off-branch, so it injects a hidden
`custom` message at the summary boundary (`context` event) and persists a "restored boundary" custom entry keyed by the
summary epoch [14]. This keeps the model and the widget aligned even though no `toolResult` survives in context.

**(d) External authority, branch pointer.** `pi-goal-x` writes the goal and its plan to files and records a single
`appendEntry` focus entry pointing at the goal id [23]. Rewinds, forks and compactions cannot lose the plan; the branch
only decides which plan is current. The cost is that the plan is no longer branch-correct by default: two branches
editing the same goal file interfere.

## Options / comparison

| Approach | Survives rewind/fold | Branch-correct | Survives `/fork` | Model sees it | Failure mode |
|---|---|---|---|---|---|
| Tool-result `details` + `getBranch()` replay (rpiv-todo, herdr, pi-todo-lite) | no | yes | yes for the copied path | only while the `toolResult` is in context | silent revert after fold |
| `appendEntry` snapshots (plan-mode, firstpick) | no (leaf-bound) | yes | yes for the copied path | no | same silent revert; `getEntries()` replay makes it worse |
| Summary `details` payload | yes, if the folder writes it | yes | yes | only via injected text, not the raw details | requires folder cooperation; invisible to the model |
| `session_tree` re-seed from `oldLeafId` | yes | yes | yes | no, unless also injected | needs a live `session_tree` emitter (this repo does emit it) |
| Context-boundary re-injection (`pi-progress`) | yes for the projection | yes | yes | yes | extra hidden message per request; must dedupe and sanitise |
| External files, session-scoped (`doompi-task`, `cabi/pi-todos`) | yes | no | new store `UNVERIFIED` | via tool results only | rewinds leave stale work visible; multi-branch contention |
| External files + branch pointer (`pi-goal-x`) | yes | partly | yes, pointer copied | via tool results | concurrent branches mutate one store |

## Risks, caveats and open questions

- No live run: every runtime interaction above is read from source and types. The `session_tree` re-seed recipe and the
  fork behaviour of `doompi-task` are unexercised (`UNVERIFIED`).
- Pi 1.3.0 is current as of 2026-10-20 (`npm view` reports 1.3.0, modified 2026-10-15). Anything here can change with the
  next minor; the `session_tree` payload and `appendEntry` leaf semantics are the load-bearing parts.
- Issue bodies for #8503, #7919 and #9651 were not read (GitHub API rate limit hit); only their titles, states and dates
  from the search index are used, and they are cited as such.
- `opensec-pi-todo` is pinned to rpiv-todo 2.12.0 and Bun-only; its `details` format matches 2.13.x but a future rpiv
  release could diverge [13].
- `pi-progress` appends a custom entry from inside a `context` handler [14]. That works, but it means projection-time code
  mutates the session; anything built here should not copy that detail casually.
- Unknown: whether any current extension reads a fold's `branch_summary.details` for task state. None of the inspected
  packages do; they only use `getBranch()`.

## Recommendation

For a task system attached to `navigate_tree` and its branch/fold summaries, do not follow the ecosystem default.

1. **Make the fold the state boundary.** `navigate_tree` should read the last task snapshot from the branch it is folding
   (it already walks `entries` and `sourceIds` before `branchWithSummary`), and write it into
   `branch_summary.details.treeNavigator.tasks` — or a sibling namespaced key — so the task list is a property of the
   summary node rather than a side effect of surviving tool results [25].
2. **Re-seed on the new branch immediately.** After `branchWithSummary`, `appendEntry("task-state", snapshot)` so the
   first entry after the summary is authoritative for that branch; the state then survives `/fork` and `/clone` [7].
3. **Emit `session_before_tree` before folding.** This repo already emits `session_tree` by hand; emitting the
   pre-navigation event would let third-party task extensions contribute state to the summary and removes the need for
   them to reverse-engineer `navigate_tree` [25][6].
4. **Keep the model-facing copy explicit.** Either put the task table into the handoff report body (today only prose
   "## Progress / In Progress" survives, per `summary-prompt.ts`) or inject it at the boundary the way `pi-progress` does.
   Do not rely on the summary prose to carry machine state [25][14].
5. **Expose the state as a rendered card.** `registerEntryRenderer` for the custom entry plus a `setWidget` list keeps the
   user's view derived from the same entry the model sees, instead of from a separate in-memory list.
6. **Say what was dropped.** When a fold cannot carry task state (no snapshot present), the tool result should state that
   the task list was not preserved — silent revert is the ecosystem's worst failure mode.

## Sources

[1] Pi 1.3.0, `docs/extensions.md` (State section, lines 222-237) — local `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`; upstream https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md (accessed 2026-10-20; applies to 1.3.0).
[2] Pi 1.3.0, `docs/session-format.md` (entry types, CustomEntry, CustomMessageEntry, BranchSummaryEntry, ContextEditEntry, context building) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md (accessed 2026-10-20).
[3] Pi 1.3.0, `docs/sessions.md` (`/tree`, `/fork`, `/clone` table) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md (accessed 2026-10-20).
[4] Pi 1.3.0, `docs/compaction.md` (Branch Summarization, `BranchSummaryEntry` details, `session_before_compact` custom state, lines 169-232, 293-330) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md (accessed 2026-10-20).
[5] Pi 1.3.0, `docs/tui.md` (integration points, widgets, renderers, overlays) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md (accessed 2026-10-20).
[6] Pi 1.3.0, `dist/core/extensions/types.d.ts` (WidgetPlacement:47, setWidget:101-104, appendEntry:1272, registerEntryRenderer:1254, registerMessageRenderer:1250, ExtensionContext:213 with `sessionManager` readonly at 222, session events:576-870, on():1198-1206, ExtensionCommandContext.navigateTree:307) — installed package (accessed 2026-10-20).
[7] Pi 1.3.0, `dist/core/session-manager.d.ts` (appendCustomEntry:273, appendCustomMessageEntry:286, getBranch:311, getEntries:334, branch:349, resetLeaf:353, branchWithSummary:359, createBranchedSession:365, ReadonlySessionManager:178) — installed package (accessed 2026-10-20).
[8] Pi 1.3.0, `dist/core/agent-session.js` lines 3300-3385 (`navigateTree`: extension summary → `branchWithSummary` → context refresh → `session_tree` emit) — installed package (accessed 2026-10-20).
[9] Pi 1.3.0, `examples/extensions/todo.ts` (header: *"State is stored in tool result details (not external files), which allows proper branching"*; `reconstructState` over `getBranch()` on `session_start` and `session_tree`) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts (accessed 2026-10-20).
[10] Pi 1.3.0, `examples/extensions/plan-mode/index.ts` (`persistState` via `appendEntry("plan-mode")`; restore from `getEntries()`; `[DONE:n]` text scanning) — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts (accessed 2026-10-20).
[11] npm registry search, `keywords:pi-package` — 12,413 packages, 2026-10-20 (https://registry.npmjs.org/-/v1/search?text=keywords:pi-package).
[12] `@juicesharp/rpiv-todo` 2.13.9 (2026-10-17, MIT) — https://www.npmjs.com/package/@juicesharp/rpiv-todo and https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo (accessed 2026-10-20).
[13] `opensec-pi-todo` 2.13.1 (Apache-2.0; Bun bundle of rpiv-todo 2.12.0) — https://www.npmjs.com/package/opensec-pi-todo; replay code inspected in `dist-bun/core.cjs` (`replayFromBranch`, `session_start`/`session_compact`/`session_tree`) at `/home/furbyhaxx/.pi/agent/npm/node_modules/opensec-pi-todo/` (accessed 2026-10-20).
[14] `@narumitw/pi-progress` 0.6.2 (2026-10-20, MIT) — https://www.npmjs.com/package/@narumitw/pi-progress; sources inspected: `src/progress-state.ts` (`reconstructProgress`, `reconcileProgressContext`, `reconstructRestoredProgressBoundary`) and `src/progress-widget.ts` (`restoreBranchState`, `session_tree` handler) (accessed 2026-10-20).
[15] `@capdiem/pi-todo` 0.3.2 (2026-09-01, MIT) — https://www.npmjs.com/package/@capdiem/pi-todo (README: snapshot semantics, `baseVersion` guard, `getBranch`/`session_tree` present in bundle) (accessed 2026-10-20).
[16] `@casualjim/pi-todo-herdr` 0.3.11 (2026-10-19, MIT) — https://www.npmjs.com/package/@casualjim/pi-todo-herdr; `src/state.ts:546-557` restore over `getBranch()` (accessed 2026-10-20).
[17] `@firstpick/pi-extension-todo-progress` 0.3.4 (2026-10-13, MIT) — https://www.npmjs.com/package/@firstpick/pi-extension-todo-progress; `index.ts` `appendEntry` snapshots + `restoreState` on `session_tree` (accessed 2026-10-20).
[18] `setwhite/pi-todo-lite` (2026-10-18, MIT) — https://github.com/setwhite/pi-todo-lite (README: whole-table replacement, replay after compaction and branch switch) (accessed 2026-10-20).
[19] `fitchmultz/pi-todo-list` (2026-10-20, MIT) — https://github.com/fitchmultz/pi-todo-list (README: nested todos stored in the session journal; branch can move before a failed save) (accessed 2026-10-20).
[20] `cabi/pi-todos` (Apache-2.0) — https://github.com/cabi/pi-todos (README: one Markdown file per todo in `.pi/todos/`, pid locking, `assigned_to_session`, comparison table against session-replay extensions) (accessed 2026-10-20).
[21] `mitsuhiko/agent-stuff` `extensions/todos.ts` (Apache-2.0) — https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/todos.ts (header: `.pi/todos` files, one per todo, lock files, `PI_TODO_PATH`) (accessed 2026-10-20).
[22] `@agimon-ai/doompi-task` 0.0.1-alpha.128 (2026-10-11, MIT) — https://www.npmjs.com/package/@agimon-ai/doompi-task (README: `~/.pi/agent/doom-task/<session>/tasks.json`, "authoritative across transcript compaction because the graph is file-backed", 30-day TTL) (accessed 2026-10-20).
[23] `pi-goal-x` 0.32.3 (2026-10-02, MIT) — https://www.npmjs.com/package/pi-goal-x; `extensions/goal-state.ts` (`.pi/goals/` markdown plans, `FOCUS_ENTRY` via `appendEntry`, branch restore over `getBranch()`) (accessed 2026-10-20).
[24] earendil-works/pi issues, title-level evidence from the GitHub search index (bodies not read): #8503 "plan-mode: demo \"Plan:\" text gets extracted as real todos, polluting context" (closed 2026-08-25), #7919 "plan-mode example: steps never get checked off during execution" (closed 2026-08-11), #9651 "appendEntry: custom entries cannot declare \"not part of the transcript window/scan\" (accounting entries starve readers)" (closed 2026-09-16) — https://github.com/earendil-works/pi/issues/8503, /7919, /9651 (accessed 2026-10-20).
[25] `pi-tree-navigator` 0.3.0, `extensions/navigate-tree/index.ts` (`emitSessionTree` lines 629-653, `branchWithSummary` call lines 2311-2324, `pi.appendEntry(REWIND_OUTCOME_CUSTOM_TYPE, …)` line 2056), `handoff.ts` (`HandoffData`, `getHandoff`), `summary-prompt.ts` (`REWIND_SUMMARY_PROMPT` with `## Progress` section) — local checkout, main at `c2cf6f9` (accessed 2026-10-20). No `session_before_tree` emit exists in the extension.
[26] earendil-works/pi issue #5932 "exposing ctx.navigateTree() to agents, as it exists on ExtensionCommandContext but not ExtensionContext" (open since 2026-08-23) — https://github.com/earendil-works/pi/issues/5932 (accessed 2026-10-20).
[27] earendil-works/pi issue #8958 "Persistent on-pane task/progress list (opencode-style): extension API supports it; requesting feedback on pattern + official example" (opened 2026-09-01, closed) — full body read; it enumerates `setWidget`, `setStatus`, `setWorkingIndicator`, `setFooter`, `setTitle`, passive progress hooks, a `task_status`-style agent tool, and RPC forwarding of `extension_ui_request` as the ecosystem's design space at v0.84.4 — https://github.com/earendil-works/pi/issues/8958 (accessed 2026-10-20).
