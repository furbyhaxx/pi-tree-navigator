---
version: 1
id: "extension-audit-settings-2026-10-29"
title: "Tree navigator configuration and settings audit"
description: "End-to-end review of config catalog, settings editor, layering, persistence, and runtime consumers."
type: "analysis"
created: "2026-10-29T18:07:47+01:00"
updated: "2026-10-29T18:20:57+01:00"
createdBy: "analyst"
updatedBy: "Pi coding assistant"
---

# Configuration and settings audit

status: "qa-complete"
confidence: "high" for the synthetic and PTY reproductions; the lifecycle gap below remains unverified.

## Summary

The 18 current JSON scalar definitions are all listed, alongside three map-entry rows. The nested policy editors also represent all currently parsed policy fields. That count does not mean the settings surface is correct: the existing start-anchor environment switch is absent; nested model fields cannot individually return to inheritance; per-model rows can contradict actual runtime values; and several invalid-config paths bypass disclosure restrictions. Atomic persistence can broaden a private file's permissions. Findings below distinguish existing knobs and defects from optional configuration proposals.

No project source, tests, config, Git state, real user config, real session data, credentials, or provider was modified or contacted. All interactive and programmatic inputs were synthetic. The full gate belongs to the coordinator.

## Findings

### 1. High / security — Atomic save changes a private config from 0600 to 0644

- **Location:** `src/ui/settings-screen-saving.ts:28-34`, `src/ui/settings-screen-saving.ts:103`.
- **Scenario:** A user edits an existing private `tree-navigator.json` under the common umask 022. A synthetic file contained a private unknown key and began mode `0600`.
- **Evidence:** The real atomic writer creates the replacement using default file permissions and renames it over the original. The disposable reproduction returned `{"before":"600","after":"644","outcome":"written","unknownPreserved":true}`. The temporary copy is also created with the broadened mode.
- **Recommendation:** Preserve the existing target's permissions when replacing it, and create a new target and its temporary file with a suitably private mode. Test a 0600 existing file with umask 022, including the symlink-target path and preservation of unknown keys.

### 2. High / security — A model-override key can pollute Object.prototype

- **Location:** `src/ui/settings-screen-raw.ts:79-92`, `src/ui/settings-screen-editing.ts:67-70`, `src/ui/settings-screen.ts:355`.
- **Scenario:** Add a model override named `__proto__`, which passes the model-pattern input check, and edit a nested auto-navigation setting. Validation also constructs a fresh probe for existing override entries.
- **Evidence:** `setAt` reads a missing child's inherited `node["__proto__"]`, then walks and modifies `Object.prototype`. In a separate disposable Bun process, `accepts(entrySettings("__proto__").find(...enabled), true)` returned true; `Object.hasOwn(Object.prototype, "auto_navigate")` changed from false to true; parsing `{}` then produced `autoNavigate: {kind:"ok", value:{enabled:true}}`.
- **Recommendation:** Traverse only own properties, and create safe own containers rather than adopting an inherited object. Audit other data-key path walkers and parser `in` checks. Add a regression exercising `__proto__` and proving both that prototypes stay untouched and an unrelated empty config remains disabled.

### 3. High / security — Invalid proposal config drops inherited auto-classifier disclosure rules

- **Location:** `src/core/config.ts:446-448`, `src/core/session-lifecycle.ts:99`, `src/auto/auto-navigate-config.ts:258-264`, `src/auto/auto-fold-planner.ts:186-200`.
- **Scenario:** Auto-navigation is enabled and `treeProposal.tools.read` is `omit`, but the same proposal block has an invalid `model`. The proposal parser rejects the entire block.
- **Evidence:** The loader retains only `proposalError`; runtime stores `config.proposal` as undefined. Auto-navigation consequently materializes `tools: {}`, whose unlisted-tool behavior is `full` (`src/retrospective/proposal-source.ts:194-195`). With a synthetic tool result, the invalid-model case had `enabled:true`, `tools:{}`, and `syntheticContentInEvidence:true`; changing only the model to `current` yielded `tools:{read:"omit"}` and `syntheticContentInEvidence:false`. No classifier request was made.
- **Recommendation:** Carry proposal/disclosure validity into every consumer, and block automatic model evidence until invalid inherited disclosure is repaired. Regression-test an invalid proposal model and a valid restrictive tool policy together, including the actual automatic evidence boundary.

### 4. High / security — A model override re-enables an invalid auto policy with full disclosure

- **Location:** `src/core/config.ts:282-313`, `src/core/config.ts:450-453`, `src/core/config-layers.ts:129-132`.
- **Scenario:** Base `auto_navigate.tools` has an invalid entry and a valid restriction for another tool; a matching model override explicitly sets `auto_navigate.enabled:true`.
- **Evidence:** With `{auto_navigate:{enabled:true,tools:{read:"omti",bash:"omit"}},model_overrides:{"fixture/exact":{auto_navigate:{enabled:true}}}}`, the warning says auto-navigation is disabled, but the base becomes only `{enabled:false}`. Resolving `fixture/exact` produces `enabled:true` and `tools:{}`; the valid `bash` restriction is lost and unlisted tools are disclosed fully.
- **Recommendation:** Preserve the invalid base-policy state through per-model resolution so no override can erase a fail-closed disclosure error. Regression-test a matching enabling override, retained restrictions, and the reported disabled state.

### 5. P2 / disclosure design gap — Broken file layers erase restrictions while warning only that the layer was ignored

- **Location:** `src/core/config-layers.ts:160-178`, `src/retrospective/proposal-command.ts:337-345`, `src/auto/auto-navigate-config.ts:258-264`.
- **Scenario:** A global config containing a `read:omit` proposal rule is truncated or unreadable; a valid trusted project enables automatic navigation, or the user requests an LLM proposal.
- **Evidence:** With synthetic truncated global text `{"treeProposal":{"tools":{"read":"omit"}},` and a valid project `{auto_navigate:{enabled:true}}`, the loader warned that the global layer was ignored, then resolved `enabled:true, tools:{}`. A file-level error contributes an absent layer rather than `proposalError`, so the proposal command's error guard does not see it either. The read restriction cannot be recovered from an invalid file; `full` is the fallback for unlisted tools.
- **Qualification:** Ignoring malformed whole-file layers is the documented current policy (`README.md:136–140`), so this is a demonstrated privacy tradeoff in that policy, not an implementation violation of the existing fallback specification. The user sees a layer warning; the widened disclosure consequence is not made explicit. No actual data was sent during the reproduction.
- **Recommendation:** Keep the documented ignore/fallback behavior for non-disclosure fields if desired, but mark disclosure provenance unknown and block model-assisted disclosure until every relevant layer is readable and valid. Test invalid JSON, non-object roots, and non-ENOENT read errors with another layer enabling a model consumer.

### 6. Major — Milestone model calls have no bounded deadline

- **Location:** `src/auto/milestone-policy.ts:389-444`, `src/auto/auto-fold-planner.ts:194-200`, `src/recovery/turn-boundary.ts:213-218`.
- **Scenario:** An available configured milestone model or registry lookup never resolves while the session signal remains active.
- **Evidence:** `evaluateMilestone` awaits model resolution and the classifier promises without a timeout; the turn boundary awaits the automatic fold before it can continue to consolidation. An abort-aware fake classifier was still pending after 60 ms and only settled as `abstain` when the synthetic parent signal was aborted. This demonstrates the missing deadline, not a measured provider latency. Continuity capture has a separate 15-second deadline (`src/continuity/continuity-runtime.ts:24`).
- **Recommendation:** Bound both model discovery and calls with a deadline combined with the parent cancellation signal; abstain and release the turn on expiry. Test a never-resolving fake lookup and an abort-aware never-resolving fake call, without network access.

### 7. Major — Existing start-anchor kill switch is missing and invisible in the editor

- **Location:** `src/core/hint-and-start-anchor.ts:41-44`, `src/ui/settings-screen-catalog.ts:88-95`, `docs/configuration.md:355`.
- **Scenario:** `PI_NAVIGATE_TREE_START_ANCHOR=0` is set. The settings panel still shows a normal `anchorStartAfterTurns` value and no indicator that the automatic start anchor is disabled; no catalog row can control the documented switch.
- **Evidence:** In a synthetic controller with the same eligible turn, the environment override produced zero label writes; removing it produced one. The 18 catalog definitions contain only the turn threshold.
- **Recommendation:** Provide a layered, editable start-anchor enabled setting if the product requires all behavior knobs in the editor, and visibly report any environment override and its precedence. Preserve the existing kill-switch semantics deliberately and test environment on/off, source display, save, and actual writes.

### 8. Major — Per-model rows ignore other matching wildcard overrides

- **Location:** `src/ui/settings-screen-maps.ts:125-137`, `src/ui/settings-screen-maps.ts:214-255`, `src/core/config.ts:282-313`.
- **Scenario:** A broad `fixture/*` override supplies a reserve, cadence, and `read:omit`; the user inspects the separate exact `fixture/exact` entry.
- **Evidence:** The synthetic exact-entry rows reported reserve `off`, cadence `6`, and tool `full`, while the runtime resolvers returned `80000`, `22`, and `omit`. The editor reads only the exact entry and root fallback, whereas runtime merges all matching patterns. Sources and inherited disclosure shown in the panel are therefore misleading; editing an inherited policy can also start from the wrong value.
- **Recommendation:** For concrete model entries, use the same full matching/precedence resolution and report the actual originating pattern. For non-concrete wildcards, state that overlap depends on the eventual model rather than claiming an effective value. Regression-test exact plus broad and specific wildcard patterns, including tool policies.

### 9. Major — Explicit per-model milestone `null` is displayed as the base policy

- **Location:** `src/ui/settings-screen-maps.ts:254-255`, `src/auto/auto-navigate-config.ts:275-277`.
- **Scenario:** A model entry sets `auto_navigate.milestone:null` to turn its milestone classifier off while the root policy is recommended.
- **Evidence:** `own?.[field] ?? base.read(config)` treats the valid null sentinel as missing. The row displayed `recommended` from the global scope while `resolveAutoNavigateConfig` returned `milestonePolicy:null` for that same exact model.
- **Recommendation:** Fall back only for `undefined`, retaining `null` as an explicit off value. Test both row text/source and effective runtime policy after saving and reloading the per-model off setting.

### 10. Major — Structured model-stage overrides cannot be reset to inherit

- **Location:** `src/ui/policy-settings-fields.ts:193-215`, `src/ui/settings-model-picker.ts:226-240`, `src/ui/settings-model-picker.ts:311-319`.
- **Scenario:** A custom intent or milestone policy uses the recommended preset, overrides one stage model, and has other custom changes that must remain. The user wants only that model to inherit the preset again.
- **Evidence:** The stage picker offers `off`, available/custom models, and possibly the current choice, but no inherit/default action. `editModel` always writes the chosen value; unlike prompt clearing at `policy-settings-fields.ts:229`, it never deletes the stage model path. A fake stage picker displayed off but no inherit, and choosing off changed the model to explicit `null`. Picking the preset's current model would pin a value rather than restore inheritance; switching the whole policy to recommended discards the other edits.
- **Recommendation:** Add per-stage reset/inherit that deletes only the model leaf, prunes empty containers, and keeps other draft fields. Test recommended and non-preset policies, confirmation and cancellation, and inheritance after preset changes.

### 11. Major — Switching target can silently discard a staged edit

- **Location:** `src/ui/settings-screen.ts:155-176`, `src/ui/settings-screen-rows.ts:141-146`, `src/ui/settings-screen-rows.ts:279-333`.
- **Scenario:** Global `anchorStartAfterTurns` is 2, trusted project is 5. Stage global 5, switch the target to project, then press Escape.
- **Evidence:** A real isolated Pi-Bolt PTY showed `1 staged · target: global`, then `target: project` with no staged badge or save shortcut. Escape returned directly to the editor without a discard prompt; global stayed 2. The staged map still has an entry, but `pending` is calculated only from changes against the currently selected target, where the same value is already present.
- **Recommendation:** Track pending edits independently of the currently previewed target, and prompt before discarding any staged edit. Make target changes and unchanged saves explicit about what happens to staged work. Regression-test target switches where the destination already has the staged value.

### 12. Major — Non-object parent blocks can be staged but cannot be repaired in the panel

- **Location:** `src/ui/settings-screen-editing.ts:221-229`, `src/ui/settings-screen-saving.ts:63-70`, `src/ui/settings-screen-maps.ts:272-284`.
- **Scenario:** A valid JSON file contains `{"continuity":"broken"}` or a non-object `consolidation`. The user edits one of its visible child rows.
- **Evidence:** A synthetic `continuity.capture=false` edit staged successfully, but saving returned `kept`, made zero writes, and warned `continuity is no longer an object. Nothing was saved; reopen settings before editing continuity.capture.` Reopening cannot help: there is no row to remove or replace that parent. The staging check only applies `blockedBy` to `structured` targets, while saving applies it to all targets. Strict unknown fields inside `auto_navigate` or `treeProposal` likewise have no root-level row to remove the offending field, leaving the group invalid.
- **Recommendation:** Detect malformed parent blocks before staging and provide an explicit, confirmed repair/removal operation that preserves unrelated data, or clearly direct users to a safe external repair. Do not imply reopening alone resolves it. Test wrong-shape and unknown-field blocks without overwriting unknown data.

### 13. Minor — `/anchor settings` silently does nothing in RPC mode

- **Location:** `src/ui/anchor-command.ts:507-513`; Pi's `ctx.ui.custom` is unsupported in RPC (`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:152`).
- **Scenario:** An RPC client with `hasUI=true` issues `/anchor settings`.
- **Evidence:** In isolated offline Pi-Bolt RPC, the command returned `{"command":"prompt","success":true,"data":{"disposition":"handled"}}` and no UI event or settings output. `/anchor settings show` returned an `extension_ui_request` notification with the settings. The code checks only `hasUI`, not `ctx.mode === "tui"`.
- **Recommendation:** Gate the interactive settings panel on both TUI mode and `hasUI`; in other modes return the read-only settings or a message naming `/anchor settings show`. Add an RPC command regression.

### 14. Minor — A classifier catalog error hides otherwise available chat models

- **Location:** `src/ui/settings-model-picker.ts:105-115`, `src/ui/settings-model-picker.ts:137-145`.
- **Scenario:** The policy-stage classifier catalog fails while the chat-model catalog would still succeed.
- **Evidence:** A synthetic registry throwing only from `getAvailableOfType("classifier")` produced `chatsRead:0`, `chatOffered:false`, `customOffered:true`. The first awaited call throws before `getAvailable()` is reached; the user must manually type an otherwise available chat selector.
- **Recommendation:** Collect classifier and chat lists independently, retain successful results, and report the failing source. Test one failed classifier catalog with a valid chat catalog and vice versa.

## Catalog / editor / consumer coverage matrix

Counts come from the actual exported definitions, rather than a documentation estimate. `src/ui/settings-screen-catalog.ts:85-285` exports **18 scalar definitions**, including two structured-policy values; `src/ui/settings-screen-maps.ts:277-284` renders those **18 rows plus three map rows = 21 top-level rows**. Each model-pattern entry renders **nine scalar rows plus one tool map = 10 rows**. Intent policy renders **11 field rows plus Apply = 12**; milestone policy renders **six field rows plus Apply = 7**. Map entries are dynamic, not a fixed number of settings.

| Config schema / controls | TUI representation | Runtime consumer / audit result |
|---|---|---|
| `rewindHintReserveTokens` | root scalar; per-model reserve row | `src/core/hint-and-start-anchor.ts:155-173`, fold/recovery resolvers; wildcard row issue #8 |
| `anchorStartAfterTurns` | root scalar | `src/core/hint-and-start-anchor.ts:54-61`; threshold wired, environment suppression missing (#7) |
| `parentHandoffMode` | root enum | `src/fold/fold-runtime.ts:135`, `src/fold/fold-adapters.ts:174`, `src/auto/automatic-fold.ts:120` |
| `continuity.capture` | root flag | `src/continuity/continuity-runtime.ts:66`, `src/tool/navigate-tree-tool.ts:199` |
| `continuity.intentClassifier` | policy row; mode/preset, gate, heuristics, and model+prompt for kind, supersession, escalation and verification | `src/continuity/continuity-runtime.ts:107-125`, `src/continuity/continuity-capture.ts:168-194,229-346`; stage inherit missing (#10) |
| `treeProposal.model` | model row and thinking picker | `src/retrospective/proposal-command.ts:268-275`, `src/retrospective/proposal-model.ts:7-29`; invalid-policy disclosure issue #3 |
| `treeProposal.tools[tool]` | dynamic root map | `src/retrospective/proposal-source.ts:186-218`, inherited by automatic milestone evidence; issues #3 and #5 |
| `auto_navigate.enabled`, `mode` | root and per-model flag/enum rows | `src/auto/automatic-fold.ts:101-115`, `src/auto/auto-fold-planner.ts:141-146`; invalid-base bypass #4 |
| `auto_navigate.milestone` | root and per-model policy rows; mode/preset, gate, classifier/confirmer models, status/boundary prompts | `src/auto/auto-fold-planner.ts:95-105,186-200`, `src/auto/milestone-policy.ts:389-444`; issues #6, #8, #9 and #10 |
| `auto_navigate.check_every_turns`, `min_tokens_since_anchor` | root and per-model count/token rows | `src/auto/auto-fold-planner.ts:173-180`; wildcard row issue #8 |
| `auto_navigate.rewind_at_tokens`, `pressure`, `keep_recent_share` | root and per-model rows | `src/auto/automatic-fold.ts:255-281`, `src/recovery/independent-recovery.ts:174-194`; wildcard row issue #8 |
| `auto_navigate.tools[tool]` | root map and per-model map | `src/auto/auto-fold-planner.ts:186-194`, `src/auto/auto-milestone.ts:95-150`; issues #4, #5 and #8 |
| `consolidation.enabled`, `max_handoffs`, `max_window_share`, `keep_newest` | four scalar rows | `src/fold/consolidation-runtime.ts:55-103,201`; malformed-parent repair #12 |
| `model_overrides[pattern]` | dynamic pattern map; 10 nested rows per entry | `src/core/config.ts:112-157,263-273,282-313`; pollution and row issues #2, #8, #9 |
| `PI_NAVIGATE_TREE_START_ANCHOR` | **no row or override status** | `src/core/hint-and-start-anchor.ts:44`; existing out-of-catalog knob, finding #7 |

The parser also accepts documented aliases and boolean `auto_navigate` shorthand; existing tests cover both. The removed `rewindHintAtPercent` and `controller_model` are ignored legacy keys, not current knobs. Policy stage model selection accepts a `provider/id`; unlike proposal models, its current schema does not define a separate thinking-level knob.

## Hard-coded policy thresholds: configuration opportunities, not unwired existing knobs

These have no `tree-navigator.json` key today. Decide deliberately which should become validated catalog/editor settings; some protect safety and should remain bounded or read-only rather than freely tunable.

1. **Minimum useful savings:** `MIN_REWIND_SAVINGS_TOKENS = 4000` in `src/index.ts:92` is injected into manual/tool folds, pressure compaction, and consolidation (`src/index.ts:116-154,190-228`). It determines visible refusals and whether compaction runs; it is the clearest candidate for one shared, constrained setting.
2. **Minimum fold focus:** `MIN_SUMMARY_FOCUS_LENGTH = 20` (`src/fold/fold-policy.ts:28`) controls validation and fallback focus. Expose only if the continuity guarantee and model-facing tool description remain coherent.
3. **Recovery headroom:** minimum output 1,024 and reserve 4,096 tokens (`src/fold/fold-policy.ts:30-32`, `src/recovery/request-guard.ts:97`) trigger visible request refusals. Consider read-only visibility first; any tunability needs admission/recovery consistency and safe lower bounds.
4. **Continuity timeout:** 15,000 ms (`src/continuity/continuity-runtime.ts:24,107-145`) decides when a configured classifier is disabled for the session. A bounded, validated timeout could accommodate providers with different latency.
5. **Fold budget/timeout:** 16 calls, 3,000 map-output tokens, 8,000 reduce-output tokens, 120,000 chunk-input tokens and 300,000 ms stream-idle timeout (`src/fold/fold-summarizer.ts:236-263`). Per-invocation `limits` exist in the summarizer but are not user config rows. Any settings need a single consistent preview/admission budget and a hard deadline.
6. **Recovery attempts / kept tail:** three recovery attempts (`src/recovery/independent-recovery.ts:37,112`) and a minimum kept-tail fraction of 0.25 of the configured amount (`src/recovery/pressure-compaction-runtime.ts:36,205`). Surface current values before considering guarded tuning, since both affect loss avoidance and progress.

## Verification and evidence

### Narrow existing tests

The following command was run with `HOME`, `PI_CODING_AGENT_DIR`, and all XDG homes set to a newly created disposable directory and `PI_OFFLINE=1`:

```sh
timeout 180 bun test \
  tests/core/config.test.ts tests/core/config-merge.test.ts \
  tests/core/runtime-config.test.ts tests/ui/settings-screen.test.ts \
  tests/ui/settings-model-picker.test.ts tests/ui/policy-settings.test.ts \
  tests/auto/auto-navigate-config.test.ts tests/auto/auto-milestone.test.ts \
  tests/retrospective/proposal-options.test.ts
```

Actual output: **289 pass, 0 fail, 9 files**. The suite uses temporary files or fake registries; passing it does not cover the findings above. No full gate was run by this audit.

### Disposable synthetic reproductions

- Separate Bun processes exercised prototype pollution, private-file permissions, invalid proposal disclosure, invalid auto disclosure plus exact override, malformed global disclosure plus trusted project, wildcard and null rows, staging, structured reset, malformed parent, classifier catalog failure, the environment override, and the milestone fake timeout. Relevant actual outputs are included in each numbered finding.
- Prototype example, runnable from the repository root in an isolated process:

  ```sh
  bun -e 'import {accepts} from "./src/ui/settings-screen-editing.ts"; import {entrySettings} from "./src/ui/settings-screen-maps.ts"; import {parseTreeNavigatorConfig} from "./src/core/config.ts"; const d=entrySettings("__proto__").find(x=>x.key.endsWith("auto_navigate.enabled")); console.log("before",Object.hasOwn(Object.prototype,"auto_navigate")); console.log("accepted",accepts(d,true)); console.log("after",Object.hasOwn(Object.prototype,"auto_navigate")); console.log("empty",parseTreeNavigatorConfig({}).layer.autoNavigate);'
  ```

  Actual result: `before false`, `accepted true`, `after true`, and an enabled auto-navigation field in the otherwise empty config. Run this only in a throwaway process.
- Private-mode reproduction used the real `save` writer on a 0600 file in a temporary directory with shell `umask 022`; actual `600 → 644` is in finding #1. The original file contained a synthetic unknown key only.
- In a real tmux PTY at 120×40, Pi-Bolt was started from a temporary work directory with a temporary agent directory, no extensions except this checkout, no skills/templates/themes, `--offline --approve --no-session`, and no configured models. `/anchor settings`, Down, Enter, `5`, Enter, Alt+T, Escape reproduced #11. The panel changed from `1 staged · target: global` to `target: project`, and exited without a discard prompt. No provider request occurred.
- In isolated offline Pi-Bolt RPC, `/anchor settings` produced only a handled response; `/anchor settings show` produced the settings notification and a handled response (#13). Project trust was disabled for that run.
- Read the current Pi settings-panel and configuration/trust references, the project Pi-extension UI skill, project `AGENTS.md`, and installed Pi extension/RPC implementation. The generic Pi settings reference permits replacing a malformed settings file, whereas this repository's `AGENTS.md` explicitly forbids overwriting malformed files; the audit uses the repository's stricter rule.

## Coordinator validation

The coordinator independently reproduced prototype pollution, both invalid-block disclosure fallbacks, the malformed-layer disclosure tradeoff, wildcard value mismatch, explicit-null mismatch, and the 0600-to-0644 save. Reusable fixtures and logs:

```sh
bash .project/analyses/extension-audit/evidence/repro-settings-security.sh
bun .project/analyses/extension-audit/evidence/repro-settings-values.ts
```

See `evidence/pi-tree-audit-settings-security.log` and `evidence/pi-tree-audit-settings-values.log`. The prototype mutation is confined to a disposable subprocess; this establishes a local settings-input defect, not a demonstrated remote-code-execution exploit. Effective file exposure also depends on parent-directory permissions. All 18 scalar definitions, 21 top-level rows and 10 per-model rows were counted directly again. Source checks confirmed the remaining picker, staging, repair and timeout paths. Finding 13 duplicates TUI finding 3 and is counted once in the integrated review.

## Explicit gaps and follow-ups

- **UNVERIFIED lifecycle race:** A synthetic `save` context whose agent `AbortSignal` was aborted during confirmation still returned `written` and called the writer and refresh callback. Pi documents this signal as the current *agent run* signal, not necessarily panel lifetime; this alone does not prove a cancelled settings command or shutdown writes in the real host. Test session replacement and shutdown while a real save is in flight, with isolated files. Installed Pi invalidates stale context getters after session replacement; do not assume the synthetic context models that guard.
- Only the 120-column PTY was used for the settings flow; full resize, mouse, 36/57/80/140-column acceptance, theme variants, and concurrent external file edits beyond existing unit cases were not exhaustively live-tested. No provider behavior, authentication, or real configured model availability was tested.
- Existing tests exercise ordinary trust gating, layers, resets, cancellation, malformed-file save refusal, model and thinking selection, atomic symlink writes, and unknown-key preservation. They do not cover the cross-feature cases identified above.
- The generic terminal-testing skill paths named by the analyst instructions were absent in this environment; the PTY was driven directly with an isolated tmux server. No terminal captures or temporary scripts are retained.
- The coordinator owns the full test, typecheck, lint, and probe gate. This report does not claim those checks were run here.
