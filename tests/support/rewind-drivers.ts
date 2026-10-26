/** Persisted rewind calls and boundary-delivered continuation messages. */
import * as assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import { REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { fireTurnEndAll } from "./boundary-drivers.ts";
import type { BoundaryDraft, CapturedTool, FakeCtx, FakePi } from "./extension-harness.ts";
import { appendToolCallAssistant, appendToolResult } from "./session-messages.ts";

export const REWIND_ARGS = {
	action: "rewind",
	rewindTo: "start",
	newLabel: "end",
	summaryFocus: "Preserve user instructions and continue.",
} as const;

/**
 * The rewind call exactly as the agent loop runs it: the model's assistant
 * turn declaring the call is persisted, `execute` queues the fold, pi
 * persists the tool_result, and the turn ends. The fold lands inside that
 * `turn_end`; `leafBeforeFold` is the abandoned branch's last entry.
 */
export async function requestRewind(
	f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx; tool: CapturedTool },
	args: Record<string, unknown> = REWIND_ARGS,
	toolCallId = "tc-rewind",
	totalTokens?: number,
	turn: {
		entries?: BoundaryDraft[];
		commit?: boolean;
		turnIndex?: number;
	} = {},
) {
	const call = appendToolCallAssistant(
		f.sm,
		[{ id: toolCallId, name: TOOL_NAME, arguments: args }],
		totalTokens,
	);
	const result = await f.tool.execute(toolCallId, args, undefined, undefined, f.ctx);
	appendToolResult(f.sm, toolCallId, TOOL_NAME, result.content[0].text, result.details);
	const leafBeforeFold = f.sm.getLeafId() as string;
	const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message, turn);
	return { result, callId: call.id, boundary, leafBeforeFold };
}

/**
 * Rewind messages delivered as `turn_end` boundary entries, oldest first,
 * each with its boundary's folded `continue`. Also pins that no rewind
 * message ever goes through `pi.sendMessage`.
 */
export function rewindMessages(pi: FakePi): Array<{ message: BoundaryDraft; continue: boolean }> {
	assert.ok(
		!pi.sendMessageCalls.some(
			(args) => (args[0] as { customType?: string } | undefined)?.customType === REWIND_CUSTOM_TYPE,
		),
		"rewind messages must be boundary entries, never pi.sendMessage",
	);
	return pi.boundaryResults.flatMap((result) =>
		result.entries
			.filter((draft) => draft.customType === REWIND_CUSTOM_TYPE)
			.map((message) => ({ message, continue: result.continue })),
	);
}
