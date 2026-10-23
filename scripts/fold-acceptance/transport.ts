/** Budgets OpenRouter POSTs before dispatch. Decisions are POST /api/v1/systemone. */

import { randomUUID } from "node:crypto";
import type { ModelCost } from "@earendil-works/pi-ai";
import {
  DECISION_MAX_OUTPUT_TOKENS,
  safeMessage,
} from "../classifier-eval/adapters.ts";
import {
  type Billing,
  type CallEvidence,
  type ModelRates,
  maxPriceOf,
  pricingFor,
  type RouteTable,
  type Settlement,
  worstCaseUsd,
} from "../classifier-eval/billing.ts";
import { BudgetError, type BudgetLedger } from "../classifier-eval/budget.ts";

/** OpenAI-compatible chat completions, including image calls on that route. */
export const OPENROUTER_CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions";

/** Anthropic messages. The Pi SDK posts `?beta=true` from `beta.messages`. */
export const OPENROUTER_MESSAGES_PATH = "/api/v1/messages";

/** TypeSafe System One on OpenRouter. This is the decisions path fold tests hit. */
export const OPENROUTER_DECISIONS_PATH = "/api/v1/systemone";

type FetchInput = string | URL | Request;

const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/u;

export type TransportEndpoint = "chat/completions" | "messages" | "systemone";

export interface PricedModel {
  readonly id: string;
  readonly kind: "chat" | "decisions";
  readonly cost: ModelCost;
}

/** Catalog costs plus the route-price table `pricingFor` reserves against. */
export interface ModelPricingTable {
  readonly routes: RouteTable;
  readonly models: readonly PricedModel[];
}

/** Body, status and parsed cost. Headers are never recorded. */
export interface TransportRecord {
  readonly reservationId: string;
  readonly endpoint: TransportEndpoint;
  readonly model: string;
  readonly requestBody: string;
  readonly httpStatus?: number;
  readonly responseBody?: string;
  readonly generationId?: string;
  readonly responseCostUsd?: number;
  readonly settlement: Settlement;
  readonly error?: string;
}

export interface BudgetedTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly ledger: BudgetLedger;
  readonly models: ModelPricingTable;
  readonly billing: Billing;
  readonly record: (record: TransportRecord) => void | Promise<void>;
}

export interface BudgetedTransport {
  readonly fetch: typeof globalThis.fetch;
  readonly drain: () => Promise<void>;
}

interface Shaped {
  readonly url: string;
  readonly init: RequestInit;
  readonly endpoint: TransportEndpoint;
  readonly model: string;
  readonly body: string;
  readonly signal: AbortSignal;
}

interface BodyRead {
  readonly text: string;
  readonly error?: unknown;
}

interface Observed {
  generationId?: string;
  responseCostUsd?: number;
}

interface Done {
  readonly error?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function fail(message: string): never {
  throw new Error(safeMessage(message));
}

function publicError(error: unknown): Error {
  if (error instanceof BudgetError) return error;
  const wrapped = new Error(safeMessage(error));
  if (error instanceof Error && error.name === "AbortError")
    wrapped.name = "AbortError";
  return wrapped;
}

function indexModels(
  table: ModelPricingTable,
): ReadonlyMap<string, PricedModel> {
  const models = new Map<string, PricedModel>();
  for (const model of table.models) {
    if (models.has(model.id)) fail(`duplicate model ${model.id}`);
    models.set(model.id, model);
  }
  return models;
}

function methodOf(input: FetchInput, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function rawUrl(input: FetchInput): string {
  if (input instanceof URL) return input.href;
  if (typeof input === "string") return input;
  return input.url;
}

function openRouterUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.port !== "" && url.port !== "443") return undefined;
  if (
    url.hostname !== "openrouter.ai" &&
    !url.hostname.endsWith(".openrouter.ai")
  )
    return undefined;
  return url;
}

function endpointOf(url: URL): TransportEndpoint | undefined {
  if (url.pathname === OPENROUTER_CHAT_COMPLETIONS_PATH && url.search === "")
    return "chat/completions";
  if (url.pathname === OPENROUTER_MESSAGES_PATH && messagesQuery(url))
    return "messages";
  if (url.pathname === OPENROUTER_DECISIONS_PATH && url.search === "")
    return "systemone";
  return undefined;
}

function messagesQuery(url: URL): boolean {
  if (url.search === "") return true;
  return url.searchParams.size === 1 && url.searchParams.get("beta") === "true";
}

function isMetadata(input: FetchInput, init?: RequestInit): boolean {
  const method = methodOf(input, init);
  if (method !== "GET" && method !== "HEAD") return false;
  const url = openRouterUrl(rawUrl(input));
  return url !== undefined;
}

function readCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function chatOutputCap(body: Record<string, unknown>): number {
  const present = (value: unknown) => value !== undefined && value !== null;
  const completion = present(body.max_completion_tokens)
    ? readCap(body.max_completion_tokens)
    : undefined;
  const legacy = present(body.max_tokens)
    ? readCap(body.max_tokens)
    : undefined;
  if (present(body.max_completion_tokens) && completion === undefined)
    fail("refused a chat request without a finite output cap");
  if (present(body.max_tokens) && legacy === undefined)
    fail("refused a chat request without a finite output cap");
  if (completion === undefined && legacy === undefined)
    fail("refused a chat request without a finite output cap");
  if (completion !== undefined && legacy !== undefined && completion !== legacy)
    fail("refused a chat request without a finite output cap");
  const cap = completion ?? legacy;
  if (cap === undefined)
    fail("refused a chat request without a finite output cap");
  return cap;
}

function shapeProvider(
  body: Record<string, unknown>,
  rates: ModelRates,
): Record<string, unknown> {
  if (body.provider !== undefined && !isRecord(body.provider))
    fail("refused an unsupported request");
  const provider = isRecord(body.provider) ? { ...body.provider } : {};
  return { ...body, provider: { ...provider, max_price: maxPriceOf(rates) } };
}

function shapeBody(
  endpoint: TransportEndpoint,
  text: string,
  models: ReadonlyMap<string, PricedModel>,
  routes: RouteTable,
): {
  body: string;
  model: string;
  maxOutputTokens: number;
  rates: ModelRates;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("refused an unsupported request");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.model !== "string" ||
    parsed.model === ""
  )
    fail("refused an unsupported request");
  if (
    parsed.models !== undefined ||
    parsed.route !== undefined ||
    parsed.plugins !== undefined
  )
    fail("refused an unsupported request");
  const kind = endpoint === "systemone" ? "decisions" : "chat";
  const entry = models.get(parsed.model);
  if (!entry) fail(`refused unknown model ${parsed.model}`);
  if (entry.kind !== kind)
    fail(`refused ${parsed.model} on a ${endpoint} endpoint`);
  const pricing = pricingFor(entry, routes, kind);
  if (pricing.refusal !== undefined)
    fail(`refused unpriced model ${parsed.model}: ${pricing.refusal}`);
  if (kind === "chat") {
    if (!Array.isArray(parsed.messages)) fail("refused an unsupported request");
    if (hasImageModality(parsed.modalities))
      fail("refused an unsupported request");
    const maxOutputTokens = chatOutputCap(parsed);
    const body = JSON.stringify(shapeProvider(parsed, pricing.rates));
    return { body, model: parsed.model, maxOutputTokens, rates: pricing.rates };
  }
  if (parsed.state === undefined || !isRecord(parsed.questions))
    fail("refused an unsupported request");
  const body = JSON.stringify(shapeProvider(parsed, pricing.rates));
  return {
    body,
    model: parsed.model,
    maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS,
    rates: pricing.rates,
  };
}

function hasImageModality(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => item === "image" || item === "image_url")
  );
}

function callerSignal(
  input: FetchInput,
  init: RequestInit | undefined,
): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  if (input instanceof Request) return input.signal;
  return undefined;
}

function outboundInit(
  request: Request,
  body: string,
  signal: AbortSignal,
): RequestInit {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return {
    method: "POST",
    headers,
    body,
    signal,
    redirect: request.redirect,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  };
}

function mergeObserved(into: Observed, value: unknown): void {
  if (!isRecord(value)) return;
  if (
    into.generationId === undefined &&
    typeof value.id === "string" &&
    GENERATION_ID.test(value.id)
  )
    into.generationId = value.id;
  if (isRecord(value.usage) && isUsd(value.usage.cost))
    into.responseCostUsd = value.usage.cost;
  if (isRecord(value.message)) mergeObserved(into, value.message);
}

function parseProviderBody(text: string): Observed {
  const observed: Observed = {};
  try {
    mergeObserved(observed, JSON.parse(text));
    return observed;
  } catch {
    // Event stream, or a body that never became JSON.
  }
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      mergeObserved(observed, JSON.parse(payload));
    } catch {
      // Keep-alive or a non-JSON data line.
    }
  }
  return observed;
}

function holdIfUnproven(
  evidence: CallEvidence,
  settlement: Settlement,
  incomplete: boolean,
): Settlement {
  const held: Settlement = { costUsd: null, costSource: "unknown" };
  if (incomplete && evidence.responseCostUsd === undefined) return held;
  const rejectedWithGeneration =
    evidence.generationId !== undefined &&
    evidence.httpStatus !== undefined &&
    evidence.httpStatus >= 400 &&
    evidence.httpStatus < 500;
  if (rejectedWithGeneration && settlement.costSource === "local") return held;
  return settlement;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<BodyRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(next.value);
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    return { text: Buffer.concat(chunks).toString("utf8"), error };
  }
}

function forward(
  response: Response,
  onBody: (read: BodyRead) => Promise<void>,
): { response: Response; task: Promise<void> } {
  if (response.body === null) {
    return { response, task: onBody({ text: "" }) };
  }
  const [caller, capture] = response.body.tee();
  return {
    response: new Response(caller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    task: readStream(capture).then(onBody),
  };
}

async function drainTasks(tasks: Set<Promise<Done>>): Promise<void> {
  const failures: unknown[] = [];
  while (tasks.size > 0) {
    const batch = [...tasks];
    const results = await Promise.all(batch);
    for (const result of results)
      if (result.error !== undefined) failures.push(result.error);
  }
  const breach = failures.find(
    (error): error is BudgetError =>
      error instanceof BudgetError && error.code === "bound_breach",
  );
  if (breach) throw breach;
  const first = failures[0];
  if (first !== undefined) throw first;
}

export function createBudgetedTransport(
  options: BudgetedTransportOptions,
): BudgetedTransport {
  const models = indexModels(options.models);
  const tasks = new Set<Promise<Done>>();
  const track = (task: Promise<void>): void => {
    const done = task.then(
      (): Done => ({}),
      (error: unknown): Done => ({ error }),
    );
    tasks.add(done);
    void done.finally(() => {
      tasks.delete(done);
    });
  };

  async function settle(
    shaped: Shaped,
    reservationId: string,
    response: { httpStatus?: number; text?: string; error?: unknown },
  ): Promise<void> {
    const parsed =
      response.text === undefined ? {} : parseProviderBody(response.text);
    const incomplete = response.error !== undefined;
    const evidence: CallEvidence = {
      dispatched: true,
      ...(response.httpStatus !== undefined && {
        httpStatus: response.httpStatus,
      }),
      ...(parsed.generationId !== undefined && {
        generationId: parsed.generationId,
      }),
      ...(parsed.responseCostUsd !== undefined && {
        responseCostUsd: parsed.responseCostUsd,
      }),
    };
    const settlement = holdIfUnproven(
      evidence,
      await options.billing.settle(evidence, shaped.signal),
      incomplete,
    );
    const record: TransportRecord = {
      reservationId,
      endpoint: shaped.endpoint,
      model: shaped.model,
      requestBody: shaped.body,
      ...(response.httpStatus !== undefined && {
        httpStatus: response.httpStatus,
      }),
      ...(response.text !== undefined && { responseBody: response.text }),
      ...(parsed.generationId !== undefined && {
        generationId: parsed.generationId,
      }),
      ...(parsed.responseCostUsd !== undefined && {
        responseCostUsd: parsed.responseCostUsd,
      }),
      settlement,
      ...(response.error !== undefined && {
        error: safeMessage(response.error),
      }),
    };
    let settleError: unknown;
    try {
      options.ledger.settle(reservationId, settlement.costUsd);
    } catch (error) {
      settleError = publicError(error);
    }
    let recordError: unknown;
    try {
      await options.record(record);
    } catch (error) {
      recordError = publicError(error);
    }
    if (
      settleError instanceof BudgetError &&
      settleError.code === "bound_breach"
    )
      throw settleError;
    if (settleError !== undefined) throw settleError;
    if (recordError !== undefined) throw recordError;
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (isMetadata(input, init)) return options.fetch(input, init);
    const signal = callerSignal(input, init);
    let request: Request;
    try {
      request = new Request(input, init);
    } catch (error) {
      throw publicError(error);
    }
    if (request.method !== "POST") fail("refused an unsupported request");
    if ((signal ?? request.signal).aborted)
      throw publicError(
        (signal ?? request.signal).reason ?? new Error("aborted"),
      );
    const url = openRouterUrl(request.url);
    if (!url) fail("refused an unsupported request");
    const endpoint = endpointOf(url);
    if (!endpoint) fail(`refused an unsupported request to ${url.pathname}`);
    let text: string;
    try {
      text = await request.text();
    } catch (error) {
      throw publicError(error);
    }
    if (text === "") fail("refused an unsupported request");
    const shapedBody = shapeBody(endpoint, text, models, options.models.routes);
    const body = shapedBody.body;
    const outboundSignal = signal ?? request.signal;
    const shaped: Shaped = {
      url: request.url,
      init: outboundInit(request, body, outboundSignal),
      endpoint,
      model: shapedBody.model,
      body,
      signal: outboundSignal,
    };
    const reservationId = randomUUID();
    try {
      options.ledger.reserve(
        reservationId,
        worstCaseUsd(
          Buffer.byteLength(body),
          shapedBody.maxOutputTokens,
          shapedBody.rates,
        ),
      );
    } catch (error) {
      throw publicError(error);
    }
    let response: Response;
    try {
      const dispatched = await options.fetch(shaped.url, shaped.init);
      if (!(dispatched instanceof Response))
        throw new Error("underlying fetch did not return a response");
      response = dispatched;
    } catch (error) {
      track(
        settle(shaped, reservationId, {
          error,
        }),
      );
      throw publicError(error);
    }
    try {
      const forwarded = forward(response, (read) =>
        settle(shaped, reservationId, {
          httpStatus: response.status,
          text: read.text,
          ...(read.error !== undefined && { error: read.error }),
        }),
      );
      track(forwarded.task);
      return forwarded.response;
    } catch (error) {
      track(
        settle(shaped, reservationId, {
          httpStatus: response.status,
          error,
        }),
      );
      throw publicError(error);
    }
  };

  return {
    fetch,
    drain: () => drainTasks(tasks),
  };
}
