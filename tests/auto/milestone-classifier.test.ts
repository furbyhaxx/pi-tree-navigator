import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	BASE_WORDING,
	buildMilestoneClassifierContext,
	INSTRUCTED_WORDING,
	instructedWording,
	MAX_STRUCTURE_ITEMS,
	NO_BOUNDARY,
} from "../../src/auto/milestone-classifier.ts";

const records = [
	{ id: "r1", role: "user" as const, text: "Add the parser." },
	{ id: "r2", role: "assistant" as const, text: "Parser added and tested." },
];

describe("milestone classifier context", () => {
	it("leaves the request without structure unchanged", () => {
		const { context } = buildMilestoneClassifierContext({
			records,
			lastAnchor: "start",
		});
		assert.deepEqual(Object.keys(context.state as object), ["note", "lastAnchor", "records"]);
	});

	it("sends the newest structure items with bounded text", () => {
		const folds = Array.from({ length: MAX_STRUCTURE_ITEMS + 3 }, (_, i) => ({
			label: `phase-${i}`,
			title: `Phase ${i}`,
			outcome: "x".repeat(1_000),
		}));
		const { context } = buildMilestoneClassifierContext({
			records,
			structure: {
				objective: "Ship the parser",
				folds,
				anchors: [{ name: "parser-start", afterRecordId: "r1" }],
			},
		});
		const structure = (
			context.state as {
				structure: {
					objective: string;
					folds: { label: string; outcome: string }[];
					anchors: unknown[];
				};
			}
		).structure;
		assert.equal(structure.objective, "Ship the parser");
		assert.equal(structure.folds.length, MAX_STRUCTURE_ITEMS);
		const firstFold = structure.folds[0];
		assert.ok(firstFold);
		assert.equal(firstFold.label, "phase-3");
		assert.ok(firstFold.outcome.length <= 300);
		assert.deepEqual(structure.anchors, [{ name: "parser-start", afterRecordId: "r1" }]);
	});
});

describe("milestone question wording", () => {
	const sent = (wording?: Parameters<typeof buildMilestoneClassifierContext>[1]) =>
		buildMilestoneClassifierContext({ records }, wording).context;

	it("sends the base wording unless another is given", () => {
		assert.deepEqual(sent(), sent(BASE_WORDING));
		assert.notDeepEqual(sent(INSTRUCTED_WORDING).questions, sent().questions);
	});

	it("changes only the question text, never the state or the offered choices", () => {
		const base = sent();
		const instructed = sent(INSTRUCTED_WORDING);
		assert.deepEqual(instructed.state, base.state);
		for (const id of ["status", "boundary"]) {
			const choices = (context: typeof base) => {
				const question = context.questions[id];
				assert.equal(question?.type, "choice");
				return question?.type === "choice" ? Object.keys(question.criteria) : [];
			};
			assert.deepEqual(choices(instructed), choices(base));
		}
		assert.deepEqual(Object.keys(instructed.questions), ["status", "boundary"]);
	});

	it("replaces the instructions of one question and keeps its criteria", () => {
		const wording = instructedWording({ status: "Custom status question" });
		assert.equal(wording.status.instructions, "Custom status question");
		assert.deepEqual(wording.status.criteria, INSTRUCTED_WORDING.status.criteria);
		assert.equal(wording.boundary.instructions, INSTRUCTED_WORDING.boundary.instructions);
		const boundary = sent(wording).questions["boundary"];
		assert.ok(boundary?.type === "choice");
		assert.equal(boundary.criteria[NO_BOUNDARY], INSTRUCTED_WORDING.boundary.none);
	});
});
