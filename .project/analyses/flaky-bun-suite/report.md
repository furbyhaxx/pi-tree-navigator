---
version: 1
id: flaky-bun-suite
title: Flaky `bun test` suite: leaked SessionManager projection patch and a GC-collected fake session
description: Two independent, order-dependent causes for the intermittent full-suite failures after moving from node --test to bun test, with the leaking test files, the causal chain, and concrete fixes.
type: analysis
created: 2026-10-26T16:16:23+01:00
updated: 2026-10-26T16:16:23+01:00
createdBy: analyst
updatedBy: analyst
---

# Flaky `bun test` suite: leaked SessionManager projection patch and a GC-collected fake session

status: "root-caused"
confidence: "high"

## Summary

Two unrelated defects produce the intermittent failures, both created by running all files in one process:

1. `tests/index.test.ts` (and the real-loader activations in `scripts/fold-acceptance/run.ts`) call
   `navigateTree(pi)`, which installs the global `SessionManager.prototype.buildSessionProjection`
   patch and only removes it on `session_shutdown`, which no test emits. The patch survives into later
   files and rewrites navigator `branch_summary` messages into `role: "custom"`, so
   `tests/retrospective/retrospective.test.ts:141` fails whenever an activating file ran since the last
   restore. 15/30 randomized seeds, deterministic with `tests/index.test.ts` + `tests/retrospective/retrospective.test.ts`.
2. In `tests/index.test.ts`, `setupRewindable(..., { capture: true })` captures the fake `AgentSession`
   only as a `WeakRef` and discards its only strong reference. GC may collect it before the fold commits;
   `refreshAgentMessages` then returns `false` and `commitFold` appends the reflection warning after the
   late-entry note, so `endsWith(NOTE_*)` fails. 3/12 ordered runs, 4/30 randomized seeds, 2/5 runs of
   `tests/index.test.ts` alone.

Both are fixed in test code plus one small `__testHooks` addition. `bun test --isolate` is a complete
stopgap for (1) but not for (2).

## Reproduction

Environment: Bun 1.4.3, 16 cores, Linux, 1558 tests / 75 files, ~5.5 s per full run. HEAD `63509ec`
(other agents committed refactor splits into this checkout while the work ran; line numbers below are
as of `63509ec`).

| Command | Result |
|---|---|
| `bun test --randomize --seed=N`, N=1..30 | 15/30 fail `retrospective clone > preserves source bytes…` (seeds 1,3,6,7,12,13,14,15,18,19,22,23,24,26,28); 4/30 fail a rewind test (1,3,15,21) |
| `bun test tests/index.test.ts tests/retrospective/retrospective.test.ts` | 387 pass, 1 fail; 5/5 runs (bun ignores the argument order, `index.test.ts` always runs first) |
| `bun test tests/retrospective/retrospective.test.ts` | 20 pass, 0 fail |
| `bun test tests/index.test.ts` | 2/5 runs fail `the late note is byte-exact…` / `re-appends a late user steer…` |
| `bun test` (ordered), 12 runs | 3/12 fail, always one of those two rewind tests, never the retrospective one |
| `bun test --smol`, 8 runs | 2/8 rewind failures |
| `bun test` with 8 busy-loop processes, 8 runs | 2/8 rewind failures |
| `bun test --isolate --randomize --seed=N` (the 10 failing seeds above) | 10/10 clean |
| `bun test --isolate` (ordered), 10 runs | 5/10 rewind failures |

Observed failure text (seed 1):

```
tests/retrospective/retrospective.test.ts:140 (the file has since moved to :141)
+   'custom',
-   'branchSummary',
    'user'
actual: [ "custom", "user" ], expected: [ "branchSummary", "user" ]
```

## Root cause

### 1. A process-global projection patch with no test-side restore

```
src/index.ts:5488        const restoreProjection = installHandoffProjection();
src/index.ts:5489        pi.on("session_shutdown", restoreProjection);   // only exit path
src/fold/handoff-projection.ts:163-175   install/restore, no idempotency, wrappers stack
tests/index.test.ts:542-555             setup() calls navigateTree(pi.pi) for every test
tests/index.test.ts:122-124             afterEach only calls __testHooks.resetPrototype()
scripts/fold-acceptance/run.ts:592      real pi loader activates the extension in-process
tests/fold/handoff-projection.test.ts:12  beforeEach(() => installHandoffProjection()()) — uninstalls leakage by accident
```

`installHandoffProjection` replaces `SessionManager.prototype.buildSessionProjection` for the whole
process and hands back a restore that only the `session_shutdown` event calls. `tests/index.test.ts`
activates the extension 377 times and never emits `session_shutdown`; its `afterEach` restores the
`AgentSession.prototype.prompt` patch and clears `sessionInstances` but leaves the projection installed.
While installed, `projectHandoffs` -> `handoffContext` rewrites any navigator `branch_summary` into
`{ role: "custom", customType: "navigate-tree-handoff" }` (`src/fold/handoff.ts:245-262`). Retrospective
clones write exactly such summaries (`details.treeNavigator`), so the clone test sees `custom` instead
of `branchSummary`.

Instrumented run (preload writing to `/tmp/proj-install.log`, seed 1): 442 installs / 27 uninstalls,
wrapper depth 415 at exit. Callers: 377 x `tests/index.test.ts:550` (`setup`), 31 x the pi loader via
`scripts/fold-acceptance/run.ts:592`, 7 x direct factory calls. The installs immediately before the
retrospective file were the loader activations, so every activating file is a potential source; the
`beforeEach` hack in `tests/fold/handoff-projection.test.ts:12` is why ordered runs usually pass (it
uninstalls the leak after `tests/index.test.ts` ran).

`node --test` never showed this because every file was its own process.

### 2. `WeakRef`-only capture of a fake session, collected mid-test

```
src/index.ts:383-397            sessionInstances: WeakRef<AgentSession>[]; captureSession pushes a WeakRef
src/index.ts:420-428            findOwningSession matches by identity, returns null once collected
src/index.ts:540-557            refreshAgentMessages -> false when no owning session is found
src/index.ts:1909,1930          refreshed === false appends REFLECTION_BOOTSTRAP_WARNING_REWIND
tests/index.test.ts:592-616     setupRewindable captures the fake and returns { fake, anchorId }
tests/index.test.ts:3631,3669   "re-appends a late user steer…" asserts endsWith(NOTE_TWO)
tests/index.test.ts:3685,3691   "the late note is byte-exact…" asserts endsWith(NOTE_ONE)
```

50 of the 52 `setupRewindable(..., { capture: true })` call sites discard the returned `{ fake }`; only
the `rewindFixture` helper (~line 947) keeps it. The fake is then reachable only through the module's
`WeakRef`. Between capture and the fold's commit the test awaits provider work, so a GC can drop it.
`refreshAgentMessages` then returns `false`, the fold receipt's continuation gets the reflection warning
appended *after* the late-entry note, and the trailing-content assertion fails while
`reappendedLateMessages` (asserted just before) still passes. Tests that assert
`details.agentMessagesRefreshed` explicitly hold the fake and never flake.

Evidence for the GC link:

- Unit probe against `__testHooks`: `captureSession(fake)` with no strong reference, then
  `Bun.gc(true)` twice, then `refreshAgentMessages(sm)` -> `false` (`sessionRefCount()` still 1, a dead
  `WeakRef`). With a strong reference it returns `true` immediately.
- Differential: preload replacing `WeakRef` with a subclass that keeps its target alive
  (`/tmp/probe/strong-weakref.ts`) run over the same seeds 1..30 -> rewind failures 0/30 (baseline 4/30),
  while the retrospective failure set stayed byte-identical (15/30), proving the two causes are
  independent. The same preload also fails `deduplicates the same session and bounds growth…` in all 30
  runs, confirming the override took effect.
- A preload forcing `Bun.gc(true)` on a 1 ms timer did not reproduce it (timers fire between tests,
  not inside them); inconclusive, not contradictory.

## Evidence

- Failure names were read from `--randomize --seed=N` logs for N=1..30, both baseline and with the
  strong-`WeakRef` preload (`/tmp/base-*.log`, `/tmp/strong-*.log`).
- Fix validation for cause 1: preload `/tmp/probe/projection-reset.ts` registers
  `afterEach(() => { const p = SessionManager.prototype; if (p.buildSessionProjection[SYM]) p.buildSessionProjection = p.buildSessionProjection[SYM]; })`.
  With it, `bun test tests/index.test.ts tests/retrospective/retrospective.test.ts` passes 5/5; without
  it the same pair fails 5/5.
- `bun test --isolate` (fresh global + module registry per file) makes all 10 previously failing
  randomized seeds pass, but ordered runs still fail the rewind tests (5/10), i.e. isolation fixes
  cause 1 only.
- Ruled out: wall-clock/load timing (idle, `--smol`, and 8 busy loops all give the same 20-40 % rate for
  cause 2); shared `sessionInstances` state between tests (`afterEach` clears it); the handoff renderer
  and history-outline patches (their own tests restore them); `PI_CODING_AGENT_DIR`/config leakage (the
  failing assertions never read config).

## Recommended fix

1. **Projection reset (cause 1)** — `src/fold/handoff-projection.ts`: export a reset that unwinds the
   symbol chain to the true original and assigns it:

   ```ts
   export function resetHandoffProjection(): void {
       const proto = SessionManager.prototype as ProjectionMethod;
       const installed = proto.buildSessionProjection as ProjectionMethod;
       let base = installed;
       while (base[originalKey]) base = base[originalKey] as ProjectionMethod;
       proto.buildSessionProjection = base as SessionManager["buildSessionProjection"];
   }
   ```

   Call it from `__testHooks.resetPrototype()` (`src/index.ts:5512`), which `tests/index.test.ts:122`
   already invokes after every test. Because `scripts/fold-acceptance/run.ts:592` and the recovery
   tests also activate the extension, make the reset suite-wide instead of per-file: add a test setup
   module registered through `bunfig.toml` `[test] preload` (or `bun test --preload`) whose
   `afterEach` calls `resetHandoffProjection()`. Then delete the accidental
   `beforeEach(() => installHandoffProjection()())` in `tests/fold/handoff-projection.test.ts:12` and
   the `installHandoffProjection()` in `tests/retrospective/retrospective.test.ts` still works unchanged.
   Regression test: a test that activates the extension and asserts
   `SessionManager.prototype.buildSessionProjection` has no `Symbol.for("pi-tree-navigator.session-projection.original")`
   after the reset.
   Stopgap while that lands: `bun test --isolate` (measured 10/10 clean on the failing seeds).

2. **Hold the captured fake (cause 2)** — `tests/index.test.ts`: keep the fake alive for the duration of
   the file instead of relying on the `WeakRef`:

   ```ts
   const capturedFakes: FakeAgentSession[] = [];
   // in setupRewindable, capture branch:
   capturedFakes.push(fake);
   // in the existing afterEach (line 122):
   capturedFakes.length = 0;
   __testHooks.resetPrototype();
   ```

   Holding it in the helper fixes all 50 call sites at once. Additionally assert
   `done.details.agentMessagesRefreshed === true` next to `tests/index.test.ts:3669` and `:3691` so a
   future regression reports the real cause instead of a content mismatch. No product change is needed:
   in production pi holds the `AgentSession` strongly.
   Regression coverage: `refreshAgentMessages` returning `false` for an unheld, collected capture is
   product behaviour worth one pinned test (`captureSession`, drop, `Bun.gc(true)`, expect `false`).

3. **Bonus flake, different cause** — `tests/scripts/classifier-eval/run.test.ts:736` failed once in 30
   seeds: `observations()` (line 215) returns file order, but `observations.jsonl` is written by four
   concurrent workers in completion order (`scripts/classifier-eval/run.ts:636-690`), so
   `const [base, granular] = observations()` can swap them. Select by field instead:
   `observations().find((o) => o.variant === "base")`.

## Open questions / follow-ups

- The retrospective failure never appeared in this checkout's plain ordered runs (0/12) because ordering
  decides it; the lead's observation of it in a plain run is consistent with a different discovery order
  (another worktree, or the 71 -> 75 file change noted below). Order-independent once fix 1 lands.
- `bun test` reported 71 files early and 75 files later in the same working tree while other agents were
  committing test splits; check the reported file count when validating, a stale list silently skips
  tests.
- `installHandoffProjection` stacking (415 wrappers at exit) also multiplies projection work in tests;
  the reset removes it. Making install idempotent is possible but restoring per owner is what keeps
  parallel live sessions correct, so it is not recommended on its own.
- Not the briefed problem but noticed: `tests/index.test.ts` clears global patches in `afterEach` while
  `tests/recovery/*.test.ts` import `src/index.ts` without any reset; extending the suite-wide preload in
  fix 1 to also call `__testHooks.resetPrototype()` would cover those files.
