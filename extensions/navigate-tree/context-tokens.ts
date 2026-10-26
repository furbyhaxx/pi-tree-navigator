import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	convertToLlm,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { formatWindow } from "./helpers.ts";

type Usage = Parameters<typeof calculateContextTokens>[0];

function validAssistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const assistant = message as {
		stopReason?: string;
		usage?: Usage;
	};
	if (
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		assistant.usage &&
		calculateContextTokens(assistant.usage) > 0
	) {
		return assistant.usage;
	}
	return undefined;
}

/** Split a baseline-safe projection into recorded usage and its estimated tail. */
export function splitContextEstimate(messages: AgentMessage[]): {
	baseline: number;
	tail: number;
} {
	const anchor = newestUsageIndex(messages);
	const usage = anchor >= 0 ? validAssistantUsage(messages[anchor]) : undefined;
	const currentSystem = anchor < 0 ? getCurrentSystemMessage(messages) : undefined;
	let tail = currentSystem ? estimateTokens(currentSystem) : 0;
	for (let j = anchor + 1; j < messages.length; j++) {
		if (anchor < 0 && messages[j].role === "system") continue;
		tail += estimateTokens(messages[j]);
	}
	return {
		baseline: usage ? calculateContextTokens(usage) : 0,
		tail,
	};
}

/** Find the newest valid usage in messages whose stale baselines have been invalidated. */
export function newestUsageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (validAssistantUsage(messages[i])) return i;
	}
	return -1;
}

/** Compare projected content on one heuristic without historical usage baselines. */
export function estimateContentTokens(messages: AgentMessage[]): number {
	const system = getCurrentSystemMessage(messages);
	return (
		(system ? estimateTokens(system) : 0) +
		messages.reduce(
			(sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)),
			0,
		)
	);
}

/**
 * The admission estimate, shaped like the SDK's own pre-request estimate: the
 * newest valid usage plus the estimated messages after it, or all messages when
 * no baseline survives invalidation (a later compaction, context edit, system
 * message or model change). Estimated text is scaled by `factor`: the SDK's
 * 3.5 chars/token over the host's four by default, or what the model measured.
 */
export function estimateRequestTokens(
	messages: AgentMessage[],
	factor = DEFAULT_TOKEN_FACTOR,
): number {
	const converted = convertToLlm(messages);
	const anchor = newestUsageIndex(converted);
	const usage = anchor >= 0 ? validAssistantUsage(converted[anchor]) : undefined;
	const tail = converted
		.slice(anchor + 1)
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	return (usage ? calculateContextTokens(usage) : 0) + Math.ceil(tail * factor);
}

/** The SDK's 3.5 chars/token over the host heuristic's four. */
export const DEFAULT_TOKEN_FACTOR = 8 / 7;

/** Pi's four-chars-per-token estimate of a whole request, ignoring usage. */
export function estimateRawRequestTokens(messages: AgentMessage[]): number {
	return convertToLlm(messages).reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * Tokens per heuristic token a model reported for a request, bounded so a
 * measurement only ever raises estimates, and never absurdly. Dense code and
 * JSON cost far more than four chars per token on some tokenizers.
 */
export function measuredTokenFactor(
	actualInput: number,
	heuristic: number,
	contextWindow = 0,
): number | undefined {
	if (!(actualInput > 0) || !(heuristic > 0)) return undefined;
	// A request the window could not hold proves the estimate wrong, however small it looked.
	const overflowed = contextWindow > 0 && actualInput > contextWindow;
	if (!(heuristic >= MIN_CALIBRATION_TOKENS) && !overflowed) return undefined;
	return Math.min(MAX_TOKEN_FACTOR, Math.max(DEFAULT_TOKEN_FACTOR, actualInput / heuristic));
}

// Tool schemas are in the reported usage but not always in the heuristic; on a
// request this large they are a small share instead of the measured ratio.
const MIN_CALIBRATION_TOKENS = 50_000;
// Random CJK text measures about 7.7x the heuristic on o200k.
const MAX_TOKEN_FACTOR = 8;

/** Estimate projected context with Pi's heuristic and the effective system state. */
export function estimateContextTokens(messages: AgentMessage[]): number {
	const { baseline, tail } = splitContextEstimate(messages);
	return baseline + tail;
}

/**
 * Why folding cannot relieve this context: the request's fixed part (system
 * prompt and tool schemas) alone reaches `limit`. Names the tool share and the
 * largest MCP server, since tool exposure is the usual culprit. Undefined while
 * the conversation still holds enough to fold.
 */
export function fixedOverheadNote(input: {
	messages: AgentMessage[];
	activeTokens: number;
	limit: number;
	factor?: number;
}): string | undefined {
	const { messages, activeTokens, limit } = input;
	const factor = input.factor ?? DEFAULT_TOKEN_FACTOR;
	const conversation = Math.ceil(
		messages.reduce(
			(sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)),
			0,
		) * factor,
	);
	const overhead = activeTokens - conversation;
	if (overhead < limit) return undefined;
	// Shares of the system message, scaled to the measured overhead: tool JSON
	// tokenizes denser than four chars per token, so absolute estimates misplace it.
	const system = getCurrentSystemMessage(messages);
	const tools = system?.toolsAdded ?? [];
	const systemChars = system ? estimateTokens(system) * 4 : 0;
	const tokensOf = (value: unknown) =>
		systemChars > 0
			? Math.round((Math.min(JSON.stringify(value).length, systemChars) / systemChars) * overhead)
			: 0;
	const toolTokens = tools.length ? tokensOf(tools) : 0;
	const servers = new Map<string, typeof tools>();
	for (const tool of tools) {
		const server = /^mcp__(.+?)__/.exec(tool.name)?.[1];
		if (server) servers.set(server, [...(servers.get(server) ?? []), tool]);
	}
	const largest = [...servers]
		.map(([name, group]) => ({
			name,
			count: group.length,
			tokens: tokensOf(group),
		}))
		.sort((a, b) => b.tokens - a.tokens)[0];
	const breakdown = [
		`system prompt ~${formatWindow(Math.max(overhead - toolTokens, 0)) || "0k"}`,
		...(tools.length
			? [
					`${tools.length} tool schemas ~${formatWindow(toolTokens) || "0k"}${largest ? `, largest mcp__${largest.name}: ${largest.count} tools ~${formatWindow(largest.tokens) || "0k"}` : ""}`,
				]
			: []),
	].join("; ");
	return `~${formatWindow(overhead)} of ~${formatWindow(activeTokens)} is fixed overhead (${breakdown}) against a ~${formatWindow(conversation) || "0k"} conversation, so no fold can bring context under ${formatWindow(limit)}. Reduce tool exposure (MCP "exposure": "codemode" or "deferred", then /reload) or raise rewind_at_tokens.`;
}
