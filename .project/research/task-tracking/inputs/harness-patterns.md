---
version: 1
id: research-agent-harness-task-subagent-coordination
title: "Task and subagent coordination in current agent harnesses (inspiration for pi-tree-navigator)"
description: "Source-backed survey of durable task state, parent-to-subagent assignment and scoping, dependency and status transitions, resume/fork, in-context vs external task lists, event/log representation and progress UI in Claude Code, Codex, OpenHands, Cursor, LangGraph and AutoGen/Microsoft Agent Framework, analysed for persistent nested tasks and artifacts attached to pi session entries."
type: research
created: "2026-10-20T13:38:07+02:00"
updated: "2026-10-20T14:16:11+02:00"
createdBy: researcher
updatedBy: researcher
question: "How do current agent harnesses (Claude Code, OpenAI Codex, OpenHands, Cursor, LangGraph/AutoGen) represent durable authoritative task state, parent-to-subagent assignment and scoping, dependency/status transitions, resume and fork, task lists in context vs an external store, event/log representations and user-visible progress; and which of those patterns are worth borrowing for persistent nested tasks and artifacts attached to pi session entries in pi-tree-navigator?"
status: final
confidence: high
---

# Task and subagent coordination in current agent harnesses

## Method and evidence basis

All claims below come from primary vendor documentation and repository source, fetched
directly and read on 2026-10-20. The configured SearXNG backend returned no usable
results for every query attempted (`No results found` for ~14 distinct queries, and
one unrelated result set for the default engine), so I abandoned search and worked
from the vendors' own documentation indices:

- `https://code.claude.com/docs/llms.txt`
- `https://developers.openai.com/codex/llms.txt` and `https://learn.chatgpt.com/docs/codex-manual.md`
- `https://docs.openhands.dev/llms.txt`
- `https://cursor.com/docs/llms.txt`
- `https://langchain-ai.github.io/langgraph/llms.txt`
- `https://microsoft.github.io/autogen/stable/` and `https://learn.microsoft.com/en-us/agent-framework/`

Two consequences for how to read this note. First, everything is cited against the
product version current on 2026-10-20, and several of these systems ship weekly; treat
specifics (default limits, flags, file paths) as dated. Second, vendor docs describe
intended behaviour, not observed behaviour. Where a documented limitation is part of
the design, I say so explicitly, because those limitations are the most transferable
knowledge in this note.

## TL;DR

- Every serious harness now separates **model-visible task bookkeeping** from a
  **durable task/event store**, and the cleanest designs make the second one the
  authority: OpenHands persists an append-only typed event log plus a small mutable
  `base_state.json`, LangGraph checkpoints state at every super-step with per-task
  writes for crash recovery, Claude Code keeps a shared task list on disk under
  `~/.claude/tasks/{team-name}/`, Codex exposes `spawn_agent`/`send_input`/
  `resume_agent`/`wait_agent`/`close_agent` over agent threads.
- Naming the same thing twice is the most visible trap: Claude Code ships a
  per-session `TodoWrite`/Task tool list **and** a team-shared task list with
  dependencies and file locking. They share the word "task" and nothing else. Any
  design for pi-tree-navigator must pick one authority and derive the other.
- Self-reported status is unreliable by design. Claude Code documents that teammates
  "sometimes fail to mark tasks as completed, which blocks dependent tasks", and its
  remedy is manual reconciliation. Status must therefore be derivable from observable
  events, not only from an agent's own write.
- Resumption is per-agent and identity-stable, not per-invocation: Claude resumes a
  subagent by agent ID via `SendMessage` and "resuming starts a new run of the agent
  under the same ID"; OpenHands resumes by `task_id`; Cursor resumes by agent ID;
  LangGraph resumes by `thread_id` + `checkpoint_id`. Fork is a separate, additive
  operation: LangGraph `update_state` "does not roll back a thread… the original
  execution history remains intact", and Claude's `/branch` copies the transcript and
  leaves the original on disk.
- Structural nesting is usually qualified by an ID path, not by object containment:
  LangGraph `checkpoint_ns` is `""` for root and `node_name:uuid` for a subgraph, with
  nested namespaces joined by `|`. That is the same idea as pi's `id`/`parentId` tree
  and is a better fit for pi-tree-navigator than a sidecar task index.
- Durability is always partial and the docs are honest about it. Claude checkpoints
  restore the parent conversation's edits but explicitly not most subagent edits, not
  Bash-driven file changes, and not symlinked paths. LangGraph subgraph state cannot
  even be *inspected* when the subagent is wrapped as a tool — the most common pattern.
  pi-tree-navigator should publish its coverage boundary as a product invariant rather
  than let users infer it.
- Recommendation in one line: record nested tasks as first-class pi entries (new
  entry type or `custom`/`custom_message` with a `customType`) whose durable identity
  **is** the entry ID, attach artifacts by referencing real entry IDs, derive status
  and dependency unblocking from an append-only event/turn log at read time, and
  expose one versioned query surface for UI and agents instead of letting the UI parse
  internal state files.

## Findings

### 1. Claude Code

#### 1.1 Subagents: assignment, scoping, identity

A subagent "runs in its own context window with a custom system prompt, specific tool
access, and independent permissions" [1]. The parent "doesn't see the subagent's
intermediate tool calls or outputs, only that final result" [7]. Claude composes a
delegation message; a non-fork subagent receives the agent's own system prompt, the
task message, the CLAUDE.md hierarchy, a git status snapshot, preloaded skills and a
"sibling roster" system reminder listing `main` and every other named agent that is a
valid `SendMessage` target [1].

Scoping is declarative and per-definition: `tools` and `disallowedTools` intersect with
the tool set available to subagents, `disallowedTools` wins on conflict, and a
definition that matches zero usable tools makes the Agent tool fail with a named error
rather than launching a broken worker [7]. Subagent files also carry `model`, `effort`,
`maxTurns`, `omitClaudeMd`, `memory`, `skills`, `mcpServers` and `autoCompactWindow` [1].

Structural limits are explicit and tunable: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
defaults to **3** layers below the main conversation, at which point Claude Code
withholds the `Agent` tool from subagents except forks (and a fork at the limit gets an
error instead of spawning); `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` defaults to **20** and
returns `Concurrent subagent limit reached`; `maxBudgetUsd` refuses spawns
(`Budget limit reached`), stops running background subagents, and ends the query with
`error_max_budget_usd` [2]. At the depth limit the subagent "does its delegated work
itself and returns one summary" — a graceful degradation rather than an error [1].

#### 1.2 The two task systems (in-context vs shared on disk)

This is the single most instructive finding for pi-tree-navigator.

**Per-session task tools.** `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList` (or
`TodoWrite` when `CLAUDE_CODE_ENABLE_TASKS=0`) are available by default only on older
models; newer models "track multi-step work without a written todo list" [3][8]. When
present, the lifecycle is documented as four transitions — created as `pending`,
activated as `in_progress`, completed, and removed via `status: "deleted"` [3]. The
SDK page's guidance is that a host application should render its own progress display
from the structured `tool_use` blocks rather than parsing state files [3].

**Team-shared task list.** When agent teams are enabled, "the shared task list
coordinates work across the team. The lead creates tasks and teammates work through
them. Tasks have three states: pending, in progress, and completed. Tasks can also
depend on other tasks: a pending task with unresolved dependencies cannot be claimed
until those dependencies are completed" [4]. The lead may assign explicitly or
teammates self-claim the next unassigned, unblocked task; "task claiming uses file
locking to prevent race conditions" [4]. Completion of a dependency unblocks dependents
automatically [4].

Storage and lifetime differ per artifact [4]:

| Artifact | Path | Lifetime |
| --- | --- | --- |
| Team config (runtime state: session IDs, tmux pane IDs, `members`) | `~/.claude/teams/{team-name}/config.json` | Removed when the session ends |
| Task list | `~/.claude/tasks/{team-name}/` | Stays on disk after the session ends (`cleanupPeriodDays`, 30 days default) |
| Each agent's mailbox (JSON) | `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` | Session |

Team name is `session-` + first 8 chars of the session ID [4]. Hooks can gate the
lifecycle: `TaskCreated` and `TaskCompleted` exit code 2 prevents the transition and
sends feedback, and `TeammateIdle` exit code 2 keeps an idle teammate working [4].

The documented failure mode is exactly the one a task-graph design must defensively
handle: "**Task status can lag**: teammates sometimes fail to mark tasks as completed,
which blocks dependent tasks. If a task appears stuck, check whether the work is
actually done and update the task status manually or tell the lead to nudge the
teammate." [4]

#### 1.3 Resume vs fork

- Each subagent invocation creates a **new instance**; continuing means resuming, and
  the resume mechanism is `SendMessage` with the agent's ID or name. Resumed subagents
  "retain their full conversation history, including all previous tool calls, results,
  and reasoning" [1].
- The parent receives an **agent ID** when a subagent completes; Explore and Plan are
  one-shot and return no ID, so they cannot be resumed; a subagent stopped at `maxTurns`
  returns output marked partial and can be resumed [1].
- "Resuming starts a new run of the agent under the same ID, so a subagent that had
  already failed or completed shows as running again in the task list and in the Agent
  SDK's task events." [1]
- Name reuse is guarded: `SendMessage` refuses a send when a name now refers to a
  different agent and reports where the name points [1].
- Transcripts persist independently of the main conversation at
  `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`; main
  conversation compaction does not touch them; they survive within the session and are
  deleted after the retention period [1].
- Session-level branch: `/branch [name]` copies the transcript and switches the running
  process to write to it; `--continue`/`--resume` with `--fork-session` does the same
  from the CLI; "the original is unchanged on disk and remains in the session picker" [5].
  In-flight background subagents and background Bash commands keep running and their
  output appears **in the new branch** [5].
- A fork subagent is different again: it inherits the entire conversation, system
  prompt, tools and model (so it shares the parent's prompt cache) and can be given
  `isolation: "worktree"`; a fork cannot spawn further forks [1].

#### 1.4 Checkpointing and its coverage boundary

Checkpoints are taken for prompts that start a turn; the 100 most recent are kept;
they are saved with the conversation so `/rewind` works after a resume [6]. The rewind
menu offers restore code and conversation, restore conversation, restore code,
summarize from here, summarize up to here [6]. Documented gaps [6]:

- Bash-modified files are not tracked.
- "**Any other subagent**: rewinding restores only the files Claude had already edited
  in your conversation. The subagent's edits to other files stay, so use git to revert
  them." (Foreground forked skills are the exception.)
- Changes made outside the session are not captured.
- Symlinked/hard-linked paths are skipped with a `Restored the code, but skipped N files`
  warning.
- "Not a replacement for version control."

#### 1.5 User-visible progress

Agent view treats every listed session as a background session under a supervisor
process. Row state is a small enum — `working`, `needs input`, `idle`, `completed`,
`failed`, `stopped` — with a separate icon *shape* for "process running" vs "process
exited" [9]. `claude agents --json` is the supported machine interface and exposes
`state`, `status` (`busy`/`waiting`/`idle`), `waitingFor`
(`permission prompt`/`input needed`/`sandbox request`/`worker request`/`dialog open`),
`sessionId`, `name` [9]. The docs are explicit that `~/.claude/jobs/<id>/` "are not a
stable interface" and that a session wanting to report progress in its own words should
write its own file — which in turn caused a design change: rows carry a one-line
summary produced by a Haiku-class model, refreshed mid-turn at most every 15 seconds
from the session's own output and rewritten at turn end [9]. The subagent panel renders
nested subagents as a tree and marks rows with descendants using a `(+N)` count [1].
Finished background subagents keep a row for 30 seconds and are then cleared, while
`/tasks` lists completed ones for the same 30 seconds [1].

### 2. OpenAI Codex

- Subagent workflows are enabled by default in current releases; "the main thread
  collects the subagent results into its final response" and Codex "waits until all
  requested results are available, then returns a consolidated response" [10].
- CLI surface: `/subagents` switches between agent threads; approvals can surface from
  an *inactive* thread and the overlay names the source thread (`o` opens it); in
  non-interactive flows an action needing fresh approval fails and the error returns to
  the parent workflow [10].
- Subagents inherit the parent turn's sandbox and approval settings; a custom agent file
  "can't replace those settings" [10] — permission isolation is deliberately not a
  per-subagent axis, the opposite of Claude's per-definition `tools`/permission model.
- Custom agents are standalone TOML files at `~/.codex/agents/` (personal) or
  `.codex/agents/` (project), requiring `name`, `description`, `developer_instructions`,
  optionally overriding `model`, `model_reasoning_effort`, `model_reasoning_summary`,
  `model_verbosity`, and able to disable capabilities; they inherit permissions,
  provider and MCP servers [10]. Built-ins are `default`, `worker`, `explorer`, and a
  custom name matching a built-in takes precedence [10].
- Global knobs live under `[agents]`: `enabled`, `max_concurrent_threads_per_session`
  (cap on concurrently open spawned threads, excluding the primary),
  `default_subagent_model`, `default_subagent_reasoning_effort`, and
  `interrupt_message` ("Record a model-visible message when an agent turn is
  interrupted", default `true`) [10].
- The multi-agent tool family is named explicitly in the config reference:
  `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`
  (`features.multi_agent`, stable, on by default) [11]. `update_plan` is a local
  function tool and `spawn_agent` "also matches `Agent`" in hook matching [11], so the
  plan/todo surface and the delegation surface are distinguishable but co-located in one
  tool namespace.
- Session-level operations: `/resume` (or `codex resume`), `/fork` ("create a new chat
  while preserving the original transcript"), `/compact` (also automatic), `/status`,
  `/plan` or Shift+Tab for Plan mode, with `plan_mode_reasoning_effort` as a
  plan-mode-specific override [11][12]. Codex's own guidance is "keep one chat per
  coherent unit of work… Fork only when the work truly branches" [12].
- Codex Cloud runs each task in its own workspace that "can keep working while your
  computer is asleep", with environments whose saved state is reused across tasks [13].
  The user-visible unit is the task, reviewed as changed files and a PR [13].

### 3. OpenHands

OpenHands has the most explicit data model of the set, and it is the one most directly
transferable.

- **Event system**: "an immutable, type-safe event framework that drives agent execution
  and state management. Events form an append-only log that serves as both the agent's
  memory and the integration point for auxiliary services" [14]. The base `Event` is an
  "immutable Pydantic model with ID, timestamp, source" [14].
- **Two axes are kept deliberately independent**: `Event.source`
  (`user`/`agent`/`environment`, i.e. attribution) versus the LLM `role`
  (`system`/`user`/`assistant`/`tool`, i.e. formatting). The docs warn: "Do not infer
  event origin from LLM role." [14] The event hierarchy splits **LLM-convertible**
  events (`MessageEvent`, `ActionEvent`, `ObservationEvent`, `UserRejectObservation`,
  `AgentErrorEvent`, `SystemPromptEvent`, `CondensationSummaryEvent`) from **internal**
  events (`ConversationStateUpdateEvent`, `CondensationRequest`, `Condensation`,
  `PauseEvent`) that are "NOT visible to the LLM" [14].
- **Persistence layout**: one directory per `conversation_id` under `persistence_dir`,
  containing `base_state.json` plus `events/event-00000-<event-id>.json`,
  `event-00001-…` [15]. Base state holds agent configuration, `execution_status`,
  statistics, secrets and `agent_state` ("Custom runtime state stored by agents") [15].
  The split is justified as "Fast event appends: no need to rewrite the entire history;
  Atomic state updates; Efficient restoration: events can be loaded lazily", and
  persistence is automatic via a custom `__setattr__` on `ConversationState` [15]. This
  layout is described as the successor of V0's single `trajectory.json`, "split into
  individual files for better performance and granular access" [15].
- **Condensation** is first-class and represented in the log: `Condensation` carries
  `forgotten_event_ids`, `summary` and `summary_offset`, and `CondensationSummaryEvent`
  is a user-role, LLM-visible summary of forgotten events [14]. Nothing is deleted; the
  log records what was dropped from context.
- **Subagent delegation**: the `TaskToolSet` exposes a `task` tool taking
  `prompt`, `subagent_type`, `description` and `resume`, and returns a `TaskObservation`
  with `task_id` (e.g. `task_00000001`), `subagent`, `status` (`completed` or `error`)
  and `text` [16]. Sub-agents run **synchronously** — "the parent blocks until the
  sub-agent finishes" — and the lifecycle is documented as creation, running,
  completion, "Persistence: the conversation is saved to disk for potential resumption",
  then optional resumption with full context [16]. An optional `DelegationVisualizer`
  renders the multi-agent flow [16].
- **Pause/resume** is an API-level operation (`pause-conversation`, `resume-sandbox`)
  and pause is also an event (`PauseEvent`), and the agent server exposes the event log
  as a queryable store: search/count/batch-get/get conversation events, and the same for
  bash events [14][17].

### 4. Cursor

- Subagents "start with a clean context. The parent agent includes relevant information
  in the prompt since subagents don't have access to prior conversation history" [18].
  Foreground blocks and returns immediately; background "returns immediately" and is for
  "long-running tasks or parallel workstreams" [18].
- Parallelism is expressed at the tool level: "Agent sends multiple Task tool calls in a
  single message, so subagents run simultaneously" [18].
- Isolation is opt-in per fan-out: by default "subagents share the parent agent's
  checkout", and asking for isolation gives "each subagent … its own environment with
  its own branch: an isolated Git worktree with a separate working directory on the same
  machine, or its own cloud environment with a dedicated VM and clone of the repository.
  Changes stay on each subagent's branch until the parent agent merges the results." [18]
- Resume is by agent ID and state is written progressively: "Each subagent execution
  returns an agent ID… Background subagents write their state as they run. You can
  resume a subagent after it completes to continue the conversation with preserved
  context." [18]
- Plan Mode externalizes the plan as a reviewable artifact: the agent asks clarifying
  questions, researches, produces a plan, the user edits it "through chat or markdown
  files", and plans are saved in the home directory by default with "Save to workspace"
  to promote them into the repo for sharing and documentation [19]. The documented
  recovery pattern is notable: rather than fixing a misdirected agent, "go back to the
  plan. Revert the changes, refine the plan… and run it again." [19]
- The Agents Window is the progress UI: multi-workspace, parallel cloud agents, diffs
  and PR management in place, "easier handoff between local and cloud", worktrees per
  task, and cloud subagents via `/in-cloud` or `/autopilot`; GA with Cursor 3 on
  2026-04-02 [20].
- The Cloud Agents API models durable units explicitly [21]:
  - agents have a lifecycle (create, list, get, archive, unarchive, delete permanently);
  - runs have `status` with observed values `CREATING`, `RUNNING`, `FINISHED`, `ERROR`,
    `CANCELLED`, `EXPIRED`, plus `durationMs`, a final `result` string, and
    `git.branches[]` of `{ repoUrl, branch?, prUrl? }`;
  - runs can be streamed over SSE (`data: {"runId":…,"status":"RUNNING"}`);
  - **artifacts** are listed per agent (`/v1/agents/{id}/artifacts`) with paths relative
    to the workspace `artifacts/` directory and downloaded via a temporary 15-minute
    presigned S3 URL.
  - One documented wart worth avoiding: the `git` snapshot is "**Per-agent state, not
    per-run.** Every run on the same agent returns the same `git` snapshot", so callers
    must attribute work to a run via `latestRunId` or the SSE stream [21].

### 5. LangGraph

- **Thread + checkpoint** is the durability core: `thread_id` "is the primary key for
  storing and retrieving checkpoints"; a checkpoint is "a snapshot of the graph state
  saved at each super-step" [22].
- **Two-level durability**: checkpoints at super-step boundaries, plus "the checkpointer
  also persists writes at the **node (task) level**… As each node within a super-step
  finishes, its outputs are written to the checkpointer's `checkpoint_writes` table as
  task entries linked to the in-progress checkpoint. These per-task writes are what
  enable pending writes recovery: if another node in the same super-step fails, the
  successful nodes' writes are already durable and don't need to be re-run on resume."
  [22] Task-level writes are not full snapshots, so time travel only resumes from
  super-step boundaries [22].
- **Nesting is an ID namespace, not containment**: `checkpoint_ns` is `""` for the root
  graph and `"node_name:uuid"` for a subgraph invoked as a node, with nested namespaces
  joined by `|` (`"outer_node:uuid|inner_node:uuid"`) [22].
- **`StateSnapshot`** carries `values`, `next` (node names to run next; empty means the
  graph is complete), `config` (`thread_id`, `checkpoint_ns`, `checkpoint_id`),
  `metadata` (`source` ∈ `input`/`loop`/`update`, `writes`, `step`), `created_at` and
  `parent_config` [22] — i.e. a durable record with an explicit parent pointer and a
  reason field, much like pi entries carry `id`/`parentId`.
- **Replay vs fork**: replay re-runs nodes after the checkpoint ("Replay re-executes
  nodes—it doesn't just read from cache. LLM calls, API requests, and interrupts fire
  again and may return different results"); fork calls `update_state` on a prior
  checkpoint and then `invoke(None)`, and "`update_state` does **not** roll back a
  thread. It creates a new checkpoint that branches from the specified point. The
  original execution history remains intact." [23] `as_node` disambiguates the writer
  when parallel branches updated state in the same step, and interrupts are always
  re-triggered during time travel [23].
- **Subgraph persistence is an explicit three-way choice**, which is the clearest
  statement in any of these systems of the trade-off pi-tree-navigator faces [24]:

  | Mode | `checkpointer=` | Interrupts | Multi-turn memory | State inspection |
  | --- | --- | --- | --- | --- |
  | Per-invocation (default) | `None` | Yes | No | Current invocation only |
  | Per-thread | `True` | Yes | Yes | Yes |
  | Stateless | `False` | No | No | No |

  Per-invocation is recommended for "multi-agent systems where subagents are invoked as
  tools"; per-thread is for subagents that need conversation memory; multiple calls to
  the same per-thread subgraph in one node "write to the same checkpoint namespace and
  conflict" [24].
- **Failure mode worth internalizing**: subgraph state inspection "does not work when a
  subgraph is called inside a tool function or other indirection (e.g., the subagents
  pattern)" — inspection requires the subgraph to be *statically discoverable* [24].
  Nested subagent state is therefore observable only when the topology is declared, not
  when delegation is dynamic.
- **Event/stream representation** is a first-class, multi-mode surface: `stream_mode` can
  be `values`, `messages`, `custom`, `checkpoints`, `tasks`, `debug`, or a list of them.
  `checkpoints` emits events with the same shape as `get_state()`; `tasks` emits "task
  start and finish events… information about which node is running, its results, and any
  errors"; `debug` combines both with extra metadata [25]. All require a checkpointer
  except the value/message modes [25].

### 6. AutoGen and Microsoft Agent Framework

Included at the depth the topic warrants, because AutoGen is no longer the live surface:
Microsoft's own current documentation states that "Agent Framework is the direct
successor, created by the same teams. It combines AutoGen's simple abstractions for
single- and multi-agent patterns with Semantic Kernel's enterprise-grade features such
as session-based state management, type safety, filters, telemetry", with migration
guides from both predecessors [26].

AutoGen's relevant contributions remain informative as prior art:

- **Event-driven core**: AutoGen's core is described as an "event-driven programming
  framework for building scalable multi-agent AI systems" [27].
- **Per-component state**: `save_state()`/`load_state()` exist per agent
  (`BaseChatAgent`, `AssistantAgent`) and per team, and the docs frame the use case as
  "a web application where stateless endpoints respond to requests and need to load the
  state of the application from persistent storage" [28] — i.e. state is a serializable
  blob the host owns, not a filesystem contract.
- **Decentralized handoff**: the `Swarm` team routes work with a
  `HandoffMessage`/`Handoff`, with no central task list or orchestrator [29]. This is the
  deliberate opposite of Claude's team task list and is worth knowing as an alternative
  failure mode (routing churn, no global progress view).

MSAF's own selling point — session-based state management with graph-based workflows for
explicit orchestration [26] — is essentially the LangGraph position, which is why this
note treats LangGraph as the representative of that family.

## Options / comparison

| Dimension | Claude Code | Codex | OpenHands | Cursor | LangGraph |
| --- | --- | --- | --- | --- | --- |
| Authoritative task/state store | Shared task list dir per team; per-session task tools; supervisor `state.json` | Agent threads + `[agents]` limits; session chats | Append-only typed event log + `base_state.json` | Cloud API agents/runs; local agent ID sessions | Checkpointer (`thread_id`, `checkpoint_id`) |
| In-context task list | Yes (`TaskCreate`/`TodoWrite`), separate from the shared list | Yes (`update_plan`, Plan mode) | No — bookkeeping is internal events, not LLM-visible | No — plans are files | No — state channels + per-node writes |
| Assignment unit | `Agent` tool call → subagent / teammate / fork | `spawn_agent` → agent thread | `task` tool → sub-agent conversation | Task tool call → subagent | Subgraph invocation / node |
| Scoping | Per-definition `tools`/`disallowedTools`, model, effort, permission mode inherited | Inherits parent sandbox/approval; custom file can tune model+instructions only | Per-`subagent_type` registered factory (LLM, tools, skills) | Subagent file: model + tool config; own worktree/VM on request | Tool list on the subgraph; `checkpointer` mode |
| Status model | `pending`/`in_progress`/`completed`/`deleted`; session `working`/`blocked`/`done`/`failed`/`stopped` | Thread activity + run states in Cloud; `interrupt_message` records interruption | `completed`/`error` per task; conversation `execution_status` | Run `CREATING`/`RUNNING`/`FINISHED`/`ERROR`/`CANCELLED`/`EXPIRED` | `next` + `metadata.source`/`step`; task start/finish stream |
| Dependencies | First-class: blocked task unclaimable until deps complete; auto-unblock; file-locked claim | Not documented as a task graph | Not a task graph; sequential blocking calls | Not documented as a task graph | Graph edges; super-step scheduling |
| Resume | `SendMessage` by agent ID/name; new run under same ID | `/resume`, `resume_agent` | `task_id` → reloaded conversation | Agent ID → full context | `thread_id` (+ `checkpoint_id`) |
| Fork | `/branch`, `--fork-session`, fork subagent | `/fork` preserving original transcript | New `conversation_id` | New agent / worktree / cloud VM | `update_state` + `invoke(None)` (additive branch) |
| Nested-state visibility | Subagent panel tree with `(+N)`; per-agent transcripts on disk | `/subagents`, thread switching | Every conversation is its own event store | Agents Window list | `checkpoint_ns`; `get_state(subgraphs=True)` — only if statically discoverable |
| Progress UI | Agent view rows (state enum + model-written one-line summary + peek/attach) | CLI thread switching; Cloud task list | Canvas; `DelegationVisualizer` | Agents Window | Consumer-built over stream modes |

## Analysis for pi-tree-navigator

pi's own substrate, verified against the bundled docs of
`@earendil-works/pi-coding-agent@1.3.0` [30]: sessions are JSONL files where "session
entries form a tree structure via `id`/`parentId` fields, enabling in-place branching
without creating new files". Every entry extends `SessionEntryBase`
(`type`, `id`, `parentId`, `timestamp`). The entry types are `session` (header),
`message`, `model_change`, `thinking_level_change`, `usage`, `compaction`,
`context_edit`, `branch_summary`, `custom`, `custom_message`, `label` and
`session_info`. Crucially: `custom` entries are "Extension state persistence. Does NOT
participate in LLM context", `custom_message` entries do participate, and `label`
entries are "User-defined bookmark/marker on an entry" carrying a `targetId`.

That last mechanism is the precedent pi-tree-navigator already relies on:
`docs/architecture.md` states as an invariant that "Chronological containment is
presentation metadata, not context ancestry. Native tree navigation always targets a
real persisted entry ID."

### Durable authoritative task state

The systems that scale to nested work all converge on **one append-only record per unit
of work, keyed by a stable ID, with a separate small mutable summary**, and they all
insist that the append-only part is the authority: OpenHands' events directory versus
`base_state.json` [15], LangGraph's checkpoints versus the latest `StateSnapshot`, and
Codex's agent threads versus per-thread status. Claude Code's split into three different
stores (task tools in the message stream, `~/.claude/tasks/` on disk, and
`~/.claude/jobs/<id>/state.json` for the supervisor) is the cautionary example: the docs
must tell users that two of the three are not stable interfaces [9].

For pi-tree-navigator, the append-only record already exists — it is the session's JSONL
tree. Adding an external task index would create exactly the duplicate-authority problem
above, and would break the invariant that navigation targets real persisted entry IDs.
A nested task should therefore be *an entry* (its own `type`, or a `custom` entry with a
`customType` such as the existing `pi.virtual-model-state` precedent), with its identity
being the entry ID and its position in the tree being real structure rather than
presentation metadata.

### Parent-to-subagent assignment and scoping

Two coherent philosophies appear. Claude and Cursor scope the *worker* (per-definition
tools, model, effort, permission mode, isolation) and let the parent compose a delegation
message; Codex scopes the *parent session* and explicitly forbids a custom agent file
from overriding permissions, provider or MCP servers [10]. For pi-tree-navigator the
transferable part is not the tool list but the **declared, inspectable scope**: Claude's
zero-usable-tools error [7] and Codex's required `name`/`description`/
`developer_instructions` triple [10] both exist so a delegation cannot silently become
unbounded. A pi-tree-navigator task record should carry the scope it was created with
(tools, model, limits, isolation) as data, so the tree can show *why* a nested task was
allowed to do something.

Depth and concurrency caps plus graceful degradation at the limit are worth copying:
Claude withholds `Agent` at the depth limit so the worker does the job itself rather than
failing the parent, and returns a distinct `Concurrent subagent limit reached` result
attributable to the refused call [1][2]. Both are cheap to implement and prevent runaway
trees, which matters more in pi where a nested task is a persistent tree node and not
just a transcript.

### Dependency and status transitions

Claude Code is the only system in this survey with a real dependency graph: dependencies
gate claiming, completion auto-unblocks dependents, and claiming is file-locked against
races [4]. It is also the only one that documents the resulting failure: lagging status
blocks dependents and requires manual repair [4].

The lesson is to make status *derivable* rather than *declared*, or at least to keep the
declared value and the derived value separate. OpenHands has the cleanest mechanics for
this — the event log is the truth and `ConversationStateUpdateEvent` is just another
event [14] — and LangGraph's node-level writes give the same property at a finer
granularity, surviving a sibling's failure without re-running [22]. OpenHands' explicit
internal-versus-LLM-visible split also means a status flip never becomes model context by
accident [14].

Concretely for pi-tree-navigator: store transitions as events (entry-appended records),
compute current status from them, and treat an agent's "I marked it done" as one input
among several. Keep `deleted` (Claude's removal status [3]) distinct from `cancelled` and
from `failed`; Cursor's `EXPIRED` alongside `CANCELLED`/`ERROR` [21] is a useful
reminder that "went away" and "broke" are different outcomes for a durable record.

### Resume and fork

Every system distinguishes these, and the distinction is stable across all of them:
**resume** continues the same identity with its history, **fork** creates an additive
sibling that leaves the original intact [1][5][11][18][23]. Two details are worth
adopting directly:

1. *Resume starts a new run under the same ID* [1], and the record shows as running
   again. This avoids inventing a new identity for continued work while keeping run
   boundaries observable.
2. *Name reuse is guarded and errors are explicit* [1]. In a nested tree, an ambiguous
   reference is a correctness bug, not a UX nit.
3. *Fork is additive and never rewrites history* [23], and the fork inherits a defined
   subset: Claude's `/branch` documents exactly what carries over (conversation history,
   session permission grants, running background work, remote connection) and what does
   not [5]. pi-tree-navigator already applies this discipline to retrospective clones
   ("Descendant copies retain original bodies and receive new header IDs/remapped parent
   paths"), so extending the same rules to task entries keeps one mechanism instead of
   two.

The most dangerous documented anti-pattern here is the partial resume: Claude's agent
teams state that `/resume` and `/rewind` "do not restore in-process teammates", so "the
lead may attempt to message teammates that no longer exist", and orphaned tmux sessions
are a known troubleshooting entry [4]. For a persistent tree, the analogue would be
dangling references from a parent entry to a nested task that did not survive a
compaction or clone. pi-tree-navigator's existing invariant that "conversion must
preserve original payloads and accounting, valid tree references" [31] is the right
defence; nested task references need to be included in that check explicitly.

### Task lists in context versus an external store

The survey shows three viable positions, and they are not interchangeable:

1. **In context only** (Codex `update_plan`, Claude's todo tools): cheap, instantly
   visible to the model, but invisible to other sessions and lost on context management.
   Claude's own docs note that newer models "track multi-step work without a written todo
   list", which means the in-context list is becoming an optional affordance rather than
   the mechanism [3].
2. **External only** (OpenHands, LangGraph): authoritative and durable, but the model
   only learns about it if something materializes it into context — which is why
   OpenHands has `CondensationSummaryEvent` and LangGraph has state channels.
3. **Both, with different grammars** (Claude Code): powerful and the source of the
   documented confusion, plus a status-lag failure mode.

pi-tree-navigator sits in a strong position: pi already has the mechanism for option 2
done right. A nested task stored as a `custom` entry is durable and invisible to the LLM;
if and only if the model needs it, a `custom_message` entry (or the existing handoff
materialization) injects it. That mirrors OpenHands' source-versus-role separation [14]
and keeps the invariant that "compaction and context edits affect projection, not source
message payloads" [31]. The thing to avoid is a second, in-context task list living
beside the entry-based one.

### Event and log representation

The strongest shared conventions:

- One immutable record per occurrence, with a stable ID and a cause/parent pointer:
  OpenHands' immutable base event with "ID, timestamp, source" [14]; LangGraph's
  `parent_config` and `metadata.source` ∈ `input`/`loop`/`update` [22]; pi's own
  `id`/`parentId` [30].
- Per-record files or lines rather than whole-file rewrites: OpenHands splits V0's single
  `trajectory.json` into `events/event-NNNNN-<id>.json` for "better performance and
  granular access" [15], and pi already appends JSONL lines.
- Attribution kept separate from rendering: `source` versus LLM `role` [14]. pi's
  equivalent distinction is entry type plus what `buildContextEntries()` includes.
- The log records what was removed from context: `Condensation` with
  `forgotten_event_ids` and `summary` [14]. pi-tree-navigator's `branch_summary` and
  `compaction` entries already have this shape.
- Machine-readable event shapes for consumers: LangGraph's `checkpoints`/`tasks` stream
  modes [25] and OpenHands' event search/count/batch-get endpoints [17]. Claude
  deliberately refuses to make its state files an interface and provides
  `claude agents --json` instead [9] — a good argument for exposing a versioned query
  API rather than documenting internal paths.

### User-visible progress

The best progress UIs in this set all reduce a durable record to a small state enum plus
a short human sentence, and keep the raw view one keystroke away: Claude agent view's
six states with separate shape/colour meanings and a model-written row summary, plus
peek/attach [9]; Cursor's Agents Window as the parallel-agent surface with local↔cloud
handoff [20]; Codex's `/subagents` thread switching [10]. Two specific lessons:

- Transience is a design choice with costs. Claude clears a finished subagent's row
  after 30 seconds [1]; for a *persistent* tree this would read as data loss, so
  pi-tree-navigator should keep completed nodes visible and let the user collapse them.
- Deriving the summary is expensive and asynchronous. Claude pays a Haiku-class request
  per turn and explicitly notes the billing and provider implications [9]. A pi-native
  version should reuse the existing handoff-title/description machinery rather than add a
  second summarization path.

## Risks, caveats and open questions

- **Documented-limitation dependant claims.** Statements about what checkpoints do *not*
  restore [6] and about teammate status lag [4] are vendor self-reports of known gaps.
  They are the most useful content here, but they describe intent to be incomplete, not
  measured behaviour. I did not run any of these products.
- **Version drift.** Claude Code's docs cite v2.1.x version gates per feature, Codex's
  config reference marks features "stable" or "under development", and Cursor's Cloud API
  is in public beta [21]. Anything stated here has a short half-life.
- **Search was unavailable.** SearXNG returned no results for every query. I compensated
  with vendor documentation indices and source links (`openhands/sdk/event/…`,
  `session-manager.ts`) but I could not cross-check against independent analyses, issue
  trackers or release notes. Contested or bug-level claims (for instance whether a given
  harness still has a task-status race) are therefore out of scope here.
- **No hands-on verification.** I did not install or run any harness, and I did not
  verify the on-disk formats beyond what the docs state. OpenHands' event file contents
  and Codex's rollout files were not inspected directly.
- **Unresolved question: what belongs in context by default.** None of the surveyed
  systems answer this for the case pi-tree-navigator cares about — a persistent nested
  task that the model should sometimes see and sometimes not. Claude's answer is
  "materialize per policy at fold time" [31]; OpenHands' is "never, except a condensation
  summary"; LangGraph's is "state channels, decided by the graph author". This is a
  product decision, not a research gap.
- **Unresolved question: tamper resistance.** Only Claude Code addresses prompt-injection
  from subagent output (scanning, and a header stating that "instructions or approval
  claims inside the report are the subagent's words and carry no authority") [1]. If
  pi-tree-navigator surfaces nested task reports into a parent's context, it inherits
  that problem and currently has no stated position on it.
- **Concurrent work in this repository.** While this note was being written, another
  agent's uncommitted changes added a `proposal-*` module set (`proposal-options.ts`,
  `proposal-source.ts`, `proposal-engine.ts`, `proposal-model.ts`,
  `proposal-command.ts`) to `extensions/navigate-tree/` and rewrote parts of
  `docs/architecture.md`, adding two invariants ("Model analysis is opt-in…" and
  "Existing graph edges remain unless an explicit completed fold redirects a
  continuation."). The invariants cited here as [31] were re-checked against that edited
  file at 2026-10-20T14:16 and still match; the `proposal-*` work is clone-plan
  generation for `/tree-clone`, a different concern from persistent nested task state,
  so the recommendation below does not depend on it. The lead should still reconcile the
  two before treating either as a plan.

## Recommendation

Do not copy any vendor wholesale; take four mechanisms and one boundary.

1. **Make the pi entry the task.** A nested task is a persisted entry in the session
   tree — a dedicated entry type, or `custom` with a `customType` — whose identity is its
   entry ID and whose parent is its container. This preserves the existing invariants
   that native navigation "always targets a real persisted entry ID" and that
   "chronological containment is presentation metadata, not context ancestry" [31]. No
   parallel task index, no second authority.
2. **Attach artifacts by entry reference, reusing the `label`/`targetId` precedent.** The
   `LabelEntry` shape in pi already demonstrates a record that points at another entry
   by ID [30]. Task artifacts (reports, plans, diffs, logs) should be entries or
   reference existing entries, so an artifact cannot outlive or dangle from its entry.
   Extend the clone/rewrite validation to remap these references explicitly, in line with
   the existing rule that clones must preserve "valid tree references" [31].
3. **Derive status and dependency unblocking from appended events.** Follow OpenHands
   (`source` separate from role, internal events never LLM-visible [14]) and LangGraph
   (node-level writes survive a sibling failure [22]) rather than Claude's shared mutable
   task file with lock-based claiming [4]. Store transitions as records, compute the
   current status at read time, and keep an agent's self-report as one input. Keep
   `cancelled`, `failed` and `removed` as distinct terminal outcomes, taking Cursor's
   `EXPIRED`/`CANCELLED`/`ERROR` split as the model [21].
4. **Separate resume from fork, and make fork additive with a documented inheritance
   table.** Resume = a new run under the same identity, visible as such [1]; fork = a
   sibling that leaves the original byte-identical, with an explicit list of what carries
   over [5][23]. pi-tree-navigator's retrospective clone already implements the fork
   half for histories ("Descendant copies retain original bodies and receive new header
   IDs/remapped parent paths"); nested tasks should ride that same path rather than
   introduce a second clone mechanism.
5. **The boundary to publish, not to hide:** exactly what rewind/fork/compaction does to
   nested task state and artifacts. Claude's checkpoint docs catalogue their own blind
   spots [6] and LangGraph documents that subgraph state is unobservable when delegation
   is dynamic [24]. pi-tree-navigator should state its coverage the same way, as an
   invariant in `docs/architecture.md`, because a persistent tree that silently loses a
   nested task's edits or references is worse than one that never promised durability.

Concretely, the cheapest first increment consistent with all of the above: an entry type
plus a small status/dependency derivation module and a `/tree` row renderer, with
references from parent entries to nested task entries validated by the same checks that
guard retrospective clones today. The expensive parts — depth/concurrency caps with
graceful degradation [1][2], model-written progress summaries [9], cloud/remote
execution [20] — are separable and should not gate the first increment.

## Sources

[1] Create custom subagents — https://code.claude.com/docs/en/sub-agents.md (accessed 2026-10-20; Claude Code v2.1.x)
[2] Subagents in the SDK: cap depth, concurrency and spend — https://code.claude.com/docs/en/agent-sdk/subagents.md (accessed 2026-10-20; TS SDK v0.3.219+, Claude Code v2.1.219+)
[3] Track todos — https://code.claude.com/docs/en/agent-sdk/todo-tracking.md (accessed 2026-10-20; Claude Code v2.1.268+)
[4] Orchestrate teams of Claude Code sessions — https://code.claude.com/docs/en/agent-teams.md (accessed 2026-10-20)
[5] Manage sessions — https://code.claude.com/docs/en/sessions.md (accessed 2026-10-20)
[6] Checkpointing — https://code.claude.com/docs/en/checkpointing.md (accessed 2026-10-20)
[7] Tools reference (Agent tool behavior, Task tool availability) — https://code.claude.com/docs/en/tools-reference.md (accessed 2026-10-20)
[8] Work with sessions (Agent SDK) — https://code.claude.com/docs/en/agent-sdk/sessions.md (accessed 2026-10-20)
[9] Manage multiple agents with agent view — https://code.claude.com/docs/en/agent-view.md (accessed 2026-10-20)
[10] Subagents (ChatGPT Work / Codex) — https://learn.chatgpt.com/docs/agent-configuration/subagents.md (accessed 2026-10-20)
[11] Codex configuration reference / CLI options (`features.multi_agent`, `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`, `update_plan`) — https://learn.chatgpt.com/docs/codex-manual.md and https://learn.chatgpt.com/docs/config-file/config-reference.md (accessed 2026-10-20)
[12] Codex CLI slash commands and working guidance — https://learn.chatgpt.com/docs/developer-commands.md?surface=cli (accessed 2026-10-20)
[13] Codex Cloud — https://learn.chatgpt.com/docs/cloud.md (accessed 2026-10-20)
[14] Events (OpenHands SDK architecture) — https://docs.openhands.dev/sdk/arch/events.md (accessed 2026-10-20)
[15] Persistence (OpenHands SDK) — https://docs.openhands.dev/sdk/guides/convo-persistence.md (accessed 2026-10-20)
[16] Task Tool Set (OpenHands SDK) — https://docs.openhands.dev/sdk/guides/task-tool-set.md (accessed 2026-10-20)
[17] OpenHands agent-server event API (search/count/batch-get conversation events; pause conversation) — https://docs.openhands.dev/llms.txt index and linked API pages (accessed 2026-10-20)
[18] Subagents (Cursor) — https://cursor.com/docs/subagents.md (accessed 2026-10-20)
[19] Plan Mode (Cursor) — https://cursor.com/docs/agent/plan-mode.md (accessed 2026-10-20)
[20] Agents Window (Cursor) — https://cursor.com/docs/agent/agents-window.md (accessed 2026-10-20; GA with Cursor 3, released 2026-04-02)
[21] Cloud Agents API endpoints (agents, runs, stream, artifacts) — https://cursor.com/docs/cloud-agent/api/endpoints.md (accessed 2026-10-20; public beta)
[22] Checkpointers (LangGraph) — https://docs.langchain.com/oss/python/langgraph/checkpointers.md (accessed 2026-10-20)
[23] Use time travel (LangGraph) — https://docs.langchain.com/oss/python/langgraph/use-time-travel.md (accessed 2026-10-20)
[24] Subgraphs (LangGraph) — https://docs.langchain.com/oss/python/langgraph/use-subgraphs.md (accessed 2026-10-20)
[25] Streaming (LangGraph) — https://docs.langchain.com/oss/python/langgraph/streaming.md (accessed 2026-10-20)
[26] Microsoft Agent Framework overview (direct successor to AutoGen and Semantic Kernel) — https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview (accessed 2026-10-20)
[27] AutoGen documentation index (event-driven core) — https://microsoft.github.io/autogen/stable/index.html (accessed 2026-10-20)
[28] Managing State (AutoGen AgentChat) — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html (accessed 2026-10-20)
[29] Swarm (AutoGen AgentChat; `HandoffMessage`, `Handoff`) — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html (accessed 2026-10-20)
[30] Session format (`@earendil-works/pi-coding-agent@1.3.0`, bundled docs `docs/session-format.md` in this repo's `node_modules`) — entry types, `id`/`parentId` tree, `CustomEntry`, `CustomMessageEntry`, `LabelEntry` (accessed 2026-10-20)
[31] pi-tree-navigator invariants — `docs/architecture.md` in this repository (accessed 2026-10-20)
