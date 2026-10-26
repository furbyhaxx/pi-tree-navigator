import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AnalyzeOptions,
	analyze,
	loadRun,
	parseObservations,
	type RankRow,
	renderMarkdown,
	replayVerdict,
	writeReport,
} from "../../../scripts/classifier-eval/analyze.ts";
import { prepareCase } from "../../../scripts/classifier-eval/prepare.ts";
import type {
	EvalObservation,
	EvalTask,
	PreparedCase,
} from "../../../scripts/classifier-eval/types.ts";
import { heuristicClassifier } from "../../../src/continuity/continuity-capture.ts";

const A = "decisions:t/a";
const B = "decisions:t/b";
const C = "decisions:t/c";
const RULE_MESSAGE = "From now on always use spaces, never tabs.";

const intentCase = (
	id: string,
	split: "development" | "holdout",
	choices: string[] = ["rule"],
	unsafeChoices: string[] = ["ephemeral"],
	task: EvalTask = "intent",
): PreparedCase =>
	prepareCase({
		id,
		split,
		family: "f",
		task,
		input: {
			type: "intent",
			message: "please continue with the plan",
			activeItems: [],
		},
		expected: { kind: { choices, unsafeChoices, rationale: "fixture" } },
	});

const supersedingCase = (id: string, split: "development" | "holdout"): PreparedCase =>
	prepareCase({
		id,
		split,
		family: "f",
		task: "supersession",
		input: {
			type: "intent",
			message: RULE_MESSAGE,
			activeItems: [{ id: "R1", kind: "rule", text: "Use tabs" }],
		},
		expected: {
			kind: {
				choices: ["rule"],
				unsafeChoices: ["ephemeral"],
				rationale: "fixture",
			},
			contradicts: { choices: ["R1"], unsafeChoices: [], rationale: "fixture" },
		},
	});

const milestoneCase = (id: string, split: "development" | "holdout"): PreparedCase =>
	prepareCase({
		id,
		split,
		family: "f",
		task: "milestone-status",
		input: {
			type: "milestone",
			records: [
				{ id: "m1", role: "user", text: "build it" },
				{ id: "m2", role: "assistant", text: "Built and verified." },
			],
		},
		expected: {
			status: {
				choices: ["milestone"],
				unsafeChoices: ["continue"],
				rationale: "fixture",
			},
			boundary: { choices: ["m2"], unsafeChoices: [], rationale: "fixture" },
		},
	});

const obs = (
	model: string,
	caseId: string,
	choice: string,
	confidence: number,
	over: Partial<EvalObservation> = {},
): EvalObservation => ({
	caseId,
	model,
	adapter: "decisions",
	repetition: 0,
	status: "ok",
	answers: { kind: { choice, confidence } },
	durationMs: 100,
	costUsd: 0.001,
	costSource: "generation",
	costBoundUsd: 0.002,
	startedAt: "2026-01-01T00:00:00.000Z",
	...over,
});

const failed = (
	model: string,
	caseId: string,
	status: "error" | "unsupported",
	over: Partial<EvalObservation> = {},
) => obs(model, caseId, "", 0, { status, answers: {}, ...over });

const run = (
	cases: PreparedCase[],
	observations: EvalObservation[],
	options: AnalyzeOptions = {},
) => analyze({ cases, observations }, { minCases: 1, ...options });

const row = (rows: readonly RankRow[], id: string): RankRow => {
	const found = rows.find((r) => r.id === id);
	assert.ok(found, `missing ${id} in ${rows.map((r) => r.id).join(", ")}`);
	return found;
};

test("chain consults the second model only on abstention, invalid output or error, and adds cost and latency", async () => {
	const cases = [
		intentCase("d1", "development"),
		...["c1", "c2", "c3", "c4"].map((id) => intentCase(id, "holdout")),
	];
	const report = await run(cases, [
		obs(A, "d1", "rule", 0.9),
		obs(B, "d1", "rule", 0.9, { costUsd: 0.01, durationMs: 300 }),
		obs(A, "c1", "rule", 0.9),
		obs(A, "c2", "rule", 0.5),
		obs(A, "c3", "bogus", 0.9),
		obs(A, "c4", "", 0, {
			status: "error",
			answers: {},
			durationMs: 50,
			costUsd: null,
			costBoundUsd: 0.004,
		}),
		...["c1", "c2", "c3", "c4"].map((id) =>
			obs(B, id, "rule", 0.9, { costUsd: 0.01, durationMs: 300 }),
		),
	]);
	const chain = row(report.tasks.intent?.ranking.pipelines ?? [], `chain(${A} > ${B})`);
	const h = chain.holdout;
	assert.ok(h);
	assert.equal(h.callsPerDecision, (1 + 2 + 2 + 2) / 4);
	assert.deepEqual(h.escalationReasons, {
		abstain: 1,
		invalid: 1,
		error: 1,
		unsupported: 0,
	});
	// c1 A only; c2, c3 A + B; c4 A's reserved bound (cost unknown) + B.
	const total = 0.001 + (0.001 + 0.01) * 2 + (0.004 + 0.01);
	assert.ok(Math.abs((h.costPer1000.usd ?? 0) - (total / 4) * 1000) < 1e-9);
	assert.equal(h.costPer1000.basis, "mixed");
	assert.equal(h.costPer1000.unknownDecisions, 1);
	// Latencies add: 100, 400, 400, 350.
	assert.equal(h.latency.p50Ms, 350);
	assert.equal(h.latency.p95Ms, 400);
	assert.equal(h.acceptedExactRate, 1);
	assert.equal(h.errors, 0, "A's failure is an escalation, not a failed decision");
});

test("confirm-chain never accepts when the second model disagrees", async () => {
	const cases = [
		intentCase("d1", "development"),
		intentCase("h1", "holdout"),
		intentCase("h2", "holdout"),
		intentCase("h3", "holdout"),
	];
	const cheap = { costUsd: 0.001 };
	const dear = { costUsd: 0.01 };
	const report = await run(cases, [
		obs(A, "d1", "rule", 0.9, cheap),
		obs(B, "d1", "rule", 0.9, dear),
		obs(A, "h1", "rule", 0.9, cheap),
		obs(B, "h1", "rule", 0.8, dear),
		// A is confidently unsafe, B confidently says something else.
		obs(A, "h2", "ephemeral", 0.95, cheap),
		obs(B, "h2", "decision", 0.9, dear),
		// A abstains: nothing to confirm, B is not consulted.
		obs(A, "h3", "rule", 0.5, cheap),
		obs(B, "h3", "rule", 0.9, dear),
	]);
	const tasks = report.tasks.intent;
	const confirm = row(tasks?.ranking.pipelines ?? [], `confirm(${A} + ${B})`).holdout;
	assert.ok(confirm);
	assert.equal(confirm.unsafeAccepted, 0);
	assert.equal(confirm.acceptedExactCases, 1, "only the agreed case is accepted");
	assert.equal(confirm.callsPerDecision, (2 + 2 + 1) / 3);
	assert.equal(
		row(tasks?.ranking.singles ?? [], `single(${A})`).holdout?.unsafeAccepted,
		1,
		"the same recorded answers are unsafe for A alone",
	);
});

test("majority vote accepts only a strict majority of accepted answers", async () => {
	const cases = [
		intentCase("d1", "development"),
		intentCase("h1", "holdout"),
		intentCase("h2", "holdout"),
	];
	const report = await run(cases, [
		...[A, B, C].map((m) => obs(m, "d1", "rule", 0.9)),
		obs(A, "h1", "rule", 0.9),
		obs(B, "h1", "rule", 0.9),
		obs(C, "h1", "ephemeral", 0.9),
		obs(A, "h2", "ephemeral", 0.9),
		obs(B, "h2", "rule", 0.9),
		obs(C, "h2", "rule", 0.5),
	]);
	const vote = row(report.tasks.intent?.ranking.pipelines ?? [], `vote(${A}, ${B}, ${C})`);
	assert.equal(vote.holdout?.acceptedExactCases, 1, "h2 has one accepted rule and one unsafe");
	assert.equal(vote.holdout?.unsafeAccepted, 0);
	assert.equal(vote.holdout?.callsPerDecision, 3);
});

test("production replay follows createModelClassifier: abstention keeps the heuristic rule and never supersedes", async () => {
	const fixture = supersedingCase("s1", "holdout");
	const answers = (kind: string, kindConfidence: number) => ({
		kind: { choice: kind, confidence: kindConfidence },
		contradicts: { choice: "R1", confidence: 0.95 },
	});
	const heuristic = await heuristicClassifier({
		entryId: "s1",
		text: RULE_MESSAGE,
		activeItems: [],
	});
	assert.equal(heuristic.kind, "rule");

	const abstained = await replayVerdict(
		fixture,
		obs(A, "s1", "", 0, { answers: answers("ephemeral", 0.4) }),
		0.7,
	);
	assert.deepEqual(abstained, { kind: "rule", by: "heuristic" });
	assert.equal(abstained.supersedes, undefined);

	const confident = await replayVerdict(
		fixture,
		obs(A, "s1", "", 0, { answers: answers("rule", 0.9) }),
		0.7,
	);
	assert.deepEqual(confident, {
		kind: "rule",
		supersedes: ["R1"],
		by: "classifier",
	});

	const unusable = await replayVerdict(
		fixture,
		obs(A, "s1", "", 0, {
			answers: { kind: { choice: "invented", confidence: 1 } },
		}),
		0.7,
	);
	assert.deepEqual(unusable, { kind: "rule", by: "heuristic" });

	const outage = await replayVerdict(fixture, failed(A, "s1", "error", { error: "503" }), 0.7);
	assert.equal(outage.kind, "rule");
	assert.match(outage.warning ?? "", /503/);

	const unknown = await replayVerdict(fixture, failed(A, "s1", "unsupported"), 0.7);
	assert.deepEqual(unknown, { kind: "rule", by: "heuristic" });

	const quiet = supersedingCase("s2", "holdout");
	const none = await replayVerdict(
		{
			...quiet,
			input: {
				type: "intent",
				message: "sounds good, thanks",
				activeItems: [],
			},
		},
		obs(A, "s2", "", 0, { answers: answers("rule", 0.2) }),
		0.7,
	);
	assert.deepEqual(none, { kind: "ephemeral", by: "classifier" });
});

test("replay rows score the committed verdict and exist for intent tasks only", async () => {
	const cases = [
		supersedingCase("sd", "development"),
		supersedingCase("sh", "holdout"),
		milestoneCase("md", "development"),
		milestoneCase("mh", "holdout"),
	];
	const abstains = {
		kind: { choice: "ephemeral", confidence: 0.4 },
		contradicts: { choice: "R1", confidence: 0.95 },
	};
	const milestone = {
		status: { choice: "milestone", confidence: 0.9 },
		boundary: { choice: "m2", confidence: 0.9 },
	};
	const report = await run(cases, [
		...["sd", "sh"].map((id) => obs(A, id, "", 0, { answers: abstains })),
		...["md", "mh"].map((id) => obs(A, id, "", 0, { answers: milestone })),
	]);
	const supersession = report.tasks.supersession;
	const replay = row(supersession?.ranking.pipelines ?? [], `replay(${A})`);
	assert.equal(replay.fallback, true);
	// The heuristic keeps the rule (kind right) but never supersedes (contradicts wrong).
	assert.equal(replay.holdout?.fallbackVerdicts, 1);
	assert.equal(replay.holdout?.accepted, 2);
	assert.equal(replay.holdout?.unsafeAccepted, 0);
	assert.equal(replay.holdout?.acceptedExactCases, 0);
	assert.equal(replay.holdout?.selectiveAccuracy, 0.5);
	// Alone, the model's kind abstained, so nothing was decided for it.
	const alone = row(supersession?.ranking.singles ?? [], `single(${A})`).holdout;
	assert.equal(alone?.accepted, 1);
	assert.equal(alone?.acceptedExactCases, 0);
	assert.ok(row(supersession?.ranking.pipelines ?? [], "heuristic-only"));
	const ids = (task: EvalTask) => report.tasks[task]?.ranking.pipelines.map((p) => p.kind) ?? [];
	assert.deepEqual(ids("milestone-status"), ["single"]);
	assert.equal(report.tasks["milestone-status"]?.ranking.singles.length, 1);
});

test("the gate chosen on development is not re-tuned on holdout", async () => {
	const cases = [
		...["d1", "d2", "d3"].map((id) => intentCase(id, "development")),
		...["h1", "h2"].map((id) => intentCase(id, "holdout")),
	];
	const development = [
		obs(A, "d1", "ephemeral", 0.8),
		obs(A, "d2", "rule", 0.9),
		obs(A, "d3", "rule", 0.6),
	];
	const withUnsafe = await run(cases, [
		...development,
		obs(A, "h1", "ephemeral", 0.9),
		obs(A, "h2", "rule", 0.95),
	]);
	const sweep = withUnsafe.tasks.intent?.sweeps.find((s) => s.model === A && s.question === "kind");
	assert.ok(sweep);
	assert.equal(sweep.selected.threshold, 0.85);
	assert.equal(sweep.selected.development?.unsafeAccepted, 0);
	assert.equal(sweep.selected.holdout?.unsafeAccepted, 1, "holdout is read, not tuned");
	assert.equal(sweep.points.find((p) => p.threshold === 0.95)?.holdout?.unsafeAccepted, 0);
	assert.equal(sweep.points.length, 10);
	assert.equal(sweep.points[0].threshold, 0.5);

	const withoutUnsafe = await run(cases, [
		...development,
		obs(A, "h1", "rule", 0.9),
		obs(A, "h2", "rule", 0.95),
	]);
	const same = withoutUnsafe.tasks.intent?.sweeps.find((s) => s.question === "kind");
	assert.equal(same?.selected.threshold, 0.85, "holdout answers never move the gate");
	assert.equal(same?.selected.holdout?.unsafeAccepted, 0);

	const never = await run(cases, [
		obs(A, "d1", "ephemeral", 0.99),
		obs(A, "d2", "rule", 0.9),
		obs(A, "d3", "rule", 0.6),
		obs(A, "h1", "rule", 0.9),
		obs(A, "h2", "rule", 0.95),
	]);
	const unreachable = never.tasks.intent?.sweeps[0].selected;
	assert.equal(unreachable?.threshold, null);
	assert.match(unreachable?.reason ?? "", /no threshold/);
});

test("ranking is lexicographic: unsafe accepted, accepted-exact rate, cost, p95", async () => {
	const holdout = ["c1", "c2", "c3", "c4"];
	const cases = [
		intentCase("d1", "development"),
		...holdout.map((id) => intentCase(id, "holdout")),
	];
	const model = (
		name: string,
		answers: [string, number][],
		over: Partial<EvalObservation> = {},
	) => [
		obs(name, "d1", "rule", 0.9, over),
		...answers.map(([choice, confidence], i) => obs(name, holdout[i], choice, confidence, over)),
	];
	const X = "decisions:t/x";
	const Y = "decisions:t/y";
	const W = "decisions:t/w";
	const V = "decisions:t/v";
	const abstaining: [string, number][] = [
		["rule", 0.9],
		["rule", 0.9],
		["rule", 0.5],
		["rule", 0.5],
	];
	const report = await run(cases, [
		// Highest accepted-exact rate, but one unsafe accepted answer.
		...model(X, [
			["rule", 0.9],
			["rule", 0.9],
			["rule", 0.9],
			["ephemeral", 0.9],
		]),
		...model(Y, abstaining, { costUsd: 0.002 }),
		...model(W, abstaining, { costUsd: 0.001 }),
		...model(V, abstaining, { costUsd: 0.001, durationMs: 50 }),
	]);
	const singles = report.tasks.intent?.ranking.singles ?? [];
	assert.deepEqual(
		singles.map((r) => r.id),
		[V, W, Y, X].map((m) => `single(${m})`),
	);
	assert.equal(row(singles, `single(${X})`).holdout?.acceptedExactRate, 0.75);
	assert.equal(singles[0].holdout?.unsafeAccepted, 0);
	assert.deepEqual(
		singles.map((r) => r.rank),
		[1, 2, 3, 4],
	);
	assert.equal(report.tasks.intent?.recommendation.single.id, `single(${V})`);
	assert.equal(report.tasks.intent?.recommendation.single.status, "recommended");
});

test("results under the minimum case count are insufficient and rank below sufficient ones", async () => {
	const cases = [
		intentCase("d1", "development"),
		...["c1", "c2", "c3"].map((id) => intentCase(id, "holdout")),
	];
	const observations = [
		obs(A, "d1", "rule", 0.9),
		obs(B, "d1", "rule", 0.9),
		...["c1", "c2", "c3"].map((id) => obs(A, id, "rule", 0.9, { costUsd: 0.01 })),
		// B is cheaper and as good but saw only two holdout cases.
		...["c1", "c2"].map((id) => obs(B, id, "rule", 0.9)),
	];
	const report = await run(cases, observations, { minCases: 3 });
	const singles = report.tasks.intent?.ranking.singles ?? [];
	assert.deepEqual(
		singles.map((r) => [r.id, r.insufficient]),
		[
			[`single(${A})`, false],
			[`single(${B})`, true],
		],
	);
	assert.match(singles[1].insufficientReason ?? "", /n=2 < 3/);
	assert.equal(singles[1].holdout?.missingCases, 1);
	assert.equal(
		singles[1].holdout?.acceptedExactRate,
		2 / 3,
		"a missing case counts as a failed decision",
	);

	const strict = await analyze({ cases, observations }, {});
	assert.ok(strict.tasks.intent?.ranking.singles.every((r) => r.insufficient));
	assert.equal(strict.tasks.intent?.recommendation.single.status, "insufficient-evidence");
});

test("unsupported and failing models stay visible in rankings and exclusions", async () => {
	const holdout = ["c1", "c2"];
	const cases = [
		intentCase("d1", "development"),
		intentCase("d2", "development"),
		...holdout.map((id) => intentCase(id, "holdout")),
	];
	const U = "chat:t/unsupported";
	const E = "decisions:t/erroring";
	const everyCase = ["d1", "d2", ...holdout];
	const report = await run(
		cases,
		[
			...everyCase.map((id) => obs(A, id, "rule", 0.9)),
			...everyCase.map((id) =>
				failed(U, id, "unsupported", {
					durationMs: 0,
					costUsd: 0,
					costBoundUsd: 0,
				}),
			),
			...everyCase.map((id) =>
				failed(E, id, "error", {
					costUsd: null,
					costBoundUsd: 0.003,
					durationMs: 800,
				}),
			),
		],
		{ top: 1 },
	);
	const task = report.tasks.intent;
	const singles = task?.ranking.singles ?? [];
	assert.equal(singles[0].id, `single(${A})`);
	const unsupported = row(singles, `single(${U})`).holdout;
	const erroring = row(singles, `single(${E})`).holdout;
	assert.equal(unsupported?.unsupported, 2);
	assert.equal(unsupported?.acceptedExactRate, 0);
	assert.equal(erroring?.errors, 2);
	assert.equal(erroring?.costPer1000.basis, "bound");
	assert.equal(erroring?.costPer1000.usd, 3);
	const detail = task?.models.find((m) => m.model === E)?.holdout;
	assert.equal(detail?.summary.errors, 2);
	assert.equal(detail?.invalidRate, 1, "failed calls are invalid, never abstentions");
	assert.equal(detail?.abstentionRate, 0);
	assert.deepEqual(task?.selection.included, [A]);
	assert.deepEqual(task?.selection.excluded.map((e) => e.model).sort(), [E, U].sort());
	assert.ok(
		task?.selection.excluded.every((e) => /no successful/.test(e.reason)),
		"models that never answered cannot occupy a pipeline slot",
	);
});

test("per-question counts, abstention and repetition consistency are reported", async () => {
	const cases = [
		intentCase("d1", "development"),
		intentCase("h1", "holdout"),
		intentCase("h2", "holdout"),
		intentCase("h3", "holdout"),
	];
	const report = await run(cases, [
		obs(A, "d1", "rule", 0.9),
		obs(A, "h1", "rule", 0.9),
		obs(A, "h1", "rule", 0.9, { repetition: 1 }),
		obs(A, "h2", "rule", 0.9),
		obs(A, "h2", "ephemeral", 0.9, { repetition: 1 }),
		obs(A, "h3", "rule", 0.4),
		obs(A, "h3", "bogus", 0.9, { repetition: 1 }),
	]);
	const detail = report.tasks.intent?.models[0].holdout;
	assert.ok(detail);
	assert.equal(detail.consistency.casesWithRepeats, 3);
	assert.equal(detail.consistency.fullyAgreeingCases, 1);
	assert.ok(Math.abs((detail.consistency.agreementRate ?? 0) - 1 / 3) < 1e-12);
	const kind = detail.perQuestion.kind;
	assert.equal(kind.questions, 6);
	assert.equal(kind.unsafeAccepted, 1);
	assert.equal(kind.abstained, 1);
	assert.equal(kind.invalid, 1);
	assert.equal(kind.accepted, 4);
	assert.equal(detail.costSources.generation, 6);
	assert.equal(detail.metrics.costPer1000.basis, "actual");
});

test("observations are loaded strictly and reports are written", async () => {
	assert.throws(() => parseObservations("{not json}\n", "obs.jsonl"), /obs\.jsonl:1: invalid JSON/);
	assert.throws(
		() =>
			parseObservations(
				JSON.stringify({ ...obs(A, "c1", "rule", 0.9), status: "weird" }),
				"obs.jsonl",
			),
		/obs\.jsonl:1: status must be/,
	);
	const dir = await mkdtemp(join(tmpdir(), "analyze-test-"));
	try {
		const cases = [intentCase("d1", "development"), intentCase("h1", "holdout")];
		const lines = [
			obs(A, "d1", "rule", 0.9),
			obs(A, "h1", "rule", 0.9),
			obs(A, "h1", "ephemeral", 0.9),
			obs(A, "unknown-case", "rule", 0.9),
		];
		await writeFile(
			join(dir, "observations.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n\n`,
		);
		await writeFile(join(dir, "run.json"), JSON.stringify({ id: "r1", cap: 2, nested: { x: 1 } }));
		const loaded = await loadRun(dir);
		assert.deepEqual(loaded.info.meta, { id: "r1", cap: 2 });
		const report = await analyze(
			{ cases, observations: loaded.observations, runs: [loaded.info] },
			{ minCases: 1 },
		);
		assert.equal(report.dataQuality.unknownCaseObservations, 1);
		assert.deepEqual(report.dataQuality.unknownCaseIds, ["unknown-case"]);
		assert.equal(report.dataQuality.duplicateObservations, 1);
		await writeReport(report, join(dir, "out"));
		const json = JSON.parse(await readFile(join(dir, "out", "report.json"), "utf8"));
		assert.equal(json.version, 1);
		const markdown = await readFile(join(dir, "out", "report.md"), "utf8");
		assert.equal(markdown, renderMarkdown(report));
		for (const heading of ["## Recommendations", "## intent", "## Limitations"])
			assert.ok(markdown.includes(heading), heading);
		assert.match(markdown, /Recommended single model/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
