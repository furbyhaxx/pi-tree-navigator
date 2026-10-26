import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { withoutSkillBody } from "./skill-blocks.ts";

/** A still-open user instruction quoted from the canonical context. */
export interface OpenUserRequest {
	sourceEntryId: string;
	text: string;
}

function storedRequests(details: unknown): OpenUserRequest[] {
	if (!details || typeof details !== "object" || !("openUserRequests" in details)) return [];
	const requests = details.openUserRequests;
	if (!Array.isArray(requests)) return [];
	return requests.filter(
		(request): request is OpenUserRequest =>
			request !== null &&
			typeof request === "object" &&
			typeof request.sourceEntryId === "string" &&
			typeof request.text === "string",
	);
}

/**
 * Collect collapsed open requests without resurrecting edited or retained input.
 * Skill bodies are referenced, not quoted. A request closes on a text-only final
 * reply, on a newer user message once the agent has responded since, and on a
 * later handoff, which already carried it through a fold summary. Requests a
 * pressure compaction quoted (`details.navigateTree.pressure`) are inherited.
 */
export function collectOpenUserRequests(
	entries: readonly { sourceEntry: SessionEntry; messages: AgentMessage[] }[],
	foldPointId: string,
	retainedIds: ReadonlySet<string>,
	continuationType: string,
): OpenUserRequest[] {
	let open = new Map<string, OpenUserRequest & { collapsed: boolean }>();
	let answered = false;
	for (const entry of entries) {
		const collapsed = !retainedIds.has(entry.sourceEntry.id);
		if (entry.sourceEntry.type === "branch_summary") {
			open.clear();
			answered = false;
		} else if (entry.sourceEntry.type === "compaction") {
			// A pressure compaction quotes the requests it summarized; they stay open.
			const details = entry.sourceEntry.details as
				| { navigateTree?: { pressure?: unknown } }
				| undefined;
			const carried = storedRequests(details?.navigateTree?.pressure);
			if (carried.length > 0) {
				open = new Map([
					...carried.map(
						(request) =>
							[
								request.sourceEntryId,
								{ ...request, text: withoutSkillBody(request.text), collapsed },
							] as const,
					),
					...open,
				]);
				answered = false;
			}
		}
		for (const message of entry.messages) {
			if (message.role === "user") {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.flatMap((block) => (block.type === "text" ? [block.text] : []))
								.join("");
				if (text.length === 0) continue;
				if (answered) open.clear();
				answered = false;
				open.set(entry.sourceEntry.id, {
					sourceEntryId: entry.sourceEntry.id,
					text: withoutSkillBody(text),
					collapsed,
				});
			} else if (message.role === "assistant") {
				answered = true;
				if (
					message.stopReason === "stop" &&
					!message.content.some((block) => block.type === "toolCall") &&
					message.content.some((block) => block.type === "text" && block.text.trim().length > 0)
				)
					open.clear();
			} else if (message.role === "custom" && message.customType === continuationType) {
				const inherited = new Map<string, OpenUserRequest & { collapsed: boolean }>();
				for (const request of storedRequests(message.details)) {
					inherited.set(request.sourceEntryId, {
						...request,
						text: withoutSkillBody(request.text),
						collapsed,
					});
				}
				// Archived requests precede late input delivered before the receipt.
				open = new Map([...inherited, ...open]);
				answered = false;
			}
		}
		if (entry.sourceEntry.id === foldPointId) break;
	}
	return [...open.values()]
		.filter((request) => request.collapsed)
		.map(({ sourceEntryId, text }) => ({ sourceEntryId, text }));
}

/** Frame archived user input separately from generated handoff narrative. */
export function renderOpenUserRequests(requests: readonly OpenUserRequest[]): string {
	if (requests.length === 0) return "";
	return (
		"\n\nThis rewind is completed; do not repeat it. Fulfill the remaining request(s) in the quoted archived user input below.\n" +
		requests
			.map(
				(request) =>
					`\nQuoted archived user request (source entry ID: ${request.sourceEntryId}):\n<archived-user-request>\n${request.text}\n</archived-user-request>`,
			)
			.join("\n")
	);
}
