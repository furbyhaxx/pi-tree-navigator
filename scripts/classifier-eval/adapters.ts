/**
 * Candidate adapters: each answers one prepared case and reports an
 * observation plus the transport evidence billing settles from.
 *
 * Requests go through the pi model registry with retries off. A recording
 * `fetch` sees only the request body and the response body, never headers, and
 * refuses any request larger than its reservation or any second request.
 */

import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { heuristicClassifier } from "../../src/continuity/continuity-capture.ts";
import { asFetch, type FetchFn } from "../fetch.ts";
import {
	type CallEvidence,
	maxPriceOf,
	PROMPT_MARGIN_BYTES,
	type Pricing,
	pricingFor,
	type RouteTable,
} from "./billing.ts";
import type { EvalAnswer, EvalObservation, PreparedCase } from "./types.ts";

/** Output tokens billed in the reservation of a decision call. */
export const DECISION_MAX_OUTPUT_TOKENS = 1_024;

/** Output cap sent with, and reserved for, a chat call. */
export const CHAT_MAX_OUTPUT_TOKENS = 1_024;

/** A request needs at least this many bytes per token, for the context check. */
const BYTES_PER_TOKEN_FLOOR = 2;
const CAPTURE_GRACE_MS = 5_000;
const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/u;

export type EvalRegistry = Pick<ModelRegistry, "classify" | "streamSimple">;

/** A model under test; every paid candidate is billed through OpenRouter. */
export type Candidate =
	| {
			adapter: "decisions";
			label: string;
			model: ClassifierModel<ClassifierApi>;
			pricing: Pricing;
			uncatalogued?: boolean;
	  }
	| { adapter: "chat"; label: string; model: Model<Api>; pricing: Pricing }
	| { adapter: "heuristic"; label: "heuristic" };

export const HEURISTIC: Candidate = {
	adapter: "heuristic",
	label: "heuristic",
};

function requireOpenRouter(provider: string): void {
	if (provider !== "openrouter")
		throw new Error(`only OpenRouter models are billed here, got ${provider}`);
}

export function decisionsCandidate(
	model: ClassifierModel<ClassifierApi>,
	table: RouteTable,
	uncatalogued = false,
): Candidate {
	requireOpenRouter(model.provider);
	return {
		adapter: "decisions",
		label: `decisions:${model.id}`,
		model,
		pricing: pricingFor(model, table, "decisions"),
		...(uncatalogued && { uncatalogued }),
	};
}

export function chatCandidate(model: Model<Api>, table: RouteTable): Candidate {
	requireOpenRouter(model.provider);
	return {
		adapter: "chat",
		label: `chat:${model.id}`,
		model,
		pricing: pricingFor(model, table, "chat"),
	};
}

export type RequestPlan =
	| { kind: "local" }
	| { kind: "unsupported"; reason: string }
	| { kind: "request"; bodyBytes: number; maxOutputTokens: number };

/** Observation fields known before billing settles the cost. */
export type DraftObservation = Omit<EvalObservation, "costUsd" | "costSource" | "costBoundUsd">;

export interface AdapterResult {
	observation: DraftObservation;
	evidence: CallEvidence;
}

export interface AnswerOptions {
	registry: EvalRegistry;
	/** Credential values to strip from recorded error text. */
	secrets?: readonly string[];
	repetition: number;
	timeoutMs: number;
	signal?: AbortSignal;
	fetch?: FetchFn;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const SECRET_PATTERNS = [/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, /sk-[A-Za-z0-9_-]{8,}/gu];

/** Error text for observations: bounded, with `secrets` and anything key-shaped removed. */
export function safeMessage(error: unknown, secrets: readonly string[] = []): string {
	let text = error instanceof Error ? error.message : String(error);
	for (const secret of secrets)
		if (secret.length >= 8) text = text.replaceAll(secret, "[redacted]");
	for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
	return text.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * Route price ceiling (USD per million tokens) sent with every request so a
 * pricier route cannot serve it. The decisions request schema takes `provider`
 * like chat does; not yet observed against the live endpoint.
 */
const providerOf = (pricing: Pricing) => ({
	max_price: maxPriceOf(pricing.rates),
});

function decisionBody(
	prepared: PreparedCase,
	model: ClassifierModel<ClassifierApi>,
	pricing: Pricing,
) {
	return JSON.stringify({
		model: model.id,
		state: prepared.context.state,
		questions: prepared.context.questions,
		provider: providerOf(pricing),
	});
}

const CHAT_SYSTEM_PROMPT =
	"You classify structured state. For every question, choose exactly one choice key from its list and judge only the state provided. " +
	'Reply with a single JSON object and nothing else, shaped {"answers": {"<question id>": {"choice": "<choice key>", "confidence": <number from 0 to 1, your probability that the choice is correct>}}}. Answer every question.';

function chatPrompt(prepared: PreparedCase): string {
	const questions = Object.entries(prepared.questions).map(
		([id, question]) =>
			`## ${id}\n${question.instructions}\nChoices:\n${Object.entries(question.choices)
				.map(([key, description]) => `- ${key}: ${description}`)
				.join("\n")}`,
	);
	return `State:\n${JSON.stringify(prepared.context.state)}\n\nQuestions:\n\n${questions.join("\n\n")}`;
}

/** Strict JSON schema of the chat answer; `choice` is limited to each question's keys. */
function answerSchema(questions: PreparedCase["questions"]) {
	return {
		type: "object",
		properties: {
			answers: {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(questions).map(([id, question]) => [
						id,
						{
							type: "object",
							properties: {
								choice: { type: "string", enum: Object.keys(question.choices) },
								confidence: { type: "number" },
							},
							required: ["choice", "confidence"],
							additionalProperties: false,
						},
					]),
				),
				required: Object.keys(questions),
				additionalProperties: false,
			},
		},
		required: ["answers"],
		additionalProperties: false,
	};
}

const supportsStructuredOutputs = (model: Model<Api>) => model.api === "openai-completions";

function chatRequest(prepared: PreparedCase, model: Model<Api>, pricing: Pricing) {
	const userPrompt = chatPrompt(prepared);
	const responseFormat = supportsStructuredOutputs(model)
		? {
				type: "json_schema",
				json_schema: {
					name: "classifier_answers",
					strict: true,
					schema: answerSchema(prepared.questions),
				},
			}
		: undefined;
	const bodyBytes = Buffer.byteLength(
		JSON.stringify({
			model: model.id,
			messages: [
				{ role: "system", content: CHAT_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			response_format: responseFormat,
			provider: providerOf(pricing),
		}),
	);
	return { userPrompt, responseFormat, bodyBytes };
}

/**
 * Decides, without any I/O, whether a candidate can answer a case and how
 * large its request is. The heuristic only judges intent messages; a request
 * that cannot fit the model context is unsupported rather than sent.
 */
export function planRequest(prepared: PreparedCase, candidate: Candidate): RequestPlan {
	if (candidate.adapter === "heuristic") {
		return prepared.input.type === "intent"
			? { kind: "local" }
			: {
					kind: "unsupported",
					reason: "the heuristic classifier only judges intent messages",
				};
	}
	if (candidate.pricing.refusal !== undefined)
		return {
			kind: "unsupported",
			reason: `refused before dispatch: ${candidate.pricing.refusal}`,
		};
	const decisions = candidate.adapter === "decisions";
	const bodyBytes = decisions
		? Buffer.byteLength(decisionBody(prepared, candidate.model, candidate.pricing))
		: chatRequest(prepared, candidate.model, candidate.pricing).bodyBytes;
	const maxOutputTokens = decisions ? DECISION_MAX_OUTPUT_TOKENS : CHAT_MAX_OUTPUT_TOKENS;
	const contextTokens =
		Math.ceil(bodyBytes / BYTES_PER_TOKEN_FLOOR) + (decisions ? 0 : maxOutputTokens);
	const window = candidate.model.contextWindow;
	return contextTokens > window
		? {
				kind: "unsupported",
				reason: `request needs about ${contextTokens} tokens; the model context is ${window}`,
			}
		: { kind: "request", bodyBytes, maxOutputTokens };
}

// ---------------------------------------------------------------------------
// Transport recording
// ---------------------------------------------------------------------------

interface Captured {
	generationId?: string;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
}

const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function mergeBody(into: Captured, body: unknown): void {
	if (!isRecord(body)) return;
	if (typeof body.id === "string" && GENERATION_ID.test(body.id) && into.generationId === undefined)
		into.generationId = body.id;
	if (!isRecord(body.usage)) return;
	const usage = body.usage;
	into.costUsd = count(usage.cost) ?? into.costUsd;
	into.inputTokens = count(usage.input_tokens) ?? count(usage.prompt_tokens) ?? into.inputTokens;
	into.outputTokens =
		count(usage.output_tokens) ?? count(usage.completion_tokens) ?? into.outputTokens;
}

/** Reads the generation id and billed usage from a JSON or event-stream body. */
export function parseResponseBody(text: string): Captured {
	const captured: Captured = {};
	try {
		mergeBody(captured, JSON.parse(text));
		return captured;
	} catch {
		// Not one JSON document: read it as server-sent events.
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			mergeBody(captured, JSON.parse(line.slice(5)));
		} catch {
			// A keep-alive comment or the [DONE] marker.
		}
	}
	return captured;
}

/**
 * Wraps `fetch` to measure the one request an answer may send. The request
 * must be a string body no larger than `maxBodyBytes`; nothing else about the
 * request, and no response header, is kept.
 */
export function createRecorder(base: FetchFn, maxBodyBytes: number) {
	let attempts = 0;
	let requestSha256: string | undefined;
	let httpStatus: number | undefined;
	let captured: Captured = {};
	let pending: Promise<void> = Promise.resolve();
	const recordingFetch: FetchFn = async (input, init) => {
		const body = init?.body;
		if (typeof body !== "string") throw new Error("refused an unmeasured request body");
		if (attempts > 0) throw new Error("refused a second request for one reservation");
		const bytes = Buffer.byteLength(body);
		if (bytes > maxBodyBytes)
			throw new Error(`refused a ${bytes} byte request over the reserved ${maxBodyBytes}`);
		attempts++;
		requestSha256 = sha256(body);
		const response = await base(input, init);
		httpStatus = response.status;
		pending = response
			.clone()
			.text()
			.then(
				(text) => {
					captured = parseResponseBody(text);
				},
				() => undefined,
			);
		return response;
	};
	return {
		fetch: asFetch(recordingFetch),
		async finish() {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				pending,
				new Promise((resolve) => {
					timer = setTimeout(resolve, CAPTURE_GRACE_MS);
				}),
			]);
			clearTimeout(timer);
			return {
				dispatched: attempts > 0,
				requestSha256,
				httpStatus,
				...captured,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function deadline(signal: AbortSignal | undefined, timeoutMs: number) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type Base = Pick<DraftObservation, "caseId" | "model" | "adapter" | "repetition" | "startedAt">;

function failure(
	base: Base,
	status: "error" | "unsupported",
	error: string,
	durationMs = 0,
	evidence: CallEvidence = { dispatched: false },
): AdapterResult {
	return {
		observation: { ...base, status, answers: {}, durationMs, error },
		evidence,
	};
}

async function answerHeuristic(prepared: PreparedCase, base: Base): Promise<AdapterResult> {
	if (prepared.input.type !== "intent") return failure(base, "unsupported", "not an intent case");
	const started = performance.now();
	const verdict = await heuristicClassifier({
		entryId: prepared.id,
		text: prepared.input.message,
		...(prepared.input.activeAnchor !== undefined && {
			activeAnchor: prepared.input.activeAnchor,
		}),
		activeItems: prepared.input.activeItems,
	});
	// The heuristic never supersedes, so it answers "none" whenever that is asked.
	const answers: Record<string, EvalAnswer> = {
		kind: { choice: verdict.kind },
	};
	if ("contradicts" in prepared.questions) answers.contradicts = { choice: "none" };
	return {
		observation: {
			...base,
			status: "ok",
			answers,
			durationMs: performance.now() - started,
		},
		evidence: { dispatched: false },
	};
}

type Transport = Awaited<ReturnType<ReturnType<typeof createRecorder>["finish"]>>;

function result(
	base: Base,
	transport: Transport,
	durationMs: number,
	outcome: {
		answers: Record<string, EvalAnswer>;
		error?: string;
		status?: "ok" | "error";
	},
	responseId?: string,
): AdapterResult {
	const generationId =
		transport.generationId ??
		(responseId !== undefined && GENERATION_ID.test(responseId) ? responseId : undefined);
	return {
		observation: {
			...base,
			status: outcome.status ?? "ok",
			answers: outcome.answers,
			durationMs,
			...(generationId !== undefined && { generationId }),
			...(transport.inputTokens !== undefined && {
				inputTokens: transport.inputTokens,
			}),
			...(transport.outputTokens !== undefined && {
				outputTokens: transport.outputTokens,
			}),
			...(transport.requestSha256 !== undefined && {
				requestSha256: transport.requestSha256,
			}),
			...(outcome.error !== undefined && { error: outcome.error }),
		},
		evidence: {
			dispatched: transport.dispatched,
			...(transport.httpStatus !== undefined && {
				httpStatus: transport.httpStatus,
			}),
			...(generationId !== undefined && { generationId }),
			...(transport.costUsd !== undefined && {
				responseCostUsd: transport.costUsd,
			}),
		},
	};
}

const wasInterrupted = (opts: AnswerOptions, signal: AbortSignal) =>
	signal.aborted && (opts.signal?.aborted ? "aborted" : `timed out after ${opts.timeoutMs} ms`);

async function answerDecisions(
	prepared: PreparedCase,
	candidate: Extract<Candidate, { adapter: "decisions" }>,
	plan: Extract<RequestPlan, { kind: "request" }>,
	opts: AnswerOptions,
	base: Base,
): Promise<AdapterResult> {
	const recorder = createRecorder(
		opts.fetch ?? globalThis.fetch,
		plan.bodyBytes + PROMPT_MARGIN_BYTES,
	);
	const signal = deadline(opts.signal, opts.timeoutMs);
	const started = performance.now();
	let classified: ClassifierResult | undefined;
	let thrown: string | undefined;
	try {
		classified = await opts.registry.classify(candidate.model, prepared.context, {
			maxRetries: 0,
			timeoutMs: opts.timeoutMs,
			signal,
			fetch: recorder.fetch,
			onPayload: (payload) =>
				isRecord(payload) ? { ...payload, provider: providerOf(candidate.pricing) } : undefined,
		});
	} catch (error) {
		thrown = safeMessage(error, opts.secrets);
	}
	const durationMs = performance.now() - started;
	const transport = await recorder.finish();
	if (classified?.stopReason !== "stop") {
		const error =
			wasInterrupted(opts, signal) ||
			thrown ||
			safeMessage(classified?.errorMessage ?? "classifier did not stop normally", opts.secrets);
		return result(base, transport, durationMs, {
			answers: {},
			status: "error",
			error,
		});
	}
	const answers: Record<string, EvalAnswer> = {};
	for (const [id, answer] of Object.entries(classified.answers))
		if (answer.type === "choice")
			answers[id] = { choice: answer.choice, confidence: answer.confidence };
	return result(base, transport, durationMs, { answers });
}

/** Maps raw chat text to answers; whatever is wrong is recorded, never dropped. */
export function parseChatAnswers(
	text: string,
	questions: PreparedCase["questions"],
): { answers: Record<string, EvalAnswer>; problems: string[] } {
	const answers: Record<string, EvalAnswer> = {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		return { answers, problems: ["output is not valid JSON"] };
	}
	const raw = isRecord(parsed) ? parsed.answers : undefined;
	if (!isRecord(raw)) return { answers, problems: ["output has no answers object"] };
	const problems: string[] = [];
	for (const [id, value] of Object.entries(raw)) {
		const choice = isRecord(value) && typeof value.choice === "string" ? value.choice : "";
		const confidence =
			isRecord(value) && typeof value.confidence === "number" ? value.confidence : undefined;
		answers[id] = confidence === undefined ? { choice } : { choice, confidence };
		if (!Object.hasOwn(questions, id)) problems.push(`unknown question ${id}`);
	}
	for (const [id, question] of Object.entries(questions)) {
		const answer = answers[id];
		if (!answer) problems.push(`no answer for ${id}`);
		else if (!Object.hasOwn(question.choices, answer.choice))
			problems.push(`${id}: choice is not offered`);
		else if (answer.confidence === undefined) problems.push(`${id}: no numeric confidence`);
	}
	return { answers, problems };
}

async function answerChat(
	prepared: PreparedCase,
	candidate: Extract<Candidate, { adapter: "chat" }>,
	plan: Extract<RequestPlan, { kind: "request" }>,
	opts: AnswerOptions,
	base: Base,
): Promise<AdapterResult> {
	const { userPrompt, responseFormat } = chatRequest(prepared, candidate.model, candidate.pricing);
	const context: Context = {
		systemPrompt: CHAT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
	};
	const recorder = createRecorder(
		opts.fetch ?? globalThis.fetch,
		plan.bodyBytes + PROMPT_MARGIN_BYTES,
	);
	const signal = deadline(opts.signal, opts.timeoutMs);
	const started = performance.now();
	let message: AssistantMessage | undefined;
	let thrown: string | undefined;
	try {
		message = await opts.registry
			.streamSimple(candidate.model, context, {
				toolChoice: "none",
				maxTokens: plan.maxOutputTokens,
				maxRetries: 0,
				timeoutMs: opts.timeoutMs,
				signal,
				fetch: recorder.fetch,
				onPayload: (payload) => {
					if (!isRecord(payload)) return undefined;
					// No tools are declared, and `tool_choice` without tools is rejected by some routes.
					const { tool_choice: _unused, ...rest } = payload;
					return {
						...rest,
						...(responseFormat && { response_format: responseFormat }),
						provider: providerOf(candidate.pricing),
					};
				},
			})
			.result();
	} catch (error) {
		thrown = safeMessage(error, opts.secrets);
	}
	const durationMs = performance.now() - started;
	const transport = await recorder.finish();
	if (!message || message.stopReason === "error" || message.stopReason === "aborted") {
		const error =
			wasInterrupted(opts, signal) ||
			thrown ||
			safeMessage(message?.errorMessage ?? "chat request failed", opts.secrets);
		return result(
			base,
			transport,
			durationMs,
			{ answers: {}, status: "error", error },
			message?.responseId,
		);
	}
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	const { answers, problems } = parseChatAnswers(text, prepared.questions);
	return result(
		base,
		transport,
		durationMs,
		{
			answers,
			...(problems.length > 0 && {
				error: `invalid chat output: ${problems.join("; ")}`.slice(0, 500),
			}),
		},
		message.responseId,
	);
}

/**
 * Answers one prepared case with one candidate. Never throws: failures become
 * `error` or `unsupported` observations. The reservation for the planned
 * request must exist before this is called.
 */
export async function answer(
	prepared: PreparedCase,
	candidate: Candidate,
	opts: AnswerOptions,
): Promise<AdapterResult> {
	const base: Base = {
		caseId: prepared.id,
		model: candidate.label,
		adapter: candidate.adapter,
		repetition: opts.repetition,
		startedAt: new Date().toISOString(),
	};
	const plan = planRequest(prepared, candidate);
	if (plan.kind === "unsupported") return failure(base, "unsupported", plan.reason);
	try {
		if (plan.kind === "local" || candidate.adapter === "heuristic")
			return await answerHeuristic(prepared, base);
		return candidate.adapter === "decisions"
			? await answerDecisions(prepared, candidate, plan, opts, base)
			: await answerChat(prepared, candidate, plan, opts, base);
	} catch (error) {
		// An unexpected failure after dispatch could still have been billed.
		return failure(base, "error", safeMessage(error, opts.secrets), 0, {
			dispatched: candidate.adapter !== "heuristic",
		});
	}
}
