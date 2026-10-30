---
version: 1
id: "usability-sweep-verification"
title: "Session settings and panel usability sweep"
description: "Implemented controls, regression evidence and terminal acceptance."
type: "analysis"
created: "2026-10-30T17:35:15+01:00"
updated: "2026-10-30T17:35:15+01:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Outcome

- Settings open in Session scope. **Apply/save staged changes** and **Change scope**
  are searchable rows activated with arrows and Enter; Alt remains optional.
- Session settings apply in memory without writing a file. Persistent saves target
  Global or trusted Project explicitly. Pending edits and discard protection survive
  scope changes, even when the new target already contains the staged value.
- **Pause automatic folding** is immediate and independent of settings staging.
  It overrides per-model enablement, fences stale asynchronous work, and resets on
  reload/session switch/shutdown. Resume restores configured policy.
- Recovery, continuity capture, hints, automatic start anchors and manual/tool
  folds remain active while paused. The user explicitly selected this behavior.
- Enabled Alt actions take priority over conflicting selection aliases. Hints skip
  shadowed keys and preserve confirmation/cancel at 36 columns. Fullscreen paging,
  line movement and Home/End reach the panel; user bindings restore on exit.
- README, configuration guide, changelog, AGENTS and the project UI skill agree.

# Verification

- `just check`: typecheck and Biome passed; **1,623 tests passed, 0 failed**
  across 101 files. Exact output: [integrated-check.log](evidence/integrated-check.log).
- `just rpc-verify`: `get_commands` succeeded and registered `anchor`.
  [Output](evidence/rpc-verify.log) includes unrelated configured-model warnings.
- Real isolated Pi-Bolt: dark/light × regular/fullscreen, each resized through
  36/57/80/140 columns. Exercised pause/resume, session apply, pending scope changes,
  file save, filtering, PageUp/PageDown, and legacy plus CSI-u Alt+s.
- Final default and synthetic-conflict checks additionally verified Home/End and
  updated narrow hints. Session capture edits did not change config-file bytes;
  the separate persistent parent-mode edit did.
- [Captures](captures/) retain text and ANSI for visual inspection. Final default
  narrow state: [36 columns](captures/final-default-pause-36x30.txt).
- Reproduce the isolated workflow with
  `QA_PREFIX=local-check python3 .project/analyses/usability-sweep/evidence/settings-terminal.py`.
  Set `QA_THEME=light`, `QA_MODE=regular`, or `QA_KEYS=1` for the other variants.
  The harness cleans its disposable terminal and synthetic config automatically.
- Independent review found no settings/pause regression. Its one minor finding
  (a shadowed cancel alias advertised as usable) failed a new regression before
  the correction and passed afterwards.
- The first combined gate exposed an integration test still navigating from the old
  Global default. Its script now exercises the Session-default Enter-only path;
  all file-preservation, live-apply and reload assertions remain.

# Alt limitations and scope

[Alt routing diagnosis](alt-routing.md) reproduced split ESC ingress and synthetic
binding collisions. Default combined Alt+s worked. The actual user's selection
bindings have Escape/Ctrl+C cancellation and no Alt+s collision; physical terminal
bytes/timing were not captured. This patch removes the Alt dependency for essential
settings actions; it does not claim to repair an unknown client/SSH input path.

Live-provider acceptance was **explicitly waived by the user for this patch**.
No provider calls or spending occurred. Live-provider behavior remains unverified.
Token-accounting integration and other broad audit findings remain outside this sweep.

All testing used synthetic sessions and isolated configuration. Nine retained
disposable terminal servers were stopped; the final harness self-cleaned. Real
user settings, private sessions and the separately installed extension were unchanged.
Changes remain local; no push or package update was performed.
