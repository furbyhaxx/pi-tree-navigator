/** Extension continuity runtime tests. */
import { describe, it, jest } from "bun:test";
import * as assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { renderBriefing } from "../../src/continuity/continuity-briefing.ts";
import { LEDGER_DETAILS_KEY } from "../../src/continuity/continuity-ledger-model.ts";
import { parseLedger } from "../../src/continuity/continuity-ledger-parser.ts";
import {
	appendOpsEntry,
	CONTINUITY_OPS_CUSTOM_TYPE,
	readBranchLedger,
	type StoredOp,
} from "../../src/continuity/continuity-store.ts";
import { buildRewindDoneText } from "../../src/fold/fold-receipts.ts";
import { __testHooks } from "../../src/index.ts";
import { fireTurnEndAll } from "../support/boundary-drivers.ts";
import {
	cleanupConfigFixture,
	fireBeforeAgentStart,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "../support/config-fixtures.ts";
import { type FakeCtx, type FakePi, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, type RegistryCall, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { configureParentMode } from "../support/rewind-fixtures.ts";
import { setupAutonomousSpan } from "../support/session-fakes.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
} from "../support/session-messages.ts";

installHarnessHooks();

describe("rewind: continuity ledger", () => {
	const userMessage = (text: string) =>
		({ role: "user", content: [{ type: "text", text }] }) as never;

	/**
	 * u1 (rule R1 on the kept chain) → a1 [anchor:start] → span with a steering
	 * item (T2, scoped to `start`) and another rule (R3) that exist only on the
	 * branch about to be abandoned.
	 */
	function ledgerSetup() {
		const f = setup();
		const u1 = f.sm.appendMessage(userMessage("u1 never edit the lockfile"));
		appendOpsEntry(f.pi.pi, [
			{
				op: {
					op: "add",
					kind: "rule",
					text: "Never edit the lockfile",
					quote: "never edit the lockfile",
				},
				ctx: { origin: "user", entryId: u1 },
			},
		]);
		const a1 = f.sm.appendMessage(
			assistantMessage([{ type: "text", text: "a1" }], "stop", 6_000) as never,
		);
		f.pi.pi.setLabel(a1, "anchor:start");
		const t2 = appendTurn(f.sm, "u2 look at the parser first", "a2", 12_000, true);
		appendOpsEntry(f.pi.pi, [
			{
				op: {
					op: "add",
					kind: "steering",
					text: "Look at the parser first",
					scopeAnchor: "start",
				},
				ctx: { origin: "user", entryId: t2.userId },
			},
		]);
		const t3 = appendTurn(f.sm, "u3 always run the linter", "a3", 24_000, true);
		appendOpsEntry(f.pi.pi, [
			{
				op: { op: "add", kind: "rule", text: "Always run the linter" },
				ctx: { origin: "user", entryId: t3.userId },
			},
		]);
		const leafBeforeFold = f.sm.getLeafId() as string;
		const before = readBranchLedger(f.sm.getBranch());
		return { ...f, u1, a1, t2, t3, leafBeforeFold, before };
	}

	/** The rewind call, folded with `summary` as the side calls' answer; `calls` are the side calls. */
	async function foldWith(
		f: ReturnType<typeof ledgerSetup>,
		summary: string,
		args: Record<string, unknown> = REWIND_ARGS,
		toolCallId = "tc-rewind",
		totalTokens?: number,
	) {
		const registry = fakeRegistry(() => reply(summary));
		f.ctx.modelRegistry = registry.registry;
		const rewound = await requestRewind(f, args, toolCallId, totalTokens);
		return { ...rewound, calls: registry.calls };
	}

	async function ledgerFixture(opts: { summary?: string } = {}) {
		const f = ledgerSetup();
		const rewound = await foldWith(f, opts.summary ?? SUMMARY_TEXT);
		return { ...f, rewound };
	}

	/** The text of the request a side call carried. */
	const requestText = (call: RegistryCall) => {
		const last = call.context.messages.at(-1);
		assert.equal(last?.role, "user");
		const { content } = last as { content: unknown };
		return typeof content === "string"
			? content
			: (content as Array<{ text: string }>).map((b) => b.text).join("\n");
	};

	const foldedEntry = (sm: SessionManager, pi: FakePi) => {
		const done = rewindMessages(pi).at(-1);
		assert.ok(done, "a continuation was delivered");
		const entry = sm.getEntry(done.message.details.summaryId as string);
		assert.ok(entry && entry.type === "branch_summary");
		return { done: done.message, entry };
	};

	const deltaBlock = (body: unknown) =>
		`\n\n<continuity-delta>\n${JSON.stringify(body)}\n</continuity-delta>`;

	it("sends the ledger and the span's user messages with the summary request", async () => {
		const f = await ledgerFixture();
		const text = requestText(f.rewound.calls.at(-1) as RegistryCall);
		const at = text.indexOf("\n\nContinuity ledger rev 3.");
		assert.ok(at > 0, "the final request carries the continuity section");
		assert.ok(text.slice(0, at).endsWith(`Additional focus: ${REWIND_ARGS.summaryFocus}`));
		const section = text.slice(at);
		assert.match(section, /R1 Never edit the lockfile/);
		assert.match(section, /R3 Always run the linter/);
		assert.match(section, /Steering scoped to start \(archived by this fold\):\nT2 /);
		assert.ok(section.includes(`- ${f.t2.userId}: u2 look at the parser first`));
		assert.ok(section.includes(`- ${f.t3.userId}: u3 always run the linter`));
		assert.ok(!section.includes(f.u1), "u1 is before the anchor");
	});

	it("stores the reconciled snapshot and the briefing; the rule stays active, the steering is archived", async () => {
		const f = await ledgerFixture({ summary: SUMMARY_TEXT });
		const { done, entry } = foldedEntry(f.sm, f.pi);
		const snapshot = parseLedger((entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY]);
		const status = (id: string) => snapshot.items.find((item) => item.id === id)?.status;
		assert.equal(status("R1"), "active");
		assert.equal(status("R3"), "active");
		assert.equal(status("T2"), "archived");
		// Carried by the snapshot, not by the abandoned span's ops entries.
		assert.equal(
			f.sm.getBranch().some((e) => e.id === f.t3.userId),
			false,
		);
		assert.deepEqual(readBranchLedger(f.sm.getBranch()), {
			ledger: snapshot,
			warnings: [],
		});
		const briefing = renderBriefing(snapshot, { maxTokens: 2500 }).text;
		assert.equal(
			entry.summary,
			`# Work handoff: end\n\n${SUMMARY_TEXT}\n\n## Continuity ledger\n\n${briefing}`,
		);
		assert.ok(entry.summary.includes("R1 Never edit the lockfile"));
		assert.ok(!entry.summary.includes("Look at the parser first"));
		assert.deepEqual(done.details.continuity, {
			rev: snapshot.rev,
			applied: 1,
			rejected: [],
			evicted: [],
		});
		assert.equal(
			done.content,
			`${buildRewindDoneText(
				{
					rewindTo: "start",
					newLabel: "end",
					beforeTokens: done.details.contextBefore as number,
					contextWindow: 1_000_000,
				},
				done.details.contextAfter as number,
			)}\n\n${__testHooks.REFLECTION_BOOTSTRAP_WARNING_REWIND}`,
			"nothing to report: the continuation copy is unchanged",
		);
		assert.equal(
			f.sm.buildSessionContext().messages.some((m) => {
				const text = JSON.stringify(m);
				return text.includes("Never edit the lockfile");
			}),
			true,
			"the briefing reaches the model through the handoff",
		);
	});

	it("a summary that ends with a Standing authorization section and a delta block folds: the delta applies, the section is kept", async () => {
		const authorization =
			'## Standing authorization\n"work autonomously until done" — scope not complete.';
		const f = await ledgerFixture({
			summary:
				`${SUMMARY_TEXT}\n\n${authorization}` +
				deltaBlock({ ratified: [{ kind: "decision", text: "Use sqlite" }] }),
		});
		const { done, entry } = foldedEntry(f.sm, f.pi);
		assert.equal(done.details.status, "done");
		const snapshot = parseLedger((entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY]);
		assert.equal(snapshot.items.find((i) => i.text === "Use sqlite")?.status, "active");
		assert.ok(!entry.summary.includes("continuity-delta"));
		assert.ok(
			entry.summary.includes(`${SUMMARY_TEXT}\n\n${authorization}\n\n## Continuity ledger`),
			"the section sits between the summary and the briefing",
		);
	});

	it("rejects a delta that archives a user rule per item, applies the valid ones and says so", async () => {
		const f = await ledgerFixture({
			summary:
				SUMMARY_TEXT +
				deltaBlock({
					expiredSteering: ["R1"],
					ratified: [{ kind: "decision", text: "Use sqlite" }],
				}),
		});
		const { done, entry } = foldedEntry(f.sm, f.pi);
		const snapshot = parseLedger((entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY]);
		assert.equal(snapshot.items.find((i) => i.id === "R1")?.status, "active");
		assert.equal(snapshot.items.find((i) => i.text === "Use sqlite")?.status, "active");
		assert.ok(!entry.summary.includes("continuity-delta"));
		assert.ok(entry.summary.includes("Use sqlite"), "in the briefing");
		const report = done.details.continuity as {
			applied: number;
			rejected: Array<{ id?: string; reason: string }>;
		};
		assert.equal(report.applied, 2);
		assert.equal(report.rejected.length, 1);
		assert.equal(report.rejected[0].id, "R1");
		const lines = done.content.split("\n\n");
		const notice = lines.find((line) => line.startsWith("Continuity: "));
		assert.ok(notice, "the model is told its attempt was refused");
		assert.match(notice, /^Continuity: 1 delta op rejected \(R1 .*protected.*\)\.$/);
	});

	it("accepts a supersession that cites a newer user message of the active branch and refuses a bogus citation", async () => {
		const delta = (citedEntryId: string) =>
			SUMMARY_TEXT +
			deltaBlock({
				superseded: [
					{
						ids: ["R1"],
						with: { kind: "rule", text: "Edit the lockfile only via pnpm" },
						citedEntryId,
					},
				],
			});
		const f = ledgerSetup();
		await foldWith(f, delta(f.a1));
		const refused = foldedEntry(f.sm, f.pi);
		assert.equal((refused.done.details.continuity as { rejected: unknown[] }).rejected.length, 1);
		const g = ledgerSetup();
		await foldWith(g, delta(g.t3.userId));
		const accepted = foldedEntry(g.sm, g.pi);
		assert.deepEqual((accepted.done.details.continuity as { rejected: unknown[] }).rejected, []);
		const { ledger } = readBranchLedger(g.sm.getBranch());
		assert.equal(ledger.items.find((i) => i.id === "R1")?.status, "superseded");
		assert.equal(
			ledger.items.find((i) => i.text === "Edit the lockfile only via pnpm")?.source.origin,
			"user",
			"the replacement keeps the user's authority",
		);
	});

	it("a malformed delta never fails the fold: reported, nothing applied, block stripped", async () => {
		const f = await ledgerFixture({
			summary: `${SUMMARY_TEXT}\n\n<continuity-delta>\n{ nope\n</continuity-delta>`,
		});
		const { done, entry } = foldedEntry(f.sm, f.pi);
		assert.equal(done.details.status, "done");
		assert.ok(!entry.summary.includes("continuity-delta"));
		const report = done.details.continuity as {
			applied: number;
			deltaError?: string;
		};
		assert.equal(report.applied, 1, "only the deterministic steering archive");
		assert.match(report.deltaError ?? "", /not valid JSON/);
		assert.match(done.content, /\n\nContinuity: delta ignored \(/);
		assert.equal(
			readBranchLedger(f.sm.getBranch()).ledger.items.find((i) => i.id === "R1")?.status,
			"active",
		);
	});

	it("keeps a stray delta tag in the stored prose and reports nothing", async () => {
		const stray = `${SUMMARY_TEXT}\n\nThe tag <continuity-delta> is mentioned here.`;
		const f = await ledgerFixture({ summary: stray });
		const { done, entry } = foldedEntry(f.sm, f.pi);
		assert.ok(entry.summary.includes("The tag <continuity-delta> is mentioned here."));
		assert.equal((done.details.continuity as { deltaError?: string }).deltaError, undefined);
		assert.ok(!done.content.includes("Continuity:"));
	});

	it("the pre-fold leaf still reads the pre-fold ledger", async () => {
		const f = await ledgerFixture({ summary: SUMMARY_TEXT });
		const after = readBranchLedger(f.sm.getBranch());
		assert.equal(after.ledger.items.find((i) => i.id === "T2")?.status, "archived");
		f.sm.branch(f.leafBeforeFold);
		const recovered = readBranchLedger(f.sm.getBranch());
		assert.deepEqual(recovered, f.before);
		assert.equal(recovered.ledger.items.find((i) => i.id === "T2")?.status, "active");
	});

	it("an empty ledger and a span without user messages change nothing", async () => {
		const f = setup();
		setupAutonomousSpan(f.sm, f.pi);
		const registry = fakeRegistry(() =>
			reply(`${SUMMARY_TEXT}\n\nA stray </continuity-delta> in prose.`),
		);
		f.ctx.modelRegistry = registry.registry;
		await requestRewind(f);
		assert.ok(
			requestText(registry.calls.at(-1) as RegistryCall).endsWith(
				`Additional focus: ${REWIND_ARGS.summaryFocus}`,
			),
			"no continuity section in the request",
		);
		const { done, entry } = foldedEntry(f.sm, f.pi);
		assert.equal(
			entry.summary,
			`# Work handoff: end\n\n${SUMMARY_TEXT}\n\nA stray </continuity-delta> in prose.`,
		);
		assert.ok(!(LEDGER_DETAILS_KEY in (entry.details as object)));
		assert.ok(!("continuity" in done.details));
		assert.ok(!done.content.includes("Continuity"));
	});

	it("a failed fold applies nothing: the ledger and the branch stay as they were", async () => {
		const f = ledgerSetup();
		const { boundary } = await foldWith(
			f,
			`no goal heading${deltaBlock({ ratified: [{ kind: "decision", text: "Hidden" }] })}`,
		);
		assert.equal(boundary.entries[0].details.status, "failed");
		assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
		assert.deepEqual(readBranchLedger(f.sm.getBranch()).ledger, f.before.ledger);
	});

	it("a refused preview writes nothing, and the briefing counts toward the size check", async () => {
		const run = async (rules: number) => {
			const f = setup();
			const first = appendTurn(f.sm, "u1", "a1", 6_000);
			f.pi.pi.setLabel(first.assistantId, "anchor:start");
			const ops: StoredOp[] = Array.from({ length: rules }, (_, i) => ({
				op: {
					op: "add",
					kind: "rule",
					text: `Rule ${i}: ${"binding ".repeat(60)}`,
				},
				ctx: { origin: "user" },
			}));
			appendOpsEntry(f.pi.pi, ops);
			for (const totalTokens of [20_000, 30_000]) {
				f.sm.appendMessage(
					assistantMessage(
						[{ type: "text", text: "work. ".repeat(400) }],
						"stop",
						totalTokens,
					) as never,
				);
			}
			const before = readBranchLedger(f.sm.getBranch());
			const { boundary } = await requestRewind(f);
			return { f, before, boundary };
		};
		const small = await run(0);
		assert.ok(
			small.f.sm.getEntries().some((e) => e.type === "branch_summary"),
			"without a ledger the fold reduces",
		);
		const big = await run(12);
		assert.ok(!big.f.sm.getEntries().some((e) => e.type === "branch_summary"));
		assert.equal(big.boundary.entries[0].details.status, "failed");
		assert.equal(big.boundary.entries[0].details.stage, "commit");
		assert.match(
			String(big.boundary.entries[0].details.detail),
			/does not reduce projected context/,
		);
		assert.deepEqual(readBranchLedger(big.f.sm.getBranch()), big.before);
	});

	it("a parent fold embeds only its own briefing, not the child's", async () => {
		const f = await ledgerFixture({ summary: SUMMARY_TEXT });
		await configureParentMode(f, "full");
		const first = foldedEntry(f.sm, f.pi);
		assert.match(first.entry.summary, /continuity ledger rev 4\]/);
		appendTurn(f.sm, "u4 prefer small diffs", "a4", 40_000, true);
		appendOpsEntry(f.pi.pi, [
			{
				op: { op: "add", kind: "rule", text: "Prefer small diffs" },
				ctx: { origin: "user" },
			},
		]);
		appendTurn(f.sm, "u5", "a5", 60_000, true);
		await foldWith(
			f,
			"## Goal\nSecond fold.\n\n## Next Steps\n1. Go.",
			{ ...REWIND_ARGS, newLabel: "end2" },
			"tc-rewind-2",
			70_000,
		);
		const second = foldedEntry(f.sm, f.pi);
		assert.equal(second.entry.summary.split("## Continuity ledger").length, 2);
		assert.match(second.entry.summary, /Child handoffs in chronological order/);
		assert.ok(second.entry.summary.includes(SUMMARY_TEXT));
		assert.ok(second.entry.summary.endsWith("Prefer small diffs"));
		const { ledger } = readBranchLedger(f.sm.getBranch());
		assert.deepEqual(
			ledger.items.filter((i) => i.status === "active").map((i) => i.text),
			["Never edit the lockfile", "Always run the linter", "Prefer small diffs"],
		);
	});
});

// =============================================================================
// Session continuity ledger: the agent's `pin` action
// =============================================================================

describe("continuity capture", () => {
	const RULE = "From now on always answer in German";
	const userMessage = (text: string) =>
		({ role: "user", content: [{ type: "text", text }] }) as never;

	/**
	 * A user message with only `userText` (a heavy `appendTurn` would bury the
	 * words in padding) and an assistant reply of `tokens` usage and bulk text.
	 */
	function workTurn(sm: SessionManager, userText: string, tokens: number) {
		const userId = sm.appendMessage(userMessage(userText));
		const message = assistantMessage(
			[{ type: "text", text: "Recorded work and evidence.\n".repeat(1200) }],
			"stop",
			tokens,
		);
		return { userId, message, assistantId: sm.appendMessage(message as never) };
	}

	/** A complete user/assistant turn, then the turn's `turn_end` boundary. */
	async function turn(
		f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx },
		userText: string,
		tokens = 100,
	) {
		const { assistantId } = appendTurn(f.sm, userText, "ok", tokens);
		const message = (f.sm.getEntry(assistantId) as { message: unknown }).message;
		return fireTurnEndAll(f.pi, f.ctx, message);
	}

	const opsEntries = (sm: SessionManager) =>
		sm
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === CONTINUITY_OPS_CUSTOM_TYPE);

	const rulesOf = (sm: SessionManager) =>
		readBranchLedger(sm.getBranch()).ledger.items.filter(
			(item) => item.kind === "rule" && item.status === "active",
		);

	const answerRule = (kind: string) => ({
		answers: {
			kind: { type: "choice", choice: kind, probabilities: {}, confidence: 1 },
		},
	});

	function fakeRegistry(
		classify: (signal?: AbortSignal) => Promise<unknown>,
		known = ["typesafe/jev-latest"],
	) {
		const calls: string[] = [];
		const registry = {
			getModelOfType: (_type: string, provider: string, id: string) =>
				known.includes(`${provider}/${id}`) ? { provider, id } : undefined,
			classify: async (
				_model: unknown,
				context: { state: { message: string } },
				options?: { signal?: AbortSignal },
			) => {
				calls.push(context.state.message);
				return {
					api: "test",
					provider: "typesafe",
					model: "jev-latest",
					stopReason: "stop",
					timestamp: 0,
					...((await classify(options?.signal)) as object),
				};
			},
		};
		return { registry, calls };
	}

	async function withConfig(
		continuity: Record<string, unknown>,
		run: (f: ReturnType<typeof setup>) => Promise<void>,
		ctxOpts: { hasUI?: boolean } = {},
	) {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ continuity }));
			const f = setup();
			if (ctxOpts.hasUI !== undefined) f.ctx.hasUI = ctxOpts.hasUI;
			await runSessionStart(f.pi, f.ctx, fixture);
			await run(f);
		} finally {
			cleanupConfigFixture(fixture);
		}
	}

	it("captures nothing while navigate_tree is not in the active tool set", async () => {
		const f = setup();
		await fireBeforeAgentStart(f.pi, f.ctx, ["read", "bash"]);
		await turn(f, RULE);
		assert.equal(opsEntries(f.sm).length, 0);

		await fireBeforeAgentStart(f.pi, f.ctx, ["read", "navigate_tree"]);
		await turn(f, "Always use tabs from now on, going forward.");
		assert.equal(opsEntries(f.sm).length, 1);
	});

	it("records the user's rule verbatim after the turn, and nothing more on a turn without new input", async () => {
		const f = setup();
		const { userId, assistantId } = appendTurn(f.sm, RULE, "ok");
		const message = (f.sm.getEntry(assistantId) as { message: unknown }).message;
		await fireTurnEndAll(f.pi, f.ctx, message);

		const branch = f.sm.getBranch();
		assert.deepEqual(
			branch.slice(-3).map((e) => e.id),
			[userId, assistantId, opsEntries(f.sm)[0].id],
			"the entry follows the completed turn",
		);
		assert.equal(opsEntries(f.sm).length, 1);
		const [rule, ...rest] = rulesOf(f.sm);
		assert.equal(rest.length, 0);
		assert.equal(rule.source.origin, "user");
		assert.equal(rule.source.entryId, userId);
		assert.equal(rule.quote, RULE);
		assert.equal(rule.text, RULE);

		await fireTurnEndAll(f.pi, f.ctx, message);
		appendTurn(f.sm, "ok thanks", "sure");
		const next = f.sm.getBranch().at(-1) as { message: unknown };
		await fireTurnEndAll(f.pi, f.ctx, next.message);
		assert.equal(opsEntries(f.sm).length, 1);
		assert.equal(f.pi.appendEntryCalls.length, 1);
	});

	it("writes nothing and never calls the classifier when capture is off", async () => {
		const { registry, calls } = fakeRegistry(async () => answerRule("rule"));
		await withConfig({ capture: false, intentClassifier: "typesafe/jev-latest" }, async (f) => {
			(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
			await turn(f, RULE);
			await turn(f, "Never touch the generated files");
			assert.equal(opsEntries(f.sm).length, 0);
			assert.equal(f.pi.appendEntryCalls.length, 0);
			assert.deepEqual(calls, []);
		});
	});

	it("leaves a tool batch without all its results alone, then records after the last result", async () => {
		const f = setup();
		f.sm.appendMessage(userMessage(RULE));
		const call = appendToolCallAssistant(f.sm, [
			{ id: "tc-a", name: "bash", arguments: { command: "true" } },
			{ id: "tc-b", name: "bash", arguments: { command: "true" } },
		]);
		const resultA = appendToolResult(f.sm, "tc-a", "bash", "done");
		await fireTurnEndAll(f.pi, f.ctx, call.message);
		assert.equal(opsEntries(f.sm).length, 0, "a result is still outstanding");
		assert.equal(f.sm.getLeafId(), resultA);

		const resultB = appendToolResult(f.sm, "tc-b", "bash", "done");
		await fireTurnEndAll(f.pi, f.ctx, call.message);
		const [entry] = opsEntries(f.sm);
		assert.deepEqual(
			f.sm
				.getBranch()
				.slice(-3)
				.map((e) => e.id),
			[resultA, resultB, entry.id],
		);
	});

	it("skips an aborted turn and picks the input up on the next one", async () => {
		const f = setup();
		f.sm.appendMessage(userMessage(RULE));
		const aborted = assistantMessage([], "aborted", 0);
		f.sm.appendMessage(aborted as never);
		await fireTurnEndAll(f.pi, f.ctx, aborted);
		assert.equal(opsEntries(f.sm).length, 0);
		await turn(f, "carry on with the parser please");
		assert.equal(rulesOf(f.sm).length, 1);
	});

	describe("fold", () => {
		async function foldFixture(opts: { capturedBefore: boolean }) {
			const f = setup();
			const first = appendTurn(f.sm, "u1 setting the stage", "a1", 6_000);
			f.pi.pi.setLabel(first.assistantId, "anchor:start");
			if (opts.capturedBefore) {
				const rule = workTurn(f.sm, RULE, 12_000);
				await fireTurnEndAll(f.pi, f.ctx, rule.message);
				assert.equal(opsEntries(f.sm).length, 1);
			} else {
				workTurn(f.sm, RULE, 12_000);
			}
			const t3 = workTurn(f.sm, "u3 look at the parser", 24_000);
			await requestRewind(f);
			const done = rewindMessages(f.pi).at(-1);
			assert.ok(done, "a continuation was delivered");
			const entry = f.sm.getEntry(done.message.details.summaryId as string);
			assert.ok(entry && entry.type === "branch_summary");
			return { ...f, entry, t3 };
		}

		for (const capturedBefore of [true, false]) {
			it(`carries the rule into the snapshot and the briefing (captured ${capturedBefore ? "at its turn" : "only at the rewind turn"})`, async () => {
				const f = await foldFixture({ capturedBefore });
				const snapshot = parseLedger(
					(f.entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
				);
				const rules = snapshot.items.filter((i) => i.kind === "rule");
				assert.equal(rules.length, 1);
				assert.equal(rules[0].status, "active");
				assert.equal(rules[0].source.origin, "user");
				assert.equal(rules[0].quote, RULE);
				const briefing = renderBriefing(snapshot, { maxTokens: 2500 }).text;
				assert.ok(f.entry.summary.endsWith(`## Continuity ledger\n\n${briefing}`));
				assert.ok(briefing.includes(RULE));
				assert.equal(
					f.sm.getBranch().some((e) => e.id === f.t3.userId),
					false,
					"the span left the branch",
				);
			});
		}

		it("puts the span's rule into the summary request when no turn recorded it yet", async () => {
			const f = setup();
			const first = appendTurn(f.sm, "u1 setting the stage", "a1", 6_000);
			f.pi.pi.setLabel(first.assistantId, "anchor:start");
			workTurn(f.sm, RULE, 12_000);
			workTurn(f.sm, "u3 look at the parser", 24_000);
			assert.equal(f.pi.appendEntryCalls.length, 0);
			await requestRewind(f);
			assert.equal(
				f.pi.appendEntryCalls.filter(([type]) => type === CONTINUITY_OPS_CUSTOM_TYPE).length,
				1,
				"captured at the rewind turn, before the fold",
			);
			const request = JSON.stringify(f.ctx.registryCalls.at(-1)?.context.messages.at(-1));
			assert.ok(request.includes(`R1 ${RULE}`));
		});
	});

	describe("classifier", () => {
		it("asks the configured model and records what it calls a rule", async () => {
			const { registry, calls } = fakeRegistry(async () => answerRule("rule"));
			await withConfig({ intentClassifier: "typesafe/jev-latest" }, async (f) => {
				(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
				const quiet = "Please keep the answers short from here";
				await turn(f, quiet);
				assert.deepEqual(calls, [quiet]);
				assert.equal(rulesOf(f.sm)[0]?.quote, quiet);
			});
		});

		it("records a model-classified ephemeral message as seen, so it is not asked again", async () => {
			const { registry, calls } = fakeRegistry(async () => answerRule("ephemeral"));
			await withConfig({ intentClassifier: "typesafe/jev-latest" }, async (f) => {
				(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
				await turn(f, "What does the parser do with tabs?");
				await turn(f, "And what about the lexer, then?");
				assert.equal(calls.length, 2, "each message is asked once");
				assert.equal(opsEntries(f.sm).length, 2);
				assert.deepEqual(rulesOf(f.sm), []);
			});
		});

		it("warns once about an unknown classifier model and falls back to heuristics", async () => {
			const { registry, calls } = fakeRegistry(async () => answerRule("rule"), []);
			await withConfig({ intentClassifier: "typesafe/jev-latest" }, async (f) => {
				(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
				await turn(f, RULE);
				await turn(f, "Never touch the generated files");
				assert.deepEqual(calls, []);
				assert.equal(rulesOf(f.sm).length, 2, "heuristics still capture");
				assert.equal(f.ctx.notifyCalls.length, 1);
				assert.equal(f.ctx.notifyCalls[0][1], "warning");
				assert.match(f.ctx.notifyCalls[0][0], /typesafe\/jev-latest/);
			});
		});

		it("stays silent headless", async () => {
			const { registry } = fakeRegistry(async () => answerRule("rule"), []);
			await withConfig(
				{ intentClassifier: "typesafe/jev-latest" },
				async (f) => {
					(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
					await turn(f, RULE);
					assert.equal(rulesOf(f.sm).length, 1);
					assert.deepEqual(f.ctx.notifyCalls, []);
				},
				{ hasUI: false },
			);
		});

		it("discards an old classifier timeout after configuration reload", async () => {
			let first = true;
			const { registry, calls } = fakeRegistry((signal) => {
				if (!first) return Promise.resolve(answerRule("rule"));
				first = false;
				return new Promise((_resolve, reject) =>
					signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				);
			});
			await withConfig({ intentClassifier: "typesafe/jev-latest" }, async (f) => {
				(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
				const fixture = makeConfigFixture();
				writeGlobalConfig(
					fixture,
					JSON.stringify({
						continuity: { intentClassifier: "typesafe/jev-latest" },
					}),
				);
				jest.useFakeTimers();
				try {
					const pending = turn(f, RULE);
					await new Promise((resolve) => setImmediate(resolve));
					await runSessionStart(f.pi, f.ctx, fixture, "reload");
					jest.advanceTimersByTime(15_000);
					await pending;
					assert.deepEqual(
						f.ctx.notifyCalls,
						[],
						"stale timeout must not suppress or warn for the new configuration",
					);
					await turn(f, "Keep the output readable");
					assert.ok(calls.length > 1, "new configuration still uses the classifier");
				} finally {
					jest.useRealTimers();
					cleanupConfigFixture(fixture);
				}
			});
		});

		it("does not let a classifier that never answers stall the turn or dump its policy", async () => {
			const { registry, calls } = fakeRegistry(
				(signal) =>
					new Promise((_resolve, reject) =>
						signal?.addEventListener("abort", () => reject(new Error("aborted"))),
					),
			);
			Object.assign(registry, {
				getAvailableOfType: async (type: string) =>
					type === "classifier"
						? [{ provider: "typesafe", id: "jev-latest", api: "decisions" }]
						: [],
				streamSimple: () => {
					throw new Error("No chat calls expected");
				},
			});
			await withConfig(
				{ intentClassifier: { kind: { model: "typesafe/jev-latest" } } },
				async (f) => {
					(f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
					jest.useFakeTimers();
					try {
						const pending = turn(f, RULE);
						await new Promise((resolve) => setImmediate(resolve));
						jest.advanceTimersByTime(15_000);
						await pending;
					} finally {
						jest.useRealTimers();
					}
					assert.equal(calls.length, 1);
					assert.equal(rulesOf(f.sm).length, 1, "the heuristic pass caught it");
					assert.equal(f.ctx.notifyCalls.length, 1);
					assert.match(
						f.ctx.notifyCalls[0][0],
						/classifier typesafe\/jev-latest did not answer within 15 s/,
					);
					assert.ok(!f.ctx.notifyCalls[0][0].includes("{"));
					await turn(f, "Never touch the generated files");
					assert.equal(calls.length, 1, "the model is not asked again");
					assert.equal(rulesOf(f.sm).length, 2);
				},
			);
		});
	});
});

// =============================================================================
// Independent folds from the extension (engine host)
//
// A fold is summarized by registry side calls, never by a main-agent turn, so
// it works for a session whose next main request the admission guard would
// refuse. Nothing is written before the commit.
// =============================================================================
