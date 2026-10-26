import { it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../../../scripts/classifier-eval/budget.ts";
import { asFetch } from "../../../scripts/fetch.ts";
import {
	AUTOMATIC_CONFIG,
	AUTOMATIC_REQUEST,
	seedCorpus,
} from "../../../scripts/fold-acceptance/fixture.ts";
import {
	interceptRuntime,
	nativeBilling,
	parseModelSelector,
	parseOptions,
	runAcceptance,
	verifyAutomaticContinuation,
	verifyRepeatedRecovery,
} from "../../../scripts/fold-acceptance/run.ts";
import {
	createBudgetedTransport,
	type ModelPricingTable,
	type TransportRecord,
} from "../../../scripts/fold-acceptance/transport.ts";
import { estimateAdmissionTokens } from "../../../src/index.ts";

it("automatic continuation need not repeat an already fulfilled finalization request", () => {
	const sm = SessionManager.inMemory();
	const anchor = sm.appendMessage({
		role: "user",
		content: "Finalize the audit",
		timestamp: 1,
	});
	sm.appendMessage(fauxAssistantMessage("ACCEPTANCE-CONTINUED: audit complete"));
	sm.branchWithSummary(anchor, "Completed audit handoff");
	assert.throws(() => verifyAutomaticContinuation(sm.getBranch(), sm.getEntries()), /continue/);
	const afterFold = sm.appendMessage(fauxAssistantMessage("Ready for the next supplied change."));
	verifyAutomaticContinuation(sm.getBranch(), sm.getEntries());
	const parentId = sm.getEntry(afterFold)?.parentId;
	assert.ok(parentId);
	sm.branch(parentId);
	sm.appendMessage(fauxAssistantMessage("failed partial reply", { stopReason: "error" }));
	assert.throws(() => verifyAutomaticContinuation(sm.getBranch(), sm.getEntries()), /continue/);
});

it("dry run writes only synthetic evidence without opening a ledger or contacting providers", async () => {
	const root = mkdtempSync(join(tmpdir(), "fold-runner-test-"));
	const oldFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = asFetch(async () => {
		calls++;
		throw new Error("no network allowed");
	});
	try {
		const ledger = join(root, "budget.jsonl"),
			out = join(root, "evidence");
		const options = parseOptions([
			"--out",
			out,
			"--ledger",
			ledger,
			"--blocks",
			"2",
			"--auth-dir",
			join(root, "does-not-exist"),
			"--dry-run",
		]);
		await runAcceptance(options);
		assert.equal(calls, 0);
		assert.equal(existsSync(ledger), false);
		const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
		assert.equal(result.dispatched, 0);
		assert.ok(result.sourceBytes > 10_000);
		const original = readFileSync(join(out, "fixture.json"));
		await assert.rejects(runAcceptance(options), /EEXIST/);
		assert.deepEqual(readFileSync(join(out, "fixture.json")), original);
	} finally {
		globalThis.fetch = oldFetch;
		rmSync(root, { recursive: true, force: true });
	}
});

it("runs the production manual fold and subsequent main turn through an isolated SDK session", async () => {
	const root = mkdtempSync(join(tmpdir(), "fold-runner-sdk-"));
	const calls: boolean[] = [];
	try {
		const options = parseOptions([
			"--out",
			join(root, "out"),
			"--ledger",
			join(root, "ledger.jsonl"),
			"--auth-dir",
			root,
			"--model",
			"openrouter/acceptance-test",
			"--blocks",
			"2",
		]);
		await runAcceptance(options, async () => {
			const runtime = await ModelRuntime.create({
				authPath: join(root, "auth.json"),
				modelsPath: join(root, "models.json"),
				allowModelNetwork: false,
			});
			runtime.registerProvider("openrouter", {
				baseUrl: "http://127.0.0.1:0",
				api: "fold-local-test",
				apiKey: "local-test-only",
				models: [
					{
						id: "acceptance-test",
						name: "Acceptance test",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
				streamSimple: (_model, _context, opts) => {
					const side = opts?.toolChoice === "none";
					calls.push(side);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() =>
						stream.end(
							fauxAssistantMessage(
								side
									? "## Goal\nContinue the synthetic audit.\n\n## Progress\n### Done\n- [x] Audit complete.\n"
									: "ACCEPTANCE-CONTINUED: compare the next supplied change.",
							),
						),
					);
					return stream;
				},
			});
			return runtime;
		});
		assert.ok(calls[0]);
		assert.equal(calls.at(-1), false);
		const result = JSON.parse(readFileSync(join(root, "out", "result.json"), "utf8"));
		assert.equal(result.passed, true);
		assert.ok(result.afterTokens < result.initialTokens);
		assert.equal(result.afterBudget.spentUsd, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("automatic dry run records the opt-in policy and finalization fixture without runtime or network", async () => {
	const root = mkdtempSync(join(tmpdir(), "fold-auto-dry-"));
	const oldFetch = globalThis.fetch;
	globalThis.fetch = asFetch(async () => {
		throw new Error("no network allowed");
	});
	try {
		const options = parseOptions([
			"--scenario",
			"automatic",
			"--out",
			join(root, "out"),
			"--ledger",
			join(root, "ledger.jsonl"),
			"--dry-run",
		]);
		assert.equal(options.blocks, 8);
		assert.equal(options.window, 96000);
		assert.equal(options.ledger, join(root, "ledger.jsonl"));
		await runAcceptance(options, async () => {
			throw new Error("runtime must not open");
		});
		assert.equal(existsSync(options.ledger), false);
		const fixture = JSON.parse(readFileSync(join(options.out, "fixture.json"), "utf8"));
		assert.equal(fixture.request, AUTOMATIC_REQUEST);
		assert.ok(fixture.corpus.join("").length > 16000);
		const sm = SessionManager.create(root, join(root, "sessions"));
		seedCorpus(sm, fixture.corpus, { completedReview: true });
		const initialTokens = estimateAdmissionTokens(sm);
		assert.ok(initialTokens > AUTOMATIC_CONFIG.auto_navigate.rewind_at_tokens);
		assert.ok(initialTokens > 4000);
		assert.ok(initialTokens + 16384 < options.window);
		assert.match(JSON.stringify(sm.getBranch().at(-1)), /Synthetic completed review phase/);
		assert.doesNotMatch(fixture.request, /rewind|navigate_tree|classifier|confidence/i);
		assert.deepEqual(
			JSON.parse(readFileSync(join(options.out, "auto-config.json"), "utf8")),
			AUTOMATIC_CONFIG,
		);
	} finally {
		globalThis.fetch = oldFetch;
		rmSync(root, { recursive: true, force: true });
	}
});

it("intercepts chat and Decisions runtime calls with the same fetch and zero retries", async () => {
	const root = mkdtempSync(join(tmpdir(), "fold-intercept-"));
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: join(root, "models.json"),
			allowModelNetwork: false,
		});
		const seen: unknown[] = [];
		const calls: Parameters<Parameters<typeof interceptRuntime>[2]>[0][] = [];
		const fetch = asFetch(async () => {
			throw new Error("must not dispatch");
		});
		const stream = createAssistantMessageEventStream();
		runtime.streamSimple = (_model, _context, options) => {
			seen.push(options);
			return stream;
		};
		runtime.classify = async (model, _context, options) => {
			seen.push(options);
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason: "stop",
				timestamp: 1,
			};
		};
		interceptRuntime(runtime, fetch, (call) => calls.push(call));
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		runtime.streamSimple(
			{
				id: "chat",
				provider: "openrouter",
				api: "openai-completions",
				name: "Local chat",
				baseUrl: "http://127.0.0.1:0",
				reasoning: false,
				input: ["text"],
				contextWindow: 96000,
				maxTokens: 1024,
				cost,
			},
			{ messages: [] },
			{ maxRetries: 9 },
		);
		const classified = await runtime.classify(
			{
				type: "classifier",
				id: "decisions",
				provider: "openrouter",
				api: "typesafe",
				name: "Local Decisions",
				baseUrl: "http://127.0.0.1:0",
				input: ["text"],
				contextWindow: 96000,
				cost,
			},
			{ state: {}, questions: {} },
			{ maxRetries: 9 },
		);
		assert.equal(classified.stopReason, "stop");
		assert.deepEqual(seen, [
			{ maxRetries: 0, fetch },
			{ maxRetries: 0, fetch },
		]);
		assert.deepEqual(
			calls.map(({ api, model, side }) => ({ api, model, side })),
			[
				{ api: "chat", model: "openrouter/chat", side: false },
				{ api: "decisions", model: "openrouter/decisions", side: true },
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("routes an openai selector to the native Responses endpoint, refuses other hosts, and keeps dry runs offline", async () => {
	assert.equal(parseOptions(["--out", "/unused", "--dry-run"]).model, "openai/gpt-6-luna");
	assert.deepEqual(parseModelSelector("openai/gpt-6-luna"), {
		provider: "openai",
		modelId: "gpt-6-luna",
	});
	assert.deepEqual(parseModelSelector("openrouter/openai/gpt-6-luna"), {
		provider: "openrouter",
		modelId: "openai/gpt-6-luna",
	});
	assert.throws(() => parseModelSelector("acceptance-test"), /provider\/modelId/u);

	const root = mkdtempSync(join(tmpdir(), "fold-native-openai-"));
	const records: TransportRecord[] = [];
	const dispatched: string[] = [];
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
		allowModelNetwork: false,
	});
	const selector = parseModelSelector("openai/gpt-6-luna");
	const model = new ModelRegistry(runtime).find(selector.provider, selector.modelId);
	assert.ok(model);
	assert.equal(model.provider, "openai");
	assert.equal(model.id, "gpt-6-luna");
	assert.equal(model.api, "openai-responses");
	assert.equal(model.baseUrl, "https://api.openai.com/v1");
	const billing = nativeBilling(true);
	assert.deepEqual(await billing.settle({ dispatched: true, responseCostUsd: 0.001 }), {
		costUsd: 0.001,
		costSource: "response",
	});
	const table: ModelPricingTable = {
		routes: {
			retrievedAt: "2026-10-23T00:00:00.000Z",
			source: ["run.test.ts"],
			models: {},
		},
		models: [
			{
				id: model.id,
				kind: "chat",
				cost: model.cost,
				maxOutputTokens: model.maxTokens,
			},
		],
	};
	const ledger = BudgetLedger.open(join(root, "budget.jsonl"), 25);
	try {
		const transport = createBudgetedTransport({
			fetch: async (input) => {
				dispatched.push(String(input));
				return new Response(
					dispatched.length === 1
						? JSON.stringify({ id: "resp_1" })
						: 'data: {"type":"response.completed","response":{"usage":{"cost":0.001}}}\n\n',
					{ status: 200 },
				);
			},
			ledger,
			models: table,
			billing,
			natives: [{ provider: model.provider, baseUrl: model.baseUrl }],
			billingFor: () => billing,
			record: (record) => {
				records.push(record);
			},
		});
		const body = JSON.stringify({
			model: model.id,
			input: [{ type: "message", role: "user", content: "hi" }],
			stream: true,
			store: false,
		});
		const init = (): RequestInit => ({
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				authorization: "Bearer header-secret-value",
			},
		});
		const response = await transport.fetch("https://api.openai.com/v1/responses", init());
		assert.equal(response.status, 200);
		await transport.drain();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.endpoint, "responses");
		assert.equal(records[0]?.settlement.costSource, "subscription");
		assert.equal(records[0]?.settlement.costUsd, 0);
		assert.equal(JSON.stringify(records[0]).includes("header-secret-value"), false);
		assert.equal(
			(JSON.parse(records[0]?.requestBody ?? "{}") as { provider?: unknown }).provider,
			undefined,
		);
		assert.equal(ledger.snapshot().heldUsd, 0);
		await transport.fetch(`${model.baseUrl}/responses`, init());
		await transport.drain();
		assert.equal(records[1]?.responseCostUsd, 0.001);
		assert.deepEqual(records[1]?.settlement, {
			costUsd: 0.001,
			costSource: "response",
		});
		assert.equal(ledger.snapshot().spentUsd, 0.001);
		for (const url of [
			"https://api.openai.com/v1/chat/completions",
			"https://api.openai.com.evil.example/v1/responses",
			"https://evil.example/v1/responses",
		])
			await assert.rejects(() => transport.fetch(url, init()), /unsupported/u);
		assert.equal(dispatched.length, 2);
	} finally {
		ledger.close();
		rmSync(root, { recursive: true, force: true });
	}

	const oldFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = asFetch(async () => {
		calls++;
		throw new Error("no network allowed");
	});
	try {
		const out = join(root, "dry");
		const options = parseOptions([
			"--out",
			out,
			"--ledger",
			join(root, "unused.jsonl"),
			"--model",
			"openai/gpt-6-luna",
			"--dry-run",
		]);
		await runAcceptance(options, async () => {
			throw new Error("dry run must not create a runtime or read auth");
		});
		assert.equal(calls, 0);
		assert.equal(existsSync(options.ledger), false);
		const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
		assert.equal(result.dispatched, 0);
	} finally {
		globalThis.fetch = oldFetch;
		rmSync(root, { recursive: true, force: true });
	}
});

it("repeated-recovery acceptance needs two successful recoveries and a final request that fits", () => {
	const sm = SessionManager.inMemory();
	const recovered = (status: string) =>
		sm.appendCustomMessageEntry("navigate-tree-rewind", "receipt", true, {
			status,
			origin: "recovery",
		});
	sm.appendMessage({ role: "user", content: "request", timestamp: 1 });
	recovered("done");
	const answer = (input: number) =>
		sm.appendMessage({
			...fauxAssistantMessage("ACCEPTANCE-CONTINUED"),
			usage: {
				input,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	answer(1000);
	const check = () => verifyRepeatedRecovery(sm.getBranch(), sm.getEntries(), 32000, 2);
	assert.throws(check, /at least 2 recoveries \(saw 1\)/);
	recovered("done");
	answer(40000);
	assert.throws(check, /fit the operating window/);
	answer(1000);
	check();
	recovered("failed");
	assert.throws(check, /refused or fail/);
});

it("rejects malformed scenarios and unsafe fixture sizes before execution", () => {
	for (const args of [
		["--scenario", "unknown"],
		["--scenario", "automatic"],
		["--scenario", "automatic", "--ledger", "relative-copy.jsonl"],
		["--blocks", "NaN"],
		["--blocks", "0"],
		["--window", "-1"],
		["--model", "acceptance-test"],
	]) {
		assert.throws(() => parseOptions(["--out", "/unused", ...args]));
	}
});
