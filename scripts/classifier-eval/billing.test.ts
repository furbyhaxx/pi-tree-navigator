import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FetchFn } from "../fetch.ts";
import {
	createBilling,
	loadRouteTable,
	MIN_RESERVATION_USD,
	maxPriceOf,
	mergeRouteTables,
	PROMPT_MARGIN_BYTES,
	parseRouteTable,
	pricingFor,
	ROUTE_PRICES_URL,
	ratesOf,
	worstCaseUsd,
} from "./billing.ts";

const TABLE = loadRouteTable(ROUTE_PRICES_URL);
const cost = (input: number, output = 0) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
});

const KEY = "sk-or-test-key-0000000000";

interface Seen {
	url: string;
	authorization: string | undefined;
}

/** A fake OpenRouter that answers each request from `responses` in order. */
function fakeApi(responses: Array<() => Response | Promise<Response>>) {
	const seen: Seen[] = [];
	const fetch: FetchFn = async (input, init) => {
		const headers = new Headers(init?.headers);
		seen.push({
			url: String(input),
			authorization: headers.get("authorization") ?? undefined,
		});
		const next = responses[Math.min(seen.length, responses.length) - 1];
		if (!next) throw new Error("no response scripted");
		return next();
	};
	return { fetch, seen };
}

const json = (status: number, body: unknown) => () =>
	new Response(JSON.stringify(body), { status });

function billingFor(fetch: FetchFn, delays = [1, 2, 4]) {
	const slept: number[] = [];
	const billing = createBilling({
		getApiKey: async () => KEY,
		fetch,
		delaysMs: delays,
		sleep: async (ms) => {
			slept.push(ms);
		},
	});
	return { billing, slept };
}

describe("reservation", () => {
	it("doubles the full-body prompt cost plus the full output allowance", () => {
		const rates = { promptUsdPerM: 0.1, completionUsdPerM: 0.5 };
		const expected = 2 * (((1_000 + PROMPT_MARGIN_BYTES) * 0.1) / 1e6 + (1_024 * 0.5) / 1e6);
		assert.equal(worstCaseUsd(1_000, 1_024, rates), expected);
		assert.equal(PROMPT_MARGIN_BYTES, 16_000);
	});

	it("prices at the highest rate the catalog lists", () => {
		assert.deepEqual(
			ratesOf({
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				tiers: [
					{
						inputTokensAbove: 272_000,
						input: 0.2,
						output: 0.75,
						cacheRead: 0.02,
						cacheWrite: 0.25,
					},
				],
			}),
			{ promptUsdPerM: 0.25, completionUsdPerM: 0.75 },
		);
		assert.deepEqual(ratesOf({ input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }), {
			promptUsdPerM: 0.042,
			completionUsdPerM: 0,
		});
	});
});

describe("effective price", () => {
	it("lifts the catalog price to the highest known route, as for clef", () => {
		const clef = { id: "cloudflare/clef", cost: cost(0.042) };
		const pricing = pricingFor(clef, TABLE, "decisions");
		assert.deepEqual(pricing.rates, {
			promptUsdPerM: 0.24,
			completionUsdPerM: 0,
		});
		assert.equal(pricing.refusal, undefined);
		assert.deepEqual(maxPriceOf(pricing.rates), {
			prompt: "0.24",
			completion: "0",
		});
		const bytes = 3_000;
		const reserved = worstCaseUsd(bytes, 1_024, pricing.rates);
		assert.equal(reserved, 2 * (((bytes + PROMPT_MARGIN_BYTES) * 0.24) / 1e6));
		const atCatalog = worstCaseUsd(bytes, 1_024, ratesOf(clef.cost));
		assert.ok(reserved > 5.7 * atCatalog);
	});

	it("prices chat at the priority route, above the catalog", () => {
		const gemini = pricingFor(
			{ id: "google/gemini-2.5-flash-lite", cost: cost(0.1, 0.4) },
			TABLE,
			"chat",
		);
		assert.deepEqual(gemini.rates, {
			promptUsdPerM: 0.18,
			completionUsdPerM: 0.72,
		});
	});

	it("never lowers a rate below the catalog", () => {
		const lower = mergeRouteTables(TABLE, {
			retrievedAt: "2026-10-24",
			source: ["override.json"],
			models: {
				"typesafe/jev-1.14": {
					kind: "decisions",
					promptUsdPerM: 0.001,
					completionUsdPerM: 0,
					contextTokens: 1000,
				},
			},
		});
		const pricing = pricingFor({ id: "typesafe/jev-1.14", cost: cost(0.042) }, lower, "decisions");
		assert.equal(pricing.rates.promptUsdPerM, 0.042);
	});

	it("refuses zero, unknown and non-finite prices", () => {
		const refused = (
			model: { id: string; cost: ReturnType<typeof cost> },
			kind: "decisions" | "chat" = "decisions",
		) => pricingFor(model, TABLE, kind).refusal;
		assert.match(
			refused({ id: "respan/span-01-lite", cost: cost(0) }) ?? "",
			/no positive prompt price/u,
		);
		assert.match(refused({ id: "not/listed", cost: cost(0) }) ?? "", /route table none/u);
		assert.match(
			refused({ id: "not/listed:free", cost: cost(0) }) ?? "",
			/no positive prompt price/u,
		);
		assert.match(refused({ id: "x/y", cost: cost(Number.NaN) }) ?? "", /finite non-negative/u);
		assert.match(
			refused({ id: "x/y", cost: cost(0.1, 0) }, "chat") ?? "",
			/no positive completion price/u,
		);
		assert.equal(refused({ id: "x/y", cost: cost(0.1, 0) }), undefined);
	});

	it("allows zero only for a :free id verified in the route table", () => {
		const pricing = pricingFor(
			{ id: "inception/mercury-decide:free", cost: cost(0) },
			TABLE,
			"decisions",
		);
		assert.equal(pricing.free, true);
		assert.equal(pricing.refusal, undefined);
		assert.equal(worstCaseUsd(5_000, 1_024, pricing.rates), MIN_RESERVATION_USD);
		assert.ok(MIN_RESERVATION_USD > 0);
	});

	it("validates a route table and keeps the committed one tied to its research", () => {
		assert.throws(
			() =>
				parseRouteTable(
					{
						retrievedAt: "x",
						source: [],
						models: {
							a: {
								kind: "decisions",
								promptUsdPerM: -1,
								completionUsdPerM: 0,
								contextTokens: null,
							},
						},
					},
					"t",
				),
			/models\.a/u,
		);
		const csvRows = (name: string) => {
			const [header = "", ...rows] = readFileSync(
				new URL(`../../.project/research/classifier-evaluation/${name}`, import.meta.url),
				"utf8",
			)
				.trim()
				.split("\n");
			const columns = header.split(",");
			return rows.map((row) =>
				Object.fromEntries(
					row.split(",").map((cell, index) => [columns[index], cell.replaceAll('"', "")]),
				),
			);
		};
		const highest = new Map<string, { prompt: number; completion: number }>();
		for (const [file, id, prompt, completion] of [
			[
				"openrouter-decision-full-context-reserves.csv",
				"model_id",
				"prompt_usd_per_million",
				"completion_usd_per_million",
			],
			[
				"openrouter-chat-alternatives.csv",
				"model_id",
				"prompt_usd_per_million",
				"completion_usd_per_million",
			],
		] as const)
			for (const row of csvRows(file)) {
				if (row.provider_slug === "no_endpoint_row") continue;
				const known = highest.get(row[id] ?? "") ?? {
					prompt: 0,
					completion: 0,
				};
				highest.set(row[id] ?? "", {
					prompt: Math.max(known.prompt, Number(row[prompt])),
					completion: Math.max(known.completion, Number(row[completion])),
				});
			}
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(TABLE.models).map(([id, entry]) => [
					id,
					{ prompt: entry.promptUsdPerM, completion: entry.completionUsdPerM },
				]),
			),
			Object.fromEntries(highest),
		);
	});
});

describe("settlement", () => {
	it("retries a late generation record and settles its total_cost", async () => {
		const api = fakeApi([
			json(404, { error: { message: "not found" } }),
			json(404, { error: { message: "not found" } }),
			json(200, { data: { total_cost: 0.000123 } }),
		]);
		const { billing, slept } = billingFor(api.fetch);
		const settled = await billing.settle({
			dispatched: true,
			httpStatus: 200,
			generationId: "gen-dec-1",
			responseCostUsd: 0.5,
		});
		assert.deepEqual(settled, { costUsd: 0.000123, costSource: "generation" });
		assert.deepEqual(slept, [1, 2, 4]);
		assert.equal(api.seen.length, 3);
		assert.equal(api.seen[0]?.url, "https://openrouter.ai/api/v1/generation?id=gen-dec-1");
		assert.equal(api.seen[0]?.authorization, `Bearer ${KEY}`);
		assert.equal(JSON.stringify(settled).includes(KEY), false);
	});

	it("falls back to the response cost, then to an unknown cost", async () => {
		const missing = fakeApi([json(404, {})]);
		const withResponse = await billingFor(missing.fetch).billing.settle({
			dispatched: true,
			httpStatus: 200,
			generationId: "gen-1",
			responseCostUsd: 0.00002,
		});
		assert.deepEqual(withResponse, {
			costUsd: 0.00002,
			costSource: "response",
		});
		assert.equal(missing.seen.length, 3);

		const unknown = await billingFor(fakeApi([json(404, {})]).fetch).billing.settle({
			dispatched: true,
			httpStatus: 200,
			generationId: "gen-2",
		});
		assert.deepEqual(unknown, { costUsd: null, costSource: "unknown" });
	});

	it("does not retry a lookup the key may not make", async () => {
		const api = fakeApi([json(401, { error: { message: "no" } })]);
		const settled = await billingFor(api.fetch).billing.settle({
			dispatched: true,
			httpStatus: 200,
			generationId: "gen-3",
		});
		assert.equal(api.seen.length, 1);
		assert.equal(settled.costUsd, null);
	});

	it("charges nothing for an unsent or rejected request but holds a timeout", async () => {
		const api = fakeApi([]);
		const { billing } = billingFor(api.fetch);
		const local = { costUsd: 0, costSource: "local" };
		assert.deepEqual(await billing.settle({ dispatched: false }), local);
		assert.deepEqual(await billing.settle({ dispatched: true, httpStatus: 429 }), local);
		assert.deepEqual(await billing.settle({ dispatched: true }), {
			costUsd: null,
			costSource: "unknown",
		});
		assert.deepEqual(await billing.settle({ dispatched: true, httpStatus: 502 }), {
			costUsd: null,
			costSource: "unknown",
		});
		assert.equal(api.seen.length, 0);
	});

	it("holds a rejected request that was issued a generation id", async () => {
		const settled = await billingFor(fakeApi([json(404, {})]).fetch).billing.settle({
			dispatched: true,
			httpStatus: 402,
			generationId: "gen-5",
		});
		assert.deepEqual(settled, { costUsd: null, costSource: "unknown" });
	});

	it("stops waiting for a generation when aborted", async () => {
		const api = fakeApi([json(404, {})]);
		const controller = new AbortController();
		const billing = createBilling({
			getApiKey: async () => KEY,
			fetch: api.fetch,
			delaysMs: [1, 2],
			sleep: async () => {
				controller.abort();
				throw new Error("aborted");
			},
		});
		const settled = await billing.settle(
			{
				dispatched: true,
				httpStatus: 200,
				generationId: "gen-4",
				responseCostUsd: 0.1,
			},
			controller.signal,
		);
		assert.deepEqual(settled, { costUsd: 0.1, costSource: "response" });
		assert.equal(api.seen.length, 0);
	});
});

describe("key usage", () => {
	it("reads only numeric usage fields", async () => {
		const api = fakeApi([
			json(200, {
				data: {
					label: "sk-or-v1-abc...xyz",
					usage: 1.5,
					usage_daily: 0.25,
					limit: 25,
					limit_remaining: 23.5,
				},
			}),
		]);
		const usage = await billingFor(api.fetch).billing.keyUsage();
		assert.deepEqual(usage, {
			usage: 1.5,
			usageDaily: 0.25,
			limit: 25,
			limitRemaining: 23.5,
		});
		assert.equal(api.seen[0]?.url, "https://openrouter.ai/api/v1/key");
	});

	it("reports a failure without the key", async () => {
		const { billing } = billingFor(fakeApi([json(401, {})]).fetch);
		await assert.rejects(
			() => billing.keyUsage(),
			(error: Error) =>
				error.message === "OpenRouter /key returned HTTP 401" && !error.message.includes(KEY),
		);
	});
});
