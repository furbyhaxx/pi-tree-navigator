/** Request admission estimates, overflow checks and session token calibration. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	isContextOverflow,
	isRecoverableLength,
} from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_TOKEN_FACTOR,
	estimateRawRequestTokens,
	estimateRequestTokens,
	measuredTokenFactor,
} from "./context-tokens.ts";
import { TOOL_NAME } from "./helpers.ts";
import {
	admissionMessages,
	carriedCompaction,
	effectiveRequestMessages,
	projectAtEntry,
} from "./projection.ts";

/**
 * Always-on anchor mandate appended to the system prompt on every agent
 * start (gated on the tool being active). Same lever as pi-napkin's vault
 * mandate: `promptGuidelines` bullets land mid-prompt; this append lands
 * at the very end of the system prompt, after <project_context> and
 * skills, and is re-applied on every prompt (never compacted). Byte-stable
 * (module constant, no per-session interpolation) for provider caching.
 */
export const ANCHOR_MANDATE = `${TOOL_NAME}: gather all context, then anchor \`context-gathered\`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.`;

/** The model fields rewind-driven compaction reads (#101). */
export interface OverflowModel {
	api?: string;
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * True when `message` is a context overflow by pi's own checks (#101, D1):
 * an explicit overflow error, a silent overflow, or a reply squeezed by the
 * context (`isRecoverableLength`). Same model only (pi's `sameModel`): a
 * reply from another model says nothing about this window.
 */
export function overflowed(message: unknown, model: OverflowModel | undefined): boolean {
	const m = message as Partial<AssistantMessage> | undefined;
	if (m?.role !== "assistant" || !model) return false;
	if (m.provider !== model.provider || m.model !== model.id) return false;
	try {
		return (
			isContextOverflow(m as AssistantMessage, model.contextWindow) ||
			isRecoverableLength(m as AssistantMessage, model.maxTokens ?? 0)
		);
	} catch {
		return false;
	}
}

export function requestAccounting(sm: SessionManager, messages: AgentMessage[]) {
	return accountRequest(effectiveRequestMessages(sm, messages), tokenFactorOf(sm));
}

/**
 * Per session, for the model that served its latest request: estimated tokens
 * per heuristic token that model reported, and the heuristic of the request
 * still awaiting its usage. A model switch drops the measurement, because
 * tokenizers differ.
 */
export const tokenCalibration = new Map<
	string,
	{ modelKey: string; factor?: number | undefined; pending?: number }
>();

export function tokenFactorOf(sm: { getSessionId(): string }): number {
	try {
		return tokenCalibration.get(sm.getSessionId())?.factor ?? DEFAULT_TOKEN_FACTOR;
	} catch {
		return DEFAULT_TOKEN_FACTOR;
	}
}

/** Remember the heuristic of the request about to go to `modelKey`. */
export function noteOutgoingRequest(
	sessionId: string,
	modelKey: string,
	effective: AgentMessage[],
): void {
	const current = tokenCalibration.get(sessionId);
	tokenCalibration.set(sessionId, {
		modelKey,
		...(current?.modelKey === modelKey && { factor: current.factor }),
		pending: estimateRawRequestTokens(effective),
	});
}

/** Calibrate from the usage the model reported for the noted request. */
export function noteRequestUsage(sessionId: string, message: unknown, contextWindow = 0): void {
	const current = tokenCalibration.get(sessionId);
	const m = message as Partial<AssistantMessage> | undefined;
	if (
		current?.pending === undefined ||
		m?.role !== "assistant" ||
		`${m.provider}/${m.model}` !== current.modelKey ||
		m.stopReason === "error" ||
		m.stopReason === "aborted" ||
		!m.usage
	)
		return;
	const factor = measuredTokenFactor(
		calculateContextTokens(m.usage) - (m.usage.output ?? 0),
		current.pending,
		contextWindow,
	);
	tokenCalibration.set(sessionId, {
		modelKey: current.modelKey,
		factor: factor ?? current.factor,
	});
}

/** The admission estimate of a complete request whose system state is already effective. */
export function accountRequest(effective: AgentMessage[], factor = DEFAULT_TOKEN_FACTOR) {
	const system = getCurrentSystemMessage(effective);
	const mandated = system !== undefined && getSystemMessageText(system).includes(ANCHOR_MANDATE);
	return {
		messages: effective,
		tokens:
			estimateRequestTokens(effective, factor) +
			(mandated ? 0 : Math.ceil((ANCHOR_MANDATE.length / 4) * factor)),
	};
}

/**
 * The one number the extension gates and reports context on: what the next
 * request on the active branch would cost, as the request guard estimates it.
 * The branch is projected as `context` sends it, under the effective system
 * state `requestAccounting` uses.
 */
export function estimateAdmissionTokens(sm: SessionManager): number {
	return accountRequest(admissionMessages(sm), tokenFactorOf(sm)).tokens;
}

/** The admission estimate (see `estimateAdmissionTokens`) for the branch a fold to `entryId` leaves. */
export function estimateAtEntry(
	sm: SessionManager,
	entries: SessionEntry[],
	entryId: string,
	byId: Map<string, SessionEntry>,
): number {
	const carry = carriedCompaction(sm.getBranch(), entryId);
	return requestAccounting(sm, projectAtEntry(entries, entryId, byId, carry)).tokens;
}
