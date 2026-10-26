/** Scripted side-call replies and a recording model registry. */
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { usageOf } from "./session-messages.ts";

/** Canonical well-formed summary text (r5d headings). */
export const SUMMARY_TEXT =
	"## Goal\nTest the rewind happy path.\n\n## Progress\n### Done\n- [x] Appended turns.\n\n## Next Steps\n1. Verify the branch_summary.";

export interface RegistryCall {
	model: unknown;
	context: Context;
	options: SimpleStreamOptions;
}

export function reply(
	text: string,
	stopReason: "stop" | "error" | "aborted" = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "claude",
		model: "claude-sonnet-4-5",
		stopReason,
		errorMessage,
		timestamp: Date.now(),
		usage: usageOf(10),
	} as unknown as AssistantMessage;
}

/** A fake `modelRegistry` recording every side call; `respond` scripts the answer. */
export function fakeRegistry(
	respond: (
		call: RegistryCall,
		index: number,
	) => AssistantMessage | Promise<AssistantMessage> = () => reply(SUMMARY_TEXT),
) {
	const calls: RegistryCall[] = [];
	const registry = {
		hasConfiguredAuth: () => true,
		streamSimple(model: unknown, context: Context, options: SimpleStreamOptions) {
			const call = { model, context, options };
			const index = calls.push(call) - 1;
			const stream = createAssistantMessageEventStream();
			void Promise.resolve(respond(call, index)).then((message) => stream.end(message));
			return stream;
		},
	};
	return { calls, registry };
}
