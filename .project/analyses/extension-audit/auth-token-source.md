---
version: 1
id: "auth-token-source"
title: "Auth-plus token-source audit"
description: "Provenance, freshness, and projection interoperability"
type: "analysis"
status: "qa-complete"
confidence: "high"
created: "2026-10-29T19:01:04+01:00"
updated: "2026-10-29T19:06:18+01:00"
createdBy: "analyst"
updatedBy: "Pi coding assistant"
---

# Auth-plus token-source audit

**Accuracy.** Pi already anchors on preceding-request usage (`../pi-auth-plus/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:108`). Synthetic conditionally removes duplicated cache-write usage and substitutes a supported HF payload's blockwise tokenizer recount; framing is omitted and images fall back (`../pi-auth-plus/src/families/synthetic/usage.ts:12`, `../pi-auth-plus/src/families/synthetic/request-tokens.ts:5`). Other tails use tokenizer or character estimates (`../pi-auth-plus/docs/tokens.md:32`). Claude's piecewise baseline-subtracted count is labeled exact (`../pi-auth-plus/src/families/anthropic/count.ts:128`, `../pi-auth-plus/docs/tokens.md:26`), but coordinator-fetched [provider documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting) calls it an estimate.

**Reproduced.** Loading a tokenizer relabeled unchanged stored usage from provider to tokenizer (`../pi-auth-plus/src/tokens/estimate/index.ts:53`). Model selection clears the cache, but recount reused the old model's 200-token anchor (`../pi-auth-plus/src/tokens/tracker/index.ts:84`, `../pi-auth-plus/src/tokens/engine/messages.ts:122`). Immediately after compaction, cached query returned 100; refresh returned 20 (`../pi-auth-plus/src/tokens/tracker/index.ts:84`, `../pi-auth-plus/src/tokens/bus.ts:63`).

**Source-derived.** A `message_end` refresh can precede persistence (`../pi-auth-plus/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:751`); context edits have no tracker subscription (`../pi-auth-plus/src/tokens/tracker/index.ts:109`). Report and breakdown are separately computed and can span branches (`../pi-auth-plus/src/tokens/bus.ts:63`).

**Interop.** The bus offers cached/refresh/breakdown only, no hypothetical input or branch identity (`../pi-auth-plus/docs/events.md:299`). Bus recounts do not replace Pi's estimator; corrected Synthetic usage changes its baseline (`../pi-auth-plus/src/families/synthetic/index.ts:111`, `../pi-auth-plus/src/tokens/bus.ts:63`). Exact fold accounting needs immutable post-transform payloads, physical-model/tokenizer and session/leaf identity, freshness fencing, and authoritative whole-request counting. Without the latter, pre-request exactness is unavailable; label estimates.

**Verification.** Auth ref `2dd635a`; nine focused files: `68 pass; 0 fail; 400 expect()`; three offline reproductions passed. Initial preload path failed, then passed. Commands and outputs: `evidence/auth-token-source/`.

**BLOCKERS:** none; live accuracy unverified, network forbidden.
