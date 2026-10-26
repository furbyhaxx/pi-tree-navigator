/** Extension hint integration tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { TREE_NAVIGATOR_CONFIG_FILENAME } from "../../src/core/config.ts";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import { buildNoAnchorText, REWIND_HINT_CUSTOM_TYPE } from "../../src/core/rewind-hint.ts";
import { START_ANCHOR_LABEL } from "../../src/fold/fold-policy.ts";
import { fireTurnEndAll } from "../support/boundary-drivers.ts";
import {
	anchorStart,
	type ConfigFixture,
	cleanupConfigFixture,
	expectedHint,
	fireBeforeAgentStart,
	fireTurnEnd,
	makeConfigFixture,
	projectConfigPath,
	runSessionStart,
	usageAt,
	writeGlobalConfig,
	writeProjectConfig,
} from "../support/config-fixtures.ts";
import { type FakeCtx, type FakePi, makeCtx, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { setupRewindable } from "../support/session-fakes.ts";
import { appendTurn, assistantMessage } from "../support/session-messages.ts";

installHarnessHooks();

function globalConfigPath(fixture: ConfigFixture): string {
	return join(fixture.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME);
}

describe("settings live application", () => {
	it("runtime capture save immediately blocks pin without writing config, and reload restores file settings", async () => {
		const fixture = makeConfigFixture();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		try {
			writeGlobalConfig(fixture, JSON.stringify({ continuity: { capture: true } }));
			const before = readFileSync(globalConfigPath(fixture), "utf8");
			const f = setup();
			f.ctx.cwd = fixture.projectDir;
			anchorStart(f.sm, f.pi);
			await runSessionStart(f.pi, f.ctx, fixture);
			const keys = [["t"], ["\x1b[H", "\x1b[B", "\x1b[B", "\x1b[B", "\r"], ["s"], ["\r"], ["\x1b"]];
			const ctx = {
				...f.ctx,
				hasUI: true,
				isIdle: () => true,
				ui: {
					...f.ctx.ui,
					confirm: async () => true,
					custom(
						factory: (...args: unknown[]) => {
							render(width: number): string[];
							handleInput(key: string): void;
						},
					) {
						return new Promise((resolve) => {
							const screen = factory(
								{ terminal: { rows: 50, columns: 130 }, requestRender() {} },
								{
									fg: (_: string, text: string) => text,
									bold: (text: string) => text,
									italic: (text: string) => text,
								},
								undefined,
								resolve,
							);
							screen.render(130);
							const script = keys.shift();
							assert.ok(script, "unexpected settings screen");
							for (const key of script) screen.handleInput(key);
						});
					},
				},
			} as unknown as ExtensionCommandContext;
			const command = f.pi.commands.get("anchor");
			assert.ok(command);
			await command.handler("settings", ctx);
			assert.equal(keys.length, 0);
			const refused = await f.tool.execute(
				"runtime-pin",
				{ action: "pin", kind: "fact", text: "Runtime was applied" },
				undefined,
				undefined,
				f.ctx,
			);
			assert.equal(refused.isError, true);
			assert.match(refused.content[0].text, /disabled by config/);
			assert.equal(readFileSync(globalConfigPath(fixture), "utf8"), before);
			await runSessionStart(f.pi, f.ctx, fixture, "reload");
			const allowed = await f.tool.execute(
				"file-pin",
				{ action: "pin", kind: "fact", text: "File settings restored" },
				undefined,
				undefined,
				f.ctx,
			);
			assert.equal(allowed.isError, undefined);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			cleanupConfigFixture(fixture);
		}
	});
});

describe("rewind hint: session_start config wiring (#44)", () => {
	it("loads the global threshold and fires on the first crossing", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 100_000 }));
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, [], "valid config must not warn");

			ctx.setContextUsage(usageAt(89.9));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0, "below-threshold observation must not fire");

			ctx.setContextUsage(usageAt(90));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			// Real call arity: exactly one argument (no options bag).
			assert.equal(pi.sendMessageCalls[0].length, 1);
			assert.deepEqual(pi.sendMessageCalls[0], [
				{
					customType: REWIND_HINT_CUSTOM_TYPE,
					content: expectedHint(90),
					display: true,
				},
			]);
			// Byte-exact pin: the anchors are named, so no `list` call is needed.
			assert.equal(
				pi.sendMessageCalls[0][0].content,
				"[navigate_tree hint] Context is at 90.0% of 1.0M — 100.0k tokens left, within the 100.0k reserve. Persist what matters to files now, then rewind to the oldest appropriate anchor.\nActive anchors (root → leaf, % of 1.0M):\n   0.0%  start",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("project layer overrides global when trusted; untrusted ignores the file", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 100_000 }));
			writeProjectConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 500_000 }));

			// Trusted: the project's 500k reserve wins over the global 100k.
			{
				const { sm, pi, ctx } = setup();
				anchorStart(sm, pi);
				ctx.cwd = fixture.projectDir;
				ctx.isProjectTrusted = () => true;
				await runSessionStart(pi, ctx, fixture);
				ctx.setContextUsage(usageAt(50));
				fireTurnEnd(pi, ctx);
				assert.equal(pi.sendMessageCalls.length, 1);
				assert.deepEqual(ctx.notifyCalls, []);
			}

			// Untrusted: the project file is ignored silently; 50% does not
			// fire (500k left > 100k), 90% does.
			{
				const { sm, pi, ctx } = setup();
				anchorStart(sm, pi);
				ctx.cwd = fixture.projectDir;
				await runSessionStart(pi, ctx, fixture);
				ctx.setContextUsage(usageAt(50));
				fireTurnEnd(pi, ctx);
				assert.equal(pi.sendMessageCalls.length, 0);
				assert.deepEqual(ctx.notifyCalls, []);
				ctx.setContextUsage(usageAt(90));
				fireTurnEnd(pi, ctx);
				assert.equal(pi.sendMessageCalls.length, 1);
			}
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("invalid config disables the hint and surfaces one warning per layer", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, "{ not json");
			writeProjectConfig(fixture, JSON.stringify({ rewindHintReserveTokens: true }));
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			ctx.cwd = fixture.projectDir;
			ctx.isProjectTrusted = () => true;
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, [
				[
					`navigate_tree: invalid JSON in global config at ${globalConfigPath(fixture)} — that layer was ignored.`,
					"warning",
				],
				[
					`navigate_tree: invalid rewindHintReserveTokens in project config at ${projectConfigPath(fixture)} — expected integer 1000-1000000 or a disable sentinel (null, false, "off", "disabled"); rewind hint disabled for this session.`,
					"warning",
				],
			]);
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.equal(ctx.notifyCalls.length, 2, "the turn must not add config warnings");
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("the removed rewindHintAtPercent warns and leaves the hint off", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintAtPercent: "90" }));
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, [
				[
					`navigate_tree: rewindHintAtPercent in global config at ${globalConfigPath(fixture)} was removed in 0.3.0 and is ignored — use rewindHintReserveTokens (tokens left in the window when the hint fires, e.g. 50000).`,
					"warning",
				],
			]);
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("suppresses config warnings when the session has no UI", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, "{ not json");
			const { pi, ctx } = setup();
			ctx.hasUI = false;
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, []);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("is default-off when no config exists (ENOENT is silent)", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, []);
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("reload resets the tracker and the toolActive gate", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 100_000 }));
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);

			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1, "spent crossing must not re-fire");

			// Tool gate off: no fire, even across the threshold.
			await fireBeforeAgentStart(pi, ctx, ["read", "bash"]);
			ctx.setContextUsage(usageAt(10));
			fireTurnEnd(pi, ctx);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);

			// session_start resets both: gate back on, tracker re-armed.
			await runSessionStart(pi, ctx, fixture);
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 2, "reload must re-arm the tracker");
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});

describe("rewind hint: turn_end handler (#44)", () => {
	const ENABLED_CONFIG = JSON.stringify({ rewindHintReserveTokens: 100_000 });

	async function enabledSetup(): Promise<{
		fixture: ConfigFixture;
		sm: SessionManager;
		pi: FakePi;
		ctx: FakeCtx;
	}> {
		const fixture = makeConfigFixture();
		writeGlobalConfig(fixture, ENABLED_CONFIG);
		const { sm, pi, ctx } = setup();
		anchorStart(sm, pi);
		await runSessionStart(pi, ctx, fixture);
		return { fixture, sm, pi, ctx };
	}

	it("does not fire when disabled by a sentinel", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: null }));
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("does not fire when the tool is inactive", async () => {
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			await fireBeforeAgentStart(pi, ctx, ["read"]);
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("keeps the tool gate per-session (#58): a sibling session must not clear this session's hint", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, ENABLED_CONFIG);
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);

			// Session A runs with the tool active, recording A's per-session gate.
			await fireBeforeAgentStart(pi, ctx, [TOOL_NAME, "read"]);

			// Sibling session B (e.g. an in-process subagent) starts without it.
			const smB = SessionManager.inMemory("/tmp");
			const ctxB = makeCtx(smB);
			await fireBeforeAgentStart(pi, ctxB, ["read"]);

			// A crosses: the hint must still fire — i.e. B's `before_agent_start`
			// did not clear A's per-session gate.
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(
				pi.sendMessageCalls.length,
				1,
				"a sibling session's before_agent_start must not clear A's hint gate",
			);

			// Re-arm the shared tracker, then flip the shared fallback back on.
			ctx.setContextUsage(usageAt(10));
			fireTurnEnd(pi, ctx);
			await fireBeforeAgentStart(pi, ctx, [TOOL_NAME, "read"]);

			// B's own false gate must be honored (not silently fall back to the
			// shared true): B stays silent, must not spend the crossing, and A
			// must still fire after it.
			ctxB.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctxB);
			assert.equal(ctxB.notifyCalls.length, 0);
			assert.equal(pi.sendMessageCalls.length, 1);

			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 2);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("no-ops on missing/percent-null/zero-window usage without spending the crossing", async () => {
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			ctx.setContextUsage(undefined);
			fireTurnEnd(pi, ctx);
			ctx.setContextUsage({
				tokens: null,
				contextWindow: 1_000_000,
				percent: null,
			});
			fireTurnEnd(pi, ctx);
			ctx.setContextUsage({ tokens: 100, contextWindow: 0, percent: 95 });
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);

			// The crossing is still unspent — the first valid observation fires.
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("no-ops on tokens-null usage even when percent is set", async () => {
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			// A 50k window under the 100k reserve: without the tokens guard,
			// `contextWindow - null` (50k) would read as inside the reserve.
			ctx.setContextUsage({
				tokens: null,
				contextWindow: 50_000,
				percent: 99,
			});
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("fires on an overrun window (tokens > contextWindow) with 0.0k left", async () => {
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			ctx.setContextUsage({
				tokens: 1_050_000,
				contextWindow: 1_000_000,
				percent: 105,
			});
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			assert.equal(
				(pi.sendMessageCalls[0][0] as { content: string }).content,
				"[navigate_tree hint] Context is at 105.0% of 1.0M — 0.0k tokens left, within the 100.0k reserve. Persist what matters to files now, then rewind to the oldest appropriate anchor.\nActive anchors (root → leaf, % of 1.0M):\n   0.0%  start",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a spent crossing skips the anchor walk entirely", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);

			const calls = { getEntries: 0, getBranch: 0, getLabel: 0 };
			const target = sm as unknown as Record<keyof typeof calls, (...args: unknown[]) => unknown>;
			const originals = { ...calls } as unknown as typeof target;
			for (const name of Object.keys(calls) as Array<keyof typeof calls>) {
				const original = target[name].bind(sm);
				originals[name] = target[name];
				target[name] = (...args: unknown[]) => {
					calls[name]++;
					return original(...args);
				};
			}
			try {
				fireTurnEnd(pi, ctx);
				fireTurnEnd(pi, ctx);
			} finally {
				Object.assign(target, originals);
			}
			assert.equal(pi.sendMessageCalls.length, 1);
			// The hint's anchor walk reads every branch entry's label; the
			// admission estimate that precedes it reads entries only.
			assert.equal(calls.getLabel, 0);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("fires once per crossing and re-arms only after a drop below the bar", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 800_000 }));
			const { sm, pi, ctx } = setup();
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(19));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);

			ctx.setContextUsage(usageAt(20));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);

			ctx.setContextUsage(usageAt(45));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1, "spent crossing must not re-fire");

			ctx.setContextUsage(usageAt(12));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1, "re-arming alone must not fire");

			ctx.setContextUsage(usageAt(21));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 2);
			assert.deepEqual(pi.sendMessageCalls[1], [
				{
					customType: REWIND_HINT_CUSTOM_TYPE,
					content: expectedHint(21, undefined, 800_000),
					display: true,
				},
			]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("with no anchors: TUI notify with the exact copy, no model message", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, ENABLED_CONFIG);
			const { pi, ctx } = setup();
			// Deliberately NO anchor.
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, [[buildNoAnchorText(95, 1_000_000), "warning"]]);

			// Spent: no second toast while still above.
			fireTurnEnd(pi, ctx);
			assert.equal(ctx.notifyCalls.length, 1);

			// Drop + re-cross re-arms.
			ctx.setContextUsage(usageAt(10));
			fireTurnEnd(pi, ctx);
			ctx.setContextUsage(usageAt(96));
			fireTurnEnd(pi, ctx);
			assert.equal(ctx.notifyCalls.length, 2);
			assert.deepEqual(ctx.notifyCalls[1], [buildNoAnchorText(96, 1_000_000), "warning"]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("lists only names rewindTo accepts", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, ENABLED_CONFIG);
			const { sm, pi, ctx } = setup();
			const t0 = appendTurn(sm, "u-empty", "a-empty");
			pi.pi.setLabel(t0.assistantId, "anchor:");
			const t1 = appendTurn(sm, "u-upper", "a-upper");
			pi.pi.setLabel(t1.assistantId, "anchor:Foo");
			anchorStart(sm, pi);
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			const text = String((pi.sendMessageCalls[0][0] as { content: unknown }).content);
			assert.match(text, /\nActive anchors \(root → leaf, % of 1\.0M\):\n +[\d.]+% {2}start$/);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("an empty-named manual label alone counts as no anchors", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, ENABLED_CONFIG);
			const { sm, pi, ctx } = setup();
			// `anchor:` is not a valid `rewindTo`, so the model must not be
			// pointed at it.
			const t = appendTurn(sm, "u-empty", "a-empty");
			pi.pi.setLabel(t.assistantId, "anchor:");
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, [[buildNoAnchorText(95, 1_000_000), "warning"]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("with no anchors and no UI: silent", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, ENABLED_CONFIG);
			const { pi, ctx } = setup();
			ctx.hasUI = false;
			await runSessionStart(pi, ctx, fixture);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("sendMessage throw falls back to appendCustomMessageEntry(customType, text, true)", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			const appendCalls: unknown[][] = [];
			(
				sm as unknown as {
					appendCustomMessageEntry: (...args: unknown[]) => string;
				}
			).appendCustomMessageEntry = (...args: unknown[]) => {
				appendCalls.push(args);
				return "custom-id";
			};
			(pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
				throw new Error("stale session runtime");
			};

			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.deepEqual(appendCalls, [[REWIND_HINT_CUSTOM_TYPE, expectedHint(95), true]]);
			assert.deepEqual(ctx.notifyCalls, [], "a successful fallback must not warn");

			// The crossing is spent even on the fallback path.
			ctx.setContextUsage(usageAt(96));
			fireTurnEnd(pi, ctx);
			assert.equal(appendCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("sendMessage + append double throw: warns with the exact copy, never throws", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			(
				sm as unknown as {
					appendCustomMessageEntry: (...args: unknown[]) => string;
				}
			).appendCustomMessageEntry = () => {
				throw new Error("append exploded");
			};
			(pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
				throw new Error("stale session runtime");
			};

			ctx.setContextUsage(usageAt(95));
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
			assert.deepEqual(ctx.notifyCalls, [
				[`${TOOL_NAME}: could not deliver the rewind hint (append exploded).`, "warning"],
			]);

			// The crossing is spent even on the double-failure path.
			fireTurnEnd(pi, ctx);
			assert.equal(ctx.notifyCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("double throw with no UI: silent, no throw, crossing spent", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			ctx.hasUI = false;
			let sendAttempts = 0;
			(
				sm as unknown as {
					appendCustomMessageEntry: (...args: unknown[]) => string;
				}
			).appendCustomMessageEntry = () => {
				throw new Error("append exploded");
			};
			(pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
				sendAttempts += 1;
				throw new Error("stale session runtime");
			};

			ctx.setContextUsage(usageAt(95));
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
			assert.equal(sendAttempts, 1);
			assert.deepEqual(ctx.notifyCalls, []);

			// The crossing is spent even on the double-failure path.
			fireTurnEnd(pi, ctx);
			assert.equal(sendAttempts, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a throwing ui.notify in the double-failure path cannot escape", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			(
				sm as unknown as {
					appendCustomMessageEntry: (...args: unknown[]) => string;
				}
			).appendCustomMessageEntry = () => {
				throw new Error("append exploded");
			};
			(pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
				throw new Error("stale session runtime");
			};
			let notifyAttempts = 0;
			ctx.ui.notify = () => {
				notifyAttempts += 1;
				throw new Error("notify exploded");
			};

			ctx.setContextUsage(usageAt(95));
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
			assert.equal(notifyAttempts, 1);

			// The crossing is spent even when the warning itself fails.
			fireTurnEnd(pi, ctx);
			assert.equal(notifyAttempts, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("captures sessionManager before sendMessage (post-throw ctx reads fail)", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			const appendCalls: unknown[][] = [];
			(
				sm as unknown as {
					appendCustomMessageEntry: (...args: unknown[]) => string;
				}
			).appendCustomMessageEntry = (...args: unknown[]) => {
				appendCalls.push(args);
				return "custom-id";
			};
			(pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
				throw new Error("stale session runtime");
			};

			// `sessionManager` serves exactly one read (the capture); a second
			// read is the stale-getter failure the fix must not depend on.
			let reads = 0;
			const proxyCtx = {
				get sessionManager(): SessionManager {
					reads += 1;
					if (reads > 1) throw new Error("stale session runtime");
					return sm;
				},
				getContextUsage: ctx.getContextUsage,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
			} as unknown as FakeCtx;

			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, proxyCtx);
			assert.equal(reads, 1, "sessionManager must be read exactly once");
			assert.deepEqual(appendCalls, [[REWIND_HINT_CUSTOM_TYPE, expectedHint(95), true]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a throwing anchor collection leaves the crossing unspent for a retry", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			const originalGetBranch = sm.getBranch;
			(sm as unknown as { getBranch: () => never }).getBranch = () => {
				throw new Error("getBranch exploded");
			};
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);

			(sm as unknown as { getBranch: typeof originalGetBranch }).getBranch = originalGetBranch;
			fireTurnEnd(pi, ctx);
			assert.equal(
				pi.sendMessageCalls.length,
				1,
				"a successful retry must still fire the crossing",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a throwing getEntries leaves the crossing unspent for a retry", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			const originalGetEntries = sm.getEntries;
			(sm as unknown as { getEntries: () => never }).getEntries = () => {
				throw new Error("getEntries exploded");
			};
			ctx.setContextUsage(usageAt(95));
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
			assert.equal(pi.sendMessageCalls.length, 0);

			(sm as unknown as { getEntries: typeof originalGetEntries }).getEntries = originalGetEntries;
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("the fired custom message is projected by the existing context handler", async () => {
		const { fixture, sm, pi, ctx } = await enabledSetup();
		try {
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);

			// pi's runtime persists a sent custom message as a `custom_message`
			// entry via `appendCustomMessageEntry`; emulate that write, then run
			// the extension's own `context` projection and assert the hint text
			// survives (no customType filtering in `buildContextMessages`).
			const text = expectedHint(95);
			sm.appendCustomMessageEntry(REWIND_HINT_CUSTOM_TYPE, text, true);
			const contextHandlers = pi.onCalls.get("context");
			assert.ok(contextHandlers, "factory must register a context handler");
			const projected = contextHandlers[0](
				{ type: "context", messages: [] } as never,
				{ sessionManager: sm } as never,
			) as { messages: unknown[] };
			assert.ok(
				JSON.stringify(projected.messages).includes(JSON.stringify(text).slice(1, -1)),
				"the rewind hint custom_message must survive the context projection",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("fails open when selectedTools is undefined (gate stays on)", async () => {
		// Complement to the earlier "tool inactive" case: an undefined
		// `selectedTools` (the fail-open branch) must leave the gate ON.
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			await fireBeforeAgentStart(pi, ctx, undefined);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("fires while TOOL_NAME is in the selected set", async () => {
		const { fixture, pi, ctx } = await enabledSetup();
		try {
			await fireBeforeAgentStart(pi, ctx, ["read", TOOL_NAME]);
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});

// =============================================================================
// automatic start anchor (#55)
//
// The extension writes a silent `anchor:start` label at the X-th turn of the
// agent run (config `anchorStartAfterTurns`, default 2), or at the run's end
// when the run finishes earlier. Per-session state (settle marker, config
// value, tool-active gate) is keyed by session id; the `findLabeledEntry`
// existence check on the active branch is authoritative. These tests drive
// the real session_start / turn_end / agent_end handlers against temp config
// fixtures (real loader, real fs) and in-memory SessionManagers. No LLM is
// involved.
// =============================================================================

describe("rewind hint: suppressed on turns a rewind owns (#80)", () => {
	/** Hint `sendMessage` calls (the only kind this extension makes). */
	function hintCalls(pi: FakePi): unknown[][] {
		return pi.sendMessageCalls.filter(
			(args) =>
				(args[0] as { customType?: string } | undefined)?.customType === REWIND_HINT_CUSTOM_TYPE,
		);
	}

	it("skips the turn that runs the rewind's fold; the crossing fires on the next normal turn", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 100_000 }));
			const f = setup();
			setupRewindable(f.sm, f.pi, { capture: true });
			await runSessionStart(f.pi, f.ctx, fixture);
			f.ctx.setContextUsage(usageAt(95));

			await requestRewind(f);
			assert.equal(rewindMessages(f.pi)[0].message.details.status, "done");
			assert.equal(hintCalls(f.pi).length, 0, "the rewind call's turn");

			// The crossing stayed unspent: the next normal turn fires it once.
			// The fold replaced the measured context, so pi measures it again.
			f.ctx.setContextUsage(usageAt(95));
			const next = assistantMessage([{ type: "text", text: "next" }], "stop");
			f.sm.appendMessage(next as never);
			const boundary = await fireTurnEndAll(f.pi, f.ctx, next);
			assert.deepEqual(boundary, { entries: [], continue: false });
			assert.deepEqual(hintCalls(f.pi), [
				[
					{
						customType: REWIND_HINT_CUSTOM_TYPE,
						content: expectedHint(
							95,
							"Active anchors (root → leaf, % of 1.0M):\n   0.6%  start\n   0.6%  end",
						),
						display: true,
					},
				],
			]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("the start anchor skips the turn that runs the rewind's fold (#90)", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ rewindHintReserveTokens: 100_000 }));
			const f = setup();
			// Anchor `a`, not `start`: the auto start anchor must be the writer.
			setupRewindable(f.sm, f.pi, { capture: true, rewindToName: "a" });
			await runSessionStart(f.pi, f.ctx, fixture);
			assert.deepEqual(f.ctx.notifyCalls, []);
			f.ctx.setContextUsage(usageAt(95));
			// The turn is the default X=2: the anchor would be written here.
			await requestRewind(f, { ...REWIND_ARGS, rewindTo: "a" }, "tc-rewind", undefined, {
				turnIndex: 1,
			});
			assert.equal(rewindMessages(f.pi)[0].message.details.status, "done");
			assert.equal(hintCalls(f.pi).length, 0);
			assert.ok(
				!f.sm.getEntries().some((e) => e.type === "label" && e.label === START_ANCHOR_LABEL),
				"never on a turn whose work is about to be folded away",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});

describe("rewind hint: per-model modelOverrides (#86)", () => {
	const SONNET = "claude/claude-sonnet-4-5";

	async function overrideSetup(config: unknown): Promise<{
		fixture: ConfigFixture;
		pi: FakePi;
		ctx: FakeCtx;
	}> {
		const fixture = makeConfigFixture();
		writeGlobalConfig(fixture, JSON.stringify(config));
		const { sm, pi, ctx } = setup();
		anchorStart(sm, pi);
		await runSessionStart(pi, ctx, fixture);
		return { fixture, pi, ctx };
	}

	it("a matching entry overrides the base reserve", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 20_000,
			modelOverrides: { [SONNET]: { rewindHintReserveTokens: 100_000 } },
		});
		try {
			// 92% of 1M = 80k left: inside the 100k entry, outside the 20k base.
			ctx.setContextUsage(usageAt(92));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			assert.match(
				String((pi.sendMessageCalls[0][0] as { content: unknown }).content),
				/within the 100\.0k reserve/,
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("an off entry disables the hint for that model only", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 100_000,
			modelOverrides: { [SONNET]: { rewindHintReserveTokens: "off" } },
		});
		try {
			ctx.setContextUsage(usageAt(99));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			// Switching to an unmatched model falls back to the base reserve.
			ctx.model = { api: "openai", provider: "x", id: "other" };
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			assert.match(
				String((pi.sendMessageCalls[0][0] as { content: unknown }).content),
				/within the 100\.0k reserve/,
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("an entry enables a model while the base is off", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			modelOverrides: { [SONNET]: { rewindHintReserveTokens: 100_000 } },
		});
		try {
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			// An unmatched model gets no hint (base off), but its turns still
			// observe the climb back out, so the next crossing fires again.
			ctx.model = { api: "openai", provider: "x", id: "other" };
			ctx.setContextUsage(usageAt(96));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			ctx.setContextUsage(usageAt(10));
			fireTurnEnd(pi, ctx);
			ctx.model = {
				api: "anthropic",
				provider: "claude",
				id: "claude-sonnet-4-5",
			};
			ctx.setContextUsage(usageAt(96));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 2);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a model switch re-reads the reserve on the next turn", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 20_000,
			modelOverrides: { "x/big": { rewindHintReserveTokens: 100_000 } },
		});
		try {
			// 80k left: outside the 20k base for the default model.
			ctx.setContextUsage(usageAt(92));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			ctx.model = { api: "openai", provider: "x", id: "big" };
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("no model falls back to the base reserve", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 100_000,
			modelOverrides: { [SONNET]: { rewindHintReserveTokens: "off" } },
		});
		try {
			ctx.model = undefined;
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("a throwing ctx.model getter skips the turn without spending the crossing", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 100_000,
			modelOverrides: { "x/y": { rewindHintReserveTokens: 50_000 } },
		});
		try {
			const live = ctx.model;
			Object.defineProperty(ctx, "model", {
				configurable: true,
				get() {
					throw new Error("stale ctx");
				},
			});
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 0);
			Object.defineProperty(ctx, "model", {
				configurable: true,
				writable: true,
				value: live,
			});
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("without modelOverrides, ctx.model is never read", async () => {
		const { fixture, pi, ctx } = await overrideSetup({
			rewindHintReserveTokens: 100_000,
		});
		try {
			let reads = 0;
			const live = ctx.model;
			Object.defineProperty(ctx, "model", {
				configurable: true,
				get() {
					reads++;
					return live;
				},
			});
			ctx.setContextUsage(usageAt(95));
			fireTurnEnd(pi, ctx);
			assert.equal(pi.sendMessageCalls.length, 1);
			assert.equal(reads, 0);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});
