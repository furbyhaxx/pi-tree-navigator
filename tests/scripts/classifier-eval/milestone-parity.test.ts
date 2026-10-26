import { beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { analyze, loadRun, type Metrics } from "../../../scripts/classifier-eval/analyze.ts";
import { CASES } from "../../../scripts/classifier-eval/cases.ts";
import {
	type CaseParity,
	compareCase,
	decisionVerdict,
	HISTORIC_MILESTONE_MODELS,
	HISTORIC_MILESTONE_POLICY_SETTING,
	harnessConfirm,
	holds,
	JEV_LABEL as JEV,
	judge,
	LUNA_LABEL as LUNA,
	milestoneInput,
	selectCases,
	summarize,
	type Verdict,
} from "../../../scripts/classifier-eval/milestone-parity.ts";
import type { CallRecord } from "../../../scripts/classifier-eval/parity.ts";
import { prepareCase } from "../../../scripts/classifier-eval/prepare.ts";
import type { EvalObservation, PreparedCase } from "../../../scripts/classifier-eval/types.ts";
import { evaluateMilestone, resolveMilestonePolicy } from "../../../src/auto/milestone-policy.ts";
import type { PolicyRegistry } from "../../../src/continuity/intent-policy.ts";

const RUNS = new URL("../../../.project/analyses/classifier-eval/runs/", import.meta.url);
const CONFIRM = `confirm(${JEV} + ${LUNA})`;

/** A registry that answers each model with its recorded observation of one case. */
function recordedRegistry(jev: EvalObservation, luna: EvalObservation): PolicyRegistry {
	const failed = (observation: EvalObservation) => observation.error ?? observation.status;
	return {
		getAvailableOfType: async (type: string) =>
			type === "classifier"
				? [
						{
							provider: HISTORIC_MILESTONE_MODELS.provider,
							id: HISTORIC_MILESTONE_MODELS.classifier,
						},
					]
				: [
						{
							provider: HISTORIC_MILESTONE_MODELS.provider,
							id: HISTORIC_MILESTONE_MODELS.confirmer,
							api: "openai-completions",
						},
					],
		classify: async () =>
			jev.status === "ok"
				? {
						stopReason: "stop",
						answers: Object.fromEntries(
							Object.entries(jev.answers).map(([id, answer]) => [
								id,
								{
									type: "choice",
									choice: answer.choice,
									confidence: answer.confidence ?? 0,
									probabilities: {},
								},
							]),
						),
					}
				: { stopReason: "error", answers: {}, errorMessage: failed(jev) },
		streamSimple: () => ({
			result: async () =>
				luna.status === "ok"
					? {
							stopReason: "stop",
							content: [
								{
									type: "text",
									text: JSON.stringify({ answers: luna.answers }),
								},
							],
						}
					: { stopReason: "error", content: [], errorMessage: failed(luna) },
		}),
	} as unknown as PolicyRegistry;
}

interface Tally {
	decisions: number;
	accepted: number;
	unsafeAccepted: number;
	acceptedExact: number;
}

const emptyTally = (): Tally => ({
	decisions: 0,
	accepted: 0,
	unsafeAccepted: 0,
	acceptedExact: 0,
});

describe("recorded holdout v3 observations replayed through the production policy", () => {
	const policy = resolveMilestonePolicy(HISTORIC_MILESTONE_POLICY_SETTING);
	const production: Record<string, Tally> = {};
	const harness: Record<string, Tally> = {};
	const mismatches: string[] = [];
	let analysed: Awaited<ReturnType<typeof analyze>>;

	beforeAll(async () => {
		assert.ok(policy);
		const prepared = CASES.filter((c) => c.input.type === "milestone").map(prepareCase);
		const byId = new Map(prepared.map((c) => [c.id, c]));
		const observations = (
			await Promise.all(
				["milestone-spikes-2026-10-23/dev-1", "holdout-v3-2026-10-23/milestone"].map((dir) =>
					loadRun(new URL(dir, RUNS).pathname),
				),
			)
		).flatMap((run) => run.observations.filter((o) => o.model === JEV || o.model === LUNA));
		const key = (o: EvalObservation) => `${o.caseId}\u0000${o.repetition}`;
		const jev = new Map(observations.filter((o) => o.model === JEV).map((o) => [key(o), o]));
		const luna = new Map(observations.filter((o) => o.model === LUNA).map((o) => [key(o), o]));
		for (const [id, first] of jev) {
			const second = luna.get(id);
			const fixture = byId.get(first.caseId);
			if (!second || !fixture) continue;
			const evaluation = await evaluateMilestone({
				policy,
				registry: recordedRegistry(first, second),
				input: milestoneInput(fixture),
			});
			const live = decisionVerdict(evaluation);
			const expected = harnessConfirm(fixture, first, second);
			const group = `${fixture.task}/${fixture.split}`;
			if (JSON.stringify(live) !== JSON.stringify(expected))
				mismatches.push(`${id}: ${JSON.stringify(live)} vs ${JSON.stringify(expected)}`);
			for (const [tallies, verdict] of [
				[production, live],
				[harness, expected],
			] as const) {
				const t = tallies[group] ?? emptyTally();
				tallies[group] = t;
				const judged = judge(fixture, verdict);
				t.decisions++;
				t.accepted += judged.accepted;
				t.unsafeAccepted += judged.unsafe;
				if (judged.acceptedExact) t.acceptedExact++;
			}
		}
		analysed = await analyze({ cases: prepared, observations }, { top: 8 });
	});

	it("decides exactly what the benchmark's confirm of the same answers decides, per decision", () => {
		assert.deepEqual(mismatches, []);
		assert.deepEqual(production, harness);
		for (const group of [
			"milestone-status/holdout",
			"milestone-boundary/holdout",
			"milestone-status/development",
			"milestone-boundary/development",
		])
			assert.ok((production[group]?.decisions ?? 0) > 0, group);
	});

	it("reproduces the accepted, unsafe and accepted-exact counts of analyze.ts for both questions and splits", () => {
		for (const task of ["milestone-status", "milestone-boundary"] as const) {
			const row = analysed.tasks[task]?.ranking.pipelines.find((r) => r.id === CONFIRM);
			assert.ok(row, `${task}: no ${CONFIRM}`);
			for (const split of ["development", "holdout"] as const) {
				const metrics: Metrics | null = row[split];
				assert.ok(metrics, `${task}/${split}`);
				assert.deepEqual(production[`${task}/${split}`], {
					decisions: metrics.decisions,
					accepted: metrics.accepted,
					unsafeAccepted: metrics.unsafeAccepted,
					acceptedExact: metrics.acceptedExactCases,
				});
			}
		}
	});

	it("keeps the evidence behind the preset: no unsafe accepted answer, 62 of 96 status and 73 of 96 boundary decisions accepted-exact on holdout", () => {
		for (const group of Object.keys(production))
			assert.equal(production[group]?.unsafeAccepted, 0, group);
		assert.equal(production["milestone-status/holdout"]?.decisions, 96);
		assert.equal(production["milestone-status/holdout"]?.acceptedExact, 62);
		assert.equal(production["milestone-boundary/holdout"]?.decisions, 96);
		assert.equal(production["milestone-boundary/holdout"]?.acceptedExact, 73);
	});
});

// ---------------------------------------------------------------------------
// The live comparison itself
// ---------------------------------------------------------------------------

describe("live parity comparison", () => {
	const fixture: PreparedCase = prepareCase({
		id: "m-1",
		split: "holdout",
		family: "f",
		task: "milestone-status",
		input: {
			type: "milestone",
			records: [
				{ id: "u1", role: "user", text: "Add the command." },
				{ id: "a1", role: "assistant", text: "Done; tests pass." },
			],
		},
		expected: {
			status: {
				choices: ["milestone"],
				unsafeChoices: ["continue"],
				rationale: "r",
			},
			boundary: { choices: ["a1"], unsafeChoices: ["none"], rationale: "r" },
		},
	});
	const observation = (
		label: string,
		status: string,
		boundary: string,
		sha: string,
	): EvalObservation => ({
		caseId: "m-1",
		model: label,
		adapter: label.startsWith("chat") ? "chat" : "decisions",
		repetition: 0,
		status: "ok",
		answers: {
			status: { choice: status, confidence: 0.9 },
			boundary: { choice: boundary, confidence: 0.9 },
		},
		durationMs: 1,
		costUsd: 0,
		costSource: "generation",
		costBoundUsd: 0,
		requestSha256: sha,
		startedAt: "",
	});
	const call = (
		kind: "classify" | "chat",
		status: string,
		boundary: string,
		sha: string,
	): CallRecord => {
		const answers = {
			status: { choice: status, confidence: 0.9 },
			boundary: { choice: boundary, confidence: 0.9 },
		};
		return {
			seq: 1,
			caseId: "m-1",
			kind,
			model: "m",
			status: "ok",
			...(kind === "classify" ? { answers } : { text: JSON.stringify({ answers }) }),
			requestSha256: sha,
			durationMs: 1,
			costBoundUsd: 0.01,
			costUsd: 0.0001,
			costSource: "generation",
		};
	};
	const benchmark = [
		observation(JEV, "milestone", "a1", "sha-jev"),
		observation(LUNA, "milestone", "a1", "sha-luna"),
	];
	const evaluation = (status: string, boundary: string) =>
		({
			status: { kind: "accept", status },
			boundary: { kind: "record", recordId: boundary },
			ran: [{}, {}],
			usage: {},
			warnings: [],
		}) as unknown as Parameters<typeof compareCase>[1];

	it("accepts a decision equal to the benchmark's confirm of the live answers with identical requests", () => {
		const result = compareCase(
			fixture,
			evaluation("milestone", "a1"),
			[call("classify", "milestone", "a1", "sha-jev"), call("chat", "milestone", "a1", "sha-luna")],
			benchmark,
		);
		assert.deepEqual(result.requestMatches, {
			classifier: true,
			confirmer: true,
		});
		assert.equal(result.consistent, true);
		assert.equal(result.matchesRecorded, true);
		assert.equal(result.acceptedExact, true);
		assert.equal(holds([result]), true);
		assert.equal(summarize([result]).requestsMatching, "2/2");
	});

	it("flags a request that differs from the recorded one, and a decision the benchmark would not make", () => {
		const changed = compareCase(
			fixture,
			evaluation("milestone", "a1"),
			[call("classify", "milestone", "a1", "other"), call("chat", "milestone", "a1", "sha-luna")],
			benchmark,
		);
		assert.equal(changed.requestMatches.classifier, false);
		assert.equal(holds([changed]), false);

		const split = compareCase(
			fixture,
			evaluation("milestone", "a1"),
			[call("classify", "milestone", "a1", "sha-jev"), call("chat", "continue", "a1", "sha-luna")],
			benchmark,
		);
		assert.deepEqual(split.harness, { status: undefined, boundary: "a1" });
		assert.equal(split.consistent, false);
		assert.equal(holds([split]), false);
	});

	it("counts an accepted unsafe decision as a failure", () => {
		const verdict: Verdict = { status: "continue", boundary: "none" };
		assert.deepEqual(judge(fixture, verdict), {
			accepted: 2,
			unsafe: 2,
			acceptedExact: false,
		});
		const unsafe: CaseParity = {
			...compareCase(
				fixture,
				evaluation("continue", "a1"),
				[call("classify", "continue", "a1", "sha-jev"), call("chat", "continue", "a1", "sha-luna")],
				benchmark,
			),
		};
		assert.equal(unsafe.unsafeAccepted, 1);
		assert.equal(holds([unsafe]), false);
	});

	it("selects evenly spaced holdout cases of both milestone tasks", () => {
		const picked = selectCases(CASES, 8);
		assert.equal(picked.length, 16);
		assert.equal(new Set(picked.map((c) => c.id)).size, 16);
		for (const task of ["milestone-status", "milestone-boundary"])
			assert.equal(picked.filter((c) => c.task === task).length, 8);
		assert.ok(picked.every((c) => c.split === "holdout"));
	});
});
