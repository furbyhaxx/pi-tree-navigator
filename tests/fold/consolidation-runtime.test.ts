/** Extension consolidation runtime tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { CONSOLIDATION_CUSTOM_TYPE } from "../../src/index.ts";
import { fireTurnEndAll } from "../support/boundary-drivers.ts";
import {
	cleanupConfigFixture,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "../support/config-fixtures.ts";
import { makeCtx, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { appendTurn } from "../support/session-messages.ts";

installHarnessHooks();

describe("background handoff consolidation", () => {
	/** A finished phase: real work, then the handoff a fold left for it. */
	function phase(sm: SessionManager, n: number): string {
		appendTurn(sm, `phase ${n} request`, `phase ${n} done`, 0, true);
		const leaf = sm.getLeafId();
		assert.ok(leaf);
		return sm.branchWithSummary(
			leaf,
			`## Goal\nPhase ${n} handoff.\n\n${"Delivered evidence. ".repeat(200)}`,
			{},
			true,
		);
	}

	/** `count` handoffs, then a fresh turn whose `turn_end` runs the check. */
	function session(count: number) {
		const f = setup({ contextWindow: 1_000_000 });
		const handoffs = Array.from({ length: count }, (_, i) => phase(f.sm, i + 1));
		const { assistantId } = appendTurn(f.sm, "next request", "working", 0);
		f.pi.pi.setLabel(assistantId, "anchor:after-cut");
		const message = (f.sm.getEntry(assistantId) as { message: unknown }).message;
		return { ...f, handoffs, message };
	}

	const compactions = (sm: SessionManager) =>
		sm.getBranch().filter((entry) => entry.type === "compaction");

	it("merges every handoff before the newest two into one compaction and keeps those two verbatim", async () => {
		const f = session(5);
		await fireTurnEndAll(f.pi, f.ctx, f.message);

		const [compaction] = compactions(f.sm);
		assert.ok(compaction, "a compaction was appended");
		assert.equal(compaction.firstKeptEntryId, f.handoffs[3]);
		assert.equal(compaction.fromHook, true);
		const { consolidation } = (
			compaction.details as {
				navigateTree: { consolidation: { merged: number; trigger: string } };
			}
		).navigateTree;
		assert.equal(consolidation.merged, 3);
		assert.equal(consolidation.trigger, "count");
		assert.ok(f.ctx.registryCalls.length > 0, "an independent side call ran");

		const context = JSON.stringify(f.sm.buildSessionContext().messages);
		for (const n of [4, 5]) assert.ok(context.includes(`Phase ${n} handoff.`));
		for (const n of [1, 2, 3])
			assert.ok(!context.includes(`Phase ${n} handoff.`), `phase ${n} merged`);

		const receipt = f.sm
			.getBranch()
			.find(
				(entry) =>
					entry.type === "custom_message" && entry.customType === CONSOLIDATION_CUSTOM_TYPE,
			);
		assert.ok(receipt, "a visible receipt follows the compaction");
	});

	it("keeps anchors after the cut foldable", async () => {
		const f = session(5);
		await fireTurnEndAll(f.pi, f.ctx, f.message);
		assert.equal(compactions(f.sm).length, 1);
		const ctx = makeCtx(f.sm, { contextWindow: 1_000_000, hasUI: false });
		const command = f.pi.commands.get("anchor");
		assert.ok(command);
		await command.handler("list", ctx as unknown as ExtensionCommandContext);
		const notification = ctx.notifyCalls[0];
		assert.ok(notification);
		const row = notification[0].split("\n").find((line) => line.includes(" after-cut ")) ?? "";
		assert.match(row, /savable$/);
	});

	it("does nothing below the threshold, after an errored turn or when disabled", async () => {
		const below = session(4);
		await fireTurnEndAll(below.pi, below.ctx, below.message);
		assert.equal(compactions(below.sm).length, 0);
		assert.equal(below.ctx.registryCalls.length, 0);

		const errored = session(5);
		await fireTurnEndAll(errored.pi, errored.ctx, {
			...(errored.message as object),
			stopReason: "error",
		});
		assert.equal(compactions(errored.sm).length, 0);

		const fixture = makeConfigFixture();
		try {
			writeGlobalConfig(fixture, JSON.stringify({ consolidation: { enabled: false } }));
			const off = session(5);
			await runSessionStart(off.pi, off.ctx, fixture);
			await fireTurnEndAll(off.pi, off.ctx, off.message);
			assert.equal(compactions(off.sm).length, 0);
			assert.equal(off.ctx.registryCalls.length, 0);
		} finally {
			cleanupConfigFixture(fixture);
		}
	});
});
