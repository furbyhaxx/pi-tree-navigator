# AGENTS.md — pi-tree-navigator

Pi package (`@furbyhaxx/pi-tree-navigator`, fork of `cad0p/pi-tree-navigator`): agent-callable
session-tree navigation. The `navigate_tree` tool and the `/anchor` command family anchor
milestones, fold work into branch summaries independently of main-agent turns, recover from
context overflow, keep a continuity ledger, and clone sessions retrospectively. These
instructions apply to the whole repository.

## Project goals

In priority order:

1. **Nothing is lost.** Folds keep the abandoned branch, retrospective operations never touch
   the source session, and ledger items with a user origin are never deleted or rewritten by
   agent or classifier ops. A fold that cannot preserve this refuses without writing.
2. **Automatic and independent.** Folding, pressure relief and recovery run on their own at
   safe boundaries, without user triggers and without sending another request into a session
   that is already near its window. Manual commands are an override, not the main path.
3. **Honest budgets.** Projection estimates, provider-measured input, cache reads and
   cumulative traffic stay distinct. Never invent a limit, a token count or a cost; unknown
   stays unknown.
4. **Cheap and cache-friendly.** Per-request projection (`context`, `context_with_system`)
   and renderers run on the hot path: no I/O, no repeated parsing, and no rewriting of stored
   entries that would break the prompt-cache prefix. Measure hot paths before and after a
   change; prefer Bun-native APIs, and move work to Bun AOT or Rust when TypeScript cannot
   meet the budget.
5. **Pi-native, consistent UI.** One `/anchor` command family with shared panel frames.
6. **Testable core.** Planners, cuts, config layering, ledger replay and rendering are plain
   functions over plain data; Pi and TUI wiring stays thin.

## Tech stack

- Bun `1.4.3` (`.bun-version`, `packageManager`); `bun test` for tests.
- TypeScript `7.0.2` with the strictness flags in `tsconfig.json`, erasable syntax only,
  explicit `.ts` import specifiers.
- Biome `2.5.15`: tabs, 100 columns, no `any`, no non-null assertions.
- Pi APIs (`@earendil-works/pi-coding-agent`, `-pi-tui`, `-pi-ai`, `-pi-agent-core`) and
  `typebox` as `peerDependencies: "*"`, pinned exactly in `devDependencies`. TypeBox for tool
  schemas. Development types target Pi 1.3; terminal acceptance uses Pi-Bolt 1.4.
- Runtime dependencies: none. A new runtime dependency needs user approval.
- `Justfile` is the command surface.

## Commands and completion criteria

`just check` (typecheck + lint + test) is the required gate. Single steps: `just typecheck`,
`just lint`, `just test`, `just format`. `just rpc-verify` loads the extension in a real Pi RPC
session (`PI_BIN`, default `pi-bolt`). `just probe` runs `scripts/pi-upstream-probe.mjs`
against the installed Pi.

- Run `just check` after code changes and fix every error and warning. Docs-only changes do
  not need it.
- Never claim a check passed unless it ran in this session and you read its output.
- `just rpc-verify` is required after changing tool or command registration, event wiring,
  renderer registration or settings persistence. `just probe` is required after touching any
  reflected Pi internal (`AgentSession.prototype.prompt`, `agent.state.messages`,
  `_extensionRunner`).
- Changes to folding, recovery, continuation or the summarizer need budgeted live acceptance
  (`scripts/fold-acceptance/`, see `docs/verification.md`). Live calls are authorized and
  expected for `openai`, `claude`, `xai` and `openrouter` (classifiers only). Capture request
  and response as evidence; a mock never proves a provider path.
- Changes to rendering, panels or key handling need a live terminal pass in Pi-Bolt (tmux
  capture or equivalent) at the widths in [TUI widths](#tui-widths). Keep captures under
  `.project/analyses/<slug>/captures/`.
- Implement, validate and QA fully before claiming completion or pushing. Do not defer or
  leave items open unless the user explicitly asks for it.

## Repository shape

```text
src/
  index.ts            Pi entrypoint: NavigatorState, controller construction, registration
  core/               state, lifecycle, config layers, runtime overrides, helpers, token
                      estimates, Pi internals, session writes, hints and start anchor
  fold/               fold engine, inputs, summarizer, prompts, handoffs, consolidation
  auto/               auto-fold planner, milestone classifier and policies, pressure compaction
  recovery/           request guard, turn boundary, overflow recovery, pressure compaction
  tool/               navigate_tree definition, schema and action dispatch
  continuity/         ledger, capture, store, briefing, open requests, retirement check
  retrospective/      proposals, plans, snapshots, cloning, descendant sessions
  ui/                 /anchor command, frame, screens, settings, tool and handoff renderers
tests/                bun:test suite mirroring src/, fixtures under tests/fixtures/
scripts/              acceptance, classifier eval, probe, restructure CLI; only the CLI ships
docs/                 end-user documentation
.pi/skills/           project UI/UX skills; load them before TUI or CLI work
.project/             development artifacts
README.md, CHANGELOG.md, LICENSE, AGENTS.md
```

- Split a module by responsibility, not by line count; ~400 lines is the point where a module
  is doing two jobs.
- A feature change stays inside its directory plus the shared `core/` seam it needs.
- Tests live in `tests/`, mirroring `src/`, never beside the source.
- The package ships raw TypeScript (`pi.extensions` → `./src/index.ts`). No build step unless
  a consumer requires it.

## Folding, recovery and the tree

`docs/architecture.md` holds the invariants; read it before touching `fold/`, `recovery/`,
`continuity/` or `retrospective/`, and update it in the same change when an invariant moves.

- `anchor:` labels are rewind targets, `branch:` labels archive work. Neither namespace
  silently overwrites an existing label.
- Folds serialize per session, run at safe boundaries (after the current tool batch), and
  never withhold or invent tool results.
- Relief is best-effort: run whenever it reduces context; targets only size the kept tail and
  pick the anchor. Non-reducing or over-budget folds fail and keep the original history.
- Only the active ancestry feeds model context. Projection changes per request; stored entries
  and payloads are never rewritten. New state goes in appended entries.
- Stored entry types (`branch_summary` details, ledger ops, handoff metadata, legacy in-band
  rewinds) are a format: change them only with a reader for the old form.
- Continuity capture and reconciliation fail open: a classifier, store or delta failure never
  blocks a turn or a fold.
- Model-assisted analysis is opt-in, applies configured disclosure filters before any request,
  and validates every generated ID, range and label locally.
- Every model call honors the caller's `AbortSignal` and a bounded timeout. The extension must
  never hang a turn.
- Reflected Pi internals are listed in the `README.md` requirements and covered by the probe.
  Add no new reflection without a probe check.

## The `navigate_tree` tool

- The tool description and parameter docs are model-facing contract text: precise, short, with
  the defaults and limits the model needs. Changing them changes agent behavior; treat it like
  an API change and note it in the changelog.
- Every action (`anchor`, `rewind`, `list`, `pin`) returns an explicit outcome; refusals say
  why and what to do instead.

## Tool rendering

- Tool rows and handoff/outcome cards render through `ui/tool-renderer.ts` and
  `ui/handoff-renderer.ts`, with one header grammar: glyph, target, metrics separated by ` · `.
- **Exact facts only.** Show metrics the operation reported; an absent field is omitted,
  never guessed or shown as `0`.
- **Failures stay visible** in every mode; refused and failed folds are never collapsed away.
- **Display state is monotonic.** A late update must not resurrect a spinner or warning that
  has settled.
- **No work in render.** No I/O, no parsing of large payloads per frame; compute once per
  result and width, then reuse.
- Truncation cues read `… N more <kind> · <expand hint>`; key names come from
  `keyHint("app.tools.expand", …)`, never hardcoded.

## Slash commands

- `/anchor` is the only command family (`tree`, `list`, `current`, `fold`, `clone`,
  `settings`, …). Every command with arguments provides `getArgumentCompletions`.
- Subcommands accept forgiving aliases (`ls`/`list`, `config`/`settings`) and singular/plural
  forms. Anchors are selectable by label or entry id; an ambiguous match opens a choice and
  never picks silently.
- Unknown input reports the usage line and the closest valid names.
- **Headless-safe.** Gate panels on `ctx.mode === "tui" && ctx.hasUI`. Without a TUI,
  read-only commands still work as text; interactive-only actions say they need the TUI and
  name the read-only alternative.
- Feedback goes through `ctx.ui.notify` with the right tone (`info`, `warning`, `error`).
  Multi-line results in the TUI render as a message, not a toast.

## Interactive panels

Panels use `ctx.ui.custom` and the shared frame in `ui/frame.ts`. Do not build a second
frame or list widget.

- **Keys come from the user's keybindings** (`KeybindingsManager`), never hardcoded. Hint rows
  show the bound keys.
- **Uniform semantics:** Enter confirms, Esc goes back one level (and closes at the root),
  Ctrl+C dismisses, Tab/Shift+Tab switches sections, arrows move, Space toggles, `/` or typing
  filters. Esc asks before discarding staged changes.
- **Lists are searchable** (`fuzzyFilter`) once they can exceed one screen.
- **Height:** size to content, cap at the terminal height minus Pi's footer, then scroll.
- **Narrow terminals:** side-by-side layouts fall back to a separate screen; anchor identity
  (label plus context %) survives every width.
- **Mouse is optional:** never the only way to reach an action.
- **Settings stage edits**, show each value's source scope, and save to an explicit scope.
  Project scope only when Pi reports the project as trusted. Saving preserves unknown keys; a
  malformed file blocks the save instead of being overwritten.
- **Session-bound:** a panel, fold or proposal belongs to the session that started it. After
  shutdown, late results must not change UI state or write entries.
- **New surfaces or layout changes are the user's call.** Show rendered frames (captures at
  the check widths, or an HTML mock for larger designs) before settling a new layout.

### TUI widths

- Use theme tokens and Pi's ANSI-aware helpers (`visibleWidth`, `truncateToWidth`,
  `wrapTextWithAnsi`). Never measure layout with `String.length`.
- Every rendered line fits the width. Check 36, 57, 80 and 140 columns when touching layout.
- Truncate in a fixed order: identity and primary state survive; secondary metrics, labels and
  breadcrumbs go first.
- Color is never the only signal: pair stress colors with a glyph, a number or a word.
- Strip control characters from session- or model-supplied text before rendering it.

## Settings and data

- Layers: defaults < user (`<agentDir>/tree-navigator.json`) < trusted project
  (`<cwd>/.pi/tree-navigator.json`) < runtime (session-scoped, cleared on start/reload). One
  catalog in `core/config.ts`; features never read config files directly.
- Resolve paths from `ctx.cwd` and the agent-dir helpers, not `process.cwd()`.
- No timers that outlive the session.

## Code conventions

- Explicit, readable code over clever code; descriptive names; early returns; no dead code; no
  boilerplate comments.
- Types describe reality: no `any`, no non-null assertions, no casts to silence the compiler.
- `node:` protocol imports; top-level imports only, no `await import()` or inline type imports.
- Validate unknown input once at the boundary that owns it (tool parameters, config files,
  session files, classifier and summarizer output), then stay typed inside.
- Errors carry context: what failed, which session or entry, and a recovery action. Catch only
  what you can act on.
- No compat shims or feature flags in a `0.x` package, except readers for stored session
  formats.
- Public modules get a lean module-level doc comment: what it owns, not how it works.
- Comments state constraints and non-obvious reasons, never restate the code.

## Testing

- `bun:test` only. Assert observable behavior: fold targets and cuts, projected context,
  ledger replay, config precedence, rendered lines at a given width, key handling.
- Every new planner, parser, renderer or key-handling branch needs a case that fails when it
  breaks.
- No network and no real credentials in the suite: fake the provider transport, theme and
  terminal. SDK-loop tests use local providers.
- Determinism: inject clocks, ids, token counts and terminal sizes.
- Fixtures captured from real runs stay unchanged and each has an assertion that uses it.
- A regression fix gets a test that reproduces it.
- Live provider, terminal and classifier evaluation are separate from the suite and never
  replace it.

## Git and delivery

- Conventional Commits, granular, English. Stage explicit paths; never `git add -A` or
  `git add .`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`,
  `git commit --no-verify`, or force-push. Never stage, revert or stash files you did not
  change.
- pi-tree-navigator is installed from `git:https://github.com/furbyhaxx/pi-tree-navigator`,
  so unpushed work never reaches a session. After `just check` and the relevant live
  verification pass, merge to `main`, push, then run `pi-bolt update --extensions`. That
  sequence is the authorized default; do not ask again for it.
- There is no CI; the local gates above are the only gates. Do not add CI workflows unless
  the user asks for them.
- Delete worktrees and their branches once merged and no longer needed.
- Version bumps, tags and publishing stay with the user.

## Documentation sync

| File | Covers |
|---|---|
| `README.md` | overview, install, configuration keys and defaults, requirements |
| `docs/architecture.md` | code overview and invariants |
| `docs/verification.md` | gates, live and terminal acceptance, delivery checklist |
| `docs/retrospective-cloning.md` | handoffs, cloning, proposal workflow, offline CLI |
| `CHANGELOG.md` | user-visible changes, including tool description changes |
| `AGENTS.md` | this file, when a convention changes |

Adding or removing a tool action, a parameter, a command or subcommand, a config key or a
stored entry type is a docs change in the same commit. Keep every Markdown file under 500
lines.

## Changelog

`CHANGELOG.md`, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

- New entries go under `## [Unreleased]` in the right subsection (`### Added`, `### Changed`,
  `### Fixed`, `### Removed`, `### Security`). Read the section first and append; never
  duplicate a subsection.
- One bullet per change: what changed, then why or what a user must do.
- Released version sections are immutable.

## Development artifacts

- `.project/{research,designs,plans,analyses}/<slug>/`, never `docs/`. Captures, live-run
  evidence and budget ledgers live in the analysis that produced them.
- Every artifact starts with YAML frontmatter: `version`, `id`, `title`, `description`,
  `type`, `created`, `updated`, `createdBy`, `updatedBy` (ISO 8601, Europe/Zurich).
- Reference artifacts by relative path.
- Never commit credentials or private sessions; acceptance runs use synthetic fixtures and
  reference auth through `--auth-dir`.

## Self-maintenance

pi-tree-navigator runs in every session of this user, including yours: `navigate_tree`,
automatic folds, overflow recovery and the continuity ledger. If a fold, rewind, recovery or
`/anchor` panel misbehaves live, the bug is probably here. Reproduce with
`pi-bolt -e ./src/index.ts`, confirm loading with `just rpc-verify`, inspect the session JSONL,
and fix it in the owning directory. Until the fix ships, disable the package in Pi settings or
run `pi-bolt --no-extensions`.

## What to avoid

- No new runtime dependencies, frameworks or browser/web UI without user approval.
- Only add model-facing tools or tool actions when the user requests them. If one would
  provide value, propose it first.
- Never weaken type safety, an invariant or a test to get a check green.
- No hardcoded machine-specific paths, agent dirs or credentials.
- Never print, log or commit secret values or private session content.
- No stubs, placeholders or TODOs presented as finished work.
- No drive-by refactors, reformatting or dependency upgrades inside an unrelated change; raise
  them instead.

## User override

If the user's instructions conflict with a rule here, name the rule and the conflict, get
confirmation, then follow the user.
