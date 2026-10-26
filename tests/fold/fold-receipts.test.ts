/** Extension fold receipts tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildRewindAcceptedText,
	buildRewindDoneText,
	CONTINUE_NUDGE_TEXT,
	REWIND_CUSTOM_TYPE,
} from "../../src/fold/fold-receipts.ts";
import { fireTurnEndAll } from "../support/boundary-drivers.ts";
import { fireBeforeAgentStart } from "../support/config-fixtures.ts";
import { type FakeCtx, type FakePi, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { rewindFixture } from "../support/rewind-fixtures.ts";
import { setupRewindable } from "../support/session-fakes.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
} from "../support/session-messages.ts";

function at<T>(xs: readonly T[], index: number): T {
	const value = xs[index];
	assert.ok(value !== undefined, `Expected an element at index ${index}`);
	return value;
}

installHarnessHooks();

describe("rewind: one-time continue nudge after a fold", () => {
	const OPEN_PROGRESS_SUMMARY =
		"## Goal\nShip it.\n\n## Progress\n### Done\n- [x] Parser.\n\n### In Progress\n- [ ] Wire the CLI.\n\n## Next Steps\n(none)";
	const NO_OPEN_SUMMARY =
		"## Goal\nShip it.\n\n## Progress\n### Done\n- [x] Parser.\n\n### In Progress\n- [ ] (none)\n\n## Next Steps\n(none)";

	/** A committed fold: the continuation is on the branch, no turn since. */
	const foldedFixture = (summary = SUMMARY_TEXT) => rewindFixture({ summary });

	/** One post-fold assistant turn, persisted and run through `turn_end`. */
	async function turn(
		f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx },
		content: Array<Record<string, unknown>> = [{ type: "text", text: "Final report." }],
		stopReason = "stop",
		opts: { continue?: boolean; commit?: boolean } = {},
	) {
		const message = assistantMessage(content, stopReason, 100);
		f.sm.appendMessage(message as never);
		const boundary = await fireTurnEndAll(f.pi, f.ctx, message, opts);
		return {
			message,
			boundary,
			nudges: boundary.entries.filter(
				(d) => d.customType === REWIND_CUSTOM_TYPE && d.details?.["status"] === "continue-nudge",
			),
		};
	}

	const userSteer = (sm: SessionManager, text = "also fix the docs") =>
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 1,
		} as never);

	it("nudges once, with continue, when the first post-fold turn is text-only and the summary has open work", async () => {
		const f = await foldedFixture();
		assert.ok(f.done);
		const { boundary, nudges } = await turn(f);
		assert.equal(nudges.length, 1);
		assert.equal(boundary.continue, true);
		assert.equal(at(nudges, 0).content, CONTINUE_NUDGE_TEXT);
		assert.equal(at(nudges, 0).display, true);
		assert.deepEqual(at(nudges, 0).details, {
			status: "continue-nudge",
			summaryId: f.done.message.details["summaryId"],
		});
		const last = f.sm.getBranch().at(-1);
		assert.ok(last && last.type === "custom_message");
		assert.equal(last.content, CONTINUE_NUDGE_TEXT);
		assert.deepEqual(f.pi.sendMessageCalls, [], "a boundary entry, not a send");
	});

	it("a second text-only turn is not nudged again", async () => {
		const f = await foldedFixture();
		assert.equal((await turn(f)).nudges.length, 1);
		const second = await turn(f);
		assert.deepEqual(second.nudges, []);
		assert.equal(second.boundary.continue, false);
	});

	it("is at most once per fold even when pi drops the draft and the same turn ends again", async () => {
		const f = await foldedFixture();
		const message = assistantMessage([{ type: "text", text: "Final report." }], "stop", 100);
		f.sm.appendMessage(message as never);
		const first = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
		assert.equal(first.entries.length, 1);
		const again = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
		assert.deepEqual(again.entries, []);
	});

	it("a new fold is nudged again", async () => {
		const f = await foldedFixture();
		assert.equal((await turn(f)).nudges.length, 1);
		const anchored = appendTurn(f.sm, "u9", "a9", 6_000);
		f.pi.pi.setLabel(anchored.assistantId, "anchor:a2");
		appendTurn(f.sm, "u10", "a10", 30_000, true);
		f.ctx.modelRegistry = fakeRegistry(() =>
			reply("## Goal\nSecond.\n\n## Next Steps\n1. Go on."),
		).registry;
		await requestRewind(
			f,
			{ ...REWIND_ARGS, rewindTo: "a2", newLabel: "end2" },
			"tc-rewind-2",
			50_000,
		);
		const folds = rewindMessages(f.pi).filter((m) => m.message.details["status"] === "done");
		assert.equal(folds.length, 2);
		assert.equal((await turn(f)).nudges.length, 1);
	});

	it("does not nudge when the first post-fold turn calls a tool, nor on a later text-only turn", async () => {
		const f = await foldedFixture();
		const call = appendToolCallAssistant(f.sm, [
			{ id: "tc-work", name: "bash", arguments: { command: "true" } },
		]);
		appendToolResult(f.sm, "tc-work", "bash", "ok");
		const worked = await fireTurnEndAll(f.pi, f.ctx, call.message);
		assert.deepEqual(worked.entries, []);
		assert.deepEqual((await turn(f)).nudges, []);
	});

	it("nudges on an open '### In Progress' item alone; placeholders are not open work", async () => {
		const open = await foldedFixture(OPEN_PROGRESS_SUMMARY);
		assert.equal((await turn(open)).nudges.length, 1);
		const none = await foldedFixture(NO_OPEN_SUMMARY);
		const quiet = await turn(none);
		assert.deepEqual(quiet.nudges, []);
		assert.equal(quiet.boundary.continue, false);
	});

	it("does not nudge after a failed fold", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		f.ctx.modelRegistry = fakeRegistry(() => reply("", "error", "overloaded")).registry;
		await requestRewind(f);
		assert.equal(
			rewindMessages(f.pi).filter((m) => m.message.details["status"] === "done").length,
			0,
		);
		assert.deepEqual((await turn(f)).nudges, []);
	});

	it("does not nudge when a user message sits between the continuation and the turn", async () => {
		const f = await foldedFixture();
		userSteer(f.sm);
		assert.deepEqual((await turn(f)).nudges, []);
	});

	it("does not nudge a fold that re-appended late user input: the turn answers it", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		f.ctx.modelRegistry = fakeRegistry((_call, index) => {
			if (index === 0) userSteer(f.sm, "steer while pending");
			return reply(SUMMARY_TEXT);
		}).registry;
		await requestRewind(f);
		assert.equal(rewindMessages(f.pi).at(-1)?.message.details["reappendedLateMessages"], 1);
		assert.deepEqual((await turn(f)).nudges, []);
	});

	it("does not nudge an error, aborted or cut-off turn", async () => {
		for (const stopReason of ["error", "aborted", "length"]) {
			const f = await foldedFixture();
			assert.deepEqual(
				(await turn(f, [{ type: "text", text: "partial" }], stopReason)).nudges,
				[],
				stopReason,
			);
		}
	});

	it("does not nudge while navigate_tree is out of the active tools", async () => {
		const f = await foldedFixture();
		await fireBeforeAgentStart(f.pi, f.ctx, ["read"]);
		assert.deepEqual((await turn(f)).nudges, []);
	});

	it("leaves a turn another handler already continues alone, and keeps the nudge unspent", async () => {
		const f = await foldedFixture();
		const message = assistantMessage([{ type: "text", text: "Final report." }], "stop", 100);
		f.sm.appendMessage(message as never);
		const owned = await fireTurnEndAll(f.pi, f.ctx, message, {
			continue: true,
			commit: false,
		});
		assert.deepEqual(owned.entries, []);
		const later = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
		assert.equal(later.entries.length, 1);
	});

	it("a headless session is nudged too", async () => {
		const f = await foldedFixture();
		f.ctx.hasUI = false;
		assert.equal((await turn(f)).nudges.length, 1);
	});

	it("renders as one line, expanding to the full text; the continuation keeps pi's default box", async () => {
		const f = await foldedFixture();
		assert.ok(f.done);
		const { nudges } = await turn(f);
		const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (
			...a: unknown[]
		) => { render(w: number): string[] } | undefined;
		assert.ok(renderer);
		const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
		const message = {
			role: "custom",
			customType: REWIND_CUSTOM_TYPE,
			content: at(nudges, 0).content,
			display: true,
			details: at(nudges, 0).details,
			timestamp: 0,
		};
		const row = renderer(message, { expanded: false, outputPad: 1 }, theme);
		assert.deepEqual(row?.render(400), [
			" <customMessageText>[navigate_tree] turn ended right after a rewind · nudged once to continue",
		]);
		const lines = renderer(message, { expanded: true, outputPad: 1 }, theme)?.render(10_000);
		assert.ok(lines?.some((l) => l.includes("not a stop condition")));
		assert.equal(
			renderer(
				{ ...message, details: f.done.message.details },
				{ expanded: false, outputPad: 1 },
				theme,
			),
			undefined,
		);
	});
});

// =============================================================================
// rewind message copy — byte-exact literals (no builder recomputation)
// =============================================================================

describe("rewind message copy (byte-exact)", () => {
	it("buildRewindDoneText", () => {
		assert.equal(
			buildRewindDoneText(
				{
					rewindTo: "start",
					newLabel: "end",
					beforeTokens: 30_000,
					contextWindow: 1_000_000,
				},
				4_000,
			),
			"[rewind to 'start' · collapsed as 'end'] · context 3.0% → 0.4% of 1.0M\n\nA branch_summary of the collapsed work has been appended to your context. It is the newest branch_summary, the current state; earlier branch_summary messages, if present, are older collapsed segments. Items under '### Done' are complete. Items under '### In Progress', '### Blocked', or '## Next Steps' are the resume point: continue the latest branch_summary's work without re-confirming with the user.\n\nA branch_summary marks a milestone, not the end of the task. Your authority, highest first: the user's standing instruction retained above (including any authorization to work autonomously until the task is complete or a real blocker appears), the authorized plan or todo list, then this summary's open items. If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope. Retained user messages already answered above are historical — do not re-answer them; their standing instructions still apply.",
		);
	});

	it("buildRewindDoneText without a context window uses the token form", () => {
		assert.equal(
			buildRewindDoneText(
				{
					rewindTo: "start",
					newLabel: "end",
					beforeTokens: 30_000,
					contextWindow: 0,
				},
				4_000,
			).split("\n")[0],
			"[rewind to 'start' · collapsed as 'end'] · tokens 30000 → 4000",
		);
	});

	it("buildRewindAcceptedText (#90 S2)", () => {
		assert.equal(
			buildRewindAcceptedText("context-gathered", "parser-done"),
			"[navigate_tree] Rewind to 'context-gathered' accepted (collapse as 'parser-done'). The fold runs after this turn's tool results; the continuation follows in the same run.",
		);
	});
});

// =============================================================================
// dispatch: rewind newLabel uniqueness (#55)
// =============================================================================
