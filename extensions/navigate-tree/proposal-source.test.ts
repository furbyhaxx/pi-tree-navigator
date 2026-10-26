import { it } from "bun:test";
import * as assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildHeuristicPlan, buildProposalRecords } from "./proposal-source.ts";
import { parseRetrospectivePlan, type SessionSnapshot } from "./retrospective-plan.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
function snapshot(entries: SessionEntry[]): SessionSnapshot {
	return {
		path: "/source.jsonl",
		sha256: "a".repeat(64),
		name: "Work",
		header: { type: "session", version: 3, id: "session", timestamp, cwd: "/" },
		entries,
		safeCuts: new Set(),
		pendingToolCalls: [],
	};
}
function user(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: 0 },
	};
}

it("infers nested rewind intervals from parent/fromId and preserves an honest current tail", () => {
	const source = snapshot([
		user("a", null, "Start task"),
		user("b", "a", "Outer work"),
		user("c", "b", "Inner work"),
		{
			type: "branch_summary",
			id: "d",
			parentId: "b",
			fromId: "c",
			timestamp,
			summary: "Inner report",
		},
		user("e", "d", "Continue outer work"),
		{
			type: "branch_summary",
			id: "f",
			parentId: "a",
			fromId: "e",
			timestamp,
			summary: "Outer report",
		},
		user("g", "f", "Continue current task"),
		{
			type: "label",
			id: "h",
			parentId: "g",
			timestamp,
			targetId: "g",
			label: "anchor:work",
		},
	]);
	const plan = buildHeuristicPlan(source);
	assert.deepEqual(
		JSON.parse(JSON.stringify(parseRetrospectivePlan(plan))),
		JSON.parse(JSON.stringify(plan)),
	);
	assert.equal(plan.sourceSha256, source.sha256);
	const root = plan.groups[0];
	assert.equal(root.lastEntryId, "h");
	assert.equal(root.state, "open");
	const outer = root.children.find(
		(group) => group.firstEntryId === "b" && group.lastEntryId === "e",
	);
	assert.ok(outer);
	assert.ok(
		outer.children.some((group) => group.firstEntryId === "c" && group.lastEntryId === "c"),
	);
	const visit = (groups: typeof plan.groups): void => {
		for (const group of groups) {
			assert.equal(group.state, "open");
			assert.ok(
				["Open phase; completion is not established.", "Inner report", "Outer report"].includes(
					group.summary,
				),
			);
			assert.doesNotMatch(group.name, /anchor:|branch:/);
			visit(group.children);
		}
	};
	visit(plan.groups);
	assert.deepEqual(buildHeuristicPlan(source), plan);
});

it("serializes every branch without truncation, preserving thinking and textual data but excluding images/signatures", () => {
	const source = snapshot([
		user("root", null, "hello"),
		user("side", "root", "x".repeat(120000)),
		user("active", "root", "active"),
	]);
	const records = buildProposalRecords(source, { tools: {} });
	assert.equal(records.records.length, 3);
	assert.ok(records.records[1].text.includes("x".repeat(120000)));
	assert.equal(JSON.parse(records.records[2].text).parentId, "root");
});

it("redacts linked context replacements and resolves reused call IDs on their own ancestry", () => {
	const entries = JSON.parse(
		JSON.stringify([
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "reused",
							name: "vault",
							arguments: { text: "PRIVATE_ARG" },
						},
					],
				},
			},
			{
				type: "message",
				id: "b",
				parentId: "a",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "reused",
					toolName: "vault",
					content: [{ type: "text", text: "PRIVATE_RESULT" }],
				},
			},
			{
				type: "message",
				id: "c",
				parentId: "b",
				timestamp,
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "reused",
							name: "read",
							arguments: { text: "public argument" },
						},
					],
				},
			},
			{
				type: "message",
				id: "d",
				parentId: "c",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "reused",
					toolName: "read",
					content: [{ type: "text", text: "public result" }],
				},
			},
			{
				type: "context_edit",
				id: "e",
				parentId: "d",
				timestamp,
				targetId: "b",
				replacement: {
					content: [{ type: "text", text: "PRIVATE_EDIT_RESULT" }],
					details: { text: "PRIVATE_EDIT_DETAILS" },
				},
			},
			{
				type: "context_edit",
				id: "f",
				parentId: "e",
				timestamp,
				targetId: "a",
				replacement: { content: "PRIVATE_EDIT_CALL" },
			},
			{
				type: "context_edit",
				id: "g",
				parentId: "f",
				timestamp,
				targetId: "c",
				replacement: {
					content: [
						{
							type: "toolCall",
							id: "edit-call",
							name: "vault",
							arguments: { text: "PRIVATE_NEW_EDIT_CALL" },
						},
					],
				},
			},
		]),
	) as SessionEntry[];
	const source = snapshot(entries);
	const omitted = JSON.stringify(
		buildProposalRecords(source, { tools: { vault: "omit" } }).records,
	);
	assert.doesNotMatch(omitted, /PRIVATE_/);
	assert.match(omitted, /public result/);
	const calls = JSON.stringify(
		buildProposalRecords(source, { tools: { vault: "calls-only" } }).records,
	);
	assert.match(calls, /PRIVATE_ARG/);
	assert.doesNotMatch(calls, /PRIVATE_RESULT|PRIVATE_EDIT_RESULT|PRIVATE_EDIT_DETAILS/);
});

it("filters exact tools through call IDs, including result details, and counts binary omissions", () => {
	const entries = JSON.parse(
		JSON.stringify([
			{
				type: "message",
				id: "call",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Reasoning",
							thinkingSignature: "OPAQUE",
						},
						{
							type: "toolCall",
							id: "t",
							name: "vault",
							arguments: { secret: "ARG_SECRET" },
						},
						{
							type: "toolCall",
							id: "u",
							name: "vault-other",
							arguments: { data: "visible" },
						},
					],
				},
			},
			{
				type: "message",
				id: "result",
				parentId: "call",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "t",
					toolName: "wrong-name",
					content: [
						{ type: "text", text: "RESULT_SECRET" },
						{ type: "image", data: "IMAGE_BYTES", mimeType: "image/png" },
					],
					details: { private: "DETAIL_SECRET" },
				},
			},
		]),
	) as SessionEntry[];
	const source = snapshot(entries);
	const omitted = buildProposalRecords(source, { tools: { vault: "omit" } });
	const text = JSON.stringify(omitted.records);
	assert.doesNotMatch(text, /ARG_SECRET|RESULT_SECRET|DETAIL_SECRET|OPAQUE|IMAGE_BYTES/);
	assert.match(text, /visible/);
	assert.match(text, /Reasoning/);
	assert.match(omitted.warnings.join(" "), /2 tool call\/result/);
	assert.match(omitted.warnings.join(" "), /unrelated prose/);
	const calls = JSON.stringify(
		buildProposalRecords(source, { tools: { vault: "calls-only" } }).records,
	);
	assert.match(calls, /ARG_SECRET/);
	assert.doesNotMatch(calls, /RESULT_SECRET|DETAIL_SECRET/);
	const full = buildProposalRecords(source, { tools: {} });
	assert.match(JSON.stringify(full.records), /RESULT_SECRET/);
	assert.doesNotMatch(JSON.stringify(full.records), /IMAGE_BYTES|OPAQUE/);
	assert.match(full.warnings.join(" "), /2 non-text/);
});

it("applies bash disclosure to native shell records and their context replacements", () => {
	const source = snapshot([
		user("root", null, "Inspect shell history"),
		{
			type: "message",
			id: "shell",
			parentId: "root",
			timestamp,
			message: {
				role: "bashExecution",
				command: "PRIVATE_SHELL_COMMAND",
				output: "PRIVATE_SHELL_OUTPUT",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		},
		{
			type: "context_edit",
			id: "edit",
			parentId: "shell",
			timestamp,
			targetId: "shell",
			replacement: { content: "PRIVATE_SHELL_REPLACEMENT" },
		},
	]);
	const omitted = JSON.stringify(buildProposalRecords(source, { tools: { bash: "omit" } }).records);
	assert.doesNotMatch(omitted, /PRIVATE_SHELL_/);
	const calls = JSON.stringify(
		buildProposalRecords(source, { tools: { bash: "calls-only" } }).records,
	);
	assert.match(calls, /PRIVATE_SHELL_COMMAND/);
	assert.doesNotMatch(calls, /PRIVATE_SHELL_OUTPUT|PRIVATE_SHELL_REPLACEMENT/);
	assert.match(
		JSON.stringify(buildProposalRecords(source, { tools: {} }).records),
		/PRIVATE_SHELL_OUTPUT/,
	);
});

it("keeps deep existing history inside valid 32-level annotations with an explicit warning", () => {
	const entries: SessionEntry[] = Array.from({ length: 36 }, (_, index) =>
		user(`u${index}`, index ? `u${index - 1}` : null, `Work ${index}`),
	);
	let leaf = "u35";
	for (let index = 34; index >= 0; index--) {
		entries.push({
			type: "branch_summary",
			id: `s${index}`,
			parentId: `u${index}`,
			fromId: leaf,
			timestamp,
			summary: `Recorded phase ${index}`,
		});
		leaf = `s${index}`;
	}
	entries.push(user("tail", leaf, "Current work"));
	const source = snapshot(entries);
	const before = JSON.stringify(source.entries);
	const warnings: string[] = [];
	const plan = buildHeuristicPlan(source, (warning) => warnings.push(warning));
	assert.doesNotThrow(() => parseRetrospectivePlan(plan));
	assert.match(warnings.join(" "), /32 levels/);
	assert.equal(plan.groups[0].firstEntryId, "u0");
	assert.equal(plan.groups[0].lastEntryId, "tail");
	assert.equal(JSON.stringify(source.entries), before);
});
