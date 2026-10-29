---
version: 1
id: "extension-audit-documentation"
title: "Documentation and skill consistency review"
description: "Verified documentation drift and convention conflicts, with rejected false positives recorded."
type: "analysis"
created: "2026-10-29T18:13:15+01:00"
updated: "2026-10-29T18:13:15+01:00"
createdBy: "docs-audit"
updatedBy: "Pi coding assistant"
---

## Findings

### D1 — P2: Unreleased history omits the architectural and public-surface migration

`CHANGELOG.md:6–27` records toolchain, layout, keys, rendering and selected fixes, but does not explain the replacement of in-band rewinds by the independent engine or the addition of `pin`, the continuity ledger, automatic navigation and the `/anchor`/clone surfaces. The historical 0.3.0 section (`CHANGELOG.md:29–64`) still correctly describes its old in-band design; the three-action description belongs to the historical 0.1.0 section, not 0.3.0.

`README.md:101–108` and `src/tool/navigate-tree-tool.ts` describe the present four-action interface. Add the missing migration bridge under Unreleased; do not rewrite immutable release history. This is documentation completeness, not a runtime failure.

### D2 — P2: The local TUI skill contradicts the current interaction standard

`.pi/skills/agentd-pi-extension-ui-ux/SKILL.md:8–16,32,63–74` cites the old `pi-bolt-subagents` reference, assumes a 60-column lower bound, and teaches literal Ctrl+O and bare-letter row actions. The repository's current `AGENTS.md:161–190` requires bound key names, centralized Alt+mnemonics, and checks at 36/57/80/140 columns. Workbench's `AGENTS.md:219–249` agrees with those newer rules.

The skill also says reset means “default,” while the implemented/documented settings semantics remove a value from a selected layer and reveal inheritance. Following the skill can reintroduce wrong keys, narrow-layout omissions and wrong reset behavior. Update it to one current source of truth; distinguish illustrative glyphs from actual active bindings.

### D3 — P3: The CLI skill does not distinguish the standalone utility from the larger agent CLI

`.pi/skills/agentd-cli-ui-ux/SKILL.md:25–99` applies a universal help/wizard contract to standalone session CLIs, with examples of `agent tree`, aliases, `--wizard`, `--json`, short flags and an interactive rail wizard. `scripts/restructure-session.mjs:30–93` is a standalone `node scripts/restructure-session.mjs` utility with `inspect|propose|preview|create`, explicit paths/tokens and a different flag surface; `package.json` intentionally has no `bin`.

This is a spec/skill scope mismatch, not proof that an `agent` binary is missing. Clarify which requirements apply to the shipped offline utility and which are future/reference UX. Do not infer an unrequested CLI redesign solely from an example.

### D4 — P3: The config module's explanatory comment denies supported overrides

`src/core/config-fields.ts:13–52` describes only two layers and says a model override without `rewindHintReserveTokens` is ignored. `src/core/config.ts:134–141` parses model-specific automatic navigation, and runtime layering is part of the current loader. `docs/configuration.md:36–57` correctly documents those overrides.

Replace the stale narrative with a short description pointing to the actual catalog and current configuration reference. Keeping several long descriptions of the same merge semantics increases drift risk.

### D5 — P3: Probe documentation still describes the retired in-band engine

`scripts/pi-upstream-probe.mjs:5,24–33` says “two” reflection points while listing three, describes the old in-band turn-end summary contract, and says cache-prefix summary checks were deleted. The independent engine is documented in `docs/how-it-works.md` and `docs/architecture.md:31–48`; the probe itself still passes 34 checks.

Update the explanatory header to the current contracts. This finding does not invalidate the successful probe run.

### D6 — P3: Documentation maintenance pointers are incomplete

- `AGENTS.md`'s Documentation sync table omits `docs/configuration.md` and `docs/how-it-works.md`, even though README delegates the main config/fold reference to them. Add them so future changes update the right files.
- `README.md:3` points to the legacy `badlogic/pi-mono` repository rather than the current `earendil-works/pi` identity used by installed packages. The old URL was not externally checked for redirects; this is a canonical-link update, not a verified broken link.
- `README.md:30` says Alt+F “filters the outline” without explaining that it cycles all/anchors/users, while typing performs text search (`src/ui/tree-screen.ts:97–99,410–419`). Clarify the two meanings; the existing wording is ambiguous rather than strictly false.

### D7 — P3: The no-anchor hint hardcodes the native label key

`src/core/rewind-hint.ts:86` embeds `shift+l` in a **TUI-only** warning. The installed host's default remains `shift+l` (`node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js:79`), so it is not obsolete by default. It becomes misleading when rebound; derive the key from the active manager or direct the user to `/anchor` instead.

## Alignment and rejected claims

- The README's current four tool actions, `/anchor` family, principal aliases, default digest handoff mode and heuristics-only continuity capture match the source.
- Product Markdown files checked by the scout remain below the 500-line limit (README 206; configuration reference 363).
- The historical consolidation proposal describes an earlier `full` default. The product docs and implementation agree on `digest`; an old decision artifact is not itself a runtime defect.
- F2 is a working native-history raw-view escape (`src/ui/history-outline.ts:366`); do not globally replace it because other row actions use Alt.
- The CLI skill forbids raw **SGR 2**, not all ANSI escapes. `scripts/restructure-session.mjs:37` using a guarded ANSI paint helper is not evidence of violating that rule. The initial scout's broader ANSI claim was rejected.
- The two local `.pi/skills` files are development guidance, not advertised bundled package skills. Their exclusion from `package.json.files` is not a packaging omission.
- No current API link or command surface was declared broken solely because its historical changelog entry differs.

## Coverage and limitations

Compared README, changelog, architecture/verification/configuration/retrospective references, the two local UI skills, relevant design artifacts, source contracts and Workbench panel conventions. Settings and live TUI behavior are detailed separately in `settings.md` and `tui.md`. Historical classifier datasets were deliberately excluded. This is not a new external audit of current provider/model catalogs or an assertion that every sentence in every historical artifact is current.
