/** Extension fold commit tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateContentTokens } from "../../src/core/context-tokens.ts";
import { estimateAdmissionTokens } from "../../src/core/request-accounting.ts";
import { commitFold, type FoldCommitInput } from "../../src/fold/fold-commit.ts";
import { previewFoldCommit } from "../../src/fold/fold-preview.ts";
import { buildLateEntriesNote, REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import navigateTree, { __testHooks } from "../../src/index.ts";
import { makeCtx, makeFakePi, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { SUMMARY_TEXT } from "../support/model-registry.ts";
import { setupRewindable } from "../support/session-fakes.ts";
import { appendToolResult, appendTurn, assistantMessage } from "../support/session-messages.ts";

installHarnessHooks();

describe("commitFold: engine shape", () => {
	function reopenSession(sm: SessionManager) {
		const path = sm.getSessionFile();
		assert.ok(path);
		return SessionManager.open(path);
	}

	function engineFold(
		f: { sm: SessionManager },
		anchorId: string,
		overrides: Partial<FoldCommitInput> = {},
	) {
		const leaf = f.sm.getLeafId() as string;
		const lead: number[] = [];
		const input: FoldCommitInput = {
			targetId: anchorId,
			rewindTo: "start",
			newLabel: "end",
			summaryText: SUMMARY_TEXT,
			handoffMode: "full",
			contextWindow: 200_000,
			foldPointId: leaf,
			branchLabelEntryId: leaf,
			continuationText: (afterTokens) => {
				lead.push(afterTokens);
				return `folded to ${afterTokens}`;
			},
			writeLabel: (entryId, label) => {
				f.sm.appendLabelChange(entryId, label);
				return true;
			},
			...overrides,
		};
		return { leaf, lead, input };
	}

	it("branches from the target, labels both ends and re-appends input after the fold point", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const run = engineFold(f, anchorId);
		const lateId = f.sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "late steer" }],
			timestamp: 1,
		} as never);
		const outcome = await commitFold(f.sm, run.input);
		assert.ok(outcome.ok);
		const summary = f.sm.getEntry(outcome.summaryId);
		assert.ok(summary && summary.type === "branch_summary");
		assert.equal(summary.parentId, anchorId);
		assert.equal(outcome.oldLeafId, lateId);
		assert.equal(f.sm.getLabel(run.leaf), "branch:end");
		assert.equal(f.sm.getLabel(outcome.summaryId), "anchor:end");
		assert.equal(outcome.reappended, 1);
		const branch = f.sm.getBranch();
		const tail = branch
			.slice(branch.findIndex((e) => e.id === outcome.summaryId) + 1)
			.filter((e) => e.type !== "label");
		assert.equal(tail.length, 1);
		assert.notEqual(tail[0].id, lateId);
		assert.ok(tail[0].type === "message" && tail[0].message.role === "user");
		assert.equal(tail[0].id, f.sm.getLeafId());
		assert.ok(outcome.refreshed);
		assert.ok(outcome.foldEstimateAfter < outcome.foldEstimateBefore);
		assert.equal(outcome.afterTokens, estimateAdmissionTokens(f.sm));
		assert.equal(
			outcome.continuation,
			`folded to ${outcome.afterTokens}\n\n${buildLateEntriesNote(1)}`,
		);
		assert.equal(run.lead.length, 2, "prospective estimate, then final");
	});

	it("late-input persistence failure restores the original branch without dangling receipt parents", async () => {
		for (const persistent of [false, true]) {
			const dir = mkdtempSync(join(tmpdir(), "fold-persistence-"));
			try {
				const sm = SessionManager.create(dir, dir);
				const pi = makeFakePi(sm);
				const { anchorId } = setupRewindable(sm, pi);
				const run = engineFold({ sm }, anchorId);
				const originalInput = sm.appendMessage({
					role: "user",
					content: "late original",
					timestamp: 1,
				});
				const originalLeaf = sm.appendCustomMessageEntry("subagent-result", "late result", true);
				const internals = sm as unknown as {
					_persist(entry: SessionEntry): void;
				};
				const persist = internals._persist.bind(sm);
				let failedId = "";
				internals._persist = (entry) => {
					if (failedId && persistent) throw new Error("persistent disk failure");
					if (entry.type === "message" && entry.message.role === "user" && !failedId) {
						failedId = entry.id;
						throw new Error("injected late-input disk failure");
					}
					persist(entry);
				};
				const outcome = await commitFold(sm, run.input);
				assert.ok(!outcome.ok, JSON.stringify(outcome));
				assert.match(outcome.reason, /late input could not be written/);
				assert.match(outcome.reason, /[Pp]ersistence.*uncertain/);
				if (persistent) {
					assert.equal(sm.getLeafId(), originalLeaf);
					assert.match(outcome.reason, /[Nn]o restoration append succeeded/);
				} else {
					assert.match(outcome.reason, /restoration append succeeded/);
				}
				assert.ok(sm.getBranch().some((entry) => entry.id === originalInput));
				assert.ok(sm.getBranch().some((entry) => entry.id === originalLeaf));
				assert.equal(sm.getLabel(run.leaf), persistent ? "branch:end" : undefined);
				assert.equal(
					sm
						.getEntries()
						.filter(
							(entry) => entry.type === "custom_message" && entry.customType === "subagent-result",
						).length,
					1,
				);
				internals._persist = persist;
				const receipt = sm.appendCustomEntry("receipt", {});
				const reopened = reopenSession(sm);
				assert.equal(reopened.getLeafId(), receipt);
				assert.deepEqual(
					reopened.getBranch().map((entry) => entry.id),
					sm.getBranch().map((entry) => entry.id),
				);
				const ids = new Set(reopened.getEntries().map((entry) => entry.id));
				assert.ok(!ids.has(failedId));
				for (const entry of reopened.getEntries()) {
					assert.ok(
						entry.parentId === null || ids.has(entry.parentId),
						`dangling parent ${entry.parentId}`,
					);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("persistence failures in the branch or mandatory labels refuse and preserve unrelated labels", async () => {
		for (const step of ["marker", "branch", "summary-label"] as const) {
			const dir = mkdtempSync(join(tmpdir(), "fold-write-"));
			try {
				const sm = SessionManager.create(dir, dir);
				const pi = makeFakePi(sm);
				const { anchorId } = setupRewindable(sm, pi);
				const run = engineFold({ sm }, anchorId);
				if (step !== "marker") sm.appendLabelChange(run.leaf, "unrelated bookmark");
				const originalLeaf = sm.getLeafId();
				const internals = sm as unknown as {
					_persist(entry: SessionEntry): void;
				};
				const persist = internals._persist.bind(sm);
				let failedId = "";
				internals._persist = (entry) => {
					const matches =
						step === "branch"
							? entry.type === "branch_summary"
							: entry.type === "label" &&
								entry.label === (step === "marker" ? "branch:end" : "anchor:end");
					if (matches && !failedId) {
						failedId = entry.id;
						throw new Error(`injected ${step} failure`);
					}
					persist(entry);
				};
				const outcome = await commitFold(sm, run.input);
				assert.ok(!outcome.ok, JSON.stringify(outcome));
				assert.match(outcome.reason, /restoration append succeeded/);
				assert.ok(sm.getBranch().some((entry) => entry.id === originalLeaf));
				assert.equal(sm.getLabel(run.leaf), step === "marker" ? undefined : "unrelated bookmark");
				const reopened = reopenSession(sm);
				assert.deepEqual(
					reopened.getBranch().map((entry) => entry.id),
					sm.getBranch().map((entry) => entry.id),
				);
				const ids = new Set(reopened.getEntries().map((entry) => entry.id));
				assert.ok(!ids.has(failedId));
				for (const entry of reopened.getEntries())
					assert.ok(entry.parentId === null || ids.has(entry.parentId));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("persistence label retry and receipt retry never parent failed in-memory entries", async () => {
		for (const operation of ["label", "receipt"] as const) {
			const dir = mkdtempSync(join(tmpdir(), "fold-retry-"));
			try {
				const sm = SessionManager.create(dir, dir);
				const pi = makeFakePi(sm);
				navigateTree(pi.pi);
				const ctx = makeCtx(sm);
				const { anchorId } = setupRewindable(sm, pi);
				const internals = sm as unknown as {
					_persist(entry: SessionEntry): void;
				};
				const persist = internals._persist.bind(sm);
				let failedId = "";
				internals._persist = (entry) => {
					if (
						!failedId &&
						(operation === "label" ? entry.type === "label" : entry.type === "custom_message")
					) {
						failedId = entry.id;
						throw new Error(`injected ${operation} failure`);
					}
					persist(entry);
				};
				pi.pi.sendMessage = (message) => {
					sm.appendCustomMessageEntry(
						message.customType,
						message.content,
						message.display ?? true,
						message.details,
					);
				};
				const api = __testHooks.foldApi(pi.pi);
				assert.ok(api);
				const outcome = await api.runFoldNow({ ...ctx, isIdle: () => true } as never, {
					origin: "manual",
					rewindTo: "start",
					newLabel: "end",
					focus: "Preserve user instructions and continue the work.",
				});
				assert.equal(outcome.status, "done", JSON.stringify(outcome));
				assert.equal(sm.getEntry(anchorId)?.id, anchorId);
				assert.ok(failedId);
				const reopened = reopenSession(sm);
				assert.deepEqual(
					reopened.getBranch().map((entry) => entry.id),
					sm.getBranch().map((entry) => entry.id),
				);
				const ids = new Set(reopened.getEntries().map((entry) => entry.id));
				assert.ok(!ids.has(failedId));
				for (const entry of reopened.getEntries())
					assert.ok(entry.parentId === null || ids.has(entry.parentId));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("preserves additive requests across a second fold without nesting continuations", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const firstText = "First open request.\n  Exact whitespace.\n";
		const firstId = f.sm.appendMessage({
			role: "user",
			content: firstText,
			timestamp: 1,
		});
		const secondText = "Also do the second request.";
		const secondId = f.sm.appendMessage({
			role: "user",
			content: secondText,
			timestamp: 2,
		});
		f.sm.appendMessage(
			assistantMessage(
				[{ type: "toolCall", id: "work", name: "read", arguments: {} }],
				"toolUse",
			) as never,
		);
		f.sm.appendMessage({
			role: "toolResult",
			toolCallId: "work",
			toolName: "read",
			content: [{ type: "text", text: "evidence" }],
			isError: false,
			timestamp: 3,
		});
		f.sm.appendMessage(
			assistantMessage([{ type: "text", text: "failed response" }], "error") as never,
		);
		f.sm.appendMessage(assistantMessage([], "stop") as never);
		f.sm.appendMessage(
			assistantMessage(
				[
					{ type: "text", text: "still using tools" },
					{ type: "toolCall", id: "more", name: "read", arguments: {} },
				],
				"stop",
			) as never,
		);
		f.sm.appendMessage({
			role: "toolResult",
			toolCallId: "more",
			toolName: "read",
			content: [{ type: "text", text: "more evidence" }],
			isError: false,
			timestamp: 4,
		});
		f.sm.appendCustomMessageEntry(
			REWIND_CUSTOM_TYPE,
			"historical continuation without typed requests",
			true,
		);
		f.sm.appendCustomMessageEntry("notification", "new notification", true);
		const run = engineFold(f, anchorId);
		const lateText = "Late input is reappended, not quoted.";
		f.sm.appendMessage({ role: "user", content: lateText, timestamp: 4 });
		const expected = [
			{ sourceEntryId: firstId, text: firstText },
			{ sourceEntryId: secondId, text: secondText },
		];
		const first = await commitFold(f.sm, run.input);
		assert.ok(first.ok, JSON.stringify(first));
		assert.deepEqual(first.openUserRequests, expected);
		assert.ok(!first.continuation.includes(lateText));
		f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, first.continuation, true, {
			status: "done",
			openUserRequests: first.openUserRequests,
		});
		f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, "duplicate receipt", true, {
			openUserRequests: first.openUserRequests,
		});
		f.sm.appendCustomMessageEntry("evidence", "extra work ".repeat(5_000), false);
		const second = await commitFold(f.sm, engineFold(f, anchorId, { newLabel: "end-two" }).input);
		assert.ok(second.ok, JSON.stringify(second));
		assert.deepEqual(second.openUserRequests.slice(0, 2), expected);
		assert.equal(
			second.openUserRequests.length,
			3,
			"late input becomes collapsed on the second fold",
		);
		assert.equal(second.continuation.split(firstText).length, 2);
		assert.ok(!second.continuation.includes(first.continuation));
		const summary = f.sm.getEntry(second.summaryId);
		assert.ok(summary?.type === "branch_summary");
		assert.ok(!summary.summary.includes(firstText));
		f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, second.continuation, true, {
			openUserRequests: second.openUserRequests,
		});
		f.sm.appendMessage(
			assistantMessage([{ type: "text", text: "requests fulfilled" }], "stop") as never,
		);
		f.sm.appendCustomMessageEntry("evidence", "more work ".repeat(5_000), false);
		const third = await commitFold(f.sm, engineFold(f, anchorId, { newLabel: "end-three" }).input);
		assert.ok(third.ok, JSON.stringify(third));
		assert.deepEqual(third.openUserRequests, []);
		assert.ok(!third.continuation.includes(firstText));
	});

	it("uses current edited user bytes and clears open requests only after a successful final reply", async () => {
		for (const final of [false, true]) {
			const f = setup();
			const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
			const sourceEntryId = f.sm.appendMessage({
				role: "user",
				content: "original discarded text",
				timestamp: 1,
			});
			f.sm.appendContextEdit(sourceEntryId, {
				content: "edited current request\n",
			});
			const hiddenId = f.sm.appendMessage({
				role: "user",
				content: "hidden request",
				timestamp: 2,
			});
			f.sm.appendContextEdit(hiddenId, null);
			if (final)
				f.sm.appendMessage(
					assistantMessage([{ type: "text", text: "completed answer" }], "stop") as never,
				);
			f.sm.appendCustomMessageEntry("notification", "late notification", true);
			const result = await commitFold(f.sm, engineFold(f, anchorId).input);
			assert.ok(result.ok, JSON.stringify(result));
			assert.deepEqual(
				result.openUserRequests,
				final ? [] : [{ sourceEntryId, text: "edited current request\n" }],
			);
			assert.ok(!result.continuation.includes("original discarded text"));
			assert.ok(!result.continuation.includes("hidden request"));
		}
	});

	it("closes a request once a newer user message follows a response, or a later handoff carried it", async () => {
		const work = (f: ReturnType<typeof setup>, id: string) => {
			f.sm.appendMessage(
				assistantMessage(
					[{ type: "toolCall", id, name: "read", arguments: {} }],
					"toolUse",
				) as never,
			);
			appendToolResult(f.sm, id, "read", "evidence");
		};

		const newer = setup();
		const { anchorId } = setupRewindable(newer.sm, newer.pi, { capture: true });
		newer.sm.appendMessage({ role: "user", content: "old task", timestamp: 1 });
		work(newer, "w1");
		const latestId = newer.sm.appendMessage({
			role: "user",
			content: "new task",
			timestamp: 2,
		});
		work(newer, "w2");
		newer.sm.appendCustomMessageEntry("work", "evidence ".repeat(6_000), false);
		const replaced = await commitFold(newer.sm, engineFold(newer, anchorId).input);
		assert.ok(replaced.ok, JSON.stringify(replaced));
		assert.deepEqual(replaced.openUserRequests, [{ sourceEntryId: latestId, text: "new task" }]);

		const carried = setup();
		const start = setupRewindable(carried.sm, carried.pi, { capture: true });
		carried.sm.appendMessage({
			role: "user",
			content: "long running task",
			timestamp: 1,
		});
		work(carried, "w1");
		const leaf = carried.sm.getLeafId();
		assert.ok(leaf);
		carried.sm.branchWithSummary(leaf, SUMMARY_TEXT, {}, true);
		work(carried, "w2");
		carried.sm.appendCustomMessageEntry("work", "evidence ".repeat(6_000), false);
		const folded = await commitFold(carried.sm, engineFold(carried, start.anchorId).input);
		assert.ok(folded.ok, JSON.stringify(folded));
		assert.deepEqual(folded.openUserRequests, []);
	});

	it("references an attached skill instead of quoting its body, including inherited requests", async () => {
		const skillBody = "Skill rule: always prefer the large model. ".repeat(400);
		const location = "/skills/picking/SKILL.md";
		const message = `<skill name="picking" location="${location}">\nReferences are relative to /skills/picking.\n\n${skillBody}\n</skill>\n\nchoose the right model for the workers`;
		const reference = `[skill "picking" was attached from ${location}; its content is not repeated here, re-read that file if needed]\n\nchoose the right model for the workers`;
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const sourceEntryId = f.sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: message }],
			timestamp: 1,
		});
		f.sm.appendCustomMessageEntry("work", "evidence ".repeat(6_000), false);
		const first = await commitFold(f.sm, engineFold(f, anchorId).input);
		assert.ok(first.ok, JSON.stringify(first));
		assert.deepEqual(first.openUserRequests, [{ sourceEntryId, text: reference }]);
		assert.ok(!first.continuation.includes("Skill rule:"));

		// A continuation written before this fix stored the full skill body.
		f.sm.appendCustomMessageEntry(REWIND_CUSTOM_TYPE, "old receipt", true, {
			openUserRequests: [{ sourceEntryId, text: message }],
		});
		f.sm.appendCustomMessageEntry("work", "more work ".repeat(6_000), false);
		const second = await commitFold(f.sm, engineFold(f, anchorId, { newLabel: "end-two" }).input);
		assert.ok(second.ok, JSON.stringify(second));
		assert.deepEqual(second.openUserRequests, [{ sourceEntryId, text: reference }]);
		assert.ok(!second.continuation.includes("Skill rule:"));
	});

	it("does not quote an open user request in the retained prefix", async () => {
		const f = setup();
		const id = f.sm.appendMessage({
			role: "user",
			content: "retained instruction",
			timestamp: 1,
		});
		f.pi.pi.setLabel(id, "anchor:start");
		f.sm.appendCustomMessageEntry("work", "large evidence ".repeat(6_000), false);
		const result = await commitFold(f.sm, engineFold(f, id).input);
		assert.ok(result.ok, JSON.stringify(result));
		assert.deepEqual(result.openUserRequests, []);
		assert.ok(!result.continuation.includes("retained instruction"));
	});

	it("prices all preserved user bytes and refuses an oversized request without mutation", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const text = "unanswered user bytes ".repeat(10_000);
		const sourceEntryId = f.sm.appendMessage({
			role: "user",
			content: text,
			timestamp: 1,
		});
		const run = engineFold(f, anchorId);
		const preview = previewFoldCommit(f.sm, run.input);
		assert.ok(preview.ok, JSON.stringify(preview));
		assert.deepEqual(preview.openUserRequests, [{ sourceEntryId, text }]);
		assert.ok(
			preview.foldEstimateAfter >
				estimateContentTokens([{ role: "user", content: text, timestamp: 1 }]),
		);
		const before = {
			leaf: f.sm.getLeafId(),
			entries: f.sm.getEntries(),
			label: f.sm.getLabel(run.leaf),
		};
		const result = await commitFold(f.sm, {
			...run.input,
			contextWindow: preview.projectedAfterTokens + 1_024 + 4_096 - 1,
		});
		assert.ok(!result.ok);
		assert.match(result.reason, /insufficient request headroom/);
		assert.equal(f.sm.getLeafId(), before.leaf);
		assert.deepEqual(f.sm.getEntries(), before.entries);
		assert.equal(f.sm.getLabel(run.leaf), before.label);
	});

	it("counts the folded leaf in the pre-fold estimate when one large turn is folded", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, {
			capture: true,
			turnsAfter: 0,
		});
		appendTurn(f.sm, "u2", "evidence ".repeat(20_000), 52_000);
		const run = engineFold(f, anchorId);
		const outcome = await commitFold(f.sm, run.input);
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
		assert.ok(outcome.foldEstimateBefore > 45_000);
		assert.ok(outcome.foldEstimateAfter < outcome.foldEstimateBefore);
	});

	it("refuses a non-reducing materialization and writes nothing", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const run = engineFold(f, anchorId, {
			summaryText: `${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`,
		});
		const entryCount = f.sm.getEntries().length;
		const outcome = await commitFold(f.sm, run.input);
		assert.ok(!outcome.ok);
		assert.match(
			outcome.reason,
			/^the materialized handoff does not reduce projected context \(estimated \d+ -> \d+ tokens\); original history was kept$/,
		);
		assert.equal(f.sm.getLeafId(), run.leaf);
		assert.equal(f.sm.getEntries().length, entryCount);
		assert.equal(f.sm.getLabel(run.leaf), undefined);
	});

	it("refuses a label that became taken and writes nothing", async () => {
		const f = setup();
		const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
		const run = engineFold(f, anchorId);
		f.pi.pi.setLabel(run.leaf, "anchor:end");
		const leafBefore = f.sm.getLeafId();
		const entryCount = f.sm.getEntries().length;
		const outcome = await commitFold(f.sm, run.input);
		assert.deepEqual(outcome, {
			ok: false,
			reason: "a label 'end' now exists on the active branch",
		});
		assert.equal(f.sm.getLeafId(), leafBefore);
		assert.equal(f.sm.getEntries().length, entryCount);
	});
});

// =============================================================================
// previewFoldCommit: the read-only preparation commitFold lands
// =============================================================================
