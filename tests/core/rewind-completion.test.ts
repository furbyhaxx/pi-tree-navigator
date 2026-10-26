/** Extension rewind completion tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import { buildRewindDoneText, REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { getHandoff, materializeHandoff } from "../../src/fold/handoff.ts";
import { __testHooks } from "../../src/index.ts";
import { fireToolCall, fireTurnEndAll } from "../support/boundary-drivers.ts";
import { type BoundaryDraft, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { fakeRegistry, reply, SUMMARY_TEXT } from "../support/model-registry.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { configureParentMode, rewindFixture } from "../support/rewind-fixtures.ts";
import { makeFakeSession, setupRewindable } from "../support/session-fakes.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
} from "../support/session-messages.ts";

function defined<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "Expected a defined test value");
	return value;
}

installHarnessHooks();

describe("rewind: completion", () => {
	it("branches from the anchor with a work handoff, labels it, and moves the leaf", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		const summaryId = f.done.message.details["summaryId"] as string;
		const entry = f.sm.getEntry(summaryId);
		assert.ok(entry && entry.type === "branch_summary");
		assert.equal(entry.parentId, f.anchorId, "child of the anchor entry");
		assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
		const details = entry.details as {
			readFiles: string[];
			modifiedFiles: string[];
			treeNavigator: { title: string; children: string[] };
		};
		assert.deepEqual(details.readFiles, []);
		assert.deepEqual(details.modifiedFiles, []);
		assert.equal(details.treeNavigator.title, "end");
		assert.deepEqual(details.treeNavigator.children, []);
		// Extension-provided summary, as pi's navigateTree marks it.
		assert.equal(entry.fromHook, true);
		assert.equal(f.sm.getLabel(summaryId), "anchor:end");
		// The summary is followed by its label change (the same shape as pi's
		// own `/tree` label write) and then the committed continuation.
		const branch = f.sm.getBranch();
		const at = branch.findIndex((e) => e.id === summaryId);
		assert.equal(defined(branch[at + 1]).type, "label");
		assert.equal(defined(branch[at + 2]).type, "custom_message");
		assert.equal(f.sm.getLeafId(), defined(branch[at + 2]).id);
		// The abandoned branch keeps the rewind call and its result, marked as
		// finished.
		assert.equal(f.sm.getLabel(f.leafBeforeFold), "branch:end");
		assert.ok(f.sm.getEntry(f.leafBeforeFold));
		assert.ok(!branch.some((e) => e.id === f.leafBeforeFold));
	});

	it("delivers the continuation as a boundary entry: buildRewindDoneText content, continue, done details", async () => {
		const f = await rewindFixture();
		const calls = rewindMessages(f.pi);
		assert.equal(calls.length, 1);
		const { message } = defined(calls[0]);
		assert.equal(defined(calls[0]).continue, true);
		assert.equal(message.type, "custom_message");
		assert.equal(message.customType, REWIND_CUSTOM_TYPE);
		assert.equal(message.display, true);
		const d = message.details;
		assert.equal(
			message.content,
			buildRewindDoneText(
				{
					rewindTo: "start",
					newLabel: "end",
					beforeTokens: d["contextBefore"] as number,
					contextWindow: 1_000_000,
				},
				d["contextAfter"] as number,
			),
		);
		assert.deepEqual(d, {
			status: "done",
			rewindTo: "start",
			newLabel: "end",
			targetId: f.anchorId,
			summaryId: d["summaryId"],
			collapsedEntries: d["collapsedEntries"],
			contextBefore: d["contextBefore"],
			contextAfter: d["contextAfter"],
			contextWindow: 1_000_000,
			origin: "agent",
			summaryStrategy: "chunked",
			summaryCalls: d["summaryCalls"],
			foldEstimateBefore: d["foldEstimateBefore"],
			foldEstimateAfter: d["foldEstimateAfter"],
			agentMessagesRefreshed: true,
			historyRewriteNotified: false,
			readFiles: [],
			modifiedFiles: [],
			reappendedLateMessages: 0,
			openUserRequests: [],
		});
		// Collapsed: the anchor's label-change entry, u2..a4 (6), the rewind
		// call and its result, all left on the abandoned branch.
		assert.equal(d.collapsedEntries, 9);
		assert.ok(Number(d.summaryCalls) >= 2, "a map call and the reduce");
		assert.ok(
			(d.contextBefore as number) > (d.contextAfter as number),
			"the rewound chain must be smaller",
		);
		assert.ok(
			Number(d.foldEstimateAfter) > SUMMARY_TEXT.length / 4,
			"the fold check includes continuation overhead",
		);
		assert.ok(Number(d.foldEstimateAfter) < Number(d.foldEstimateBefore));
	});

	it("continuation prose: [rewind] header + pending-work guidance", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		const text = f.done.message.content;
		assert.match(text, /^\[rewind to 'start' · collapsed as 'end'\] · /);
		assert.match(text, /### Done/);
		assert.match(text, /### In Progress/);
		assert.match(text, /### Blocked/);
		assert.match(text, /## Next Steps/);
		assert.match(text, /are the resume point/);
		assert.match(text, /It is the newest branch_summary, the current state/);
		assert.match(text, /continue the latest branch_summary's work/);
	});

	it("continuation prose: the authority order outranks the summary, and retained messages keep their standing instructions", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		const text = f.done.message.content;
		assert.match(text, /A branch_summary marks a milestone, not the end of the task/);
		assert.match(
			text,
			/Your authority, highest first: the user's standing instruction retained above \(including any authorization to work autonomously until the task is complete or a real blocker appears\), the authorized plan or todo list, then this summary's open items/,
		);
		assert.match(
			text,
			/If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope/,
		);
		assert.match(text, /do not re-answer them; their standing instructions still apply/);
		assert.doesNotMatch(text, /predate this rewind/);
		assert.doesNotMatch(text, /execute them next/);
	});

	it("refreshes agent.state.messages to the rewound chain", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		assert.ok(f.fake);
		assert.equal(f.done.message.details["agentMessagesRefreshed"], true);
		// pi commits the receipt after the handlers, once the state is refreshed.
		const chain = f.sm.buildSessionContext().messages;
		assert.deepEqual(f.fake.agent.state.messages, chain.slice(0, -1));
		assert.equal((chain.at(-1) as { customType?: string }).customType, REWIND_CUSTOM_TYPE);
	});

	it("bootstrap-missing: continuation carries the rewind warning and refreshed=false", async () => {
		const f = await rewindFixture({ capture: false });
		assert.ok(f.done);
		assert.equal(f.done.message.details["status"], "done");
		assert.equal(f.done.message.details["agentMessagesRefreshed"], false);
		assert.ok(
			f.done.message.content.endsWith(`\n\n${__testHooks.REFLECTION_BOOTSTRAP_WARNING_REWIND}`),
		);
	});

	it("strips any preamble before '## Goal' from the stored summary", async () => {
		const f = await rewindFixture({
			summary: `Sure — here is the summary.\n\n${SUMMARY_TEXT}\n\n`,
		});
		assert.ok(f.done);
		const entry = f.sm.getEntry(f.done.message.details["summaryId"] as string);
		assert.ok(entry && entry.type === "branch_summary");
		assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
	});

	it("appends read/modified file tags from read/edit/write calls in the collapsed segment", async () => {
		const f = setup();
		const t1 = appendTurn(f.sm, "u1", "a1", 6_000);
		f.pi.pi.setLabel(t1.assistantId, "anchor:start");
		appendToolCallAssistant(
			f.sm,
			[
				{ id: "r1", name: "read", arguments: { path: "src/a.ts" } },
				{ id: "r2", name: "read", arguments: { path: "src/b.ts" } },
				{ id: "e1", name: "edit", arguments: { path: "src/b.ts" } },
				{ id: "w1", name: "write", arguments: { path: "src/c.ts" } },
			],
			12_000,
		);
		for (const id of ["r1", "r2", "e1", "w1"]) {
			appendToolResult(f.sm, id, "read", "ok");
		}
		appendTurn(f.sm, "u3", "a3", 24_000, true);
		await requestRewind(f);
		const { details } = defined(rewindMessages(f.pi)[0]).message;
		assert.deepEqual(details["readFiles"], ["src/a.ts"]);
		assert.deepEqual(details["modifiedFiles"], ["src/b.ts", "src/c.ts"]);
		const entry = f.sm.getEntry(details["summaryId"] as string);
		assert.ok(entry && entry.type === "branch_summary");
		assert.equal(
			entry.summary,
			`# Work handoff: end\n\n${SUMMARY_TEXT}\n\n<read-files>\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>`,
		);
		const fileDetails = entry.details as {
			readFiles: string[];
			modifiedFiles: string[];
		};
		assert.deepEqual(fileDetails.readFiles, ["src/a.ts"]);
		assert.deepEqual(fileDetails.modifiedFiles, ["src/b.ts", "src/c.ts"]);
	});

	it("emits session_tree after the rewind so history mirrors rebuild (#79)", async () => {
		// pi-claude-bridge mirrors the conversation in a Claude Code session and
		// rebuilds it only on `session_tree` / `session_compact`. A tool-driven
		// rewind must emit the same event pi's own navigateTree emits, AFTER the
		// branch and the agent-state refresh, so a handler reading the session
		// sees the rewound chain.
		const f = setup();
		setupRewindable(f.sm, f.pi);
		const fake = makeFakeSession(f.sm);
		const events: Array<Record<string, unknown>> = [];
		let messagesAtEmit: unknown[] | undefined;
		let deliveredBeforeEmit = -1;
		fake._extensionRunner = {
			emit: async (event) => {
				events.push(event as Record<string, unknown>);
				messagesAtEmit = fake.agent.state.messages;
				deliveredBeforeEmit = rewindMessages(f.pi).length;
			},
		};
		__testHooks.captureSession(fake as unknown as AgentSession);
		const { leafBeforeFold } = await requestRewind(f);

		const done = defined(rewindMessages(f.pi)[0]).message;
		assert.equal(done.details["historyRewriteNotified"], true);
		assert.equal(events.length, 1);
		const event = events[0];
		assert.ok(event);
		assert.equal(event["type"], "session_tree");
		assert.equal(
			event["oldLeafId"],
			leafBeforeFold,
			"old leaf = the abandoned branch's last entry",
		);
		assert.equal(
			f.sm.getEntry(f.sm.getLeafId() as string)?.parentId,
			event["newLeafId"],
			"the receipt follows the new leaf",
		);
		assert.equal(
			f.sm.getEntry(event["newLeafId"] as string)?.parentId,
			done.details["summaryId"],
			"new leaf = the label entry on the summary",
		);
		assert.equal(
			(event["summaryEntry"] as { id?: string } | undefined)?.id,
			done.details["summaryId"],
		);
		assert.equal(event["fromExtension"], true);
		assert.deepEqual(
			messagesAtEmit,
			f.sm.buildSessionContext().messages.slice(0, -1),
			"the chain before pi commits the receipt",
		);
		assert.equal(deliveredBeforeEmit, 0, "emit precedes the continuation message");
	});

	it("reports historyRewriteNotified=false without a reachable runner (#79)", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		assert.equal(f.done.message.details["agentMessagesRefreshed"], true);
		assert.equal(f.done.message.details["historyRewriteNotified"], false);
	});

	it("a throwing session_tree handler does not fail the rewind (#79)", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi);
		const fake = makeFakeSession(f.sm);
		fake._extensionRunner = {
			emit: async () => {
				throw new Error("handler boom");
			},
		};
		__testHooks.captureSession(fake as unknown as AgentSession);
		await requestRewind(f);
		const done = defined(rewindMessages(f.pi)[0]).message;
		assert.equal(done.details["status"], "done");
		assert.equal(done.details["historyRewriteNotified"], false);
		assert.match(done.content, /^\[rewind to 'start'/);
	});

	it("a throwing pi.sendMessage cannot affect delivery (rewind messages never use it)", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		(f.pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }).sendMessage = () => {
			throw new Error("stale session runtime");
		};
		const { boundary } = await requestRewind(f);
		assert.equal(boundary.continue, true);
		assert.equal(boundary.entries.length, 1);
		assert.equal(defined(boundary.entries[0]).details["status"], "done");
		// Committed by pi (replicated by `fireTurnEndAll`) after the branch_summary.
		const leaf = f.sm.getEntry(f.sm.getLeafId() as string);
		assert.ok(leaf && leaf.type === "custom_message");
		assert.equal(leaf.customType, REWIND_CUSTOM_TYPE);
		assert.equal(leaf.display, true);
		assert.match(String(leaf.content), /^\[rewind to 'start'/);
		assert.ok(
			f.sm.getBranch().some((e) => e.type === "branch_summary"),
			"the continuation follows the branch_summary on the active branch",
		);
	});

	it("setLabel throw falls back to appendLabelChange for both labels", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		(f.pi.pi as { setLabel: typeof f.pi.pi.setLabel }).setLabel = () => {
			throw new Error("stale session runtime");
		};
		const { leafBeforeFold } = await requestRewind(f);
		const done = defined(rewindMessages(f.pi)[0]).message;
		assert.equal(done.details["status"], "done");
		assert.equal(f.sm.getLabel(done.details["summaryId"] as string), "anchor:end");
		assert.equal(f.sm.getLabel(leafBeforeFold), "branch:end");
	});

	it("chained rewinds: a→b then b→c keeps prior labels and re-anchors the new summary", async () => {
		const f = setup();
		const tA = appendTurn(f.sm, "u1", "a1", 6_000);
		f.pi.pi.setLabel(tA.assistantId, "anchor:a");
		appendTurn(f.sm, "u2", "a2", 12_000, true);
		appendTurn(f.sm, "u3", "a3", 18_000, true);
		__testHooks.captureSession(makeFakeSession(f.sm) as unknown as AgentSession);

		await requestRewind(f, { ...REWIND_ARGS, rewindTo: "a", newLabel: "b" });
		const first = defined(rewindMessages(f.pi)[0]).message;
		assert.equal(first.details["status"], "done");
		const sumB = first.details["summaryId"] as string;

		appendTurn(f.sm, "u4", "a4", 24_000, true);
		appendTurn(f.sm, "u5", "a5", 30_000, true);
		const { result: r2 } = await requestRewind(
			f,
			{
				...REWIND_ARGS,
				rewindTo: "b",
				newLabel: "c",
				summaryFocus: "Preserve user instructions across the second rewind.",
			},
			"tc-2",
		);
		assert.equal(r2.details["targetId"], sumB);
		const second = defined(rewindMessages(f.pi)[1]).message;
		assert.equal(second.details["status"], "done");
		const sumC = second.details["summaryId"] as string;
		assert.equal(f.sm.getEntry(sumC)?.parentId, sumB);
		assert.equal(f.sm.getLabel(sumC), "anchor:c");
		assert.equal(
			f.sm.getLabel(sumB),
			"anchor:b",
			"the b-summary's anchor:b label must survive the second rewind",
		);
		assert.equal(f.sm.getLabel(tA.assistantId), "anchor:a");
		const leaf = f.sm.getEntry(f.sm.getLeafId() as string);
		assert.equal(
			f.sm.getEntry(leaf?.parentId as string)?.parentId,
			sumC,
			"the continuation follows the c-summary's label",
		);
	});

	it("refuses a growing materialized summary without writing a branch or completion label", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi);
		f.ctx.modelRegistry = fakeRegistry(() =>
			reply(`${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`),
		).registry;
		const { boundary, leafBeforeFold } = await requestRewind(f);
		assert.equal(f.sm.getEntries().filter((entry) => entry.type === "branch_summary").length, 0);
		assert.equal(f.sm.getLabel(leafBeforeFold), undefined);
		assert.ok(!f.sm.getBranch().some((entry) => f.sm.getLabel(entry.id) === "anchor:end"));
		assert.equal(boundary.continue, false, "commit-stage refusals stop the run");
		assert.equal(defined(boundary.entries[0]).details["status"], "failed");
		assert.equal(defined(boundary.entries[0]).details["stage"], "commit");
		assert.match(
			String(defined(boundary.entries[0]).details["detail"]),
			/does not reduce projected context/,
		);
		assert.equal(fireToolCall(f.pi, f.ctx), undefined);
	});

	it("compares fold content on the same heuristic despite low recorded usage", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { tokenCounts: [6000, 8000, 10000, 11000] });
		f.ctx.modelRegistry = fakeRegistry(() =>
			reply(`${SUMMARY_TEXT}\n${"evidence ".repeat(4500)}`),
		).registry;
		await requestRewind(f);
		const done = rewindMessages(f.pi).at(-1)?.message;
		assert.equal(done?.details["status"], "done");
		assert.ok(
			Number(done?.details["foldEstimateAfter"]) < Number(done?.details["foldEstimateBefore"]),
		);
	});

	it("checks the currently edited view rather than the old pre-withholding measurement", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi);
		// The context is edited while the summary is being written.
		f.ctx.modelRegistry = fakeRegistry((_call, index) => {
			if (index === 0) {
				for (const entry of f.sm.getBranch()) {
					if (entry.type === "message" && entry.message.role === "user")
						f.sm.appendContextEdit(entry.id, { content: "short" });
				}
			}
			return reply(SUMMARY_TEXT);
		}).registry;
		const { boundary } = await requestRewind(f);
		assert.equal(f.sm.getEntries().filter((entry) => entry.type === "branch_summary").length, 0);
		assert.match(
			String(defined(boundary.entries[0]).details["detail"]),
			/does not reduce projected context/,
		);
	});

	it("includes full child reports in the net-fold check", async () => {
		const f = setup();
		await configureParentMode(f, "full");
		setupRewindable(f.sm, f.pi);
		const leaf = f.sm.getLeafId();
		assert.ok(leaf);
		f.sm.branchWithSummary(leaf, `CHILD ${"evidence ".repeat(12_000)}`, {}, true);
		f.ctx.modelRegistry = fakeRegistry(() =>
			reply(`${SUMMARY_TEXT}\n${"report ".repeat(16_000)}`),
		).registry;
		const beforeCount = f.sm.getEntries().filter((entry) => entry.type === "branch_summary").length;
		const { boundary } = await requestRewind(f);
		assert.equal(
			f.sm.getEntries().filter((entry) => entry.type === "branch_summary").length,
			beforeCount,
		);
		assert.match(
			String(defined(boundary.entries[0]).details["detail"]),
			/does not reduce projected context/,
		);
	});

	it("folds an earlier child handoff into a parent once and projects honest work context", async () => {
		const f = await rewindFixture({ mode: "full" });
		assert.ok(f.done);
		const childId = f.done.message.details["summaryId"] as string;
		appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
		appendTurn(f.sm, "parent-verification", "parent-result", 30000, true);
		const parentReport =
			"## Goal\nParent scope\n\n## Progress\nParent final outcome\n\n## Next Steps\nContinue.";
		const parentRegistry = fakeRegistry(() => reply(parentReport));
		f.ctx.modelRegistry = parentRegistry.registry;
		await requestRewind(f, { ...REWIND_ARGS, rewindTo: "start", newLabel: "parent" }, "tc-parent");
		const instruction = parentRegistry.calls.at(-1)?.context.messages.at(-1);
		assert.match(JSON.stringify(instruction), /no fixed 4000-character cap/);
		const latest = rewindMessages(f.pi).at(-1);
		assert.ok(latest);
		const parent = f.sm.getEntry(latest.message.details["summaryId"] as string);
		assert.ok(parent?.type === "branch_summary");
		assert.equal(parent.summary.split("Test the rewind happy path.").length - 1, 1);
		assert.match(parent.summary, /Parent final outcome/);
		const details = parent.details as {
			treeNavigator: { children: string[]; sourceIds: string[] };
		};
		assert.deepEqual(details.treeNavigator.children, [childId]);
		assert.equal(
			new Set(details.treeNavigator.sourceIds).size,
			details.treeNavigator.sourceIds.length,
		);
		const projected = __testHooks.buildContextMessages(f.sm);
		assert.equal(
			projected.filter(
				(message) => message.role === "custom" && message.customType === "navigate-tree-handoff",
			).length,
			1,
		);
		assert.doesNotMatch(
			JSON.stringify(projected),
			/explored a different conversation|came back from/,
		);
	});

	it("defaults parent folds to a digest while retaining full child evidence for synthesis", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		const childId = f.done.message.details["summaryId"] as string;
		const child = f.sm.getEntry(childId);
		assert.ok(child?.type === "branch_summary");
		appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
		appendTurn(f.sm, "parent-verification", "parent-result", 30000, true);
		const parentReport = "## Goal\nParent scope\n\n## Outcome\nParent delivered.";
		const registry = fakeRegistry(() => reply(parentReport));
		f.ctx.modelRegistry = registry.registry;
		await requestRewind(
			f,
			{ ...REWIND_ARGS, rewindTo: "start", newLabel: "digest-parent" },
			"tc-digest",
		);
		const latest = rewindMessages(f.pi).at(-1);
		assert.ok(latest);
		const parent = f.sm.getEntry(latest.message.details["summaryId"] as string);
		assert.ok(parent?.type === "branch_summary");
		const handoff = getHandoff(parent);
		assert.ok(handoff);
		assert.equal(handoff.mode, "digest");
		assert.match(parent.summary, /Earlier handoffs in this span \(digest\)/);
		assert.ok(parent.summary.includes(`entry ${childId}`));
		assert.ok(!parent.summary.includes(child.summary));
		assert.ok(!parent.summary.includes(SUMMARY_TEXT));
		assert.ok(JSON.stringify(registry.calls).includes("Test the rewind happy path."));
		const full = materializeHandoff({ ...handoff, mode: "full" }, [
			{ id: childId, summary: child.summary },
		]);
		assert.ok(parent.summary.length < full.length);
	});

	it("includes a native child summary’s own generation usage in parent recorded statistics", async () => {
		const f = setup();
		const anchor = appendTurn(f.sm, "root-user", "root-answer", 6000);
		f.pi.pi.setLabel(anchor.assistantId, "anchor:start");
		appendTurn(f.sm, "child-user", "child-answer", 12000);
		const childId = f.sm.branchWithSummary(anchor.assistantId, "## Goal\nNative child", {}, true, {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, total: 7 },
		});
		f.pi.pi.setLabel(childId, "anchor:child");
		appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
		__testHooks.captureSession(makeFakeSession(f.sm) as unknown as AgentSession);
		await requestRewind(f, { ...REWIND_ARGS, newLabel: "parent" });
		const done = rewindMessages(f.pi).at(-1);
		assert.ok(done);
		const entry = f.sm.getEntry(done.message.details["summaryId"] as string);
		assert.ok(entry?.type === "branch_summary");
		const details = entry.details as {
			treeNavigator: { sourceIds: string[]; stats: { cost: number } };
		};
		assert.ok(details.treeNavigator.sourceIds.includes(childId));
		assert.equal(details.treeNavigator.stats.cost, 7);
	});

	it("immediate re-rewind of a just-landed summary is refused and queues nothing", async () => {
		const f = await rewindFixture();
		const { result, boundary } = await requestRewind(
			f,
			{ ...REWIND_ARGS, rewindTo: "end", newLabel: "again" },
			"tc-2",
		);
		assert.equal(result.isError, true);
		assert.equal(result.details["rejected"], "min-savings");
		assert.equal(boundary.entries.length, 0);
		assert.equal(fireToolCall(f.pi, f.ctx), undefined);
	});

	it("never calls pi.sendMessage / sendUserMessage for rewind messages", async () => {
		const f = await rewindFixture();
		assert.ok(f.done);
		assert.equal(f.done.message.details["status"], "done");
		assert.deepEqual(f.pi.sendMessageCalls, []);
		assert.deepEqual(f.pi.sendUserMessageCalls, []);
	});

	it("keeps entries from a handler earlier in the chain: [foreign, ours]", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const foreign: BoundaryDraft = {
			type: "custom_message",
			customType: "other-extension",
			content: "queued by another extension",
			display: false,
			details: { from: "other" },
		};
		const { boundary } = await requestRewind(f, REWIND_ARGS, "tc-rewind", undefined, {
			entries: [foreign],
		});
		assert.equal(boundary.continue, true);
		assert.equal(boundary.entries.length, 2);
		assert.equal(boundary.entries[0], foreign, "the foreign draft, untouched");
		assert.equal(defined(boundary.entries[1]).customType, REWIND_CUSTOM_TYPE);
		assert.equal(defined(boundary.entries[1]).details["status"], "done");
	});

	it("drops earlier context_edit drafts the rewind made stale, keeps the rest (compactions included)", async () => {
		// pi validates the whole boundary list in a preview and drops ALL of it
		// when one draft fails; a draft targeting an entry the rewind abandoned
		// would take the continuation down with it.
		const f = setup();
		setupRewindable(f.sm, f.pi, { capture: true });
		const anchorId = f.sm.getBranch().find((e) => f.sm.getLabel(e.id) === "anchor:start")?.id;
		assert.ok(anchorId);
		const call = appendToolCallAssistant(f.sm, [
			{ id: "tc-rewind", name: TOOL_NAME, arguments: REWIND_ARGS },
		]);
		const result = await f.tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, f.ctx);
		appendToolResult(f.sm, "tc-rewind", TOOL_NAME, defined(result.content[0]).text);
		const staleEdit = {
			type: "context_edit",
			targetId: call.id,
			replacement: { content: "x" },
		};
		// pi never validates a compaction's firstKeptEntryId, so compaction
		// drafts pass through untouched — null (self-retaining) and stale ids.
		const staleCompaction = {
			type: "compaction",
			summary: "s",
			firstKeptEntryId: call.id,
		};
		const selfCompaction = {
			type: "compaction",
			summary: "s",
			firstKeptEntryId: null,
		};
		const liveEdit = {
			type: "context_edit",
			targetId: anchorId,
			replacement: { content: "y" },
		};
		const foreign = {
			type: "custom_message",
			customType: "other-extension",
			content: "kept",
			display: true,
			details: {},
		};
		const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message, {
			entries: [staleEdit, staleCompaction, selfCompaction, liveEdit, foreign] as never,
		});
		assert.equal(boundary.continue, true);
		assert.deepEqual(
			boundary.entries.slice(0, -1),
			[staleCompaction, selfCompaction, liveEdit, foreign],
			"only the stale context_edit dropped, the rest kept in order",
		);
		assert.equal(boundary.entries.at(-1)?.customType, REWIND_CUSTOM_TYPE);
	});

	it("returns nothing on turns without a queued fold", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi);
		const handlers = f.pi.onCalls.get("turn_end");
		assert.ok(handlers);
		const result = await defined(handlers[0])(
			{
				type: "turn_end",
				turnIndex: 0,
				message: assistantMessage([{ type: "text", text: SUMMARY_TEXT }], "stop"),
				toolResults: [],
				entries: [],
				continue: false,
			} as never,
			f.ctx as never,
		);
		assert.equal(result, undefined);
	});
});

// =============================================================================
// TUI renderers
// =============================================================================
