# Configuration reference

Settings live in `tree-navigator.json`; layers and precedence are described in the
[README](../README.md#configuration-tree-navigatorjson).

## Rewind hint (optional)

Long autonomous sessions can blow through context silently — the model can't read pi's footer, and `rewind` is a targeted alternative to pi's lossy auto-compaction, but nothing tells the agent *when* to use it. The rewind hint is an opt-in `turn_end` observer that fires **once per crossing**: when the tokens left in the context window drop to the configured reserve, the agent gets a persisted nudge to persist what matters to files and rewind to an anchor. Default: **disabled** (pi's own compaction behavior is unchanged).

Enable it with `rewindHintReserveTokens` (see [Configuration](../README.md#configuration-tree-navigatorjson) for the layer paths and the shared file-level failure semantics):

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
  so steering stays active and the ledger is unchanged. The target is half of
  `rewind_at_tokens`, priced like the request guard prices the next request
  (system, tools, summary, kept work and receipt), with a full-size summary
  assumed before the call. When the configured share cannot reach the target,
  the kept tail shrinks first, down to a quarter of the configured share, never
  splitting a tool call from its result. The target guides sizing only: a
  compaction that still lands above it runs anyway, and its receipt names the
  result and the target. It is skipped only when it would free too little
  context (see below). The same retry rule as pressure folds applies.
- **Pressure fold (`pressure: "fold"`, deterministic).** At the same threshold
  the independent engine folds back to an anchor instead, without asking a
  classifier. It uses the canonical cut and the shared
  materialized preview, and folds to the newest anchor whose result lands under
  half of `rewind_at_tokens`. When no anchor reaches that target, it folds to the
  oldest valid anchor, which still relieves context, and the receipt says it
  landed above the target. A retry (after a fold or a skip) needs half of
  `rewind_at_tokens`, at least `min_tokens_since_anchor`, of fresh estimated
  tokens, so a result that lands high does not refire after a few file reads. Unfinished work is folded
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
Existing labels are never overwritten. When pressure relief cannot reduce
context at all (no valid anchor, an unanswered tool call, a non-reducing
handoff or compaction, a failed summary), a visible `navigate-tree-auto-warning`
names the reason; the history is kept.
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
cancellation take precedence. When the request a recovery produced still cannot
fit (estimates can undercount dense code), recovery runs again, up to three
times per request, as long as each attempt starts from less context than the
previous one. Progress is measured before calibration, so a token factor learned
from the overflow does not read as growth. Once the recovered request generates
within the operating window, a later overflow in the same run is a new request
and recovers again; a reply whose reported input exceeded the window still
counts as part of the same recovery. Only when
no attempt can reduce context is the request refused before dispatch with
`Request stopped before generation: estimated input <n> tokens leaves fewer than 1024 output tokens plus 4096 headroom`;
nothing is withheld and the original history is kept.

Recovery does not withhold tool results or impose a rewind-only tool gate.
When no anchor is valid, or the fold fails (a non-reducing handoff, too little
post-fold headroom, a failed summary), recovery falls back to a tail-keeping
compaction like pressure compaction: older work is summarized into a native
compaction, the newest work stays verbatim, and a
`navigate-tree-pressure-compaction` receipt with `origin: "recovery"` reports the
result. Incomplete or interleaved tool envelopes and a changed model or session
refuse without any write. The source history stays available; the receipt
identifies why the operation could not finish. If another extension rejects a
boundary draft, settlement checks delivery and persists the missing receipt once,
for successes and failures.

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
  kind and which active item the message replaces; `openai/gpt-6-luna` is asked the
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
        "escalation": { "model": "openai/gpt-6-luna" },
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

`anchorStartAfterTurns` (see [Configuration](../README.md#configuration-tree-navigatorjson)):

- Value: integer **1–50** inclusive. A bare number is canonical (`2`); numeric strings (`"2"`) are accepted. Default **2**.
- **Non-optional**: unlike the hint, an absent `anchorStartAfterTurns` — or no config file at all — still fires at the default; absence is never a warning.
- Invalid value (out of range, decimal, non-numeric string, `null`, `false`, object): a field-scoped warning, then the other layer's valid value applies, else the default 2 — a touched-but-invalid value must not disable a non-optional feature.
- Precedence: trusted project > global > default 2.
- Kill switch: `PI_NAVIGATE_TREE_START_ANCHOR=0` suppresses the write, read at write time (a mid-process change applies without `/reload`).

Behavior and edge cases:

- **Run-bounded**: X counts native turns of the current agent run. A run shorter than X anchors at its end (`agent_end`); `agent_end` fires on completed, aborted, and errored runs, so settlement always happens by the end of the first run (with X=2, even a one-turn run anchors at turn 1).
- **Once per session**: `start` marks the start of the current session leg. Once the label is written — or found already on the active branch (e.g. a manual `/tree` label) — the extension never writes it again in that session, including later prompts and agent loops. `/reload` re-evaluates only via the existence check, so no duplicate is ever written.
- **Every session**, including subagents, gated only on `navigate_tree` being in the active tool set (headless included).
- **Labels are unique** (see [What you get](../README.md#what-you-get)): the tool refuses a duplicate `name`/`newLabel`, so `start` is never moved or overwritten by the agent. A manual `/tree` duplicate remains possible; `list` shows both and `rewindTo` resolves leaf-most.
- Silent by design: a label entry only — no model message, no UI.
