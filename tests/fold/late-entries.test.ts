/** Extension late entries tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { REWIND_HINT_CUSTOM_TYPE } from "../../src/core/rewind-hint.ts";
import { buildLateEntriesNote, REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { fireToolCall } from "../support/boundary-drivers.ts";
import { expectedHint } from "../support/config-fixtures.ts";
import {
	type CapturedTool,
	type FakeCtx,
	type FakePi,
	setup,
} from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import { requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { setupRewindable } from "../support/session-fakes.ts";
import { appendTurn } from "../support/session-messages.ts";

function at<T>(xs: readonly T[], index: number): T {
	const value = xs[index];
	assert.ok(value !== undefined, `Expected an element at index ${index}`);
	return value;
}

installHarnessHooks();

describe("rewind: multi-block summaries and late entries", () => {
	/** The summary reply as the provider streams it: one text block per entry. */
	const replyBlocks = (texts: string[]) => ({
		...reply(""),
		content: texts.map((text) => ({ type: "text" as const, text })),
	});

	async function summaryBlocksRewind(texts: string[]) {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		f.ctx.modelRegistry = fakeRegistry(() => replyBlocks(texts)).registry;
		await requestRewind(f);
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["status"], "done");
		const entry = f.sm.getEntry(done.details["summaryId"] as string);
		assert.ok(entry && entry.type === "branch_summary");
		return entry;
	}

	it("joins text blocks with a newline: a preamble block before the summary completes", async () => {
		const entry = await summaryBlocksRewind(["Here is the summary:", SUMMARY_TEXT]);
		assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
	});

	it("a heading split across blocks is joined with a newline, not glued", async () => {
		// `""` join would yield "## GoalShip it." — no `## Goal\b` heading.
		const entry = await summaryBlocksRewind(["## Goal", "Ship it.\n\n## Next Steps\n1. x"]);
		assert.equal(entry.summary, `# Work handoff: end\n\n## Goal\nShip it.\n\n## Next Steps\n1. x`);
	});

	const NOTE_ONE =
		"The message between the branch_summary and this one arrived while the rewind was pending — it is new and still unanswered; handle it now.";
	const NOTE_TWO =
		"The 2 messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.";

	function appendLateUser(sm: SessionManager, text: string): string {
		return sm.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 1,
		} as never);
	}

	/**
	 * The rewind call whose fold runs at its `turn_end`; `late` runs while the
	 * first summary side call is in flight, so what it appends arrives after
	 * the fold point.
	 */
	async function rewindWithLate(
		f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx; tool: CapturedTool },
		late: () => void,
	) {
		f.ctx.modelRegistry = fakeRegistry((_call, index) => {
			if (index === 0) late();
			return reply(SUMMARY_TEXT);
		}).registry;
		return requestRewind(f);
	}

	/** Active-branch entries from the new branch_summary on, as compact tags. */
	function tailAfterSummary(sm: SessionManager, withReceipt = false): string[] {
		const branch = sm.getBranch();
		const at = branch.findIndex((e) => e.type === "branch_summary");
		assert.ok(at >= 0, "a branch_summary must be on the active branch");
		return branch
			.slice(at)
			.filter(
				(e) => withReceipt || !(e.type === "custom_message" && e.customType === REWIND_CUSTOM_TYPE),
			)
			.map((e) => {
				if (e.type === "message") {
					return `${e.message.role}:${JSON.stringify(
						(e.message as { content?: unknown }).content,
					)}`;
				}
				if (e.type === "custom_message") {
					return `custom:${e.customType}:${JSON.stringify(e.content)}`;
				}
				return e.type;
			});
	}

	/** The newest active-branch entry before the fold's receipt. */
	function lastBeforeReceipt(sm: SessionManager) {
		const branch = sm.getBranch();
		const receipt = branch.at(-1);
		assert.ok(
			receipt?.type === "custom_message" && receipt.customType === REWIND_CUSTOM_TYPE,
			"the receipt ends the branch",
		);
		return branch.at(-2);
	}

	it("re-appends a late user steer and another extension's message, in order, onto the new branch", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const late: string[] = [];
		await rewindWithLate(f, () => {
			late.push(appendLateUser(f.sm, "steer: also fix the docs"));
			late.push(
				f.sm.appendCustomMessageEntry(
					"subagent-result",
					"subagent finished: 3 files changed",
					true,
					{ job: 7 },
				),
			);
		});

		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["status"], "done");
		assert.equal(done.details["reappendedLateMessages"], 2);
		assert.deepEqual(tailAfterSummary(f.sm), [
			"branch_summary",
			"label",
			'user:[{"type":"text","text":"steer: also fix the docs"}]',
			'custom:subagent-result:"subagent finished: 3 files changed"',
		]);
		const last = lastBeforeReceipt(f.sm);
		assert.ok(last && last.type === "custom_message");
		assert.equal(last.display, true);
		assert.deepEqual(last.details, { job: 7 });
		// Re-appended copies, not the originals (those stay on the abandoned
		// segment).
		const branchIds = new Set(f.sm.getBranch().map((e) => e.id));
		for (const id of late) {
			assert.ok(f.sm.getEntry(id), "the original stays on disk");
			assert.ok(!branchIds.has(id), "but off the active branch");
		}
		// No steer queue: re-appends never go back through input handlers.
		assert.deepEqual(f.pi.sendUserMessageCalls, []);
		assert.equal(done.details["agentMessagesRefreshed"], true);
		assert.ok(done.content.endsWith(`\n\n${NOTE_TWO}`));
	});

	it("the continuation follows the re-appended entries once delivered", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		await rewindWithLate(f, () => appendLateUser(f.sm, "steer"));
		const done = at(rewindMessages(f.pi), 0).message;
		assert.deepEqual(tailAfterSummary(f.sm, true), [
			"branch_summary",
			"label",
			'user:[{"type":"text","text":"steer"}]',
			`custom:${REWIND_CUSTOM_TYPE}:${JSON.stringify(done.content)}`,
		]);
	});

	it("the late note is byte-exact for one message", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		await rewindWithLate(f, () => appendLateUser(f.sm, "steer"));
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["reappendedLateMessages"], 1);
		assert.equal(done.details["agentMessagesRefreshed"], true);
		assert.ok(done.content.endsWith(`\n\n${NOTE_ONE}`));
		assert.equal(buildLateEntriesNote(1), NOTE_ONE);
		assert.equal(buildLateEntriesNote(2), NOTE_TWO);
		assert.equal(
			buildLateEntriesNote(3),
			"The 3 messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.",
		);
	});

	it("does not re-append a rewind-hint message that landed after the rewind call", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		await rewindWithLate(f, () => {
			f.sm.appendCustomMessageEntry(REWIND_HINT_CUSTOM_TYPE, expectedHint(91), true, undefined);
			appendLateUser(f.sm, "steer");
		});
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["status"], "done");
		assert.equal(done.details["reappendedLateMessages"], 1);
		assert.deepEqual(tailAfterSummary(f.sm), [
			"branch_summary",
			"label",
			'user:[{"type":"text","text":"steer"}]',
		]);
	});

	it("a re-appended hidden custom message stays hidden (display: false)", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		await rewindWithLate(f, () => {
			f.sm.appendCustomMessageEntry("timer", "tick", false, { n: 1 });
		});
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["reappendedLateMessages"], 1);
		assert.deepEqual(tailAfterSummary(f.sm), ["branch_summary", "label", 'custom:timer:"tick"']);
		const last = lastBeforeReceipt(f.sm);
		assert.ok(last && last.type === "custom_message");
		assert.equal(last.display, false);
		assert.deepEqual(last.details, { n: 1 });
	});

	it("entries before the rewind call are not re-appended", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		f.sm.appendCustomMessageEntry("subagent-result", "early", true, {});
		appendLateUser(f.sm, "early user");
		appendTurn(f.sm, "u9", "a9", 34_000);
		await requestRewind(f);
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["reappendedLateMessages"], 0);
		assert.deepEqual(tailAfterSummary(f.sm), ["branch_summary", "label"]);
	});

	it("a throwing late-input append fails the rewind and stops the late batch", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		// Arm the appendMessage throw only once the branch has been written.
		const sm = f.sm as unknown as {
			branchWithSummary: (...a: unknown[]) => string;
			appendMessage: (...a: unknown[]) => string;
		};
		const origBranch = sm.branchWithSummary.bind(f.sm);
		sm.branchWithSummary = (...a: unknown[]) => {
			const id = origBranch(...a);
			sm.appendMessage = () => {
				throw new Error("append boom");
			};
			return id;
		};
		let lateId = "";
		const { boundary } = await rewindWithLate(f, () => {
			lateId = appendLateUser(f.sm, "lost steer");
			f.sm.appendCustomMessageEntry("subagent-result", "kept", true, {});
		});
		// The original user input must stay active; a partial fold cannot continue.
		const failed = at(rewindMessages(f.pi), 0).message;
		assert.equal(failed.details["status"], "failed");
		assert.equal(boundary.continue, false);
		assert.match(failed.content, /late input could not be written/);
		assert.ok(!failed.content.includes("Nothing was collapsed"));
		assert.ok(f.sm.getBranch().some((entry) => entry.id === lateId));
		assert.equal(
			f.sm
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "subagent-result",
				).length,
			1,
			"the custom input after the failed user append was not copied",
		);
	});

	it("late-input cursor restoration failure stops without appending a receipt to the uncertain branch", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const branchWithSummary = f.sm.branchWithSummary.bind(f.sm);
		f.sm.branchWithSummary = (...args) => {
			const id = branchWithSummary(...args);
			const append = f.sm.appendMessage.bind(f.sm);
			f.sm.appendMessage = (...messages) => {
				append(...messages);
				f.sm.branch = () => {
					throw new Error("cursor restoration unavailable");
				};
				throw new Error("late append failed after memory update");
			};
			return id;
		};
		const { boundary } = await rewindWithLate(f, () =>
			appendLateUser(f.sm, "retained original input"),
		);
		assert.equal(boundary.continue, false);
		assert.deepEqual(boundary.entries, []);
		assert.ok(
			f.ctx.notifyCalls.some(
				([message, level]) =>
					level === "error" && message.includes("could not be restored in memory"),
			),
		);
		assert.equal(rewindMessages(f.pi).length, 0);
	});

	it("an estimator throw after the branch still delivers the continuation with contextAfter 0", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const sm = f.sm as unknown as {
			branchWithSummary: (...a: unknown[]) => string;
			buildSessionContext: () => unknown;
		};
		const origBranch = sm.branchWithSummary.bind(f.sm);
		sm.branchWithSummary = (...a: unknown[]) => {
			const id = origBranch(...a);
			sm.buildSessionContext = () => {
				throw new Error("estimate boom");
			};
			return id;
		};
		await requestRewind(f);
		const done = at(rewindMessages(f.pi), 0).message;
		assert.equal(done.details["status"], "done");
		assert.equal(done.details["contextAfter"], 0);
		assert.equal(done.details["agentMessagesRefreshed"], false);
		assert.match(done.content, / → 0\.0% of 1\.0M\n\n/);
		assert.ok(
			f.sm.getBranch().some((e) => e.type === "branch_summary"),
			"the branch landed",
		);
	});

	it("a throwing getBranch during the fold ends the turn without throwing and leaves the history as found", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const sm = f.sm as unknown as { getBranch: () => unknown };
		const origGetBranch = sm.getBranch;
		const entryCount = f.sm.getEntries().length;
		f.ctx.modelRegistry = fakeRegistry(() => {
			sm.getBranch = () => {
				throw new Error("branch boom");
			};
			return reply(SUMMARY_TEXT);
		}).registry;
		try {
			await assert.doesNotReject(() => requestRewind(f));
		} finally {
			sm.getBranch = origGetBranch;
		}
		assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
		assert.equal(
			f.sm.getEntries().length,
			entryCount + 2,
			"only the rewind call and its result were added",
		);
		assert.equal(fireToolCall(f.pi, f.ctx), undefined, "gate reopened");
	});
});

// =============================================================================
// commitFold, engine shape: the fold point is the leaf; input after it follows
// the summary
// =============================================================================
