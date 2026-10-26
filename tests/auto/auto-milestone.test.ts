import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildAutoMilestoneEvidence } from "../../src/auto/auto-milestone.ts";
import { MAX_MILESTONE_RECORDS } from "../../src/auto/milestone-classifier.ts";
import {
	CONTINUITY_OPS_CUSTOM_TYPE,
	type StoredOp,
} from "../../src/continuity/continuity-store.ts";
import { makeHandoff } from "../../src/fold/handoff.ts";
import type { ProposalToolMode } from "../../src/retrospective/proposal-options.ts";

const user = (content: string) => ({
	role: "user" as const,
	content,
	timestamp: 1,
});
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const said = (text: string) => assistant([{ type: "text", text }]);
function evidence(sm: SessionManager, tools: Record<string, ProposalToolMode> = {}) {
	const leafId = sm.getLeafId();
	assert.ok(leafId);
	return buildAutoMilestoneEvidence({
		entries: sm.getEntries(),
		leafId,
		getLabel: (id) => sm.getLabel(id),
		tools,
	});
}

test("only active projected readable bodies are evidence, with persisted IDs", () => {
	const sm = SessionManager.inMemory();
	const root = sm.appendMessage(user("request"));
	sm.appendMessage(said("ABANDONED"));
	sm.branch(root);
	const hidden = sm.appendMessage(said("HIDDEN"));
	const edited = sm.appendMessage(said("ORIGINAL"));
	sm.appendContextEdit(hidden, null);
	sm.appendContextEdit(edited, { content: "edited visible answer" });
	sm.appendCustomMessageEntry("internal", "HIDDEN_CUSTOM", false);
	const newest = sm.appendMessage(
		assistant([
			{
				type: "thinking",
				thinking: "THINKING",
				thinkingSignature: "SIGNATURE",
			},
			{ type: "text", text: "verified and done" },
		]),
	);
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "image",
		toolName: "read",
		content: [{ type: "image", data: "IMAGE_BYTES", mimeType: "image/png" }],
		isError: false,
		timestamp: 1,
	});
	const result = evidence(sm);
	const text = JSON.stringify(result.input);
	for (const secret of ["ABANDONED", "HIDDEN", "ORIGINAL", "THINKING", "SIGNATURE", "IMAGE_BYTES"])
		assert.ok(!text.includes(secret), secret);
	assert.equal(
		result.input.records.find((record) => record.id === edited)?.text,
		"edited visible answer",
	);
	assert.equal(result.input.records.at(-1)?.id, newest);
	assert.equal(result.recordEntryIds.get(newest), newest);
	assert.ok(!result.recordEntryIds.has(hidden));
});

test("tool disclosure covers edited results, mismatched names and native shell", () => {
	for (const mode of ["full", "calls-only", "omit"] as const) {
		const sm = SessionManager.inMemory();
		sm.appendMessage(
			assistant([
				{
					type: "toolCall",
					id: "call",
					name: "read",
					arguments: { path: "CALL_ARGUMENT" },
				},
			]),
		);
		const resultId = sm.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "alias",
			content: [{ type: "text", text: "ORIGINAL_RESULT" }],
			details: { secret: "DETAILS" },
			isError: false,
			timestamp: 1,
		});
		sm.appendContextEdit(resultId, { content: "EDITED_RESULT" });
		sm.appendMessage({
			role: "bashExecution",
			command: "SHELL_COMMAND",
			output: "SHELL_OUTPUT",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		const result = evidence(sm, { read: mode, bash: mode });
		const text = result.input.records.map((record) => record.text).join("\n");
		assert.ok(!text.includes("ORIGINAL_RESULT"));
		assert.ok(!text.includes("DETAILS"));
		assert.equal(text.includes("EDITED_RESULT"), mode === "full");
		assert.equal(text.includes("SHELL_OUTPUT"), mode === "full");
		assert.equal(text.includes("SHELL_COMMAND"), mode !== "omit");
		assert.equal(text.includes("CALL_ARGUMENT"), mode !== "omit");
		assert.equal(result.input.records.find((record) => record.id === resultId)?.role, "tool");
		if (mode !== "full") {
			assert.match(text, /withheld/);
			assert.ok(result.notices.some((notice) => notice.includes("disclosure")));
		}
	}
});

test("edited excluded tool calls cannot reappear as replacement prose", () => {
	const sm = SessionManager.inMemory();
	const call = sm.appendMessage(
		assistant([
			{
				type: "toolCall",
				id: "call",
				name: "read",
				arguments: { path: "SECRET" },
			},
		]),
	);
	sm.appendContextEdit(call, { content: "SECRET_REPLACEMENT" });
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "alias",
		content: [{ type: "text", text: "SECRET_RESULT" }],
		isError: false,
		timestamp: 1,
	});
	const result = evidence(sm, { read: "omit" });
	assert.ok(!JSON.stringify(result).includes("SECRET"));
	assert.match(result.input.records[0].text, /withheld/);
});

test("newest bounded phase retains objective, active goals, anchors and prior fold facts", () => {
	const sm = SessionManager.inMemory();
	const root = sm.appendMessage(user("Build the adapter"));
	sm.appendMessage(said("ARCHIVED_WORK"));
	const handoff = makeHandoff({
		name: "prior",
		title: "Prior work",
		goal: "prepare",
		outcome: "ready",
		report: "PRIOR_REPORT",
		mode: "full",
		children: [],
		sourceEntries: [],
	});
	sm.branchWithSummary(root, handoff.report, { treeNavigator: handoff });
	const ops: StoredOp[] = [
		{
			op: { op: "add", kind: "objective", text: "Build the adapter" },
			ctx: { origin: "user", entryId: root },
		},
		{
			op: { op: "add", kind: "sub-goal", text: "Verify evidence" },
			ctx: { origin: "agent" },
		},
		{
			op: { op: "add", kind: "sub-goal", text: "Already complete" },
			ctx: { origin: "agent" },
		},
	];
	sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, { ops });
	sm.appendCustomEntry(CONTINUITY_OPS_CUSTOM_TYPE, {
		ops: [{ op: { op: "complete", id: "S3" }, ctx: { origin: "agent" } }] satisfies StoredOp[],
	});
	const anchor = sm.appendMessage(said("PRE_ANCHOR_WORK"));
	sm.appendLabelChange(anchor, "anchor:prepared");
	const ids = Array.from({ length: MAX_MILESTONE_RECORDS + 3 }, (_, i) =>
		sm.appendMessage(said(`phase record ${i}`)),
	);
	const result = evidence(sm);
	assert.equal(result.input.lastAnchor, "prepared");
	assert.equal(result.input.records.length, MAX_MILESTONE_RECORDS);
	assert.deepEqual([...result.recordEntryIds.values()], ids.slice(3));
	assert.equal(result.input.structure?.objective, "Build the adapter");
	assert.deepEqual(result.input.structure?.goals, ["Verify evidence"]);
	assert.deepEqual(result.input.structure?.anchors, [{ name: "prepared" }]);
	assert.deepEqual(result.input.structure?.folds, [
		{ label: "prior", title: "Prior work", goal: "prepare", outcome: "ready" },
	]);
	for (const hidden of ["ARCHIVED_WORK", "PRE_ANCHOR_WORK", "PRIOR_REPORT"])
		assert.ok(!JSON.stringify(result.input).includes(hidden));
	assert.match(result.notices.join("\n"), /3 older milestone records omitted/);
});

test("compacted originals do not return as evidence", () => {
	const sm = SessionManager.inMemory();
	sm.appendMessage(user("COMPACTED_ORIGINAL"));
	const kept = sm.appendMessage(user("kept request"));
	sm.appendCompaction("COMPACTION_SUMMARY", kept, 100);
	const newest = sm.appendMessage(said("current answer"));
	const result = evidence(sm);
	assert.deepEqual(
		result.input.records.map((record) => record.id),
		[kept, newest],
	);
	assert.ok(!JSON.stringify(result.input).includes("COMPACTED_ORIGINAL"));
});
