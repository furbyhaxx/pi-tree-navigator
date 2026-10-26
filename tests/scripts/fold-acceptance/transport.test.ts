/**
 * Fake local transport only. These tests do not verify real provider behavior.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCost } from "@earendil-works/pi-ai";
import { DECISION_MAX_OUTPUT_TOKENS } from "../../../scripts/classifier-eval/adapters.ts";
import {
	type Billing,
	createBilling,
	maxPriceOf,
	pricingFor,
	worstCaseUsd,
} from "../../../scripts/classifier-eval/billing.ts";
import { BudgetError, BudgetLedger } from "../../../scripts/classifier-eval/budget.ts";
import type { FetchFn } from "../../../scripts/fetch.ts";
import {
	type BudgetedTransport,
	createBudgetedTransport,
	type ModelPricingTable,
	type TransportRecord,
} from "../../../scripts/fold-acceptance/transport.ts";

const cost = (input: number, output: number): ModelCost => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
});

const TABLE: ModelPricingTable = {
	routes: {
		retrievedAt: "2026-10-23T00:00:00.000Z",
		source: ["transport.test.ts"],
		models: {
			"openai/gpt-test": {
				kind: "chat",
				promptUsdPerM: 0.5,
				completionUsdPerM: 0.8,
				contextTokens: 128_000,
			},
			"typesafe/jev-1.14": {
				kind: "decisions",
				promptUsdPerM: 0.042,
				completionUsdPerM: 0.5,
				contextTokens: 262_144,
			},
			"unpriced/zero": {
				kind: "chat",
				promptUsdPerM: 0,
				completionUsdPerM: 0,
				contextTokens: 8_192,
			},
		},
	},
	models: [
		{ id: "openai/gpt-test", kind: "chat", cost: cost(0.1, 0.2) },
		{ id: "typesafe/jev-1.14", kind: "decisions", cost: cost(0.04, 0.5) },
		{
			id: "unpriced/zero",
			kind: "chat",
			cost: cost(0, 0),
		},
	],
};

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MESSAGES_URL = "https://openrouter.ai/api/v1/messages?beta=true";
const DECISIONS_URL = "https://openrouter.ai/api/v1/systemone";
const JSON_HEADERS = { "content-type": "application/json" };
const HEADER_SECRET = "header-secret-value";

const chatModel = TABLE.models[0];
const decisionModel = TABLE.models[1];
if (!chatModel || !decisionModel) throw new Error("fixture models missing");

const chatRates = pricingFor(chatModel, TABLE.routes, "chat").rates;
const decisionRates = pricingFor(decisionModel, TABLE.routes, "decisions").rates;

const chatBody = (): string =>
	JSON.stringify({
		model: "openai/gpt-test",
		messages: [{ role: "user", content: "fold" }],
		max_completion_tokens: 128,
		stream: true,
		provider: {
			order: ["Keep"],
			max_price: { prompt: "100", completion: "100" },
		},
	});

const decisionBody = (): string =>
	JSON.stringify({
		model: "typesafe/jev-1.14",
		state: { message: "fold" },
		questions: {
			kind: {
				type: "choice",
				instructions: "Classify",
				criteria: { a: "b" },
			},
		},
	});

const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

function acceptanceBilling(): Billing {
	return createBilling({
		getApiKey: async () => "sk-or-test-key-0000000000",
		fetch: async () => new Response("{}", { status: 400 }),
		delaysMs: [1],
		sleep: async () => {},
	});
}

interface Seen {
	input: string | URL | Request;
	init: RequestInit | undefined;
	body: string | undefined;
}

interface Harness {
	ledger: BudgetLedger;
	transport: BudgetedTransport;
	calls: Seen[];
	records: TransportRecord[];
}

async function withTransport(
	limitUsd: number,
	fetch: FetchFn,
	use: (ctx: Harness) => Promise<void>,
	billing: Billing = acceptanceBilling(),
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "fold-transport-"));
	const ledger = BudgetLedger.open(join(dir, "budget.jsonl"), limitUsd);
	const calls: Seen[] = [];
	const records: TransportRecord[] = [];
	const wrapped: FetchFn = async (input, init) => {
		calls.push({
			input,
			init,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
		return fetch(input, init);
	};
	const transport = createBudgetedTransport({
		fetch: wrapped,
		ledger,
		models: TABLE,
		billing,
		record: (record) => {
			records.push(record);
		},
	});
	try {
		await use({ ledger, transport, calls, records });
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const post = (body: string, signal?: AbortSignal): RequestInit => ({
	method: "POST",
	body,
	headers: JSON_HEADERS,
	...(signal ? { signal } : {}),
});

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("budgeted fold transport", () => {
	it("does not fetch when the ledger cannot hold the reservation", async () => {
		await withTransport(
			0,
			async () => new Response("{}"),
			async ({ ledger, transport, calls }) => {
				await assert.rejects(
					() => transport.fetch(CHAT_URL, post(chatBody())),
					(error: unknown) => {
						assert.ok(error instanceof BudgetError);
						assert.equal(error.code, "cap_exceeded");
						return true;
					},
				);
				assert.equal(calls.length, 0);
				assert.equal(ledger.snapshot().heldUsd, 0);
				assert.equal(ledger.snapshot().spentUsd, 0);
			},
		);
	});

	it("gives the caller first bytes before the stream ends, then drain settles", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let closed = false;
		const encoder = new TextEncoder();
		const first = `data: ${JSON.stringify({
			id: "gen-stream-1",
			choices: [{ delta: { content: "Hi" } }],
		})}\n\n`;
		const rest = `data: ${JSON.stringify({
			id: "gen-stream-1",
			usage: { prompt_tokens: 4, completion_tokens: 1, cost: 0.00021 },
		})}\n\ndata: [DONE]\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(encoder.encode(first));
				await gate;
				controller.enqueue(encoder.encode(rest));
				controller.close();
				closed = true;
			},
		});
		await withTransport(
			25,
			async () =>
				new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			async ({ ledger, transport }) => {
				const response = await within(
					transport.fetch(CHAT_URL, post(chatBody())),
					1_000,
					"fetch blocked until stream end",
				);
				assert.equal(closed, false);
				const reader = response.body?.getReader();
				assert.ok(reader);
				const chunk = await within(reader.read(), 1_000, "first byte blocked");
				assert.equal(chunk.done, false);
				assert.ok(chunk.value && chunk.value.byteLength > 0);
				assert.equal(closed, false);
				assert.equal(ledger.snapshot().spentUsd, 0);
				assert.ok(ledger.snapshot().heldUsd > 0);
				let settled = false;
				const drained = transport.drain().then(() => {
					settled = true;
				});
				assert.equal(settled, false);
				release();
				await Promise.all([
					(async () => {
						while (!(await reader.read()).done) {
							// Drain the caller branch so tee backpressure cannot stall capture.
						}
					})(),
					drained,
				]);
				assert.equal(settled, true);
				assert.equal(ledger.snapshot().spentUsd, 0.00021);
				assert.equal(ledger.snapshot().heldUsd, 0);
			},
		);
	});

	it("reserves each retry and sidecall before that POST", async () => {
		const costs = [0.001, 0.002, 0.0004];
		const heldDuringFetch: number[] = [];
		let call = 0;
		let heldNow = (): number => 0;
		await withTransport(
			25,
			async () => {
				heldDuringFetch.push(heldNow());
				const costUsd = costs[call] ?? 0;
				call += 1;
				const id = costUsd === 0.0004 ? "gen-side-1" : `gen-retry-${costUsd}`;
				return jsonResponse(200, {
					id,
					usage: { cost: costUsd },
					...(costUsd === 0.0004 ? { answers: {} } : { choices: [] }),
				});
			},
			async ({ ledger, transport, calls, records }) => {
				heldNow = () => ledger.snapshot().heldUsd;
				await transport.fetch(CHAT_URL, post(chatBody()));
				await transport.fetch(CHAT_URL, post(chatBody()));
				await transport.fetch(DECISIONS_URL, post(decisionBody()));
				assert.equal(calls.length, 3);
				assert.equal(heldDuringFetch.length, 3);
				assert.ok(heldDuringFetch.every((held) => held > 0));
				await transport.drain();
				assert.equal(ledger.snapshot().spentUsd, 0.0034);
				assert.equal(ledger.snapshot().heldUsd, 0);
				assert.equal(records.length, 3);
				assert.equal(new Set(records.map((record) => record.reservationId)).size, 3);
				assert.deepEqual(
					records.map((record) => record.endpoint),
					["chat/completions", "chat/completions", "systemone"],
				);
				assert.deepEqual(
					records.map((record) => record.responseCostUsd),
					[0.001, 0.002, 0.0004],
				);
			},
		);
	});

	it("shapes a Request body, preserves its signal, and drops a stale content-length", async () => {
		const controller = new AbortController();
		await withTransport(
			25,
			async () => jsonResponse(200, { id: "gen-req-1", usage: { cost: 0.0001 } }),
			async ({ ledger, transport, calls }) => {
				const request = new Request(CHAT_URL, {
					method: "POST",
					body: chatBody(),
					headers: {
						...JSON_HEADERS,
						authorization: `Bearer ${HEADER_SECRET}`,
						"content-length": "99999",
					},
					signal: controller.signal,
				});
				await transport.fetch(request);
				const seen = calls[0];
				assert.ok(seen);
				assert.equal(seen.init?.signal, request.signal);
				controller.abort();
				assert.equal(seen.init?.signal?.aborted, true);
				assert.equal(new Headers(seen.init?.headers).get("content-length"), null);
				assert.equal(
					new Headers(seen.init?.headers).get("authorization"),
					`Bearer ${HEADER_SECRET}`,
				);
				const sent = JSON.parse(seen.body ?? "{}") as {
					model?: string;
					max_completion_tokens?: number;
					provider?: { order?: string[]; max_price?: unknown };
				};
				assert.equal(sent.model, "openai/gpt-test");
				assert.equal(sent.max_completion_tokens, 128);
				assert.deepEqual(sent.provider?.order, ["Keep"]);
				assert.deepEqual(sent.provider?.max_price, maxPriceOf(chatRates));
				assert.notEqual(seen.body, chatBody());
				assert.equal(
					ledger.snapshot().heldUsd,
					worstCaseUsd(Buffer.byteLength(seen.body ?? ""), 128, chatRates),
				);
				await transport.drain();
			},
		);
	});

	it("rejects unpriced, unknown and uncapped chat before dispatch", async () => {
		await withTransport(
			25,
			async () => new Response("{}"),
			async ({ ledger, transport, calls, records }) => {
				const bodies = [
					JSON.stringify({
						model: "unpriced/zero",
						messages: [{ role: "user", content: "x" }],
						max_completion_tokens: 16,
					}),
					JSON.stringify({
						model: "missing/model",
						messages: [{ role: "user", content: "x" }],
						max_completion_tokens: 16,
					}),
					JSON.stringify({
						model: "openai/gpt-test",
						messages: [{ role: "user", content: "x" }],
					}),
					`{"model":"openai/gpt-test","messages":[{"role":"user","content":"x"}],"max_completion_tokens":1e309}`,
				];
				for (const body of bodies) {
					await assert.rejects(
						() => transport.fetch(CHAT_URL, post(body)),
						/unpriced model|unknown model|finite output cap/u,
					);
				}
				await assert.rejects(
					() => transport.fetch("https://openrouter.ai/api/alpha/decisions", post(decisionBody())),
					/unsupported/u,
				);
				assert.equal(calls.length, 0);
				assert.equal(records.length, 0);
				assert.equal(ledger.snapshot().heldUsd, 0);
			},
		);
	});

	it("holds an aborted dispatch and an unknown response", async () => {
		const controller = new AbortController();
		await withTransport(
			25,
			async () => {
				throw Object.assign(new Error(`aborted Bearer ${HEADER_SECRET}`), {
					name: "AbortError",
				});
			},
			async ({ ledger, transport, calls, records }) => {
				await assert.rejects(
					() => transport.fetch(CHAT_URL, post(chatBody(), controller.signal)),
					(error: unknown) => {
						assert.ok(error instanceof Error);
						assert.equal(error.name, "AbortError");
						assert.equal(error.message.includes(HEADER_SECRET), false);
						assert.equal(error.message.includes("authorization"), false);
						return true;
					},
				);
				assert.equal(calls.length, 1);
				assert.equal(calls[0]?.init?.signal, controller.signal);
				await transport.drain();
				assert.ok(ledger.snapshot().heldUsd > 0);
				assert.equal(ledger.snapshot().spentUsd, 0);
				assert.equal(records[0]?.settlement.costUsd, null);
				assert.equal(records[0]?.error?.includes(HEADER_SECRET), false);
			},
		);

		await withTransport(
			25,
			async () => jsonResponse(200, { answers: { kind: { choice: "a" } } }),
			async ({ ledger, transport }) => {
				await transport.fetch(DECISIONS_URL, post(decisionBody()));
				const held = ledger.snapshot().heldUsd;
				await transport.drain();
				assert.equal(ledger.snapshot().heldUsd, held);
				assert.ok(held > 0);
				assert.equal(ledger.snapshot().spentUsd, 0);
			},
		);
	});

	it("does not release a 4xx response that carries a generation id", async () => {
		await withTransport(
			25,
			async () =>
				jsonResponse(400, {
					id: "gen-rejected-1",
					error: { message: "no" },
				}),
			async ({ ledger, transport, records }) => {
				await transport.fetch(CHAT_URL, post(chatBody()));
				const held = ledger.snapshot().heldUsd;
				await transport.drain();
				assert.equal(ledger.snapshot().spentUsd, 0);
				assert.equal(ledger.snapshot().heldUsd, held);
				assert.equal(records[0]?.generationId, "gen-rejected-1");
				assert.equal(records[0]?.httpStatus, 400);
				assert.equal(records[0]?.settlement.costUsd, null);
			},
		);

		const releasing: Billing = {
			async settle() {
				return { costUsd: 0, costSource: "local" };
			},
			async keyUsage() {
				throw new Error("unused");
			},
		};
		await withTransport(
			25,
			async () => jsonResponse(400, { id: "gen-rejected-2", error: { message: "no" } }),
			async ({ ledger, transport }) => {
				await transport.fetch(CHAT_URL, post(chatBody()));
				const held = ledger.snapshot().heldUsd;
				await transport.drain();
				assert.equal(ledger.snapshot().heldUsd, held);
				assert.equal(ledger.snapshot().spentUsd, 0);
			},
			releasing,
		);
	});

	it("records bodies and status, never request or response headers", async () => {
		await withTransport(
			25,
			async () =>
				jsonResponse(
					200,
					{ id: "gen-cap-1", usage: { cost: 0.0001 } },
					{ "x-provider-secret": HEADER_SECRET },
				),
			async ({ transport, calls, records }) => {
				const response = await transport.fetch(CHAT_URL, {
					method: "POST",
					body: chatBody(),
					headers: {
						...JSON_HEADERS,
						authorization: `Bearer ${HEADER_SECRET}`,
					},
				});
				assert.equal(response.headers.get("x-provider-secret"), HEADER_SECRET);
				assert.equal(
					new Headers(calls[0]?.init?.headers).get("authorization"),
					`Bearer ${HEADER_SECRET}`,
				);
				await transport.drain();
				const recorded = JSON.stringify(records);
				assert.equal(recorded.includes(HEADER_SECRET), false);
				assert.equal(recorded.includes("authorization"), false);
				assert.equal(recorded.includes("x-provider-secret"), false);
				assert.equal(records[0]?.httpStatus, 200);
				assert.equal(records[0]?.responseBody?.includes("gen-cap-1"), true);
				assert.equal(records[0]?.requestBody.includes("authorization"), false);
				assert.equal(records[0]?.generationId, "gen-cap-1");
				assert.equal(records[0]?.responseCostUsd, 0.0001);
			},
		);
	});

	it("passes OpenRouter GET metadata through untouched", async () => {
		const init = {
			method: "GET",
			headers: { authorization: `Bearer ${HEADER_SECRET}` },
		};
		await withTransport(
			25,
			async (input, seenInit) => {
				assert.equal(input, "https://openrouter.ai/api/v1/models/user");
				assert.equal(seenInit, init);
				return new Response("[]", { status: 200 });
			},
			async ({ ledger, transport, calls }) => {
				const response = await transport.fetch("https://openrouter.ai/api/v1/models/user", init);
				assert.equal(response.status, 200);
				assert.equal(calls.length, 1);
				assert.equal(calls[0]?.input, "https://openrouter.ai/api/v1/models/user");
				assert.equal(calls[0]?.init, init);
				assert.equal(ledger.snapshot().heldUsd, 0);
			},
		);
	});

	it("clamps System One and Anthropic messages without changing the model or cap", async () => {
		let sent = "";
		await withTransport(
			25,
			async (_input, init) => {
				sent = typeof init?.body === "string" ? init.body : "";
				return jsonResponse(200, {
					id: "gen-dec-clamp",
					usage: { cost: 0.0001 },
					answers: {},
				});
			},
			async ({ ledger, transport }) => {
				await transport.fetch(DECISIONS_URL, post(decisionBody()));
				const parsed = JSON.parse(sent) as {
					model?: string;
					max_tokens?: unknown;
					provider?: { max_price?: unknown };
				};
				assert.equal(parsed.model, "typesafe/jev-1.14");
				assert.equal(parsed.max_tokens, undefined);
				assert.deepEqual(parsed.provider?.max_price, maxPriceOf(decisionRates));
				assert.equal(
					ledger.snapshot().heldUsd,
					worstCaseUsd(Buffer.byteLength(sent), DECISION_MAX_OUTPUT_TOKENS, decisionRates),
				);
				await transport.drain();
			},
		);

		await withTransport(
			25,
			async (_input, init) => {
				sent = typeof init?.body === "string" ? init.body : "";
				return jsonResponse(200, { id: "gen-msg-1", usage: { cost: 0.0002 } });
			},
			async ({ transport }) => {
				const body = JSON.stringify({
					model: "openai/gpt-test",
					messages: [{ role: "user", content: "fold" }],
					max_tokens: 64,
				});
				await transport.fetch(MESSAGES_URL, post(body));
				const parsed = JSON.parse(sent) as {
					model?: string;
					max_tokens?: number;
					provider?: { max_price?: unknown };
				};
				assert.equal(parsed.model, "openai/gpt-test");
				assert.equal(parsed.max_tokens, 64);
				assert.deepEqual(parsed.provider?.max_price, maxPriceOf(chatRates));
				await transport.drain();
			},
		);
	});

	it("rejects billable server tools and multiple completions before dispatch", async () => {
		await withTransport(
			25,
			async () => jsonResponse(200, {}),
			async ({ transport, calls, ledger }) => {
				const base = JSON.parse(chatBody()) as Record<string, unknown>;
				const extras = [
					{ n: 2 },
					{ best_of: 2 },
					{ tools: [{ type: "web_search" }] },
					{ web_search_options: {} },
					{ modalities: ["audio"] },
					{
						messages: [
							{
								role: "user",
								content: [
									{
										type: "image_url",
										image_url: { url: "https://example.invalid/image.png" },
									},
								],
							},
						],
					},
				];
				for (const extra of extras)
					await assert.rejects(() =>
						transport.fetch(CHAT_URL, post(JSON.stringify({ ...base, ...extra }))),
					);
				assert.equal(calls.length, 0);
				assert.equal(ledger.snapshot().heldUsd, 0);
			},
		);
	});

	it("surfaces an overspend even when settlement finishes before drain", async () => {
		await withTransport(
			25,
			async () => jsonResponse(200, { id: "gen-over-1", usage: { cost: 10 } }),
			async ({ transport, records }) => {
				const response = await transport.fetch(CHAT_URL, post(chatBody()));
				await response.text();
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(records.length, 1);
				await assert.rejects(transport.drain(), (error: unknown) => {
					assert.ok(error instanceof BudgetError);
					assert.equal(error.code, "bound_breach");
					return true;
				});
				assert.equal(records.length, 1);
				assert.equal(records[0]?.settlement.costUsd, 10);
			},
		);
	});

	it("does not retry a failed POST itself", async () => {
		await withTransport(
			25,
			async () => {
				throw new Error("network down");
			},
			async ({ transport, calls, ledger }) => {
				await assert.rejects(() => transport.fetch(CHAT_URL, post(chatBody())));
				assert.equal(calls.length, 1);
				await transport.drain();
				assert.ok(ledger.snapshot().heldUsd > 0);
				assert.equal(ledger.snapshot().spentUsd, 0);
			},
		);
	});
});
