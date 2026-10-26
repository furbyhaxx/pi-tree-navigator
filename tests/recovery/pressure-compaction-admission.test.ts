/** Extension pressure compaction admission tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionCommandContext,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { appendOpsEntry } from "../../src/continuity/continuity-store.ts";
import { estimateRawRequestTokens, estimateRequestTokens } from "../../src/core/context-tokens.ts";
import { formatPct1 } from "../../src/core/helpers.ts";
import { ANCHOR_MANDATE, estimateAdmissionTokens } from "../../src/core/request-accounting.ts";
import { buildRewindHintText } from "../../src/core/rewind-hint.ts";
import { __testHooks, PRESSURE_COMPACTION_CUSTOM_TYPE } from "../../src/index.ts";
import { fireAgentSettled, fireContext, fireTurnEndAll } from "../support/boundary-drivers.ts";
import {
	cleanupConfigFixture,
	fireTurnEnd,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "../support/config-fixtures.ts";
import {
	type BoundaryDraft,
	type BoundaryResult,
	type FakeCtx,
	type FakePi,
	makeCtx,
	setup,
} from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, reply } from "../support/model-registry.ts";
import {
	BIG,
	errorOverflow,
	type Forced,
	forcedDrafts,
	forcedSetup,
	runErrorEnd,
} from "../support/pressure-fixtures.ts";
import { makeFakeSession } from "../support/session-fakes.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
	usageOf,
} from "../support/session-messages.ts";

installHarnessHooks();

async function autoFixture(
	answer: (context: ClassifierContext) => Promise<{ status: string; boundary?: string }>,
	config: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	const policy = {
		classifier: { model: "test/milestone" },
		confirmer: { model: null },
	};
	const f = await forcedSetup({
		config: {
			auto_navigate: {
				enabled: true,
				milestone: policy,
				check_every_turns: 3,
				min_tokens_since_anchor: 100_000,
				rewind_at_tokens: 80_000,
				pressure: "fold",
				...config,
			},
			...overrides,
		},
	});
	const summaries = fakeRegistry();
	const questions: ClassifierContext[] = [];
	const classifierModels: string[] = [];
	Object.assign(f.ctx, {
		modelRegistry: {
			...summaries.registry,
			getAvailableOfType: async (type: string) =>
				type === "classifier"
					? ["milestone", "base"].map((id) => ({
							provider: "test",
							id,
							api: "decisions",
						}))
					: [],
			classify: async (model: { id: string }, context: ClassifierContext) => {
				classifierModels.push(model.id);
				questions.push(context);
				const result = await answer(context);
				const choices = {
					status: result.status,
					boundary: result.boundary ?? "none",
				};
				return {
					answers: Object.fromEntries(
						Object.entries(choices).map(([id, choice]) => [
							id,
							{ type: "choice", choice, confidence: 0.95, probabilities: {} },
						]),
					),
					stopReason: "stop",
				};
			},
		},
	});
	return { ...f, summaries, questions, classifierModels };
}

async function autoTurn(f: Forced, tokens: number, text = "working") {
	const turn = appendTurn(f.sm, "continue", text, tokens);
	const entry = f.sm.getEntry(turn.assistantId);
	assert.ok(entry?.type === "message");
	return fireTurnEndAll(f.pi, f.ctx, entry.message);
}

const newestBoundary = (context: ClassifierContext) => {
	const question = context.questions.boundary;
	assert.ok(question?.type === "choice");
	const records = (context.state as { records: { id: string }[] }).records;
	const id = records.at(-1)?.id;
	assert.ok(id && id in question.criteria);
	return id;
};

function assertNoAutoSteer(f: Forced, boundary: BoundaryResult) {
	assert.ok(!boundary.entries.some((entry) => entry.customType === "navigate-tree-auto-rewind"));
	assert.equal(f.pi.sendUserMessageCalls.length, 0);
	assert.ok(
		!f.pi.sendMessageCalls.some(
			(args) => (args[0] as { customType?: string }).customType === "navigate-tree-auto-rewind",
		),
	);
}

/** A pressure compaction landed above `target` and its receipt says so; returns the priced result. */
function assertAboveTargetCompaction(
	f: Awaited<ReturnType<typeof autoFixture>>,
	boundary: BoundaryResult,
	target: number,
): number {
	assert.ok(f.summaries.calls.length > 0, "the compaction ran");
	assert.ok(
		f.sm.getBranch().some((value) => value.type === "compaction"),
		JSON.stringify(boundary),
	);
	const receipt = boundary.entries.find(
		(value) => value.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
	);
	assert.ok(receipt, JSON.stringify(boundary));
	const details = receipt.details as {
		after: number;
		target: number;
		aboveTarget: boolean;
	};
	assert.equal(details.target, target);
	assert.equal(details.aboveTarget, true);
	assert.ok(details.after > target);
	assert.match(String(receipt.content), new RegExp(`above the ~${target / 1000}k target`));
	return details.after;
}

/** A tool turn whose result carries about `tokens` tokens of evidence. */
function toolTurn(f: Forced, id: string, tokens: number, usage = 0) {
	const assistantId = f.sm.appendMessage(
		assistantMessage(
			[{ type: "toolCall", id, name: "read", arguments: {} }],
			"toolUse",
			usage,
		) as never,
	);
	appendToolResult(f.sm, id, "read", "e".repeat(tokens * 4));
	return assistantId;
}

describe("rewind-driven compaction (#101)", () => {
	describe("one admission estimate", () => {
		/** Host-heuristic tokens (4 chars each) of filler text. */
		const filler = (tokens: number) => "x".repeat(tokens * 4);
		const userMessage = (text: string) =>
			({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: 0,
			}) as never;

		/** A session at `window` with a pre-baseline body, a measured turn and a short tail. */
		async function admissionSetup(
			window: number,
			baseline: { bodyTokens: number; measured: number; tailTokens: number },
		) {
			const fixture = makeConfigFixture();
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 20_000 }));
			const f = setup({ contextWindow: window });
			f.ctx.cwd = fixture.projectDir;
			await runSessionStart(f.pi, f.ctx, fixture);
			const turn = appendTurn(f.sm, filler(baseline.bodyTokens), "a1", baseline.measured);
			f.pi.pi.setLabel(turn.assistantId, "anchor:start");
			f.sm.appendMessage(userMessage(filler(baseline.tailTokens)));
			return { fixture, ...f, userId: turn.userId };
		}

		/** Fire the request guard on `messages`; the aborter tells whether it refused. */
		async function guard(
			f: { pi: FakePi; ctx: FakeCtx },
			messages: Array<Record<string, unknown>>,
		) {
			const aborter = new AbortController();
			const ctx = {
				...f.ctx,
				signal: aborter.signal,
				abort: () => aborter.abort(),
			};
			for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
				await handler({ type: "context_with_system", messages } as never, ctx as never);
			}
			return aborter.signal.aborted;
		}

		/** What a refused request leaves behind: the failure receipt's estimate. */
		async function refusalEstimate(f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx }) {
			const aborted = assistantMessage([], "aborted", 0);
			f.sm.appendMessage(aborted as never);
			const result = await fireTurnEndAll(f.pi, f.ctx, aborted, {
				commit: true,
			});
			assert.equal(result.continue, false);
			const failed = forcedDrafts(result).at(-1);
			assert.equal(failed?.details.reason, "insufficient request headroom");
			return Number(failed?.details.inputEstimate);
		}

		// The reported session: a 372k window, a valid 307,882-token usage
		// baseline, a ~4.8k-token tail, and a whole-content scan (324.5k host
		// tokens, 371k once scaled to the SDK's heuristic) that out-grows the
		// measured baseline.
		const REPORTED = {
			bodyTokens: 319_700,
			measured: 307_882,
			tailTokens: 4_800,
		};

		it("admits a request whose recorded usage plus its tail fits, though a whole-content scan would not", async () => {
			const f = await admissionSetup(372_000, REPORTED);
			try {
				const messages = [
					{ role: "system", content: "rules", timestamp: 0 },
					...fireContext(f.pi, f.ctx),
				];
				const scan = estimateRequestTokens(
					messages.map((m) => ({ ...m, usage: undefined })) as never,
				);
				assert.ok(scan + 5_120 > 372_000, "the whole-content scan refuses it");
				assert.equal(await guard(f, messages), false);
				const admission = estimateAdmissionTokens(f.sm);
				assert.ok(admission + 5_120 <= 372_000);
				assert.ok(admission > REPORTED.measured);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		});

		it("still refuses when the baseline is stale: a model switch or a context edit", async () => {
			for (const invalidate of ["model switch", "context edit"]) {
				const f = await admissionSetup(372_000, REPORTED);
				try {
					if (invalidate === "model switch") {
						f.sm.appendModelChange("other", "other-model");
					} else {
						f.sm.appendContextEdit(f.userId, {
							content: [{ type: "text", text: filler(REPORTED.bodyTokens - 1_000) }],
						} as never);
					}
					const messages = [
						{ role: "system", content: "rules", timestamp: 0 },
						...fireContext(f.pi, f.ctx),
					];
					assert.equal(await guard(f, messages), true, invalidate);
					assert.ok(
						(await refusalEstimate(f)) + 5_120 > 372_000,
						`${invalidate}: the receipt carries the whole-content estimate`,
					);
				} finally {
					cleanupConfigFixture(f.fixture);
				}
			}
		});

		it("counts the anchor mandate once: not when the system message already carries it", async () => {
			// 94,880 + the 5,120 the guard keeps free is exactly the 100k window.
			const chars = 332_080;
			const withMandate = {
				role: "system",
				content: "x".repeat(chars - ANCHOR_MANDATE.length) + ANCHOR_MANDATE,
				timestamp: 0,
			};
			const without = { ...withMandate, content: "x".repeat(chars) };
			assert.equal(estimateRequestTokens([withMandate] as never), 94_880);
			assert.equal(estimateRequestTokens([without] as never), 94_880);

			const carried = await admissionSetup(100_000, {
				bodyTokens: 1,
				measured: 0,
				tailTokens: 1,
			});
			try {
				assert.equal(await guard(carried, [withMandate]), false);
			} finally {
				cleanupConfigFixture(carried.fixture);
			}
			const bare = await admissionSetup(100_000, {
				bodyTokens: 1,
				measured: 0,
				tailTokens: 1,
			});
			try {
				assert.equal(await guard(bare, [without]), true);
				assert.equal(await refusalEstimate(bare), 94_880 + Math.ceil(ANCHOR_MANDATE.length / 3.5));
			} finally {
				cleanupConfigFixture(bare.fixture);
			}
		});

		it("derives the hint, the anchor list and the request guard from one number", async () => {
			const WINDOW_TOKENS = 100_000;
			const f = await admissionSetup(WINDOW_TOKENS, {
				bodyTokens: 100,
				measured: 95_000,
				tailTokens: 1_000,
			});
			try {
				const mandate = Math.ceil(ANCHOR_MANDATE.length / 3.5);
				const admission = estimateAdmissionTokens(f.sm);
				assert.equal(admission, 95_000 + Math.ceil((1_000 * 8) / 7) + mandate);
				// pi's own estimate disagrees on purpose.
				f.ctx.getContextUsage = () => ({
					tokens: 90_000,
					contextWindow: WINDOW_TOKENS,
					percent: 90,
				});

				const listed = await f.tool.execute(
					"tc-list",
					{ action: "list" },
					undefined,
					undefined,
					f.ctx,
				);
				assert.equal(listed.details.contextTokens, admission);
				assert.match(
					listed.content[0].text,
					new RegExp(`ctx ${formatPct1(admission, WINDOW_TOKENS)} of 100k`),
				);

				const anchorCommand = f.pi.commands.get("anchor");
				assert.ok(anchorCommand);
				const command = makeCtx(f.sm, {
					contextWindow: WINDOW_TOKENS,
					hasUI: false,
				});
				await anchorCommand.handler("list", command as unknown as ExtensionCommandContext);
				// The anchor sits on the measured turn: its footprint is the usage and the mandate.
				const savable = admission - (95_000 + mandate);
				assert.ok(
					command.notifyCalls[0][0].includes(`−${(savable / 1000).toFixed(1)}k savable`),
					command.notifyCalls[0][0],
				);

				const messages = [
					{ role: "system", content: "rules", timestamp: 0 },
					...fireContext(f.pi, f.ctx),
				];
				assert.equal(await guard(f, messages), true);

				fireTurnEnd(f.pi, f.ctx);
				const hint = (f.pi.sendMessageCalls[0][0] as { content: string }).content;
				assert.equal(
					hint.split("\n")[0],
					buildRewindHintText(
						(admission / WINDOW_TOKENS) * 100,
						WINDOW_TOKENS - admission,
						20_000,
						WINDOW_TOKENS,
						"",
					).split("\n")[0],
				);

				assert.equal(await refusalEstimate(f), admission);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		});
	});

	it("delivers a failure receipt if a later handler invalidates the boundary", async () => {
		const f = await forcedSetup();
		try {
			const aborter = new AbortController();
			const ctx = {
				...f.ctx,
				signal: aborter.signal,
				abort: () => aborter.abort(),
			};
			for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
				await handler(
					{
						type: "context_with_system",
						messages: [{ role: "system", content: "s".repeat(350_000), timestamp: 0 }],
					} as never,
					ctx as never,
				);
			assert.equal(aborter.signal.aborted, true);
			f.pi.onCalls.get("turn_end")?.push((event) => ({
				entries: [
					...(event as { entries: BoundaryDraft[] }).entries,
					{ type: "context_edit", targetId: "off-branch", replacement: null },
				],
				continue: false,
			}));
			const aborted = assistantMessage([], "aborted", 0);
			f.sm.appendMessage(aborted as never);
			const boundary = await fireTurnEndAll(f.pi, f.ctx, aborted);
			assert.deepEqual(boundary.entries, [], "Pi rejects the whole boundary");
			await fireAgentSettled(f.pi, f.ctx, true);
			assert.equal(f.pi.sendMessageCalls.length, 1);
			const receipt = f.pi.sendMessageCalls[0][0] as { content: string };
			assert.match(receipt.content, /Request stopped before generation/);
			await fireAgentSettled(f.pi, f.ctx, true);
			assert.equal(f.pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("accounts for the final forced prompt rather than the earlier persisted system view", async () => {
		for (const oversized of [true, false]) {
			const f = await forcedSetup();
			try {
				const fake = {
					...makeFakeSession(f.sm),
					_runSystemPromptOptions: {
						forceSystemPrompt: oversized ? "s".repeat(350_000) : "short final prompt",
					},
				};
				__testHooks.captureSession(fake as unknown as AgentSession);
				const aborter = new AbortController();
				const ctx = {
					...f.ctx,
					signal: aborter.signal,
					abort: () => aborter.abort(),
				};
				const messages = [
					{
						role: "system",
						content: oversized ? "old short prompt" : "s".repeat(350_000),
						timestamp: 0,
					},
				];
				for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
					await handler({ type: "context_with_system", messages } as never, ctx as never);
				assert.equal(aborter.signal.aborted, oversized);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("refuses independent recovery when the final forced system prompt cannot fit", async () => {
		const f = await forcedSetup();
		try {
			f.sm.appendModelChange("other", "other-model");
			__testHooks.captureSession({
				...makeFakeSession(f.sm),
				_runSystemPromptOptions: { forceSystemPrompt: "s".repeat(350_000) },
			} as unknown as AgentSession);
			const { settle } = await runErrorEnd(f, errorOverflow(f.sm).message);
			assert.equal(settle.continue, false);
			assert.ok(!settle.entries.some((entry) => entry.type === "context_edit"));
			assert.equal(forcedDrafts(settle)[0].details.status, "failed");
			assert.match(forcedDrafts(settle)[0].content, /system prompt alone/);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("keeps a feasible complete request and system declarations intact", async () => {
		const f = await forcedSetup();
		try {
			const aborter = new AbortController();
			const ctx = {
				...f.ctx,
				signal: aborter.signal,
				abort: () => aborter.abort(),
			};
			const messages = [{ role: "system", content: "rules", timestamp: 0 }];
			for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
				const result = await handler(
					{ type: "context_with_system", messages } as never,
					ctx as never,
				);
				assert.equal(result, undefined);
			}
			assert.equal(aborter.signal.aborted, false);
			assert.equal(messages[0].content, "rules");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate classifies on its cadence below rewind_at_tokens and never folds", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }));
		try {
			await autoTurn(f, 50_000);
			await autoTurn(f, 51_000);
			assert.equal(f.questions.length, 0);
			await autoTurn(f, 52_000);
			assert.equal(f.questions.length, 1);
			await autoTurn(f, 53_000);
			await autoTurn(f, 54_000);
			assert.equal(f.questions.length, 1);
			await autoTurn(f, 55_000);
			assert.equal(f.questions.length, 2);
			assert.equal(f.summaries.calls.length, 0);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate anchors an older accepted boundary without folding or recounting work", async () => {
		let target = "";
		const f = await autoFixture(async () => ({ status: "milestone", boundary: target }), {
			min_tokens_since_anchor: 10_000,
		});
		try {
			target = appendTurn(f.sm, "earlier", "# Earlier milestone", 20_000).assistantId;
			const boundary = await autoTurn(f, 50_000);
			assert.equal(f.sm.getLabel(target), "anchor:earlier-milestone");
			assert.equal(f.summaries.calls.length, 0);
			assertNoAutoSteer(f, boundary);
			assert.ok(!f.sm.getEntries().some((entry) => entry.type === "branch_summary"));
			await autoTurn(f, 51_000);
			assert.equal(f.questions.length, 1);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate folds at rewind_at_tokens through the engine without asking a classifier", async () => {
		const f = await autoFixture(async () => {
			throw new Error("a classifier must not decide a pressure fold");
		});
		try {
			const boundary = await autoTurn(f, 90_000);
			assert.equal(boundary.continue, true);
			const [done] = forcedDrafts(boundary);
			assert.equal(done?.details.status, "done", JSON.stringify(boundary));
			assert.equal(done.details.origin, "auto");
			assert.equal(done.details.rewindTo, "start");
			assert.equal(f.questions.length, 0);
			assert.ok(f.summaries.calls.length > 0);
			assert.ok(f.sm.getBranch().some((entry) => entry.type === "branch_summary"));
			assertNoAutoSteer(f, boundary);
			const calls = f.summaries.calls.length;
			await autoTurn(f, 85_000);
			assert.equal(
				f.summaries.calls.length,
				calls,
				"another pressure fold needs min_tokens_since_anchor fresh tokens",
			);
			assert.equal(f.questions.length, 0);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate folds to the oldest valid anchor when none reaches half of rewind_at_tokens, and says so", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			rewind_at_tokens: 2_000,
		});
		try {
			const boundary = await autoTurn(f, 90_000);
			assert.ok(f.summaries.calls.length > 0, "the fold ran");
			assert.ok(f.sm.getBranch().some((entry) => entry.type === "branch_summary"));
			const [done] = forcedDrafts(boundary);
			assert.equal(done?.details.status, "done", JSON.stringify(boundary));
			assert.equal(done.details.aboveTarget, true);
			assert.match(
				String(done.content),
				/No anchor lands under the ~1k pressure target .* oldest valid anchor/,
			);
			const calls = f.summaries.calls.length;
			await autoTurn(f, 90_500);
			assert.equal(
				f.summaries.calls.length,
				calls,
				"the next pressure fold waits for the retry runway",
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate persists a visible warning when a pressure fold has no valid target", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }));
		try {
			const base = f.sm.getBranch().find((entry) => f.sm.getLabel(entry.id) === "anchor:start");
			assert.ok(base);
			f.pi.pi.setLabel(base.id, undefined);
			const boundary = await autoTurn(f, 90_000);
			const warnings = boundary.entries.filter(
				(entry) => entry.customType === "navigate-tree-auto-warning",
			);
			assert.equal(warnings.length, 1, JSON.stringify(boundary));
			assert.match(String(warnings[0].content), /crossed rewind_at_tokens .* but no fold ran/);
			assert.ok(
				f.ctx.notifyCalls.some(
					([text, level]) => level === "warning" && text.includes("no fold ran"),
				),
			);
			assert.equal(boundary.continue, false);
			assert.equal(f.questions.length, 0);
			assert.equal(f.summaries.calls.length, 0);
			assert.ok(!f.sm.getEntries().some((entry) => entry.type === "branch_summary"));
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate keeps an unanswered request verbatim through a pressure fold", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }));
		try {
			const done = appendTurn(f.sm, "completed task", "# Done", 90_000);
			const entry = f.sm.getEntry(done.assistantId);
			assert.ok(entry?.type === "message");
			const request = "A new unanswered request: also update the changelog.";
			f.sm.appendMessage({ role: "user", content: request, timestamp: 1 });
			const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);
			const [result] = forcedDrafts(boundary);
			assert.equal(result?.details.status, "done", JSON.stringify(boundary));
			const branch = f.sm.getBranch();
			const summaryAt = branch.findIndex((value) => value.type === "branch_summary");
			assert.ok(summaryAt >= 0);
			assert.ok(
				branch
					.slice(summaryAt)
					.some(
						(value) =>
							value.type === "message" &&
							value.message.role === "user" &&
							value.message.content === request,
					),
				"the open request stays a user message after the handoff",
			);
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate compacts older work at rewind_at_tokens and keeps the newest turns verbatim", async () => {
		const f = await autoFixture(
			async () => {
				throw new Error("a classifier must not decide pressure relief");
			},
			{ pressure: "compact", rewind_at_tokens: 60_000, keep_recent_share: 0.1 },
		);
		try {
			for (let i = 1; i <= 4; i++) appendTurn(f.sm, `task ${i}`, `# Done ${i}`, i * 10_000, true);
			const last = appendTurn(f.sm, "task 5", "# Done 5", 70_000, true);
			const entry = f.sm.getEntry(last.assistantId);
			assert.ok(entry?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);

			const receipt = boundary.entries.find(
				(value) => value.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
			);
			assert.ok(receipt, JSON.stringify(boundary));
			assert.equal(f.questions.length, 0);
			assert.ok(f.summaries.calls.length > 0);
			const compaction = f.sm.getBranch().findLast((value) => value.type === "compaction");
			assert.ok(compaction?.type === "compaction");
			assert.equal(compaction.firstKeptEntryId, last.userId);
			assert.equal(f.sm.getLabel(compaction.id), "anchor:compacted");
			assert.ok(
				!f.sm.getBranch().some((value) => value.type === "branch_summary"),
				"a compaction, not a fold",
			);
			const projected = f.sm.buildSessionProjection().entries;
			assert.equal(projected[0].sourceEntry.id, compaction.id);
			assert.ok(
				projected.some((value) => value.sourceEntry.id === last.userId),
				"the newest turn stays verbatim",
			);
			assertNoAutoSteer(f, boundary);

			// The compaction anchor is a fold target that keeps the compacted summary.
			for (let i = 6; i <= 8; i++) appendTurn(f.sm, `task ${i}`, `# Done ${i}`, 20_000, true);
			const api = __testHooks.foldApi(f.pi.pi);
			assert.ok(api);
			const fold = (rewindTo: string, newLabel: string) =>
				api.runFoldNow({ ...f.ctx, isIdle: () => true } as never, {
					origin: "manual",
					rewindTo,
					newLabel,
					focus: "Preserve user instructions and continue the work.",
				});
			const folded = await fold("compacted", "after-compaction");
			assert.equal(folded.status, "done", JSON.stringify(folded));
			const summary = f.sm.getBranch().findLast((value) => value.type === "branch_summary");
			assert.equal(summary?.parentId, compaction.id);
			assert.equal(
				f.sm.buildSessionProjection().entries[0].sourceEntry.id,
				compaction.id,
				"the fold keeps the compaction summary in context",
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate quotes an open request a pressure compaction summarizes", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			pressure: "compact",
			rewind_at_tokens: 60_000,
			keep_recent_share: 0.1,
		});
		try {
			appendTurn(f.sm, "earlier", "# Earlier", 5_000, true);
			const request = "Migrate every crate to edition 2024 and keep going.";
			const requestId = f.sm.appendMessage({
				role: "user",
				content: request,
				timestamp: 1,
			});
			for (let i = 1; i <= 4; i++) toolTurn(f, `r${i}`, 9_000, i * 10_000);
			const leaf = f.sm.getEntry(toolTurn(f, "r5", 2_000, 70_000));
			assert.ok(leaf?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, leaf.message);
			const compaction = f.sm.getBranch().findLast((value) => value.type === "compaction");
			assert.ok(compaction?.type === "compaction", JSON.stringify(boundary));
			assert.ok(
				compaction.summary.includes(
					`<archived-user-request>\n${request}\n</archived-user-request>`,
				),
			);
			assert.deepEqual(
				(
					compaction.details as {
						navigateTree: { pressure: { openUserRequests: unknown } };
					}
				).navigateTree.pressure.openUserRequests,
				[{ sourceEntryId: requestId, text: request }],
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate compacts even when the kept work alone exceeds half of rewind_at_tokens, and says so", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			pressure: "compact",
			rewind_at_tokens: 40_000,
			keep_recent_share: 0.1,
		});
		try {
			appendTurn(f.sm, "earlier", "# Earlier", 5_000, true);
			f.sm.appendMessage({ role: "user", content: "read it", timestamp: 1 });
			const leaf = f.sm.getEntry(toolTurn(f, "big", 30_000, 50_000));
			assert.ok(leaf?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, leaf.message);
			assertAboveTargetCompaction(f, boundary, 20_000);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate prices a pressure compaction as the request guard does, not as usage minus a content heuristic", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			pressure: "compact",
			rewind_at_tokens: 40_000,
			keep_recent_share: 0.1,
		});
		try {
			// Recorded usage understates the large earlier evidence, so the
			// heuristic prefix exceeds the usage-based active estimate.
			f.sm.appendMessage({
				role: "user",
				content: "read the logs",
				timestamp: 1,
			});
			for (let i = 1; i <= 4; i++) toolTurn(f, `old${i}`, 20_000);
			f.sm.appendMessage({
				role: "user",
				content: "now this one",
				timestamp: 2,
			});
			const leaf = f.sm.getEntry(toolTurn(f, "new", 22_000, 41_000));
			assert.ok(leaf?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, leaf.message);
			const after = assertAboveTargetCompaction(f, boundary, 20_000);
			const committed = estimateAdmissionTokens(f.sm);
			assert.ok(
				after >= committed && after - committed < 200,
				`the receipt prices the committed request (${committed}), not usage minus a heuristic (${after})`,
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate shrinks the kept tail when the configured share cannot land under the budget", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			pressure: "compact",
			rewind_at_tokens: 60_000,
			keep_recent_share: 0.45,
		});
		try {
			appendTurn(f.sm, "earlier", "# Earlier", 5_000, true);
			f.sm.appendMessage({ role: "user", content: "read them", timestamp: 1 });
			let leafId = "";
			for (let i = 1; i <= 6; i++)
				leafId = toolTurn(f, `t${i}`, 6_000, i === 6 ? 70_000 : i * 10_000);
			const leaf = f.sm.getEntry(leafId);
			assert.ok(leaf?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, leaf.message);
			const compaction = f.sm.getBranch().findLast((value) => value.type === "compaction");
			assert.ok(compaction?.type === "compaction", JSON.stringify(boundary));
			const kept = (
				compaction.details as {
					navigateTree: { pressure: { keptTokens: number } };
				}
			).navigateTree.pressure.keptTokens;
			assert.ok(kept < 27_000, `kept ${kept} shrank below the configured 27k`);
			assert.ok(kept >= 6_000, `kept ${kept} still holds the newest tool turn`);
			const receipt = boundary.entries.find(
				(value) => value.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
			);
			assert.ok(receipt);
			assert.ok((receipt.details as { after: number }).after <= 30_000);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate keeps the configured tail in calibrated tokens when the tokenizer counts higher", async () => {
		const fixture = makeConfigFixture();
		writeGlobalConfig(
			fixture,
			JSON.stringify({
				auto_navigate: {
					enabled: true,
					milestone: {
						classifier: { model: "test/milestone" },
						confirmer: { model: null },
					},
					check_every_turns: 3,
					min_tokens_since_anchor: 1_000_000,
					pressure: "compact",
					rewind_at_tokens: 60_000,
					keep_recent_share: 0.14,
				},
			}),
		);
		try {
			const f = setup({ contextWindow: 100_000 });
			f.ctx.cwd = fixture.projectDir;
			await runSessionStart(f.pi, f.ctx, fixture);
			Object.assign(f.ctx, {
				modelRegistry: {
					...fakeRegistry().registry,
					getAvailableOfType: async () => [],
					classify: async () => {
						throw new Error("a classifier must not decide pressure relief");
					},
				},
			});
			f.sm.appendMessage({ role: "user", content: "read them", timestamp: 1 });
			for (let i = 1; i <= 12; i++) {
				appendToolCallAssistant(f.sm, [{ id: `d${i}`, name: "read", arguments: {} }], 0);
				appendToolResult(f.sm, `d${i}`, "read", "e".repeat(16_000));
			}
			const request = [
				{ role: "system", content: "rules", timestamp: 0 },
				...f.sm.buildSessionContext().messages,
			];
			for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
				await handler({ type: "context_with_system", messages: request } as never, f.ctx as never);
			// The tokenizer reports 1.3x the heuristic: each 4k tool turn costs ~5.2k.
			const model = f.ctx.model as { provider: string; id: string };
			const reply = {
				...assistantMessage([{ type: "text", text: "ok" }], "stop"),
				provider: model.provider,
				model: model.id,
				usage: usageOf(Math.round(estimateRawRequestTokens(request as never) * 1.3)),
			};
			f.sm.appendMessage(reply as never);
			const boundary = await fireTurnEndAll(f.pi, f.ctx, reply);
			assert.ok(
				f.sm.getBranch().some((value) => value.type === "compaction"),
				JSON.stringify(boundary),
			);
			// 14% of 60k is 8.4k calibrated tokens: two tool turns, not three.
			const keptResults = f.sm
				.buildSessionProjection()
				.entries.filter(
					(value) =>
						value.sourceEntry.type === "message" && value.sourceEntry.message.role === "toolResult",
				).length;
			assert.equal(keptResults, 2);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("auto_navigate prices the system prompt a pressure compaction keeps", async () => {
		const run = async (systemChars: number) => {
			const f = await autoFixture(async () => ({ status: "continue" }), {
				pressure: "compact",
				rewind_at_tokens: 60_000,
				keep_recent_share: 0.1,
			});
			f.sm.appendMessage({
				role: "system",
				content: "s".repeat(systemChars),
				timestamp: 0,
			} as never);
			for (let i = 1; i <= 4; i++) appendTurn(f.sm, `task ${i}`, `# Done ${i}`, i * 10_000, true);
			const last = appendTurn(f.sm, "task 5", "# Done 5", 70_000, true);
			const entry = f.sm.getEntry(last.assistantId);
			assert.ok(entry?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);
			return { f, boundary };
		};

		const small = await run(8_000);
		let smallPriced = 0;
		try {
			const receipt = small.boundary.entries.find(
				(value) => value.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
			);
			assert.ok(receipt, JSON.stringify(small.boundary));
			const priced = (receipt.details as { after: number }).after;
			smallPriced = priced;
			const committed = estimateAdmissionTokens(small.f.sm);
			assert.ok(
				priced >= committed && priced - committed < 200,
				`the priced request (${priced}) is the committed one (${committed}) plus the receipt`,
			);
		} finally {
			cleanupConfigFixture(small.f.fixture);
		}

		const large = await run(60_000);
		try {
			const receipt = large.boundary.entries.find(
				(value) => value.customType === PRESSURE_COMPACTION_CUSTOM_TYPE,
			);
			assert.ok(receipt, JSON.stringify(large.boundary));
			const after = (receipt.details as { after: number }).after;
			assert.ok(
				after - smallPriced >= 12_000,
				`the larger kept system prompt is priced into the result (${smallPriced} -> ${after})`,
			);
		} finally {
			cleanupConfigFixture(large.f.fixture);
		}
	});

	it("auto_navigate keeps steering scoped to a retained compaction anchor across the next compaction", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			pressure: "compact",
			rewind_at_tokens: 60_000,
			keep_recent_share: 0.1,
			min_tokens_since_anchor: 1_000,
		});
		try {
			for (let i = 1; i <= 4; i++) appendTurn(f.sm, `task ${i}`, `# Done ${i}`, i * 10_000, true);
			const first = appendTurn(f.sm, "task 5", "# Done 5", 70_000, true);
			const firstEntry = f.sm.getEntry(first.assistantId);
			assert.ok(firstEntry?.type === "message");
			await fireTurnEndAll(f.pi, f.ctx, firstEntry.message);
			assert.ok(f.sm.getEntries().some((value) => value.type === "compaction"));

			const steer = appendTurn(f.sm, "look at the parser first", "ok", 75_000, true);
			appendOpsEntry(f.pi.pi, [
				{
					op: {
						op: "add",
						kind: "steering",
						text: "Look at the parser first",
						scopeAnchor: "compacted",
					},
					ctx: { origin: "user", entryId: steer.userId },
				},
			]);
			for (let i = 6; i <= 8; i++)
				appendTurn(f.sm, `task ${i}`, `# Done ${i}`, 80_000 + i * 1_000, true);
			const second = appendTurn(f.sm, "task 9", "# Done 9", 120_000, true);
			const secondEntry = f.sm.getEntry(second.assistantId);
			assert.ok(secondEntry?.type === "message");
			const boundary = await fireTurnEndAll(f.pi, f.ctx, secondEntry.message);
			const compactions = f.sm.getBranch().filter((value) => value.type === "compaction");
			assert.equal(compactions.length, 2, JSON.stringify(boundary));
			const latest = compactions.at(-1);
			assert.ok(latest?.type === "compaction");
			assert.ok(
				latest.summary.includes("Look at the parser first"),
				"steering whose anchor is retained stays in the briefing",
			);
			assert.equal(f.sm.getLabel(compactions[0].id), "anchor:compacted");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate never partially folds an unsafe pending tool envelope", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }));
		try {
			const pending = appendToolCallAssistant(
				f.sm,
				[{ id: "pending", name: "read", arguments: { path: "unfinished" } }],
				90_000,
			);
			const boundary = await fireTurnEndAll(f.pi, f.ctx, pending.message);
			assert.equal(f.summaries.calls.length, 0);
			assert.ok(!f.sm.getEntries().some((entry) => entry.type === "branch_summary"));
			assert.ok(f.sm.getBranch().some((entry) => entry.id === pending.id));
			const [warning] = boundary.entries.filter(
				(entry) => entry.customType === "navigate-tree-auto-warning",
			);
			assert.match(String(warning?.content), /no fold ran: .*tool call without its result/);
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate rejects pre-compaction targets and folds to a feasible fresh anchor", async () => {
		const f = await autoFixture(async () => ({ status: "continue" }), {
			min_tokens_since_anchor: 10_000,
		});
		try {
			const old = appendTurn(f.sm, "old", "old answer", 90_000);
			f.sm.appendCompaction("Compacted summary", old.userId, 90_000);
			const refused = await autoTurn(f, 92_000);
			assert.equal(f.summaries.calls.length, 0);
			assert.ok(
				refused.entries.some((entry) => entry.customType === "navigate-tree-auto-warning"),
				JSON.stringify(refused),
			);
			assert.ok(!f.sm.getEntries().some((entry) => entry.type === "branch_summary"));
			assertNoAutoSteer(f, refused);
			const fresh = appendTurn(f.sm, "new work", "ready", 20_000);
			f.pi.pi.setLabel(fresh.assistantId, "anchor:fresh");
			const workTurn = async (tokens: number) => {
				const turn = appendTurn(f.sm, "new work", "working", tokens, true);
				const entry = f.sm.getEntry(turn.assistantId);
				assert.ok(entry?.type === "message");
				return fireTurnEndAll(f.pi, f.ctx, entry.message);
			};
			await workTurn(40_000);
			const boundary = await workTurn(93_000);
			const [done] = forcedDrafts(boundary);
			assert.equal(done?.details.status, "done", JSON.stringify(boundary));
			assert.equal(done.details.rewindTo, "fresh");
			assert.ok(f.summaries.calls.length > 0);
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate discards stale input and does not consume its cadence", async () => {
		let release: () => void = () => {};
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const reply = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = await autoFixture(
			async (context) => {
				started();
				await reply;
				return { status: "milestone", boundary: newestBoundary(context) };
			},
			{ check_every_turns: 1 },
		);
		try {
			const pending = autoTurn(f, 50_000);
			await ready;
			const oldLeaf = f.sm.getLeafId();
			f.sm.appendMessage({
				role: "user",
				content: "Stop; requirements changed.",
				timestamp: 1,
			});
			release();
			await pending;
			assert.equal(f.sm.getLabel(oldLeaf as string), undefined);
			assert.equal(f.summaries.calls.length, 0);
			await autoTurn(f, 51_000);
			assert.equal(f.questions.length, 2, "the stale crossing was never installed");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate resolves wildcard policy overrides and applies disclosure before classification", async () => {
		const f = await autoFixture(
			async (context) => ({
				status: "milestone",
				boundary: newestBoundary(context),
			}),
			{
				enabled: false,
				milestone: { classifier: { model: "test/base" } },
				tools: { read: "omit" },
			},
			{
				model_overrides: {
					"*sonnet*": {
						auto_navigate: {
							enabled: true,
							milestone: {
								classifier: { model: "test/milestone" },
								confirmer: { model: null },
							},
							check_every_turns: 1,
							mode: "anchor-only",
						},
					},
				},
			},
		);
		try {
			const boundary = await autoTurn(f, 90_000, "# Verified milestone");
			assert.ok(f.questions.length > 0);
			assert.deepEqual(f.classifierModels, ["milestone"]);
			const text = JSON.stringify(f.questions[0]);
			assert.ok(!text.includes(BIG), "omitted read results never reach the policy");
			assert.match(text, /omit|withheld/);
			assert.equal(f.summaries.calls.length, 0);
			assert.ok(
				f.sm.getBranch().some((entry) => f.sm.getLabel(entry.id) === "anchor:verified-milestone"),
			);
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate refuses changed model, window, signal, labels, config and competing folds", async () => {
		for (const change of ["model", "window", "signal", "label", "config", "queued"] as const) {
			let mutate: () => Promise<void> = async () => {};
			const f = await autoFixture(
				async (context) => {
					const boundary = newestBoundary(context);
					await mutate();
					return { status: "milestone", boundary };
				},
				{ check_every_turns: 1 },
			);
			try {
				mutate = async () => {
					if (change === "model" && f.ctx.model) f.ctx.model.id = "changed";
					if (change === "window" && f.ctx.model) f.ctx.model.contextWindow = 200_000;
					if (change === "signal") f.ctx.signal = new AbortController().signal;
					if (change === "label") f.pi.pi.setLabel(f.sm.getLeafId() as string, "user bookmark");
					if (change === "config") {
						writeGlobalConfig(f.fixture, JSON.stringify({ auto_navigate: false }));
						await runSessionStart(f.pi, f.ctx, f.fixture);
					}
					if (change === "queued") {
						const api = __testHooks.foldApi(f.pi.pi);
						assert.ok(api);
						assert.ok(
							api.queueFold(f.sm.getSessionId(), {
								origin: "manual",
								rewindTo: "start",
								newLabel: "manual-fold",
								focus: "Preserve completed work and continue the remaining requested task.",
							}).ok,
						);
					}
				};
				const boundary = await autoTurn(f, 50_000);
				assert.equal(f.questions.length, 1, change);
				assert.equal(f.summaries.calls.length, 0, change);
				assert.ok(
					!f.sm
						.getBranch()
						.some((entry) => /^anchor:(?!start$)/.test(f.sm.getLabel(entry.id) ?? "")),
					`${change}: a stale decision must not place an anchor`,
				);
				assert.ok(!f.sm.getEntries().some((entry) => entry.type === "branch_summary"), change);
				assert.equal(forcedDrafts(boundary).length, 0, change);
				assertNoAutoSteer(f, boundary);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("auto_navigate preserves an unanswered suffix and anchors only the accepted milestone", async () => {
		let target = "";
		const f = await autoFixture(
			async () => ({
				status: "milestone",
				boundary: target,
			}),
			{ check_every_turns: 1 },
		);
		try {
			target = appendTurn(f.sm, "completed task", "# Done", 50_000).assistantId;
			const entry = f.sm.getEntry(target);
			assert.ok(entry?.type === "message");
			const userId = f.sm.appendMessage({
				role: "user",
				content: "A new unanswered request.",
				timestamp: 1,
			});
			const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);
			assert.equal(f.summaries.calls.length, 0);
			assert.equal(f.sm.getLabel(target), "anchor:done");
			assert.ok(f.sm.getBranch().some((value) => value.id === userId));
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate reports summary and commit failures without continuing", async () => {
		for (const stage of ["summary", "commit"] as const) {
			const f = await autoFixture(async (context) => ({
				status: "milestone",
				boundary: newestBoundary(context),
			}));
			const internals = f.sm as unknown as {
				_persist(entry: SessionEntry): void;
			};
			const persist = internals._persist.bind(f.sm);
			try {
				if (stage === "summary") {
					const failed = fakeRegistry(() => ({
						...reply(""),
						stopReason: "error",
						errorMessage: "injected provider failure",
					}));
					Object.assign(f.ctx.modelRegistry, {
						streamSimple: failed.registry.streamSimple,
					});
				} else {
					internals._persist = (entry) => {
						if (entry.type === "branch_summary") throw new Error("injected write failure");
						persist(entry);
					};
				}
				const boundary = await autoTurn(f, 90_000);
				const [failed] = forcedDrafts(boundary);
				assert.equal(failed?.details.status, "failed", JSON.stringify(boundary));
				assert.equal(failed.details.stage, stage);
				assert.equal(failed.details.origin, "auto");
				assert.equal(boundary.continue, false);
				assert.ok(!f.sm.getBranch().some((entry) => entry.type === "branch_summary"));
				assertNoAutoSteer(f, boundary);
			} finally {
				internals._persist = persist;
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("auto_navigate refuses stale context getters before evaluating", async () => {
		const f = await autoFixture(async () => ({ status: "milestone" }));
		try {
			Object.defineProperty(f.ctx, "hasUI", {
				get() {
					throw new Error("stale context");
				},
			});
			await autoTurn(f, 90_000);
			assert.equal(f.questions.length, 0);
			assert.equal(f.summaries.calls.length, 0);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate stops without a receipt append when a failed commit quarantines the cursor", async () => {
		const f = await autoFixture(async (context) => ({
			status: "milestone",
			boundary: newestBoundary(context),
		}));
		const internals = f.sm as unknown as {
			_persist(entry: SessionEntry): void;
		};
		const persist = internals._persist.bind(f.sm);
		const branch = f.sm.branch.bind(f.sm);
		let failed = false;
		try {
			internals._persist = (entry) => {
				if (entry.type === "branch_summary") {
					failed = true;
					throw new Error("injected write failure");
				}
				persist(entry);
			};
			f.sm.branch = (id) => {
				if (failed) throw new Error("injected cursor restoration failure");
				return branch(id);
			};
			const boundary = await autoTurn(f, 90_000);
			assert.equal(failed, true);
			assert.equal(boundary.continue, false);
			assert.deepEqual(boundary.entries, []);
			assert.ok(f.ctx.notifyCalls.some(([text]) => text.includes("failed at the commit stage")));
			const checks = f.questions.length;
			await fireTurnEndAll(
				f.pi,
				f.ctx,
				assistantMessage([{ type: "text", text: "unchanged" }], "stop", 90_000),
			);
			assert.equal(f.questions.length, checks);
			assertNoAutoSteer(f, boundary);
		} finally {
			internals._persist = persist;
			f.sm.branch = branch;
			cleanupConfigFixture(f.fixture);
		}
	});

	it("auto_navigate persists bounded operational warnings without claiming completion", async () => {
		const f = await autoFixture(
			async () => {
				throw new Error("offline failure");
			},
			{ check_every_turns: 1 },
		);
		try {
			const boundary = await autoTurn(f, 50_000);
			const warnings = boundary.entries.filter(
				(entry) => entry.customType === "navigate-tree-auto-warning",
			);
			assert.equal(warnings.length, 1);
			assert.match(String(warnings[0].content), /offline failure/);
			assert.ok(
				f.ctx.notifyCalls.some(
					([text, level]) => level === "warning" && text.includes("offline failure"),
				),
			);
			assert.ok(
				f.sm
					.getBranch()
					.some(
						(entry) =>
							entry.type === "custom_message" && entry.customType === "navigate-tree-auto-warning",
					),
			);
			assert.ok(String(warnings[0].content).length <= 1502);
			assert.equal(boundary.continue, false);
			assert.equal(forcedDrafts(boundary).length, 0);
			assert.equal(f.summaries.calls.length, 0);
			assertNoAutoSteer(f, boundary);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});
});
