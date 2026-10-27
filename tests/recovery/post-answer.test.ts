/** Completed recovery replies must settle without a new model request. */
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { fireTurnEndAll } from "../support/boundary-drivers.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { rewindFixture } from "../support/rewind-fixtures.ts";

installHarnessHooks();

describe("post-recovery answers", () => {
	for (const overWindow of [false, true]) {
		it(`settles a completed reply with stale summary work (over window: ${overWindow})`, async () => {
			const f = await rewindFixture({
				summary: "## Goal\nAudit.\n\n## Next Steps\n1. Report remaining work.",
			});
			assert.ok(f.done);
			f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, "Recovered.", true, {
				...f.done.message.details,
				origin: "recovery",
			});
			const message = fauxAssistantMessage(
				"ACCEPTANCE-CONTINUED. Remaining work is blocked on the next change.",
			);
			assert.ok(f.ctx.model);
			message.provider = f.ctx.model.provider;
			message.model = f.ctx.model.id;
			if (overWindow)
				message.usage = { ...message.usage, input: (f.ctx.model.contextWindow ?? 0) + 1_000 };
			f.sm.appendMessage(message);
			const before = f.sm.getBranch().map((entry) => entry.id);
			const boundary = await fireTurnEndAll(f.pi, f.ctx, message);
			assert.equal(boundary.continue, false);
			assert.deepEqual(boundary.entries, []);
			assert.deepEqual(
				f.sm.getBranch().map((entry) => entry.id),
				before,
			);
		});
	}

	it("still nudges a post-recovery stop that contains no final answer", async () => {
		const f = await rewindFixture({
			summary: "## Goal\nAudit.\n\n## Next Steps\n1. Answer the request.",
		});
		assert.ok(f.done);
		f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, "Recovered.", true, {
			...f.done.message.details,
			origin: "recovery",
		});
		const message = fauxAssistantMessage([{ type: "thinking", thinking: "Need to answer." }]);
		f.sm.appendMessage(message);
		const boundary = await fireTurnEndAll(f.pi, f.ctx, message);
		assert.equal(boundary.continue, true);
		assert.ok(boundary.entries.some((entry) => entry.details["status"] === "continue-nudge"));
	});

	it("still nudges an unfinished milestone after an agent-requested fold", async () => {
		const f = await rewindFixture({
			summary: "## Goal\nAudit.\n\n## Next Steps\n1. Inspect the next partition.",
		});
		const message = fauxAssistantMessage("Milestone report; the next partition remains.");
		f.sm.appendMessage(message);
		const boundary = await fireTurnEndAll(f.pi, f.ctx, message);
		assert.equal(boundary.continue, true);
		assert.ok(boundary.entries.some((entry) => entry.details["status"] === "continue-nudge"));
	});
});
