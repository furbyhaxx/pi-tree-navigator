/** Session turns, tool messages and usage fixtures. */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
};

export function usageOf(totalTokens: number) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: ZERO_COST,
	};
}

/**
 * Append a complete user/assistant turn so the chain has a labelable assistant
 * leaf with usage. Returns the assistant entry id so the caller can label it.
 */
export function appendTurn(
	sm: SessionManager,
	userText: string,
	assistantText: string,
	totalTokens = 100,
	recordWork = false,
): { userId: string; assistantId: string } {
	const userId = sm.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: userText },
			...(recordWork ? [{ type: "text", text: "Recorded work and evidence.\n".repeat(1200) }] : []),
		],
	} as never);
	const assistantId = sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: "anthropic",
		provider: "claude",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: usageOf(totalTokens),
	} as never);
	return { userId, assistantId };
}

/** An assistant message as the agent loop hands it to `turn_end`. */
export type AssistantTurn = {
	role: "assistant";
	content: Array<Record<string, unknown>>;
	stopReason: string;
	[k: string]: unknown;
};

export function assistantMessage(
	content: Array<Record<string, unknown>>,
	stopReason: string,
	totalTokens = 0,
): AssistantTurn {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "claude",
		model: "claude-sonnet-4-5",
		stopReason,
		timestamp: Date.now(),
		usage: usageOf(totalTokens),
	};
}

/**
 * Append an assistant message declaring tool calls (each with `arguments`),
 * the shape the model emits for the rewind call itself or for a blocked
 * forced attempt. Returns the appended message (for `turn_end`) and its id.
 */
export function appendToolCallAssistant(
	sm: SessionManager,
	toolCalls: Array<{
		id: string;
		name: string;
		arguments?: Record<string, unknown>;
	}>,
	totalTokens = 30_000,
): { id: string; message: AssistantTurn } {
	const message = assistantMessage(
		toolCalls.map((tc) => ({
			type: "toolCall",
			id: tc.id,
			name: tc.name,
			arguments: tc.arguments ?? { action: "rewind" },
		})),
		"toolUse",
		totalTokens,
	);
	return { id: sm.appendMessage(message as never), message };
}

/** Append the tool_result pi records after a tool's `execute` returns. */
export function appendToolResult(
	sm: SessionManager,
	toolCallId: string,
	toolName: string,
	text: string,
	details: unknown = {},
): string {
	return sm.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as never);
}
