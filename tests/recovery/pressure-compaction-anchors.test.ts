/** Extension pressure compaction anchors tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	buildSessionContext,
	CONFIG_DIR_NAME,
	type ExtensionCommandContext,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { estimateContentTokens, estimateRequestTokens } from "../../src/core/context-tokens.ts";
import { formatPct1 } from "../../src/core/helpers.ts";
import { ANCHOR_MANDATE } from "../../src/core/request-accounting.ts";
import {
	buildReserveGuardWarning,
	buildReserveOrderWarning,
	REWIND_COMPACTION_OFF_TEXT,
} from "../../src/core/rewind-hint.ts";
import { REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { __testHooks } from "../../src/index.ts";
import {
	anchorStart,
	type ConfigFixture,
	cleanupConfigFixture,
	fireTurnEnd,
	makeConfigFixture,
	runSessionStart,
	usageAt,
	writeGlobalConfig,
	writePiSettings,
} from "../support/config-fixtures.ts";
import { makeCtx, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { forcedSetup, theme, WINDOW } from "../support/pressure-fixtures.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { appendTurn } from "../support/session-messages.ts";

installHarnessHooks();

/** Write the fixture's project pi `.pi/settings.json` (#101). */
function writeProjectPiSettings(fixture: ConfigFixture, settings: unknown): void {
	const dir = join(fixture.projectDir, CONFIG_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

describe("rewind-driven compaction (#101)", () => {
	describe("anchors before a compaction", () => {
		const WINDOW = 100_000;

		/**
		 * Five pre-compaction turns, then one the compaction keeps (anchored as
		 * `kept`), then two more. Zero recorded usage by default, so the
		 * request-time estimate and the fold gate price the same characters.
		 */
		function compactedSession(usageOf = (_turn: number) => 0) {
			const f = setup({ contextWindow: WINDOW });
			const early = appendTurn(f.sm, "u1", "a1", usageOf(1));
			f.pi.pi.setLabel(early.assistantId, "anchor:early");
			for (const n of [2, 3, 4]) appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
			const cut = appendTurn(f.sm, "u5", "a5", usageOf(5), true);
			f.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
			const kept = appendTurn(f.sm, "u5k", "a5k", usageOf(5), true);
			f.pi.pi.setLabel(kept.assistantId, "anchor:kept");
			f.sm.appendCompaction("Compacted summary", kept.userId, 0);
			const late = appendTurn(f.sm, "u6", "a6", usageOf(6), true);
			f.pi.pi.setLabel(late.assistantId, "anchor:after-cut");
			appendTurn(f.sm, "u7", "a7", usageOf(7), true);
			return {
				...f,
				ids: {
					early: early.assistantId,
					cut: cut.assistantId,
					kept: kept.assistantId,
					keptUser: kept.userId,
					late: late.assistantId,
				},
			};
		}

		/** What a fold at `entryId` leaves before any handoff: Pi's own context at that leaf. */
		const footprintAt = (sm: SessionManager, entryId: string) =>
			estimateContentTokens(buildSessionContext(sm.getEntries(), entryId).messages);

		/** The same footprint as the request guard prices it: SDK-scaled, plus the mandate the prompt appends. */
		const admissionAt = (sm: SessionManager, entryId: string) =>
			estimateRequestTokens(buildSessionContext(sm.getEntries(), entryId).messages) +
			Math.ceil(ANCHOR_MANDATE.length / 3.5);

		const parentOf = (sm: SessionManager, entryId: string) => {
			const parentId = sm.getEntry(entryId)?.parentId;
			assert.ok(parentId);
			return parentId;
		};

		const foldArgs = (rewindTo: string) => ({
			...REWIND_ARGS,
			rewindTo,
			newLabel: "folded",
		});

		it("lists a pre-compaction anchor at its un-compacted footprint, not the compaction baseline", async () => {
			const { sm, tool, ctx, ids } = compactedSession();
			const res = await tool.execute("tc-list", { action: "list" }, undefined, undefined, ctx);
			const text = res.content[0].text;
			for (const [name, id] of [
				["early", ids.early],
				["before-cut", ids.cut],
				["after-cut", ids.late],
			]) {
				const pct = formatPct1(admissionAt(sm, id), WINDOW).replace(".", "\\.");
				assert.match(text, new RegExp(`${pct}\\s+${name}\\b`), text);
			}
			assert.ok(
				footprintAt(sm, ids.cut) > estimateContentTokens(sm.buildSessionContext().messages),
				"the fixture's pre-compaction anchor costs more than the compacted context",
			);
		});

		it("flags in /anchor list only the pre-compaction anchors a fold cannot free", async () => {
			const f = compactedSession();
			const ctx = makeCtx(f.sm, { contextWindow: WINDOW, hasUI: false });
			const command = f.pi.commands.get("anchor");
			assert.ok(command);
			await command.handler("list", ctx as unknown as ExtensionCommandContext);
			const lines = ctx.notifyCalls[0][0].split("\n");
			const row = (name: string) => lines.find((line) => line.includes(` ${name} `)) ?? "";
			assert.match(row("before-cut"), /−0 savable {2}\(before compaction\)$/);
			assert.match(row("early"), /savable$/);
			assert.match(row("kept"), /savable$/);
			assert.match(row("after-cut"), /savable$/);
		});

		it("carries the compaction forward when the target lies inside its kept range", async () => {
			const f = compactedSession();
			const original = f.sm.getBranch().find((entry) => entry.type === "compaction");
			assert.ok(original);
			const uncarried = admissionAt(f.sm, f.ids.kept);
			const { result } = await requestRewind(f, foldArgs("kept"), "tc-kept", 0);
			assert.equal(result.isError, undefined, result.content[0].text);
			const done = rewindMessages(f.pi).at(-1)?.message;
			assert.equal(done?.details.status, "done", String(done?.details.detail));

			const branch = f.sm.getBranch();
			const summaryAt = branch.findIndex((e) => e.type === "branch_summary");
			const copies = branch.filter((e) => e.type === "compaction" && e.id !== original.id);
			assert.equal(copies.length, 1, "one carried copy");
			const copy = copies[0] as typeof original & {
				firstKeptEntryId: string;
				summary: string;
				details: { carriedFrom?: string };
			};
			assert.ok(branch.indexOf(copy) > summaryAt, "copy follows the summary");
			assert.equal(copy.summary, "Compacted summary");
			assert.equal(copy.firstKeptEntryId, f.ids.keptUser);
			assert.equal(copy.details.carriedFrom, original.id);

			const messages = f.sm.buildSessionContext().messages;
			const texts = JSON.stringify(messages);
			for (const gone of ["u1", "u2", "u3", "u4", "u5"])
				assert.ok(!texts.includes(`"${gone}"`), `${gone} stays compacted`);
			assert.ok(texts.includes('"u5k"'), "the kept turn stays");

			// The preview priced the target through the same carried copy.
			const handoffAt = messages.findIndex(
				(m) => m.role === "custom" && m.customType === "navigate-tree-handoff",
			);
			assert.ok(handoffAt > 0);
			const carriedPrice =
				estimateRequestTokens(messages.slice(0, handoffAt)) +
				Math.ceil(ANCHOR_MANDATE.length / 3.5);
			assert.equal(result.details.tokensAtTarget, carriedPrice);
			assert.ok(carriedPrice < uncarried, "carrying keeps history compacted");
		});

		it("keeps anchors foldable after a carried fold and still refuses targets before the kept range", async () => {
			const f = compactedSession();
			await requestRewind(f, foldArgs("kept"), "tc-kept", 0);
			appendTurn(f.sm, "u8", "a8", 0, true);
			appendTurn(f.sm, "u9", "a9", 0, true);
			const ctx = makeCtx(f.sm, { contextWindow: WINDOW, hasUI: false });
			const command = f.pi.commands.get("anchor");
			assert.ok(command);
			await command.handler("list", ctx as unknown as ExtensionCommandContext);
			const lines = ctx.notifyCalls[0][0].split("\n");
			const row = (name: string) => lines.find((line) => line.includes(` ${name} `)) ?? "";
			assert.match(row("kept"), /savable$/);
			assert.match(row("folded"), /savable$/);
			assert.match(row("before-cut"), /\(before compaction\)$/);
		});

		it("refuses a fold to a pre-compaction anchor at request time, before any fold is queued", async () => {
			const f = compactedSession();
			const { result, callId } = await requestRewind(f, foldArgs("before-cut"), "tc-cut", 0);
			assert.equal(result.isError, true);
			assert.equal(result.details.rejected, "min-savings");
			assert.match(result.content[0].text, /lies before the latest compaction/);
			assert.equal(
				result.details.apparentSavings,
				admissionAt(f.sm, parentOf(f.sm, callId)) - admissionAt(f.sm, f.ids.cut),
			);
			assert.ok(Number(result.details.apparentSavings) < 0);
			assert.deepEqual(
				f.pi.boundaryResults.flatMap((r) => r.entries),
				[],
				"no fold ran",
			);
			assert.equal(f.ctx.registryCalls.length, 0);
		});

		for (const [anchor, key] of [
			["after-cut", "late"],
			["early", "early"],
		] as const) {
			it(`prices '${anchor}' by the footprint its fold leaves, so the gate agrees`, async () => {
				const f = compactedSession();
				const { result, callId, leafBeforeFold } = await requestRewind(
					f,
					foldArgs(anchor),
					"tc-fold",
					0,
				);
				assert.equal(result.isError, undefined);
				const priced = footprintAt(f.sm, f.ids[key]);
				// The fold point is the rewind call's tool result, which the fold collapses too.
				const before = footprintAt(f.sm, leafBeforeFold);
				assert.equal(result.details.tokensAtTarget, admissionAt(f.sm, f.ids[key]));
				assert.equal(result.details.contextBefore, admissionAt(f.sm, parentOf(f.sm, callId)));

				const done = rewindMessages(f.pi).at(-1)?.message;
				assert.equal(done?.details.status, "done");
				assert.equal(done?.details.foldEstimateBefore, before);
				assert.ok(Number(done?.details.foldEstimateAfter) > priced);
				const messages = f.sm.buildSessionContext().messages;
				const handoffAt = messages.findIndex(
					(m) => m.role === "custom" && m.customType === "navigate-tree-handoff",
				);
				assert.ok(handoffAt > 0);
				assert.equal(estimateContentTokens(messages.slice(0, handoffAt)), priced);
			});
		}

		it("names the compaction when the gate refuses a pre-compaction target that recorded usage under-priced", async () => {
			const f = compactedSession((turn) => (turn <= 5 ? 6_000 : turn === 6 ? 20_000 : 30_000));
			const { result, boundary } = await requestRewind(f, foldArgs("before-cut"), "tc-cut", 0);
			assert.equal(result.isError, undefined, "usage prices the target low");
			assert.equal(f.sm.getEntries().filter((entry) => entry.type === "branch_summary").length, 0);
			assert.equal(boundary.entries[0].details.status, "failed");
			assert.equal(boundary.entries[0].details.stage, "commit");
			assert.match(
				String(boundary.entries[0].details.detail),
				/'before-cut' lies before the latest compaction.*\(estimated \d+ -> \d+ tokens\); original history was kept/,
			);
		});
	});

	it("D9: compaction on → TUI error once per crossing, no hint; headless silent; re-read per crossing", async () => {
		const f = await forcedSetup({
			piSettings: { compaction: { enabled: true } },
		});
		try {
			f.ctx.setContextUsage(usageAt(90, WINDOW));
			fireTurnEnd(f.pi, f.ctx);
			fireTurnEnd(f.pi, f.ctx);
			assert.deepEqual(f.ctx.notifyCalls, [[REWIND_COMPACTION_OFF_TEXT, "error"]]);
			assert.equal(f.pi.sendMessageCalls.length, 0);
			// Settings change between crossings: the next crossing hints.
			writePiSettings(f.fixture, { compaction: { enabled: false } });
			f.ctx.setContextUsage(usageAt(10, WINDOW));
			fireTurnEnd(f.pi, f.ctx);
			f.ctx.setContextUsage(usageAt(90, WINDOW));
			fireTurnEnd(f.pi, f.ctx);
			assert.equal(f.pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
		const g = await forcedSetup({ piSettings: {} });
		try {
			g.ctx.hasUI = false;
			g.ctx.setContextUsage(usageAt(90, WINDOW));
			fireTurnEnd(g.pi, g.ctx);
			assert.deepEqual(g.ctx.notifyCalls, []);
			assert.equal(g.pi.sendMessageCalls.length, 0);
		} finally {
			cleanupConfigFixture(g.fixture);
		}
	});

	it("D9: project settings count only when the project is trusted", async () => {
		for (const trusted of [false, true]) {
			const fixture = makeConfigFixture();
			try {
				writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 20_000 }));
				writeProjectPiSettings(fixture, { compaction: { enabled: true } });
				const f = setup({ contextWindow: WINDOW });
				f.ctx.cwd = fixture.projectDir;
				f.ctx.isProjectTrusted = () => trusted;
				await runSessionStart(f.pi, f.ctx, fixture);
				anchorStart(f.sm, f.pi);
				f.ctx.setContextUsage(usageAt(90, WINDOW));
				fireTurnEnd(f.pi, f.ctx);
				assert.equal(f.pi.sendMessageCalls.length, trusted ? 0 : 1);
				assert.equal(f.ctx.notifyCalls.length, trusted ? 1 : 0);
			} finally {
				cleanupConfigFixture(fixture);
			}
		}
	});

	it("D9 (S3): the live session's compaction setting decides, not the disk (#101)", async () => {
		for (const live of [true, false]) {
			// The disk says the opposite of the session's in-memory settings.
			const f = await forcedSetup({
				piSettings: { compaction: { enabled: !live } },
			});
			try {
				const session = {
					sessionManager: f.sm,
					settingsManager: SettingsManager.inMemory({
						compaction: { enabled: live },
					}),
				};
				__testHooks.captureSession(session as unknown as AgentSession);
				f.ctx.setContextUsage(usageAt(90, WINDOW));
				fireTurnEnd(f.pi, f.ctx);
				assert.equal(f.pi.sendMessageCalls.length, live ? 0 : 1, `live=${live}`);
				assert.equal(f.ctx.notifyCalls.length, live ? 1 : 0, `live=${live}`);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
	});

	it("warns for the concrete active model rather than treating wildcard patterns as models", async () => {
		const f = await forcedSetup({
			config: {
				model_overrides: { "claude/*": { rewind_hint_reserve_tokens: 10_000 } },
			},
		});
		try {
			assert.deepEqual(f.ctx.notifyCalls, [
				[buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"), "warning"],
			]);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("D10: warns per model when the hint reserve is below pi's, only with compaction off", async () => {
		const f = await forcedSetup({
			config: {
				rewindHintReserveTokens: 10_000,
				modelOverrides: { "openai/gpt-x": { rewindHintReserveTokens: 50_000 } },
			},
			piSettings: {
				compaction: {
					enabled: false,
					modelOverrides: { "openai/gpt-x": { reserveTokens: 60_000 } },
				},
			},
		});
		try {
			assert.deepEqual(f.ctx.notifyCalls, [
				[buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"), "warning"],
				[buildReserveOrderWarning(50_000, 60_000, "openai/gpt-x"), "warning"],
			]);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
		const g = await forcedSetup({
			config: { rewindHintReserveTokens: 10_000 },
			piSettings: {},
		});
		try {
			assert.deepEqual(g.ctx.notifyCalls, [], "compaction on: D9's case");
		} finally {
			cleanupConfigFixture(g.fixture);
		}
	});

	it("D10: warns when the hint reserve does not exceed what the request guard keeps free", async () => {
		// The guard keeps 1,024 output + 4,096 headroom tokens free.
		for (const [reserve, guarded] of [
			[4_000, true],
			[5_120, true],
			[5_121, false],
		] as const) {
			const f = await forcedSetup({
				config: { rewindHintReserveTokens: reserve },
			});
			try {
				assert.deepEqual(f.ctx.notifyCalls, [
					[buildReserveOrderWarning(reserve, 16_384, "claude/claude-sonnet-4-5"), "warning"],
					...(guarded
						? [
								[
									buildReserveGuardWarning(reserve, 5_120, "claude/claude-sonnet-4-5"),
									"warning",
								] as const,
							]
						: []),
				]);
			} finally {
				cleanupConfigFixture(f.fixture);
			}
		}
		const g = await forcedSetup({
			config: { rewindHintReserveTokens: 4_000 },
			piSettings: {},
		});
		try {
			assert.deepEqual(g.ctx.notifyCalls, [], "compaction on: D9's case");
		} finally {
			cleanupConfigFixture(g.fixture);
		}
	});

	it("D10 (fix 9): one model's invalid pi reserve does not skip the others", async () => {
		const f = await forcedSetup({
			config: {
				rewindHintReserveTokens: 10_000,
				modelOverrides: {
					"openai/bad": { rewindHintReserveTokens: 50_000 },
					"openai/gpt-x": { rewindHintReserveTokens: 50_000 },
				},
			},
			piSettings: {
				compaction: {
					enabled: false,
					modelOverrides: {
						"openai/bad": { reserveTokens: "x" },
						"openai/gpt-x": { reserveTokens: 60_000 },
					},
				},
			},
		});
		try {
			assert.deepEqual(f.ctx.notifyCalls, [
				[buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"), "warning"],
				[buildReserveOrderWarning(50_000, 60_000, "openai/gpt-x"), "warning"],
			]);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});

	it("renders D8 as one error-styled row; the forced message keeps pi's default box", async () => {
		const f = await forcedSetup();
		try {
			const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (
				...a: unknown[]
			) => { render(w: number): string[] } | undefined;
			assert.ok(renderer);
			const text = "the forced rewind was aborted";
			const row = renderer(
				{
					role: "custom",
					customType: REWIND_CUSTOM_TYPE,
					content: text,
					display: true,
					details: { status: "failed" },
				},
				{ expanded: false, outputPad: 1 },
				theme,
			);
			assert.deepEqual(row?.render(1000), [` <error>${text}`]);
			assert.equal(
				renderer(
					{
						role: "custom",
						customType: REWIND_CUSTOM_TYPE,
						content: "x",
						display: true,
						details: { status: "forced" },
					},
					{ expanded: false, outputPad: 1 },
					theme,
				),
				undefined,
			);
		} finally {
			cleanupConfigFixture(f.fixture);
		}
	});
});
