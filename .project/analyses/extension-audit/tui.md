---
version: 1
id: "extension-audit-tui"
title: "Pi tree navigator TUI and renderer audit"
description: "Evidence-ranked audit of navigation, frames, commands, and transcript renderers against Workbench conventions."
type: "analysis"
created: "2026-10-29T18:06:11+01:00"
updated: "2026-10-29T18:08:32+01:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Pi tree navigator TUI and renderer audit

status: "qa-complete"
confidence: "high"

## Summary

The audit found two high-impact safety defects: untrusted handoff/history text reaches terminal render output with active control sequences, and a requested fold target can silently become another anchor. RPC and JSON/print command output also fails the headless contract. Keyboard hints, pagination, dismissal, short-terminal geometry, and retrospective views have independently reproducible defects. The visual and renderer improvements below are separated from functional defects.

This review made no source changes and made no provider requests. The local `AGENTS.md` Self-maintenance rule says to “fix it in the owning directory” when a panel misbehaves live; the explicit review-only brief overrides that rule. Settings wiring was excluded as requested. Workbench's user conventions are in `../pi-workbench/AGENTS.md:163-187,206-249`; its actual binding, pagination and panel implementation is `../pi-workbench/src/core/menu.ts:122-131,181-204,373-405`, and its command output handling is `../pi-workbench/src/core/commands.ts:348-351,395-410`. The relevant Workbench design is `../pi-workbench/.project/designs/subagents-and-tasks/design.md:433-471`; navigator-specific design is `.pi/skills/agentd-pi-extension-ui-ux/SKILL.md:14-70`.

## Test matrix and environment

- Pi-Bolt `1.4.0` (Pi-Bolt `1.0.7`, linux-x64), Bun `1.4.3`, tmux `3.8`, fullscreen TUI.
- A private `mktemp -d` contained an isolated `HOME`, `PI_CODING_AGENT_DIR`, XDG directories, session directory, synthetic session JSONL, and keybindings. Pi was started from the scratch working directory with `env -i`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `timeout 600 pi-bolt --offline -ne -nc -ns -np --no-mcp -na -e /mnt/Projects/furbyhaxx/pi-tree-navigator/src/index.ts`. No credentials or user settings were used. Pi reported `No models available`.
- Live: `/anchor` hub, populated list, tree, ledger, non-foldable fold plan, and synthetic clone inspection at 36/57/80/140 columns, 24 rows. Also exercised search/Escape, ledger entry creation, plain-vs-Alt action, custom keybindings, PageDown, Ctrl+C, unknown fold target, 80x12, and clone inspection of the unsaved current session. Captures are in `.project/analyses/extension-audit/tui-captures/`.
- RPC: isolated offline subprocess with `/anchor list`, `/anchor tree`, `/anchor current`, `/anchor`, `/anchor lsst`, `/anchor clone inspect <synthetic>`, and `/anchor clone propose <synthetic>`. The bad-command notification was a positive control. JSON print mode was checked with `/anchor list`. A fake registry simulated the accepted model-proposal RPC dialog; zero provider calls were made.
- Focused tests: `bun test tests/ui/anchor-command.test.ts tests/ui/clone-screen.test.ts tests/ui/clone-views.test.ts tests/ui/current-screen.test.ts tests/ui/fold-plan-screen-panel.test.ts tests/ui/fold-plan-screen-state.test.ts tests/ui/fold-plan-screen.test.ts tests/ui/fold-screen.test.ts tests/ui/frame-rendering.test.ts tests/ui/frame.test.ts tests/ui/handoff-renderer.test.ts tests/ui/history-outline.test.ts tests/ui/navigator-renderers.test.ts tests/ui/styled-lines.test.ts tests/ui/tool-renderer.test.ts tests/ui/tree-screen.test.ts` returned **191 pass, 0 fail, 16 files**.
- The tmux session was stopped and all scratch state removed. The full gate was not run; the coordinator owns it. No live provider, light-theme, regular-mode, accessibility-tool, or mouse interaction was attempted. Existing unit tests cover several mouse cases; they do not replace those live checks. The optional terminal-testing skill path was unavailable.

## Functional and safety findings

### 1. Major — terminal escape sequences survive in handoffs and native history

**Reproduction.** A synthetic title/goal/outcome containing `hello\x1b]0;AUDIT_TITLE\x07world` was passed to the real `makeHandoff`, `handoffRow`, and `handoffCard` components. `JSON.stringify` of their render output contained the entire `\u001b]0;AUDIT_TITLE\u0007` sequence in the native-tree row and collapsed and expanded cards (`raw-osc= true` for all three). A synthetic manifest and user message with the same sequence, rendered through the actual patched `TreeSelectorComponent`, likewise yielded `osc leaked= true` in both group title and user row. No active escape was sent to the real terminal during this experiment.

**Expected / actual.** Session/model text should be stripped of terminal controls before styling. The components return the complete OSC sequence as terminal output. If forwarded by the host, it can alter terminal state; actual terminal side effects were not tested.

**Cause.** `src/ui/handoff-renderer.ts:89-107,135,248-254` styles untrusted title, outcome, goal and stored Markdown directly. `src/ui/history-outline.ts:117-126,172,336-339` styles untrusted entry text and manifest titles directly. The ordinary shared frame's sanitizer is not used on these paths.

**Rule / fix.** Workbench `../pi-workbench/AGENTS.md:249` and local `AGENTS.md:190` require stripping controls. Sanitize untrusted fields and stored Markdown at the rendering boundary without changing stored/model data; test OSC, CSI, C1 controls and legitimate Markdown in both collapsed/expanded cards and native history.

### 2. Major — explicitly requested fold target can change silently

**Reproduction.** In the live synthetic session, `/anchor fold does-not-exist` opened the fold plan on `important-milestone-suffix-alpha` without an unknown-target warning; see `tui-captures/fold-unknown-140x24.txt`. The live candidates were non-foldable, so no fold was executed. A separate actual `openState` call with `old-invalid` selected and `new-valid` available printed `requested=old-invalid selected= new-valid recommended= undefined`.

**Expected / actual.** An unknown target should be rejected; a selected non-foldable target should remain selected with its refusal. Instead a missing name falls back to the ordinary recommendation, and a known but invalid candidate falls back to another valid candidate. A user pressing Enter can fold a different branch than the one requested; that final consequence follows from `FoldPlanPanel`'s Enter handler and was not exercised against a provider.

**Cause.** `src/fold/fold-adapters.ts:160-166` silently falls back when `preselect` is unknown; `src/ui/fold-plan-screen-state.ts:107-119` discards a non-foldable recommended index; `src/ui/anchor-command.ts:350-356,499-505` forwards the selected/requested name.

**Rule / fix.** Workbench `../pi-workbench/AGENTS.md:202-205` and local `AGENTS.md:147-149` require explicit name/ID resolution and no silent selection. Reject unknown or ambiguous input and retain a known invalid selection so its reason is visible. Add regressions for unknown names, entry IDs, ambiguous matches and Alt+R on an invalid anchor next to a valid one.

### 3. Major — RPC and JSON/print do not provide the required command results

**Reproduction.** An isolated Pi-Bolt RPC session received `{"type":"prompt","id":"list","message":"/anchor list"}` and similarly `/anchor tree`, `/anchor current`, and `/anchor`. Each returned only `{"type":"response","command":"prompt","success":true,"data":{"disposition":"handled"}}`; no result or extension UI request followed. `/anchor lsst` in the same process emitted a working `extension_ui_request` notification with the usage text, proving the channel was working. `pi-bolt --mode json -p ... '/anchor list'` emitted only the `session` JSON line and exited 0.

For `/anchor clone inspect /tmp/.../synthetic.jsonl`, RPC emitted only `Inspected "Synthetic audit session": 3 entries and 2 user turns.`; the full custom inspection was never shown. `/anchor clone propose` on that file emitted `Tree proposal cancelled; no plan was saved.` because review returned undefined. A fake RPC context with confirmed `--llm` and `custom() => undefined` produced `undefined is not an object (evaluating 'result.kind')`, with `provider calls: 0`.

**Expected / actual.** Read-only commands should return their text without a TUI; unsupported interactive actions should say why and name an alternative. Pi-Bolt RPC has `ctx.hasUI === true`, but `custom()` returns `undefined`; print and JSON mode make `notify` a no-op. These branches therefore silently return, lose the review, or error.

**Cause.** `src/ui/anchor-command.ts:464-519`, `src/retrospective/retrospective-command.ts:170-243`, and `src/retrospective/proposal-command.ts:262-264,282-323,355-360` gate on `hasUI` alone and assume custom results. Pi-Bolt documents the actual RPC contract at `/home/furbyhaxx/.pi-bolt/pi-bolt-linux-x64/docs/rpc-extension-ui.md:16-25`.

**Rule / fix.** Workbench `../pi-workbench/AGENTS.md:206-210` and its `src/core/commands.ts:348-351,395-410` explicitly distinguish TUI mode and record headless results. Gate all custom frames on `ctx.mode === "tui" && ctx.hasUI`; use an observable text/entry output in each mode, and reject or provide a safe explicit alternative for review-dependent operations. Add real RPC and JSON/print tests, plus a no-provider fake test after model confirmation.

### 4. Major — rebound navigation hints advertise inactive keys

**Reproduction.** In the isolated agent dir, set `keybindings.json` to `{"tui.select.up":"ctrl+k","tui.select.down":"ctrl+j","tui.select.confirm":"ctrl+l","tui.select.cancel":"ctrl+q"}`, run `/reload`, and open `/anchor`. The footer still said `↑↓ navigate  enter open  type filter  esc close`. Down and Enter did nothing; Ctrl+J moved selection. See `tui-captures/hub-rebound-80x24.txt`, `hub-rebound-advertised-keys-80x24.txt`, and `hub-rebound-ctrl-j-80x24.txt`.

**Cause / fix.** Input matches the injected manager in `src/ui/frame.ts:263-275`, but `keybindings()` hardcodes the hints at `src/ui/frame.ts:346-379`; the fold panel repeats this in `src/ui/fold-plan-screen-panel.ts:310-355`. Workbench `../pi-workbench/AGENTS.md:219-220` and `src/core/menu.ts:122-131` resolve the user's active bindings. Do the same for every hint and any prose naming confirm/cancel; test remapped and disabled bindings.

### 5. Major — fold plan exceeds available height on short terminals

**Reproduction.** In the fold plan resize the live terminal from 140x24 to 80x12. `tui-captures/fold-80x12.txt` shows the fold panel bottom, description, hint and bottom rule missing; the Pi footer is also cropped. A direct component experiment with a valid synthetic candidate and 36x12 reported `panel-lines=13` before the host footer.

**Cause / fix.** `src/ui/frame-rendering.ts:43,104-120` forces at least 10 frame rows, and `src/ui/fold-plan-screen-panel.ts:129-136,268-283,431-435` adds the plan block after measuring the frame rather than reserving that space. Workbench `../pi-workbench/AGENTS.md:225-227` requires capping to the terminal less footer/reserve. Budget the complete panel including its block against actual available rows; progressively compact or scroll while retaining cancel and failure text. Test at 12, 16, 24 and 40 rows, narrow and wide, with valid and invalid candidates.

### 6. Minor — PageDown is intercepted by the fullscreen host

**Reproduction.** On the hub at 80x24, Home selected the first row; PageDown left selection on that same row despite two hidden rows. See `tui-captures/hub-before-page-80x24.txt` and `hub-after-page-80x24.txt`. In an actual synthetic native-history selector with 16 user entries, PageDown likewise left `Semantic phase (open)` selected.

**Cause / fix.** `src/ui/frame.ts:269-270` implements paging but does not claim host page bindings. Workbench `src/core/menu.ts:181-204,394` temporarily claims/reinstates `tui.altScreen.pageUp/pageDown` while the panel is focused. `src/ui/history-outline.ts:358-405` has no page handling. Workbench `../pi-workbench/AGENTS.md:225-227` requires page navigation. Claim/release keys safely and implement page handling for the native history; test actual fullscreen routing, including focus loss and custom mappings.

### 7. Minor — Ctrl+C goes back one screen instead of dismissing the panel

**Reproduction.** Open `/anchor`, enter Tree, press Ctrl+C. The hub remains open rather than returning to Pi's editor; see `tui-captures/tree-before-ctrl-c-140x24.txt` and `tree-after-ctrl-c-140x24.txt`.

**Cause / fix.** `src/ui/frame.ts:258-260,274-275,457-465` sends Ctrl+C and Escape through the same `onCancel` result; `src/ui/anchor-command.ts:405-445` interprets that as a child-screen back. Workbench `../pi-workbench/AGENTS.md:221-223` and local `AGENTS.md:165-168` distinguish dismiss from back. Propagate a distinct dismiss outcome through nested screens; test both keys in nested and root screens.

### 8. Minor — ledger descriptions teach the wrong row-action keys

**Reproduction.** After adding a rule, the live Current screen description said `x retracts it, e edits the text, p unpins it`, while the footer correctly said `alt+x`, `alt+e`, `alt+p`. Pressing `x` placed it into the search input rather than asking to retract; see `tui-captures/current-140x24.txt` and `current-plain-x-140x24.txt`. The history description also says `h hides history`.

**Cause / fix.** The prose is hardcoded at `src/ui/current-screen.ts:134-145`, while row shortcuts pass through `frameShortcutKey` at `src/ui/frame.ts:82-111,289-296`. Workbench `../pi-workbench/AGENTS.md:219-223` and local `AGENTS.md:161-164` require accurate key labels in hints and prose. Resolve every action in descriptions through the shared mnemonic helper and cover active, completed, historical and protected item states.

### 9. Minor — core navigation and actions disappear from narrow hints

**Reproduction.** At 36x24 the populated list, tree and ledger footers show only `type filter  esc back  …`, hiding arrows, Enter, and all row actions; see `tui-captures/list-36x24.txt`, `tree-36x24.txt`, and `current-36x24.txt`. At 57 columns the list hides `alt+r fold` while retaining other hints (`list-57x24.txt`). In the ledger the only remaining prose uses the wrong plain-letter action, compounding finding 8.

**Cause / fix.** `src/ui/frame.ts:346-381` treats filter and Escape as essential while Enter/movement are lower priority; `src/ui/frame-rendering.ts:216-235` stops after the first hint that does not fit. Workbench `../pi-workbench/AGENTS.md:219-223` and the extending-Pi design system's hint rules require showing currently usable bindings. Prioritize confirmation and selected-row action, abbreviate labels, or provide an accessible help surface at narrow widths. Add 36/57-column observable hint tests.

### 10. Minor — absent handoff accounting is rendered as measured zero

**Reproduction.** `makeHandoff` over one synthetic user-only message produced `{"messages":1,"toolCalls":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0,"usageRecords":0}`. `handoffUsage` printed `1 messages · 0 tool calls · tokens in 0 / out 0 / cache read 0 / write 0 · recorded inclusive $0.0000`.

**Expected / actual.** No usage record means token usage and cost are unknown, yet zeroes are displayed as measured values. Message/tool counts remain known.

**Cause / fix.** `src/fold/handoff.ts:60-96` totals missing records as zero, and `src/ui/handoff-renderer.ts:83-86` ignores `usageRecords`. Workbench `../pi-workbench/AGENTS.md:163-164` and local `AGENTS.md:132-133` say omit absent facts. Omit accounting when there is no record and distinguish partially recorded totals if source entries have incomplete usage; test zero records and partial records.

### 11. Minor — default clone inspection fails for a new unpersisted session

**Reproduction.** In the isolated no-model session, set two anchors and add a ledger rule, then run `/anchor clone inspect` without a path. The live output is an `ENOENT ... lstat '<scratch>/sessions/<id>.jsonl'` warning; see `tui-captures/clone-current-not-persisted-140x24.txt`. Explicitly inspecting a synthetic session file works (`clone-inspect-80x24.txt`).

**Cause / fix.** `src/retrospective/retrospective-command.ts:80-86,187-189` assumes the nonempty `getSessionFile()` path already exists. The current in-memory session had entries but Pi had not created the session file. Workbench `../pi-workbench/AGENTS.md:206-210` calls for actionable feedback, and this command's own menu promises the current session when no path is given (`src/ui/anchor-command.ts:128-132`). Inspect a safe snapshot of current in-memory data or explicitly explain that it is not yet on disk and give the saved-session-path alternative; do not force a model call merely to create the file.

## Visual and source-level improvements

These are convention gaps, not claims of a live failure beyond the measurements stated.

1. **Collapsed handoff is taller than the card contract.** Synthetic long goal and outcome produced 11 lines at 36 columns and 10 at 57/80; the collapsed card independently allows three lines for each field and wraps its accounting (`src/ui/handoff-renderer.ts:102-120`). `.pi/skills/agentd-pi-extension-ui-ux/SKILL.md:70` specifies at most four summary lines plus one expand hint; Workbench `../pi-workbench/AGENTS.md:159-167` likewise emphasizes bounded normal previews. Clamp the total card, preserving title, primary outcome and the bound expand hint.
2. **The shared frame is needlessly cramped in normal-height terminals.** `src/ui/frame-rendering.ts:104-118` caps the frame to half the terminal even when space remains. At 80x24 the six-item hub shows four rows and a scroll indicator (`hub-80x24.txt`); Workbench `../pi-workbench/AGENTS.md:225-227` sizes to content up to the terminal minus footer/reserve. Consider using the available-height budget while preserving frozen geometry. Layout changes require user review of captures.
3. **Native history search is substring-only rather than fuzzy.** `src/ui/history-outline.ts:230-239` uses `includes`; an actual `buildHistoryOutline` call searching `sma` did not match `Semantic phase`. Workbench `../pi-workbench/AGENTS.md:224` requires `fuzzyFilter` for long lists. Adopt the shared fuzzy behavior without losing ancestor reveal.
4. **History reconstruction occurs on every native selector render/input.** `src/ui/history-outline.ts:266-305,313-315,358-360` revalidates the manifest and rebuilds the outline rather than caching against session/manifest/query/expansion changes. Workbench `../pi-workbench/AGENTS.md:186-187` requires avoiding repeated render work. Actual latency was not measured, so this is a source-level performance risk, not a measured regression.
5. **The model-proposal loading surface bypasses the shared frame.** `src/retrospective/proposal-command.ts:291-292` constructs `BorderedLoader` in `ctx.ui.custom`; local `AGENTS.md:157-159` and Workbench `../pi-workbench/AGENTS.md:215-217` require the shared frame for panels. This path was not exercised live because provider calls were explicitly out of scope. Inspect its visuals with a fake runner before deciding a layout; the RPC failure itself is confirmed in finding 3.

## Coordinator checks

- Independently reran `handoffRow` with synthetic OSC text and zero usage records: control sequence remained in the returned row; accounting printed measured-looking zeroes. See `evidence/repro-handoff.ts` and `evidence/pi-tree-audit-handoff.log`. No active escape was written to a terminal.
- Independently inspected the supplied target-selection, rebound-key and height captures and their source control flow. The unknown target fallback and bound-input/hardcoded-hint mismatch are confirmed.
- Additional P3 display defect: `src/ui/handoff-renderer.ts:128` renders every non-`full` mode as `parent synthesis only`, including `digest`. Digest actually includes a child index (`README.md:76–80`). Render the three distinct modes accurately.

## Open questions and follow-ups

- Run real mouse, dark/light and fullscreen/regular-mode acceptance after fixes. The existing tests do not exercise a live provider handoff, and no claim is made about a real terminal accepting the synthetic OSC.
- Check session shutdown/late fold progress carefully: `src/ui/fold-plan-screen-panel.ts:237-264` calls `tui.requestRender()` from progress and completion without an explicit closed/session guard. This is an unverified source-level lifecycle risk; reproduce before treating it as a defect.
- Root-level anchor enumeration complexity and Workbench frame-composition duplication were intentionally left to the coordinator, as requested.
- `BLOCKERS: none` for this audit. The unavailable optional terminal-testing skill did not block tmux-based tests.
