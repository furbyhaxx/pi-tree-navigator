/**
 * Production preflight recovery through the real SDK loop and a local provider.
 * The lifecycle stand-in is not this test: the production extension, engine, and
 * registry side-call summarizer run here.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import navigateTree, {
	estimateAdmissionTokens,
	PRESSURE_COMPACTION_CUSTOM_TYPE,
} from "../../src/index.ts";

const WINDOW = 32_000;
const RESERVE = 1_024 + 4_096;
const REQUEST = "preserve-9f3c2a answer this exact request";
const EVIDENCE = "FOLDED-EVIDENCE-";
const SUMMARY = `## Goal
Continue the preserved request.

## Progress
### Done
- [x] Collapsed the seeded branch.
`;

interface RecordedCall {
	side: boolean;
	aborted: boolean;
	tokens: number;
	text: string;
}

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if ("text" in block && typeof block.text === "string") return block.text;
			return "";
		})
		.join("");
}

function callTokens(messages: readonly { content?: unknown }[]): number {
	return Math.ceil(JSON.stringify(messages).length / 3.5);
}

function summaryReply(): AssistantMessage {
	return fauxAssistantMessage(SUMMARY);
}

function abortedReply(): AssistantMessage {
	return fauxAssistantMessage([], {
		stopReason: "aborted",
		errorMessage: "aborted",
	});
}

/** Tool turns the `regrow` agent runs after its first recovery; together they overflow again. */
const REGROW_TURNS = 4;
const REGROW_RESULT = `REGROW-EVIDENCE-${"dolor sit amet ".repeat(2_000)}`;

async function withSession(
	mode: "recover" | "cancel" | "no-anchor" | "regrow",
	run: (harness: {
		sm: SessionManager;
		prompt: (text: string) => Promise<string | undefined>;
		calls: RecordedCall[];
		abort: () => Promise<void>;
		sideStarted: Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-preflight-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_OFFLINE = "1";
	const cwd = join(dir, "work");
	const api = `mock-api-${mode}`;
	const faux = createFauxCore({
		api,
		provider: "mock",
		models: [
			{
				id: "mock-1",
				name: "Mock 1",
				reasoning: false,
				input: ["text"],
				contextWindow: WINDOW,
				maxTokens: 8_000,
			},
		],
	});
	const calls: RecordedCall[] = [];
	let markSideStarted = () => {};
	const sideStarted = new Promise<void>((resolve) => {
		markSideStarted = resolve;
	});
	const streamSimple = (
		_model: Parameters<typeof faux.streamSimple>[0],
		context: Parameters<typeof faux.streamSimple>[1],
		options: Parameters<typeof faux.streamSimple>[2],
	) => {
		const side = options?.toolChoice === "none";
		const text = (context.messages ?? []).map((message) => messageText(message)).join("\n");
		calls.push({
			side,
			aborted: options?.signal?.aborted === true,
			tokens: callTokens(context.messages ?? []),
			text,
		});
		if (side && mode === "cancel") {
			markSideStarted();
			const stream = createAssistantMessageEventStream();
			const finish = () => stream.end(abortedReply());
			if (options?.signal?.aborted) finish();
			else options?.signal?.addEventListener("abort", finish, { once: true });
			return stream;
		}
		const mainCalls = calls.filter((call) => !call.side).length;
		const reply = side
			? summaryReply()
			: mode === "regrow" && mainCalls <= REGROW_TURNS
				? fauxAssistantMessage([fauxToolCall("grow", {}, { id: `grow-${mainCalls}` })], {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage("recovered answer");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.end(reply));
		return stream;
	};
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		allowModelNetwork: false,
	});
	runtime.registerProvider("mock", {
		baseUrl: "http://127.0.0.1:0",
		apiKey: "mock-key",
		api,
		streamSimple,
		models: [
			{
				id: "mock-1",
				name: "Mock 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: WINDOW,
				maxTokens: 8_000,
			},
		],
	});
	const model = runtime.getModel("mock", "mock-1");
	if (!model) throw new Error("mock model was not registered");
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		defaultThinkingLevel: "off",
	});
	const sm = SessionManager.inMemory(cwd);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager: settings,
		noExtensions: true,
		extensionFactories: [
			navigateTree,
			(pi) =>
				pi.registerTool({
					name: "grow",
					label: "Grow",
					description: "Returns a large synthetic result.",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: REGROW_RESULT }],
						details: {},
					}),
				}),
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a test agent.",
	});
	await loader.reload();
	const loadErrors = loader.getExtensions().errors;
	if (loadErrors.length > 0) {
		throw new Error(JSON.stringify(loadErrors));
	}
	const { session } = await createAgentSession({
		cwd,
		agentDir: dir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "off",
		tools: mode === "regrow" ? ["navigate_tree", "grow"] : ["navigate_tree"],
		resourceLoader: loader,
		sessionManager: sm,
		settingsManager: settings,
	});
	await session.bindExtensions({
		mode: "json",
		abortHandler: () => {
			void session.abort();
		},
	});
	try {
		const anchor = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed the anchor" }],
			timestamp: 1,
		} as never);
		const anchored = sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor reply" }],
			stopReason: "stop",
			timestamp: 2,
		} as never);
		if (mode !== "no-anchor") sm.appendLabelChange(anchored, "anchor:start");
		const filler = `${EVIDENCE}${"lorem ipsum ".repeat(800)}`;
		let guard = 0;
		while (estimateAdmissionTokens(sm) + RESERVE <= WINDOW && guard < 12) {
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: `${filler} user ${guard}` }],
				timestamp: 3 + guard,
			} as never);
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `${filler} assistant ${guard}` }],
				stopReason: "stop",
				timestamp: 4 + guard,
			} as never);
			guard++;
		}
		assert.ok(
			estimateAdmissionTokens(sm) + RESERVE > WINDOW,
			"the seeded branch must already exceed the admission guard",
		);
		assert.notEqual(sm.getLeafId(), anchor);
		await run({
			sm,
			calls,
			sideStarted,
			abort: () => session.abort(),
			prompt: async (text) => {
				try {
					await session.prompt(text);
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
		await session.waitForIdle();
	} finally {
		try {
			session.dispose();
		} catch {
			// The temp directory is removed either way.
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		await rm(dir, { recursive: true, force: true });
	}
}

function userText(entry: {
	type: string;
	message?: { role?: string; content?: unknown };
}): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
	return messageText(entry.message);
}

describe("production preflight recovery", () => {
	it("folds an oversized request in the same run and preserves it", async () => {
		await withSession("recover", async ({ sm, prompt, calls }) => {
			const rejected = await prompt(REQUEST);
			assert.equal(rejected, undefined, String(rejected));
			const main = calls.filter((call) => !call.side && !call.aborted);
			const side = calls.filter((call) => call.side);
			assert.equal(main.length, 1, JSON.stringify(calls.map((call) => call.side)));
			assert.ok(side.length > 0, "the production summarizer made a side call");
			assert.ok(side.length <= 16, `side calls were not bounded: ${side.length}`);
			for (const call of side) {
				assert.ok(call.tokens + 8_000 < WINDOW, `side call was not bounded: ${call.tokens}`);
			}
			assert.equal(
				side.some((call) => call.text.includes(EVIDENCE)),
				true,
				"a side call must see the folded evidence",
			);
			assert.ok(main[0].tokens + RESERVE <= WINDOW, `main transport ${main[0].tokens}`);
			assert.equal(main[0].text.includes(EVIDENCE), false);
			assert.equal(main[0].text.includes(REQUEST), true);
			const branch = sm.getBranch();
			const summaryAt = branch.findIndex((entry) => entry.type === "branch_summary");
			assert.ok(summaryAt >= 0, "branch_summary was not written");
			const preserved = branch
				.slice(summaryAt + 1)
				.map((entry) => userText(entry))
				.filter((text): text is string => text !== undefined);
			assert.ok(
				preserved.some((text) => text === REQUEST),
				`request was not preserved verbatim: ${JSON.stringify(preserved)}`,
			);
			assert.equal(
				branch.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						messageText(entry.message).includes("recovered answer"),
				),
				true,
			);
		});
	});

	it("recovers again when the run overflows a second time after the recovered request generated", async () => {
		await withSession("regrow", async ({ sm, prompt, calls }) => {
			const rejected = await prompt(REQUEST);
			assert.equal(rejected, undefined, String(rejected));
			const recoveries = sm
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === "navigate-tree-rewind"
						? [entry.details as { status?: string; origin?: string }]
						: [],
				);
			assert.deepEqual(
				recoveries.map((details) => `${details.origin}:${details.status}`),
				["recovery:done", "recovery:done"],
				JSON.stringify(recoveries),
			);
			const main = calls.filter((call) => !call.side && !call.aborted);
			assert.equal(main.length, REGROW_TURNS + 1);
			for (const call of main) assert.ok(call.tokens + RESERVE <= WINDOW, `main ${call.tokens}`);
			assert.ok(
				messageText(
					(
						sm.getBranch().findLast((entry) => entry.type === "message") as {
							message: { content?: unknown };
						}
					).message,
				).includes("recovered answer"),
			);
		});
	});

	it("uses current edited work and replays unanswered input across later metadata", async () => {
		await withSession("recover", async ({ sm, prompt, calls }) => {
			const work = sm
				.getBranch()
				.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(work);
			const obsolete = `OBSOLETE-WORK-UNIQUE${"old work ".repeat(1200)}`;
			const edited = `CURRENT-EDITED-WORK-UNIQUE${"new work ".repeat(1200)}`;
			sm.appendContextEdit(work.id, {
				content: [{ type: "text", text: obsolete }],
			});
			const custom = "preserve exact custom input";
			const append = sm.appendMessage.bind(sm);
			let requestId = "";
			sm.appendMessage = (message) => {
				const id = append(message);
				if (message.role === "user" && messageText(message) === REQUEST) {
					requestId = id;
					sm.appendLabelChange(id, "request-metadata");
					sm.appendModelChange("mock", "mock-1");
					sm.appendCustomEntry("navigate-tree-continuity-ops", {});
					sm.appendCustomMessageEntry("other-extension", custom, true, {
						exact: 1,
					});
					sm.appendContextEdit(work.id, {
						content: [{ type: "text", text: edited }],
					});
				}
				return id;
			};
			assert.equal(await prompt(REQUEST), undefined);
			assert.ok(calls.some((call) => call.side));
			const evidence = calls
				.filter((call) => call.side)
				.map((call) => call.text)
				.join("\n");
			assert.ok(evidence.includes(edited), "summary must receive the current edit");
			assert.equal(evidence.includes(obsolete), false);
			assert.equal(evidence.includes(custom), false);
			assert.equal(
				calls.some((call) => call.side && call.text.includes(`[${requestId}] user:`)),
				false,
				"the unanswered request must not become an evidence record",
			);
			const branch = sm.getBranch();
			const summaryAt = branch.findIndex((entry) => entry.type === "branch_summary");
			assert.ok(summaryAt >= 0);
			assert.ok(
				branch
					.slice(summaryAt + 1)
					.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "other-extension" &&
							entry.content === custom &&
							entry.display === true &&
							JSON.stringify(entry.details) === JSON.stringify({ exact: 1 }),
					),
			);
			assert.ok(branch.slice(summaryAt + 1).some((entry) => userText(entry) === REQUEST));
		});
	});

	it("refuses interleaved tool results without rewriting history or calling a model", async () => {
		await withSession("recover", async ({ sm, prompt, calls }) => {
			sm.appendMessage(
				fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "interleaved",
							name: "read",
							arguments: {},
						},
					],
					{ stopReason: "toolUse" },
				),
			);
			const before = sm.getEntries().map((entry) => JSON.stringify(entry));
			const append = sm.appendMessage.bind(sm);
			sm.appendMessage = (message) => {
				const id = append(message);
				if (message.role === "user" && messageText(message) === REQUEST) {
					append({
						role: "toolResult",
						toolCallId: "interleaved",
						toolName: "read",
						content: [{ type: "text", text: "real interleaved result" }],
						isError: false,
						timestamp: 1,
					});
				}
				return id;
			};
			await prompt(REQUEST);
			assert.equal(calls.length, 0);
			assert.deepEqual(
				sm
					.getEntries()
					.slice(0, before.length)
					.map((entry) => JSON.stringify(entry)),
				before,
			);
			assert.equal(
				sm.getEntries().some((entry) => entry.type === "branch_summary"),
				false,
			);
			for (const entry of sm.getEntries()) {
				if (entry.type !== "context_edit") continue;
				const target = sm.getEntry(entry.targetId);
				assert.ok(target?.type === "message" && target.message.role === "assistant");
				assert.equal(target.message.stopReason, "error");
			}
			assert.ok(sm.getBranch().some((entry) => userText(entry) === REQUEST));
		});
	});

	it("cancels a waiting side call without committing or calling the main model", async () => {
		await withSession("cancel", async ({ sm, prompt, calls, abort, sideStarted }) => {
			const pending = prompt(REQUEST);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					sideStarted,
					new Promise((_, reject) => {
						timeout = setTimeout(() => reject(new Error("side call did not start")), 15_000);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
			await abort();
			await pending;
			assert.equal(
				calls.some((call) => !call.side),
				false,
				JSON.stringify(calls),
			);
			assert.equal(
				sm.getBranch().some((entry) => entry.type === "branch_summary"),
				false,
			);
		});
	});

	it("contains candidate-pricing failures without dispatching an oversized request", async () => {
		await withSession("recover", async ({ sm, prompt, calls }) => {
			sm.getLabel = () => {
				throw new Error("candidate labels unavailable");
			};
			await prompt(REQUEST);
			assert.equal(calls.filter((call) => !call.side && !call.aborted).length, 0);
			assert.equal(
				sm.getBranch().some((entry) => entry.type === "branch_summary"),
				false,
			);
			const receipts = sm
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "navigate-tree-rewind",
				);
			assert.equal(receipts.length, 1);
			assert.match(JSON.stringify(receipts[0]), /candidate labels unavailable/);
		});
	});

	it("compacts older work and lets the request through when no anchor is valid", async () => {
		await withSession("no-anchor", async ({ sm, prompt, calls }) => {
			const error = await prompt(REQUEST);
			assert.equal(error, undefined);
			const main = calls.filter((call) => !call.side && !call.aborted);
			assert.equal(main.length, 1, JSON.stringify(calls));
			assert.ok(main[0].tokens + RESERVE <= WINDOW, "the sent request fits");
			assert.ok(
				calls.some((call) => call.side),
				"a summary side call ran",
			);
			const compaction = sm.getBranch().findLast((entry) => entry.type === "compaction");
			assert.ok(compaction, "a compaction replaced the older work");
			const receipts = sm
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" && entry.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
				);
			assert.equal(receipts.length, 1, JSON.stringify(receipts));
			const receipt = receipts[0];
			assert.equal(receipt.type, "custom_message");
			if (receipt.type !== "custom_message") return;
			assert.equal((receipt.details as { origin?: string }).origin, "recovery");
			assert.match(
				messageText({ content: receipt.content }),
				/no fold could relieve it \(.*no anchors on the active branch/,
			);
		});
	});
});
