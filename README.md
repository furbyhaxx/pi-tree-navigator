# pi-tree-navigator

🌳 Agent-callable session tree navigation for [pi](https://github.com/badlogic/pi-mono).

Anchor named milestones, then fold conversation spans into model-generated handoffs while keeping the original history browsable. An independent engine summarizes and commits the fold; it does not need another main-agent turn to succeed. Manual, agent-requested, automatic and recovery folds share preservation and request-budget checks.

This way you can have a session that looks like this :)

<img width="2686" height="708" alt="image" src="https://github.com/user-attachments/assets/dc3beecf-c18c-4ab2-b5a8-19b9f94d1498" />


## Install

Stable npm release:

```bash
pi install npm:@cad0p/pi-tree-navigator
```

Pre-release npm snapshots from `main` are published with the `next` dist-tag:

```bash
pi install npm:@cad0p/pi-tree-navigator@next
```

You can also install directly from the git source when testing unreleased branches:

```bash
pi install git:github.com/cad0p/pi-tree-navigator
```

## Restructure an existing session

This fork adds retrospective cloning: turn completed work in a linear or branched
session into nested summary branches without modifying the original. The clone gets a
new ID and a ` (restructured)` name suffix, and both sessions remain resumable.

Run `/anchor` for the unified menu: `tree`, `list`, `current`, `fold`, `clone`,
`settings`. `/tree-clone` no longer exists; use `/anchor clone`.

- **Tree:** browse handoffs, archived work, anchors and user turns. Enter shows
  details; `g` confirms navigation to the real entry; `f` filters the outline.
  Pi's native `/tree` remains available for its complete graph.
- **List:** inspect active anchors, create one with `n`, or request a fold with `r`.
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
  tool disclosure policies, then save to global, trusted project or runtime scope.
  `/anchor settings show` prints effective settings without opening a panel.

All panels share a breadcrumb frame, fuzzy search (`/`), navigation keys and an
Escape/back path. Filtering keeps the panel height stable; narrow hint bars keep
Escape and search visible. Destructive or session-moving actions require confirmation.

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

## Publishing

This repo uses [`cad0p/semver-calver-release`](https://github.com/cad0p/semver-calver-release)'s npm-package workflow:

- Pushes to `main` compute the next hybrid SemVer + CalVer version, tag a GitHub prerelease, and publish to npm with the `next` dist-tag.
- Curated release PRs from `release/from-v*` branches bump the base `package.json` version and publish stable npm releases.
- npm publishing uses GitHub OIDC / npm trusted publishing via `.github/workflows/release.yml` (`id-token: write`) and `publishConfig.access: public`.

### Requirements

- **pi 1.3+** (Node ≥22.19). This fork raises the host floor for retrospective cloning's system/tool-state replay checks; live rewinds still require a configured model provider. Offline clone inspection, preview and creation do not.
- Peer dependencies (the source of truth is `package.json` `peerDependencies`):
  - `@earendil-works/pi-coding-agent >=1.3.0`
  - `@earendil-works/pi-agent-core >=1.3.0`
  - `@earendil-works/pi-ai >=1.3.0` (`isContextOverflow` / `isRecoverableLength`, the overflow checks independent recovery shares with pi)
  - `typebox ^1.0.0` (used to declare the tool's parameter schema; bundled with pi but listed explicitly so a standalone install resolves correctly).
- The reflection bootstrap depends on plain (not `#`-private) internal pi/agent fields: `AgentSession.prototype.prompt` (patched for session capture) and `agent.state.messages` (refreshed after a rewind so the next prompt snapshots the rewound chain). After a rewind the extension also emits `session_tree` through the captured session's plain `_extensionRunner` field (#79; see [History-mirroring providers](#history-mirroring-providers-pi-claude-bridge)). Per-turn in-loop context refresh runs through the **public** `context` extension event (see “In-loop context refresh” below) — no `agent.prepareNextTurn*` reflection. The rewind's same-run continuation relies on pi's `turn_end` boundary contract (handlers awaited before the steering drain, returned entries committed, `continue` honoured; public since 0.87). Verified against pi 1.3.0 via `scripts/pi-upstream-probe.mjs`.

## What you get

A single agent-callable tool, `navigate_tree`, with four actions:

| action | params | effect |
|---|---|---|
| `anchor` | `name` | Label the current point in the conversation as a milestone. |
| `rewind` | `rewindTo`, `newLabel`, `summaryFocus` | Queue an independent fold at the next turn boundary, after sibling and nested tools finish. The engine summarizes, validates and branches without asking the main agent to generate the handoff. The original subtree stays on disk. `summaryFocus` is required; `newLabel` must be fresh. See [Independent folding](#independent-folding). |
| `list` | — | Show all anchors on the active branch with cumulative context %, followed by the continuity ledger's active items when there are any. |
| `pin` | `kind`, `text` (or `path` + `why` for files), `scopeAnchor` | Record a durable item in the [continuity ledger](#continuity-ledger-endless-sessions) that survives every fold. `kind` is `sub-goal`, `decision`, `fact`, `file` or `steering`; rules and the objective are the user's alone and cannot be pinned. A `file` pin stores a sha256 so a later change marks it stale. Steering belongs to an anchor (default: the newest) and lapses when that anchor is folded. Refused when `continuity.capture` is `false`. |

`name` (written by `anchor`) and `newLabel` (written by `rewind`) both share the reserved `anchor:` label prefix; `rewindTo` resolves against that same namespace. Every label written by `anchor` and every `newLabel` written by `rewind` is referenceable by any subsequent `rewind`'s `rewindTo`, and `list` shows all of them. A completed rewind also writes `branch:<newLabel>` on the old fold point, so `/tree` can jump back to the full collapsed segment; `branch:` labels are not anchors (`rewindTo` does not resolve them, `list` does not show them).

Labels are unique on the active branch: `anchor` refuses a `name` and `rewind` refuses a `newLabel` that already exists (the `rewind` check runs before summarization), and an existing label is never moved or cleared. The old move-on-collision rename-forward idiom (`anchor x` → `rewind(newLabel=x)`) is retired — a rewind needs a fresh `newLabel`; the existing label stays addressable via `rewindTo`. Manual `/tree` labels can still duplicate; `list` shows every match and `rewindTo` resolves leaf-most. The extension itself also writes one silent label per session leg: `anchor:start` (see [Automatic start anchor](#automatic-start-anchor)).

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
immediately to the current session; no reload is needed. Reset removes a key from
the selected scope, revealing the lower layer rather than forcing the default.
Unknown keys and existing JSON key aliases are preserved on disk. An untrusted
project is neither read nor edited, and malformed files must be corrected before
that scope can be saved. File-level problems (non-ENOENT read error, invalid JSON, non-object root) warn and make that layer contribute nothing for *every* field, so the other layer still applies; a missing file is silent. Each field-level invalid value emits its own field-scoped warning when the session has a UI (headless sessions stay silent, like every `ui.notify`).

## Rewind hint (optional)

Long autonomous sessions can blow through context silently — the model can't read pi's footer, and `rewind` is a targeted alternative to pi's lossy auto-compaction, but nothing tells the agent *when* to use it. The rewind hint is an opt-in `turn_end` observer that fires **once per crossing**: when the tokens left in the context window drop to the configured reserve, the agent gets a persisted nudge to persist what matters to files and rewind to an anchor. Default: **disabled** (pi's own compaction behavior is unchanged).

Enable it with `rewindHintReserveTokens` (see [Configuration](#configuration-tree-navigatorjson) for the layer paths and the shared file-level failure semantics):

```json
{ "rewindHintReserveTokens": 50000 }
```

- Value: integer **1000–1000000** inclusive — the number of tokens left in the window (`contextWindow − context tokens`) at which the hint fires. A bare number is canonical (`50000`); a digits-only string (`"50000"`, surrounding whitespace allowed) is also accepted. Size it like pi's `compaction.reserveTokens`: it is an absolute budget for the persist + summary turns, so it means the same thing on a 100k and a 1M window. A reserve at or above the window fires on the first observed turn and never re-arms while that window stays (the tokens left can never climb above it); only a switch to a model with a larger window can re-arm it.
- Explicit-disable sentinels: `null`, `false`, `"off"`, `"disabled"` (case-insensitive) — the project layer can switch off a global value.
- Precedence: a project key, when present, wins (including sentinels). Absent → global. Absent everywhere → disabled.
- Invalid value (out of range, non-integer, a string other than digits — signs, decimals, exponents — `true`, object): the hint stays off for the session — no fallback to the other layer's reserve — and its field-scoped warning is shown when the session has a UI.
- One hint per crossing: fires when `tokens left <= reserve`, re-arms only after the tokens left climb back above it (a rewind or compaction); no escalation, no re-fire while spent.
- **Removed in 0.3.0: `rewindHintAtPercent`.** A percentage meant very different budgets on different windows (90% leaves 100k on 1M but 10k on 100k). The key is now ignored with a field-scoped warning pointing at `rewindHintReserveTokens`; migrate by picking the tokens you want left (e.g. `"90"` on a 1M window → `100000`).

When the crossing has at least one `anchor:` label on the active branch, the agent receives a persisted custom message naming every active anchor with its cumulative context percentage — so the model knows a rewind target exists (including the automatic `start`) without a `list` call. Mid-run this steers the running loop (one reaction turn in the same run); when the agent is idle it only appends and waits for the user's next prompt, so an idle-agent rewind stays user-confirmed:

```text
[navigate_tree hint] Context is at 95.2% of 1.0M — 48.0k tokens left, within the 50.0k reserve. Persist what matters to files now, then rewind to the oldest appropriate anchor.
Active anchors (root → leaf, % of 1.0M):
   4.1%  start
  12.0%  context-gathered
```

The same anchor table appears in min-savings refusals and `list`, which adds an `(after: “…”)` preview. The fold plan uses the full materialized preview; anchors before compaction are marked when branching to them would restore compacted history.

With no anchors the extension sends **no model message** (a rewind is impossible) and shows a TUI-only warning explaining how to add one manually: `/tree`, select the entry to rewind to, press `shift+l`, label it `anchor:<name>` (e.g. `anchor:context-gathered`), then ask the agent to rewind to it.

### Per-model reserve (`modelOverrides` / `model_overrides`)

Different models need different budgets: a model that writes long summaries or grows context fast per turn needs a larger reserve. `modelOverrides` (or `model_overrides`) sets `rewindHintReserveTokens` (`rewind_hint_reserve_tokens`) and `auto_navigate` per model or wildcard pattern (`*gemini-4-argon*`, `openrouter/*`, or bare `gemini-4-argon`):

```json
{
  "rewind_hint_reserve_tokens": 50000,
  "auto_navigate": {
    "enabled": false,
    "mode": "anchor-and-rewind",
    "pressure": "compact",
    "keep_recent_share": 0.25,
    "milestone": "recommended",
    "check_every_turns": 6,
    "min_tokens_since_anchor": 25000,
    "rewind_at_tokens": 120000,
    "tools": { "bash": "calls-only", "read": "omit" }
  },
  "model_overrides": {
    "*gemini-4-argon*": {
      "rewind_hint_reserve_tokens": 120000,
      "auto_navigate": {
        "enabled": true,
        "check_every_turns": 4,
        "min_tokens_since_anchor": 20000,
        "rewind_at_tokens": 90000
      }
    }
  }
}
```

When `auto_navigate.enabled` is true, two things happen at each turn boundary:

- **Pressure compaction (default, deterministic).** When the estimated context
  reaches `rewind_at_tokens` in `anchor-and-rewind` mode with `pressure: "compact"`,
  the newest `keep_recent_share` of `rewind_at_tokens` (default 0.25, range
  0.05–0.45) stays verbatim and everything older is summarized into one native
  Pi compaction. The cut lands on a message boundary and never separates a tool
  call from its result, so the files and results the agent is working with stay
  in context. No anchor is needed. The summary carries still-open user requests
  verbatim and the continuity briefing; the compaction entry gets an
  `anchor:compacted` label, a later fold or recovery target. No anchor is folded,
  so steering stays active and the ledger is unchanged. The result must land
  under half of `rewind_at_tokens`, priced like the request guard prices the
  next request (system, tools, summary, kept work and receipt). Before any
  summary call, a summary of the full reduce-output size is assumed; after it,
  the real summary is priced. Otherwise nothing is written and a warning says
  whether to lower `keep_recent_share` or raise `rewind_at_tokens`. Leave room:
  half of `rewind_at_tokens` minus the kept share must hold the system prompt
  and the summary (at 200k and 0.25: 50k). The same retry rule as pressure
  folds applies.
- **Pressure fold (`pressure: "fold"`, deterministic).** At the same threshold
  the independent engine folds back to an anchor instead, without asking a
  classifier. It uses the canonical cut and the shared
  materialized preview, and folds to the newest anchor whose result lands under
  half of `rewind_at_tokens`. There is no oldest-anchor fallback: a fold that
  lands just under the threshold would fire again after a few file reads and
  discard the agent's current work each time. When no anchor reaches that budget,
  a warning names the smallest reachable size and the `rewind_at_tokens` it needs.
  A retry (after a fold or a skip) needs half of `rewind_at_tokens`, at least
  `min_tokens_since_anchor`, of fresh estimated tokens. Unfinished work is folded
  too; still-open user requests are kept verbatim after the handoff. A request
  closes on a text-only final reply, on a newer user message after the agent
  responded, or on a later handoff. An attached skill is quoted as a reference to
  its file, not its body.
- **Milestone anchors (classifier).** Below the threshold, after
  `check_every_turns` completed turns or `min_tokens_since_anchor` fresh tokens,
  the configured `milestone` policy judges projected, disclosure-filtered evidence
  from the current phase. The recommended policy asks two models in parallel and
  accepts only when both agree above the confidence threshold. An accepted
  boundary becomes an `anchor:` label, a better fold target later; classifiers
  never trigger a fold.

No user prompt or rewind steer is injected. Results are discarded when the
branch, active model, policy or cancellation state changes while a check runs.
Existing labels are never overwritten. When a pressure fold cannot run (no valid
anchor, an unanswered tool call, a pre-compaction target, a non-reducing handoff),
a visible `navigate-tree-auto-warning` names the reason; the history is kept.
`anchor-only` mode places milestone anchors and never folds. An unavailable model,
abstention, disagreement or provider error makes no semantic decision.

Fold summary side calls run at the session's thinking level capped at `low`, with
room for reasoning on top of the answer budget; a `length` stop is retried once
with reasoning off.

`milestone` accepts `"recommended"`, `null` (disabled), or a tunable object:
`{minConfidence?, classifier?: {model?}, confirmer?: {model?}, status?: {instructions?}, boundary?: {instructions?}}`.
Use `/anchor settings` to change stage models and question instructions.
Disabling the confirmer trades corroboration for a single model's decision.
The former `controller_model` setting is replaced by this policy; migrate it
explicitly rather than assuming the old selector applies to a different API.

The recommended policy and its benchmark provenance live in
`milestone-policy.ts`. Zero unsafe decisions in a finite synthetic benchmark
is not a guarantee of error-free automatic folding. Automatic folding remains
opt-in; recovery does not require classifier approval.

It is keyed like pi's `compaction.modelOverrides`, but each entry takes `rewindHintReserveTokens` (not pi's `reserveTokens`) with this extension's value rules, including the disable sentinels pi does not accept:

```json
{
  "rewindHintReserveTokens": 40000,
  "modelOverrides": {
    "opencode-go/deepseek-v4.1-flash": { "rewindHintReserveTokens": 50000 }
  }
}
```

- Keys are the exact `provider/modelId` of the active model (as in pi's `/model` list). The reserve is resolved against the live model on every turn, so a mid-session `/model` switch takes effect on the next turn. The crossing is shared across the switch and re-arms whenever the tokens left exceed the active model's reserve, so switching to a model with a smaller reserve (or one with the hint off) can re-arm it and a later switch back can fire again.
- A matching entry wins over the base `rewindHintReserveTokens`, including an entry sentinel (`"off"` disables the hint for that model only) and an entry that enables the hint while the base is off. No matching entry, or no active model → the base value.
- Layers merge per key: a trusted project entry that sets `rewindHintReserveTokens` replaces the global entry for the same model (an entry without it is ignored, so the global entry stays), other keys pass through. As in pi, a matching entry from either layer beats the base value from either layer, so a global model entry beats a project-wide base.
- Entry values follow the base field's rules. An invalid entry value disables the hint for that model (no fallback to the base) with a field-scoped warning. A non-object `modelOverrides` or entry warns and is ignored; an entry without `rewindHintReserveTokens` (e.g. a pasted pi `reserveTokens` entry) is ignored, and so are other keys inside an entry.

### Rewind hygiene (always on)

Independent of the hint, the tool ships two static `promptGuidelines` bullets, present whenever `navigate_tree` is active: **when rewinding, prefer the oldest anchor that keeps what you'd otherwise re-read or re-derive**, persisting durable findings to files first; and **don't rewind while a user decision or unresolved question is pending** — ask the user instead. The bullets are not config-gated (`registerTool` fixes the array at registration), cost ~64 tokens per request (257 chars / 4), and change the cached system-prompt prefix once per active session on upgrade (the provider-facing tool schema is unchanged).

### Independent overflow recovery

When `navigate_tree` is active and Pi's native auto-compaction is disabled,
recovery is on even when rewind hints and milestone auto-folding are off.
Manual folding remains available independently of this automatic ownership rule.

The final preflight check includes the effective system prompt, tool declarations
and projected conversation. Its estimate uses valid recorded usage plus the
estimated tail; without a valid baseline it estimates the whole request.
Context edits, compaction and runtime-state changes invalidate stale baselines.
The hint, plan, anchor list and request guard use the same admission policy.
These are estimates; provider-measured input is available only after a response.

If fewer than 1,024 output tokens plus 4,096 headroom remain, the extension awaits
the independent fold engine before dispatching the main request. It selects a
valid anchor using the full materialized preview, summarizes outside the main
agent, preserves unanswered input verbatim and returns the smaller projection.
Successful recovery does not abort the run or ask the model to call a tool.

A provider context-overflow response is handled through the same engine at the
appropriate lifecycle boundary. Native compaction/retry ownership and user
cancellation take precedence. Recovery attempts are bounded: a repeated failure
produces an actionable receipt instead of an unbounded retry loop. A request that
cannot fit at all is refused before dispatch with `Request stopped before generation: estimated input <n> tokens leaves fewer than 1024 output tokens plus 4096 headroom`;
nothing is withheld and the original history is kept.

Recovery does not withhold tool results or impose a rewind-only tool gate.
Incomplete tool envelopes, stale state, missing anchors, non-reducing handoffs
and insufficient post-fold headroom refuse the fold. The source history stays
available; the receipt identifies why the operation could not finish. If another
extension rejects a boundary draft, settlement checks delivery and persists the
missing failure receipt once.

### Compaction guidance

Use one automatic recovery owner. Pi's native auto-compaction takes precedence
when `compaction.enabled` is true. To use navigator recovery, disable it in Pi's
global or trusted-project `settings.json`:

```json
{ "compaction": { "enabled": false } }
```

`anchor`, `list`, manual folding and explicit agent folds remain available.
Settings are read from the live session, so a settings change applies without
editing installed source files.

The optional hint reserve is an early-warning and target-selection allowance,
not an enable switch for recovery. Keep it comfortably above the 5,120-token
minimum request headroom to allow useful work before pressure forces a fold.
Recovery chooses the newest valid target whose materialized preview leaves that
reserve, or the oldest valid target when none meets the recommendation budget.
With hints off, the recommendation leaves 25% of the window free. Every selected
target must still pass the engine's actual reduction and headroom gates.

### Handoff consolidation (on by default)

Handoffs before a fold target stay in context, so they pile up across a long
session. At a completed turn boundary, the extension merges every projected entry
before the oldest of the newest `keep_newest` handoffs into one project-history
summary and appends it as a native Pi `compaction` entry. The newest handoffs and
everything after them stay verbatim; the merged originals remain in the JSONL.

```text
before: H1 H2 H3 H4 H5 ... leaf
after : [compaction: H1..H3 merged] H4 H5 ... leaf
```

| key (`consolidation`) | default | effect |
|---|---|---|
| `enabled` | `true` | Turn background consolidation on or off. |
| `max_handoffs` / `maxHandoffs` | `4` | Consolidate when more handoffs than this are in context. |
| `max_window_share` / `maxWindowShare` | `0.1` | Or when handoffs exceed this share of the window. |
| `keep_newest` / `keepNewest` | `2` | Handoffs kept verbatim after the cut. |

- The summary is an independent side call (chunked, low reasoning) under the same
  per-session lock as folds. It never runs while a fold is queued or running, after
  an errored or aborted turn, or when the session changed meanwhile.
- The cut is refused when a tool call before it has its result after it. The
  compaction must free at least 4,000 estimated tokens; otherwise nothing is written.
- Every refusal or failure appends a visible `navigate-tree-auto-warning`; a success
  appends a `navigate-tree-consolidation` receipt and emits `session_compact`.
- Later folds to an anchor inside the kept range carry the compaction forward, so
  anchors after the cut stay foldable. Anchors before the cut are refused.

## Continuity ledger (endless sessions)

A fold keeps the work summary but used to lose the user's own binding words: goals, rules,
decisions and steering. The continuity ledger keeps them verbatim across any number of folds.

```text
user message ──capture──▶ ops entry ──replay──▶ ledger ──fold──▶ snapshot in branch_summary
                                                   │                      │
                                                   └── briefing embedded in the handoff ◀─┘
```

- **Capture** runs at `turn_end` and reads only new user messages and `ask_user` answers.
  Explicit wording ("from now on", "going forward", "decision:", "let's go with", bare
  "always"/"never" in short messages) becomes a protected item; everything else stays
  ordinary conversation. Long messages only yield sentences with explicit rule or decision
  wording, at most three, never an objective. `/anchor` fold requests are ignored.
- **Persistence is branch-local.** The ledger is the replay of `navigate-tree-continuity-ops`
  entries since the last fold; each fold stores a snapshot in `branch_summary.details.continuity`.
  Rewinding to an earlier branch restores that branch's ledger.
- **Fold.** The independent summary request lists the binding items and the user messages the
  model may cite. The model may append one `<continuity-delta>` block (completed goals, newly
  ratified facts, supersessions, expired steering). The extension validates it, applies it as an
  agent proposal and embeds the resulting briefing (about 2,500 tokens at most) in the stored
  handoff. No extra model call. A malformed delta applies nothing and is reported in the
  fold result.
- **Authority.** User-origin rules, decisions and the objective cannot be deleted, archived,
  rewritten or completed by the agent or a classifier. A supersession must cite a newer user
  message. Rejected ops are listed in the fold result, never applied.

| key (`tree-navigator.json`) | default | effect |
|---|---|---|
| `continuity.capture` | `true` | Turn capture and the agent's ledger writes on or off. |
| `continuity.intentClassifier` | `null` | Model policy that judges each new user message (below). `null`, `false`, `"off"` or `"disabled"` keep the local heuristics. Failed stages stop making requests for the session; a failed kind stage or a 15 s capture timeout falls back to heuristics. |

`continuity.intentClassifier` accepts three forms. Every model is a `provider/id` from the Pi
catalog with configured credentials; a Decisions classifier is preferred, otherwise a chat model
answers the same questions as strict JSON.

- `"provider/id"`: one model answers both the intent kind and the supersession question.
- `"recommended"`: the benchmarked preset. `openrouter/microsoft/microsoft-decision-1` judges the
  kind and which active item the message replaces; `openrouter/openai/gpt-6-luna` is asked the
  supersession question only when the classifier abstains. The kind is never escalated: in the
  benchmark, escalating it accepted unsafe answers. A retirement proposed by the escalation
  needs a separate Microsoft decision-model check of that specific item. A refusal, uncertain
  answer, cancellation or failed check keeps the existing item active. A primary accepted
  answer or a confident `none` does not trigger this check. Measured supersession-chain cost
  was about $0.04 per 1,000 decisions; it is not a fixed price for complete message capture.
- An object that overrides the preset field by field. A stage with `"model": null` is off;
  `instructions` (1-1,000 characters) replaces the question wording.

```json
{
  "continuity": {
    "intentClassifier": {
      "preset": "recommended",
      "heuristics": true,
      "minConfidence": 0.7,
      "kind": { "model": "openrouter/microsoft/microsoft-decision-1" },
      "supersession": {
        "model": "openrouter/microsoft/microsoft-decision-1",
        "escalation": { "model": "openrouter/openai/gpt-6-luna" },
        "verification": { "model": "openrouter/microsoft/microsoft-decision-1" }
      }
    }
  }
}
```

Set either nested stage's `model` to `null` to disable it, or select another catalogued
model and override its `instructions`. Disabling verification allows escalation-proposed
retirements without the extra check. The benchmark observed one wrong retirement in
96 escalation-chain decisions before verification; zero observed failures is not a guarantee.

Without `preset`, unset stages are off. `heuristics: false` requires a `kind.model`. Answers
below `minConfidence` abstain; the heuristics then keep explicit markers. Any model policy
sends each new user message (up to about 3 KB) and the active ledger items to the provider,
which is why the default stays local. The evidence, including measured limits, is in
`.project/analyses/classifier-eval/summary.md`.

`/anchor current` (aliases `ledger`, `briefing`) browses and edits the active branch's ledger:
`x` retracts an item after a confirmation (it stays in the session history), `e` edits its text
(the original quote is kept), `p` pins or unpins (a pinned item of any kind is out of the agent's
reach), `c` completes a goal, `a` adds a rule, decision, sub-goal or fact, `h` shows superseded
and retracted items, and Enter shows an item's source and revisions. Edits are refused while the
agent is working or when `continuity.capture` is `false`; browsing always works. Without a UI the
command prints the briefing.

Capture only runs while `navigate_tree` is in the active tool set. The heuristics miss
instructions phrased without a marker ("drop X and only keep Y"). A classifier can capture
those, but low-confidence answers abstain; they do not guarantee complete intent capture.
On abstention, explicit heuristic markers and excerpts are retained. Confidence thresholds
and user-authority protections remain unchanged. Review missing or conflicting items with
`/anchor current`; the agent can also `pin` its own supporting facts and decisions.

## Automatic start anchor

Independent of the hint, the extension writes a silent `anchor:start` label at the X-th turn of the agent run (or at the run's end if it finishes earlier), so every session leg has a guaranteed low-floor fallback rewind target (typically ~4% of the window) with no user action. `start` shows up in `list` output like any other anchor; nothing else model-visible changes in v1.

`anchorStartAfterTurns` (see [Configuration](#configuration-tree-navigatorjson)):

- Value: integer **1–50** inclusive. A bare number is canonical (`2`); numeric strings (`"2"`) are accepted. Default **2**.
- **Non-optional**: unlike the hint, an absent `anchorStartAfterTurns` — or no config file at all — still fires at the default; absence is never a warning.
- Invalid value (out of range, decimal, non-numeric string, `null`, `false`, object): a field-scoped warning, then the other layer's valid value applies, else the default 2 — a touched-but-invalid value must not disable a non-optional feature.
- Precedence: trusted project > global > default 2.
- Kill switch: `PI_NAVIGATE_TREE_START_ANCHOR=0` suppresses the write, read at write time (a mid-process change applies without `/reload`).

Behavior and edge cases:

- **Run-bounded**: X counts native turns of the current agent run. A run shorter than X anchors at its end (`agent_end`); `agent_end` fires on completed, aborted, and errored runs, so settlement always happens by the end of the first run (with X=2, even a one-turn run anchors at turn 1).
- **Once per session**: `start` marks the start of the current session leg. Once the label is written — or found already on the active branch (e.g. a manual `/tree` label) — the extension never writes it again in that session, including later prompts and agent loops. `/reload` re-evaluates only via the existence check, so no duplicate is ever written.
- **Every session**, including subagents, gated only on `navigate_tree` being in the active tool set (headless included).
- **Labels are unique** (see [What you get](#what-you-get)): the tool refuses a duplicate `name`/`newLabel`, so `start` is never moved or overwritten by the agent. A manual `/tree` duplicate remains possible; `list` shows both and `rewindTo` resolves leaf-most.
- Silent by design: a label entry only — no model message, no UI.

## How it works

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

## Limitations

- **Summaries are lossy.** Structural checks and continuity preservation do not
  prove semantic completeness. Original messages remain in the archived branch;
  inspect important reports and pin durable facts.
- **Budgets are estimates.** Planning and execution share an admission policy,
  but provider tokenization can differ. Provider errors still need recovery or
  an explicit failure.
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
pnpm install
pnpm test
pnpm run lint
pnpm run typecheck
node scripts/pi-upstream-probe.mjs
```

Without pnpm, an already-installed checkout can run `node --test`,
`node_modules/.bin/tsc --noEmit` and `node_modules/.bin/biome check` directly.
See [Verification](docs/verification.md) for exact suite commands, SDK-loop and
terminal contracts, and the budgeted live acceptance runner.

The tests cover the independent engine, current evidence projection, shared
materialization preview, active and late input preservation, preflight/provider
recovery, policy validation and confirmation, and historical handoff rendering.
The byte-exact r5d prompt remains pinned. SDK-loop tests use local providers and
do not establish real-provider cache reuse or summary quality.

### Live verification

Use a disposable synthetic session and the extension under test. Keep raw safe
request/response evidence, usage and original failed runs. Never copy credentials
or send private sessions for testing.

- **Independent execution:** manual and preflight folds make summary side calls
  before any main-agent turn. Agent and automatic folds execute at their safe
  boundary without another model turn to initiate the operation.
- **Continuation:** the post-fold model receives the reduced projection, still-open
  user request and new input, then fulfills that request without a driver follow-up.
- **Budget:** distinguish projected estimates, provider-measured input, cache reads
  and cumulative traffic. Inspect Strategy A cache reuse; Strategy B may use a
  different prefix and does not promise the same cache hit.
- **Preservation:** check required facts, constraints and remaining work against the
  source. `node scripts/summary-quality-check.mjs <session.jsonl> --all` is structural
  smoke, not a semantic completeness proof.
- **TUI:** drive the plan, progress/cancellation and result cards at 60 and 130
  columns. Verify the footer updates and Ctrl+O/mouse interactions work.

## License

MIT — see [LICENSE](LICENSE).
