/** Extension fold adapters tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { buildSessionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateRequestTokens } from "../../src/core/context-tokens.ts";
import { LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE } from "../../src/core/legacy-rewind.ts";
import { ANCHOR_MANDATE, estimateAdmissionTokens } from "../../src/core/request-accounting.ts";
import { commitFold } from "../../src/fold/fold-commit.ts";
import { previewFoldCommit } from "../../src/fold/fold-preview.ts";
import {
	foldPlaceholderSummary,
	foldRecommendationBudget,
	foldSummaryPlaceholderTokens,
	priceFoldCandidates,
	recommendFoldIndex,
} from "../../src/fold/fold-pricing.ts";
import {
	buildLateEntriesNote,
	buildRewindDoneText,
	REWIND_CUSTOM_TYPE,
} from "../../src/fold/fold-receipts.ts";
import { DEFAULT_REDUCE_OUTPUT_TOKENS } from "../../src/fold/fold-summarizer.ts";
import { __testHooks } from "../../src/index.ts";
import { fireContext, fireTurnEndAll } from "../support/boundary-drivers.ts";
import {
	cleanupConfigFixture,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "../support/config-fixtures.ts";
import { type FakeCtx, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, type RegistryCall, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import { appendTurn, assistantMessage } from "../support/session-messages.ts";

installHarnessHooks();

describe("independent folds through the engine host", () => {
	const WINDOW = 100_000;
	/** The guard refuses a request unless it leaves the minimum output plus the headroom. */
	const GUARD_RESERVE = 1_024 + 4_096;
	const SYSTEM_MESSAGE = {
		role: "system",
		content: "You are the pi agent.",
		timestamp: 0,
	};
	const FOLD = {
		origin: "manual",
		rewindTo: "start",
		newLabel: "folded",
		focus: "Continue the parser fix; the user's last instruction was to keep the tests green.",
	} as const;

	/**
	 * An anchored session of five heavy turns. `leafTokens` is the usage the
	 * newest assistant reports: 99k leaves the next main request over the guard.
	 */
	async function foldSetup(leafTokens: number) {
		const fixture = makeConfigFixture();
		writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 20_000 }));
		const f = setup({ contextWindow: WINDOW });
		(f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
		f.ctx.cwd = fixture.projectDir;
		await runSessionStart(f.pi, f.ctx, fixture);
		const first = appendTurn(f.sm, "u1", "a1", 5_000);
		f.pi.pi.setLabel(first.assistantId, "anchor:start");
		let leafId = first.assistantId;
		for (const [i, tokens] of [12_000, 24_000, 36_000, 48_000, leafTokens].entries()) {
			leafId = appendTurn(f.sm, `u${i + 2}`, `a${i + 2}`, tokens, true).assistantId;
		}
		// pi persists a message sent while idle, without starting a turn.
		const hooks = f.pi.pi as unknown as Record<string, unknown>;
		hooks.sendMessage = (...args: unknown[]) => {
			f.pi.sendMessageCalls.push(args);
			const [m] = args as [
				{
					customType: string;
					content: string;
					display: boolean;
					details: unknown;
				},
			];
			f.sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
		};
		hooks.getThinkingLevel = () => "medium";
		const api = __testHooks.foldApi(f.pi.pi);
		assert.ok(api, "the factory exposes its fold entry points");
		return { ...f, fixture, api, anchorId: first.assistantId, leafId };
	}
	type FoldFixture = Awaited<ReturnType<typeof foldSetup>>;

	const foldCtx = (f: { ctx: FakeCtx }, registry: object, extra: object = {}) =>
		({
			...f.ctx,
			modelRegistry: registry,
			isIdle: () => true,
			...extra,
		}) as FakeCtx & {
			modelRegistry: object;
			isIdle(): boolean;
		};

	const snapshotOf = (sm: SessionManager) => ({
		entries: sm.getEntries().map((entry) => entry.id),
		leaf: sm.getLeafId(),
	});

	/** Fire the admission guard as the next main request would; true when it aborts the request. */
	async function guardAborts(f: FoldFixture, ctx: FakeCtx): Promise<boolean> {
		const aborter = new AbortController();
		const messages = [SYSTEM_MESSAGE, ...fireContext(f.pi, ctx)];
		for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
			await handler(
				{ type: "context_with_system", messages } as never,
				{
					...ctx,
					signal: aborter.signal,
					abort: () => aborter.abort(),
				} as never,
			);
		}
		return aborter.signal.aborted;
	}

	/** The summary landed as a new branch from the anchor, and the old leaf is marked. */
	function assertFolded(f: FoldFixture) {
		const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
		assert.ok(summary, "a branch_summary is on the active branch");
		assert.equal(summary.parentId, f.anchorId);
		assert.equal(f.sm.getLabel(f.leafId), "branch:folded");
		assert.equal(f.sm.getLabel(summary.id), "anchor:folded");
		assert.ok(!f.sm.getBranch().some((e) => e.id === f.leafId));
		assert.ok(
			estimateAdmissionTokens(f.sm) + GUARD_RESERVE <= WINDOW,
			"the next main request is admitted",
		);
		return summary;
	}

	/** No in-band machinery ran: no instruction message, no user message, no turn started. */
	function assertNoSummaryTurn(f: FoldFixture, registryCalls: RegistryCall[]) {
		assert.ok(
			f.sm
				.getEntries()
				.every(
					(e) =>
						!(e.type === "custom_message" && e.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE),
				),
		);
		assert.equal(f.pi.sendUserMessageCalls.length, 0);
		for (const args of f.pi.sendMessageCalls) {
			assert.deepEqual(args[1], { triggerTurn: false });
		}
		assert.ok(registryCalls.length > 0);
		for (const call of registryCalls) {
			assert.equal(call.options.toolChoice, "none");
			assert.equal(call.options.sessionId, f.sm.getSessionId());
		}
	}

	const leafMessage = (f: FoldFixture) => {
		const entry = f.sm.getEntry(f.leafId);
		assert.equal(entry?.type, "message");
		return (entry as { message: unknown }).message;
	};

	const receiptsOf = (sm: SessionManager) =>
		sm
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === REWIND_CUSTOM_TYPE ? [entry] : [],
			);

	it("folds an idle session whose next main request the guard refuses, with side calls only", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry);
			assert.ok(
				estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW,
				"the next request exceeds the admission guard",
			);
			const before = snapshotOf(f.sm);

			const outcome = await f.api.runFoldNow(ctx as never, FOLD);

			assert.equal(outcome.status, "done", JSON.stringify(outcome));
			if (outcome.status !== "done") return;
			assert.equal(outcome.strategy, "chunked", "the live request cannot be admitted");
			assertFolded(f);
			assertNoSummaryTurn(f, registry.calls);
			assert.equal(
				registry.calls[0].options.reasoning,
				"low",
				"fold summaries cap the session's medium thinking at low",
			);
			const receipt = receiptsOf(f.sm).at(-1);
			assert.equal(f.sm.getLeafId(), receipt?.id, "the continuation ends the new branch");
			assert.ok(receipt);
			assert.equal((receipt.details as { status?: string }).status, "done");
			assert.deepEqual(
				before.entries,
				snapshotOf(f.sm).entries.slice(0, before.entries.length),
				"the abandoned branch is kept on disk",
			);
			assert.equal(await guardAborts(f, ctx), false, "the next request fits");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("folds at the next turn_end boundary of a running session and continues the run", async () => {
		const f = await foldSetup(99_000);
		try {
			assert.ok(estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW);
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry);
			assert.deepEqual(f.api.queueFold(f.sm.getSessionId(), FOLD), {
				ok: true,
			});
			assert.equal(registry.calls.length, 0, "nothing runs before the boundary");

			const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));

			assert.equal(result.continue, true);
			assertFolded(f);
			assertNoSummaryTurn(f, registry.calls);
			assert.equal(f.pi.sendMessageCalls.length, 0, "the receipt is a boundary entry");
			const [done] = result.entries.filter((d) => d.customType === REWIND_CUSTOM_TYPE);
			assert.equal(done.details.status, "done");
			assert.equal(f.sm.getLeafId(), receiptsOf(f.sm).at(-1)?.id);
			assert.equal(await guardAborts(f, ctx), false, "the next request fits");

			const again = await fireTurnEndAll(f.pi, ctx, assistantMessage([], "stop", 0));
			assert.deepEqual(again.entries, [], "the fold ran once");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("preserves the open user request outside an omitting summary at the queued boundary", async () => {
		const f = await foldSetup(40_000);
		try {
			const text = "Rewind now, then reply ACCEPTANCE-CONTINUED-unique-73.\n  Keep these bytes.\n";
			const sourceEntryId = f.sm.appendMessage({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: 100,
			});
			f.sm.appendCustomMessageEntry("new-notification", "audit finished", true);
			const registry = fakeRegistry(() => reply(SUMMARY_TEXT));
			assert.ok(!SUMMARY_TEXT.includes("ACCEPTANCE-CONTINUED-unique-73"));
			const ctx = foldCtx(f, registry.registry);
			assert.deepEqual(f.api.queueFold(f.sm.getSessionId(), { ...FOLD, origin: "agent" }), {
				ok: true,
			});
			const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
			assert.equal(result.continue, true);
			const done = result.entries.find((d) => d.customType === REWIND_CUSTOM_TYPE);
			assert.ok(done);
			assert.ok(String(done.content).includes(text), JSON.stringify(done));
			assert.ok(String(done.content).includes(sourceEntryId));
			assert.match(String(done.content), /rewind is completed; do not repeat it/i);
			assert.match(String(done.content), /fulfill the remaining request/i);
			assert.deepEqual(done.details.openUserRequests, [{ sourceEntryId, text }]);
			const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
			assert.ok(summary?.type === "branch_summary");
			assert.ok(!summary.summary.includes(text));
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("replays the captured system head in context (Strategy A) when the request is admitted", async () => {
		const f = await foldSetup(40_000);
		try {
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry);
			assert.equal(await guardAborts(f, ctx), false);
			const liveMessages = __testHooks.buildContextMessages(f.sm).length;

			const outcome = await f.api.runFoldNow(ctx as never, FOLD);

			assert.equal(outcome.status, "done", JSON.stringify(outcome));
			if (outcome.status !== "done") return;
			assert.equal(outcome.strategy, "in-context");
			assert.equal(registry.calls.length, 1);
			const { messages } = registry.calls[0].context;
			assert.equal(messages[0], SYSTEM_MESSAGE);
			const last = messages.at(-1);
			assert.equal(last?.role, "user");
			assert.match(
				JSON.stringify(last),
				/^\{"role":"user","content":\[\{"type":"text","text":"\[navigate_tree\]/,
			);
			assert.equal(messages.length, 1 + liveMessages + 1);
			assert.match(
				JSON.stringify(last),
				/messages 3 onwards/,
				"the system head is not numbered; the anchor ends message 2",
			);
			assertFolded(f);
			assertNoSummaryTurn(f, registry.calls);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("chunks the evidence (Strategy B) without a captured system head, and after a session start", async () => {
		for (const captured of [false, true]) {
			const f = await foldSetup(40_000);
			try {
				const registry = fakeRegistry();
				const ctx = foldCtx(f, registry.registry);
				if (captured) {
					await guardAborts(f, ctx);
					await runSessionStart(f.pi, f.ctx, f.fixture, "resume");
				}
				const outcome = await f.api.runFoldNow(ctx as never, FOLD);
				assert.equal(outcome.status, "done", JSON.stringify(outcome));
				if (outcome.status !== "done") return;
				assert.equal(outcome.strategy, "chunked");
				assert.ok(outcome.calls >= 2, "a map call and the reduce");
				assertFolded(f);
				assertNoSummaryTurn(f, registry.calls);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("leaves the history exactly as found when the provider fails, on both paths", async () => {
		const failing = () => fakeRegistry(() => reply("", "error", "overloaded"));
		{
			const f = await foldSetup(99_000);
			try {
				const registry = failing();
				const before = snapshotOf(f.sm);
				const outcome = await f.api.runFoldNow(foldCtx(f, registry.registry) as never, FOLD);
				assert.equal(outcome.status, "failed");
				if (outcome.status !== "failed") return;
				assert.equal(outcome.stage, "summary");
				assert.equal(outcome.reason, "provider-error");
				assert.deepEqual(snapshotOf(f.sm), before);
				assert.equal(f.pi.sendMessageCalls.length, 0);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		const f = await foldSetup(99_000);
		try {
			const registry = failing();
			const ctx = foldCtx(f, registry.registry);
			const before = snapshotOf(f.sm);
			f.api.queueFold(f.sm.getSessionId(), { ...FOLD, origin: "agent" });
			const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
			assert.equal(result.continue, true, "the model that asked hears about it");
			const [receipt] = result.entries;
			assert.equal(receipt.details.status, "failed");
			assert.equal(receipt.details.stage, "summary");
			assert.equal(receipt.details.reason, "provider-error");
			assert.match(receipt.content, /Nothing was collapsed/);
			const after = snapshotOf(f.sm);
			assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
			assert.equal(after.entries.length, before.entries.length + 1, "only the receipt was added");
			assert.equal(
				f.sm.getBranch().some((e) => e.type === "branch_summary"),
				false,
			);
			assert.equal(f.sm.getLabel(f.leafId), undefined);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("cancels before the commit and leaves the history as found", async () => {
		{
			const f = await foldSetup(99_000);
			try {
				const controller = new AbortController();
				const registry = fakeRegistry(() => {
					controller.abort();
					return reply("", "aborted");
				});
				const before = snapshotOf(f.sm);
				const outcome = await f.api.runFoldNow(foldCtx(f, registry.registry) as never, FOLD, {
					signal: controller.signal,
				});
				assert.equal(outcome.status, "cancelled");
				assert.deepEqual(snapshotOf(f.sm), before);
				assert.equal(f.pi.sendMessageCalls.length, 0);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		// Esc during the run: the queued fold is cancelled at the boundary, with no side call.
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry();
			const controller = new AbortController();
			controller.abort();
			const ctx = foldCtx(f, registry.registry, { signal: controller.signal });
			const before = snapshotOf(f.sm);
			f.api.queueFold(f.sm.getSessionId(), FOLD);
			const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
			assert.equal(registry.calls.length, 0);
			const [receipt] = result.entries;
			assert.equal(receipt.details.status, "failed");
			assert.equal(receipt.details.reason, "cancelled");
			assert.deepEqual(snapshotOf(f.sm).entries.slice(0, before.entries.length), before.entries);
			assert.equal(
				f.sm.getBranch().some((e) => e.type === "branch_summary"),
				false,
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("re-appends input that arrives during the summary instead of folding it away", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry((_call, index) => {
				if (index === 0) {
					f.sm.appendMessage({
						role: "user",
						content: [{ type: "text", text: "late steer" }],
						timestamp: Date.now(),
					} as never);
				}
				return reply(SUMMARY_TEXT);
			});
			const outcome = await f.api.runFoldNow(foldCtx(f, registry.registry) as never, FOLD);
			assert.equal(outcome.status, "done", JSON.stringify(outcome));
			if (outcome.status !== "done") return;
			assert.equal(outcome.commit.reappended, 1);
			const tail = f.sm.getBranch().slice(-4);
			assert.deepEqual(
				tail.map((e) => e.type),
				["branch_summary", "label", "message", "custom_message"],
			);
			assert.match(JSON.stringify(tail[2]), /late steer/);
			assert.ok(
				JSON.stringify(tail[3]).includes(JSON.stringify(buildLateEntriesNote(1)).slice(1, -1)),
				"the continuation names the late message as unanswered",
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("refuses a missing or pre-compaction anchor before any side call", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry);
			const before = snapshotOf(f.sm);
			const outcome = await f.api.runFoldNow(ctx as never, {
				...FOLD,
				rewindTo: "nowhere",
			});
			assert.equal(outcome.status, "failed");
			if (outcome.status !== "failed") return;
			assert.equal(outcome.stage, "gate");
			assert.match(outcome.detail, /no label 'nowhere' on the active branch/);
			assert.equal(registry.calls.length, 0);
			assert.deepEqual(snapshotOf(f.sm), before);
		} finally {
			cleanupConfigFixture(f.fixture);
		}

		const g = setup({ contextWindow: WINDOW });
		const early = appendTurn(g.sm, "u1", "a1", 0);
		g.pi.pi.setLabel(early.assistantId, "anchor:early");
		for (const n of [2, 3, 4]) appendTurn(g.sm, `u${n}`, `a${n}`, 0, true);
		const cut = appendTurn(g.sm, "u5", "a5", 0, true);
		g.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
		const kept = appendTurn(g.sm, "u5k", "a5k", 0, true);
		g.sm.appendCompaction("Compacted summary", kept.userId, 0);
		appendTurn(g.sm, "u6", "a6", 0, true);
		const registry = fakeRegistry();
		const before = snapshotOf(g.sm);
		const outcome = await __testHooks
			.foldApi(g.pi.pi)
			?.runFoldNow(foldCtx(g, registry.registry) as never, {
				...FOLD,
				rewindTo: "before-cut",
			});
		assert.equal(outcome?.status, "failed");
		if (outcome?.status !== "failed") return;
		assert.match(outcome.detail, /lies before the latest compaction/);
		assert.equal(registry.calls.length, 0);
		assert.deepEqual(snapshotOf(g.sm), before);
	});

	it("serializes folds per session", async () => {
		const f = await foldSetup(99_000);
		try {
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const registry = fakeRegistry(async (_call, index) => {
				if (index === 0) await gate;
				return reply(SUMMARY_TEXT);
			});
			const ctx = foldCtx(f, registry.registry);
			const sessionId = f.sm.getSessionId();
			const first = f.api.runFoldNow(ctx as never, FOLD);
			assert.deepEqual(await f.api.runFoldNow(ctx as never, { ...FOLD, newLabel: "other" }), {
				status: "busy",
			});
			assert.deepEqual(f.api.queueFold(sessionId, FOLD), {
				ok: false,
				reason: "a fold is already queued or running for this session",
			});
			release();
			assert.equal((await first).status, "done");
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("recommends the newest valid anchor inside the hint budget, else the oldest", () => {
		const candidates = [
			{ name: "old", valid: true, projectedAfterTokens: 40 },
			{ name: "mid", valid: true, projectedAfterTokens: 70 },
			{ name: "new", valid: true, projectedAfterTokens: 90 },
		];
		assert.equal(foldRecommendationBudget(100, null), 75);
		assert.equal(recommendFoldIndex(candidates, foldRecommendationBudget(100, 20)), 1);
		assert.equal(recommendFoldIndex(candidates, foldRecommendationBudget(100, null)), 1);
		assert.equal(recommendFoldIndex(candidates, foldRecommendationBudget(100, 50)), 0);
		assert.equal(recommendFoldIndex(candidates, foldRecommendationBudget(100, 70)), 0);
	});

	const PLAN_WIDTH = 120;
	const planTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	interface PlanScreen {
		handleInput(data: string): void;
		render(width: number): string[];
	}

	async function shown(screen: PlanScreen, includes: string): Promise<string> {
		for (let i = 0; i < 80; i++) {
			const text = screen.render(PLAN_WIDTH).join("\n");
			if (text.includes(includes)) return text;
			await new Promise((resolve) => setImmediate(resolve));
		}
		throw new Error(
			`screen never showed ${JSON.stringify(includes)}\n${screen.render(PLAN_WIDTH).join("\n")}`,
		);
	}

	async function driveAnchor(
		f: FoldFixture,
		ctx: ReturnType<typeof foldCtx>,
		args: string,
		scripts: Array<(screen: PlanScreen) => Promise<void>>,
	) {
		const pending = [...scripts];
		const command = f.pi.commands.get("anchor");
		assert.ok(command);
		await command.handler(args, {
			...ctx,
			hasUI: true,
			ui: {
				...ctx.ui,
				notify(message: string, type?: "info" | "warning" | "error") {
					ctx.notifyCalls.push([message, type]);
				},
				custom(factory: (...factoryArgs: unknown[]) => PlanScreen) {
					const script = pending.shift();
					assert.ok(script, "unexpected extra screen");
					return new Promise((resolve, reject) => {
						const screen = factory(
							{
								terminal: { rows: 40, columns: PLAN_WIDTH },
								requestRender() {},
							},
							planTheme,
							undefined,
							resolve,
						);
						screen.render(PLAN_WIDTH);
						script(screen).catch(reject);
					});
				},
			},
		} as never);
		assert.equal(pending.length, 0);
	}

	function assertCommandFolded(f: FoldFixture, label = "start-folded") {
		const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
		assert.ok(summary, "a branch_summary is on the active branch");
		assert.equal(summary.parentId, f.anchorId);
		assert.equal(f.sm.getLabel(f.leafId), `branch:${label}`);
		assert.equal(f.sm.getLabel(summary.id), `anchor:${label}`);
		assert.ok(!f.sm.getBranch().some((e) => e.id === f.leafId));
	}

	it("folds an idle session from /anchor fold without a user message, even when the guard would refuse", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry);
			assert.ok(estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW);
			await driveAnchor(f, ctx, "fold", [
				async (screen) => {
					assert.match(screen.render(PLAN_WIDTH).join("\n"), /chunked/);
					screen.handleInput("\r");
					await shown(screen, "folded as");
					screen.handleInput("\r");
				},
			]);
			assertCommandFolded(f);
			assertNoSummaryTurn(f, registry.calls);
			assert.match(
				JSON.stringify(registry.calls.at(-1)?.context.messages.at(-1)),
				/Latest request: u6/,
			);
			assert.equal(await guardAborts(f, ctx), false);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("queues /anchor fold while the agent is working and does not branch before the boundary", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry();
			const ctx = foldCtx(f, registry.registry, { isIdle: () => false });
			const before = snapshotOf(f.sm);
			await driveAnchor(f, ctx, "fold", [
				async (screen) => {
					assert.match(screen.render(PLAN_WIDTH).join("\n"), /agent working/);
					screen.handleInput("\r");
					await shown(screen, "queued");
					screen.handleInput("\r");
				},
			]);
			assert.equal(registry.calls.length, 0);
			assert.equal(f.pi.sendUserMessageCalls.length, 0);
			assert.deepEqual(snapshotOf(f.sm), before);
			const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
			assert.equal(result.continue, true);
			assertCommandFolded(f);
			assertNoSummaryTurn(f, registry.calls);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("cancels /anchor fold before the commit and keeps the branch", async () => {
		const f = await foldSetup(99_000);
		try {
			const registry = fakeRegistry(
				(call) =>
					new Promise((resolve) => {
						const signal = call.options.signal;
						const finish = () => resolve(reply("", "aborted"));
						if (!signal || signal.aborted) finish();
						else signal.addEventListener("abort", finish, { once: true });
					}),
			);
			const ctx = foldCtx(f, registry.registry);
			const before = snapshotOf(f.sm);
			await driveAnchor(f, ctx, "fold", [
				async (screen) => {
					screen.handleInput("\r");
					for (let i = 0; i < 50 && registry.calls.length === 0; i++)
						await new Promise((resolve) => setImmediate(resolve));
					assert.ok(registry.calls.length > 0, "the sidecar call started");
					screen.handleInput("\x1b");
					await shown(screen, "cancelled");
					screen.handleInput("\r");
					await shown(screen, "chunked");
					screen.handleInput("\x1b");
				},
			]);
			assert.deepEqual(snapshotOf(f.sm), before);
			assert.equal(
				f.sm.getBranch().some((e) => e.type === "branch_summary"),
				false,
			);
			assert.equal(f.pi.sendUserMessageCalls.length, 0);
			assert.equal(f.pi.sendMessageCalls.length, 0);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("refuses a pre-compaction anchor on the plan with the preview reason", async () => {
		const g = setup({ contextWindow: WINDOW });
		(g.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
		const early = appendTurn(g.sm, "u1", "a1", 0);
		g.pi.pi.setLabel(early.assistantId, "anchor:early");
		for (const n of [2, 3, 4]) appendTurn(g.sm, `u${n}`, `a${n}`, 0, true);
		const cut = appendTurn(g.sm, "u5", "a5", 0, true);
		g.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
		const kept = appendTurn(g.sm, "u5k", "a5k", 0, true);
		g.sm.appendCompaction("Compacted summary", kept.userId, 0);
		appendTurn(g.sm, "u6", "a6", 0, true);
		const before = snapshotOf(g.sm);
		const ctx = foldCtx(g, fakeRegistry().registry);
		await driveAnchor(g as FoldFixture, ctx, "fold", [
			async (screen) => {
				screen.handleInput("\x1b[A");
				const text = screen.render(PLAN_WIDTH).join("\n");
				assert.match(text, /before-cut/);
				assert.match(text, /not foldable/);
				assert.match(text, /lies before the latest compaction/);
				screen.handleInput("\x1b");
			},
		]);
		assert.deepEqual(snapshotOf(g.sm), before);
		assert.equal(g.pi.sendUserMessageCalls.length, 0);
	});

	for (const mode of ["full", "digest"] as const) {
		it(`prices a ${mode} child handoff as the commit materializes it`, async () => {
			const f = setup({ contextWindow: 1_000_000 });
			(f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
			const root = appendTurn(f.sm, "u1 keep the parser", "a1", 6_000);
			f.pi.pi.setLabel(root.assistantId, "anchor:start");
			for (const n of [2, 3, 4, 5]) appendTurn(f.sm, `u${n}`, `a${n}`, 12_000, true);
			const marker = "CHILD-HANDOFF-MARKER";
			const childLeaf = f.sm.getLeafId();
			assert.ok(childLeaf);
			f.sm.branchWithSummary(
				childLeaf,
				`${SUMMARY_TEXT}\n${marker} ${"evidence ".repeat(4_000)}`,
				{},
				true,
			);
			for (const n of [6, 7, 8]) appendTurn(f.sm, `u${n}`, `a${n}`, 20_000, true);
			const model = {
				provider: "claude",
				id: "claude-sonnet-4-5",
				contextWindow: 1_000_000,
				maxTokens: 64_000,
			};
			const focus = "Continue the parser work that is still open on this branch.";
			assert.equal(
				foldPlaceholderSummary(foldSummaryPlaceholderTokens(model.maxTokens)).length,
				DEFAULT_REDUCE_OUTPUT_TOKENS * 4,
			);
			assert.equal(foldSummaryPlaceholderTokens(100), 100);
			const prices = priceFoldCandidates(f.sm, {
				model,
				handoffMode: mode,
				focus,
				suggestLabel: (name) => (name === "start" ? "parent" : `${name}-folded`),
			});
			const start = prices.find((price) => price.name === "start");
			assert.ok(start?.valid, start?.reason ?? "");
			if (!start?.valid) return;
			const leafId = f.sm.getLeafId();
			assert.ok(leafId);
			const preview = previewFoldCommit(f.sm, {
				targetId: start.targetId,
				rewindTo: "start",
				newLabel: start.suggestedLabel,
				summaryText: foldPlaceholderSummary(foldSummaryPlaceholderTokens(model.maxTokens)),
				handoffMode: mode,
				contextWindow: model.contextWindow,
				foldPointId: leafId,
				continuationText: (afterTokens) =>
					buildRewindDoneText(
						{
							rewindTo: "start",
							newLabel: start.suggestedLabel,
							beforeTokens: start.beforeTokens,
							contextWindow: model.contextWindow,
						},
						afterTokens,
					),
			});
			assert.ok(preview.ok, preview.ok ? "" : preview.reason);
			if (!preview.ok) return;
			assert.equal(start.projectedAfterTokens, preview.projectedAfterTokens);
			assert.equal(preview.materialized.includes(marker), mode === "full");
			if (mode === "digest") assert.match(preview.materialized, /Earlier handoffs in this span/);
			const anchorOnly =
				estimateRequestTokens(buildSessionContext(f.sm.getEntries(), start.targetId).messages) +
				Math.ceil(ANCHOR_MANDATE.length / 3.5);
			assert.notEqual(start.projectedAfterTokens, start.beforeTokens - anchorOnly);
			assert.ok(start.projectedAfterTokens > anchorOnly);
			const outcome = await commitFold(f.sm, {
				targetId: start.targetId,
				rewindTo: "start",
				newLabel: start.suggestedLabel,
				summaryText: foldPlaceholderSummary(foldSummaryPlaceholderTokens(model.maxTokens)),
				handoffMode: mode,
				contextWindow: model.contextWindow,
				foldPointId: leafId,
				branchLabelEntryId: leafId,
				continuationText: (afterTokens) =>
					buildRewindDoneText(
						{
							rewindTo: "start",
							newLabel: start.suggestedLabel,
							beforeTokens: start.beforeTokens,
							contextWindow: model.contextWindow,
						},
						afterTokens,
					),
				writeLabel: (entryId, label) => {
					f.sm.appendLabelChange(entryId, label);
					return true;
				},
			});
			assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
			if (!outcome.ok) return;
			const summary = f.sm.getEntry(outcome.summaryId);
			assert.ok(summary && summary.type === "branch_summary");
			assert.equal(summary.summary, preview.materialized);
			assert.deepEqual(summary.details, preview.details);
		});
	}

	it("preselects the anchor chosen with r in the list", async () => {
		const f = await foldSetup(40_000);
		try {
			const assistants = f.sm
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			f.pi.pi.setLabel(assistants[2].id, "anchor:mid");
			const ctx = foldCtx(f, fakeRegistry().registry);
			await driveAnchor(f, ctx, "list", [
				async (screen) => {
					screen.handleInput("r");
				},
				async (screen) => {
					const text = screen.render(PLAN_WIDTH).join("\n");
					assert.match(text, /rewind to start/);
					assert.doesNotMatch(text, /rewind to mid/);
					screen.handleInput("\x1b");
				},
				async (screen) => {
					screen.handleInput("\x1b");
				},
			]);
			assert.equal(f.pi.sendUserMessageCalls.length, 0);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});
});
