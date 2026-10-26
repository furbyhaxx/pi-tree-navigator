---
version: 1
id: "index-split-factory-state"
title: "index.ts factory split: shared state and unit order"
description: "Design for moving the default-export factory of src/index.ts into controller modules without behavior change."
type: "design"
created: "2026-10-26T16:18:40+01:00"
updated: "2026-10-26T16:18:40+01:00"
createdBy: "orchestrator"
updatedBy: "orchestrator"
---

# index.ts factory split

Map of every binding, reader and writer: ../../analyses/index-split/factory-map.md (section 2).
Reviewed by second-opinion; its findings are folded in below.

## State

One shared backing object, allocated once per factory call, grouped by concern. Controllers
receive only the groups or operations they need (narrow `Deps` types), never the whole state.

```ts
interface NavigatorState {
	readonly config: ConfigBindings;      // the 7 config lets + piSettingsSource
	readonly activity: ActivityState;     // toolActive, toolActiveBySession
	readonly folds: FoldState;            // parentModes, capturedSystems, queuedFolds, runningFolds
	readonly recovery: RecoveryState;     // requestBudgetFailures, recoveryAttempts, nativeRetryOwned, recoveryCuts, recoveryReceipts
	readonly continuity: ContinuityState; // continuityWarned, classifierTimedOut, nudgedFolds
	readonly automatic: AutomaticState;   // autoFoldStateBySession
	readonly anchors: AnchorState;        // hintTracker, anchorStartSettled, anchorStartTurnsBySession
	readonly turns: { readonly rewindTurns: WeakSet<object>; readonly overflowedTurns: WeakSet<object> };
}
```

## Invariants the move must keep

- **Config identity is behavior.** Continuity capture compares `continuityConfig !== captureConfig`
  after an await. Replace config values exactly where a binding is reassigned today; never mutate a
  config object in place. Controllers read `state.config.x` at call time; never destructure a
  replaceable field at construction.
- **Lifecycle cleanup is asymmetric.** session_start and session_shutdown delete different fields,
  `anchorStartSettled` survives both, and start deletes `toolActiveBySession` after config loading
  (an await boundary). Keep both sequences explicit and move them last; no generic sweep.
- **Tool gates differ.** Start-anchor gating reads only `toolActiveBySession`; other paths fall back
  to `toolActive`. No universal `isToolActive` helper.
- **Registration stays in index.ts.** Controllers are closure-returning factories without side
  effects; every `pi.on`/`registerTool`/renderer call stays in index.ts in today's order (two
  `turn_end` handlers: fold/recovery owner first) and keeps its sync/async shape.
- Module-global reflection state, `unrestoredFoldCursors` and `foldApis` keep their lifetimes;
  `__testHooks` reference the owning modules.

## Units (sequential, all edit index.ts)

1. Introduce `src/core/navigator-state.ts` and switch the factory to it mechanically; lifecycle
   bodies stay in place.
2. Continuity capture + nudge -> `src/continuity/`; fold engine run (prepareFold, commitEngineFold,
   runFold) -> `src/fold/fold-runtime.ts`.
3. Pressure compaction, independent recovery, automatic folding, consolidation -> `src/auto/`,
   `src/recovery/`.
4. Manual/queued fold adapters, rewind hint + start anchor, request guard handlers, tool dispatch
   (`src/tool/`), `/anchor` command deps, renderers.
5. Lifecycle sequences (session_start/shutdown, config application) last.
