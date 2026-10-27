---
version: 1
id: "research-durable-task-tracking-autonomous-agents"
title: "Durable task tracking for autonomous agents: prior art, standards, UI patterns and failure modes"
description: "Source-backed survey of hierarchical planning, dependency/DAG tracking, blackboard and shared-memory architectures, workflow and event-sourced durable execution, human-agent progress interfaces, and the empirical failure modes of transcript-only task state, with design implications for nested tasks carrying notes, files, facts and decisions, on-demand retrieval, branch/fold summaries and subagent ownership."
type: "research"
created: "2026-10-20T14:13:36+02:00"
updated: "2026-10-20T14:13:36+02:00"
createdBy: "researcher"
updatedBy: "researcher"
---

# Durable task tracking for autonomous agents

## TL;DR

- Task state that lives only in the transcript is not durable: it is rewritten by
  every compaction and lost from the model's view even though it survives on disk.
  Measured compaction losses are large: compactors retained only 17% of injected
  side constraints on average, and an inbox agent deleted e-mails without approval
  in 30/100 sessions after compaction versus none before it [72]. The proposed fix
  in that paper — keep constraints in a separate structure and re-inject them — is
  the same shape as a durable task store.
- Classical hierarchical planning (STRIPS, HTN, PDDL) and goal-reasoning
  architectures already give the vocabulary that agent task trees need: typed
  tasks, preconditions, decomposition, and an explicit goal lifecycle with
  reformulation and repair [1][2][3][5]. Plans are commitments to be revised, not
  contracts to be obeyed [4].
- Dependency and workflow theory is mature and directly reusable: control-flow
  patterns including milestone, deferred choice, cancel-activity and cancel-case
  [21], BPMN sub-processes [22], compensation via sagas [23], and build-system
  semantics for re-execution, early cutoff and constructive traces [24].
- Durable execution is a solved engineering problem outside agents (event history
  and deterministic replay [25][39], checkpoints and thread-scoped state [41][42],
  journaled services [45][46]) and protocol-level task state now exists inside the
  agent ecosystem: MCP defines tasks as "durable state machines" with polling, TTL
  and terminal statuses [28][29], and A2A defines an eight-state task lifecycle
  with artifacts and status-update events [27].
- The strongest evidence-backed retrieval pattern is addressable recall: keep an
  append-only, ID-addressable store of raw observations and put only short
  citations in the active context, so the agent can pull the original by ID instead
  of relying on a lossy summary or on embedding similarity (99.40% vs 88.12%
  exact-answer accuracy in the paper's needle-in-a-haystack evaluation) [71]. This
  is the same mechanism that makes "folded" branches cheap: fold into the context,
  keep the branch addressable.
- Subagent ownership is the weakest spot in current designs. Multi-agent
  delegation fails through context mismatch and unshared decisions [56], through
  specification and alignment failures documented in MAST [38], and dynamic
  concurrency changes scheduling and coordination behaviour rather than model
  quality [80]. Ownership, acceptance criteria and result artifacts must be
  records, not prose in a transcript, and each task needs exactly one writer.
- Recommendation for this repository: add a durable, append-only task/decision
  store keyed by stable task IDs next to the session tree, have fold summaries
  carry a pointer set plus the constraint block verbatim rather than the only copy
  of it, make retrieval ID-based, and give every delegated task an owner record and
  an acceptance field. Section 11 lists the concrete shape.

## 1. Scope and method

Questions this note answers for the follow-up design work:

1. What do planning, workflow and multi-agent traditions already establish about
   hierarchical task state, dependencies and ownership?
2. How is durable task state built outside agents, and what is now standardized
   inside agent protocols?
3. What do human-agent interfaces need from task state to keep oversight cheap?
4. What demonstrably breaks when task state exists only as transcript text?
5. What design does that imply for nested tasks carrying notes, files, facts and
   decisions, for on-demand retrieval, for branch/fold summaries and for subagent
   ownership?

Method and limits. Primary sources only: canonical papers with DOI-verified
records, standards documents, vendor documentation, and 2024-2026 preprints
verified through their arXiv abstract pages. Claims taken from an abstract are
stated as such; claims from a publisher snippet are avoided. Every bibliographic
record in section 14 was checked by machine in this run (Crossref API, arXiv
abstract pages, or a direct fetch returning HTTP 200) on 2026-10-20, except where
section 15 says otherwise. Two network limits applied: this host cannot reach
`github.com`, and the general web-search front-end returned degraded results, so
discovery used the scholarly engine plus direct fetches, and repository links are
cited from the primary documents that reference them rather than fetched.

## 2. Hierarchical planning and decomposition

**Classical foundations supply the data model.** STRIPS separates operators
(preconditions, add list, delete list) from the goal and the state it mutates [1];
HTN planning makes the task *itself* hierarchical, with compound tasks decomposed
into subtasks by methods, and shows the resulting complexity bounds [2]; PDDL
standardizes domains, typed objects, durative actions and numeric state so plans
are machine-checkable [3]. For a task tree this is the difference between "a list
of steps" and "a typed task graph with preconditions and a state that changes
monotonically under logged effects".

**Plans are resources, not contracts.** Suchman's critique of plan-following as the
model of human action — plans as resources for situated action that get repaired in
the situation — is the correct prior for agents that must replan mid-task [4].
Goal reasoning formalizes what that means operationally: a goal has a lifecycle
(formulate, select, expand, commit, monitor, modify) and the agent may *drop or
reformulate* goals when assumptions fail, which is precisely the state a task
record must represent [5]. Mission planning at NASA/JPL is the largest deployed
example of a durable, human-editable activity plan with dependency constraints and
mixed-initiative editing [6].

**LLM-era decomposition work is mostly about where the hierarchy is materialized.**
Least-to-most prompting and decomposed prompting build subtask handlers
explicitly [7][8]; plan-and-solve emits a plan before solving [9]; ReAct
interleaves thought and action without an external plan object [10]; Tree of
Thoughts searches over intermediate states rather than over a decomposition [11];
ADaPT decomposes only as needed and can recurse on failure [12]; LLM+P hands the
plan problem to a classical planner [13]; LLMCompiler compiles a plan into a
*dependency DAG* with a task-fetching unit that dispatches ready tasks in parallel
— the clearest LLM-native dependency-graph execution model [14]; Voyager keeps a
growing skill library with self-verification, i.e. durable procedural memory
outside the transcript [15].

**Generative Agents remains the reference for hierarchical task tracking in a
stateful agent**: a planning module generates only a high-level hour-level plan in
advance and then *recursively decomposes* the near future into 5-15-minute chunks
"just in time", and a *reflection tree* of higher-level insights is built above the
memory stream with relevance/recency/importance retrieval [16]. That just-in-time
decomposition is the on-demand-retrieval idea applied to planning: keep the coarse
grain resident and generate detail when it is needed. CoALA gives the unifying vocabulary used throughout the
rest of this note: modular memory (working, episodic, semantic, procedural), an
action space split into internal (retrieval, reasoning, learning) and external
(grounding) actions, and a decision loop over them [17]. Reflexion adds
self-generated verbal lessons persisted across trials [18]; Agent Workflow Memory
induces reusable workflows from past trajectories and injects them later [19].

**The 2026 survey names the core problem.** "The Horizon Gap" disambiguates three
routinely conflated properties — long-horizon (task: required steps), long-context
(model: token capacity), long-term memory (system: persistence across steps and
sessions) — and organizes 1,547 arXiv papers (2024-2026) along a long-horizon task
lifecycle; its motivating failure list is literally "losing track of earlier
decisions, declaring half-finished work done, or drifting from goals" [20]. Any
durable task tracking design should be evaluated against those three symptoms.

## 3. Dependency graphs and workflow tracking

- **Control-flow patterns.** The canonical workflow-pattern catalogue covers
  sequence, parallel split, synchronisation, exclusive and multi-choice,
  structured versus arbitrary cycles, **deferred choice**, **milestone** (a task is
  enabled only while a stage has not been cancelled), **cancel activity** and
  **cancel case** [21]. Milestone and cancel semantics matter for agents: they are
  exactly the patterns for "do not start this until phase X is still alive" and
  "abandon the subtree when the goal changes".
- **Process notation.** BPMN 2.0.2 (ISO/IEC 19510) standardizes sub-processes,
  boundary events, compensation handlers and multi-instance activities, i.e. nested
  tasks with typed edges and explicit interruption semantics [22].
- **Compensation.** Sagas predate modern workflow engines: a long-lived computation
  is a sequence of steps with *compensating* actions, because partial work cannot
  simply be rolled back [23]. Agents need the same: a step record should name its
  inverse or its "abandon" story, otherwise a mid-flight replan orphans effects.
- **Rebuild and invalidation semantics.** Build Systems à la Carte formalizes
  rebuild strategies (dirty bit, constructive traces, verifying traces,
  suspension) and the properties that make incremental re-execution safe [24]. This
  is the best available theory for "which tasks must re-run when an artifact
  changes", and it is what turns a snapshot of task state into a *derived* view
  that can be recomputed deterministically.
- **Runtime durability.** Temporal makes the execution history the source of truth
  and replays it deterministically: state persists in the face of failures and
  outages, an execution resumes from the latest state, and large histories are
  rotated with Continue-As-New [25]. The `Continue-As-New` pattern is directly
  analogous to folding a finished phase: keep a bounded live state, archive the
  rest, and never lose the identity of the work.
- **Agent-native DAGs.** LLMCompiler executes a compiled dependency DAG with
  parallel dispatch [14]. Magentic-One shows the ledger pattern in an agent
  orchestrator: an outer loop maintains a **task ledger** that holds "given or
  verified facts, facts to look up, facts to derive" plus the plan, and an inner
  loop maintains a **progress ledger** that directs and evaluates individual steps;
  on stall the orchestrator updates the task ledger, revises the plan and restarts
  the inner loop [26]. It also demonstrates the weakness addressed later in this
  note: those ledgers are managed by the orchestrator's own context, so their
  lifetime is bounded by the context window and the summarization policy, not by
  storage.
- **Standardized task objects.** MCP 2025-11-25 introduces tasks as "durable state
  machines that carry information about the underlying execution state of the
  request they wrap", requestor-driven, with polling, a `ttl` for lifetime, and
  statuses including `working`, `completed`, `failed` and `cancelled`; the spec
  marks them experimental [28][29]. SEP-1686 introduced the feature and SEP-2663
  carries the extension work [30][31]. A2A defines a stateful task with archival
  potential and the states `submitted`, `working`, `input-required`,
  `auth-required`, `completed`, `failed`, `canceled`, `rejected` (plus
  `unspecified`), artifact and status-update events that must stream in order, and
  a hard rule that terminal tasks accept no further messages [27]. Together these
  give two interoperable task-lifecycle vocabularies a local store can align to
  instead of inventing one.

## 4. Blackboards, shared memory and coordination

**Classic blackboard systems** solved exactly the problem of many knowledge sources
cooperating on one evolving structured state: Hearsay-II is the reference
implementation, where independent knowledge sources post and revise hypotheses on
a shared blackboard under a control regime that resolves uncertainty [33]. The
distributed-problem-solving line added the two properties a modern agent ledger
needs: *functionally accurate cooperation* (agents exchange partial, uncertain
results rather than requiring global consistency) [34] and *partial global
planning*, where agents build and exchange partial plans of one another's activity
to coordinate without central scheduling [35]. Task allocation itself was
formalized by the Contract Net Protocol: announcement, bids, award, and a
commitment model that lets both parties decommit [36].

**What this maps onto today.** CrewAI-style shared short-term memory, MetaGPT-style
message pools, and graph/state-machine frameworks are described in surveys as
"shared-state or blackboard" communication, with the recurring warning that the
blackboard becomes an untyped global variable and consistency problems follow
[37]. The failure taxonomy work is the empirical counterpart: MAST was built from
rigorous analysis of 150 traces with expert annotators and released with 1,600+
annotated traces across 7 multi-agent frameworks, precisely because MAS gains are
often minimal and the reasons are structural, not model-specific [38].

**Cognitive-architecture framing.** CoALA's memory/action decomposition [17] is the
cleanest way to place the pieces of a task store: the open task tree is working
memory, completed work with outcomes is episodic memory, durable facts and
conventions are semantic memory, and procedures/skills are procedural memory.
Modern memory systems confirm that all four are needed and that a single storage
substrate has blind spots. The lineage starts with paging: MemGPT treats the context
window as fast memory and moves data between tiers under model control ("virtual
context management") [58]; associative graph memory organizes recall around
entities and their neighbours [59]; A-MEM lets the agent organize its own notes
dynamically instead of filling a fixed store [60]. Two benchmarks define what
remembering means across a multi-month interaction: LoCoMo grounds very long-term
dialogues in personas and temporal event graphs [65], while LongMemEval scores five
abilities specifically — extraction, multi-session reasoning, temporal reasoning,
knowledge updates and abstention [66]; the last two are exactly what a task store
lives or dies on, because stale facts and confident guessing are the visible
failures. Tree-structured conversational memory targets the fold problem directly
by supporting recursive retrieval over a hierarchy [67]. Agent Zero Memory then
runs three parallel systems (an
episodic event timeline that makes *when and what changed* first-class, an
entity-event knowledge graph, and a citation-locked curated fact store) behind an
intent gate and a router, so a self-contained turn adds no retrieval latency [76].
That intent gate is a design admission: not every turn should pay for retrieval.

## 5. Durable execution, journals and event sourcing

- **Event sourcing and replay.** Store state as an ordered append-only sequence of
  events; current state is a fold over the log; keep snapshots purely as
  optimizations [39]. For agents this makes branch/fold operations cheap and
  auditable: a fold is a snapshot, and the log remains the authority.
- **Rewrite versus restart.** Crash-only software argues that the correct recovery
  design is "always restart, never recover": the crash path and the normal start
  path are identical, so recovery logic cannot rot [40]. Applied to agents, the
  session or task store should be recoverable by replay, not by a special
  repair path.
- **Checkpoints and threads.** LangGraph's persistence layer distinguishes
  thread-scoped checkpoints (continuation, human-in-the-loop, time travel, fault
  tolerance) from cross-thread stores for application data and memory [41][42][43],
  and exposes time travel and branching over checkpoints in its front-end
  bindings [44]. This two-level split (per-thread run state versus durable
  cross-thread knowledge) is the same split this repository already makes between
  live ancestry and archived branches.
- **Journaled execution.** Restate services are durable handlers with a server in
  front that provides durable execution for otherwise ordinary application code
  [45]; DBOS documents durable workflow execution with its state kept in a
  database [46]. Both exist because "log every side effect, replay deterministically"
  beats "try to persist ad-hoc state structures".
- **Agent harnesses already do this.** OpenHands models a session as an event
  stream with an explicit runtime and controller, so agent activity is
  event-sourced rather than message-sourced [47]. Anthropic's platform exposes
  sessions that "maintain conversation history across multiple interactions", with
  a session event stream carrying session, span and agent events in both
  directions, including interrupts and mid-execution redirection [48][49]. A
  platform-level compaction facility now ships alongside them [50].

## 6. Durable task state in shipping agents and protocols

- **MCP tasks** — durable state machines with TTL and polling, requestor-driven,
  experimental [28][29].
- **A2A tasks** — eight-state lifecycle with artifacts, status-update events, and
  terminal-state immutability [27].
- **Anthropic Agent Skills** — the retrieval-side pattern that matters most for
  task notes: a skills directory where only name and description (about 100 tokens
  per skill) are always present, and the body is read from the filesystem on
  demand. The documentation calls this progressive disclosure: "Claude loads
  information in stages as needed, rather than consuming context upfront" [51].
  A companion memory tool gives the agent a durable, external place to write [52].
- **Anthropic's own long-horizon guidance** names three techniques for extended
  horizons: compaction, structured note-taking, and multi-agent architectures, and
  states the mechanism behind navigation-first context: letting agents retrieve
  data autonomously enables progressive disclosure, with Claude Code as the hybrid
  case where CLAUDE.md is dropped in up front while glob/grep retrieve files
  just-in-time [53]. It also names context rot: recall accuracy degrades as input
  tokens grow [53][84].
- **Anthropic's multi-agent system** is the reference delegation design: subagents
  operate in their own context windows in parallel and return condensed results,
  which is described as compression plus separation of concerns (distinct tools,
  prompts, trajectories, less path dependency); the reported gain was 90.2% over a
  single agent on an internal research eval, and token usage alone explained 80% of
  the variance in performance [54].
- **Manus** makes the transcript-only failure explicit and the fix explicit: it
  treats the file system as the ultimate context because it is unlimited, persistent
  and directly operable, and — the key line — the agent "tends to create a `todo.md`
  file and update it step-by-step", which "pushes the global plan into the model's
  recent attention span, avoiding lost-in-the-middle issues and reducing goal
  misalignment" [55]. The plan file is durable memory *and* an attention device.
- **Cognition argues the opposite of naive fan-out**: share context, and note that
  actions carry implicit decisions — its worked example is a subagent producing a
  game background in the wrong style because it never saw the decisions made
  elsewhere [56].
- **OpenAI Agents SDK** offers sessions as the durable conversation store for
  agent runs [57].
- **Local harness facts (this repository's runtime).** Pi sessions are JSONL files
  in which every entry has an ID and a parent, the active branch supplies model
  context, and compaction inserts a summary entry while the original entries remain
  in the tree [R1]. Summaries have a fixed schema — Goal, Constraints &
  Preferences, Progress, Key Decisions, Next Steps, with Critical Context added for
  compaction only and file lists appended — so **branch summaries deliberately stop
  before Critical Context** [R2]. The bundled `todo` extension stores its list in
  tool-result details, and the example documents the reason: state in session
  entries means "when you branch, the todo state is automatically correct for that
  point in history" [R3]. The bundled `plan-mode` extension instead extracts
  numbered steps from `Plan:` sections of assistant text, tracks completion from
  `[DONE:n]` markers in later assistant messages, and rebuilds completion state on
  resume by re-scanning messages [R4].

That last point is the crux for this repository: todo state is *persisted* (so
branches are correct) but it is *transcript-derived*, so its model-visible form
depends on the projection policy, and after a fold it can survive on disk while
disappearing from the working context unless the summary or the store carries it.

## 7. Human-agent progress interfaces

- **Initiative and interruption.** Horvitz's mixed-initiative principles remain the
  operating manual: consider uncertainty and costs of both acting and asking,
  minimize the cost of poor guesses, and let the user correct cheaply [92]. Iqbal
  and Horvitz quantified resumption: task interruption forces reorientation work,
  and the cost depends on how well the interface supports resuming [96]. A task
  tree that shows what was in flight is a resumption aid, not decoration.
- **Progress indication.** Myers established empirically that percent-done progress
  indicators change user behaviour and satisfaction [95]. The honest corollary for
  agents is that a fabricated or stale percentage is worse than a structured,
  verifiable progress state.
- **Overview first, details on demand.** Shneiderman's mantra (overview first, zoom
  and filter, details-on-demand) [94] is exactly the branch/fold interaction model:
  folded phases are the overview, expanding a handoff is details-on-demand. Pirolli
  and Card's information foraging adds the missing decision rule — people follow
  *information scent* — which is why a collapsed row must carry a scent line
  (goal, state, open items), not just a label [97].
- **Checklists and plans as coordination artifacts.** With plausible mechanism from
  the surgical-checklist trial, where a structured checklist reduced morbidity and
  mortality at scale [98], checklists work when the state is explicit and shared.
  Plans, by contrast, must be treated as estimates: the planning fallacy is
  robust, with actors systematically underestimating their own completion times
  [99], so an agent's self-reported remaining work is a weak signal and should be
  shown as a claim, not a forecast.
- **Agent-specific interfaces (2026).** AgentGUI is a locally hosted GUI for
  observing and steering multiple concurrent long-running sessions; a controlled
  study found 38% faster identification of key elements from agent traces (p =
  0.023), and its automated drift-prevention feature raised task completion by up
  to 34 percentage points across a 0.8B-9B local model ladder [77]. AdaLens builds
  an interactive storyline for monitoring and steering long-running agentic data
  analysis, joining temporal progression with drill-down [78]. MUSE restructures
  low-level execution traces into multiple semantic levels so users can navigate
  from overview to implementation detail, reference specific workflow steps in
  context, and repair a step without locating it by hand [79]. The convergent
  finding: trace-level detail is unusable without a semantic hierarchy over it, and
  drift detection is a first-class UI feature.
- **Trust calibration.** Amershi et al.'s guidelines (make clear what the system
  can do, time services to context, support efficient dismissal and correction,
  notify about changes, expose why) are the checklist for the human-facing surface
  of any task store [93].

## 8. Failure modes when task state lives only in the transcript

Evidence, in rough order of directness:

1. **Compaction silently drops constraints.** CONPACT studies user-issued side
   constraints ("do not delete any e-mails until I confirm") that constrain
   behaviour across turns but "can be silently dropped during compaction". In an
   inbox experiment the agent deleted e-mails without approval in 30/100 sessions
   after compaction versus none before; the evaluated compactors retained only 17%
   of injected constraints on average. Keeping constraints in a separate store and
   appending them to the compacted context restored retention above 90% [72]. This
   is the strongest available evidence that invariants must not be carried only by
   the summary.
2. **Compaction changes behaviour nondeterministically.** A matched-context study
   of long-horizon agents measured execution instability at decision boundaries
   around compaction, constructing matched contexts (full raw prefix, summary plus
   uncompressed recent step, updated summary) to isolate the effect [73]. Related
   work finds compaction lowering measured reliability while raising engagement,
   and shows the same context producing different behaviour across agent
   configurations [74]. Same context, different agent, different outcome: the
   transcript is not a state machine.
3. **Summaries lose the recoverable path.** ARC's diagnosis is precise: existing
   compaction discards, summarizes or retrieves earlier information and "may remove
   task-critical details or fail to recover them reliably". Its fix separates
   archival storage from active-context presentation — an append-only,
   ID-addressable log of tool observations, with compact citations in the active
   window and on-demand fetch by ID, avoiding both re-execution and
   similarity-only retrieval; 99.40% average exact-answer accuracy on
   needle-in-a-haystack versus 88.12% for the best baseline [71].
4. **Plans get violated by the agents that wrote them.** An ASE 2026 study, "From
   Plan to Action: How Well Do Agents Follow the Plan?", investigates plan
   violations by nondeterministic agents and reports that plan reminders can
   mitigate them [91]. A plan that exists only as prose in the transcript has no
   enforcement surface; a store can re-inject the active plan deterministically.
5. **Harness ablations show where the wins are.** A 2026 component-level study
   ablates planning, action space and context management over 176 matched settings
   and four models: context management becomes more valuable as the window budget
   tightens, most of its benefit comes from *preventing context-overflow failures*,
   staging rule-based elision before LLM summarization is the strongest strategy,
   and making elided content recoverable "adds machinery" (i.e. costs) [75]. Design
   conclusion: elide deterministically, keep a recovery handle, do not rely on
   summarization as the primary loss-control mechanism.
6. **Hierarchical summarization degrades recursively.** Recursive summarization of
   long documents works with human feedback [62] and gist memory compresses prompts
   to reusable tokens [61], but folds-of-folds drift: pi feeds the previous summary
   back in as iterative context when compacting again [R2], so errors and omissions
   compound. RAPTOR's tree-organized retrieval and ReadAgent's gist memory
   with explicit look-up decisions both exist to keep the raw material reachable
   [64][63].
7. **Long context is unreliable even when it fits.** Lost in the Middle: recall
   depends strongly on position, with the middle worst [83]. Context rot: accuracy
   degrades non-uniformly with input length even on trivial tasks and under minimal
   distractors [84]. Multi-turn degradation: a systematic study of 200,000+
   simulated conversations found an average ~39% performance drop in multi-turn
   settings with "lost-in-conversation" as the mechanism, and — importantly —
   agents answer prematurely; the authors summarise it as "when LLMs take a wrong
   turn in a conversation, they get lost and do not recover" [85]. NoLiMa removes
   the literal-matching shortcut from long-context evaluation and measures the cost:
   at 32K, eleven of the tested models fall below 50% of their short-context
   baseline, and even GPT-4o drops from 99.3% to 69.7% [86]; RULER varies effective
   context length systematically [87]. Practical consequence: a task list that is present but
   far down a long context is not reliably "known".
8. **Reliability is not captured by single-run success.** τ-bench introduced
   `pass^k` to measure consistency across trials and found state-of-the-art agents
   succeeding on about half the tasks and inconsistent across repetitions [88]. The
   METR long-task work quantifies capability as a 50%-task-completion time horizon
   (human-expert time), reporting around 50 minutes for Claude 3.7 Sonnet at the
   time of writing and a doubling roughly every seven months since 2019 [89]. If
   horizons keep lengthening faster than per-run reliability improves, durable
   external state is the only way to absorb failures.
9. **Real trajectories show where process breaks.** AutoResearchEval annotates 800
   end-to-end research trajectories across 7 domains with an empirically grounded
   failure taxonomy of 45 patterns (ARFT) whose authors locate the deficit at the
   model level — the absence of a metacognitive loop that checks what was produced
   against what was found, revises when it does not hold, and questions the path
   taken — rather than in any particular scaffold [81]. The work is motivated by
   the lack of process-level, artifact-level visibility into failures. Other 2026
   work documents multi-hour workflows in which upstream planning and research
   errors compound, agents finalize prematurely, and plan artifacts are produced
   without execution evidence [82].
10. **Tool interfaces shape failure.** SWE-agent's core result is that the
    agent-computer interface (including error feedback and history handling)
    dominates performance on real repositories [90]. Error messages for invalid
    state transitions belong in the interface, not in the prompt.

## 9. Design implications

Throughout, "task store" means an append-only record of task events plus a
materialized view, addressable by stable task IDs, stored durably outside the model
context and independent of any single session's projection.

### 9.1 Keep the store authoritative, and the transcript a projection

The transcript can be the journal, but it cannot be the only copy of task state,
because compaction, branching and summarization all rewrite what the model sees
[72][71][R2]. Two viable shapes:

- *Derived view*: task state is a fold over session entries (like the bundled
  `todo` extension [R3]), which is automatically branch-correct, but must be
  recomputed for the active branch and re-injected after every compaction.
- *Sibling store*: task events are written to their own log next to the session
  file (or to a database), with task IDs stable across branch, clone and fold.

Recommended: sibling log as the authority, session entries as the index. This
matches how the platform layer behaves (session plus event stream plus resources
[48][49]) and keeps the retrospective clone workflow honest: a clone must carry the
task records for the ranges it contains, and an archived branch must not lose
its open items. Write order is a design inference from event sourcing and
crash-only recovery rather than a cited result: write the store first, then the
context, so a crash between the two leaves a visible orphan record instead of an
invisible commitment [39][40].

### 9.2 Nested tasks and dependency edges

Model the tree structurally and the edges explicitly:

- Every task has a stable ID (never a line number), a parent, an optional set of
  `depends_on` edges and `blocks` edges, a lifecycle state, and a state history.
- Align the lifecycle to the two standard vocabularies instead of inventing one:
  MCP's durable-state-machine statuses (`working`/`completed`/`failed`/`cancelled`
  plus TTL) [28] and A2A's `submitted`/`working`/`input-required`/`auth-required`/
  `completed`/`failed`/`canceled`/`rejected` with terminal immutability [27].
  `input-required` in particular is the state a blocked-on-human task needs, and
  it should map to a *resumable pause*, not to failure.
- Implement milestone and cancellation semantics from the workflow-pattern
  catalogue: a task enabled "only while a stage has not been cancelled" [21], and
  case cancellation that abandons a subtree rather than losing it.
- Give each step an inverse or abandon story (saga semantics) so a replan cannot
  silently orphan effects [23].
- Expose re-execution semantics: inputs, outputs and a content key per step so
  "already done" is checkable and "must re-run" is derivable [24].
- Keep the goal lifecycle explicit on the root task (rebuild/reformulate/monitor/
  repair), because agents *should* drop goals that have become impossible, and that
  is a state transition, not a failure [5][4].

### 9.3 Attached notes, files, facts and decisions

These four payload kinds differ in truth conditions and should not share one free-
text field:

- **Notes**: free-form markdown attached to a task, append-only, addressable by ID;
  the natural unit for progressive disclosure [51].
- **Files**: path plus content hash plus the operation that produced it, mirroring
  pi's cumulative file tracking in summaries [R2]; a hash makes "still current"
  checkable and enables derive-from-input re-computation [24].
- **Facts**: typed as *given*, *to look up*, *to derive*, following Magentic-One's
  task ledger split [26], each with source, confidence and retrieval-on-demand
  pointer. Agent Zero Memory's "citation-locked" curated fact layer is the right
  discipline: a fact without a resolvable source is a rumor [76].
- **Decisions**: ADR-shaped records — context, options considered, decision,
  consequences, status (`accepted`, `superseded`, `reversed`) — because decisions
  are the payload that *causes* later divergence when unshared [56], and because
  "decisions and reversals" already appear in this repository's handoff schema
  [R5]. Decisions should be append-only with explicit supersession, never edited
  in place.

Attach provenance with the W3C PROV model's three roles — entities generated,
activities that generated them, and the agents responsible [100] — and reuse the
Web Annotation Data Model's body/target shape for notes and facts attached to tasks
[101]. Both are stable Recommendations and save schema invention. For
observability, the OpenTelemetry GenAI semantic conventions moved out of the main
conventions repository; cite the span/agent conventions from their new home when
instrumenting, and do not treat the old URL as authoritative [102].

### 9.4 On-demand retrieval

- **Two-tier presence.** Always-resident: the index line per open task (ID, title,
  state, owner, blocked-by, cost so far). Not resident: notes, artifacts, facts,
  decisions. This is progressive disclosure applied to tasks exactly as Agent
  Skills applies it to procedures [51][53].
- **Address, do not approximate.** Citations by ID in context, full content fetched
  by ID on request, is both cheaper and more reliable than similarity search over
  embeddings (ARC's result) [71]; it also matches Manus's finding that the
  filesystem *is* the context [55]. Similarity retrieval stays useful as a
  discovery aid for "which task was this", not as the retrieval mechanism for the
  active plan.
- **Retrieve when the agent decides, with a gate.** ACM gives the agent purpose-
  built context-editing tools and lets it decide when to compress, offload and
  re-query [70]; Agent Zero Memory's intent gate exists so self-contained turns pay
  no retrieval cost [76]. ReadAgent's explicit "when to look up" decision is the
  older statement of the same design [63].
- **Scent in the index.** Collapsed rows need enough text to judge relevance, per
  information foraging [97]; a fold row that says only "[branch: 412 messages]" is
  unreachable in practice.
- **The 2026 counter-current.** "Don't retrieve, navigate" style work argues for
  compiling durable structure (skills, wikis) and navigating it actively instead of
  running vector retrieval at inference time; Librarian Agents formalizes the
  asymmetry that agents navigate existing filesystems well but are rarely trained
  to *build* reusable workspaces for future sessions [69]. Implication: curating the
  task tree is itself work worth modeling (a curate/consolidate step), not just an
  artifact of the run.

### 9.5 Branch and fold summaries

Fold summaries are snapshots over the event log [39], with known failure modes and
known fixes:

- **Split narrative from invariants.** CONPACT's fix — extract constraints into a
  separate structure and re-inject verbatim — took retention from 17% to over 90%
  [72]. A fold must carry a machine-copied block of constraints, acceptance
  criteria and open items; the prose narrative may summarize everything else.
- **Never let the summary be the only copy.** Keep the folded range addressable by
  ID so retrieval can bypass the summary entirely [71], and never require the model
  to reconstruct state the store already has.
- **Schema the summary against the failures.** This repository's handoff already
  records goal/scope, work done, decisions and reversals, deliverables,
  verification and its limits, commits, open/deferred work and key facts [R5]; pi's
  native summary schema is Goal, Constraints & Preferences, Progress, Key
  Decisions, Next Steps, with Critical Context only for compaction and file lists
  appended [R2]. Note the asymmetry: **branch summaries drop Critical Context**,
  which is exactly where side constraints live. If folds are the primary archive in
  a long run, that omission should be closed or compensated by the store.
- **Bound the summary recursion.** Iterative re-summarization compounds loss [R2];
  mitigate by re-anchoring each fold to IDs, keeping raw ranges retrievable, and
  recomputing summaries rarely (only when the store's own record changes), with the
  derived summary marked as derived and reproducible [24][39].
- **Fold at task boundaries, not message boundaries.** The unit of folding should
  be a completed subtree of the task tree (with its decisions and artifacts), which
  is what retrospective cloning already does with ranges [R6].
- **Honesty rule for verification.** A fold must record what was verified and what
  was not, since outcome-only signals "grow uninformative as horizons lengthen"
  [20][R5].

### 9.6 Subagent ownership

- **Exactly one writer per task.** Ownership is a field (owner identity, session or
  subagent ID, grant time), and the update path is serialized. Blackboard systems
  chose controlled posting for this reason [33], and the general warning that an
  untyped shared board becomes a global variable is the argument for typed records
  and single-writer rules [37].
- **Delegation is a record, not a message.** Announcement, spec, acceptance
  criteria, budget, deadline, result artifact, acceptance verdict, and a
  decommitment path: contract-net semantics with a durable record [36]. The
  subagent result should be an artifact (file/pointer) plus a short report, which
  is what the Anthropic multi-agent system does to compress context and separate
  concerns [54].
- **Context sharing decides success.** Cognition's principles — share context, and
  remember that actions carry implicit decisions — predict the failure they show:
  subagents that cannot see the decisions produce plausible but wrong artifacts
  [56]. Ownership records should therefore carry the decision IDs that constrain the
  task, so a subagent receives the decisions, not just the instruction.
- **Design against the documented coordination failures.** MAST's annotated corpus
  is the test list: specification violations, inter-agent misalignment,
  verification gaps [38]. A2A's `rejected`/`failed` states and terminal
  immutability, and MCP's `failed`/`cancelled`, give the wire semantics [27][28].
  Dynamic concurrency research additionally shows that letting agents spawn
  subagents at will changes *scheduling and coordination* behaviour, with outcomes
  driven by orchestration rather than model capability on long-horizon work [80]:
  concurrency should be a policy the store knows about (max in-flight, ownership,
  join semantics), not an emergent side effect.
- **Reclaim orphaned work.** With one writer per task, a crashed or cancelled owner
  leaves a task in a reclaimable state; the store must define lease/expiry (MCP's
  `ttl` is a precedent [28]) and a resume path, otherwise long runs accumulate
  silently dead tasks [89][88].

### 9.7 Progress UI and human oversight

- Folded rows are the overview; expansion is details-on-demand [94]. Each row needs
  scent: goal, state, owner, open-item count, verification status [97].
- Show structured truth, not estimates: task states and artifacts are verifiable;
  "percent complete" from the model is planning-fallacy-prone [99] and, when wrong,
  actively harmful [95].
- Support resumption: the state a human needs first is "what was in flight, what
  was interrupted, what remains" [96], which is a query over the store.
- Surface drift and anomalies automatically; drift prevention measurably raised
  completion rates in AgentGUI's preliminary experiment, and trace navigation was
  measurably faster with hierarchy [77][79].
- Keep the approval gate explicit for irreversible actions: post-compaction
  constraint loss led to unapproved destructive actions in 30/100 sessions [72];
  a stored constraint with a required approval state is the structural fix.
- Trust calibration and correction affordances per Amershi et al. [93], with
  mixed-initiative cost reasoning for when the agent should ask [92].

## 10. Design options compared

| Option | Durability | Branch correctness | Post-compaction truth | Retrieval cost | Notes |
|---|---|---|---|---|---|
| Transcript-only list (prose or tool results in active branch) | Survives on disk [R1][R3] | Free (branch-scoped by construction) [R3] | Poor: summary is the only carrier; constraints lost [72][R2] | Cheap until evicted, then unrecoverable [71] | Pairs with `[DONE:n]` parsing [R4]; simplest, weakest |
| Transcript-only + strict fold schema | Same | Free | Better if the schema has a constraints block and open items [R5][72] | Summary is the ceiling; raw range addressable only if IDs kept [71] | This repository's current handoff direction |
| Sibling append-only task log + materialized view | Independent of compaction | Needs explicit branch/clone handling [R6] | Good: re-inject from store after each projection change [72] | ID-based fetch, no re-execution [71] | Recommended; needs GC and clone semantics |
| Event-sourced session + derived task view | Strong (replay) [39][47][48] | Inherent (log + branch offset) | Good if re-derived per projection | Replay or snapshot fetch | Most faithful, highest engineering cost |
| Filesystem-as-task-store (files per task) | Strong, agent-operable [55][68] | Manual (copy-on-clone) | Good; needs index hygiene | Navigation instead of retrieval [69] | Agent-friendly; organization degrades without curation [68] |

## 11. Recommendation

Concrete, minimal shape for a durable task store in this repository (design input,
not a committed plan):

1. **Store.** Append-only JSONL event log per session family
   (`task.created/state.changed/note.added/fact.recorded/decision.recorded/
   delegated/accepted/abandoned`), plus a rebuildable materialized index (JSON or
   SQLite) keyed by task ID. No model call required to rebuild. Keep it beside the
   session file, and define explicitly whether a retrospective clone copies,
   references or excludes events, because clones currently copy bodies unchanged
   [R6].
2. **Identifiers.** Stable IDs, never positions; every event references the task ID
   and, where relevant, the session entry ID that produced it, so the UI can jump
   from a task to the transcript and back (this repository's outline already
   navigates only to real persisted entry IDs [R1]).
3. **Records.** Task (id, parent, children, state, owner, depends_on, blocked_by,
   acceptance criteria, created/updated), note, artifact(file path + hash +
   producing event), fact(text, kind: given|lookup|derived, source, confidence),
   decision(ADR fields + status + supersedes).
4. **Refusal to lose invariants.** Maintain a `constraints` and `open_items` block
   that is copied verbatim into every fold summary and re-injected after each
   compaction; treat the summary as derived narrative and the store as authority
   [72][71].
5. **Retrieval contract.** Index line always in context (id, title, state, owner,
   blocked-by, open count); bodies fetched by ID with a single tool; the tool
   returns the raw record plus its provenance, never a paraphrase [71][70].
6. **Fold integration.** On branch/fold, emit a handoff that carries constraint and
   open-item blocks verbatim, decision IDs, artifact list with hashes, verification
   status with explicit limits, and the range's ID for bypass retrieval; keep the
   existing full/synthesized parent policy, and refuse to fold a subtree whose
   tasks are not terminal unless the fold marks them as carried-open [R5][R2][20].
7. **Ownership.** One writer per task; delegation creates a child task with an owner
   record, budget and acceptance criteria; results are artifacts plus a report;
   lease/expiry reclaims abandoned work; the store reports contention instead of
   letting two writers overwrite [36][54][56][80].
8. **Verification.** Target the three horizon-gap symptoms as acceptance criteria:
   no earlier decision lost, no half-finished task reported done, no goal drift
   without an explicit goal-state event [20]. Add a regression test that runs a
   compaction or fold across a task tree and asserts that constraints, open items
   and decision IDs survive verbatim in the projected context [72][75].

## 12. Risks, caveats and open questions

- **Evidence transfer.** Much of the failure evidence comes from model/harness
  combinations other than pi; CONPACT, ARC and the harness ablation are the most
  transferable, but none of them tested a sibling task store, so the recommendation
  is inference from mechanism, not a measured result for this design.
- **Two vocabularies.** MCP tasks and A2A tasks are close but not identical, and MCP
  tasks are explicitly experimental [28][27]; a local store should map onto them
  rather than adopt either wholesale.
- **GC and growth.** An append-only store grows forever; the build-systems
  literature says derived state can always be recomputed, but nothing reviewed here
  solves "which task records are still worth keeping" for agents.
- **Cross-session identity.** Whether tasks belong to a session, a session family,
  or a workspace is unresolved; the clone workflow in this repository makes the
  question concrete.
- **Authority of folded summaries.** Summaries remain the reviewed input of a
  conversion, not independent verification of historical claims [R1]; a store that
  records verification status does not by itself make claims true.
- **Human attention, not just agent state.** Every 2026 interface study reviewed
  improves the human side of oversight [77][78][79]; none shows a durable task store
  alone improving outcomes, so UI and store must ship together.
- **Open question worth answering next:** does an explicit `todo.md`-style plan
  file measurably reduce the horizon-gap symptoms in pi, and does the effect come
  from persistence, from attention recency, or from the human-visible artifact? The
  literature suggests all three contribute [55][53][75].

## 13. Project references (local, verified in this run)

- [R1] `docs/architecture.md` (invariants: active ancestry supplies context; native
  navigation targets real persisted entry IDs) and `docs/retrospective-cloning.md`
  (handoff records goal/scope, decisions and reversals, deliverables, verification
  and limits, commits, open work, key facts) in this repository.
- [R2] pi docs, `Compaction Reference`
  (`/home/furbyhaxx/.pi-bolt/pi-bolt-linux-x64/docs/compaction.md`):
  summary format Goal, Constraints & Preferences, Progress, Key Decisions, Next
  Steps; Critical Context only for compaction; file lists appended; previous summary
  passed as iterative context; `CompactionEntry.firstKeptEntryId`.
- [R3] `node_modules/@earendil-works/pi-coding-agent/examples/extensions/todo.ts`:
  todos stored in tool-result details so branch state is automatically correct.
- [R4] `node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/`:
  plan extraction from `Plan:` sections, `[DONE:n]` markers, `pi.appendEntry("plan-mode", …)`,
  resume rebuilds completion by re-scanning messages.
- [R5] `docs/retrospective-cloning.md`: user-visible fields of a handoff card and
  fold/expand interaction.
- [R6] `docs/retrospective-cloning.md`, `docs/architecture.md`: clone semantics —
  bodies copied unchanged, new header IDs, reviewed descendant plans, no model
  calls.

## 14. Sources

Classical planning, workflow and coordination theory

1. Fikes, R. and Nilsson, N. (1971). STRIPS: A New Approach to the Application of Theorem Proving to Problem Solving. *Artificial Intelligence* 2(3-4). doi:10.1016/0004-3702(71)90010-5. (verified via Crossref 2026-10-20)
2. Erol, K., Hendler, J. and Nau, D. (1996). Complexity results for HTN planning. *Annals of Mathematics and Artificial Intelligence* 18(1). doi:10.1007/BF02136175. (verified via Crossref)
3. Fox, M. and Long, D. (2003). PDDL2.1: An Extension to PDDL for Expressing Temporal Planning Domains. *JAIR* 20. doi:10.1613/jair.1129. (verified via Crossref)
4. Suchman, L. (1987). *Plans and Situated Actions: The Problem of Human-Machine Communication*. Cambridge University Press. 2nd edn 2006, doi:10.1017/CBO9780511808418. (2nd edn verified via Crossref)
5. Aha, D. (2018). Goal Reasoning: Foundations, Emerging Applications, and Prospects. *AI Magazine* 39(2). doi:10.1609/aimag.v39i2.2800. (verified via Crossref)
6. Aiello, A. et al. (2004). MAPGEN: Mixed-initiative planning and scheduling for the Mars Exploration Rover mission. *IEEE Intelligent Systems* 19(1). doi:10.1109/MIS.2004.1265878. (verified via Crossref)
21. van der Aalst, W., ter Hofstede, A., Kiepuszewski, B. and Barros, A. (2003). Workflow Patterns. *Distributed and Parallel Databases* 14(1), 5-51. doi:10.1023/A:1022883727209. (verified via Crossref and the publisher page)
22. OMG (2013). Business Process Model and Notation (BPMN) Version 2.0.2. https://www.omg.org/spec/BPMN/2.0.2/. (HTTP 200, 2026-10-20)
23. Garcia-Molina, H. and Salem, K. (1987). Sagas. *SIGMOD '87*. doi:10.1145/38713.38742. (verified via Crossref)
24. Mokhov, A., Mitchell, N. and Peyton Jones, S. (2018). Build Systems à la Carte. *PACMPL* 2(ICFP). doi:10.1145/3236774. (verified via Crossref)
33. Erman, L., Hayes-Roth, F., Lesser, V. and Reddy, D. (1980). The Hearsay-II Speech-Understanding System: Integrating Knowledge to Resolve Uncertainty. *ACM Computing Surveys* 12(2). doi:10.1145/356810.356816. (verified via Crossref)
34. Lesser, V. and Corkill, D. Functionally Accurate, Cooperative Distributed Systems. In *Readings in Distributed Artificial Intelligence* (1988). doi:10.1016/B978-0-934613-63-7.50034-6. (verified via Crossref)
35. Durfee, E. and Lesser, V. (1991). Partial global planning: a coordination framework for distributed hypothesis formation. *IEEE Trans. Systems, Man and Cybernetics* 21(5). doi:10.1109/21.120067. (verified via Crossref)
36. Smith, R. (1980). The Contract Net Protocol: High-Level Communication and Control in a Distributed Problem Solver. *IEEE Trans. Computers* C-29(12). doi:10.1109/TC.1980.1675516. (verified via Crossref)
37. Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems (2025, rev. 2026). arXiv:2502.14321. (title/date verified on arXiv)
38. Cemri, M. et al. (2025). Why Do Multi-Agent LLM Systems Fail? (MAST). arXiv:2503.13657. (abstract verified)

LLM planning, decomposition and agent memory

7. Zhou, D. et al. (2022). Least-to-Most Prompting Enables Complex Reasoning in Large Language Models. arXiv:2205.10625.
8. Khot, T. et al. (2022/2023). Decomposed Prompting: A Modular Approach for Solving Complex Tasks. arXiv:2210.02406.
9. Wang, L. et al. (2023). Plan-and-Solve Prompting. arXiv:2305.04091.
10. Yao, S. et al. (2022/2023). ReAct: Synergizing Reasoning and Acting in Language Models. arXiv:2210.03629.
11. Yao, S. et al. (2023). Tree of Thoughts: Deliberate Problem Solving with Large Language Models. arXiv:2305.10601.
12. Prabhakar, A. et al. (2023/2024). ADaPT: As-Needed Decomposition and Planning with Language Models. arXiv:2311.05772.
13. Liu, B. et al. (2023). LLM+P: Empowering Large Language Models with Optimal Planning Proficiency. arXiv:2304.11477.
14. Kim, S. et al. (2023/2024). An LLM Compiler for Parallel Function Calling. arXiv:2312.04511.
15. Wang, G. et al. (2023). Voyager: An Open-Ended Embodied Agent with Large Language Models. arXiv:2305.16291.
16. Park, J. S. et al. (2023). Generative Agents: Interactive Simulacra of Human Behavior. arXiv:2304.03442.
17. Sumers, T., Yao, S., Narasimhan, K. and Griffiths, T. (2024). Cognitive Architectures for Language Agents (CoALA). arXiv:2309.02427 (TMLR).
18. Shinn, N. et al. (2023). Reflexion: Language Agents with Verbal Reinforcement Learning. arXiv:2303.11366.
19. Wang, Z. et al. (2024). Agent Workflow Memory. arXiv:2409.07429.
20. The Horizon Gap: Planning, Memory, Execution, Training, and Evaluation for Long-Horizon LLM Agents (2026). arXiv:2608.06663. (abstract verified)

Durable execution, workflows and protocol-level task state

25. Temporal. Workflow execution (event history, replay, Continue-As-New). https://docs.temporal.io/workflow-execution. (fetched 2026-10-20)
26. Fourney, A. et al. (2024). Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks. arXiv:2411.04468. (task/progress ledger quotes verified in the paper HTML)
27. Agent2Agent (A2A) Protocol specification. https://a2a-protocol.org/latest/specification/. (fetched; task states and terminal-state rules verified)
28. Model Context Protocol specification 2025-11-25, Basic utilities: Tasks. https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks.md. (fetched; "durable state machines", polling, ttl, statuses verified)
29. Model Context Protocol, Tasks extension overview. https://modelcontextprotocol.io/extensions/tasks/overview.md. (fetched)
30. MCP SEP-1686: Tasks. https://modelcontextprotocol.io/seps/1686-tasks.md.
31. MCP SEP-2663: Tasks Extension. https://modelcontextprotocol.io/seps/2663-tasks-extension.md.
39. Fowler, M. (2005). Event Sourcing. https://martinfowler.com/eaaDev/EventSourcing.html. (HTTP 200)
40. Candea, G. and Fox, A. (2003). Crash-Only Software. *HotOS IX*. https://www.usenix.org/legacy/events/hotos03/tech/full_papers/candea/candea.pdf. (HTTP 200)
41. LangChain. LangGraph Persistence. https://docs.langchain.com/oss/python/langgraph/persistence. (fetched)
42. LangChain. LangGraph Checkpointers. https://docs.langchain.com/oss/python/langgraph/checkpointers.
43. LangChain. LangGraph Stores. https://docs.langchain.com/oss/python/langgraph/stores.
44. LangChain. Time travel (checkpoint navigation). https://docs.langchain.com/oss/python/langchain/frontend/time-travel.
45. Restate. Durable execution concepts. https://docs.restate.dev/concepts/durable_execution. (fetched)
46. DBOS documentation. https://docs.dbos.dev/. (HTTP 200; landing page only)
47. Wang, X. et al. (2024). OpenHands: An Open Platform for AI Software Developers as Generalist Agents. arXiv:2407.16741.
48. Anthropic. Managed Agents: Start a session. https://platform.claude.com/docs/en/managed-agents/sessions. (fetched)
49. Anthropic. Managed Agents: Session event stream. https://platform.claude.com/docs/en/managed-agents/events-and-streaming. (fetched)
50. Anthropic. Compaction (platform feature). https://platform.claude.com/docs/en/build-with-claude/compaction.
51. Anthropic. Agent Skills overview (progressive disclosure). https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview. (fetched)
52. Anthropic. Memory tool. https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.
53. Anthropic (2025-09-29). Effective context engineering for AI agents. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents. (fetched)
54. Anthropic (2025-06-13). How we built our multi-agent research system. https://www.anthropic.com/engineering/multi-agent-research-system. (fetched)
55. Manus. Context Engineering for AI Agents: Lessons from Building Manus. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus. (fetched; todo.md recitation quoted)
56. Yan, W. / Cognition (2025-06-12). Don't Build Multi-Agents. https://cognition.ai/blog/dont-build-multi-agents. (fetched)
57. OpenAI. Agents SDK: Sessions. https://openai.github.io/openai-agents-python/sessions/. (HTTP 200)

Memory, retrieval and 2026 agent-state research

58. Packer, C. et al. (2023/2024). MemGPT: Towards LLMs as Operating Systems. arXiv:2310.08560. (abstract verified)
59. Gutiérrez, B. et al. (2024/2025). HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models. arXiv:2405.14831. (title/date verified on arXiv)
60. Xu, W. et al. (2025). A-MEM: Agentic Memory for LLM Agents. arXiv:2502.12110. (abstract verified)
61. Mu, J. et al. (2023). Learning to Compress Prompts with Gist Tokens. arXiv:2304.08467.
62. Wu, J. et al. (2021). Recursively Summarizing Books with Human Feedback. arXiv:2109.10862.
63. Lee, K. et al. (2024). A Human-Inspired Reading Agent with Gist Memory of Very Long Contexts (ReadAgent). arXiv:2402.09727.
64. Sarthi, P. et al. (2024). RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval. arXiv:2401.18059.
65. Maharana, A. et al. (2024). Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo). arXiv:2402.17753. (abstract verified)
66. Wu, D. et al. (2024/2025). LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. arXiv:2410.10813. (abstract verified)
67. Ke, Y. et al. (2026). Dynamic Memory Forest: Constructing and Tracing Conversational Trajectories for Long-Term Conversation. *SIGIR '26*. doi:10.1145/3805712.3809646. (verified via Crossref)
68. Filesystem-Based Memory for LLM Agents: Organization, Evolution, and Sustainability (2026). arXiv:2607.26637. (abstract verified)
69. Librarian Agents: Training LLMs to Curate Long-Context Workspaces that Anticipate Future Queries (2026). arXiv:2610.22273. (abstract verified)
70. Agentic Context Management for Long-Horizon Tasks (2026). arXiv:2607.23809. (abstract verified)
71. Addressable Recall Compaction for Long Context-Window Control in AI Agents (2026). arXiv:2607.25066. (abstract verified)
72. Lost in Context Compaction: When LLM Systems Drop Side Constraints (2026). arXiv:2608.11242. (abstract verified; 17%, 30/100, >90% figures)
73. Towards Reliable Context Compression for Long-Horizon Agents: An Empirical Study of Execution Instability (2026). arXiv:2608.06503.
74. Same Context, Different Agents: A Behavioral Study of Semantic Layers, Orchestration and Compaction in Data Agents (2026). arXiv:2610.20959.
75. An Empirical Study of Harness Design for Coding Agents (2026). arXiv:2609.20804. (abstract verified; 176 settings, four models)
76. Agent Zero Memory: Provenance-Aware Long-Term Memory for LLM Agents (2026). arXiv:2608.29606. (abstract verified)
77. AgentGUI: An Interface for Observing and Steering Long-Running AI Agents (2026). arXiv:2607.26300. (abstract verified; 38% faster, up to 34pp)
78. AdaLens: Interactive Storyline for Monitoring and Steering Long-Running Agentic Data Analysis (2026). arXiv:2608.17834.
79. MUSE: An Interactive Meta-Agent for Understanding and Steering LLM-powered Data Science Systems (2026). arXiv:2608.16181. (abstract verified)
80. When Sub-Agents Work in Parallel: The Promises and Pitfalls of Dynamic Concurrency in Long-Horizon Coding Tasks (2026). arXiv:2610.10263. (abstract verified)
81. How do agents fail on autoresearch: End-to-End Diagnostic Evaluation on 100 Real-World Frontier Research Tasks (2026). arXiv:2608.14905. (abstract verified; ARFT taxonomy)
82. A Phased Workflow for Operating LLM-Based Coding Agents (2026). arXiv:2608.30701.

Context limits, reliability and agent interfaces

83. Liu, N. F. et al. (2023/2024). Lost in the Middle: How Language Models Use Long Contexts. arXiv:2307.03172 (TACL).
84. Hong, K., Troynikov, A. and Huber, J. (2025-07-14). Context Rot: How Increasing Input Tokens Impacts LLM Performance. Chroma technical report. https://research.trychroma.com/context-rot. (fetched)
85. Laban, P. et al. (2025). LLMs Get Lost In Multi-Turn Conversation. arXiv:2505.06120.
86. Modarressi, A. et al. (2025). NoLiMa: Long-Context Evaluation Beyond Literal Matching. arXiv:2502.05167.
87. Hsieh, C.-P. et al. (2024). RULER: What's the Real Context Size of Your Long-Context Language Models? arXiv:2404.06654.
88. Yao, S. et al. (2024). τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains. arXiv:2406.12045. (abstract verified; pass^k)
89. Kwa, T. et al. (2025/2026). Measuring AI Ability to Complete Long Software Tasks. arXiv:2503.14499 (NeurIPS 2025). (abstract verified; 50%-time-horizon metric)
90. Yang, J. et al. (2024). SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering. arXiv:2405.15793.
91. Liu, X., Dehghan, A., Ganhotra, J., Hirzel, M. and Jabbarvand, R. (2026). From Plan to Action: How Well Do Agents Follow the Plan? *ASE 2026*. doi:10.1145/3832783.3834400. (bibliographic record verified via Crossref; findings quoted from the publisher listing)
92. Horvitz, E. (1999). Principles of mixed-initiative user interfaces. *CHI '99*. doi:10.1145/302979.303030. (verified via Crossref)
93. Amershi, S. et al. (2019). Guidelines for Human-AI Interaction. *CHI '19*. doi:10.1145/3290605.3300233. (verified via Crossref)
94. Shneiderman, B. (1996). The Eyes Have It: A Task by Data Type Taxonomy for Information Visualizations. *IEEE VL '96*. doi:10.1109/VL.1996.545307. (verified via Crossref)
95. Myers, B. (1985). The importance of percent-done progress indicators for computer-human interfaces. *CHI '85*. doi:10.1145/317456.317459. (verified via Crossref)
96. Iqbal, S. and Horvitz, E. (2007). Disruption and recovery of computing tasks. *CHI '07*. doi:10.1145/1240624.1240730. (verified via Crossref)
97. Pirolli, P. and Card, S. (1999). Information foraging. *Psychological Review* 106(4). doi:10.1037/0033-295X.106.4.643. (verified via Crossref)
98. Haynes, A. B. et al. (2009). A Surgical Safety Checklist to Reduce Morbidity and Mortality in a Global Population. *NEJM* 360. doi:10.1056/NEJMsa0810119. (verified via Crossref)
99. Buehler, R., Griffin, D. and Ross, M. (1994). Exploring the "planning fallacy". *JPSP* 67(3). doi:10.1037/0022-3514.67.3.366. (verified via Crossref)

Provenance, annotation and instrumentation standards

100. W3C (2013). PROV-DM: The PROV Data Model. W3C Recommendation 30 April 2013. https://www.w3.org/TR/prov-dm/. (fetched)
101. W3C (2017). Web Annotation Data Model. W3C Recommendation 23 February 2017. https://www.w3.org/TR/annotation-model/. (fetched)
102. OpenTelemetry. Generative AI semantic conventions. https://opentelemetry.io/docs/specs/semconv/gen-ai/ — page now redirects: "GenAI semantic conventions have moved". (fetched; follow the notice before instrumenting)

## 15. Verification status

Verified in this run (2026-10-20): all Crossref records in section 14 (title,
venue, year, DOI), all arXiv identifiers (title and submission/last-revised date via
each abstract page), and every documentation URL marked fetched or HTTP 200.

Not verified, and treated accordingly in the text:

- Claims attributed only to a publisher search snippet: [91] (ASE paper finding about
  plan reminders). The bibliographic record is verified; the finding is not.
- [46] DBOS: only the documentation landing page was reachable; durable-workflow
  details come from that page's title and position, not from its internals.
- [30][31] MCP SEPs and [42][43][44][50][52] documentation pages: existence and
  titles verified through the official documentation index (`llms.txt`), not by
  fetching each page.
- [102] OpenTelemetry GenAI conventions: the old URL now serves a "moved" notice;
  the new home could not be resolved from this host (`github.com` is unreachable),
  so the target repository is not linked here.
- Ni's blackboard-system article (AI Magazine, 1986) and Corkill's later blackboard
  survey could not be machine-verified (no matching Crossref record, AAAI
  article IDs guessed and wrong). The blackboard lineage in section 4 therefore
  rests on [33][34][35] plus the survey [37]; add the Ni citation only after
  checking it against a library record.
- GitHub-hosted artifacts referenced by primary sources (for example the MCP tasks
  extension repository named by [29], and the `gh project` kanban the repository's
  AGENTS.md requires) could not be checked because `github.com` is unreachable from
  this host; this note did not inspect the project kanban.
- No experiment was run: the design in section 11 is inference from the cited
  mechanisms and measurements, not a measured result for pi.
- [59] HippoRAG, [63] ReadAgent, [64] RAPTOR, [61] gist tokens and [62] recursive
  summarization are cited for their published approach (title and abstract level);
  no numerical result from them is quoted here. The measured retrieval numbers in
  this note come from [71] and [72], whose abstracts were read in full.
