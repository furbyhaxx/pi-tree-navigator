import { test } from "bun:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectRetrospectiveSession,
	readSessionSnapshot,
} from "../../src/retrospective/retrospective-plan.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
type Row = {
	id: string;
	parentId: string | null;
	type: string;
	[key: string]: unknown;
};
const call = (id: string, parentId: string | null): Row => ({
	id,
	parentId,
	type: "message",
	message: {
		role: "assistant",
		timestamp: 1,
		provider: "test",
		model: "test",
		api: "test",
		stopReason: "toolUse",
		usage: {},
		content: [{ type: "toolCall", id: "reused", name: "test", arguments: {} }],
	},
});
const result = (id: string, parentId: string): Row => ({
	id,
	parentId,
	type: "message",
	message: {
		role: "toolResult",
		timestamp: 1,
		toolCallId: "reused",
		toolName: "test",
		isError: false,
		content: [],
	},
});
const summary = (id: string, parentId: string, fromId: string): Row => ({
	id,
	parentId,
	fromId,
	type: "branch_summary",
	summary: "Completed work.",
});
async function fixture(rows: Row[], run: (path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "snapshot-test-"));
	try {
		const path = join(dir, "source.jsonl");
		await writeFile(
			path,
			`${[
				{ type: "session", version: 3, id: "session", timestamp, cwd: dir },
				...rows.map((row) => ({ timestamp, ...row })),
			]
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		await run(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("native rewinds carry exact occurrence evidence, including transitive summaries", async () => {
	await fixture(
		[
			call("call", null),
			result("result", "call"),
			summary("rewind-one", "call", "result"),
			summary("rewind-two", "call", "result"),
			summary("transitive", "call", "rewind-one"),
			call("new-call", "transitive"),
			summary("unresolved", "new-call", "result"),
			summary("root", "call", "root"),
		],
		async (path) => {
			const snapshot = await readSessionSnapshot(path);
			assert.deepEqual([...snapshot.safeCuts], [-1, 1, 2, 3, 4]);
			assert.deepEqual(snapshot.pendingToolCalls, ["reused"]);
			const graph = (await inspectRetrospectiveSession(path)).graph;
			assert.deepEqual(graph.branchingPoints, ["call"]);
			assert.deepEqual(graph.leaves, ["result", "rewind-one", "rewind-two", "unresolved", "root"]);
		},
	);
});

test("sibling result resolves global unfinished status but leaves cuts branch-local", async () => {
	await fixture(
		[
			call("call", null),
			result("result", "call"),
			{ id: "sibling", parentId: "call", type: "custom", customType: "test" },
		],
		async (path) => {
			const snapshot = await readSessionSnapshot(path);
			assert.deepEqual(snapshot.pendingToolCalls, []);
			assert.deepEqual([...snapshot.safeCuts], [-1, 1]);
		},
	);
});

test("a reused provider ID completes independently after a rewind", async () => {
	await fixture(
		[
			call("first", null),
			result("first-result", "first"),
			summary("rewind", "first", "first-result"),
			call("second", "rewind"),
			result("second-result", "second"),
			summary("second-rewind", "second", "second-result"),
		],
		async (path) => {
			const snapshot = await readSessionSnapshot(path);
			assert.deepEqual(snapshot.pendingToolCalls, []);
			assert.deepEqual([...snapshot.safeCuts], [-1, 1, 2, 4, 5]);
		},
	);
});

test("orphan results cannot borrow completion from another branch", async () => {
	await fixture(
		[call("call", null), result("result", "call"), result("orphan", "result")],
		async (path) => {
			await assert.rejects(readSessionSnapshot(path), /Orphan tool result orphan/);
		},
	);
});

test("30k completed-history rows inspect inside a 256 MiB isolated heap", async () => {
	const rows: Row[] = [];
	let parentId: string | null = null;
	for (let i = 0; i < 10_000; i++) {
		rows.push(call(`call-${i}`, parentId), result(`result-${i}`, `call-${i}`), {
			id: `meta-${i}`,
			parentId: `result-${i}`,
			type: "custom",
			customType: "test",
		});
		parentId = `meta-${i}`;
	}
	await fixture(rows, async (path) => {
		const moduleUrl = new URL("../../src/retrospective/retrospective-plan.ts", import.meta.url)
			.href;
		const child = spawnSync(
			process.execPath,
			[
				"--max-old-space-size=256",
				"--input-type=module",
				"-e",
				`import { inspectRetrospectiveSession } from ${JSON.stringify(moduleUrl)};
       const view = await inspectRetrospectiveSession(process.argv[1]);
       if (view.entries !== 30000 || view.pendingToolCalls.length || !view.graph.linear || view.graph.leaves.length !== 1) process.exit(1);
       console.log(JSON.stringify({ maxRSSKiB: process.resourceUsage().maxRSS, heapUsed: process.memoryUsage().heapUsed }));`,
				path,
			],
			{ encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr);
		console.info(child.stdout.trim());
	});
});
