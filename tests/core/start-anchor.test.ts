/** Extension start anchor tests. */
import { afterEach, beforeEach, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	START_ANCHOR_DEFAULT_TURNS,
	START_ANCHOR_MAX_TURNS,
	START_ANCHOR_MIN_TURNS,
} from "../../src/core/config.ts";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import { START_ANCHOR_LABEL } from "../../src/fold/fold-policy.ts";
import navigateTree, { __testHooks } from "../../src/index.ts";
import {
	cleanupConfigFixture,
	fireBeforeAgentStart,
	fireTurnEnd,
	makeConfigFixture,
	projectConfigPath,
	runSessionStart,
	writeGlobalConfig,
	writeProjectConfig,
} from "../support/config-fixtures.ts";
import {
	type FakeCtx,
	type FakePi,
	makeCtx,
	makeFakePi,
	setup,
} from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { appendTurn } from "../support/session-messages.ts";

installHarnessHooks();

/** Fire the captured `agent_end` handler (run-end fallback). */
function fireAgentEnd(pi: FakePi, ctx: FakeCtx): void {
	const handlers = pi.onCalls.get("agent_end");
	assert.ok(handlers, "factory must register an agent_end handler");
	assert.equal(handlers.length, 1);
	handlers[0]({ type: "agent_end", messages: [] } as never, ctx as never);
}

describe("automatic start anchor (#55)", () => {
	const ENV_KEY = "PI_NAVIGATE_TREE_START_ANCHOR";
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = savedEnv;
		savedEnv = undefined;
	});

	it("registers exactly one agent_end handler", () => {
		const { pi } = setup();
		const handlers = pi.onCalls.get("agent_end");
		assert.ok(handlers, "factory must register an agent_end handler");
		assert.equal(handlers.length, 1);
	});

	it("defaults to X=2 with no config: silent write at the 2nd turn, no model message, no UI", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, [], "absent config must not warn");

			appendTurn(sm, "u1", "a1");
			const leaf1 = sm.getLeafId();
			fireTurnEnd(pi, ctx, 0); // turn 1: below X
			assert.equal(pi.setLabelCalls.length, 0);
			assert.equal(sm.getLabel(leaf1 as string), undefined);

			appendTurn(sm, "u2", "a2");
			const leaf2 = sm.getLeafId();
			fireTurnEnd(pi, ctx, 1); // turn 2: triggers
			assert.equal(pi.setLabelCalls.length, 1);
			assert.deepEqual(pi.setLabelCalls[0], [leaf2, START_ANCHOR_LABEL]);
			assert.equal(sm.getLabel(leaf2 as string), START_ANCHOR_LABEL);
			assert.equal(__testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL), leaf2);
			// Silent: label entry only — no model message, no UI.
			assert.equal(pi.sendMessageCalls.length, 0);
			assert.deepEqual(ctx.notifyCalls, []);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("honors a configured X and anchors the X-th turn's persisted tail", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 3 }));
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);

			appendTurn(sm, "u1", "a1");
			fireTurnEnd(pi, ctx, 0);
			assert.equal(pi.setLabelCalls.length, 0, "turn 1 must not fire at X=3");
			appendTurn(sm, "u2", "a2");
			fireTurnEnd(pi, ctx, 1);
			assert.equal(pi.setLabelCalls.length, 0, "turn 2 must not fire at X=3");
			appendTurn(sm, "u3", "a3");
			const leaf = sm.getLeafId();
			fireTurnEnd(pi, ctx, 2);
			assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("project X overrides global when trusted; an untrusted project is ignored", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 5 }));
			writeProjectConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 2 }));

			// Trusted: project 2 fires at the 2nd turn.
			{
				const { sm, pi, ctx } = setup();
				ctx.cwd = fixture.projectDir;
				ctx.isProjectTrusted = () => true;
				await runSessionStart(pi, ctx, fixture);
				appendTurn(sm, "u1", "a1");
				appendTurn(sm, "u2", "a2");
				fireTurnEnd(pi, ctx, 1);
				assert.equal(pi.setLabelCalls.length, 1);
			}

			// Untrusted: global 5 applies; the 2nd turn must not fire.
			{
				const { sm, pi, ctx } = setup();
				ctx.cwd = fixture.projectDir;
				await runSessionStart(pi, ctx, fixture);
				appendTurn(sm, "u1", "a1");
				appendTurn(sm, "u2", "a2");
				fireTurnEnd(pi, ctx, 1);
				assert.equal(pi.setLabelCalls.length, 0);
			}
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("invalid project X warns and falls through to the valid global layer", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 3 }));
			writeProjectConfig(fixture, JSON.stringify({ anchorStartAfterTurns: "nope" }));
			const { sm, pi, ctx } = setup();
			ctx.cwd = fixture.projectDir;
			ctx.isProjectTrusted = () => true;
			await runSessionStart(pi, ctx, fixture);
			assert.deepEqual(ctx.notifyCalls, [
				[
					`navigate_tree: invalid anchorStartAfterTurns in project config at ${projectConfigPath(fixture)} — expected integer ${START_ANCHOR_MIN_TURNS}-${START_ANCHOR_MAX_TURNS}; falling back to the other layer's valid value, else the default ${START_ANCHOR_DEFAULT_TURNS}.`,
					"warning",
				],
			]);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const leaf = sm.getLeafId();
			fireTurnEnd(pi, ctx, 2); // global X=3
			assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("loads the field for all five session_start reasons", async () => {
		const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
		for (const reason of reasons) {
			const fixture = makeConfigFixture();
			try {
				writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 4 }));
				const { sm, pi, ctx } = setup();
				await runSessionStart(pi, ctx, fixture, reason);
				assert.deepEqual(ctx.notifyCalls, [], `${reason}: valid config must not warn`);
				for (let i = 0; i < 3; i++) {
					appendTurn(sm, `u${i}`, `a${i}`);
					fireTurnEnd(pi, ctx, i);
				}
				assert.equal(pi.setLabelCalls.length, 0, `${reason}: below X`);
				appendTurn(sm, "u4", "a4");
				fireTurnEnd(pi, ctx, 3);
				assert.equal(pi.setLabelCalls.length, 1, `${reason}: X-th turn writes`);
			} finally {
				cleanupConfigFixture(fixture);
			}
		}
	});

	it("agent_end fallback settles a run shorter than X at the run's end", async () => {
		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 5 }));
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			fireTurnEnd(pi, ctx, 0);
			appendTurn(sm, "u2", "a2");
			fireTurnEnd(pi, ctx, 1);
			const leaf = sm.getLeafId();
			assert.equal(pi.setLabelCalls.length, 0);
			fireAgentEnd(pi, ctx);
			assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
			assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("agent_end after a run with no turns anchors the last persisted entry (user message)", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			const userId = sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "only a user message" }],
			} as never);
			fireAgentEnd(pi, ctx);
			assert.deepEqual(pi.setLabelCalls, [[userId, START_ANCHOR_LABEL]]);
			assert.equal(sm.getLabel(userId), START_ANCHOR_LABEL);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("settles after the first write: later turns and a second agent run never re-insert", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const firstLeaf = sm.getLeafId();
			fireTurnEnd(pi, ctx, 1);
			assert.equal(pi.setLabelCalls.length, 1);
			fireAgentEnd(pi, ctx); // same run's end: settled, no-op
			appendTurn(sm, "u3", "a3");
			fireTurnEnd(pi, ctx, 1); // second run's 2nd turn: no-op
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 1, "must never re-insert");
			assert.equal(
				__testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL),
				firstLeaf,
				"the original label target must not move",
			);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("an existing anchor:start wins (manual /tree label): skip + settle, never write", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			const t = appendTurn(sm, "u1", "a1");
			pi.pi.setLabel(t.assistantId, START_ANCHOR_LABEL);
			appendTurn(sm, "u2", "a2");
			const writesBefore = pi.setLabelCalls.length;
			fireTurnEnd(pi, ctx, 1);
			fireAgentEnd(pi, ctx);
			appendTurn(sm, "u3", "a3");
			fireTurnEnd(pi, ctx, 1);
			assert.equal(
				pi.setLabelCalls.length,
				writesBefore,
				"an existing label must settle the session without a write",
			);
			assert.equal(sm.getLabel(t.assistantId), START_ANCHOR_LABEL);
			assert.equal(__testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL), t.assistantId);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("toolActive gate: inactive tool skips; reactivated tool writes", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			await fireBeforeAgentStart(pi, ctx, ["read"]);
			fireTurnEnd(pi, ctx, 1);
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 0);
			await fireBeforeAgentStart(pi, ctx, ["read", TOOL_NAME]);
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("kill switch is read at write time: =0 skips both triggers; unset retries", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const leaf = sm.getLeafId();
			process.env[ENV_KEY] = "0";
			fireTurnEnd(pi, ctx, 1);
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 0, "kill switch must suppress both triggers");
			delete process.env[ENV_KEY];
			// A skipped settle left the session unsettled: the next trigger retries.
			fireAgentEnd(pi, ctx);
			assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("setLabel throw falls back to appendLabelChange(leafId, 'anchor:start') and settles", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const leaf = sm.getLeafId();
			const appendCalls: unknown[][] = [];
			const origAppend = sm.appendLabelChange.bind(sm);
			(
				sm as unknown as {
					appendLabelChange: (...args: unknown[]) => string;
				}
			).appendLabelChange = (...args: unknown[]) => {
				appendCalls.push(args);
				return origAppend(args[0] as string, args[1] as string | undefined);
			};
			(pi.pi as unknown as { setLabel: (...args: unknown[]) => void }).setLabel = () => {
				throw new Error("stale session runtime");
			};
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
			assert.deepEqual(appendCalls, [[leaf, START_ANCHOR_LABEL]]);
			assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
			// Settled via the fallback: later triggers are no-ops.
			fireTurnEnd(pi, ctx, 1);
			fireAgentEnd(pi, ctx);
			assert.equal(appendCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("double write failure stays fail-open and unsettled for the next retry", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const origSetLabel = pi.pi.setLabel.bind(pi.pi);
			const origAppend = sm.appendLabelChange.bind(sm);
			(pi.pi as unknown as { setLabel: (...args: unknown[]) => void }).setLabel = () => {
				throw new Error("stale session runtime");
			};
			(
				sm as unknown as {
					appendLabelChange: (...args: unknown[]) => string;
				}
			).appendLabelChange = () => {
				throw new Error("append exploded");
			};
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
			assert.equal(pi.setLabelCalls.length, 0);
			// Restore both: the unsettled session retries and succeeds at the
			// run end.
			(pi.pi as unknown as { setLabel: typeof pi.pi.setLabel }).setLabel = origSetLabel;
			(sm as unknown as { appendLabelChange: typeof sm.appendLabelChange }).appendLabelChange =
				origAppend;
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("existence-check read failure leaves the session unsettled (retries later)", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const origGetBranch = sm.getBranch.bind(sm);
			let armed = true;
			(sm as unknown as { getBranch: () => unknown }).getBranch = () => {
				if (armed) throw new Error("getBranch boom");
				return origGetBranch();
			};
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
			assert.equal(pi.setLabelCalls.length, 0);
			armed = false;
			fireAgentEnd(pi, ctx);
			assert.equal(pi.setLabelCalls.length, 1);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("setLabel throw with a missing appendLabelChange stays unsettled and retries", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const leaf = sm.getLeafId();
			const origSetLabel = pi.pi.setLabel.bind(pi.pi);
			const origAppend = sm.appendLabelChange.bind(sm);
			(pi.pi as unknown as { setLabel: (...args: unknown[]) => void }).setLabel = () => {
				throw new Error("stale session runtime");
			};
			(sm as unknown as { appendLabelChange: unknown }).appendLabelChange = undefined;
			// A missing fallback method is NOT a successful write: no label, no
			// settle, and nothing throws into the loop.
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
			assert.equal(sm.getLabel(leaf as string), undefined, "no write may be recorded");
			// Restore both: the still-unsettled session retries at the run end.
			(pi.pi as unknown as { setLabel: typeof pi.pi.setLabel }).setLabel = origSetLabel;
			(sm as unknown as { appendLabelChange: typeof sm.appendLabelChange }).appendLabelChange =
				origAppend;
			fireAgentEnd(pi, ctx);
			assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("appendLabelChange fallback preserves the method receiver (this === SessionManager)", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			const leaf = sm.getLeafId();
			const origAppend = sm.appendLabelChange.bind(sm);
			// Prototype-style method that needs its receiver: an unbound
			// `append(...)` call loses `this` and throws instead of writing.
			(
				sm as unknown as {
					appendLabelChange: (entryId: string, label: string | undefined) => string;
				}
			).appendLabelChange = function (this: unknown, entryId: string, label: string | undefined) {
				if (this !== sm) {
					throw new Error("appendLabelChange lost its receiver");
				}
				return origAppend(entryId, label);
			};
			(pi.pi as unknown as { setLabel: (...args: unknown[]) => void }).setLabel = () => {
				throw new Error("stale session runtime");
			};
			assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
			assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("per-session config: a later session_start must not retune an earlier session", async () => {
		const fixtureA = makeConfigFixture();
		const fixtureB = makeConfigFixture();
		try {
			writeGlobalConfig(fixtureA, JSON.stringify({ anchorStartAfterTurns: 5 }));
			writeGlobalConfig(fixtureB, JSON.stringify({ anchorStartAfterTurns: 1 }));
			const smA = SessionManager.inMemory("/tmp");
			const smB = SessionManager.inMemory("/tmp");
			const pi = makeFakePi(smA);
			navigateTree(pi.pi);
			const ctxA = makeCtx(smA);
			const ctxB = makeCtx(smB);
			const writes: Array<[string, string | undefined]> = [];
			let target = smA;
			(
				pi.pi as unknown as {
					setLabel: (entryId: string, label: string | undefined) => void;
				}
			).setLabel = (entryId, label) => {
				writes.push([entryId, label]);
				target.appendLabelChange(entryId, label);
			};
			// B starts second and loads X=1; A must keep its own X=5.
			await runSessionStart(pi, ctxA, fixtureA);
			await runSessionStart(pi, ctxB, fixtureB);

			appendTurn(smA, "a-u1", "a-a1");
			appendTurn(smA, "a-u2", "a-a2");
			appendTurn(smB, "b-u1", "b-a1");

			fireTurnEnd(pi, ctxA, 1); // A: 2 < 5, no write
			assert.equal(writes.length, 0, "A must keep its X=5");

			target = smB;
			const leafB = smB.getLeafId();
			fireTurnEnd(pi, ctxB, 0); // B: 1 >= 1, writes at its first turn
			assert.deepEqual(writes, [[leafB, START_ANCHOR_LABEL]]);
			assert.equal(
				__testHooks.findLabeledEntry(smA, START_ANCHOR_LABEL),
				null,
				"A must stay unanchored",
			);
		} finally {
			cleanupConfigFixture(fixtureA);
			cleanupConfigFixture(fixtureB);
		}
	});

	it("per-session toolActive: a sibling session's inactive gate must not suppress this one", async () => {
		const fixture = makeConfigFixture();
		try {
			const smA = SessionManager.inMemory("/tmp");
			const smB = SessionManager.inMemory("/tmp");
			const pi = makeFakePi(smA);
			navigateTree(pi.pi);
			const ctxA = makeCtx(smA);
			const ctxB = makeCtx(smB);
			const writes: Array<[string, string | undefined]> = [];
			let target = smA;
			(
				pi.pi as unknown as {
					setLabel: (entryId: string, label: string | undefined) => void;
				}
			).setLabel = (entryId, label) => {
				writes.push([entryId, label]);
				target.appendLabelChange(entryId, label);
			};
			await runSessionStart(pi, ctxA, fixture);
			await runSessionStart(pi, ctxB, fixture);
			appendTurn(smA, "a-u1", "a-a1");
			appendTurn(smA, "a-u2", "a-a2");
			appendTurn(smB, "b-u1", "b-a1");
			appendTurn(smB, "b-u2", "b-a2");

			// A has the tool active; B is a restricted sibling session.
			await fireBeforeAgentStart(pi, ctxA, ["read", TOOL_NAME]);
			await fireBeforeAgentStart(pi, ctxB, ["read"]);

			target = smA;
			fireTurnEnd(pi, ctxA, 1);
			assert.equal(writes.length, 1, "A must write despite B's inactive gate");
			target = smB;
			fireTurnEnd(pi, ctxB, 1);
			assert.equal(writes.length, 1, "B must stay gated");
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("per-session keying: interleaved sessions settle independently", async () => {
		const fixture = makeConfigFixture();
		try {
			const smA = SessionManager.inMemory("/tmp");
			const smB = SessionManager.inMemory("/tmp");
			const pi = makeFakePi(smA);
			navigateTree(pi.pi);
			const ctxA = makeCtx(smA);
			const ctxB = makeCtx(smB);
			const writes: Array<[string, string | undefined]> = [];
			let target = smA;
			(
				pi.pi as unknown as {
					setLabel: (entryId: string, label: string | undefined) => void;
				}
			).setLabel = (entryId, label) => {
				writes.push([entryId, label]);
				target.appendLabelChange(entryId, label);
			};
			await runSessionStart(pi, ctxA, fixture);
			await runSessionStart(pi, ctxB, fixture);

			appendTurn(smA, "a-u1", "a-a1");
			appendTurn(smB, "b-u1", "b-a1");
			appendTurn(smA, "a-u2", "a-a2");
			appendTurn(smB, "b-u2", "b-a2");

			// B settles first; that must not suppress A's independent settle.
			target = smB;
			fireTurnEnd(pi, ctxB, 1);
			assert.equal(writes.length, 1);
			target = smA;
			fireTurnEnd(pi, ctxA, 1);
			assert.equal(writes.length, 2);

			// Both settled: interleaved re-fires are no-ops.
			fireTurnEnd(pi, ctxB, 1);
			fireTurnEnd(pi, ctxA, 1);
			fireAgentEnd(pi, ctxB);
			fireAgentEnd(pi, ctxA);
			assert.equal(writes.length, 2);
			assert.ok(__testHooks.findLabeledEntry(smA, START_ANCHOR_LABEL));
			assert.ok(__testHooks.findLabeledEntry(smB, START_ANCHOR_LABEL));
		} finally {
			cleanupConfigFixture(fixture);
		}
	});

	it("anchor(name='start') is refused when the automatic label exists (reservation moot)", async () => {
		const fixture = makeConfigFixture();
		try {
			const { sm, pi, tool, ctx } = setup();
			await runSessionStart(pi, ctx, fixture);
			appendTurn(sm, "u1", "a1");
			appendTurn(sm, "u2", "a2");
			fireTurnEnd(pi, ctx, 1);
			assert.equal(pi.setLabelCalls.length, 1);
			appendTurn(sm, "u3", "a3");
			const result = await tool.execute(
				"tc-1",
				{ action: "anchor", name: "start" },
				undefined,
				undefined,
				ctx,
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /A label 'start' already exists on the active branch/);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});
