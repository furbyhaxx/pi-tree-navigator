---
version: 1
id: "extension-audit-integration"
title: "Integration and performance audit"
description: "Independently reproduced lifecycle, Workbench composition and scaling findings."
type: "analysis"
created: "2026-10-29T17:58:55+01:00"
updated: "2026-10-29T18:04:54+01:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

Reviewed revision: `cf4730634090f678e7f578e9fe5672ca0c8c230c`.
Review only; no product files changed.

## I1 — P2: One session shutdown removes projection support from another live session

- Sources: `src/fold/handoff-projection.ts:167–178`; registration and shutdown in `src/index.ts:248–249`.
- Each installation unwraps to the original host method and installs its own replacement. The most recent installation's cleanup restores that original method even when an earlier installation remains alive.
- Reproduction: an in-memory SessionManager with historical assistant usage of 100010 tokens, followed by clone provenance naming that assistant. Install A, then B. While both exist the patched estimate is 2 tokens. Dispose B while A is alive: estimate becomes 100010. Dispose A afterward does not repair the situation.
- Impact: in-process SDK sessions can lose corrected native context accounting and handoff materialization when a sibling ends. This is not a failure of ordinary sequential session replacement, which recreates the extension runtime.
- Recommendation: reference-count the shared patch or maintain installation ownership; restore the host method only when no live owner remains. Apply the same ownership review to the renderer patch helper (`src/ui/handoff-renderer.ts:157–165`), which uses the same pattern.
- Evidence: `evidence/pi-tree-audit-perf.log`.

## I2 — P2: Workbench system-role frames are hoisted and duplicated in fold requests

- Sources: `src/fold/fold-runtime.ts:48–68`, `src/fold/fold-pricing.ts:141–175`, `src/fold/fold-inputs.ts:205–218`; analogous recovery reconstruction in `src/recovery/request-guard.ts:78–80,132`.
- Reference: `../pi-workbench/src/message-framing/projection.ts:21–43` and registration in `../pi-workbench/src/index.ts:1047–1053`.
- Workbench can project trusted persisted frames into system messages at their original conversation positions. Navigator captures **every** system-role message as its head, then prepends that head to a newly projected persisted conversation.
- Reproduction uses the actual Workbench `projectFrames`, Navigator `captureSystemHead`, and `preparedInContext`: original sequence `[system HEAD, user initial, system FRAME_MARKER, user latest]` becomes `[system HEAD, system FRAME_MARKER, user initial, user FRAME_MARKER, user latest]`. Marker occurs twice.
- Impact: order and authority change, evidence duplicates, and Strategy A no longer preserves the main request's prefix. Recovery uses the same reconstruction shape and can reintroduce old frame contents before the reduced conversation. The latter path is a source-derived risk; the directly reproduced path is summary construction.
- Trigger: Workbench runs before Navigator's `context_with_system` and the model supports native mid-conversation system messages. User-role-only frame projection does not trigger this specific duplication.
- Recommendation: distinguish the actual leading system/tool prefix from position-bound system entries, and preserve/reapply request-local transforms when constructing summary and recovered requests. Add composition coverage in both extension orders.
- Evidence: `evidence/pi-tree-audit-frames.log`.

## I3 — P2: Anchor enumeration performs a full projection per anchor

- Sources: `src/core/anchors.ts:33–55`, `src/core/request-accounting.ts:139–148`, `src/core/projection.ts:200–212`; command consumer `src/ui/anchor-command-deps.ts:111–124`.
- `collectActiveAnchors` invokes `estimateAtEntry` for every anchor; each estimate rebuilds a projection and repeats branch/compaction scans. The ID map is shared, but the projected prefix work is not.
- Synthetic fixture: in-memory SessionManager, 500/1000/2000/4000 user messages, each containing 20 repetitions of a short string; one label every 10 messages; handoff projection installed. Five measured runs after a warmup; medians on this host:

| Messages / anchors | List anchors | Context projection |
|---|---:|---:|
| 500 / 50 | 5.12 ms | 0.46 ms |
| 1000 / 100 | 16.02 ms | 0.65 ms |
| 2000 / 200 | 52.69 ms | 1.02 ms |
| 4000 / 400 | 207.35 ms | 2.34 ms |

- Impact: synchronous command/panel opening and pressure-hint listing stalls on long histories. This does not establish a slow ordinary per-request projection; that measured well on these fixtures.
- Recommendation: reuse estimates for unchanged entry/model/config/projection revisions, or derive prefix estimates in one pass while preserving context-edit and compaction semantics. Add a scaling benchmark rather than a brittle wall-clock unit assertion.
- Evidence: `evidence/pi-tree-audit-perf.log`.

## I4 — P2: Proposal side calls have no local deadline and cancellation depends on provider settlement

- Sources: `src/retrospective/proposal-model.ts:44–76`; `src/retrospective/proposal-engine.ts:160–177`; UI ownership in `src/retrospective/proposal-command.ts:298–328`.
- The model adapter passes the caller's signal unchanged and awaits `.result()` directly. Neither the proposal engine nor the adapter creates a timeout. This violates the repository requirement that every model call have a bounded timeout.
- Reproduction with the real `createAssistantMessageEventStream` and a synthetic non-settling registry: abort the caller signal after dispatch. The provider sees the aborted signal, but the returned promise is still pending after 100 ms. It settles only when the fixture explicitly ends the stream. Captured options contain only `signal`, `maxTokens`, and `toolChoice`.
- Impact: a stalled transport/provider can keep a proposal operation pending without a Navigator deadline; dismissing the loader does not independently end the background await. This is a synthetic stalled-provider reproduction, not evidence that any particular live provider ignores cancellation. The 100 ms observation establishes lack of prompt abort, not a measured infinite wait.
- Recommendation: add a bounded operation deadline, compose it with the caller/session shutdown signal, and stop waiting independently of provider cooperation while observing late rejection. Reuse the existing fold/classifier timeout conventions rather than adding another divergent adapter.
- Evidence: `evidence/pi-tree-audit-proposal.log`.

## Reproduction commands

Run from the repository root, with dependencies installed and `../pi-workbench` present for the frame-composition fixture:

```sh
bun .project/analyses/extension-audit/evidence/repro-perf.ts
bun .project/analyses/extension-audit/evidence/repro-frames.ts
bun .project/analyses/extension-audit/evidence/repro-proposal.ts
```

These use synthetic in-memory data and no provider transport. The relocated copies were rerun successfully; the second 400-anchor timing was 211.79 ms, consistent with the original scaling result. Raw logs retain the original measurements.

## Verification

- `just check`: exit 0; typecheck passed; Biome checked 253 files; 1604 tests passed, zero failed, 100 test files, 10.33 seconds reported by Bun.
- `just probe`: exit 0; 34 of 34 checks passed.
- `just rpc-verify`: exit 0; `get_commands` success, local `/anchor` registration present. Offline model-pattern warnings came from user model configuration; they did not prevent extension loading.
- Actual provider calls were not run for this read-only review. Offline fixtures do not establish real-provider semantics, summary quality or cache reuse.
- Disproved hypothesis: ordinary sequential anchor creation does not overwrite the same leaf; `appendLabelChange` advances the leaf, and both anchors remain. This is not a finding.
