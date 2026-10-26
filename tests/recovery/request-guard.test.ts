/** Extension request guard tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { estimateRawRequestTokens } from "../../src/core/context-tokens.ts";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import {
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
} from "../../src/core/legacy-rewind.ts";
import { ANCHOR_MANDATE, estimateAdmissionTokens } from "../../src/core/request-accounting.ts";
import { REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { __testHooks } from "../../src/index.ts";
import { fireContext, fireTurnEndAll } from "../support/boundary-drivers.ts";
import { setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { SUMMARY_TEXT } from "../support/model-registry.ts";
import { rewindFixture } from "../support/rewind-fixtures.ts";
import {
	appendToolResult,
	appendTurn,
	assistantMessage,
	usageOf,
} from "../support/session-messages.ts";

function at<T>(xs: readonly T[], index: number): T {
	const value = xs[index];
	assert.ok(value !== undefined, `Expected an element at index ${index}`);
	return value;
}

installHarnessHooks();

/**
 * pi-ai's own `estimateContextTokens` (#101). The package root does not export
 * it and the exports map blocks subpaths, so resolve the file beside the entry.
 */
async function piAiEstimateContextTokens(messages: unknown[]) {
	const entry = import.meta.resolve("@earendil-works/pi-ai");
	const { estimateContextTokens } = await import(new URL("./utils/estimate.js", entry).href);
	return estimateContextTokens(messages) as {
		tokens: number;
		usageTokens: number;
		trailingTokens: number;
		lastUsageIndex: number | null;
	};
}

describe("context event handler", () => {
	it("prices estimated context at the token ratio the model reported for its last request", async () => {
		const f = setup({ contextWindow: 400_000 });
		const model = f.ctx.model as { provider: string; id: string };
		const send = async () => {
			const request = [
				{ role: "system", content: "rules", timestamp: 0 },
				...fireContext(f.pi, f.ctx),
			];
			for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
				await handler({ type: "context_with_system", messages: request } as never, f.ctx as never);
			return estimateRawRequestTokens(request as never);
		};
		const growth = () => {
			const before = estimateAdmissionTokens(f.sm);
			f.sm.appendMessage({
				role: "user",
				content: "{".repeat(40_000),
				timestamp: 1,
			});
			return estimateAdmissionTokens(f.sm) - before;
		};
		f.sm.appendMessage({
			role: "user",
			content: "x".repeat(240_000),
			timestamp: 1,
		});
		const uncalibrated = growth();
		assert.ok(Math.abs(uncalibrated - (10_000 * 8) / 7) < 50, `${uncalibrated}`);

		// The tokenizer reports 1.6x Pi's four-chars-per-token heuristic.
		const raw = await send();
		const reply = {
			...assistantMessage([{ type: "text", text: "ok" }], "stop"),
			provider: model.provider,
			model: model.id,
			usage: usageOf(Math.round(raw * 1.6)),
		};
		f.sm.appendMessage(reply as never);
		await fireTurnEndAll(f.pi, f.ctx, reply);
		const calibrated = growth();
		assert.ok(Math.abs(calibrated - 16_000) < 50, `${calibrated}`);

		// Another model's tokenizer starts over at the default.
		f.ctx.model = { ...f.ctx.model, id: "other-model" } as never;
		await send();
		const switched = growth();
		assert.ok(Math.abs(switched - (10_000 * 8) / 7) < 50, `${switched}`);
	});

	it("learns the token ratio from a small request the operating window could not hold", async () => {
		const f = setup({ contextWindow: 32_000 });
		const model = f.ctx.model as { provider: string; id: string };
		const exchange = async (reportedRatio: number) => {
			const request = [
				{ role: "system", content: "rules", timestamp: 0 },
				...fireContext(f.pi, f.ctx),
			];
			for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
				await handler({ type: "context_with_system", messages: request } as never, f.ctx as never);
			const reply = {
				...assistantMessage([{ type: "text", text: "ok" }], "toolUse"),
				provider: model.provider,
				model: model.id,
				usage: usageOf(Math.round(estimateRawRequestTokens(request as never) * reportedRatio)),
			};
			f.sm.appendMessage(reply as never);
			await fireTurnEndAll(f.pi, f.ctx, reply);
		};
		const growth = () => {
			const before = estimateAdmissionTokens(f.sm);
			f.sm.appendMessage({
				role: "user",
				content: "x".repeat(4_000),
				timestamp: 1,
			});
			return estimateAdmissionTokens(f.sm) - before;
		};
		// Dense text: ~10k heuristic tokens that the tokenizer counts 2.5x higher.
		f.sm.appendMessage({
			role: "user",
			content: "x".repeat(40_000),
			timestamp: 1,
		});
		await exchange(2.5);
		// 25k fits the 32k window: below 50k heuristic tokens it is not evidence.
		assert.ok(Math.abs(growth() - (1_000 * 8) / 7) < 20);
		// Dense text the tokenizer counts 7x: the window could not hold it.
		await exchange(7);
		assert.ok(Math.abs(growth() - 7_000) < 20, "overflow evidence calibrates");
	});

	it("registers exactly one context handler via pi.on", () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("context");
		assert.ok(handlers, "factory must register a context handler");
		assert.equal(handlers.length, 1);
	});

	it("buildContextMessages projects the active branch (leaf-relative, no args)", () => {
		// The deleted wrapper rebuilt messages from buildSessionContext() every
		// turn; the context handler must produce the same projection from the
		// PUBLIC ReadonlySessionManager surface (buildContextEntries is exposed,
		// buildSessionContext is not). Pin the projection equals the session
		// context's messages on a plain chain.
		const { sm } = setup();
		appendTurn(sm, "u1", "a1", 100);
		appendTurn(sm, "u2", "a2", 200);
		const projected = __testHooks.buildContextMessages(sm);
		assert.deepEqual(
			projected,
			sm.buildSessionContext().messages.filter((message) => message.role !== "system"),
		);
	});

	it("buildContextMessages is conversation-only (Pi re-attaches the head)", () => {
		// `context` handlers transform conversation messages only; the runner
		// filters system state out before the handler and re-attaches the current
		// head afterwards. Returning a projection that still carries the
		// persisted system entry would duplicate the head whenever
		// `forceSystemPrompt` is unset.
		const { sm } = setup();
		sm.appendMessage({ role: "system", content: "PERSISTED HEAD" } as never);
		appendTurn(sm, "u1", "a1", 100);
		const projected = __testHooks.buildContextMessages(sm);
		assert.ok(
			projected.every((message) => message.role !== "system"),
			"the context payload must not carry system messages",
		);
		assert.ok(
			sm.buildSessionContext().messages.some((m) => m.role === "system"),
			"the raw session context still contains the persisted system entry",
		);
	});

	it("buildContextMessages applies context_edit omissions (projection beats raw entries)", () => {
		const { sm } = setup();
		const t1 = appendTurn(sm, "u1", "a1", 100);
		appendTurn(sm, "u2", "a2", 200);
		// pi's overflow recovery and the fallback provider omit failed attempts
		// with a null-replacement context_edit. The wire projection must drop
		// the message; the raw buildContextEntries walk would reintroduce it.
		sm.appendContextEdit(t1.assistantId, null);
		const projected = __testHooks.buildContextMessages(sm);
		assert.ok(
			!projected.some((message) => JSON.stringify(message).includes("a1")),
			"the omitted assistant must not be reintroduced",
		);
		assert.ok(
			sm.buildContextEntries().some((entry) => entry.id === t1.assistantId),
			"the raw entry walk still contains the omitted entry",
		);
		assert.equal(projected.length, sm.buildSessionContext().messages.length);
	});

	it("projects active-branch legacy rewind failures and aborts without mutating results", () => {
		const { sm } = setup();
		const resultId = appendToolResult(sm, "legacy-rewind-call", TOOL_NAME, "Rewind accepted.");
		const failure = "Summarization failed: the branch could not be written.";
		sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
			status: "failed",
			toolResultEntryId: resultId,
			text: failure,
		});
		const abortedResultId = appendToolResult(
			sm,
			"legacy-aborted-rewind-call",
			TOOL_NAME,
			"Rewind accepted.",
		);
		const aborted = "The historical rewind was aborted.";
		sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
			status: "aborted",
			toolResultEntryId: abortedResultId,
			text: aborted,
		});
		sm.appendCustomMessageEntry(
			LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
			"Historical summary instruction must remain hidden.",
			true,
		);

		const original = sm.getEntry(resultId);
		const originalAborted = sm.getEntry(abortedResultId);
		assert.ok(original?.type === "message");
		assert.ok(originalAborted?.type === "message");
		const originalMessage = structuredClone(original.message);
		const originalAbortedMessage = structuredClone(originalAborted.message);
		assert.equal(original.message.role, "toolResult");
		assert.equal(original.message.isError, false);
		assert.equal(originalAborted.message.role, "toolResult");
		assert.equal(originalAborted.message.isError, false);

		const projected = __testHooks.buildContextMessages(sm);
		const results = projected.filter((message) => message.role === "toolResult");
		assert.deepEqual(
			results.map((message) => ({
				isError: message.isError,
				content: message.content,
			})),
			[
				{ isError: true, content: [{ type: "text", text: failure }] },
				{ isError: true, content: [{ type: "text", text: aborted }] },
			],
		);
		assert.ok(
			!JSON.stringify(projected).includes("Historical summary instruction"),
			"legacy summary requests remain hidden from model context",
		);
		assert.deepEqual(original.message, originalMessage);
		assert.deepEqual(originalAborted.message, originalAbortedMessage);
	});

	it("ignores legacy rewind outcomes on an abandoned branch", () => {
		const { sm } = setup();
		const resultId = appendToolResult(sm, "legacy-rewind-call", TOOL_NAME, "Rewind accepted.");
		const outcomeId = sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
			status: "failed",
			toolResultEntryId: resultId,
			text: "failure from an abandoned attempt",
		});
		sm.branch(resultId);
		assert.ok(!sm.getBranch().some((entry) => entry.id === outcomeId));

		const projected = __testHooks.buildContextMessages(sm);
		const result = projected.find((message) => message.role === "toolResult");
		assert.ok(result);
		assert.equal(result.isError, false);
		assert.deepEqual(result.content, [{ type: "text", text: "Rewind accepted." }]);
	});

	it("withheld results zero the usage of the assistants after them (#101)", async () => {
		// pi's output clamp sizes max_tokens from the last assistant usage. That
		// usage still counts the withheld result, so the clamp saw no room and
		// capped the reply at 1 token (a false overflow). The assistant before
		// the result counted only earlier content, so its usage stays exact.
		const { sm } = setup();
		const at = Date.now();
		const model = {
			api: "anthropic",
			provider: "claude",
			model: "claude-sonnet-4-5",
		};
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
			...model,
			stopReason: "toolUse",
			timestamp: at,
			usage: usageOf(10),
		} as never);
		const resultId = sm.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "next" }],
			...model,
			stopReason: "endTurn",
			timestamp: at,
			usage: usageOf(90_000),
		} as never);
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "go on" }],
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			...model,
			stopReason: "endTurn",
			timestamp: at,
			usage: usageOf(95_000),
		} as never);
		sm.appendContextEdit(resultId, {
			content: [{ type: "text", text: "[navigate_tree] Output withheld" }],
		} as never);

		const projected = __testHooks.buildContextMessages(sm);
		assert.deepEqual(
			projected.flatMap((m) => (m.role === "assistant" ? [m.usage.totalTokens] : [])),
			[10, 0, 0],
		);
		// pi-ai falls back to the exact usage before the edit, and the rest is
		// chars/3.5: the notice and two short messages, not the stale 95k.
		const estimate = await piAiEstimateContextTokens(projected);
		assert.equal(estimate.lastUsageIndex, 1);
		assert.equal(estimate.usageTokens, 10);
		assert.ok(
			estimate.trailingTokens < 1_000,
			`trailing estimate should be chars/3.5, got ${estimate.trailingTokens}`,
		);
		// The session's own objects are untouched (the clone is per request).
		assert.deepEqual(
			sm
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? [entry.message.usage.totalTokens]
						: [],
				),
			[10, 90_000, 95_000],
		);
	});

	it("an assistant produced after the edit keeps its exact usage (#101)", async () => {
		// The edit applied before this turn was sent, so its usage counts only the
		// edited context and is exact. Only the turn between target and edit is
		// stale.
		const { sm } = setup();
		const at = Date.now();
		const model = {
			api: "anthropic",
			provider: "claude",
			model: "claude-sonnet-4-5",
		};
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
			...model,
			stopReason: "toolUse",
			timestamp: at,
			usage: usageOf(10),
		} as never);
		const resultId = sm.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "next" }],
			...model,
			stopReason: "endTurn",
			timestamp: at,
			usage: usageOf(90_000),
		} as never);
		sm.appendContextEdit(resultId, {
			content: [{ type: "text", text: "[navigate_tree] Output withheld" }],
		} as never);
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "go on" }],
			timestamp: at,
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			...model,
			stopReason: "endTurn",
			timestamp: at,
			usage: usageOf(5_000),
		} as never);

		const projected = __testHooks.buildContextMessages(sm);
		assert.deepEqual(
			projected.flatMap((m) => (m.role === "assistant" ? [m.usage.totalTokens] : [])),
			[10, 0, 5_000],
		);
		// pi-ai anchors on the newest assistant, the one sent after the edit.
		const estimate = await piAiEstimateContextTokens(projected);
		assert.equal(estimate.lastUsageIndex, projected.length - 1);
		assert.equal(estimate.usageTokens, 5_000);
	});

	it("without context_edits the projection keeps every assistant's usage (#101)", () => {
		const { sm } = setup();
		appendTurn(sm, "u1", "a1", 100);
		appendTurn(sm, "u2", "a2", 90_000);
		const projected = __testHooks.buildContextMessages(sm);
		assert.deepEqual(
			projected,
			sm.buildSessionContext().messages.filter((message) => message.role !== "system"),
		);
		assert.deepEqual(
			projected.flatMap((m) => (m.role === "assistant" ? [m.usage.totalTokens] : [])),
			[100, 90_000],
		);
	});

	it("handler returns messages = tree projection on every call (no leaf-gating)", () => {
		// R7: every appendMessage advances the leaf, so a "leaf changed since
		// last turn" heuristic would fire on essentially every call. Always-
		// replace degenerates to exactly what the deleted wrapper did. Fire the
		// captured handler twice with no tree change in between — both must
		// return the same projection (no pass-through case exists to pin, but
		// this guards against a future conditional reintroducing gating).
		const { sm, pi } = setup();
		appendTurn(sm, "u1", "a1", 100);
		const handlers = pi.onCalls.get("context");
		assert.ok(handlers, "factory must register a context handler");
		const first = at(handlers, 0)(
			{ type: "context", messages: [] } as never,
			{ sessionManager: sm } as never,
		);
		const second = at(handlers, 0)(
			{ type: "context", messages: [] } as never,
			{ sessionManager: sm } as never,
		);
		assert.deepEqual(first, second);
		assert.deepEqual(
			(first as { messages: unknown[] }).messages,
			sm.buildSessionContext().messages,
		);
	});

	it("post-rewind: handler returns anchor chain + branch_summary + continuation, none of the abandoned segment", async () => {
		// The headline invariant (#80 shape): after the fold lands, the next LLM
		// call (the very next context event) must see the chain up to the
		// anchor, the branch_summary, and the continuation message — and none of
		// the collapsed turns, the rewind tool call or its result (all on the
		// abandoned branch).
		const f = await rewindFixture();
		assert.ok(f.done, "the rewind must deliver its continuation message");

		const handlers = f.pi.onCalls.get("context");
		assert.ok(handlers, "factory must register a context handler");
		const outcome = at(handlers, 0)(
			{ type: "context", messages: [] } as never,
			{ sessionManager: f.sm } as never,
		) as {
			messages: Array<{
				role: string;
				customType?: string;
				summary?: string;
				content?: unknown;
			}>;
		};
		const messages = outcome.messages;
		const json = JSON.stringify(messages);

		// Ends with branch_summary then the continuation.
		const last = at(messages, messages.length - 1);
		const prev = at(messages, messages.length - 2);
		assert.equal(prev.role, "custom");
		assert.equal(prev.customType, "navigate-tree-handoff");
		assert.equal(
			prev.content,
			`# Work handoff: end\n\n${SUMMARY_TEXT}`,
			"the projected summary is the stored text",
		);
		assert.equal(last.role, "custom");
		assert.equal(last.customType, REWIND_CUSTOM_TYPE);
		assert.equal(last.content, f.done.message.content);

		// Anchor turn retained; collapsed turns, the rewind call and its result
		// are gone.
		assert.ok(json.includes('"a1"'), "the anchor turn is retained");
		for (const gone of ['"a2"', '"a3"', '"a4"', "tc-rewind"]) {
			assert.ok(!json.includes(gone), `${gone} must be on the abandoned branch`);
		}
		assert.ok(
			!messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("## Goal")),
			"the summary text is not replayed as an assistant message",
		);
		assert.ok(
			!messages.some((m) => m.role === "toolResult"),
			"no tool_result survives on the rewound chain",
		);

		// idempotent: a second invocation with no tree change returns the same.
		const again = at(handlers, 0)(
			{ type: "context", messages: [] } as never,
			{ sessionManager: f.sm } as never,
		);
		assert.deepEqual(again, outcome);
	});
});

// =============================================================================
// before_agent_start anchor mandate (#31)
//
// The #29 `promptGuidelines` bullet landed mid-prompt (inside the Guidelines
// section) and did not move behavior. #31 moves the policy to a
// `before_agent_start` append, which lands at the very END of the system
// prompt (after <project_context> and skills), is re-applied on every prompt,
// and survives compaction. These pins cover registration, the append shape
// (with the approved mandate spelled as a literal), the active-tool gate,
// fail-open semantics, and byte-stability for prompt caching.
// =============================================================================

describe("before_agent_start anchor mandate", () => {
	it("registers exactly one before_agent_start handler via pi.on", () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("before_agent_start");
		assert.ok(handlers, "factory must register a before_agent_start handler");
		assert.equal(handlers.length, 1);
	});

	it("appends the approved mandate to the system prompt when the tool is active", async () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("before_agent_start");
		assert.ok(handlers, "factory must register a before_agent_start handler");
		const out = await at(handlers, 0)(
			{
				type: "before_agent_start",
				prompt: "do the thing",
				systemPrompt: "BASE",
				systemPromptOptions: {
					selectedTools: ["read", "bash", "navigate_tree"],
				},
			} as never,
			{} as never,
		);
		assert.deepEqual(out, {
			systemPrompt:
				"BASE\n\nnavigate_tree: gather all context, then anchor `context-gathered`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.",
		});
	});

	it("skips the append when the tool is verifiably absent from selectedTools", async () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("before_agent_start");
		assert.ok(handlers, "factory must register a before_agent_start handler");
		const out = await at(handlers, 0)(
			{
				type: "before_agent_start",
				prompt: "do the thing",
				systemPrompt: "BASE",
				systemPromptOptions: { selectedTools: ["read", "bash"] },
			} as never,
			{} as never,
		);
		assert.deepEqual(out, {});
	});

	it("fails open when selectedTools is undefined (mandate still appended)", async () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("before_agent_start");
		assert.ok(handlers, "factory must register a before_agent_start handler");
		const out = await at(handlers, 0)(
			{
				type: "before_agent_start",
				prompt: "do the thing",
				systemPrompt: "BASE",
				systemPromptOptions: {},
			} as never,
			{} as never,
		);
		assert.deepEqual(out, { systemPrompt: `BASE\n\n${ANCHOR_MANDATE}` });
	});

	it("is byte-stable across identical calls (prompt-caching contract)", async () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("before_agent_start");
		assert.ok(handlers, "factory must register a before_agent_start handler");
		const event = {
			type: "before_agent_start",
			prompt: "do the thing",
			systemPrompt: "BASE",
			systemPromptOptions: {
				selectedTools: ["read", "bash", "navigate_tree"],
			},
		} as never;
		const first = (await at(handlers, 0)(event, {} as never)) as {
			systemPrompt: string;
		};
		const second = (await at(handlers, 0)(event, {} as never)) as {
			systemPrompt: string;
		};
		assert.deepEqual(first, second);
		assert.equal(first.systemPrompt, second.systemPrompt);
	});
});

// =============================================================================
// Schema shape (Kiro compatibility)
// =============================================================================
