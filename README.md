# pi-tree-navigator

🌳 Agent-callable session tree navigation for [pi](https://github.com/badlogic/pi-mono).

Anchor named milestones, then fold conversation spans into model-generated handoffs while keeping the original history browsable. An independent engine summarizes and commits the fold; it does not need another main-agent turn to succeed. Manual, agent-requested, automatic and recovery folds share preservation and request-budget checks.

This way you can have a session that looks like this :)

<img width="2686" height="708" alt="image" src="https://github.com/user-attachments/assets/dc3beecf-c18c-4ab2-b5a8-19b9f94d1498" />


## Install

This fork is installed from git; `main` is the release channel:

```bash
pi install git:github.com/furbyhaxx/pi-tree-navigator
```

## Restructure an existing session

This fork adds retrospective cloning: turn completed work in a linear or branched
session into nested summary branches without modifying the original. The clone gets a
new ID and a ` (restructured)` name suffix, and both sessions remain resumable.

Run `/anchor` for the unified menu: `tree`, `list`, `current`, `fold`, `clone`,
`settings`. `/tree-clone` no longer exists; use `/anchor clone`.

- **Tree:** browse handoffs, archived work, anchors and user turns. Enter shows
  details; `Alt+g` confirms navigation to the real entry; `Alt+f` filters the outline.
  Pi's native `/tree` remains available for its complete graph.
- **List:** inspect active anchors, create one by selecting `+ Set new anchor at current leaf…`
  with Enter, or request a fold with `Alt+r`.
- **Current:** inspect and edit the continuity ledger; pin/unpin, retract, mark
  sub-goals done, or show historical items. Writes are blocked while the agent runs.
- **Fold:** review one recommended plan, including the target, projected context
  and summary strategy. Enter runs the independent engine; label and focus are
  editable. A request made while the agent works runs at the next turn boundary.
  Progress is visible and Escape cancels before commit. `/anchor fold <anchor>`
  opens the plan with that anchor selected. Without a UI, `/anchor fold` prints
  the plan and `/anchor fold <anchor|recommended> [new-label]` folds (or queues
  while the agent works).
- **Clone paths:** `inspect`, `preview` and `create` take one path and no options;
  a stray `--option` is refused instead of becoming part of the filename. Quote
  a path that contains `--`.
- **Clone:** inspect, propose, review, preview and create with readable screens.
  Raw JSON is an explicit advanced option, never the default review surface.
- **Settings:** stage scalar settings, model choices, per-model overrides and
  tool disclosure policies. Opens in **Session** scope; apply without writing a file,
  or explicitly choose Global or trusted Project scope to persist changes.
  Save/apply and scope selection are searchable rows operated with arrows and Enter;
  Alt shortcuts are optional. `/anchor settings show` prints effective settings.
- **Pause automatic folding:** in `/anchor settings`, select **Pause automatic folding**.
  This session-only switch wins over per-model enablement. It stops milestone checks
  and automatic pressure folds/compaction; recovery, continuity capture, hints and
  manual/tool folds remain active. Select **Resume automatic folding** to restore the
  configured policy. Reloading or switching sessions clears the pause.

All panels share a breadcrumb frame, fuzzy search (type to filter), navigation keys and an
Escape/back path. Filtering keeps the panel height stable; narrow hint bars keep
Escape and search visible. Row actions use left Alt plus the displayed mnemonic;
Space toggles boolean rows when the filter is empty and separates search terms otherwise.
`/` is ordinary filter text. Destructive or session-moving actions require confirmation.

Use `/anchor clone inspect <session.jsonl>`, then `/anchor clone propose <session.jsonl>`
to derive a local heuristic tree. Add `--llm` to refine it with the current model,
or `--model openai/gpt-6-luna:high` to select another provider/model and thinking
level. Review and save the proposed plan, then `/anchor clone preview <plan.json>`
and `/anchor clone create <plan.json>`. Creation requires confirmation and never
switches sessions automatically.
Descendant sessions are copied with unchanged histories by default; a plan's
`recurse` option restructures them only with reviewed descendant plans.
An offline CLI is also available. Model analysis is explicit and optional;
inspection, heuristic proposals, preview and creation make no model calls.
`treeProposal` settings select the default model and which tools' calls/results
may be sent. Existing rewind branches and native summary references are preserved.

This fork also renders useful native handoff cards: title, goal, outcome and
recorded inclusive token/cost statistics appear before expansion. Converted
sessions open a chronological, nested `/tree` outline with `[current]` inside
its open phase; F2 returns to Pi's raw conversation graph.

`parentHandoffMode` in `tree-navigator.json` selects `digest` (default: a synthesized
parent report plus one bounded index line per child), `full` (retain child handoffs
once each), or `synthesized` (a relevance-focused parent report only). The summarizer
always receives full child reports as evidence; digest keeps the originals in
session history, reachable through `/anchor tree`. Existing handoffs retain their
frozen mode. Plans may override the mode per group; plans without a mode retain
`full`. The agent receives materialized handoff text, not the collapsed UI label.

See [Retrospective session cloning](docs/retrospective-cloning.md) for the plan
format, safety checks, CLI commands, and limitations. See
[Code overview and invariants](docs/architecture.md) for implementation boundaries.

## Requirements

- **Pi 1.3+** (Node ≥22.19). Live folds need a configured model provider; offline clone
  inspection, preview and creation do not.
- Pi packages (`@earendil-works/pi-coding-agent`, `-pi-agent-core`, `-pi-ai`, `-pi-tui`) and
  `typebox` are peer dependencies provided by Pi.
- The extension relies on a few plain (not `#`-private) Pi internals:
  `AgentSession.prototype.prompt`, `agent.state.messages` and `_extensionRunner`.
  `just probe` (`scripts/pi-upstream-probe.mjs`) checks them against the installed Pi.

## What you get

A single agent-callable tool, `navigate_tree`, with four actions:

| action | params | effect |
|---|---|---|
| `anchor` | `name` | Label the current point in the conversation as a milestone. |
| `rewind` | `rewindTo`, `newLabel`, `summaryFocus` | Queue an independent fold at the next turn boundary, after sibling and nested tools finish. The engine summarizes, validates and branches without asking the main agent to generate the handoff. The original subtree stays on disk. `summaryFocus` is required; `newLabel` must be fresh. See [Independent folding](docs/how-it-works.md#independent-folding). |
| `list` | — | Show all anchors on the active branch with cumulative context %, followed by the continuity ledger's active items when there are any. |
| `pin` | `kind`, `text` (or `path` + `why` for files), `scopeAnchor` | Record a durable item in the [continuity ledger](docs/configuration.md#continuity-ledger-endless-sessions) that survives every fold. `kind` is `sub-goal`, `decision`, `fact`, `file` or `steering`; rules and the objective are the user's alone and cannot be pinned. A `file` pin stores a sha256 so a later change marks it stale. Steering belongs to an anchor (default: the newest) and lapses when that anchor is folded. Refused when `continuity.capture` is `false`. |

`name` (written by `anchor`) and `newLabel` (written by `rewind`) both share the reserved `anchor:` label prefix; `rewindTo` resolves against that same namespace. Every label written by `anchor` and every `newLabel` written by `rewind` is referenceable by any subsequent `rewind`'s `rewindTo`, and `list` shows all of them. A completed rewind also writes `branch:<newLabel>` on the old fold point, so `/tree` can jump back to the full collapsed segment; `branch:` labels are not anchors (`rewindTo` does not resolve them, `list` does not show them).

Labels are unique on the active branch: `anchor` refuses a `name` and `rewind` refuses a `newLabel` that already exists (the `rewind` check runs before summarization), and an existing label is never moved or cleared. The old move-on-collision rename-forward idiom (`anchor x` → `rewind(newLabel=x)`) is retired — a rewind needs a fresh `newLabel`; the existing label stays addressable via `rewindTo`. Manual `/tree` labels can still duplicate; `list` shows every match and `rewindTo` resolves leaf-most. The extension itself also writes one silent label per session leg: `anchor:start` (see [Automatic start anchor](docs/configuration.md#automatic-start-anchor)).

**Anchoring is mandated, not suggested.** On every agent start the extension appends a one-line mandate to the end of the system prompt (`before_agent_start`), gated on the tool being active: `navigate_tree: gather all context, then anchor \`context-gathered\`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.` The append lands after project context and skills, is re-applied on every prompt, and survives compaction — unlike the `promptGuidelines` bullet it replaced. ~40 tokens (159 chars / 4), constant for prompt caching.

## Configuration (`tree-navigator.json`)

The extension reads global and trusted-project files, with optional session-only
runtime overrides set through `/anchor settings`:

| Layer | Path |
|---|---|
| Global | `join(getAgentDir(), "tree-navigator.json")` (`PI_CODING_AGENT_DIR`-aware) |
| Project | `join(cwd, CONFIG_DIR_NAME, "tree-navigator.json")` (`.pi/` by default; read only when the project is trusted — untrusted projects are ignored silently) |
| Runtime | In memory for the current session; cleared on session start/switch or `/reload`, never written to a config file |

```json
{ "rewindHintReserveTokens": 50000, "anchorStartAfterTurns": 2 }
```

A runtime key wins over project, which wins over global (including the hint's
disable sentinels); absent everywhere uses the field's default. Settings saves apply
immediately to the current session; no reload is needed. Session overrides and the
session automatic-fold pause clear on `/reload` or a session switch. Reset removes a key from
the selected scope, revealing the lower layer rather than forcing the default.
Unknown keys and existing JSON key aliases are preserved on disk. An untrusted
project is neither read nor edited, and malformed files must be corrected before
that scope can be saved. File-level problems (non-ENOENT read error, invalid JSON, non-object root) warn and make that layer contribute nothing for *every* field, so the other layer still applies; a missing file is silent. Each field-level invalid value emits its own field-scoped warning when the session has a UI (headless sessions stay silent, like every `ui.notify`).


Each setting, its default and its behavior is documented in
[Configuration reference](docs/configuration.md): rewind hint and per-model reserves,
rewind hygiene, independent overflow recovery, compaction guidance, handoff
consolidation, the continuity ledger and the automatic start anchor.
[How folding works](docs/how-it-works.md) covers the independent engine, runtime
integration and history-mirroring providers.

## Limitations

- **Summaries are lossy.** Structural checks and continuity preservation do not
  prove semantic completeness. Original messages remain in the archived branch;
  inspect important reports and pin durable facts.
- **Budgets are estimates.** Planning and execution share an admission policy.
  Estimated text is priced at the ratio the current model reported for its last
  request of at least 50k estimated tokens, or for any smaller request whose
  reported input exceeded the operating window (never below Pi's 3.5 characters
  per token, at most 8x the four-char heuristic), because dense code, JSON and
  CJK text cost far more on some tokenizers. Pressure compaction keeps its
  configured tail in these calibrated tokens. The first fold right after a model
  switch, before that model has answered once, still uses the default. Provider errors still need recovery or an explicit
  failure.
- **Some folds cannot reduce context.** Retained prefixes, full child handoffs,
  protected continuity and unanswered input can already consume the budget.
  Chunking makes summary requests manageable; it cannot guarantee that the final
  handoff fits. Pre-compaction targets may restore history and are refused.
- **Side calls have a cost.** A fitting in-context call can reuse cache; chunked
  extraction and reduction make multiple billed requests. Call/output bounds
  limit work but are not a monetary spending limit for normal product use.
- **Model decisions can be wrong or abstain.** Benchmark results describe the
  published synthetic dataset, not a universal safety guarantee. Automatic
  folding is opt-in; deterministic gates still decide whether a fold is valid.
- **Context disclosure is configurable.** Model-assisted capture and milestone
  checks send permitted inputs to their chosen providers. Capture defaults to
  local heuristics. Review policy settings before opting in.
- **Provider compatibility matters.** Independent requests must respect the
  supplied context and cancellation. History-mirroring providers require separate
  validation; ordinary API-provider results do not establish their behavior.
- **Persistence is not atomic.** Pi can move its in-memory leaf before an append
  fails. The engine validates before commit and attempts recovery on failure, but
  an uncertain disk write cannot be described as safely rolled back.
- **Other extensions can interfere with boundaries.** A later handler's invalid
  draft can prevent a continuation receipt from committing. Failure reporting and
  SDK-loop tests cover known cases, not every extension combination.
- **Host internals can change.** Session capture, agent-message refresh and history
  rewrite notification depend on the integration surfaces above. Host upgrades
  require upstream probes and runtime checks.
- **History grows.** Folding frees active context, not disk space. Archived
  messages and historical failures remain in the JSONL.
- **Label namespaces are reserved.** Use `anchor:` and `branch:` only for
  navigator targets and archived fold points. Existing labels are not overwritten.
- **Unloading needs a restart.** The session-capture prototype patch is
  process-wide; restarting Pi fully removes it.

## Development

```sh
just install
just check        # typecheck + lint + test
just rpc-verify   # load the extension in a real Pi RPC session
just probe        # check the Pi internals the extension relies on
```

See [Verification](docs/verification.md) for live provider, terminal and classifier
acceptance.

## License

MIT — see [LICENSE](LICENSE).
