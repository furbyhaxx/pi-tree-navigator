/**
 * Retirement check: the request that asks a classifier whether a user message
 * replaces one specific ledger item, so a proposed retirement of that item can
 * be confirmed before it applies.
 *
 * The request is a plain choice question, so it goes through `classifierAsk`
 * (decision models) and `chatAsk` (chat models) of `intent-policy.ts` unchanged.
 * No I/O.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import { capText } from "./continuity-ledger.ts";
import type { StageAnswer } from "./intent-policy.ts";

/** Id of the one question; its answer is `yes` or `no`. */
export const RETIREMENT_QUESTION = "retires";
export const RETIREMENT_YES = "yes";
export const RETIREMENT_NO = "no";

// Same bounds as the intent request, so a message or item that fits there fits here.
const MAX_MESSAGE_CHARS = 4_000;
const MAX_ITEM_CHARS = 200;
const MAX_OTHER_ITEMS = 30;

export type RetirementItem = { id: string; kind: string; text: string };

export interface RetirementCheckInput {
	/** The user's message that is supposed to retire `item`. */
	message: string;
	/** The one active item whose retirement is proposed. */
	item: RetirementItem;
	/** The other active items, shown so the classifier can tell which one the message targets. */
	otherItems?: readonly RetirementItem[];
}

const oneLine = ({ id, kind, text }: RetirementItem): RetirementItem => ({
	id,
	kind,
	text: capText(text.replace(/\s+/g, " ").trim(), MAX_ITEM_CHARS),
});

/** The exact classifier request that asks whether `message` replaces `item`. */
export function buildRetirementCheckContext(input: RetirementCheckInput): {
	context: ClassifierContext;
} {
	const others = (input.otherItems ?? []).slice(0, MAX_OTHER_ITEMS);
	return {
		context: {
			state: {
				message: capText(input.message, MAX_MESSAGE_CHARS),
				item: oneLine(input.item),
				...(others.length > 0 && { otherItems: others.map(oneLine) }),
			},
			questions: {
				[RETIREMENT_QUESTION]: {
					type: "choice",
					instructions:
						"Does the message explicitly replace or reverse the one item in `item`, so that it no longer applies? Judge only that item. A message that merely relates to it, refines or narrows it, adds an exception, or changes a different item does not retire it.",
					criteria: {
						[RETIREMENT_YES]:
							"The message explicitly drops, replaces or reverses this item, so it no longer applies",
						[RETIREMENT_NO]:
							"The item still applies: the message does not mention it, only relates to it, refines it, adds an exception, or changes another item",
					},
				},
			},
		},
	};
}

/** True only for a `yes` answer with at least `minConfidence`; anything else keeps the item. */
export function retirementConfirmed(
	answers: Record<string, StageAnswer> | undefined,
	minConfidence: number,
): boolean {
	const answer = answers?.[RETIREMENT_QUESTION];
	return (
		answer !== undefined && answer.choice === RETIREMENT_YES && answer.confidence >= minConfidence
	);
}
