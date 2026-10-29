---
version: 1
id: "extension-audit"
title: "Extension completeness, correctness and UX audit"
description: "Integrated, evidence-ranked review of pi-tree-navigator and its alignment with pi-workbench conventions."
type: "analysis"
created: "2026-10-29T18:26:32+01:00"
updated: "2026-10-29T18:26:32+01:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Verdict

The extension has substantial implementation and test coverage, but it does **not** yet satisfy its preservation, disclosure, settings-truthfulness or Workbench UX contracts. The main gaps are interactions between otherwise tested features, rather than missing command registrations or placeholder scalar rows.

Reviewed product revision: `cf4730634090f678e7f578e9fe5672ca0c8c230c`.
This was a read-only product review. Only review artifacts were added; no fixes, configuration changes, dependency changes or provider calls were made.

## Evidence and coverage

- `just check`: typecheck and lint passed; Biome checked 253 files; **1,604 tests passed, 0 failed, 100 files**.
- `just probe`: **34/34 checks passed**.
- `just rpc-verify`: successful local `/anchor` registration. Offline model-pattern warnings did not prevent loading.
- Additional focused checks: 289 settings tests, 191 TUI tests and 67 runtime tests passed. These overlap the full suite; they are not additional unique coverage counts.
- Independent synthetic reproductions established the preservation, authority, configuration, frame-composition and patch-ownership findings below.
- Live isolated Pi-Bolt fullscreen interaction covered **36/57/80/140 × 24**, **80 × 12**, rebound keys, nested navigation, fold selection, ledger actions, clone inspection and RPC/JSON behavior. Settings staging was separately exercised at 120 × 40.
- All inputs were synthetic. Provider semantics, summary quality and cache reuse were not measured. No private sessions or real settings were changed.

Detailed reports and evidence:

- [Runtime preservation and recovery](runtime.md)
- [Configuration and editor coverage](settings.md)
- [Live TUI and Workbench comparison](tui.md)
- [Integration and measured performance](integration.md)
- [Documentation and skills](documentation.md)
- [Reproduction scripts and logs](evidence/), [terminal captures](tui-captures/)

Priorities below are remediation order: **P1** preservation/security/ownership; **P2** functional correctness, interoperability and material UX; **P3** narrower defects or maintenance. A P1 does not imply remote exploitability. Reproductions use local components unless explicitly marked live TUI/RPC; scope qualifications remain part of each finding.

## P1 — preservation, disclosure and ownership

### A01. Folds restore context-edited-away content

`src/fold/fold-preview.ts:198–212`, `src/fold/fold-commit.ts:133–156`.
An edit after an anchor that omits/replaces an earlier retained message is abandoned by the fold. Real SessionManager reproduction changed the omitted message from absent to visible after a successful commit. Redactions and provider-envelope repairs can therefore be undone. Carry effective cross-boundary edits into both preview and commit. [Runtime §1](runtime.md)

### A02. Folds revert effective runtime checkpoints

`src/fold/fold-commit.ts:133–156,204`, `src/core/pi-internals.ts:125–139`.
Model, thinking and persisted system-section changes after the target disappear from active ancestry. Reproduction reverted the current model, `high` thinking and a new policy to the anchor's older state. Preserve the effective cut-time checkpoints and subsequent late changes, or refuse stale work. [Runtime §2](runtime.md)

### A03. Pressure recovery bypasses fold-lock ownership

`src/recovery/independent-recovery.ts:164–189,231,247–253`, `src/recovery/pressure-compaction-runtime.ts:231,311`.
Recovery invoked pressure compaction with `runningFolds` already occupied. A `busy` fold result also falls through to that path. Pressure compaction adds/deletes the same Set membership without owning it, enabling overlapping mutation and clearing another operation's lock. Use one ownership-aware lock and validate the pressure snapshot. Control-flow reproduction is confirmed; an actual concurrent provider schedule was not exercised. [Runtime §3](runtime.md)

### A04. Deduplication fails to protect a later user decision

`src/continuity/continuity-ledger-reducer.ts:197–204`, `src/continuity/continuity-ledger-model.ts:219–221`.
If an agent records text first and a user later states the same decision, deduplication retains agent provenance. A subsequent agent archive succeeded in the reproduction. Promote authority/provenance on genuine user duplicates without making ordinary duplicate capture churn revisions. [Runtime §5](runtime.md)

### A05. Chunked folding drops hidden model-visible messages

`src/fold/fold-inputs.ts:43–46`.
Strategy B and consolidation treat custom-message `display:false` as non-evidence, although the SDK sends those messages to the model. The real converter included the fixture while summary records were empty. Preserve canonical model-visible content; visibility is a presentation attribute. An existing test encodes the faulty exclusion assumption. [Runtime §6](runtime.md)

### A06. Retrospective clones lose active first-party continuity

`src/retrospective/retrospective-clone.ts:300–318`, `src/continuity/continuity-store.ts:110–143`.
A cloned fold archived the ops for a user rule without putting a continuity snapshot on the new summary; active replay went from one protected rule to none. Source data remains archived. Generic extension-state limitations are disclosed, but this package's own protected ledger is not preserved. Carry it forward or explicitly reject affected conversions. [Runtime §7](runtime.md)

### A07. A model-pattern key can pollute Object.prototype

`src/ui/settings-screen-raw.ts:79–92`, `src/ui/settings-screen-editing.ts:67–70`, `src/ui/settings-screen.ts:355`.
The accepted `__proto__` path adopts an inherited object. Editing/validating its nested setting mutated `Object.prototype.auto_navigate`; parsing an unrelated empty object then enabled automatic navigation. Use own-property traversal and safe containers. Reproduced only in disposable processes; no remote execution exploit is claimed. [Settings §2](settings.md)

### A08. Invalid configuration can widen classifier disclosure

Two independently reproduced paths:

- `src/core/config.ts:446–448`, `src/auto/auto-navigate-config.ts:258–264`: an invalid proposal model discards an otherwise valid inherited `read:omit` restriction; auto-classifier evidence then includes the synthetic read content.
- `src/core/config.ts:282–313,450–453`, `src/core/config-layers.ts:129–132`: an invalid base auto policy becomes `{enabled:false}`, but a matching enabling override revives it with `tools:{}`, losing valid restrictions while the warning says it is disabled.

Keep disclosure-invalid state through every resolver and fail closed at the model-evidence boundary. No content was actually transmitted during these tests. [Settings §§3–4](settings.md)

### A09. Saving broadens private config permissions

`src/ui/settings-screen-saving.ts:28–34,103`.
Atomic replacement changed an existing file from **0600 to 0644** under umask 022, including an unchanged private unknown key. Preserve existing permissions and create private temporary/new files. Effective exposure also depends on parent-directory permissions. [Settings §1](settings.md)

### A10. Untrusted terminal controls survive rendering

`src/ui/handoff-renderer.ts:89–107,135,248–254`, `src/ui/history-outline.ts:117–126,172,336–339`.
Synthetic OSC content remained intact in handoff rows, collapsed/expanded cards and native-history output. These paths bypass the ordinary frame sanitizer. Sanitize untrusted text at rendering boundaries while preserving stored/model content. Render-output injection is reproduced; no active escape was sent to a real terminal, so terminal side effects remain untested. [TUI §1](tui.md)

## P2 — correctness, integration and material UX

### A11. Preflight returns a request it already knows is oversized

`src/recovery/request-guard.ts:113–134`, `src/recovery/pressure-compaction-runtime.ts:262–298`.
After successful best-effort relief, the guard does not repeat complete-request admission. A controller reproduction returned **40,054 tokens for a 10,000-token window** without aborting. Re-account and perform bounded additional relief or refuse dispatch. This was not a provider test. [Runtime §4](runtime.md)

### A12. An explicit fold target can silently become another anchor

`src/fold/fold-adapters.ts:160–166`, `src/ui/fold-plan-screen-state.ts:107–119`.
Live `/anchor fold does-not-exist` selected a different anchor without an unknown-target warning. A known non-foldable selection likewise changed to a valid candidate in a state reproduction. Preserve explicit selections and their refusal reason; reject unknown/ambiguous targets. No wrong-target fold was executed against a provider. [TUI §2](tui.md)

### A13. Workbench system frames are hoisted and duplicated

`src/fold/fold-runtime.ts:48–68`, `src/fold/fold-pricing.ts:141–175`, `src/fold/fold-inputs.ts:205–218`.
With actual Workbench projection before Navigator, native mid-conversation system frames are captured as part of the head and also reconstructed as conversation content. The fixture marker appeared twice and moved ahead of earlier user input. Preserve position-bound system entries separately from the true leading prefix. This depends on extension ordering and native system-role support; analogous recovery reconstruction is a source-derived risk. [Integration I2](integration.md)

### A14. Overlapping session installations do not share patch ownership safely

`src/fold/handoff-projection.ts:167–178`, `src/index.ts:248–249`.
Install A, install B, dispose B: the original host method is restored while A remains live. A synthetic native estimate jumped from **2 to 100,010 tokens**. Reference-count or otherwise track patch ownership. The renderer helper has a similar source pattern, but was not independently reproduced. Ordinary sequential session replacement is not the reproduced case. [Integration I1](integration.md)

### A15. Milestone and proposal calls lack local deadlines

`src/auto/milestone-policy.ts:389–444`, `src/recovery/turn-boundary.ts:213–218`, `src/retrospective/proposal-model.ts:44–76`.
Milestone evaluation can hold the turn boundary until the parent aborts; proposal execution directly awaits provider settlement even after abort. Synthetic non-settling dependencies demonstrated both. Bound discovery and execution, combine cancellation signals, and stop waiting independently of transport cooperation. These experiments establish missing local bounds, not measured live-provider hangs. [Settings §6](settings.md), [Integration I4](integration.md)

### A16. Per-model settings misrepresent effective values

`src/ui/settings-screen-maps.ts:125–137,214–255`, `src/core/config.ts:282–313`.
The editor ignores other matching wildcard overrides. An exact-model row showed reserve `off`, cadence `6`, and disclosure `full`; runtime used `80000`, `22`, and `omit`. Separately, `??` makes explicit milestone `null` display as the base `recommended` policy although runtime disables it. Share runtime resolution/provenance and distinguish null from absence. [Settings §§8–9](settings.md)

### A17. Changing save target can hide and discard staged work

`src/ui/settings-screen.ts:155–176`, `src/ui/settings-screen-rows.ts:141–146,279–333`.
Live settings: stage global value 5 over global 2, switch to project already containing 5, then Escape. The staged badge disappears and the panel exits without confirmation; global remains 2. Pending state must represent all staged edits, independently of the currently previewed target. [Settings §11](settings.md)

### A18. Policy stage models cannot individually return to inheritance

`src/ui/policy-settings-fields.ts:193–215`, `src/ui/settings-model-picker.ts:226–240,311–319`.
Stage pickers offer off and explicit models, but no deletion/reset of one override. Off writes null, while resetting the whole policy loses unrelated edits. Add per-field inherit/reset with clear provenance. [Settings §10](settings.md)

### A19. The editor cannot repair malformed parent blocks it lets users edit

`src/ui/settings-screen-editing.ts:221–229`, `src/ui/settings-screen-saving.ts:63–70`.
A child edit under `continuity:"broken"` stages but cannot save; the warning recommends reopening, which cannot repair the parent. Strict unknown fields likewise leave some groups unrepairable through current rows. Detect before staging and offer explicit safe repair/removal or accurate external-repair guidance. [Settings §12](settings.md)

### A20. One existing behavioral switch is absent from the editor

`src/core/hint-and-start-anchor.ts:41–44`, `src/ui/settings-screen-catalog.ts:88–95`.
`PI_NAVIGATE_TREE_START_ANCHOR=0` suppresses start-anchor writes, but the panel shows only the ordinary threshold with no disabled/override status. Add a layered enabled setting if all behavior knobs must be interactive, and make environment precedence visible. [Settings §7](settings.md)

### A21. Headless commands lose results or assume unavailable custom UI

`src/ui/anchor-command.ts:464–519`, `src/retrospective/retrospective-command.ts:170–243`, `src/retrospective/proposal-command.ts:262–323,355–360`.
RPC has `hasUI:true` but no custom terminal panels. Live list/tree/current/hub/settings commands returned handled without their result; JSON/print list emitted no list. Clone review disappeared, and a confirmed fake LLM proposal crashed before any provider call. Gate on mode plus UI capability and provide observable text or explicit unsupported-operation guidance. Settings RPC is the same defect, counted here once. [TUI §3](tui.md), [Settings §13](settings.md)

### A22. Key hints contradict actual input bindings

`src/ui/frame.ts:263–275,346–379`, `src/ui/fold-plan-screen-panel.ts:310–355`, `src/ui/current-screen.ts:134–145`, `src/core/rewind-hint.ts:86`.
Rebound keys worked while the live footer advertised inactive arrows/Enter/Escape. Ledger prose teaches bare letters that actually enter search, and the no-anchor warning hardcodes native Shift+L. Derive hints and prose from the same binding/action definitions as input. [TUI §§4,8](tui.md), [Documentation D7](documentation.md)

### A23. Short terminals clip essential panel content

`src/ui/frame-rendering.ts:43,104–120`, `src/ui/fold-plan-screen-panel.ts:129–136,268–283,431–435`.
Live 80×12 clipped fold descriptions, actions, bottom rule and Pi footer. A valid candidate at 36×12 rendered 13 panel lines before host chrome. Budget the whole panel, including plan blocks, against available rows; retain cancellation and failure text. [TUI §5](tui.md)

### A24. Anchor enumeration scales quadratically

`src/core/anchors.ts:33–55`, `src/core/request-accounting.ts:139–148`, `src/core/projection.ts:200–212`.
Each anchor gets a separate full projection. Five-run warmed medians for **50/100/200/400 anchors: 5.12/16.02/52.69/207.35 ms**. The ordinary 4,000-message context projection took **2.34 ms**; it was not generally slow. Cache by the relevant projection revision or compute reusable prefix accounting. Preserve compaction/edit semantics and add a scaling benchmark. [Integration I3](integration.md)

### A25. Whole-file fallback has an unsafe disclosure tradeoff

`src/core/config-layers.ts:160–178`, `src/retrospective/proposal-command.ts:337–345`.
A malformed restrictive global file is ignored while a valid project can still enable automatic navigation with full default disclosure. The layer warning does not explain the widened disclosure. **Ignoring a malformed layer is the documented policy**, so this is a demonstrated design tradeoff rather than a parser-spec violation. Recommend blocking model disclosure when relevant policy provenance is unreadable/unknown. No data was transmitted. [Settings §5](settings.md)

## P3 — narrower defects and maintenance

- **A26 — Manual malformed-envelope validation gap.** `src/fold/fold-runtime.ts:71–137`, `src/fold/fold-preview.ts:105–122`: manual folding accepted a retained unresolved tool call that recovery correctly rejected. Reproduction starts from malformed imported/edited history; normal SDK generation of that state was not established. Apply the shared safety check before summary calls. [Runtime §8](runtime.md)
- **A27 — Catalog failure hides usable models.** `src/ui/settings-model-picker.ts:105–115,137–145`: classifier discovery throws before chat discovery runs. Keep independent successful catalogs and report the failed source. [Settings §14](settings.md)
- **A28 — Fullscreen paging is intercepted.** `src/ui/frame.ts:269–270`, `src/ui/history-outline.ts:358–405`: live PageDown did not move selection. Claim/release host page keys as Workbench does; add native-history paging. [TUI §6](tui.md)
- **A29 — Ctrl+C goes back instead of dismissing.** `src/ui/frame.ts:258–275,457–465`, `src/ui/anchor-command.ts:405–445`: live nested Tree returned to the hub. Propagate a distinct dismiss outcome. [TUI §7](tui.md)
- **A30 — Narrow hints hide primary actions.** `src/ui/frame.ts:346–381`, `src/ui/frame-rendering.ts:216–235`: at 36 columns list/tree/ledger show only filter/back/ellipsis; at 57 some selected-row actions disappear. Prioritize confirmation and primary action, abbreviate or expose accessible help. [TUI §9](tui.md)
- **A31 — Handoff facts are mislabeled.** `src/fold/handoff.ts:60–96`, `src/ui/handoff-renderer.ts:83–86,128`: no usage records renders measured-looking zero tokens/cost; digest is labeled “parent synthesis only” despite including a child index. Preserve unknownness and label all three modes distinctly. [TUI §10 and coordinator checks](tui.md)
- **A32 — Unsaved current-session inspection fails unhelpfully.** `src/retrospective/retrospective-command.ts:80–86,187–189`: a nonempty session-file path may not exist yet. Live default inspection emitted ENOENT; an explicit saved fixture worked. Inspect a safe in-memory snapshot or explain the saved-file alternative. [TUI §11](tui.md)
- **A33 — Unreleased migration history is incomplete.** `CHANGELOG.md:6–27`: missing the independent-engine/public-surface migration, including pin/continuity/automatic and anchor/clone surfaces. Add the migration bridge without rewriting historical releases. [Documentation D1](documentation.md)
- **A34 — Local TUI skill teaches obsolete conventions.** `.pi/skills/agentd-pi-extension-ui-ux/SKILL.md:8–16,32,63–74`: old package reference, 60-column minimum, literal expansion key, bare-letter actions and reset-to-default language conflict with current binding, Alt-action, narrow-width and inheritance rules. [Documentation D2](documentation.md)
- **A35 — CLI skill scope is ambiguous.** `.pi/skills/agentd-cli-ui-ux/SKILL.md:25–99` describes a larger agent CLI/wizard contract while the shipped `scripts/restructure-session.mjs:30–93` is an explicit standalone utility. Clarify applicability; this does not prove a missing binary or authorize a redesign. [Documentation D3](documentation.md)
- **A36 — Config and probe narratives are stale.** `src/core/config-fields.ts:13–52` omits runtime layering and denies supported model overrides; `scripts/pi-upstream-probe.mjs:5,24–33` describes retired in-band behavior and miscounts reflection points. Shorten and correct these explanations. [Documentation D4–D5](documentation.md)
- **A37 — Maintenance pointers need synchronization.** `AGENTS.md` Documentation sync omits configuration/how-it-works references; `README.md:3` uses the old repository identity; `README.md:30` leaves Alt+F mode cycling versus typed search ambiguous. The old URL was not externally checked and is not claimed broken. [Documentation D6](documentation.md)

## Configuration completeness answer

The current schema has **18 scalar definitions**, with **three map rows = 21 top-level rows**. Each model-pattern entry has **10 rows**. All parsed policy fields have controls; intent and milestone policies have dedicated nested editors. No additional missing JSON scalar control was found.

That inventory is not end-to-end correctness: A07–A09 and A16–A20 affect safety, effective values, inheritance, staging and visibility. The existing start-anchor environment switch is outside the editor. See the full schema → editor → runtime matrix in [settings.md](settings.md).

Hardcoded values such as minimum fold savings, operation deadlines, summary budgets and recovery limits are **configuration opportunities**, not existing unwired JSON knobs. Prefer shared validated settings with safe bounds; expose safety-derived values read-only where arbitrary tuning would violate admission or preservation invariants.

## Workbench design alignment and improvements

Compared against `../pi-workbench/AGENTS.md:159–249`, actual `src/core/menu.ts`/`commands.ts`, and `.project/designs/subagents-and-tasks/design.md:433–471`.

The extension uses the expected command family, editor-replacing shared frame, theme helpers, search and staged scope-aware settings. Adherence breaks in actual behavior: binding-derived hints, explicit target resolution, page ownership, Ctrl+C semantics, narrow hints, complete height budgets, sanitization, truthful facts and headless output (A10, A12, A21–A23, A28–A32).

Additional improvements, separate from functional defects:

1. **Bound total collapsed-card height.** `src/ui/handoff-renderer.ts:102–120` produced 10–11 lines on synthetic long content, exceeding the local four-summary-line-plus-hint contract. Budget the whole card rather than each field independently.
2. **Use available panel height.** `src/ui/frame-rendering.ts:104–118` caps normal panels at half the terminal; the six-row hub scrolls at 80×24. Fit content up to the actual available budget while preserving frozen geometry. Review captures before settling a changed layout.
3. **Make native history fuzzy-searchable.** `src/ui/history-outline.ts:230–239` uses substring matching, unlike the required long-list fuzzy behavior.
4. **Cache history reconstruction.** `src/ui/history-outline.ts:266–315,358–360` rebuilds manifests/outlines on render/input. This is a source-derived optimization opportunity; its latency was not measured.
5. **Use the shared frame for proposal progress.** `src/retrospective/proposal-command.ts:291–292` constructs a separate BorderedLoader. Provider-backed visuals were not exercised; inspect with a fake runner before redesigning.
6. **Consolidate duplicated semantics, not all similarly shaped code.** Runtime/editor config resolution already disagrees (A16); live/retrospective preservation differs (A02/A06); timeout and custom-UI gating conventions are repeated inconsistently (A15/A21). Share these contracts first. A blanket refactor is not justified by this audit.

## Recommended remediation order

- **Current slice:** preservation and disclosure regressions (A01–A10), with the lock/admission interaction A11 included in runtime safety work. Build failing regressions from the retained fixtures; keep fixes independently reviewable.
- **Next slice:** effective settings/inheritance/staging and command safety, then Workbench keyboard/height/headless alignment. Confirm changed visuals from captures or interactive previews.
- **Later:** measured anchor performance, secondary display/history improvements, and synchronization of documentation/skills. Update affected documentation alongside each fix rather than leaving all docs to the end.

This is a recommendation, not authorization to implement. No findings were fixed in this review.

## Explicit remaining verification gaps

- No live provider dispatch, cache measurement, summary-quality acceptance or authentication tests.
- No live mouse, light-theme or regular-mode acceptance. Fullscreen width/height checks do not establish those modes.
- No proven late-write-on-shutdown bug: synthetic aborted settings context and fold progress callbacks are **UNVERIFIED lifecycle risks**, because agent-run cancellation is not necessarily panel/session lifetime. Test actual host replacement before accepting them as findings.
- No actual terminal side effects from injected escapes, remote prototype-pollution exploit, crash-durability experiment, or real concurrent provider schedule was attempted.
- Historical classifier datasets and an exhaustive sentence-by-sentence review of old artifacts were outside the useful review surface. Current product contracts and relevant design invariants were checked.

Rejected false positives and qualifications are preserved in the detailed reports, including sequential-anchor overwrite, immutable historical changelog differences, broad ANSI prohibitions and alleged missing bundled skills/binary.
