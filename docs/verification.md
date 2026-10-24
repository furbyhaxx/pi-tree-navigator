# Verification

Verification follows the behavior changed. Unit tests establish deterministic contracts;
SDK-loop tests establish lifecycle integration; real-provider calls establish observed
transport and model behavior; terminal tests establish interactive behavior. None replaces
the others.

## Offline gates

From a dependency-installed checkout:

```sh
node_modules/.bin/tsc --noEmit
node_modules/.bin/biome check extensions/ scripts/
node --test extensions/navigate-tree/*.test.ts scripts/classifier-eval/*.test.ts scripts/fold-acceptance/*.test.ts
node scripts/pi-upstream-probe.mjs
```

The npm scripts also support `pnpm test`, `pnpm run lint` and `pnpm run typecheck` when
pnpm is available. Do not change the package version or changelog outside a release.
Run focused tests during implementation, then the combined gate before delivery.

Tests must protect behavior, not obsolete implementation details. Historical in-band
sessions remain readable, but new folds do not write a summary-request message, freeze
the main request, withhold results or require a rewind-only tool turn.

## Independent review

Use a reviewer who did not author the changes. Cover:

- Correctness: source preservation, request preservation, budgets, state transitions,
  failure and cancellation paths.
- Adversarial cases: stale snapshots, late messages, reused tool IDs, malformed policies,
  unavailable models, provider failures and partial persistence.
- Pi integration: signatures against locked packages and lifecycle behavior against
  installed SDK code, including real local-provider loop tests.

Reproduce findings before accepting them. Recheck affected findings after fixes; record
which commit was reviewed. A reviewer agreeing with a design is not runtime evidence.

## Independent fold contracts

- Manual, agent, automatic and recovery entrypoints use the same engine and commit
  preview. Manual folding makes side calls without asking the main agent to initiate it.
- A queued request runs after the current tool batch, including sibling and nested calls.
  The retired sole-tool-call and first-nested-call restrictions must not return.
- Strategy A reuses the effective system/tool messages and current projected context
  only when the complete summary request fits. Strategy B covers the selected evidence
  with bounded map/reduce calls; oversized records are split, not silently truncated.
- Record coverage, per-call output limits, reduction bounds, cancellation and total call
  limits are tested. A provider error must not create an unlimited fallback loop.
- Both strategies use current context edits while excluding input after the fold cut.
- The exact materialized handoff, full-mode child reports, continuity briefing, active
  user request, late input and continuation are included in the projected budget.
- Non-reducing or over-budget materialization refuses before branching. Pre-compaction
  targets are priced honestly rather than clamped to the newer compacted baseline.
- Still-open user requests survive even when the summarizer omits them. Tool calls and
  notifications do not count as final answers. Completed requests are not resurrected;
  preserved requests are not recursively duplicated in child handoffs.
- Stale branch/model/configuration state is rejected after asynchronous work. No
  incomplete tool envelopes or invented tool results are accepted. Native summaries
  discharge tool calls only through real completion evidence in their archived ancestry.
- A successful commit refreshes agent messages and emits the history-rewrite event.
  Persistence failures must distinguish precommit refusal from an already-written fold.

## Recovery through the real SDK loop

`preflight-recovery.test.ts` and `provider-recovery.test.ts` use the production extension
with a local provider, not a stand-in fold. Exercise:

1. A next request already over the operating budget: independent folding precedes main
   dispatch and the original unanswered request is replayed verbatim.
2. User/custom input separated from completed work by metadata and context edits.
3. Refusal of interleaved unresolved tool envelopes, absent anchors and impossible
   retained context, without dispatching the oversized request.
4. Provider context overflow, including a second failure after recovery; unrelated
   errors and intentional cancellation must not trigger recovery.
5. Esc during the side call: no new branch and no unwanted restart.
6. A later extension rejects a boundary draft: the failure receipt still appears once.
7. Native compaction/retry ownership prevents competing navigator recovery.

Preflight recovery awaits the engine in `context_with_system` and returns fresh messages.
An aborted/error turn does not honor ordinary `turn_end` continuation. Explicit provider
errors recover at `agent_before_settle`; do not reset private abort flags to force restart.
Local SDK tests prove this lifecycle, not real-provider cache reuse or tokenization.

## Budgeted live acceptance

Live calls require authorization and a shared spending ceiling. The acceptance transport
reserves a conservative request bound before dispatch, disables automatic retries, captures
safe request/response bodies and reconciles per-generation billed costs on OpenRouter. A
native subscription provider (the default `openai/gpt-6-luna`) records the cost the response
reports, or `0` with `costSource: "subscription"`, never a catalog estimate. Unknown costs
stay reserved. Account-level usage deltas can include unrelated sessions and are not run billing.
Never copy credentials or submit private sessions. Use synthetic fixtures in isolated agent
and workspace directories, and preserve unsuccessful runs.

The repository runner exercises production manual, preflight and agent-triggered flows:

```sh
node scripts/fold-acceptance/run.ts --scenario manual --dry-run --out /path/to/new-dry-run
node scripts/fold-acceptance/run.ts --scenario manual --out /path/to/new-manual-run --ledger /absolute/path/to/shared-budget-ledger.jsonl
node scripts/fold-acceptance/run.ts --scenario preflight --out /path/to/new-preflight-run --ledger /absolute/path/to/shared-budget-ledger.jsonl
node scripts/fold-acceptance/run.ts --scenario agent --out /path/to/new-agent-run --ledger /absolute/path/to/shared-budget-ledger.jsonl
```

Use a fresh output directory. `--model` takes a full Pi `provider/modelId` selector and
defaults to `openai/gpt-6-luna`; `openrouter/openai/gpt-6-luna` keeps the OpenRouter route.
A native provider is allowed exactly its own `${baseUrl}/responses` endpoint, and `--dry-run`
makes no provider calls or auth reads. `--window` controls the fixture operating window
without exceeding the catalog limit. `--blocks` controls the varied source corpus.
Authentication is referenced through `--auth-dir`, never copied. Pi's native `openai`
provider supports an API key or ChatGPT OAuth subscription; the runner uses Pi's runtime
auth resolution and only records subscription-zero costs when that subscription is configured.

For each real run, inspect the saved session and wire evidence:

- Actual provider/model identity, response statuses, summary call count and retry outcomes.
- The refused-window case really starts over budget and summarizes before main dispatch.
- Agent-triggered folding preserves and fulfills the still-open request without a driver
  follow-up prompt. A committed handoff alone is not acceptance.
- Subsequent main input is smaller, the handoff retains required facts and constraints,
  and its remaining work matches the request. Structural summary checks are not complete
  semantic verification.
- Report provider-observed input/cache tokens separately from projection estimates and
  cumulative traffic. Strategy A cache reuse is measured, not assumed; chunked Strategy B
  does not promise the main conversation's prefix cache hit.

Run `node scripts/summary-quality-check.mjs <session.jsonl> --all` for structural smoke.
The older `scripts/live-navigator-acceptance.mjs` and analyzer retain historical in-band
acceptance evidence; those captures do not prove independent-engine behavior.

Automatic acceptance must invoke the real configured milestone policy, preserve disclosure
filters, test an accepted latest boundary and a boundary before unfinished work, and confirm
that the controller invokes the engine without writing a rewind steer. Keep classifier
abstention visible rather than substituting a deterministic success in a live claim.

## Terminal acceptance

Load the extension under test explicitly in an isolated Pi-Bolt session. Exercise 60 and
130 columns, dark and light themes, fullscreen and regular mode. Capture both rendered
states and interactions:

- `/anchor fold` recommendation, alternate target, search, label/focus editing, confirmation,
  progress, cancellation and busy-agent queuing.
- Settings policy stage/model/instruction edits, invalid input, scope selection and cancel.
- Handoff and outcome expansion/collapse with Ctrl+O and fullscreen mouse interaction.
- Resize while a panel is open; stable geometry, clipped lines and keyboard-only operation.
- Footer/context change after a fold without another user prompt where continuation applies.

Stop disposable terminal sessions afterwards. Do not alter global configuration for tests;
if an authorized migration changes user configuration, back it up and preserve unrelated
keys, overrides and disclosure rules.

## Classifier evaluation

See `scripts/classifier-eval/` and `.project/analyses/classifier-eval/summary.md` for the
reproducible dataset, runner, analysis and retained evidence. Use the production request
builders. Select candidates on development data; label any selection made using holdout
results as such. Report case counts separately from repeated observations, and account for
correlated cases. Zero observed unsafe decisions does not establish a zero population rate.

Test classification and production application separately: protected user authority stays
in deterministic ledger rules; uncertain/failed retirement verification keeps the item.
Capture remains heuristics-only by default. Model policies and instruction overrides are
explicitly configurable, with disclosures before enabling external classification.

## Retrospective clone acceptance

Retrospective operations never mutate the source. Test source hashes, safe tool-batch cuts,
context edits, native summaries, parent modes, runtime state and descendant remapping. Reopen
created sessions with the real SessionManager; source bytes and accounting remain unchanged.
Drive proposal/review/preview/create/cancel in the terminal and verify no implicit session
switch. Model-created summaries remain untrusted semantic output even after graph validation.

## Delivery checklist

- Affected offline gates and integration tests passed, with actual output recorded.
- Required provider and TUI acceptance ran; limitations and failed evidence are retained.
- Independent review findings are fixed or explicitly resolved with evidence.
- Documentation matches the implemented behavior and commands.
- Only task-owned files are committed; credentials/private sessions remain excluded.
- Repository-authorized integration/push is complete. Installation and configuration
  migration are reported separately and performed only with authorization.
