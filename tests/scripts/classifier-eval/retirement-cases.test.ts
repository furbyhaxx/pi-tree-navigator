import { test } from "bun:test";
import assert from "node:assert/strict";
import { CASES as SOURCE_CASES } from "../../../scripts/classifier-eval/cases.ts";
import { prepareCase } from "../../../scripts/classifier-eval/prepare.ts";
import {
	CASES,
	type RetirementLabel,
	retirementCaseId,
	retirementCases,
	retirementLabel,
} from "../../../scripts/classifier-eval/retirement-cases.ts";
import { scoreObservation } from "../../../scripts/classifier-eval/scoring.ts";
import type { EvalCase, EvalObservation } from "../../../scripts/classifier-eval/types.ts";

const MAX_STATE_BYTES = 3_000;

// The leak patterns of cases.test.ts: annotator vocabulary must never reach a request.
const LEAK_PATTERNS: RegExp[] = [
	/classif/i,
	/expected/i,
	/label/i,
	/the answer/i,
	/this is a rule/i,
	/not a lasting/i,
	/annotat/i,
	/ground truth/i,
	/rationale/i,
	/correct choice/i,
	/\bunsafe\b/i,
	/\b(positive|negative|ambiguous|superseded|retired)\b/i,
	/[[(](rule|decision|objective|sub-goal|steering|ephemeral|milestone|await-user|blocked)[\])]/i,
];

const parents = SOURCE_CASES.filter((c) => c.task === "supersession");
const parentById = new Map(
	parents.flatMap((parent) =>
		parent.input.type === "intent"
			? parent.input.activeItems.map(
					(item) => [retirementCaseId(parent.id, item.id), parent] as const,
				)
			: [],
	),
);
const parentOf = (c: EvalCase) => {
	const parent = parentById.get(c.id);
	assert.ok(parent, c.id);
	return parent;
};
const retirementInput = (c: EvalCase) => {
	assert.equal(c.input.type, "retirement");
	return c.input;
};
const textsOf = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: Array.isArray(value)
			? value.flatMap(textsOf)
			: value && typeof value === "object"
				? Object.values(value).flatMap(textsOf)
				: [];
const count = (cases: readonly EvalCase[], label: RetirementLabel) =>
	cases.filter((c) => retirementLabel(c) === label).length;

test("one case per supersession case and active item, split and family kept", () => {
	assert.equal(
		CASES.length,
		parents.reduce(
			(sum, p) => sum + (p.input.type === "intent" ? p.input.activeItems.length : 0),
			0,
		),
	);
	assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
	for (const c of CASES) {
		const parent = parentOf(c);
		const { item, otherItems = [] } = retirementInput(c);
		assert.equal(c.task, "retirement-check");
		assert.equal(c.split, parent.split, c.id);
		assert.equal(c.family, parent.family, c.id);
		assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)+$/, c.id);
		assert.equal(c.id, retirementCaseId(parent.id, item.id));
		assert.ok(parent.input.type === "intent");
		assert.deepEqual(
			[item, ...otherItems].map((i) => i.id).sort(),
			parent.input.activeItems.map((i) => i.id).sort(),
			c.id,
		);
		assert.equal(retirementInput(c).message, parent.input.message, c.id);
	}
});

test("derivation is deterministic", () => {
	assert.deepEqual(retirementCases(SOURCE_CASES), CASES);
});

test("positives are the replaced items, negatives every other item", () => {
	for (const parent of parents) {
		const own = CASES.filter((c) => parentOf(c) === parent);
		const answer = parent.expected["contradicts"];
		assert.ok(answer, `${parent.id} needs a contradicts reference`);
		const { choices, unsafeChoices } = answer;
		const ambiguous = choices.includes("none");
		const replaced = choices.filter((id) => id !== "none");
		assert.equal(count(own, "positive"), ambiguous ? 0 : replaced.length, parent.id);
		assert.equal(count(own, "ambiguous"), ambiguous ? replaced.length : 0, parent.id);
		assert.equal(count(own, "negative"), unsafeChoices.length, parent.id);
		for (const c of own) {
			const { item } = retirementInput(c);
			assert.equal(retirementLabel(c) === "negative", unsafeChoices.includes(item.id), c.id);
		}
	}
});

test("only a confirmed negative is unsafe; a missed positive is merely wrong", () => {
	const verdict = (c: EvalCase, choice: string): ReturnType<typeof scoreObservation> => {
		const observation: EvalObservation = {
			caseId: c.id,
			model: "decisions:x/y",
			adapter: "decisions",
			repetition: 0,
			status: "ok",
			answers: { retires: { choice, confidence: 0.9 } },
			durationMs: 1,
			costUsd: 0,
			costSource: "local",
			costBoundUsd: 0,
			startedAt: "2026-10-23T00:00:00.000Z",
		};
		return scoreObservation(prepareCase(c), observation);
	};
	for (const c of CASES) {
		const yes = verdict(c, "yes");
		const no = verdict(c, "no");
		const label = retirementLabel(c);
		assert.equal(yes.unsafeAccepted, label === "negative" ? 1 : 0, c.id);
		assert.equal(no.unsafeAccepted, 0, c.id);
		assert.equal(yes.acceptedExact, label !== "negative", c.id);
		assert.equal(no.acceptedExact, label !== "positive", c.id);
	}
});

test("requests carry no label, id of the case or reference text", () => {
	const leaky = "This is positive: the message replaced it.";
	assert.ok(LEAK_PATTERNS.some((p) => p.test(leaky)));
	for (const c of CASES) {
		const { context } = prepareCase(c);
		const state = JSON.stringify(context.state);
		const text = textsOf(context.state).join("\n");
		for (const pattern of LEAK_PATTERNS) assert.doesNotMatch(text, pattern, `${c.id}: ${pattern}`);
		assert.ok(!state.includes(c.id) && !state.includes(parentOf(c).id), c.id);
		assert.deepEqual(Object.keys(context.state as object), ["message", "item", "otherItems"], c.id);
		for (const answer of Object.values(c.expected))
			assert.ok(!state.includes(answer.rationale) && answer.rationale.length > 20, c.id);
		assert.ok(Buffer.byteLength(state) < MAX_STATE_BYTES, `${c.id}: ${state.length} bytes`);
	}
});

test("the positive and the negatives of one message differ only in the asked item", () => {
	for (const parent of parents) {
		const own = CASES.filter((c) => parentOf(c) === parent);
		const messages = new Set(own.map((c) => retirementInput(c).message));
		assert.equal(messages.size, 1, parent.id);
		for (const c of own) {
			const { item, otherItems = [] } = retirementInput(c);
			const order = [item, ...otherItems]
				.map((i) => i.id)
				.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
			assert.ok(parent.input.type === "intent");
			assert.deepEqual(
				order,
				parent.input.activeItems
					.map((i) => i.id)
					.sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
				c.id,
			);
			assert.deepEqual(
				otherItems.map((i) => i.id),
				parent.input.activeItems.map((i) => i.id).filter((id) => id !== item.id),
				`${c.id}: other items keep the ledger order`,
			);
		}
	}
});

test("no family spans development and holdout and each split has every label", () => {
	const splits = new Map<string, Set<string>>();
	for (const c of CASES) splits.set(c.family, (splits.get(c.family) ?? new Set()).add(c.split));
	for (const [family, seen] of splits)
		assert.equal(seen.size, 1, `family ${family} spans both splits`);
	for (const split of ["development", "holdout"] as const) {
		const inSplit = CASES.filter((c) => c.split === split);
		for (const label of ["positive", "negative", "ambiguous"] as const)
			assert.ok(count(inSplit, label) >= 2, `${split} ${label}`);
		assert.ok(count(inSplit, "negative") > count(inSplit, "positive"), split);
	}
});
