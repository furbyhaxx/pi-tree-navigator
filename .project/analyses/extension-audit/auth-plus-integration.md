---
version: 1
id: "extension-audit-auth-plus-integration"
title: "pi-auth-plus token accounting interoperability"
description: "Follow-up audit of Navigator's use of auth-plus counters, usage corrections, and the missing request-snapshot counting contract."
type: "analysis"
created: "2026-10-29T19:00:21+01:00"
updated: "2026-10-29T19:06:18+01:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Verdict

pi-auth-plus is the appropriate owner of provider-specific token counting. Navigator currently benefits from corrected persisted assistant usage but does **not** consume its token service. New tails, hypothetical branches, materialized folds and summary requests still use Navigator's heuristics. Replacing these with the latest cached bus total would be unsafe: that report counts a live session projection, not an identified final or hypothetical request.

Auth-plus was initially read at `f2cba5755603b0153eb894a0d854dce198d4cc64` (version 0.5.1). Concurrent unrelated work advanced it to `2dd635a3395875ee28792f6c5a603f045f07c159` during the review; focused tests ran at that revision. The intervening diff was inspected: token engine, counters, tracker, bus and Synthetic correction files did not change. Its pre-existing untracked `.pi/` directory was left untouched. Navigator product revision remains `cf4730634090f678e7f578e9fe5672ca0c8c230c`; the later audit commit changes no product behavior. This review makes no product changes.

## What is already shared

- `../pi-auth-plus/src/families/synthetic/usage.ts:14–82` removes duplicate usage components and, when a suitable tokenizer and countable payload are available, replaces prompt counts. Billing costs and output are separately retained by the implementation.
- The fallback registration returns a corrected message from `message_end` (`../pi-auth-plus/src/families/synthetic/index.ts:111–121`); request-local physical hooks apply the same correction (`physical.ts:30–42`).
- Pi applies message-end replacement to the message used by persistence and later turn events (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:868–881,920–936`). Navigator reads usage from that message at `src/recovery/turn-boundary.ts:142`, and from projected assistant usage at `src/core/context-tokens.ts:12–27,83–96`.
- A synthetic test changed a usage baseline from 220 to 1,020 using the real auth-plus correction function and an injected tokenizer. Navigator consumed **1,020** without any bus integration. This establishes plumbing, not provider accuracy.
- Navigator invalidates corrected usage when a context edit makes it stale. The retained fixture demonstrates this correctly. A better counter must recount the new projection, not preserve or reuse the invalid baseline.

## Current counter coverage

The implementation is richer, but not uniformly tokenizer-backed:

- Claude uses its native count endpoint with route-specific character estimates on failure (`../pi-auth-plus/src/families/anthropic/index.ts:46–58`, `count.ts:41–46`).
- Explicit Synthetic HF models use their tokenizer when loaded; unsupported/missing-tokenizer cases fall back (`../pi-auth-plus/src/families/synthetic/index.ts:44–56`).
- The open-model Google route uses a tokenizer; its other routes use provider-specific character ratios (`../pi-auth-plus/src/families/google/index.ts:24–52`).
- OpenAI and xAI currently use route-specific character ratios for tails, not native count endpoints (`../pi-auth-plus/src/families/openai/index.ts:51–65`, `../pi-auth-plus/src/families/xai/index.ts:14–28`).
- Unknown families use four characters/token for prose and three for JSON (`../pi-auth-plus/src/tokens/estimate/index.ts:11`).

These are verified implementation choices. This review does not establish the live error distribution of those ratios or revalidate historical calibration datasets.

## AP1 — P2: Navigator does not use auth-plus's richer tail and request counting

Sources: `src/core/context-tokens.ts:83–104,111–129`; `src/core/request-accounting.ts:130–148`; `src/fold/fold-pricing.ts:67–91`; `src/fold/fold-preview.ts:241–277`; `src/fold/fold-summarizer-evidence.ts:8–20`. No auth-plus token bus consumer exists in Navigator's `src/`.

Navigator has multiple local counting purposes:

- Admission uses the newest valid usage plus a character-based tail, scaled by 8/7 or a session calibration factor.
- Fold reduction comparison and consolidation use whole-content heuristic counts.
- Summary admission estimates messages and serialized tools.
- Map/reduce packing separately estimates UTF-8 bytes at 3.5 bytes/token.

Auth-plus supplies provider-specific counters, local tokenizers, source labels, and bounded content memoization (`../pi-auth-plus/src/tokens/engine/index.ts`). Its fallback distinguishes prose from JSON. On the same synthetic JSON tool-result content, Navigator estimated **8,798**, while the auth-plus generic fallback estimated **10,264**. Both are estimates; this is evidence of divergent policy, not proof of the true token count.

Impact: the auth-plus panel/footer and Navigator's fold thresholds can disagree even while both extensions are installed. Better tail counting does not automatically reach anchor selection, fold safety checks or summary chunking. After folds invalidate historical usage, those paths need whole-projection recounts most.

Recommendation: share the counting capability while retaining distinct policies for request admission, context reduction, historical usage and billing. Do not substitute one number indiscriminately for all four meanings.

## AP2 — P2 integration limitation: the current bus cannot authorize an exact request

Sources: `../pi-auth-plus/src/tokens/bus.ts:8–11,61–70`; `../pi-auth-plus/src/tokens/engine/index.ts:24–35,272–321`; `../pi-auth-plus/src/tokens/tracker/index.ts:78–103`.

`queryTokens` accepts only `refresh` and `breakdown`. The report carries provider/model, counts, source and computation time, but no session/leaf identity, input fingerprint or request-transform revision. The engine reads `buildSessionProjection()`, not the final messages flowing through Navigator's `context_with_system` handler or the provider's transformed request.

Consequences:

- `refresh:true` recounts the current branch; it does not count a proposed fold, summary side call, runtime-forced system prompt, or the final request after other extensions transform it.
- The asynchronous tracker debounces updates. A cached result may belong to the preceding state; computation time alone cannot establish that it matches the requested input.
- A live-session count cannot be applied to multiple hypothetical anchor candidates.
- The previously reproduced Workbench frame duplication still needs fixing; improved tokenization cannot repair wrongly composed input.

A synthetic system-state experiment demonstrates the distinction: the session stored `tiny`, while `getSystemPrompt()` supplied a 4,000-character forced prompt. Auth-plus counted the persisted state as **2 tokens**; Navigator counted the explicitly supplied effective request as **1,144**. Both are estimates of different inputs. No real request was dispatched.

This is a capability gap for Navigator integration, not a claim that a dashboard-oriented query service violates its current public contract.

## AP3 — P2 accuracy contract: endpoint-derived does not mean exact whole-request count

Sources: `../pi-auth-plus/src/families/anthropic/count.ts:119–160`; `../pi-auth-plus/src/tokens/types.ts:3–4`; `../pi-auth-plus/docs/tokens.md:21–24`.

The Claude counter counts individual text/tool pieces against a minimal request and subtracts a shared baseline. The engine then adds those pieces. This is a useful cached estimate, but not a count of the final structured conversation. The implementation and docs acknowledge framing differences, while the type comment and UI terminology call count-endpoint values exact.

Current official [Anthropic token-counting documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting), fetched during this review, explicitly calls even a complete endpoint response an **estimate** that may differ from actual input usage and can include unbilled system-added tokens. Therefore source provenance and whole-request precision should be represented separately. Do not treat `source: "count-endpoint"` as proof that a request fits with zero uncertainty.

No live count endpoint was called. This finding is based on the implementation and current provider documentation, not a measured endpoint error rate. Historical Synthetic scale factors were not revalidated and are not claimed as universal current facts.

## AP4 — P2: tokenizer availability relabels historical usage without recounting it

Sources: `../pi-auth-plus/src/tokens/estimate/index.ts:50–54`; `../pi-auth-plus/src/tokens/engine/index.ts:303–305`.

The tokenizer counter's `anchorSource` depends on whether a tokenizer is currently loaded, not on how a particular stored assistant message was counted. The reproduction kept the same stored **200-token** usage, changed only tokenizer availability, and obtained `provider` before / `tokenizer` after. No historical recount occurred. The same mismatch can apply to an unsupported payload that deliberately retained provider usage.

Recommendation: persist count provenance alongside corrected usage, including tokenizer identity/version and recount coverage. Do not infer past counting from current capabilities. Evidence: `evidence/auth-token-source/repro-pass.log` and `repro.ts`.

## AP5 — P2: auth-plus alone reuses old-model usage after a model change

Sources: `../pi-auth-plus/src/tokens/engine/messages.ts:122–162`; `../pi-auth-plus/src/tokens/tracker/index.ts:84–87`.

The tracker clears its cached report on a model change, but the recount's `usageAnchor` checks compaction and context-edit boundaries without matching the assistant's provider/model to the selected model. It can immediately rebuild a new-model report from the old model's usage.

The analyst reproduced an old **200-token** anchor. Independently, the coordinator used the real auth-plus Pi 1.4 SessionManager, persisted a model change, and reproduced an old **220-token** anchor under the new model. Applying Navigator's actual `projectHandoffs` invalidation removed that anchor. Thus Navigator currently masks this auth-plus defect when its shared-host projection patch is active; raw auth-plus counting must not depend on another extension for correctness.

Recommendation: make the engine validate the effective counting identity and relevant model/system boundaries itself. Physical model resolution/alias changes need the same rule. Existing patch-ownership finding A14 can remove the protection, increasing the importance of local validation.

## AP6 — P2 integration risk: cached counts have no invalidation fence after compaction

Sources: `../pi-auth-plus/src/tokens/tracker/index.ts:78–103`; `../pi-auth-plus/src/tokens/bus.ts:63`.

After a synthetic compaction event changed the leaf and current count, the public cached query returned **100** while a refreshed query returned **20**. The tracker cancels/schedules a recount, but only clears immediately on session start, model change or a changed `session_tree` branch—not compaction. The default debounce is 250 ms; the controlled reproduction stretches it to avoid timing-dependent assertions.

Serving cached data is documented, but the response carries no dirty/stale flag or branch revision. It is unsuitable for admission without the AP2 contract change. Clear/mark obsolete reports on every invalidating change, and fence async publication against the counted snapshot.

Additional source-derived concerns, not independently reproduced as live-host failures: `message_end` scheduling can precede host persistence if later handlers are slow; there is no direct context-edit subscription; query report and breakdown are calculated separately and can straddle a change. Details and 68 passing focused tests are retained in [the source audit](auth-token-source.md).

## Recommended direction — design now, implement separately

A hybrid preserves auth-plus's specialization and Navigator's safety requirements:

1. **Auth-plus owns counters and provider shaping knowledge.** Add a supported counting capability for an explicit immutable input snapshot and physical model, rather than importing internal implementation files from Navigator.
2. **Navigator owns projection and admission.** Supply the actual effective messages/system/tools for main requests, proposed post-fold branches and summary requests. Count each shape against its own identity.
3. **Return provenance and identity.** Include source, tokenizer/model revision where available, snapshot fingerprint, coverage limitations, and whether framing is included. Current-session broadcasts should also carry session/branch revision so consumers can reject stale results.
4. **Keep synchronous hot paths free of I/O.** Warm and memoize local counts asynchronously; use bounded explicit preparation for missing expensive counts. Never make rendering or a generic context hook wait indefinitely for an endpoint. On unavailable/stale/unsupported counts, use an honestly labelled conservative fallback or refuse near the limit.
5. **Keep network disclosure explicit.** A refresh can call a provider count endpoint with text. Future cross-extension counting must retain route/disclosure constraints rather than treating it as a purely local utility.
6. **Preserve independent safety checks.** Improved counting does not fix lost context edits/checkpoints, ownership races, or the already-known missing post-recovery admission check.

Options:

| Option | Benefit | Limitation |
|---|---|---|
| Keep separate estimators | No interface change or dependency | Divergent UI and fold decisions persist |
| Consume cached live-session bus totals | Small display-oriented integration | Unsafe for final-request admission or hypothetical folds |
| Shared snapshot counting plus cached display reports | Consistent counters, explicit freshness, candidate support | Requires a small cross-extension contract and regression tests |

Recommend the third option. The contract should be designed before replacing estimators; exact implementation and new configuration remain a user decision. Keep a local fallback so Navigator can still run without auth-plus. Do not copy provider/tokenizer logic into Navigator.

## Verification

- `bun .project/analyses/extension-audit/evidence/repro-auth-integration.ts`: passed all five scenarios; retained output in `evidence/auth-integration.log`.
- `bun test tests/core/context-tokens.test.ts`: **16 pass, 0 fail**; output in `evidence/auth-integration-navigator-tests.log`.
- Analyst's nine focused auth-plus files: **68 pass, 0 fail, 400 expectations**. Three offline source/tracker reproductions passed. Commands, raw output and the initial corrected preload-path failure are retained in `evidence/auth-token-source/`.
- Synthetic counter dependencies prohibit network calls and never load real credentials or tokenizer caches.
- This establishes implementation paths and divergent estimates, not route-wide real token accuracy or performance under live count endpoints.
