---
version: 1
id: "index-split-factory-map"
title: "src/index.ts split: symbol, state and seam map"
description: "Read-only factory map of src/index.ts (5546 lines) for splitting it into src/core, src/fold, src/auto, src/recovery, src/continuity, src/retrospective, src/ui and src/tool: top-level clusters with ranges/deps, the default-export factory closure state and handlers, __testHooks surface, and every importer of src/index.ts."
type: "analysis"
created: 2026-10-26T15:46:12+01:00
updated: 2026-10-26T15:46:12+01:00
createdBy: "explorer"
updatedBy: "explorer"
---

# src/index.ts split: symbol, state and seam map

## Correction to the brief

The file is **5546 lines**, not 6052. Section boundaries:

| Range | Content |
|---|---|
| 1-247 | file JSDoc, imports |
| 248-2385 | top-level section (90 declarations), ends at `toolError` |
| 2386 | `const foldApis = new WeakMap<ExtensionAPI, FoldApi>();` |
| 2388-5488 | `export default function (pi: ExtensionAPI)` |
| 5490-5502 | `__testHooks` doc comment |
| 5503-5546 | `export const __testHooks` |

Working tree: `src/index.ts`, `tests/index.test.ts`, `README.md`, `docs/verification.md` are already modified (not by this run). 35 `export` statements. Ranges below run declaration start to last code line; a doc comment between two symbols belongs to the later one.

## 1. Top-level section (248-2385)

`*` marks exported (i.e. part of the current cross-module contract).

### A. Policy constants and limits — 248-349 (23 symbols)

`ANCHOR_MANDATE`* 248, `START_ANCHOR_LABEL`* 254, `MAX_SESSION_REFS`* 273, `MAX_HINT_WALK_DEPTH`* 276, `MIN_SUMMARY_FOCUS_LENGTH`* 284, `MIN_REWIND_SAVINGS_TOKENS`* 297, `CONSOLIDATION_SUMMARY_TOKENS` 299, `MIN_KEPT_SHARE_OF_CONFIGURED` 302, `CONSOLIDATION_CUSTOM_TYPE`* 304, `PRESSURE_COMPACTION_CUSTOM_TYPE`* 306, `RECOVERY_MIN_OUTPUT_TOKENS` 307, `RECOVERY_HEADROOM_TOKENS` 308, `MAX_RECOVERY_ATTEMPTS` 310, `LIST_HINT_MAX_LENGTH` 313, `LIST_BRIEFING_MAX_TOKENS` 316, `PIN_KINDS` 319, `PinKind` 320, `isPinKind` 321, `PIN_HASH_MAX_BYTES` 324, `ANCHOR_HINT_MAX_LENGTH` 329, `ORIG_PROMPT_KEY` 330, `REFLECTION_BOOTSTRAP_WARNING_LIST` 335, `REFLECTION_BOOTSTRAP_WARNING_REWIND` 337.

Depends on nothing (literals). No mutable state. Only `ORIG_PROMPT_KEY` and the two reflection warnings belong with cluster B rather than `core/`.

### B. Pi reflection, session capture, event emission — 330-469, 540-613

`PiInternals` 350-374, `asInternals` 375-382, `sessionInstances` 383, `seenSessions` (let) 384, `captureSession` 386-398, `patchAgentSessionPrototype` 399-419, `findOwningSession` 420-469, `refreshAgentMessages` 540-558, `emitSessionTree` 559-591, `emitSessionCompact` 592-613.

Depends on A (`MAX_SESSION_REFS`, `ORIG_PROMPT_KEY`). **Module-level mutable state: `sessionInstances` (WeakRef array), `seenSessions` (reassigned only from `__testHooks`); `patchAgentSessionPrototype` mutates the global `AgentSession.prototype.prompt` at import time.** Read by C (`effectiveRequestMessages`), J (`commitFold`), the factory (`piCompaction`, both overflow paths, tool `reflectionOk`), `__testHooks`.

### C. Wire projection — 470-539, 977-994, 1072-1077

`buildContextMessages`* 470-539, `effectiveRequestMessages` 977-994, `admissionMessages` 1072-1077.

C depends on B only. Read by D, G, L (`preparedInContext`), the `context` / `context_with_system` handlers, `maybeRunAutomaticFold`.

### D. Compaction carry-over and per-entry projection — 614-720

`findLabeledEntry` 614-627, `carriedCompaction` 628-643, `systemCheckpoint` 644-651, `compactionCopy` 652-666, `carriedDetails` 667-680, `projectAtEntry` 681-695, `estimateAtEntry` 696-710, `precedesLatestCompaction` 711-720.

Internal edges: `compactionCopy`→`carriedDetails`; `projectAtEntry`→`compactionCopy`; `estimateAtEntry`→`carriedCompaction`, `projectAtEntry`, `requestAccounting` (G); `precedesLatestCompaction`→`carriedCompaction`. Read by E, J, L, the factory (`prepareFold`, `maybeRunAutomaticFold`, `compactUnderPressure`), and the tool (`anchor`, `rewind` token math). No state.

### E. Anchors, listing, pin helpers — 721-913

`collectActiveAnchors` 721-745, `activeAnchorNames` 746-756, `isFilled` 757-760, `hashPinnedFile` 761-771, `AnchorTarget` 772-775, `resolveAnchorTarget` 776-789, `suggestFoldLabel` 790-808, `formatActiveAnchors` 809-842, `buildMinSavingsRejection` 843-873, `findLabelHint` 874-913.

Depends on A (`LIST_HINT_MAX_LENGTH`, `MAX_HINT_WALK_DEPTH`, `PIN_HASH_MAX_BYTES`), D (`estimateAtEntry`, `precedesLatestCompaction`, `findLabeledEntry`), and `core/helpers`, `core/config`. Read by the anchor command, all four tool actions, J, L, the factory. No state; all read-only over `SessionManager`.

### F. Drafts, receipts and styled text — 914-947, 1078-1100, 1144-1197, 1434-1462

`keepValidDrafts` 914-928, `RewindMessageDraft` 929-936, `rewindMessageDraft` 937-947, `hideDrafts` 1078-1086, `REWIND_CUSTOM_TYPE`* 1087-1089, `buildRewindAcceptedText`* 1090-1100, `StyledLines` 1144-1182, `wrapPlainLine`* 1183-1197, `buildRewindDoneText`* 1434-1450, `CONTINUE_NUDGE_TEXT`* 1451-1453, `CONTINUE_NUDGE_STATUS` 1454-1455, `buildLateEntriesNote`* 1456-1462.

Depends on A only. Read by G, I, J, M, the factory (`runQueuedFold`, `requestBudgetFailureDraft`, `continueNudgeDraft`, `runFoldNow`, `maybeRunAutomaticFold`), both `turn_end` handlers, the renderers block, the tool. `StyledLines` is the only top-level class and is the entry/message renderer for `pi.registerMessageRenderer`. No state.

### G. Overflow, request accounting, token calibration — 948-976, 995-1071

`OverflowModel` 948-961, `overflowed` 962-976, `requestAccounting` 995-1004, `tokenCalibration` 1005, `tokenFactorOf` 1007-1015, `noteOutgoingRequest` 1016-1025, `noteRequestUsage` 1026-1049, `accountRequest` 1050-1066, `estimateAdmissionTokens`* 1067-1071.

Depends on C, B, A (`ANCHOR_MANDATE` in `accountRequest`). **Module-level mutable state: `tokenCalibration` Map (1005), cleared by the factory's `session_shutdown`/`session_start`.** Read by D, J, L, the factory, the `context`/`turn_end` handlers, and 5 test/script importers.

### H. Continuity request section and open-tool-batch check — 1101-1143

`continuityRequestSection` 1101-1118, `CONTINUITY_CAPTURE_TIMEOUT_MS` 1119-1121, `endsInOpenToolBatch` 1122-1143. No internal deps. Read by `prepareFold` (prompt inputs) and `captureContinuity` (timeout).

### I. Late entries and the recovery cut — 1198-1433

`rewindStaleReason` 1198-1219, `LateEntry`* 1220-1232, `isPreservedLateEntry` 1233-1241, `toolEnvelopeIds` 1242-1255, `recoveryCutOf`* 1256-1374 (119 lines), `collectLateEntries` 1375-1433.

Depends on F (`REWIND_CUSTOM_TYPE`) and itself. Read by `previewFoldCommit` (J), `recoverIndependently`, `maybeRunAutomaticFold`. Pure, no state. `recoveryCutOf` is the only symbol with a dedicated test file (`tests/recovery/recovery-cut.test.ts`).

### J. Fold preview and commit — 1463-1936

`FoldPreviewInput`* 1463-1485, `FoldCommitInput`* 1486-1491, `FoldMaterialization` 1492-1512, `FoldPreview`* 1513-1523, `FoldCommitOutcome` 1524-1556, `previewFoldCommit`* 1557-1751 (195), `unrestoredFoldCursors` 1752, `commitFold`* 1760-1936 (177).

Depends on A (`RECOVERY_HEADROOM_TOKENS`, `RECOVERY_MIN_OUTPUT_TOKENS`, reflection warning), B (`emitSessionTree`, `refreshAgentMessages`), D (`carriedCompaction`, `compactionCopy`, `carriedDetails`, `findLabeledEntry`, `precedesLatestCompaction`, `projectAtEntry`), F (`buildLateEntriesNote`, `REWIND_CUSTOM_TYPE`), G (`requestAccounting`, `estimateAdmissionTokens`), I (`collectLateEntries`, `rewindStaleReason`). **Module-level mutable state: `unrestoredFoldCursors` WeakSet (1752)**, written by `commitFold`, `compactUnderPressure`, `maybeRunAutomaticFold`, the factory's `context_with_system`; read as a fold gate in `maybeRunAutomaticFold`, `maybeConsolidate`.

### K. Fold host/API contract types — 1937-1982

`FoldHost` 1937-1948, `FoldLanded` 1949-1954, `FoldResult` 1955-1957, `FoldRequestInput`* 1958-1960, `FoldApi` 1961-1982. Types only. `FoldApi` is the `foldApis` (2386) value type and the `__testHooks.foldApi(pi)` return.

### L. Fold admission, pricing and recommendation — 1983-2302

`foldAdmission` 1983-2012, `foldSummaryPlaceholderTokens`* 2013-2020, `foldPlaceholderSummary`* 2021-2031, `foldRecommendationBudget`* 2032-2041, `recommendFoldIndex`* 2042-2052, `FoldCandidatePrice` 2053-2060, `preparedInContext` 2061-2097, `summarizerReduceTokens` 2098-2111, `summarizerOutputCap` 2112-2119, `previewStrategy` 2120-2152, `FOCUS_REQUEST_CHARS` 2153-2155, `defaultFoldFocus` 2156-2189, `priceFoldCandidates`* 2190-2302 (113).

Most cross-cutting unit: depends on A (`START_ANCHOR_LABEL`, `MIN_SUMMARY_FOCUS_LENGTH`, `RECOVERY_HEADROOM_TOKENS`), C (`buildContextMessages` via `preparedInContext`), D, E (`collectActiveAnchors`), F, H (`continuityRequestSection`), G, J (`previewFoldCommit`), plus `fold/fold-summarizer` and `fold/fold-inputs`. Called by `recoverIndependently`, `manualFoldDeps`, `maybeRunAutomaticFold`, tests. No state.

### M. Fold receipts and tool-result helpers — 2303-2385

`foldDoneDraft` 2303-2333, `foldFailedDraft` 2334-2365, `ToolResult` 2366-2371, `toolError` 2372-2385.

Depends on F (`rewindMessageDraft`, `RewindMessageDraft`), K (`FoldResult`), `fold/fold-engine`'s `FoldOutcome`. Read by `runFoldNow`, `runQueuedFold`, `recoverIndependently`, `maybeRunAutomaticFold`, and the tool's refusal paths.

### Dependency direction (from call-site scan, comments excluded)

`A ← everything`. `B ← C, J, factory`. `C ← D, G, L`. `D ← E, J, L, factory`. `E ← J, L, tool, anchor command`. `F ← G, I, J, M, factory, renderers`. `G ← D, J, L, factory`. `H ← J, factory`. `I ← J, factory`. `J ← L, factory`. `K ← J, M`. `L ← factory, tests`. `M ← factory, tool`.

Only two mutual pairs exist, both one-directional per function: `D ↔ G` (`requestAccounting`/`estimateAtEntry`) and `J ↔ L` (`previewFoldCommit`/`preparedInContext`).

## 2. The default-export factory (2388-5488, 3101 lines)

### 2.1 Closure state (29 bindings)

| Line | Binding | Kind | Written by | Read by |
|---|---|---|---|---|
| 2498 | `parentModes` | Map\<sessionId, HandoffMode\> | `applyNavigatorConfig`, `session_start` | `prepareFold`, `recoverIndependently`, `manualFoldDeps`, `maybeRunAutomaticFold`, `ANCHOR_CMD` |
| 2503 | `capturedSystems` | Map\<sessionId, {modelKey, messages}\> | `captureSystemHead`, `session_start`, `session_shutdown` | `prepareFold`, `recoverIndependently`, `manualFoldDeps`, `maybeRunAutomaticFold`, `turn_end`, `context_with_system` |
| 2504 | `queuedFolds` | Map\<sessionId, FoldRequest\> | `queueFold`, `runQueuedFold`, `agent_settled`, `session_start`, `session_shutdown` | `ANCHOR_CMD`, `turn_end`, `maybeRunAutomaticFold`, `maybeConsolidate` |
| 2505 | `runningFolds` | Set\<sessionId\> | `runFold`, `compactUnderPressure`, `maybeConsolidate` | `ANCHOR_CMD`, `queueFold`, `maybeRunAutomaticFold`, `maybeConsolidate` |
| 2507 | `rewindTurns` | WeakSet\<object\> | `turn_end` (overflow path), `runQueuedFold`, `maybeRunAutomaticFold` | `turn_end` (both), `agent_end` path, `continueNudgeDraft`, `maybeRunAutomaticFold` |
| 2511 | `overflowedTurns` | WeakSet\<object\> | `turn_end` (fold/recovery) | `turn_end` (hint/anchor), `continueNudgeDraft`, `maybeRunAutomaticFold` |
| 2513-2524 | `requestBudgetFailures` | Map\<sessionId, {inputEstimate, contextWindow, receiptId, detail?, providerOverflow?}\> | `turn_end`, `agent_before_settle`, `context_with_system`, `agent_settled`, `before_agent_start`, `session_start`, `session_shutdown` | `turn_end`, `agent_settled`, `context_with_system` |
| 2525 | `recoveryAttempts` | Map\<sessionId, {attempts, heuristicTokens}\> | `recoverIndependently`, `turn_end` (delete), `agent_settled`, `before_agent_start`, `session_start`, `session_shutdown` | `recoverIndependently` |
| 2526 | `nativeRetryOwned` | Set\<sessionId\> | `session_before_compact`, `session_compact_failed`, `context_with_system` (delete), `agent_settled`, `before_agent_start`, `session_start`, `session_shutdown` | `turn_end`, `agent_before_settle`, `context_with_system` |
| 2527-2529 | `recoveryCuts` | Map\<sessionId, entryId\> | `recoverIndependently`, `session_start`, `session_shutdown` | `prepareFold`, `recoverIndependently` |
| 2530 | `recoveryReceipts` | Map\<sessionId, RewindMessageDraft[]\> | `holdRecoveryReceipt`, `agent_settled` (delete), `before_agent_start`, `session_start`, `session_shutdown` | `agent_settled` |
| 2571-2582 | `piSettingsSource` | let {cwd, agentDir, projectTrusted} | `session_start` | `piCompaction`, `reserveOrderWarnings` |
| 3218-3221 | `continuityConfig` | let | `applyNavigatorConfig`, `session_start`, `ANCHOR_CMD.settings.onSaved` | `captureContinuity`, `ANCHOR_CMD.applyUserOps`, tool `pin`, `maybeConsolidate` |
| 3222 | `continuityWarned` | Map\<sessionId, Set\<string\>\> | `captureContinuity`, `session_start`, `ANCHOR_CMD` | `captureContinuity` |
| 3224 | `classifierTimedOut` | Set\<sessionId\> | `captureContinuity`, `session_start`, `ANCHOR_CMD` | `captureContinuity` |
| 3225-3231 | `consolidationConfig` | let | `applyNavigatorConfig`, `session_start` | `maybeConsolidate` |
| 3346 | `nudgedFolds` | Set\<summaryId\> | `continueNudgeDraft` | `continueNudgeDraft` |
| 3756 | `toolActive` | let boolean | `before_agent_start`, `session_start` | both `turn_end`, `captureContinuity`, `continueNudgeDraft`, `agent_before_settle`, `context_with_system`, `maybeRunAutomaticFold`, `maybeConsolidate`, `ANCHOR_CMD` |
| 3757 | `rewindHintReserveTokens` | let | `applyNavigatorConfig`, `session_start` | `ANCHOR_CMD`, `foldBudget`, `turn_end` (hint), `recoverIndependently`, `maybeRunAutomaticFold`, `reserveOrderWarnings` |
| 3758 | `hintByModel` | let ReadonlyMap | `applyNavigatorConfig`, `session_start` | same as above |
| 3759 | `autoNavigateBase` | let AutoNavigatePartial | `applyNavigatorConfig`, `session_start` | `recoverIndependently`, `maybeRunAutomaticFold`, `ANCHOR_CMD.settings` |
| 3760 | `autoNavigateByModel` | let ReadonlyMap | `applyNavigatorConfig`, `session_start` | same |
| 3761 | `proposalConfig` | let ProposalOptions | `applyNavigatorConfig`, `session_start` | `recoverIndependently`, `maybeRunAutomaticFold`, `ANCHOR_CMD.settings` |
| 3762 | `autoFoldStateBySession` | Map\<sessionId, AutoFoldState\> | `maybeRunAutomaticFold`, `ANCHOR_CMD`, `session_start`, `session_shutdown` | `maybeRunAutomaticFold`, `ANCHOR_CMD` |
| 3763-3771 | `hintTracker` | let RewindHintTracker | `session_start`, `ANCHOR_CMD`, `turn_end` (hint) | `turn_end` (hint) |
| 3772 | `anchorStartSettled` | Set\<sessionId\> | `writeStartAnchorIfNeeded`, `session_compact` (delete) | `writeStartAnchorIfNeeded` |
| 3773 | `anchorStartTurnsBySession` | Map\<sessionId, number\> | `applyNavigatorConfig`, `session_start` | `writeStartAnchorIfNeeded` |
| 3774 | `toolActiveBySession` | Map\<sessionId, boolean\> | `before_agent_start`, `session_start` (delete) | both `turn_end`, `captureContinuity`, `continueNudgeDraft`, `agent_before_settle`, `context_with_system`, `writeStartAnchorIfNeeded`, `maybeRunAutomaticFold`, `maybeConsolidate` |
| 5486 | `restoreProjection` | const (uninstall fn) | `installHandoffProjection()` | `session_shutdown` at 5487 |

Plus the `pi` handle and `foldApis.set(pi, {queueFold, runFoldNow})` at 3152.

### 2.2 Inner functions

| Lines | Size | Name | Closure state R/W | Inner calls |
|---|---|---|---|---|
| 2531-2535 | 5 | `holdRecoveryReceipt` | W `recoveryReceipts` | — |
| 2536-2546 | 11 | `receiptOnBranch` | — | — |
| 2547-2570 | 24 | `requestBudgetFailureDraft` | — | — (`rewindMessageDraft`) |
| 2583-2605 | 23 | `piCompaction` | R `piSettingsSource` | — (`asInternals`, `findOwningSession`) |
| 2608-2614 | 7 | `writeLabel` | R `unrestoredFoldCursors` | — |
| 2623-2643 | 21 | `captureSystemHead` | W `capturedSystems` | — |
| 2646-2718 | 73 | `prepareFold` | R `capturedSystems`, `recoveryCuts`, `parentModes` | — |
| 2721-2771 | 51 | `commitEngineFold` | — | `writeLabel`, `commitFold` |
| 2774-2806 | 33 | `runFold` | W `runningFolds` | `prepareFold`, `commitEngineFold` |
| 2808-2971 | 164 | `recoverIndependently` | R/W `recoveryAttempts`, W `recoveryCuts`, R `capturedSystems`, `parentModes`, config lets | `runFold`, `compactUnderPressure` |
| 2974-2983 | 10 | `foldHostOf` | — | `summaryThinking` |
| 2986-2989 | 4 | `summaryThinking` | — | — |
| 2991-2997 | 7 | `gateFailed` | — | — |
| 3003-3015 | 13 | `queueFold` | R/W `queuedFolds`, R `runningFolds` | — |
| 3018-3035 | 18 | `appendFoldMessage` | R `unrestoredFoldCursors` | — |
| 3038-3055 | 18 | `runFoldNow` | — | `foldHostOf`, `runFold`, `gateFailed`, `appendFoldMessage` |
| 3057-3069 | 13 | `foldBudget` | R `rewindHintReserveTokens`, `hintByModel` | — |
| 3071-3074 | 4 | `manualFocus` | — | — |
| 3077-3143 | 67 | `manualFoldDeps` | R `capturedSystems`, `parentModes` | `manualFocus`, `foldBudget`, `foldHostOf`, `queueFold`, `runFoldNow`, `summaryThinking` |
| 3145-3150 | 6 | `openManualFold` | — | `manualFoldDeps`, `queueFold`, `runFoldNow` |
| 3161-3213 | 53 | `runQueuedFold` | W `queuedFolds`, `rewindTurns` | `gateFailed`, `foldHostOf`, `runFold`, `captureContinuity` |
| 3232-3342 | 111 | `captureContinuity` | R `continuityConfig`, W `continuityWarned`, `classifierTimedOut`, R `toolActive(BySession)` | — (`endsInOpenToolBatch`) |
| 3354-3422 | 69 | `continueNudgeDraft` | R `rewindTurns`, `overflowedTurns`, `toolActive(BySession)`; R/W `nudgedFolds` | — |
| 3782-3838 | 57 | `writeStartAnchorIfNeeded` | R `anchorStartTurnsBySession`, `toolActiveBySession`; R/W `anchorStartSettled` | — (`findLabeledEntry`) |
| 3840-3853 | 14 | `applyNavigatorConfig` | W all config lets, `anchorStartTurnsBySession`, `parentModes`, `autoFoldStateBySession` | — |
| 3933-3978 | 46 | `reserveOrderWarnings` | R `piSettingsSource`, reserve lets | — |
| 4301-4575 | 275 | `maybeRunAutomaticFold` | R/W `autoFoldStateBySession`, W `rewindTurns`, R `queuedFolds`, `runningFolds`, `capturedSystems`, `parentModes`, config lets, `toolActive(BySession)`, `overflowedTurns` | `foldHostOf`, `compactUnderPressure`, `runFold`, `gateFailed`, `writeLabel`; closures `isCurrent`, `deliver`, `anchor`, `skipped` |
| 4584-4834 | 251 | `compactUnderPressure` | W `runningFolds` | `writeLabel`; closures `planAt`, `details`, `compactionText`, `previewOf`, `admissionAfter`, `receiptText` |
| 4843-5030 | 188 | `maybeConsolidate` | W `runningFolds`, R `queuedFolds`, config lets, `toolActive(BySession)` | `foldHostOf`, `writeStartAnchorIfNeeded`; closures `warn`, `isCurrent` |
| 5486 | 1 | `restoreProjection` | — | — |

### 2.3 Handlers and registration

| Lines | Size | Unit | State R | State W | Inner calls |
|---|---|---|---|---|---|
| 2389-2495 | 107 | `registerAnchorCommand(pi, {...})` (settings, listAnchors, setAnchor, suggestLabel, requestFold, openFoldPlan, foldWithoutUi, contextBadge, readLedger, applyUserOps) | `queuedFolds`, `runningFolds`, `continuityConfig`, reserve lets, `autoNavigate*`, `proposalConfig`, `autoFoldStateBySession`, `continuityWarned`, `classifierTimedOut` | `hintTracker`, `autoFoldStateBySession`, `continuityWarned`, `classifierTimedOut` (+ `applyNavigatorConfig`) | `openManualFold`, `manualFoldDeps`, `writeLabel` |
| 3425-3531 | 107 | `pi.on("turn_end")` fold/recovery owner | `requestBudgetFailures`, `queuedFolds`, `rewindTurns`, `overflowedTurns`, `nativeRetryOwned`, `toolActive(BySession)`, `recoveryAttempts` | `overflowedTurns`, `rewindTurns`, `requestBudgetFailures`, `recoveryAttempts` | `runQueuedFold`, `recoverIndependently`, `captureContinuity`, `maybeRunAutomaticFold`, `maybeConsolidate`, `continueNudgeDraft`, `piCompaction`, `foldHostOf`, `holdRecoveryReceipt` |
| 3534-3622 | 89 | `pi.on("agent_before_settle")` | `nativeRetryOwned`, `toolActive(BySession)` | `requestBudgetFailures` | `recoverIndependently`, `foldHostOf`, `piCompaction`, `holdRecoveryReceipt`, `requestBudgetFailureDraft` |
| 3624-3648 | 25 | `pi.on("agent_settled")` | `recoveryReceipts`, `requestBudgetFailures` | `requestBudgetFailures`, `recoveryReceipts`, `recoveryAttempts`, `nativeRetryOwned`, `queuedFolds` | `receiptOnBranch`, `appendFoldMessage`, `requestBudgetFailureDraft` |
| 3651-3666 | 16 | `pi.on("session_shutdown")` | — | deletes from 8 closure maps + `tokenCalibration` (G) | — |
| 3668-3676 | 9 | `pi.on("session_before_compact")` | — | `nativeRetryOwned` | — |
| 3678-3686 | 9 | `pi.on("session_compact_failed")` | — | `nativeRetryOwned` | — |
| 3688-3694 | 7 | `pi.on("session_compact")` | — | `anchorStartSettled` | — |
| 3696-3754 | 59 | renderers: `registerEntryRenderer(CONTINUITY_OPS_CUSTOM_TYPE)`, `registerMessageRenderer(LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE)`, `registerEntryRenderer(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE)`, `registerMessageRenderer(REWIND_CUSTOM_TYPE)` (nudge + failed rows) | — | — | `StyledLines`, `legacySummaryRequestRow`, `legacyRewindOutcomeRow` |
| 3860-3926 | 67 | `pi.on("session_start")` | — | resets 15 bindings incl. `hintTracker`, `piSettingsSource`, then `applyNavigatorConfig` | `applyNavigatorConfig`, `reserveOrderWarnings` |
| 3988-3990 | 3 | `pi.on("context")` | — | — | `buildContextMessages` |
| 3992-4073 | 82 | `pi.on("context_with_system")` | `nativeRetryOwned`, `toolActive(BySession)`, `capturedSystems` | same + `requestBudgetFailures`, `unrestoredFoldCursors` | `foldHostOf`, `captureSystemHead`, `noteOutgoingRequest`, `requestAccounting`, `piCompaction`, `recoverIndependently` |
| 4082-4100 | 19 | `pi.on("before_agent_start")` | — | `toolActive`, `toolActiveBySession`, deletes `requestBudgetFailures`/`recoveryReceipts`/`recoveryAttempts`/`nativeRetryOwned` | — |
| 4110-4117 | 8 | `pi.on("tool_result")` | — | — | — (flips `isError` for `toolError` refusals) |
| 4124-4299 | 176 | `pi.on("turn_end")` hint + start anchor | `toolActive(BySession)`, `rewindTurns`, `overflowedTurns`, reserve lets, `hintTracker` | — (tracker internal) | `writeStartAnchorIfNeeded`, `piCompaction` |
| 5036-5048 | 13 | `pi.on("agent_end")` | — | — | `writeStartAnchorIfNeeded` |
| 5050-5483 | 434 | `pi.registerTool` (`navigate_tree`: list, anchor, pin, rewind) | `continuityConfig` | — | `estimateAdmissionTokens`, `collectActiveAnchors`, `estimateAtEntry`, `resolveAnchorTarget`, `findLabelHint`, `findLabeledEntry`, `precedesLatestCompaction`, `buildMinSavingsRejection`, `buildRewindAcceptedText`, `toolError`, `queueFold` |
| 5484-5485 | 2 | `registerHandoffRenderer(pi)`, `registerHistoryOutline(pi)` | — | — | — |
| 5487 | 1 | `pi.on("session_shutdown", restoreProjection)` | `restoreProjection` | — | — |

`foldApis.set(pi, …)` sits at 3152, between `openManualFold` and `runQueuedFold`.

### 2.4 Natural seams

| Seam | Lines | Size | State it owns | State read across the seam |
|---|---|---|---|---|
| S1 fold host + queue | 2498-2645 | 148 | `parentModes`, `capturedSystems`, `queuedFolds`, `runningFolds`, `piSettingsSource` | `unrestoredFoldCursors`, `recoveryCuts` |
| S2 manual/queued fold entry points | 2974-3217 | 244 | none (uses S1 state) | `capturedSystems`, `parentModes`, `queuedFolds`, `runningFolds`, reserve lets |
| S3 fold engine run | 2646-2807 | 162 | none (`runningFolds`) | `capturedSystems`, `recoveryCuts`, `parentModes` |
| S4 independent recovery | 2511-2570, 2808-2971 | 60 + 164 | `requestBudgetFailures`, `recoveryAttempts`, `nativeRetryOwned`, `recoveryCuts`, `recoveryReceipts` | `capturedSystems`, `parentModes`, 6 config lets, `rewindTurns`/`overflowedTurns` (set by callers), `unrestoredFoldCursors` |
| S5 continuity capture + nudge | 3218-3342, 3346-3422 | 179 | `continuityConfig`, `continuityWarned`, `classifierTimedOut`, `nudgedFolds` | `toolActive`, `toolActiveBySession`, `rewindTurns`, `overflowedTurns` |
| S6 session lifecycle + config | 2571-2582, 3651-3666, 3782-3853, 3860-3926, 3933-3978, 5036-5048 | 8+16+72+67+46+13 | `toolActive`, `toolActiveBySession`, `anchorStartSettled`, `anchorStartTurnsBySession`, `hintTracker`, `piSettingsSource`, and the reset of every other session-keyed map | all of S1/S4/S5/S7/S8/S9/S10 state (to clear it) |
| S7 request guard (`context`, `context_with_system`, `before_agent_start`, `tool_result`) | 3988-4117 | 130 | none | `nativeRetryOwned`, `requestBudgetFailures`, `capturedSystems`, `toolActive(BySession)`, `unrestoredFoldCursors`, S1+S4 functions |
| S8 hint + start anchor | 3756-3779, 4124-4299 | 24+176 | `rewindHintReserveTokens`, `hintByModel`, `hintTracker` | `toolActive(BySession)`, `rewindTurns`, `overflowedTurns`, `anchorStart*` |
| S9 automatic folding | 4301-4575 | 275 | `autoFoldStateBySession` | `rewindTurns`, `queuedFolds`, `runningFolds`, `capturedSystems`, `parentModes`, config lets, `toolActive(BySession)`, `overflowedTurns`, `unrestoredFoldCursors` |
| S10 pressure compaction | 4584-4834 | 251 | none | `runningFolds`, reserve/config lets, `unrestoredFoldCursors` |
| S11 consolidation | 4843-5030 | 188 | none | `runningFolds`, `queuedFolds`, `consolidationConfig`, `toolActive(BySession)`, `unrestoredFoldCursors` |
| S12 renderers | 3696-3754 | 59 | none | constants (A), `StyledLines` (F) |
| S13 tool dispatch | 5050-5483 | 434 | none | `continuityConfig`, `queueFold` (S1) |
| S14 anchor command deps | 2389-2495 | 107 | none | 6 config lets + `applyNavigatorConfig`, `queuedFolds`/`runningFolds`, `autoFoldStateBySession`, `continuityWarned`/`classifierTimedOut`, `hintTracker`, `openManualFold`/`manualFoldDeps`/`writeLabel` |
| S15 projection install | 5484-5487 | 4 | `restoreProjection` | — |

State crossing ≥3 seams (the reason a function-by-function move is not enough):

- `toolActive` / `toolActiveBySession` — S5, S6, S7, S8, S9, S10, S11, S13, S14.
- `rewindTurns` / `overflowedTurns` — S2, S5, S6, S7, S8, S9 (and S3 writes `rewindTurns` via callers).
- `runningFolds` / `queuedFolds` — S1, S2, S3, S6, S9, S10, S11, S13, S14.
- `capturedSystems` / `parentModes` — S1, S3, S4, S7, S9, S14.
- The seven config lets (`rewindHintReserveTokens`, `hintByModel`, `autoNavigateBase`, `autoNavigateByModel`, `proposalConfig`, `continuityConfig`, `consolidationConfig`) — S6 writes, S4/S5/S7/S8/S9/S10/S11/S14 read.
- `unrestoredFoldCursors` (module-level, J) — S1, S7, S9, S10, S11.

`session_start` (3860-3926) and `session_shutdown` (3651-3666) reach 8 and 9 state families respectively; they are the only functions that can see every seam's state today.

## 3. `__testHooks` (5490-5546)

`export const __testHooks` at 5503 exposes:

- `resetPrototype()` 5513-5526 — restores `AgentSession.prototype.prompt` from `ORIG_PROMPT_KEY`, deletes the symbol, empties `sessionInstances`, rebinds `seenSessions` to a fresh `WeakSet`. Only writer of `seenSessions` outside cluster B.
- `findLabelHint` (E), `findLabeledEntry` (D), `buildContextMessages` (C), `refreshAgentMessages` (B), `captureSession` (B).
- `foldApi(pi)` → `foldApis.get(pi)` (2386, `FoldApi` type from K).
- `sessionRefCount()` → `sessionInstances.length` (B).
- `REFLECTION_BOOTSTRAP_WARNING_LIST`, `REFLECTION_BOOTSTRAP_WARNING_REWIND` (A).

It touches module-level state only (A, B, C, D, 2386), no factory closure state.

## 4. Importers of `src/index.ts`

No `src/` module imports it (only doc comments in `core/config.ts`, `core/helpers.ts` mention it). `package.json:39` declares `./src/index.ts` under `pi.extensions`.

| Importer | Symbols |
|---|---|
| tests/index.test.ts:86-119 | default `navigateTree`; `__testHooks`, `ANCHOR_MANDATE`, `buildLateEntriesNote`, `buildRewindAcceptedText`, `buildRewindDoneText`, `CONSOLIDATION_CUSTOM_TYPE`, `CONTINUE_NUDGE_TEXT`, `commitFold`, `estimateAdmissionTokens`, `FoldCommitInput` (type), `FoldPreviewInput` (type), `foldPlaceholderSummary`, `foldRecommendationBudget`, `foldSummaryPlaceholderTokens`, `MAX_HINT_WALK_DEPTH`, `MAX_SESSION_REFS`, `MIN_REWIND_SAVINGS_TOKENS`, `MIN_SUMMARY_FOCUS_LENGTH`, `PRESSURE_COMPACTION_CUSTOM_TYPE`, `previewFoldCommit`, `priceFoldCandidates`, `REWIND_CUSTOM_TYPE`, `recommendFoldIndex`, `START_ANCHOR_LABEL`, `wrapPlainLine` |
| tests/recovery/recovery-cut.test.ts:5 | `recoveryCutOf` |
| tests/recovery/preflight-recovery.test.ts:29 | default `navigateTree`, `estimateAdmissionTokens`, `PRESSURE_COMPACTION_CUSTOM_TYPE` |
| tests/recovery/provider-recovery.test.ts:24 | same three |
| tests/scripts/fold-acceptance/run.test.ts:30 | `estimateAdmissionTokens` |
| scripts/fold-acceptance/run.ts:28 | default `navigateTree`, `__testHooks`, `estimateAdmissionTokens`, `PRESSURE_COMPACTION_CUSTOM_TYPE`, `REWIND_CUSTOM_TYPE` |
| scripts/fold-acceptance/tui-observer.ts:11 | `estimateAdmissionTokens` |
| scripts/fold-acceptance/tui.ts:114, scripts/live-navigator-acceptance.mjs:240 | path only (extension entry), no symbol imports |

21 of the 35 exports are imported by name, so they need a stable re-export surface or
same-change updates in the importers. `estimateAdmissionTokens` (G) is the most imported
symbol (5 files).

## Notes

- `pi.on("context")` (3988-3990) is a 3-line arrow returning an object; brace-counting scans
  mis-size it — it is complete as listed.
- `registerAnchorCommand`'s deps object is the widest state consumer in the factory
  (10 readers, 4 writers) while containing no fold logic.
- `recoverIndependently` (164 lines) is the only inner function that both reads the config
  lets and writes recovery state — the natural S4 boundary.
- Two `pi.on("turn_end")` handlers exist (3425, 4124) with disjoint duties (fold/recovery
  owner vs. hint/start anchor); the fold one must run first (comment at 3424).
- `randomUUID` is used only by the recovery paths (S4/S7); `sha256` (from
  `retrospective/retrospective-plan.ts`) only by `hashPinnedFile` (E).