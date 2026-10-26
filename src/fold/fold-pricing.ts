/** Fold request inputs, admission estimates and candidate pricing. */
import type { Message, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	collectEntriesForBranchSummary,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { renderFoldCaptureSection } from "../continuity/continuity-briefing.ts";
import { readBranchLedger, spanUserEntryRefs } from "../continuity/continuity-store.ts";
import { collectActiveAnchors } from "../core/anchors.ts";
import { DEFAULT_TOKEN_FACTOR } from "../core/context-tokens.ts";
import { extractTextContent, isValidName, LABEL_PREFIX, MAX_NAME_LENGTH } from "../core/helpers.ts";
import { buildContextMessages, findLabeledEntry } from "../core/projection.ts";
import {
	accountRequest,
	estimateAdmissionTokens,
	tokenFactorOf,
} from "../core/request-accounting.ts";
import type { FoldPlanCandidate } from "../ui/fold-plan-screen.ts";
import { type FoldTargetCandidate, selectFoldTarget } from "./fold-engine.ts";
import { anchorMessageIndex, buildFoldProjection, buildInContextMessages } from "./fold-inputs.ts";
import {
	MIN_SUMMARY_FOCUS_LENGTH,
	RECOVERY_HEADROOM_TOKENS,
	START_ANCHOR_LABEL,
} from "./fold-policy.ts";
import { previewFoldCommit } from "./fold-preview.ts";
import { buildRewindDoneText } from "./fold-receipts.ts";
import {
	DEFAULT_REDUCE_OUTPUT_TOKENS,
	reasoningAllowance,
	type SummarizeFoldOptions,
} from "./fold-summarizer.ts";
import type { HandoffMode } from "./handoff.ts";
import { buildSummaryRequestText, hasOpenWork } from "./summary-prompt.ts";

/**
 * The continuity block of the summary request: what the ledger keeps in force
 * and the user messages the model may cite. Absent (the request is then
 * byte-identical to one without a ledger) when the ledger has nothing active
 * and the folded span holds no user message. Fail-open: a fold never depends
 * on it.
 */
export function continuityRequestSection(
	sm: SessionManager,
	fold: { target: string; rewindTo: string },
): string | undefined {
	try {
		const branch = sm.getBranch();
		const { ledger } = readBranchLedger(branch);
		const userEntries = spanUserEntryRefs(branch, fold.target);
		if (userEntries.length === 0 && !ledger.items.some((item) => item.status === "active")) {
			return undefined;
		}
		return renderFoldCaptureSection(ledger, fold.rewindTo, userEntries);
	} catch {
		return undefined;
	}
}

/**
 * The shared admission policy for the engine's in-context request: the
 * estimate of the complete request (system prompt and tools included), the
 * output allowance and the recovery headroom must fit the model's window.
 */
export function foldAdmission(
	contextWindow: number,
	factor = DEFAULT_TOKEN_FACTOR,
): SummarizeFoldOptions["admit"] {
	return (request, maxOutputTokens) => {
		const inputEstimate =
			accountRequest(
				[
					...(request.systemPrompt
						? [
								{
									role: "system" as const,
									content: request.systemPrompt,
									timestamp: 0,
								},
							]
						: []),
					...request.messages,
				],
				factor,
			).tokens +
			(request.tools ? Math.ceil((JSON.stringify(request.tools).length / 4) * factor) : 0);
		return {
			fits: inputEstimate + maxOutputTokens + RECOVERY_HEADROOM_TOKENS <= contextWindow,
			inputEstimate,
		};
	};
}

/** Output cap the reduce pass and a prospective summary are sized to. */
export function foldSummaryPlaceholderTokens(maxTokens: number | undefined): number {
	return Math.min(
		DEFAULT_REDUCE_OUTPUT_TOKENS,
		typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : DEFAULT_REDUCE_OUTPUT_TOKENS,
	);
}

/** A valid summary whose text estimates to `tokens` at four characters per token. */
export function foldPlaceholderSummary(tokens: number): string {
	const head = "## Goal\nContinue the latest request and the open work.\n";
	const chars = Math.max(1, tokens) * 4;
	if (head.length >= chars) return head.slice(0, chars);
	return head + "x".repeat(chars - head.length);
}

/**
 * Tokens the post-fold request may use: the window minus the hint reserve, or
 * 75% of the window when the hint is off.
 */
export function foldRecommendationBudget(
	contextWindow: number,
	hintReserve: number | null,
): number {
	if (contextWindow <= 0) return 0;
	const reserve = hintReserve === null ? Math.floor(contextWindow * 0.25) : hintReserve;
	return Math.max(0, contextWindow - reserve);
}

/** Index of {@link selectFoldTarget}'s choice, or undefined when none is valid. */
export function recommendFoldIndex<T extends FoldTargetCandidate>(
	candidates: readonly T[],
	budget: number,
): number | undefined {
	const selected = selectFoldTarget(candidates, budget);
	if (!selected.ok) return undefined;
	const index = candidates.indexOf(selected.candidate);
	return index >= 0 ? index : undefined;
}

/** One priced fold target, root to leaf, for the plan and for recovery or auto. */
export interface FoldCandidatePrice extends FoldPlanCandidate {
	targetId: string;
}

/**
 * What a fold would replay for Strategy A, or undefined when that request cannot
 * be captured. Without `targetId` every message is summarized.
 */
export function preparedInContext(
	sm: SessionManager,
	targetId: string | undefined,
	throughId: string,
	captured: { modelKey: string; messages: Message[] } | undefined,
	model: { provider: string; id: string } | undefined,
): SummarizeFoldOptions["inContext"] | undefined {
	if (!captured || !model || captured.modelKey !== `${model.provider}/${model.id}`)
		return undefined;
	const allEntries = sm.getEntries();
	const leafId = sm.getLeafId();
	if (!leafId) return undefined;
	const projection = buildFoldProjection(allEntries, leafId, throughId);
	const projectedMessages = buildContextMessages({
		buildContextEntries: () => sm.buildContextEntries(),
		buildSessionProjection: () => projection,
		getBranch: () => sm.getBranch(),
		getLabel: (id) => sm.getLabel(id),
	});
	return buildInContextMessages(
		captured.messages,
		projectedMessages,
		targetId === undefined
			? -1
			: anchorMessageIndex(
					{
						entries: projection.entries.map((entry) => ({
							...entry,
							messages: entry.messages.filter((message) => message.role !== "system"),
						})),
					},
					targetId,
				),
	);
}

/** The reduce allowance `summarizeFold` admits, including the runner's window cap. */
export function summarizerReduceTokens(
	model:
		| {
				maxTokens?: number;
				contextWindow?: number;
		  }
		| undefined,
): number {
	const runnerMax = summarizerOutputCap(model);
	if (runnerMax === undefined) return foldSummaryPlaceholderTokens(undefined);
	return Math.min(DEFAULT_REDUCE_OUTPUT_TOKENS, runnerMax);
}

/** `createFoldSummaryRunner`'s response cap, or undefined without a model limit. */
export function summarizerOutputCap(
	model: { maxTokens?: number; contextWindow?: number } | undefined,
): number | undefined {
	const maxTokens = model?.maxTokens;
	if (typeof maxTokens !== "number" || maxTokens <= 0) return undefined;
	return Math.min(maxTokens, Math.floor((model?.contextWindow ?? 0) / 4));
}

function previewStrategy(
	inContext: SummarizeFoldOptions["inContext"] | undefined,
	contextWindow: number,
	reduceOut: number,
	focus: string,
	parent: { mode: HandoffMode; childCount: number },
	continuitySection: string | undefined,
	factor: number,
): "in-context" | "chunked" {
	if (!inContext) return "chunked";
	const admitted = foldAdmission(contextWindow, factor)(
		{
			...(inContext.systemPrompt === undefined ? {} : { systemPrompt: inContext.systemPrompt }),
			...(inContext.tools === undefined ? {} : { tools: inContext.tools }),
			messages: [
				...inContext.messages,
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildSummaryRequestText(inContext.first, focus, parent, continuitySection),
						},
					],
					timestamp: 0,
				},
			],
		},
		reduceOut,
	);
	return admitted.fits ? "in-context" : "chunked";
}

const FOCUS_REQUEST_CHARS = 400;

/** Focus for a manual fold: the latest user request and whether a handoff still has open work. */
export function defaultFoldFocus(sm: SessionManager): string {
	let latest = "";
	let newestSummary = "";
	try {
		for (const entry of sm.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const text = extractTextContent(entry.message.content).replace(/\s+/g, " ").trim();
				if (text) latest = text;
			} else if (entry.type === "branch_summary") {
				newestSummary = entry.summary;
			}
		}
	} catch {
		latest = "";
		newestSummary = "";
	}
	const open = newestSummary !== "" && hasOpenWork(newestSummary);
	const request = latest
		? `Latest request: ${latest.slice(0, FOCUS_REQUEST_CHARS).trimEnd()}`
		: "Latest request: continue the work on this branch.";
	const remaining = open
		? "Open work remains in the newest handoff; continue it rather than wrapping up."
		: "Continue the unfinished work still on this branch from that request.";
	const focus = `${request} ${remaining}`;
	return focus.length >= MIN_SUMMARY_FOCUS_LENGTH
		? focus
		: `${focus} Continue the authorized work.`;
}

/**
 * Price every active anchor with the commit preview, including full child
 * handoffs, the ledger and the continuation. `projectedAfterTokens` is that
 * preview, never the anchor's own footprint subtracted from the current total.
 */
export function priceFoldCandidates(
	sm: SessionManager,
	input: {
		model?:
			| {
					provider: string;
					id: string;
					contextWindow?: number;
					maxTokens?: number;
			  }
			| undefined;
		handoffMode: HandoffMode;
		captured?: { modelKey: string; messages: Message[] } | undefined;
		focus: string;
		suggestLabel(anchorName: string): string;
		/** Last folded entry. Later user and custom input is priced as late, not subtracted. */
		foldPointId?: string;
		/** The summarizer's reasoning level; its allowance decides whether the in-context call fits. */
		thinking?: ThinkingLevel | "off";
	},
): FoldCandidatePrice[] {
	const contextWindow = input.model?.contextWindow ?? 0;
	const beforeTokens = estimateAdmissionTokens(sm);
	const reduceOut = summarizerReduceTokens(input.model);
	const reduceCeiling = Math.min(
		reduceOut + reasoningAllowance(input.thinking ?? "off"),
		summarizerOutputCap(input.model) ?? Number.POSITIVE_INFINITY,
	);
	const placeholder = foldPlaceholderSummary(reduceOut);
	const leafId = input.foldPointId ?? sm.getLeafId();
	return collectActiveAnchors(sm).map((anchor) => {
		const suggestedLabel = input.suggestLabel(anchor.name);
		const targetId = findLabeledEntry(sm, LABEL_PREFIX + anchor.name) ?? "";
		const priced = {
			name: anchor.name,
			targetId,
			...(LABEL_PREFIX + anchor.name === START_ANCHOR_LABEL ? { auto: true as const } : {}),
			...(anchor.hint ? { afterPreview: anchor.hint } : {}),
			beforeTokens,
			projectedAfterTokens: beforeTokens,
			contextWindow,
			strategy: "chunked" as const,
			suggestedLabel,
		};
		if (!leafId || !targetId || !isValidName(anchor.name)) {
			return {
				...priced,
				valid: false,
				reason: !isValidName(anchor.name)
					? `anchor names are kebab-case, at most ${MAX_NAME_LENGTH} characters`
					: `'${anchor.name}' is no longer on the active branch`,
			};
		}
		let strategy: "in-context" | "chunked" = "chunked";
		try {
			const { entries } = collectEntriesForBranchSummary(sm, leafId, targetId);
			strategy = previewStrategy(
				preparedInContext(sm, targetId, leafId, input.captured, input.model),
				contextWindow,
				reduceCeiling,
				input.focus,
				{
					mode: input.handoffMode,
					childCount: entries.filter((entry) => entry.type === "branch_summary").length,
				},
				continuityRequestSection(sm, {
					target: targetId,
					rewindTo: anchor.name,
				}),
				tokenFactorOf(sm),
			);
		} catch {
			strategy = "chunked";
		}
		try {
			const preview = previewFoldCommit(sm, {
				targetId,
				rewindTo: anchor.name,
				newLabel: suggestedLabel,
				summaryText: placeholder,
				handoffMode: input.handoffMode,
				contextWindow,
				foldPointId: leafId,
				continuationText: (afterTokens) =>
					buildRewindDoneText(
						{
							rewindTo: anchor.name,
							newLabel: suggestedLabel,
							beforeTokens,
							contextWindow,
						},
						afterTokens,
					),
			});
			if (!preview.ok) {
				return { ...priced, strategy, valid: false, reason: preview.reason };
			}
			return {
				...priced,
				strategy,
				valid: true,
				projectedAfterTokens: preview.projectedAfterTokens,
			};
		} catch (error) {
			return {
				...priced,
				strategy,
				valid: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
