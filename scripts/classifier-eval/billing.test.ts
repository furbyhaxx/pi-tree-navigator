import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBilling,
  PROMPT_MARGIN_BYTES,
  ratesOf,
  worstCaseUsd,
} from "./billing.ts";

const KEY = "sk-or-test-key-0000000000";

interface Seen {
  url: string;
  authorization: string | undefined;
}

/** A fake OpenRouter that answers each request from `responses` in order. */
function fakeApi(responses: Array<() => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
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

function billingFor(fetch: typeof globalThis.fetch, delays = [1, 2, 4]) {
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
    const expected =
      2 * (((1_000 + PROMPT_MARGIN_BYTES) * 0.1) / 1e6 + (1_024 * 0.5) / 1e6);
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
    assert.deepEqual(
      ratesOf({ input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }),
      { promptUsdPerM: 0.042, completionUsdPerM: 0 },
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
    assert.equal(
      api.seen[0]?.url,
      "https://openrouter.ai/api/v1/generation?id=gen-dec-1",
    );
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

    const unknown = await billingFor(
      fakeApi([json(404, {})]).fetch,
    ).billing.settle({
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
    assert.deepEqual(
      await billing.settle({ dispatched: true, httpStatus: 429 }),
      local,
    );
    assert.deepEqual(await billing.settle({ dispatched: true }), {
      costUsd: null,
      costSource: "unknown",
    });
    assert.deepEqual(
      await billing.settle({ dispatched: true, httpStatus: 502 }),
      { costUsd: null, costSource: "unknown" },
    );
    assert.equal(api.seen.length, 0);
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
        error.message === "OpenRouter /key returned HTTP 401" &&
        !error.message.includes(KEY),
    );
  });
});
