---
version: 1
id: "adaptive-context-sources-2026-10-21"
title: "Adaptive context management: source review and critical assessment"
description: "Primary papers, inspected harness revisions, classifier contracts, provider rules and dispositions of independent review findings."
type: "research"
created: "2026-10-21T20:17:56+02:00"
updated: "2026-10-21T20:24:41+02:00"
createdBy: "Pi coding assistant"
updatedBy: "Pi coding assistant"
---

# Method and coverage

Six parallel investigations covered papers, harness implementations, classifiers, a private session audit, request/protocol correctness, and UX/task continuity. Two independent critics challenged the combined reports. All eight returned. This document is the integrating assistant's assessment, not an unedited collection of agent opinions.

Research date: **21 October 2026, Europe/Zurich**. Source research, local inspection and artifact writing only: no live-provider inference, classifier benchmark, installed-package/configuration change or private transcript upload. Public documentation fetches are not inference experiments.

The integrating assistant checked consequential local claims, read the cited provider/classifier contracts, verified paper identities/abstracts, and inspected selected harness source. Paper performance numbers are the authors' results; none were reproduced. Code inspection establishes implementation behavior at a revision, not task quality or production reliability.

The session audit's private fixture is represented by a hash and aggregate measurements in [session-audit.md](session-audit.md). Its body and identifying source paths are not committed.

# Papers: what transfers and what does not

1. **Generative Agents**, UIST 2023. [Paper](https://arxiv.org/abs/2304.03442), [DOI](https://doi.org/10.1145/3586183.3606763). Retrieval combines relevance, recency and importance with higher-level reflections. This supports age as one signal, not automatic expiration of old constraints. Evaluation was a simulated social environment, not tool-heavy coding. Full-text interpretation comes from the papers lane.

2. **Recursively Summarizing Books with Human Feedback**, 2021, v2. [Paper](https://arxiv.org/abs/2109.10862). Shows trained hierarchical decomposition can produce useful book summaries and support question answering. It used human-feedback training across levels; it does not validate repeatedly shortening an agent's already-shortened handoff without its original sources. Omitted detail remains a failure mode. The integrator verified the abstract and method description; the lane reviewed limitations.

3. **Lost in the Middle**, TACL, 2023. [Paper](https://arxiv.org/abs/2307.03172). In multi-document QA and key-value retrieval, evidence position affected performance, with weaker use of middle context. This establishes a separate evaluation concern from request overflow. It is not a universal percentage penalty for today's models, or proof that any shorter prompt is better.

4. **LongMemEval**, ICLR 2025, v2. [Paper](https://arxiv.org/abs/2410.10813), [code/data](https://github.com/xiaowu0162/LongMemEval). Tests extraction, multi-session reasoning, temporal reasoning, updates and abstention; organizes memory design as indexing, retrieval and reading. Useful evaluation dimensions for this project. The abstract reports a 30% accuracy drop in sustained-interaction memory for evaluated systems; this must not become a forecast for Pi. The lane also found that finer fact granularity was not uniformly beneficial.

5. **LoCoMo / Evaluating Very Long-Term Conversational Memory of LLM Agents**, 2024. [Paper](https://arxiv.org/abs/2402.17753). Adds long-range temporal/causal and adversarial questions. Its generated and human-edited social dialogues differ from repository histories and mutable files. Useful test categories, not sufficient coding-agent validation. Reviewed by the papers lane.

6. **MemGPT**, 2023/2024, v2. [Paper](https://arxiv.org/abs/2310.08560). Separates limited active context from larger memory and pages evidence into the model. This is prior art for a smaller projection over an archive. Document-analysis and conversation results do not prove that a coding agent will recognize an omitted warning and fetch it before acting. The paper is the evidence here; this review did not inspect current Letta source.

7. **LLMLingua-2**, Findings of ACL 2024, v2. [Paper](https://arxiv.org/abs/2403.12968). Uses learned token keep/drop classification for extractive compression. Keeping original tokens avoids some invented wording but can still discard necessary meaning. Evaluations include meeting, long-context, reasoning and other text datasets; they do not establish preservation of native tool protocols or arbitrary reasoning signatures. It is a distinct candidate from an episode-level importance classifier.

8. **Addressable Recall Compaction (ARC)**, preprint, 27 July 2026. [Paper](https://arxiv.org/abs/2607.25066). Stores observations in an append-only ID-addressable log and replaces old observations with citations. Authors report 99.40% versus 88.12% exact-answer accuracy on their Needle-in-a-Haystack setup, but 29.97% versus 28.25% on LongBench-v2 Hard. The different results matter: an explicitly requested needle is much easier to know to retrieve than an unmentioned dependency in a coding task. This supports testing addressable recall, not calling it lossless cognition. The integrator verified both figures in the abstract.

9. **MemDev-Bench**, preprint, 20 October 2026. [Paper](https://arxiv.org/abs/2610.27524). Uses temporally valid repository histories and controlled prior-task relevance. Reports that memory can help localization/editing but also cause failures, and that raw trajectories can save agent steps by retaining process information omitted by compressed memories. Very recent, not independently replicated here; the lane notes limited configuration coverage. Treat as a warning to evaluate applicability and preserve useful process evidence.

10. **GACC-Bench**, preprint, 15 October 2026. [Paper](https://arxiv.org/abs/2610.21893). Evaluates goal-conditioned compression using withheld downstream questions over documents and agent traces. Target-goal conditioning helps in the evaluated setup; mismatched goals hurt, and compressed contexts still fall short of full context. Supports testing task-conditioned views and questions not known to the compressor. Does not justify discarding everything unrelated to the latest task wording.

11. **When to Forget: Risk-Controlled Context Adaptation for Long-Horizon Agents (RECAP)**, preprint, 16 October 2026. [Paper](https://arxiv.org/abs/2610.22897). Studies retain/compress/remove interventions at different execution points; the lane reports that a failure record's usefulness changes with task progression. Preliminary evidence for outcome-based evaluation instead of age-only rules. No replication or Pi-specific guarantee.

**Coverage gap:** this sweep did not establish a direct, reproducible comparison of simple observation masking against abstractive summaries on Pi-style traces. Three additional focused web searches returned no results; no remembered paper title or unsupported performance claim is substituted for missing evidence. The proposed evaluation must include that baseline.

# Harness implementations

## Pi native projection and compaction

The harness lane inspected `badlogic/pi-mono@bd3c9b823762`, MIT, including:

- [Compaction](https://github.com/badlogic/pi-mono/blob/bd3c9b823762/packages/coding-agent/src/core/compaction/compaction.ts): recent-tail retention, valid cut boundaries and previous-summary carryover.
- [Compaction utilities](https://github.com/badlogic/pi-mono/blob/bd3c9b823762/packages/coding-agent/src/core/compaction/utils.ts): file tracking and conversation serialization. The lane observed tool-result truncation for summary input, not deletion from raw history.
- [Session manager](https://github.com/badlogic/pi-mono/blob/bd3c9b823762/packages/coding-agent/src/core/session-manager.ts): branch-local context edits over retained source entries.

The integrator and protocol lane also inspected the locally installed Pi 1.3.0 package source. The host's projected estimator and the SDK's common request estimator are separate paths; agreement must be tested rather than assumed. Runtime-bundled Pi-Bolt behavior may differ from a repository dev dependency.

## OpenHands Software Agent SDK

Inspected revision **`1d057fe15d104758202a2f628e54d6f7bb065755`**, MIT.

- [LLM summarizing condenser](https://github.com/OpenHands/software-agent-sdk/blob/1d057fe15d104758202a2f628e54d6f7bb065755/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py), especially lines 54–200: token pressure and explicit requests are hard requirements; event-count pressure is soft. The effective token limit uses the stricter configured/agent input cap. It protects an initial prefix and recent suffix and has bounded hard-reset retries.
- [Tool-call matching](https://github.com/OpenHands/software-agent-sdk/blob/1d057fe15d104758202a2f628e54d6f7bb065755/openhands-sdk/openhands/sdk/context/view/properties/tool_call_matching.py): protected manipulation boundaries between calls and observations.
- [Condensation event](https://github.com/OpenHands/software-agent-sdk/blob/1d057fe15d104758202a2f628e54d6f7bb065755/openhands-sdk/openhands/sdk/event/condenser.py): IDs describe the model-facing view transformation over an append-only event history.

Adopt the distinction between soft hygiene and hard request safety, explicit view transformations and protocol-safe cut boundaries. Do not infer semantic truth from structurally valid condensation or copy a destructive reset policy without this project's requirements.

## OpenAI Codex

Inspected revision **`9b39316997fd8bcecdb2007722f52ef858f0dbd8`**, Apache-2.0.

- [Remote-history trimming](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/core/src/compact_remote_history.rs), lines 70–199: emergency fitting walks backward over eligible tool outputs, replacing bodies while carrying call identifiers, metadata and success status. It stops at ineligible boundaries and has a retained-output exception.
- [Compaction](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/core/src/compact.rs): a separate summary-history mechanism.

Adopt the separation between emergency request fitting and semantic summarization. This review did not establish an exact raw-transcript retrieval guarantee for Codex's replaced history, or measure task quality.

For both OpenHands and Codex, a refresh using the short commit selector failed; the tool served cached checkouts. The integrator confirmed their full `HEAD` hashes and clean tracked status, then read source at those hashes. These are revision-pinned source observations, not a claim that the latest remote head was freshly checked. No third-party code was copied. Future code reuse must respect the cited licenses.

OpenCode source inspection did not complete in the delegated sweep; no implementation claim about it is used.

# Classifier contracts and limitations

Primary documentation checked on 21 October 2026:

- [TypeSafe models](https://docs.typesafe.ai/models), [System One API](https://docs.typesafe.ai/api/system-one), [confidence](https://docs.typesafe.ai/confidence), [memory cookbook](https://docs.typesafe.ai/cookbooks/basic_memory).
- [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy), reviewed by the classifier lane. Its reported data handling is provider processing, not local inference or an assumed zero-retention contract.
- Installed Pi `docs/models.md`, section “Use classifier models,” and `docs/codemode.md`, section “Classify,” read by the integrator.

Pi exposes typed choices, boolean probabilities and scores. These outputs can label or rank supplied evidence; they do not return arbitrary extracted strings or generate a handoff. The current TypeSafe OpenAPI additionally contains an image-box question behind a special header; that does not provide free-form text extraction, and it is outside the Pi classifier surface considered here.

TypeSafe's published limits distinguish total-request context from state-plus-one-question context. Those constraints and the documented long-context accuracy/latency tradeoff make whole-history classification an inappropriate default. Exact limits, versions and pricing are volatile; no model or price is selected by this report. The lane's models.dev lookup found no Jev entry and used first-party documentation instead.

A reported probability distribution or confidence statistic is not measured calibration on this project's facts. A chat-model alternative should satisfy the same locally validated output schema; unsupported strict-schema generation must fail or use explicit parse/validation/retry behavior. No provider capability is assumed merely from a model name.

Chunk-local evidence cannot establish cross-chunk supersession. A later extractor needs both propositions, supporting sources and relevant authority/time context. Verify source IDs and supporting text mechanically where possible; this does not prove the extracted statement is true or complete.

# Provider and budgeting references

- Anthropic: [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).
- OpenAI: [conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [token counting](https://developers.openai.com/api/docs/guides/token-counting), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- Google: [thinking/signatures](https://ai.google.dev/gemini-api/docs/thinking), [token counting](https://ai.google.dev/gemini-api/docs/tokens).

The protocol lane reviewed these references. The integrator independently checked Anthropic context editing: tool-result clearing uses placeholders and can invalidate the cached prefix; server-managed thinking clearing is distinct from arbitrary client rewriting. Native strategies are provider-specific. Generic trimming must not rewrite opaque reasoning/signature blocks or leave invalid tool-call/result associations.

Cache savings are accounting/latency savings, not reclaimed context capacity. Count current projected input, requested output/reasoning capacity and safety headroom separately. Local estimates remain estimates, and provider-reported usage applies to the request that produced it.

# Independent review: accepted, qualified and declined

Both critics recommended a deterministic baseline before additional models. Their opinions were checked against source and existing user decisions.

**Accepted:** unify baseline validity with projection changes; walk actual projected ancestors rather than stopping at a branch summary; account for replacement size; distinguish archive retention from behavioral recall; preserve protocol and opaque metadata; test old binding constraints and hidden dependencies.

**Qualified:** repeated child prose is a measured cost, but `full` mode is an intentional preservation policy. Changing it to references is an explicit policy experiment, not a safe bug fix. The sidecar's restricted anchor evidence is likewise a safety property; its inability to manage a large span needs an explicit fallback, not permission to decide from unseen evidence.

**Declined:** claims that deterministic receipts guarantee zero semantic loss, 100% protocol safety, or a particular token-saving percentage without tests. Character shares are not safe-removal percentages. Reviewers' invented retrieval/usability thresholds are candidate study choices, not established acceptance criteria.

**Declined:** indefinitely waiting for every background worker before folding. Protect unresolved protocol batches, but capture a live-state revision/event watermark and reconcile later arrivals; a long-lived worker should not indefinitely block context recovery.

**Declined:** replacing the already chosen project task ledger with a new branch-local task authority. Historical receipts and the current ledger answer different questions. The UX lane did not adequately incorporate that prior decision; the synthesis corrects it.

**Qualified:** stale pending-state prose can be a snapshot followed by a legitimate new event. The empty-todo contradiction is real, but its storage-loss cause is not established. Low reread counts do not prove complete memory, and partial file indexes are not a semantic recall benchmark.

No implementation, automatic policy change or quality claim is approved by the reviewers' agreement. The proposed evaluation remains in [evaluation.md](evaluation.md).
