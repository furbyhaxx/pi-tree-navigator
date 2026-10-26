import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	buildMilestoneClassifierContext,
	type MilestoneRecord,
	type MilestoneStructure,
} from "../../extensions/navigate-tree/milestone-classifier.ts";
import type { FetchFn } from "../fetch.ts";
import { type AnswerOptions, chatCandidate, decisionsCandidate } from "./adapters.ts";
import { loadRouteTable, PROMPT_MARGIN_BYTES, ROUTE_PRICES_URL } from "./billing.ts";
import { CASES } from "./cases.ts";
import {
	addCarried,
	combineGranular,
	generateStructure,
	heuristicStructure,
	parseStructure,
	parseVariant,
	planVariant,
	type StructureObservation,
	structureRequest,
	variantCase,
	worstCaseStructure,
} from "./milestone-variants.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalAnswer, EvalCase, PreparedCase } from "./types.ts";

type MilestoneCaseInput = Extract<EvalCase["input"], { type: "milestone" }>;

const KEY = "sk-or-test-SECRET-0000000000";
const TABLE = loadRouteTable(ROUTE_PRICES_URL);
const EVIDENCE = new URL(
	"../../.project/analyses/classifier-eval/runs-catalogued-2026-10-23/dev-screen-2026-10-23/observations.jsonl",
	import.meta.url,
);

const RECORDS: MilestoneRecord[] = [
	{ id: "u1", role: "user", text: "Add the export command and run the tests." },
	{ id: "a1", role: "assistant", text: "Adding the command." },
	{ id: "t1", role: "tool", text: "Edited src/export.ts" },
	{ id: "a2", role: "assistant", text: "Done; tests pass. Docs are next." },
	{ id: "a3", role: "assistant", text: "Updating the docs now." },
];

const STRUCTURE: MilestoneStructure = {
	objective: "Ship the export command",
	goals: ["export command", "docs"],
	folds: [{ label: "f1", title: "Setup", outcome: "done" }],
	anchors: [{ name: "baseline" }],
};

const milestoneCase = (structure?: MilestoneStructure): EvalCase => ({
	id: "m-1",
	split: "development",
	family: "export",
	task: "milestone-status",
	input: {
		type: "milestone",
		lastAnchor: "baseline",
		records: RECORDS,
		...(structure && { structure }),
	},
	expected: {
		status: {
			choices: ["continue"],
			unsafeChoices: ["milestone"],
			rationale: "r",
		},
		boundary: { choices: ["a2"], unsafeChoices: ["a3"], rationale: "r" },
	},
});

let directory = "";
let registry: ModelRegistry;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "variants-test-"));
	const runtime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(directory, "store.json"),
		refreshOnCreate: false,
	});
	await runtime.setRuntimeApiKey("openrouter", KEY);
	registry = new ModelRegistry(runtime);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const jev = () => {
	const model = registry.getModelOfType("classifier", "openrouter", "typesafe/jev-1.14");
	assert.ok(model);
	return decisionsCandidate(model, TABLE);
};
const luna = () => {
	const model = registry.getModelOfType("chat", "openrouter", "openai/gpt-6-luna");
	assert.ok(model);
	const candidate = chatCandidate(model, TABLE);
	assert.equal(candidate.adapter, "chat");
	return candidate.adapter === "chat"
		? { ...candidate, label: `${candidate.label}#structure` }
		: candidate;
};

const options = (fetch: FetchFn): AnswerOptions => ({
	registry,
	repetition: 0,
	timeoutMs: 5_000,
	fetch,
});

describe("variant ids", () => {
	it("canonicalizes parts and rejects combinations that contradict", () => {
		assert.equal(parseVariant("base").id, "base");
		assert.equal(parseVariant("tree-luna+granular").id, "granular+tree-luna");
		assert.equal(parseVariant("tree-heuristic+instructions").id, "instructions+tree-heuristic");
		for (const bad of [
			"instructions+granular",
			"tree-luna+tree-heuristic",
			"base+granular",
			"granular+granular",
			"tree",
		])
			assert.throws(() => parseVariant(bad), Error, bad);
	});
});

describe("base variant", () => {
	it("sends the production request without structure, byte for byte", () => {
		const plain = prepareCase(milestoneCase());
		const withStructure = prepareCase(milestoneCase(STRUCTURE));
		assert.ok("structure" in withStructure.context.state);
		const base = variantCase(withStructure, parseVariant("base"));
		assert.equal(JSON.stringify(base.context), JSON.stringify(plain.context));
		assert.deepEqual(base.questions, plain.questions);
	});

	it("matches the request hash of an earlier live observation for the same cases", async () => {
		const earlier = readFileSync(EVIDENCE, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const candidate = jev();
		const cases = CASES.filter(
			(fixture) => fixture.split === "development" && fixture.input.type === "milestone",
		).slice(0, 3);
		assert.equal(cases.length, 3);
		for (const fixture of cases) {
			const old = earlier.find(
				(o) => o.model === candidate.label && o.caseId === fixture.id && o.repetition === 0,
			);
			assert.ok(old?.requestSha256, `no earlier observation for ${fixture.id}`);
			const plan = planVariant(prepareCase(fixture), candidate, parseVariant("base"), new Map());
			const result = await plan.run(options(async () => new Response("{}", { status: 400 })));
			assert.equal(result.observation.model, `${candidate.label}#base`);
			assert.equal(result.observation.requestSha256, old.requestSha256);
		}
	});
});

/** Hashes of the serialized request (state and questions) each variant sent before the wording moved into the production module. */
const REQUEST_SHA256: Record<string, string> = {
	"status-docs-migration-milestone|base":
		"ae48f5a4baca94feac9fa043cb65b334f40ea96be758c1dc573fb6fca2f34e6a",
	"status-docs-migration-milestone|instructions":
		"7f3bd5a9f8bf038b021813978c7bbecdde5e2aa85f1f35a458b0aadeebeb0179",
	"status-docs-migration-milestone|granular":
		"3b1ec95b37eeeea647927c9eec7e8ba3f44e8fb2b9667187e7921ed4d2b6db4d",
	"status-docs-migration-milestone|tree-heuristic":
		"8f1965c62b36b0476b8d63c30d0c2e7380f4eaceab94d6af8f00e90b243b334d",
	"status-docs-migration-milestone|instructions+tree-heuristic":
		"09c769aad2861d1d5c22895093b0656dfde5df956f99c279eca8869541a9e2fb",
	"status-docs-migration-milestone|granular+tree-heuristic":
		"90c9e135762863657bb4c9ce93cb99aa9e62ef3bf3026aa784c7a91c5f938286",
	"status-docs-migration-milestone|instructions+tree-luna":
		"136bb5f9bca9c52da791a497677dfd276a6f3c0f7f4d8973868c161dd8555266",
	"boundary-lint-cleanup-hook-started|base":
		"6bcd06149babc1053eb392858e78752843e7aff201f9eebe8ceb202cc3e63f89",
	"boundary-lint-cleanup-hook-started|instructions":
		"d36524b7af4bd93da69cb31ed6e9527dd860376142a0ba0c796ea9f4eea29b32",
	"boundary-lint-cleanup-hook-started|granular":
		"cb4b69015c1152f187a7d5d88af5e20b2f035535582c16c3eaeddf9104f4f875",
	"boundary-lint-cleanup-hook-started|tree-heuristic":
		"0a432bf96dc301bada8a6e8f97401b1c554035d0b5cffc104ff852d9b6c898a1",
	"boundary-lint-cleanup-hook-started|instructions+tree-heuristic":
		"2850d17d05816b3e7308c702eb49cc561cbbf9ee9dc1408f4b1f8a3f9f80a429",
	"boundary-lint-cleanup-hook-started|granular+tree-heuristic":
		"96ad6b81f6fdb91105427e459750c1ee83de683d7cb47cb4d924c8696f1f0d74",
	"boundary-lint-cleanup-hook-started|instructions+tree-luna":
		"8daa7b6fdc150ff1946405b46994dcaf82833960a4b16f8a94051c59f83c054b",
	"status-redirect-asks-user-mixed|base":
		"467c40e4a9c7d7b0f4d3525247a4a340df221575a7c1ae5b1a227cc9891ec908",
	"status-redirect-asks-user-mixed|instructions":
		"b645c55071137575c04c8c8a1f4153886a064b1c6525365574e149b2778ddff5",
	"status-redirect-asks-user-mixed|granular":
		"6d8b540d5515f3a9293c0791bb889a97d94d74f5fee1fbad80c4dbff1d60355e",
	"status-redirect-asks-user-mixed|tree-heuristic":
		"b7b09e53452ba829ce574fe2e9087c26549f77100fc4c5df327792146c5df533",
	"status-redirect-asks-user-mixed|instructions+tree-heuristic":
		"77094c36cf243b23c931727d64c6cbcfee7218ca34932a37b32b447dccd9f27d",
	"status-redirect-asks-user-mixed|granular+tree-heuristic":
		"61c430d42c77a12afb26e5de6ae47291ea08fb3252be488755fb9d35558f7cc6",
	"status-redirect-asks-user-mixed|instructions+tree-luna":
		"572d3902f900619cf5a943fa124ae8f39335f6db2acb058e77815c1cd922b049",
	"status-retry-backoff-milestone|base":
		"2b5386fe757acaa950e14b098d011c47441073ba3fe08c3f8088db6897afe830",
	"status-retry-backoff-milestone|instructions":
		"81dd12f6eff3d0ed60f2393ba8b3c8b31291fd10a4758aa7c3944e1dea210660",
	"status-retry-backoff-milestone|granular":
		"cbc8be351ee9caff7718fc797cf8fb5727a4e7abafab1a66a5b2bd13f15f9a95",
	"status-retry-backoff-milestone|tree-heuristic":
		"24e29f6a5d0061ea9381718d4c4107eed9b8425dbbe42716371097eeb98f18ca",
	"status-retry-backoff-milestone|instructions+tree-heuristic":
		"163082851fd97fd919ea2997c986ba5a424028d89a5318d071dfc892635cc6fc",
	"status-retry-backoff-milestone|granular+tree-heuristic":
		"4bc665e736a4149aa57c1f0f2ac1d911779d60df82bf3e620247a4aeaf2db29c",
	"status-retry-backoff-milestone|instructions+tree-luna":
		"ac967b07401af0ca9fc224257221c21d8e564eb81a9f1718d05a670c1d60aa90",
	"boundary-config-rename-next-phase-started|base":
		"98c8979e9607dd66aaf38477eaa1bd0e658133b5abc1e9561c1fa4cfd42e64c7",
	"boundary-config-rename-next-phase-started|instructions":
		"7dea3b124a85e314439c6eed1fc4a3c36334b8e32539898fdc2cab834ccd9be2",
	"boundary-config-rename-next-phase-started|granular":
		"0b9d5f171ba99c45c53af8738f0cfd78da7eabd2f2a273437109986c08c13c72",
	"boundary-config-rename-next-phase-started|tree-heuristic":
		"1eaf98dbb4829ac88ff92a123f24227474a811dc854ed964edcd76af03d397a2",
	"boundary-config-rename-next-phase-started|instructions+tree-heuristic":
		"25135b743b6704a94e388a05dc0c2ddf3c03a9a1aa63f02cac6c7d627b76204d",
	"boundary-config-rename-next-phase-started|granular+tree-heuristic":
		"4d215ba8c760298fbb26ed5b289d6c2992998e16bfe1d7ad14ad82ea8ec7f848",
	"boundary-config-rename-next-phase-started|instructions+tree-luna":
		"2e718c8aea18ba379dd85dd051e12bd1399209fed8fc33f52eb36ecb37e5b33f",
};

const FIXED_STRUCTURE: MilestoneStructure = {
	objective: "Fixed objective",
	goals: ["g1", "g2"],
	folds: [{ label: "f1", title: "t", outcome: "o" }],
	anchors: [{ name: "a" }],
};

describe("benchmark requests", () => {
	it("stay byte-identical to what earlier runs sent, for every variant", () => {
		const entries = Object.entries(REQUEST_SHA256);
		assert.equal(entries.length, 35);
		for (const [key, expected] of entries) {
			const [caseId = "", spec = ""] = key.split("|");
			const fixture = CASES.find((c) => c.id === caseId);
			assert.ok(fixture, `no case ${caseId}`);
			const variant = parseVariant(spec);
			const structure =
				variant.tree === "heuristic"
					? heuristicStructure(fixture.input as MilestoneCaseInput)
					: variant.tree === "luna"
						? FIXED_STRUCTURE
						: undefined;
			const sent = variantCase(prepareCase(fixture), variant, structure);
			assert.equal(
				createHash("sha256").update(JSON.stringify(sent.context)).digest("hex"),
				expected,
				key,
			);
		}
	});
});

describe("variant requests", () => {
	const fixture = prepareCase(milestoneCase());

	it("instructions keep the question ids and every record choice", () => {
		const sent = variantCase(fixture, parseVariant("instructions"));
		assert.deepEqual(Object.keys(sent.questions), ["status", "boundary"]);
		assert.deepEqual(
			Object.keys(sent.questions.boundary?.choices ?? {}),
			Object.keys(fixture.questions.boundary?.choices ?? {}),
		);
		assert.notEqual(sent.questions.status?.instructions, fixture.questions.status?.instructions);
		assert.deepEqual(sent.context.state, fixture.context.state);
	});

	it("granular asks one yes/no question per signal and per assistant record", () => {
		const sent = variantCase(fixture, parseVariant("granular"));
		assert.deepEqual(Object.keys(sent.questions), [
			"asks-user",
			"blocked",
			"open-work",
			"finished",
			"report:a1",
			"report:a2",
			"report:a3",
		]);
		for (const question of Object.values(sent.questions))
			assert.deepEqual(Object.keys(question.choices), ["yes", "no"]);
		assert.match(sent.questions["report:a2"]?.instructions ?? "", /Done; tests pass/u);
	});

	it("tree-heuristic derives objective, goals and anchor, and keeps a case structure as given", () => {
		assert.deepEqual(heuristicStructure({ records: RECORDS, lastAnchor: "baseline" }), {
			objective: "Add the export command and run the tests.",
			anchors: [{ name: "baseline" }],
		});
		assert.equal(heuristicStructure({ records: [RECORDS[1] as MilestoneRecord] }), undefined);
		const variant = parseVariant("tree-heuristic");
		const derived = planVariant(fixture, jev(), variant, new Map());
		assert.ok("structure" in derived.prepared.context.state);
		const given = planVariant(prepareCase(milestoneCase(STRUCTURE)), jev(), variant, new Map());
		assert.deepEqual(
			(given.prepared.context.state as { structure: unknown }).structure,
			buildMilestoneClassifierContext({
				records: RECORDS,
				structure: STRUCTURE,
			}).context.state.structure,
		);
	});
});

const yes = (confidence = 0.9): EvalAnswer => ({ choice: "yes", confidence });
const no = (confidence = 0.9): EvalAnswer => ({ choice: "no", confidence });

describe("granular combination", () => {
	const SIGNALS = ["asks-user", "blocked", "open-work", "finished"] as const;
	const GIVEN: (EvalAnswer | undefined)[] = [
		yes(),
		no(),
		undefined,
		{ choice: "maybe", confidence: 1 },
	];

	it("never yields milestone unless every signal is answered and only finished is yes", () => {
		let milestones = 0;
		for (const a of GIVEN)
			for (const b of GIVEN)
				for (const c of GIVEN)
					for (const d of GIVEN) {
						const answers = Object.fromEntries(
							SIGNALS.flatMap((signal, index) => {
								const given = [a, b, c, d][index];
								return given ? [[signal, given]] : [];
							}),
						);
						const status = combineGranular(RECORDS, answers).status;
						const clear =
							a?.choice === "no" && b?.choice === "no" && c?.choice === "no" && d?.choice === "yes";
						assert.equal(status?.choice === "milestone", clear);
						if (clear) milestones++;
						if (a?.choice === "yes") assert.equal(status?.choice, "await-user");
						else if (b?.choice === "yes") assert.equal(status?.choice, "blocked");
						else if (c?.choice === "yes") assert.equal(status?.choice, "continue");
					}
		assert.equal(milestones, 1);
	});

	it("states milestone with the lowest confidence of its signals", () => {
		const status = combineGranular(RECORDS, {
			"asks-user": no(0.95),
			blocked: no(0.9),
			"open-work": no(0.6),
			finished: yes(0.99),
		}).status;
		assert.deepEqual(status, { choice: "milestone", confidence: 0.6 });
	});

	it("decides a non-milestone status from one answer even when the others are missing", () => {
		assert.deepEqual(combineGranular(RECORDS, { "open-work": yes(0.8) }).status, {
			choice: "continue",
			confidence: 0.8,
		});
		assert.equal(combineGranular(RECORDS, { finished: yes() }).status, undefined);
		assert.deepEqual(
			combineGranular(RECORDS, {
				"asks-user": no(),
				blocked: no(),
				"open-work": no(),
				finished: no(0.7),
			}).status,
			{ choice: "continue", confidence: 0.7 },
		);
	});

	it("takes the newest finished-phase report and the confidence of everything after it", () => {
		assert.deepEqual(
			combineGranular(RECORDS, {
				"report:a1": no(),
				"report:a2": yes(0.85),
				"report:a3": no(0.7),
			}).boundary,
			{ choice: "a2", confidence: 0.7 },
		);
		assert.deepEqual(
			combineGranular(RECORDS, {
				"report:a1": no(0.8),
				"report:a2": no(0.9),
				"report:a3": no(0.95),
			}).boundary,
			{ choice: "none", confidence: 0.8 },
		);
	});

	it("leaves the boundary out when a record at or after the report is unanswered", () => {
		assert.equal(
			combineGranular(RECORDS, { "report:a1": yes(), "report:a2": yes() }).boundary,
			undefined,
		);
		assert.equal(
			combineGranular(RECORDS, {
				"report:a1": yes(),
				"report:a2": { choice: "yes", confidence: 7 },
				"report:a3": no(),
			}).boundary,
			undefined,
		);
	});
});

describe("generated structure", () => {
	it("keeps only valid, bounded, printable text and known record ids", () => {
		const parsed = parseStructure(
			JSON.stringify({
				objective: `  ship\nthe\u0007 export ${"x".repeat(400)}`,
				goals: ["a", 3, "", "b".repeat(500), "c", "d", "e", "f", "g"],
				anchors: [
					{ name: "first", afterRecordId: "a2" },
					{ name: "ghost", afterRecordId: "zz" },
					{ name: "", afterRecordId: "a1" },
					{ name: "n".repeat(90), afterRecordId: "a3" },
				],
			}),
			["u1", "a1", "a2", "a3"],
		);
		assert.deepEqual(parsed.problems, []);
		const structure = parsed.structure;
		assert.ok(structure);
		assert.equal(structure.objective?.length, 200);
		assert.match(structure.objective ?? "", /^ship the export /u);
		assert.equal(structure.goals?.length, 6);
		assert.equal(structure.goals?.[1]?.length, 160);
		assert.deepEqual(
			structure.anchors?.map((a) => a.afterRecordId),
			["a2", "a3"],
		);
		assert.equal(structure.anchors?.[1]?.name.length, 40);
	});

	it("rejects output without an objective or lists", () => {
		assert.deepEqual(parseStructure("nope", []).problems, ["output is not valid JSON"]);
		assert.deepEqual(parseStructure("{}", []).problems, [
			"no objective",
			"goals is not a list",
			"anchors is not a list",
		]);
	});

	it("is priced for the largest structure the limits allow", () => {
		const worst = worstCaseStructure(RECORDS);
		const adversarial = parseStructure(
			JSON.stringify({
				objective: '"\\'.repeat(300),
				goals: Array.from({ length: 9 }, () => "\u{1F600}".repeat(300)),
				anchors: Array.from({ length: 12 }, () => ({
					name: "\u20ac".repeat(90),
					afterRecordId: "a2",
				})),
			}),
			RECORDS.map((r) => r.id),
		).structure;
		assert.ok(adversarial);
		const bytes = (structure: MilestoneStructure) =>
			Buffer.byteLength(
				JSON.stringify(buildMilestoneClassifierContext({ records: RECORDS, structure }).context),
			);
		assert.ok(bytes(adversarial) <= bytes(worst));
	});

	it("is generated once through the chat route and recorded with its cost evidence", async () => {
		const sent: string[] = [];
		const reply = JSON.stringify({
			objective: "Ship the export command",
			goals: ["export command", "docs"],
			anchors: [{ name: "export done", afterRecordId: "a2" }],
		});
		const fetch: FetchFn = async (_input, init) => {
			sent.push(String(init?.body));
			const chunk = (extra: object) =>
				`data: ${JSON.stringify({ id: "gen-struct-1", ...extra })}\n\n`;
			return new Response(
				chunk({
					choices: [{ index: 0, delta: { role: "assistant", content: reply } }],
				}) +
					chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
					chunk({
						choices: [],
						usage: { prompt_tokens: 90, completion_tokens: 30, cost: 0.00002 },
					}) +
					"data: [DONE]\n\n",
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const fixture = prepareCase(milestoneCase());
		const candidate = luna();
		const result = await generateStructure(fixture, candidate, options(fetch));
		assert.equal(sent.length, 1);
		const planned = structureRequest(fixture, candidate).bodyBytes;
		const bytes = Buffer.byteLength(sent[0] ?? "");
		assert.ok(bytes >= planned && bytes <= planned + PROMPT_MARGIN_BYTES);
		const observation = result.observation as StructureObservation;
		assert.equal(observation.model, "chat:openai/gpt-6-luna#structure");
		assert.equal(observation.status, "ok");
		assert.equal(observation.generationId, "gen-struct-1");
		assert.equal(
			observation.requestSha256,
			createHash("sha256")
				.update(sent[0] ?? "")
				.digest("hex"),
		);
		assert.deepEqual(observation.structure?.anchors, [
			{ name: "export done", afterRecordId: "a2" },
		]);
		assert.equal(result.evidence.responseCostUsd, 0.00002);
		assert.equal(JSON.stringify(result).includes("SECRET"), false);
	});
});

describe("tree-luna variant", () => {
	const fixture: PreparedCase = prepareCase(milestoneCase());
	const variant = parseVariant("tree-luna");
	const generated = (extra: Partial<StructureObservation> = {}): StructureObservation => ({
		caseId: "m-1",
		model: "chat:openai/gpt-6-luna#structure",
		adapter: "chat",
		repetition: 0,
		status: "ok",
		answers: {},
		durationMs: 1200,
		costUsd: 0.00004,
		costSource: "generation",
		costBoundUsd: 0.01,
		startedAt: "2026-10-23T00:00:00.000Z",
		structure: { objective: "Ship the export command" },
		...extra,
	});

	it("sends the generated structure, keeps the case folds and carries the structure cost and time", async () => {
		const structures = new Map([["m-1", generated()]]);
		const sent: string[] = [];
		const plan = planVariant(prepareCase(milestoneCase(STRUCTURE)), jev(), variant, structures);
		const result = await plan.run(
			options(async (_input, init) => {
				sent.push(String(init?.body));
				return new Response("{}", { status: 400 });
			}),
		);
		const { state } = JSON.parse(sent[0] ?? "{}") as {
			state: { structure: MilestoneStructure };
		};
		assert.equal(state.structure.objective, "Ship the export command");
		assert.deepEqual(state.structure.folds, STRUCTURE.folds);
		assert.equal(state.structure.goals, undefined);
		assert.deepEqual(result.carried, {
			costUsd: 0.00004,
			costSource: "generation",
			boundUsd: 0.01,
		});
		assert.ok(result.observation.durationMs >= 1200);
	});

	it("records an error without a request when the structure is missing", async () => {
		let requests = 0;
		const plan = planVariant(fixture, jev(), variant, new Map());
		const result = await plan.run(
			options(async () => {
				requests++;
				return new Response("{}");
			}),
		);
		assert.equal(requests, 0);
		assert.equal(result.observation.status, "error");
		assert.match(result.observation.error ?? "", /structure generation failed/u);
		assert.equal(result.evidence.dispatched, false);
	});

	it("adds carried costs and treats an unknown part as unknown", () => {
		const carried = {
			costUsd: 0.00004,
			costSource: "generation" as const,
			boundUsd: 0.01,
		};
		assert.deepEqual(addCarried({ costUsd: 0.00001, costSource: "generation" }, carried), {
			costUsd: 0.00005,
			costSource: "generation",
		});
		assert.deepEqual(
			addCarried({ costUsd: 0.00001, costSource: "response" }, carried).costSource,
			"response",
		);
		assert.deepEqual(addCarried({ costUsd: null, costSource: "unknown" }, carried), {
			costUsd: null,
			costSource: "unknown",
		});
		assert.deepEqual(addCarried({ costUsd: 0, costSource: "local" }, carried), {
			costUsd: 0.00004,
			costSource: "generation",
		});
	});
});
