/**
 * Worst-case cost reservation and billing reconciliation against OpenRouter.
 *
 * The registry catalog price is only a reservation input. The cost recorded
 * for a call comes from OpenRouter's generation record, then the response's
 * own `usage.cost`; when neither is available the call settles as unknown and
 * the ledger keeps the full hold.
 */

import type { ModelCost } from "@earendil-works/pi-ai";
import type { CostSource } from "./types.ts";

/** Bytes added to the request body before pricing it, for provider-side framing. */
export const PROMPT_MARGIN_BYTES = 16_000;

/** Multiplier covering route price differences and rounding. */
export const WORST_CASE_FACTOR = 2;

/** Delays before each generation lookup; they add up to roughly 30 s. */
export const SETTLEMENT_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000,
];

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
const LOOKUP_TIMEOUT_MS = 10_000;
const PER_MILLION = 1_000_000;

/** Prices in USD per million tokens. */
export interface ModelRates {
  promptUsdPerM: number;
  completionUsdPerM: number;
}

/** What one dispatched call is known to have cost, taken from the wire. */
export interface CallEvidence {
  /** False when no request left the process, so nothing can have been billed. */
  dispatched: boolean;
  httpStatus?: number;
  generationId?: string;
  /** `usage.cost` from the provider response body. */
  responseCostUsd?: number;
}

/** The settled cost of a call; `null` is an unknown cost. */
export interface Settlement {
  costUsd: number | null;
  costSource: CostSource;
}

/** Aggregate key usage in USD, `null` where OpenRouter reports none. */
export interface KeyUsage {
  usage: number | null;
  usageDaily: number | null;
  limit: number | null;
  limitRemaining: number | null;
}

export interface Billing {
  /** Resolves the cost of a call; never throws. */
  settle(evidence: CallEvidence, signal?: AbortSignal): Promise<Settlement>;
  /** Reads aggregate usage for the API key; throws without exposing credentials. */
  keyUsage(signal?: AbortSignal): Promise<KeyUsage>;
}

export interface BillingOptions {
  /** Resolves the OpenRouter key at call time; the key is never stored or logged. */
  getApiKey: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  delaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function checkedRate(value: number, name: string): number {
  if (!isUsd(value))
    throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

/**
 * Highest prompt and completion price across the base rate and every context
 * tier; cache writes count as prompt tokens because they bill above input.
 */
export function ratesOf(cost: ModelCost): ModelRates {
  const rows = [cost, ...(cost.tiers ?? [])];
  return {
    promptUsdPerM: checkedRate(
      Math.max(...rows.flatMap((row) => [row.input, row.cacheWrite])),
      "prompt price",
    ),
    completionUsdPerM: checkedRate(
      Math.max(...rows.map((row) => row.output)),
      "completion price",
    ),
  };
}

/**
 * Reservation for one call: every request byte counts as a prompt token, the
 * full output allowance is billed, and the sum is doubled.
 */
export function worstCaseUsd(
  bodyBytes: number,
  maxOutputTokens: number,
  rates: ModelRates,
): number {
  const prompt =
    ((bodyBytes + PROMPT_MARGIN_BYTES) * rates.promptUsdPerM) / PER_MILLION;
  const completion = (maxOutputTokens * rates.completionUsdPerM) / PER_MILLION;
  return WORST_CASE_FACTOR * (prompt + completion);
}

const abortError = () => new Error("aborted");

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const RETRYABLE_STATUSES = new Set([404, 408, 425, 429]);

/** Creates a billing client for OpenRouter's generation and key endpoints. */
export function createBilling(options: BillingOptions): Billing {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? OPENROUTER_API_URL).replace(/\/+$/u, "");
  const delays = options.delaysMs ?? SETTLEMENT_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  async function get(
    path: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    return request(`${baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  async function lookupGeneration(
    generationId: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const apiKey = await options.getApiKey();
    if (!apiKey) return undefined;
    const path = `/generation?id=${encodeURIComponent(generationId)}`;
    for (const delay of delays) {
      try {
        await sleep(delay, signal);
        const response = await get(path, apiKey, signal);
        if (response.ok) {
          const body: unknown = await response.json();
          const cost =
            isRecord(body) && isRecord(body.data) && body.data.total_cost;
          if (isUsd(cost)) return cost;
        } else if (
          !RETRYABLE_STATUSES.has(response.status) &&
          response.status < 500
        ) {
          return undefined;
        }
      } catch {
        if (signal?.aborted) return undefined;
      }
    }
    return undefined;
  }

  return {
    async settle(evidence, signal) {
      if (!evidence.dispatched) return { costUsd: 0, costSource: "local" };
      if (evidence.generationId !== undefined) {
        const cost = await lookupGeneration(evidence.generationId, signal);
        if (cost !== undefined)
          return { costUsd: cost, costSource: "generation" };
      }
      if (evidence.responseCostUsd !== undefined) {
        return { costUsd: evidence.responseCostUsd, costSource: "response" };
      }
      const rejected =
        evidence.httpStatus !== undefined &&
        evidence.httpStatus >= 400 &&
        evidence.httpStatus < 500;
      return rejected
        ? { costUsd: 0, costSource: "local" }
        : { costUsd: null, costSource: "unknown" };
    },

    async keyUsage(signal) {
      const apiKey = await options.getApiKey();
      if (!apiKey) throw new Error("no OpenRouter API key is configured");
      const response = await get("/key", apiKey, signal);
      if (!response.ok) {
        throw new Error(`OpenRouter /key returned HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      const data = isRecord(body) && isRecord(body.data) ? body.data : {};
      const number = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        usage: number(data.usage),
        usageDaily: number(data.usage_daily),
        limit: number(data.limit),
        limitRemaining: number(data.limit_remaining),
      };
    },
  };
}
