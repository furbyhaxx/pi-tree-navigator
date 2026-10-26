/** Registry-backed fold summary calls, public contracts and bounded strategy orchestration. */

import type {
	Api,
	Message,
	Model,
	StopReason,
	ThinkingLevel,
	Tool,
	Usage,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	estimate,
	extractionInstruction,
	extractionMessage,
	FRAME_TOKENS,
	groupBySize,
	MAP_SYSTEM,
	type Note,
	noteText,
	packRecords,
	planConsolidation,
	REDUCE_SYSTEM,
	userMessage,
} from "./fold-summarizer-evidence.ts";
import { buildSummaryRequestText, extractSummaryText } from "./summary-prompt.ts";

/** Caller-owned side-call model adapter; provider errors come back as a stop reason, never a throw. */
export interface FoldSummaryRunner {
	readonly name: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	/** Reasoning level of every call unless a request turns it off. */
	readonly thinking: ThinkingLevel | "off";
	complete(request: {
		systemPrompt?: string;
		messages: Message[];
		tools?: Tool[];
		/** Response ceiling; reasoning tokens share it on adaptive and effort-based models. */
		maxTokens: number;
		/** `"off"` sends this call without reasoning. */
		reasoning?: "off";
		signal?: AbortSignal;
	}): Promise<{
		text: string;
		stopReason: StopReason;
		usage?: Usage;
		errorMessage?: string | undefined;
	}>;
}

/** Build a runner on the registry's `streamSimple` so authentication stays registry-owned. */
export function createFoldSummaryRunner(options: {
	registry: Pick<ModelRegistry, "streamSimple">;
	model: Model<Api>;
	thinking: ThinkingLevel | "off";
	sessionId?: string;
}): FoldSummaryRunner {
	const { registry, model, thinking, sessionId } = options;
	return {
		name: `${model.provider}/${model.id}:${thinking}`,
		thinking,
		contextWindow: model.contextWindow,
		maxOutputTokens: Math.min(model.maxTokens, Math.floor(model.contextWindow / 4)),
		async complete(request) {
			const response = await registry
				.streamSimple(
					model,
					{
						...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
						messages: request.messages,
						...(request.tools === undefined ? {} : { tools: request.tools }),
					},
					{
						...(request.signal === undefined ? {} : { signal: request.signal }),
						...(thinking === "off" || request.reasoning === "off" ? {} : { reasoning: thinking }),
						maxTokens: request.maxTokens,
						toolChoice: "none",
						...(sessionId === undefined ? {} : { sessionId }),
					},
				)
				.result();
			return {
				text: response.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
				stopReason: response.stopReason,
				usage: response.usage,
				errorMessage: response.errorMessage,
			};
		},
	};
}

/** One collapsed message of the anchor-to-leaf segment, as plain text. */
export interface FoldSegmentRecord {
	id: string;
	role: "user" | "assistant" | "tool" | "summary" | "custom";
	text: string;
}

/** Reported before every runner call. */
export type FoldSummaryProgress = {
	phase: "in-context" | "map" | "reduce";
	call: number;
	plannedCalls: number;
};

export interface SummarizeFoldOptions {
	runner: FoldSummaryRunner;
	focus: string;
	parent?: { mode: "full" | "synthesized" | "digest"; childCount: number } | undefined;
	continuitySection?: string | undefined;
	/**
	 * Replaces the r5d fold instruction in the in-context request and the final reduce;
	 * `first` is the 1-based first summarized message. The answer must still start at `## Goal`.
	 */
	instruction?(first: number): string;
	/**
	 * Strategy A candidate: the projected live request up to the leaf; `first` is the 1-based first collapsed message.
	 * pi 1.3 carries the system prompt and tools as system messages inside `messages`; the separate fields are optional.
	 */
	inContext?:
		| {
				messages: Message[];
				first: number;
				systemPrompt?: string;
				tools?: Tool[];
		  }
		| undefined;
	/** Strategy B evidence: background text (may be empty) and the anchor-to-leaf records in order. */
	segment: { background: string; records: FoldSegmentRecord[] };
	/** Shared admission policy: input estimate of the complete request, system prompt and tools included. */
	admit(
		request: { systemPrompt?: string; tools?: Tool[]; messages: Message[] },
		maxOutputTokens: number,
	): { fits: boolean; inputEstimate: number };
	limits?:
		| {
				maxCalls?: number;
				mapOutputTokens?: number;
				reduceOutputTokens?: number;
				chunkInputTokens?: number;
		  }
		| undefined;
	signal?: AbortSignal | undefined;
	onProgress?: ((progress: FoldSummaryProgress) => void) | undefined;
}

export type SummarizeFoldResult =
	| {
			ok: true;
			text: string;
			strategy: "in-context" | "chunked";
			calls: number;
			chunks: number;
			usage: Usage[];
			/** Record ids each map call covered, in call order; empty for the in-context strategy. */
			coverage: string[][];
	  }
	| {
			ok: false;
			reason: "aborted" | "provider-error" | "invalid-summary" | "over-call-budget" | "no-evidence";
			detail: string;
			calls: number;
			usage: Usage[];
	  };

type Failure = Extract<SummarizeFoldResult, { ok: false }>;
type Completion = Awaited<ReturnType<FoldSummaryRunner["complete"]>>;
type Request = Parameters<FoldSummaryRunner["complete"]>[0];

const DEFAULT_MAX_CALLS = 16;
const DEFAULT_MAP_OUTPUT_TOKENS = 3000;
/** Output allowance shared by the summarizer and prospective fold previews. */
export const DEFAULT_REDUCE_OUTPUT_TOKENS = 8000;
const DEFAULT_CHUNK_INPUT_TOKENS = 120_000;
const HEADROOM_TOKENS = 4096;

const REASONING_ALLOWANCE: Readonly<Record<ThinkingLevel | "off", number>> = {
	off: 0,
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

/**
 * Response tokens reserved for reasoning on top of an answer cap. Adaptive
 * Anthropic and OpenAI reasoning models count thinking against the same
 * ceiling as the answer, so an answer-sized cap ends in `length`.
 */
export function reasoningAllowance(thinking: ThinkingLevel | "off"): number {
	return REASONING_ALLOWANCE[thinking] ?? REASONING_ALLOWANCE["xhigh"];
}

const FINAL_RETRIES = 1;

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Write a fold's summary with a side call. Strategy A replays the live request
 * when it fits; otherwise (or when A yields no valid summary) strategy B
 * extracts notes from chunks of the collapsed segment and reduces them with the
 * unchanged r5d instruction. Expected failures return a typed result.
 */
export async function summarizeFold(options: SummarizeFoldOptions): Promise<SummarizeFoldResult> {
	const { runner, signal } = options;
	const maxCalls = options.limits?.maxCalls ?? DEFAULT_MAX_CALLS;
	const mapOut = Math.min(
		options.limits?.mapOutputTokens ?? DEFAULT_MAP_OUTPUT_TOKENS,
		runner.maxOutputTokens,
	);
	const reduceOut = Math.min(
		options.limits?.reduceOutputTokens ?? DEFAULT_REDUCE_OUTPUT_TOKENS,
		runner.maxOutputTokens,
	);
	// Response ceilings: the answer plus room for reasoning, and the larger
	// reasoning-off ceiling a `length` retry may use. Planning reserves the latter.
	const allowance = reasoningAllowance(runner.thinking);
	const ceiling = (answer: number) => Math.min(runner.maxOutputTokens, answer + allowance);
	const retryCeiling = (answer: number) =>
		Math.min(runner.maxOutputTokens, Math.max(answer + allowance, 2 * answer));
	const reduceCeiling = ceiling(reduceOut);
	const mapReserve = retryCeiling(mapOut);
	const reduceReserve = retryCeiling(reduceOut);
	const usage: Usage[] = [];
	let calls = 0;
	let plannedCalls = 0;
	const requestText = (first: number) =>
		options.instruction
			? options.instruction(first)
			: buildSummaryRequestText(first, options.focus, options.parent, options.continuitySection);

	const fail = (reason: Failure["reason"], detail: string): Failure => ({
		ok: false,
		reason,
		detail,
		calls,
		usage,
	});

	const invoke = async (
		phase: FoldSummaryProgress["phase"],
		request: Omit<Request, "signal">,
	): Promise<{ response: Completion } | { failure: Failure }> => {
		if (signal?.aborted) return { failure: fail("aborted", "cancelled before the request") };
		calls++;
		options.onProgress?.({ phase, call: calls, plannedCalls });
		let response: Completion;
		try {
			response = await runner.complete({ ...request, ...(signal === undefined ? {} : { signal }) });
		} catch (error) {
			if (signal?.aborted || isAbort(error))
				return { failure: fail("aborted", "cancelled during the request") };
			return {
				failure: fail("provider-error", error instanceof Error ? error.message : String(error)),
			};
		}
		if (response.usage) usage.push(response.usage);
		if (signal?.aborted || response.stopReason === "aborted")
			return { failure: fail("aborted", "cancelled during the request") };
		if (response.stopReason === "error")
			return {
				failure: fail("provider-error", response.errorMessage ?? "provider error"),
			};
		return { response };
	};

	/**
	 * One call whose `length` stop is retried once without reasoning and with the
	 * reserved ceiling: reasoning that exhausts the shared ceiling must not end
	 * the fold. The retry is a billed call and counts against `maxCalls`.
	 */
	const invokeWithRetry = async (
		phase: FoldSummaryProgress["phase"],
		request: Omit<Request, "signal" | "maxTokens" | "reasoning">,
		answer: number,
	): Promise<{ response: Completion } | { failure: Failure }> => {
		const first = await invoke(phase, {
			...request,
			maxTokens: ceiling(answer),
		});
		if ("failure" in first || first.response.stopReason !== "length") return first;
		if (calls >= maxCalls) return first;
		plannedCalls++;
		return invoke(phase, {
			...request,
			maxTokens: retryCeiling(answer),
			reasoning: "off",
		});
	};

	const summaryOf = (response: Completion): string | null =>
		response.stopReason === "stop" ? extractSummaryText(response.text) : null;

	let inContextNote = "";
	let inContextFailed = false;
	const inContext = options.inContext;
	if (inContext) {
		const request = {
			...(inContext.systemPrompt === undefined ? {} : { systemPrompt: inContext.systemPrompt }),
			...(inContext.tools === undefined ? {} : { tools: inContext.tools }),
			messages: [...inContext.messages, userMessage(requestText(inContext.first))],
		};
		const { fits, inputEstimate } = options.admit(request, reduceCeiling);
		if (fits) {
			plannedCalls = 1;
			const attempt = await invoke("in-context", {
				...request,
				maxTokens: reduceCeiling,
			});
			if ("failure" in attempt) return attempt.failure;
			const text = summaryOf(attempt.response);
			if (text !== null)
				return {
					ok: true,
					text,
					strategy: "in-context",
					calls,
					chunks: 0,
					usage,
					coverage: [],
				};
			inContextFailed = true;
			inContextNote = `the in-context attempt ended with stop reason "${attempt.response.stopReason}" without a valid summary`;
		} else {
			inContextNote = `the in-context request (about ${inputEstimate} input tokens) does not fit`;
		}
	}

	const { background, records } = options.segment;
	if (records.length === 0)
		return fail(
			inContextFailed ? "invalid-summary" : "no-evidence",
			inContextNote
				? `${inContextNote}; the segment has no records to fall back on`
				: "no in-context request and no segment records",
		);

	const instruction = extractionInstruction(options.focus, mapOut);
	const mapOverhead =
		estimate(MAP_SYSTEM) +
		estimate(extractionMessage(background, "", "", instruction)) +
		FRAME_TOKENS;
	const budget = Math.min(
		options.limits?.chunkInputTokens ?? DEFAULT_CHUNK_INPUT_TOKENS,
		runner.contextWindow - mapReserve - mapOverhead - HEADROOM_TOKENS,
	);
	const chunks = packRecords(records, budget);
	if (!chunks)
		return fail(
			"over-call-budget",
			`${runner.name} leaves only ${budget} tokens of evidence per request; a record cannot be split to fit`,
		);

	const first = background ? 2 : 1;
	const finalInstruction = requestText(first);
	const backgroundMessage = background
		? `Background for the collapsed work below; it is not part of it:\n${background}`
		: "";
	const finalCapacity =
		runner.contextWindow -
		reduceReserve -
		estimate(REDUCE_SYSTEM) -
		estimate(backgroundMessage) -
		estimate(finalInstruction) -
		HEADROOM_TOKENS;
	const worstNoteTokens = Math.ceil((mapOut * 8) / 7) + FRAME_TOKENS;
	const consolidations = planConsolidation(chunks.length, worstNoteTokens, budget, finalCapacity);
	if (consolidations === undefined)
		return fail(
			"over-call-budget",
			`${chunks.length} evidence notes of up to ${worstNoteTokens} tokens cannot be reduced within ${runner.name}'s context window`,
		);
	const planned = chunks.length + consolidations + 1;
	if (calls + planned > maxCalls)
		return fail(
			"over-call-budget",
			`planned ${planned} calls (${chunks.length} map, up to ${consolidations} consolidation, 1 reduce)${calls ? ` after ${calls} earlier` : ""} exceed the limit of ${maxCalls}`,
		);
	plannedCalls = calls + planned;

	const coverage: string[][] = [];
	let notes: Note[] = [];
	for (const [index, chunk] of chunks.entries()) {
		const firstId = chunk.ids[0];
		const label = `Evidence records ${index + 1}/${chunks.length} (records ${chunk.ids[0]} to ${chunk.ids.at(-1)}):`;
		const attempt = await invokeWithRetry(
			"map",
			{
				systemPrompt: MAP_SYSTEM,
				messages: [userMessage(extractionMessage(background, label, chunk.text, instruction))],
			},
			mapOut,
		);
		if ("failure" in attempt) return attempt.failure;
		const text = attempt.response.text.trim();
		if (attempt.response.stopReason !== "stop" || !text)
			return fail(
				"invalid-summary",
				`map call ${index + 1}/${chunks.length} ended with stop reason "${attempt.response.stopReason}" and ${text ? "incomplete" : "no"} notes${attempt.response.stopReason === "length" ? ", also after a retry without reasoning" : ""}`,
			);
		coverage.push(chunk.ids);
		notes.push({
			text,
			first: firstId,
			last: chunk.ids.at(-1) ?? firstId,
		});
	}

	const noteSizes = () => notes.map((note, index) => estimate(noteText(note, index, notes.length)));
	let sizes = noteSizes();
	while (sizes.reduce((sum, size) => sum + size, 0) > finalCapacity) {
		const groups = groupBySize(sizes, budget);
		const merging = groups.filter((group) => group.length > 1);
		const needed = merging.length;
		if (needed === 0 || calls + needed + 1 > maxCalls)
			return fail(
				"over-call-budget",
				needed === 0
					? `${notes.length} evidence notes are too large to consolidate`
					: `consolidating ${notes.length} evidence notes needs ${needed} more calls plus the reduce, beyond the limit of ${maxCalls} after ${calls}`,
			);
		const next: Note[] = [];
		for (const group of groups) {
			const members = group.map((index) => {
				const note = notes[index];
				if (!note) throw new TypeError("Missing consolidation note");
				return note;
			});
			const firstMember = members[0];
			const lastMember = members.at(-1);
			if (!firstMember || !lastMember) throw new TypeError("Missing consolidation members");
			if (members.length === 1) {
				next.push(firstMember);
				continue;
			}
			const body = members.map((note, index) => noteText(note, index, members.length)).join("\n\n");
			const attempt = await invokeWithRetry(
				"reduce",
				{
					systemPrompt: MAP_SYSTEM,
					messages: [
						userMessage(
							extractionMessage(
								background,
								`Evidence notes to consolidate (${members.length} notes from earlier extraction passes, in order):`,
								body,
								instruction,
							),
						),
					],
				},
				mapOut,
			);
			if ("failure" in attempt) return attempt.failure;
			const text = attempt.response.text.trim();
			if (attempt.response.stopReason !== "stop" || !text)
				return fail(
					"invalid-summary",
					`a consolidation call ended with stop reason "${attempt.response.stopReason}" and ${text ? "incomplete" : "no"} notes`,
				);
			next.push({
				text,
				first: firstMember.first,
				last: lastMember.last,
			});
		}
		notes = next;
		sizes = noteSizes();
	}

	const reduceRequest = {
		systemPrompt: REDUCE_SYSTEM,
		messages: [
			...(background ? [userMessage(backgroundMessage)] : []),
			...notes.map((note, index) => userMessage(noteText(note, index, notes.length))),
			userMessage(finalInstruction),
		],
	};
	let lastDetail = "";
	for (let attempt = 0; attempt <= FINAL_RETRIES; attempt++) {
		if (attempt > 0 && calls >= maxCalls) break;
		const result = await invokeWithRetry("reduce", reduceRequest, reduceOut);
		if ("failure" in result) return result.failure;
		const text = summaryOf(result.response);
		if (text !== null)
			return {
				ok: true,
				text,
				strategy: "chunked",
				calls,
				chunks: chunks.length,
				usage,
				coverage,
			};
		lastDetail = `the final reduce ended with stop reason "${result.response.stopReason}" without a valid summary`;
	}
	return fail("invalid-summary", lastDetail);
}
