/**
 * Retirement-check cases, derived from the labelled supersession cases: one
 * case per (supersession case, active item), asking whether the message
 * replaces that item. Run with `run.ts --cases scripts/classifier-eval/retirement-cases.ts`.
 *
 * Label of an item, from the parent's `contradicts` reference:
 *   positive   the item is a reference answer and `none` is not: truly replaced
 *   negative   the item is not a reference answer: confirming it is unsafe
 *   ambiguous  the item and `none` are both reference answers: either verdict is fine
 */

import {
	RETIREMENT_NO,
	RETIREMENT_QUESTION,
	RETIREMENT_YES,
} from "../../src/continuity/retirement-check.ts";
import { CASES as SOURCE_CASES } from "./cases.ts";
import type { EvalCase, ExpectedAnswer } from "./types.ts";

export type RetirementLabel = "positive" | "negative" | "ambiguous";

/** Id of the retirement case for `itemId` of the supersession case `parentId`. */
export const retirementCaseId = (parentId: string, itemId: string): string =>
	`retire-${parentId.replace(/^supersession-/, "")}-${itemId.toLowerCase()}`;

/** The label a retirement case was derived with, read from its reference. */
export function retirementLabel(fixture: EvalCase): RetirementLabel {
	const { choices } = fixture.expected[RETIREMENT_QUESTION] ?? {
		choices: [],
	};
	return choices.length === 2
		? "ambiguous"
		: choices[0] === RETIREMENT_YES
			? "positive"
			: "negative";
}

function reference(label: RetirementLabel, parent: ExpectedAnswer): ExpectedAnswer {
	const why = parent.rationale;
	if (label === "positive")
		return {
			choices: [RETIREMENT_YES],
			unsafeChoices: [],
			rationale: `The message replaces this item. ${why}`,
		};
	if (label === "ambiguous")
		return {
			choices: [RETIREMENT_YES, RETIREMENT_NO],
			unsafeChoices: [],
			rationale: `Replacing this item is defensible but not required. ${why}`,
		};
	return {
		choices: [RETIREMENT_NO],
		unsafeChoices: [RETIREMENT_YES],
		rationale: `The message does not replace this item; confirming it would be a wrong retirement. ${why}`,
	};
}

/** One retirement case per active item of every supersession case, in source order. */
export function retirementCases(source: readonly EvalCase[]): readonly EvalCase[] {
	return source.flatMap((parent) => {
		if (parent.task !== "supersession" || parent.input.type !== "intent") return [];
		const { message, activeItems } = parent.input;
		const answer = parent.expected.contradicts;
		if (!answer) return [];
		return activeItems.map((item): EvalCase => {
			const named = answer.choices.includes(item.id);
			const label: RetirementLabel = !named
				? "negative"
				: answer.choices.includes("none")
					? "ambiguous"
					: "positive";
			return {
				id: retirementCaseId(parent.id, item.id),
				split: parent.split,
				family: parent.family,
				task: "retirement-check",
				input: {
					type: "retirement",
					message,
					item,
					otherItems: activeItems.filter((other) => other.id !== item.id),
				},
				expected: { [RETIREMENT_QUESTION]: reference(label, answer) },
			};
		});
	});
}

export const CASES: readonly EvalCase[] = retirementCases(SOURCE_CASES);
