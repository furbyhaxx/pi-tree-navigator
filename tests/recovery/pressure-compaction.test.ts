/** Extension pressure compaction tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { asFetch } from "../../scripts/fetch.ts";
import {
	fireAgentSettled,
	fireContext,
	fireToolCall,
	fireTurnEndAll,
} from "../support/boundary-drivers.ts";
import { cleanupConfigFixture } from "../support/config-fixtures.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import {
	BIG,
	errorOverflow,
	type Forced,
	forcedDrafts,
	forcedSetup,
	runErrorEnd,
	WINDOW,
} from "../support/pressure-fixtures.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	assistantMessage,
	usageOf,
} from "../support/session-messages.ts";

installHarnessHooks();

/** Ids hidden (last `context_edit` null) on the active branch. */
function hiddenIds(sm: SessionManager): Set<string> {
	const last = new Map<string, unknown>();
	for (const e of sm.getBranch()) {
		if (e.type === "context_edit") last.set(e.targetId, e.replacement);
	}
	return new Set([...last].filter(([, r]) => r === null).map(([id]) => id));
}

async function providerPayload(f: Forced, payload: unknown): Promise<unknown> {
	let current = payload;
	for (const handler of f.pi.onCalls.get("before_provider_request") ?? []) {
		current =
			(await handler(
				{ type: "before_provider_request", payload: current } as never,
				f.ctx as never,
			)) ?? current;
	}
	return current;
}

describe("rewind-driven compaction (#101)", () => {
	it("explicit error: independently folds at agent_before_settle without withholding results", async () => {
		const f = await forcedSetup();
		try {
			const archived = structuredClone(f.sm.getEntries());
			const err = errorOverflow(f.sm);
			const { turn, settle } = await runErrorEnd(f, err.message);
			assert.deepEqual(turn.entries, []);
			assert.equal(settle.continue, true);
			assert.equal(
				settle.entries.some((entry) => entry.type === "context_edit"),
				false,
			);
			const [done] = forcedDrafts(settle);
			assert.equal(done.details.status, "done");
			assert.ok(f.ctx.registryCalls.length > 0);
			assert.ok(f.sm.getBranch().some((entry) => entry.type === "branch_summary"));
			for (const entry of archived) assert.deepEqual(f.sm.getEntry(entry.id), entry);
			const wire = fireContext(f.pi, f.ctx);
			assert.ok(!wire.some((message) => message.stopReason === "error"));
			assert.ok(!JSON.stringify(wire).includes("Output withheld"));
			assert.equal(f.sm.getLabel(err.id), undefined);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("explicit error: recovers again when the recovered request still overflows, while each attempt shrinks", async () => {
		const f = await forcedSetup();
		try {
			const first = await runErrorEnd(f, errorOverflow(f.sm).message);
			assert.equal(first.settle.continue, true);
			assert.equal(forcedDrafts(first.settle)[0]?.details.status, "done");
			// The recovered request still overflows (an undercounting estimate):
			// the agent read more, and no reply generated in between.
			for (const id of ["r3", "r4"]) {
				appendToolCallAssistant(f.sm, [{ id, name: "read", arguments: { path: id } }], 0);
				appendToolResult(f.sm, id, "read", BIG);
			}
			const calls = f.ctx.registryCalls.length;
			const second = await runErrorEnd(f, errorOverflow(f.sm).message);
			assert.ok(f.ctx.registryCalls.length > calls, "the second recovery summarized again");
			assert.ok(
				!JSON.stringify(second.settle).includes("already attempted"),
				JSON.stringify(second.settle),
			);
			assert.equal(second.settle.continue, true, JSON.stringify(second.settle));
			// Nothing is left to reduce: the attempts stop with a receipt, no loop.
			const third = await runErrorEnd(f, errorOverflow(f.sm).message);
			assert.equal(third.settle.continue, false);
			assert.match(
				JSON.stringify(third.settle),
				/did not reduce context|recoveries for this request|did not help either/,
			);
			const fourth = await runErrorEnd(f, errorOverflow(f.sm).message);
			assert.equal(fourth.settle.continue, false);
			assert.match(
				JSON.stringify(fourth.settle),
				/did not reduce context|recoveries for this request/,
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	for (const change of ["model", "session"] as const) {
		it(`explicit recovery refuses a stale ${change} before committing`, async () => {
			const f = await forcedSetup();
			try {
				f.ctx.modelRegistry = fakeRegistry(() => {
					if (change === "model") {
						assert.ok(f.ctx.model);
						f.ctx.model = { ...f.ctx.model, id: "changed-model" };
					} else f.ctx.sessionManager = SessionManager.inMemory("/tmp/replaced-recovery-session");
					return reply(SUMMARY_TEXT);
				}).registry;
				const { settle } = await runErrorEnd(f, errorOverflow(f.sm).message);
				assert.equal(settle.continue, false);
				assert.equal(
					f.sm.getBranch().some((entry) => entry.type === "branch_summary"),
					false,
				);
				assert.equal(forcedDrafts(settle)[0].details.status, "failed");
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		});
	}

	it("squeezed length: recovered at turn_end, the reply and its failed calls hidden", async () => {
		const f = await forcedSetup();
		try {
			const message = {
				...assistantMessage(
					[{ type: "toolCall", id: "w1", name: "write", arguments: {} }],
					"length",
					0,
				),
				usage: { ...usageOf(99_000), output: 100 },
			};
			const id = f.sm.appendMessage(message as never);
			const failed = appendToolResult(f.sm, "w1", "write", "truncated");
			const turn = await fireTurnEndAll(f.pi, f.ctx, message, {
				turnIndex: 1,
			});
			assert.equal(turn.continue, true);
			const edits = turn.entries.filter((d) => d.type === "context_edit");
			assert.deepEqual(
				edits.map((d) => [d.targetId, d.replacement === null]),
				[],
			);
			const suppressed = f.sm
				.getEntries()
				.filter((entry) => entry.type === "context_edit" && entry.replacement === null)
				.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
			assert.deepEqual(suppressed, [id, failed]);
			const wire = JSON.stringify(fireContext(f.pi, f.ctx));
			assert.ok(!wire.includes("truncated"));
			assert.ok(!wire.includes('"w1"'));
			assert.equal(forcedDrafts(turn)[0].details.status, "done");
			assert.ok(f.ctx.registryCalls.length > 0);
			// Rewind-owned: no start anchor on the overflowed turn (X = 2).
			assert.equal(f.sm.getLabel(id), undefined);
			assert.equal(f.pi.sendMessageCalls.length, 0, "no hint");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	for (const stopReason of ["length", "stop"] as const) {
		for (const owner of ["extension", "native", "native-retry", "cancel"] as const) {
			it(`${stopReason} recovery stands down for ${owner} ownership`, async () => {
				const f = await forcedSetup({
					piSettings: { compaction: { enabled: owner === "native" } },
				});
				try {
					const aborter = new AbortController();
					const ctx = { ...f.ctx, signal: aborter.signal };
					if (owner === "cancel") aborter.abort();
					if (owner === "native-retry") {
						for (const handler of f.pi.onCalls.get("session_before_compact") ?? []) {
							await handler(
								{
									type: "session_before_compact",
									reason: "overflow",
									willRetry: true,
								} as never,
								ctx as never,
							);
						}
					}
					const message = {
						...assistantMessage([{ type: "text", text: "overflow evidence" }], stopReason, 0),
						usage: { ...usageOf(105_000), input: 105_000 },
					};
					f.sm.appendMessage(message as never);
					const before = structuredClone(f.sm.getEntries());
					const boundary = await fireTurnEndAll(f.pi, ctx, message, {
						continue: owner === "extension",
					});
					assert.equal(boundary.continue, owner === "extension");
					assert.deepEqual(boundary.entries, []);
					assert.deepEqual(f.sm.getEntries(), before);
					assert.equal(f.ctx.registryCalls.length, 0);
					assert.equal(f.pi.onCalls.has("tool_call"), false);
				} finally {
					cleanupConfigFixture(f.fixture);
				}
			});
		}
	}

	it("pi compaction on: the overflowed reply gets no start anchor (#101, D14)", async () => {
		// Pi compaction is on: rewind-driven compaction stands down, so the
		// overflowed turn is not rewind-owned. It must still not be anchored.
		const f = await forcedSetup({
			anchor: false,
			piSettings: { compaction: { enabled: true } },
		});
		try {
			const message = {
				...assistantMessage([{ type: "text", text: "done" }], "stop", 0),
				usage: { ...usageOf(105_000), input: 105_000 },
			};
			const id = f.sm.appendMessage(message as never);
			await fireTurnEndAll(f.pi, f.ctx, message, { turnIndex: 1 });
			assert.equal(f.sm.getLabel(id), undefined);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("silent stop overflow: preserves successful evidence and the pending input without withholding", async () => {
		const f = await forcedSetup();
		try {
			f.sm.appendMessage({
				role: "user",
				content: "protected".repeat(7_000),
				timestamp: 0,
			} as never);
			const message = {
				...assistantMessage([{ type: "text", text: "done" }], "stop", 0),
				usage: { ...usageOf(105_000), input: 105_000 },
			};
			const id = f.sm.appendMessage(message as never);
			const turn = await fireTurnEndAll(f.pi, f.ctx, message);
			assert.equal(turn.continue, true);
			const edits = turn.entries.filter((d) => d.type === "context_edit");
			assert.deepEqual(edits, []);
			assert.ok(!hiddenIds(f.sm).has(id));
			assert.equal(forcedDrafts(turn)[0].details.status, "done");
			const wire = fireContext(f.pi, f.ctx);
			assert.ok(JSON.stringify(wire).includes("protected"));
			assert.ok(JSON.stringify(wire).includes("done"));
			assert.ok(!JSON.stringify(wire).includes("Output withheld"));
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("does not trigger: another model, a non-overflow error, compaction on, another extension's continue", async () => {
		// Another model.
		{
			const f = await forcedSetup();
			try {
				const err = errorOverflow(f.sm, "other");
				const { settle } = await runErrorEnd(f, err.message);
				assert.deepEqual(settle.entries, []);
				assert.equal(fireToolCall(f.pi, f.ctx), undefined);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		// A rate limit is not an overflow.
		{
			const f = await forcedSetup();
			try {
				const message = {
					...assistantMessage([], "error", 0),
					errorMessage: "rate limit exceeded",
				};
				f.sm.appendMessage(message as never);
				const { settle } = await runErrorEnd(f, message);
				assert.deepEqual(settle.entries, []);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		// pi's compaction on (pi's default): pi owns the overflow.
		{
			const f = await forcedSetup({ piSettings: {} });
			try {
				const err = errorOverflow(f.sm);
				const { settle } = await runErrorEnd(f, err.message);
				assert.deepEqual(settle.entries, []);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		// Recovery is on even when proactive hints are disabled.
		{
			const f = await forcedSetup({ config: {} });
			try {
				const err = errorOverflow(f.sm);
				const { settle } = await runErrorEnd(f, err.message);
				assert.equal(settle.continue, true);
				assert.equal(forcedDrafts(settle)[0].details.status, "done");
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		// Another extension already continues (e.g. a fallback provider).
		{
			const f = await forcedSetup();
			try {
				const err = errorOverflow(f.sm);
				const { settle } = await runErrorEnd(f, err.message, true);
				assert.deepEqual(settle.entries, []);
				assert.equal(settle.continue, true);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("aborts an infeasible complete request before sending a one-token continuation", async () => {
		const f = await forcedSetup({ issuerTokens: 99_000, anchor: false });
		try {
			const aborter = new AbortController();
			const ctx = {
				...f.ctx,
				signal: aborter.signal,
				abort: () => aborter.abort(),
			};
			const messages = [
				{ role: "system", content: "rules", timestamp: 0 },
				...fireContext(f.pi, f.ctx),
			];
			const handlers = f.pi.onCalls.get("context_with_system") ?? [];
			assert.ok(handlers.length > 0);
			for (const handler of handlers) {
				await handler({ type: "context_with_system", messages } as never, ctx as never);
			}
			assert.equal(aborter.signal.aborted, true);
			const aborted = assistantMessage([], "aborted", 0);
			f.sm.appendMessage(aborted as never);
			const result = await fireTurnEndAll(f.pi, f.ctx, aborted, {
				commit: true,
			});
			assert.equal(result.continue, false);
			const failed = forcedDrafts(result).at(-1);
			assert.equal(failed?.details.reason, "insufficient request headroom");
			assert.ok(Number(failed?.details.inputEstimate) > WINDOW);
			assert.match(failed?.content ?? "", /No tool results were withheld/);
			assert.ok(
				!result.entries.some(
					(entry) => entry.type === "context_edit" && entry.replacement !== null,
				),
			);
			await fireAgentSettled(f.pi, f.ctx, true);
			assert.equal(f.pi.sendMessageCalls.length, 0, "the committed receipt is not duplicated");
			let requests = 0;
			const response = await streamSimple(
				{
					api: "openai-completions",
					provider: "offline",
					id: "budget-fixture",
					name: "Budget fixture",
					baseUrl: "https://offline.invalid/v1",
					reasoning: false,
					input: ["text"],
					contextWindow: WINDOW,
					maxTokens: 64_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
				normalizeContext({
					messages: [{ role: "user", content: "test", timestamp: 1 }],
				}),
				{
					apiKey: "offline-test-only",
					signal: aborter.signal,
					maxRetries: 0,
					fetch: asFetch(async () => {
						requests++;
						throw new Error("transport must not run");
					}),
				},
			).result();
			assert.equal(response.stopReason, "aborted");
			assert.equal(requests, 0);
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = asFetch(async () => {
					requests++;
					throw new Error("transport must not run");
				});
				await streamGoogle(
					{
						api: "google-generative-ai",
						provider: "google",
						id: "budget-fixture",
						name: "Budget fixture",
						baseUrl: "https://offline.invalid",
						reasoning: false,
						input: ["text"],
						contextWindow: WINDOW,
						maxTokens: 64_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					normalizeContext({
						messages: [{ role: "user", content: "test", timestamp: 1 }],
					}),
					{
						apiKey: "offline-test-only",
						signal: aborter.signal,
						maxRetries: 0,
						onPayload: (payload) => providerPayload(f, payload),
					},
				).result();
				assert.equal(requests, 0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});
});
