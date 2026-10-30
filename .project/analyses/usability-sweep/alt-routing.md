---
version: 1
id: "alt-routing"
title: "Alt routing in Anchor panels"
description: "Isolated Pi-Bolt keyboard ingress investigation."
type: "analysis"
created: "2026-10-30T16:51:19+01:00"
updated: "2026-10-30T16:51:19+01:00"
createdBy: "analyst"
updatedBy: "analyst"
---

# Alt routing

status: "partially explained"
confidence: "high" for synthetic cases.

## Summary

Synthetic default-binding Alt+s works. Split ingress and binding collisions fail; the reported failure remains unobserved.

## Reproduction

Pi-Bolt 1.4.0, tmux 3.8, isolated 140x32: `-ne --offline --no-session -e ./src/index.ts` plus probe; `/anchor settings`, Enter twice (autocomplete), Down three times, Space. Both `tmux send-keys M-s` and `send-keys -H 1b 5b 31 31 35 3b 33 75` opened Save.

- `bash .project/analyses/usability-sweep/evidence/split-window.sh`: 10 ms opened Discard; 250 ms opened Save.
- `bash .project/analyses/usability-sweep/evidence/page-routing.sh`: masking delivered page keys.
- `bun test tests/ui/frame.test.ts`: 21 pass, 0 fail.

## Root cause

Synthetic `tui.select.cancel` including `alt+s` matches both actions; `src/ui/frame.ts:273-276` chooses cancel. When ESC and `s` are split by 120 ms, Pi's 10 ms timeout emits ESC first (`../pi-bolt/packages/tui/src/terminal.ts:134-150`). Actual terminal conditions are unknown.

## Evidence

Traces/captures: `.project/analyses/usability-sweep/evidence/`. Reruns require an empty `ROUTING_EVIDENCE_DIR`. A registered shortcut fires in the editor, not the focused panel. Fullscreen paging stops at the viewport.

## Recommended fix

Prioritize enabled Alt actions over cancel; retain Escape/Ctrl+C. Test both encodings with injected bindings. Split ingress requires Kitty or a longer `PI_TUI_ESC_TIMEOUT`. Claim/release paging bindings on focus, following `../pi-workbench/src/core/menu.ts:202-245`.

## Open questions / follow-ups

`BLOCKERS:` Physical bytes, timing, bindings and consuming listeners are unknown. No real settings/providers used; processes stopped. The read-only brief overrides AGENTS.md's “fix it in the owning directory.”
