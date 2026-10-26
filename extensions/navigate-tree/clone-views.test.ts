/**
 * Tests for the clone text views: real sessions and plans on disk, rendered at
 * phone width. The judged output is the text a user reads.
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	entryIndex,
	formatCreateConfirmation,
	formatInspect,
	formatPlanOutline,
	formatPreview,
	inspectBadge,
	outlineBadge,
	planTitles,
	previewBadge,
} from "./clone-views.ts";
import { previewRetrospectiveSession } from "./retrospective.ts";
import {
	inspectRetrospectiveSession,
	readRetrospectivePlan,
	readSessionSnapshot,
} from "./retrospective-plan.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const message = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: { role: "user", content: text, timestamp: 1 },
});
const toolCall = (id: string, parentId: string | null) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: {
		role: "assistant",
		timestamp: 1,
		provider: "test",
		model: "test",
		api: "test",
		stopReason: "toolUse",
		usage: {},
		content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
	},
});

let directory: string;
let sourcePath: string;
let planPath: string;
let unfinishedPath: string;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "clone-views-"));
	const header = {
		type: "session",
		version: 3,
		id: "0198d6a4-7f3c-7b52-9c1e-123456789abc",
		cwd: directory,
		timestamp,
	};
	const rows = (...more: object[]) =>
		`${[header, ...more].map((row) => JSON.stringify(row)).join("\n")}\n`;
	sourcePath = join(directory, "source session.jsonl");
	await writeFile(
		sourcePath,
		rows(
			{
				type: "session_info",
				id: "name",
				parentId: null,
				timestamp,
				name: "Parser rewrite",
			},
			message("m1", "name", "Build the parser"),
			message("m2", "m1", "Add tests"),
			message("m3", "m2", "Verify the output"),
			message("m4", "m3", "Ship it"),
			message("m5", "m4", "Clean up"),
			message("m6", "m5", "Write the docs"),
			{
				type: "label",
				id: "l1",
				parentId: "m6",
				timestamp,
				targetId: "m2",
				label: "anchor:impl-start",
			},
			{
				type: "label",
				id: "l2",
				parentId: "l1",
				timestamp,
				targetId: "m3",
				label: "anchor:tests-green",
			},
			{
				type: "branch_summary",
				id: "bs",
				parentId: "m3",
				timestamp,
				fromId: "m6",
				summary: "Did the work.",
			},
		),
	);
	unfinishedPath = join(directory, "unfinished.jsonl");
	await writeFile(unfinishedPath, rows(message("u1", null, "Go"), toolCall("t1", "u1")));
	const inspected = await inspectRetrospectiveSession(sourcePath);
	planPath = join(directory, "plan.json");
	await writeFile(
		planPath,
		JSON.stringify({
			version: 1,
			source: "source session.jsonl",
			sourceSha256: inspected.sourceSha256,
			nameSuffix: " (clone)",
			parentHandoffMode: "full",
			groups: [
				{
					name: "design-phase",
					title: "Design: parser architecture and a title long enough to wrap",
					firstEntryId: "m1",
					lastEntryId: "m4",
					summary:
						"Designed the parser and agreed on the tokenizer interface, then verified it against fixtures from several earlier sessions.",
					state: "folded",
					children: [
						{
							name: "sketch",
							firstEntryId: "m1",
							lastEntryId: "m2",
							summary: "Sketch.",
							state: "folded",
							mode: "synthesized",
							children: [],
						},
					],
				},
				{
					name: "build",
					firstEntryId: "m5",
					lastEntryId: "m6",
					summary: "Open work.",
					state: "open",
					children: [],
				},
			],
		}),
	);
});
afterAll(() => rm(directory, { recursive: true, force: true }));

const jsonLike = /[{}]|"sourceSha256"|"previewToken"/;
const assertFits = (lines: readonly string[], width: number) => {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
	}
};

describe("inspect view", () => {
	it("states session, entries, branches, folds, anchors, tools and a short hash at 60 columns", async () => {
		const inspected = await inspectRetrospectiveSession(sourcePath);
		const lines = formatInspect(inspected, 60);
		const text = lines.join("\n");
		assertFits(lines, 60);
		assert.doesNotMatch(text, jsonLike);
		assert.match(text, /^Session\s+Parser rewrite$/m);
		assert.match(text, /^Id\s+0198d6a4-7f3c-7b52-9c1e-123456789abc$/m);
		assert.match(text, /^Entries\s+10 · 6 user turns$/m);
		assert.match(text, /^Branches\s+2 branches, 1 fork point$/m);
		assert.match(text, /^Folds\s+1 fold summary$/m);
		assert.match(text, /^Anchors\s+2: impl-start, tests-green$/m);
		assert.match(text, /^Tools\s+all calls finished$/m);
		assert.ok(text.includes(inspected.sourceSha256.slice(0, 12)));
		assert.ok(!text.includes(inspected.sourceSha256));
		assert.equal(inspectBadge(inspected), "10 entries");
	});

	it("warns about unfinished tool calls and wraps a long path under its label", async () => {
		const inspected = await inspectRetrospectiveSession(unfinishedPath);
		const lines = formatInspect(inspected, 40);
		assertFits(lines, 40);
		const text = lines.join("\n");
		assert.match(text, /^Tools\s+1 unfinished$/m);
		assert.match(text, /^Branches\s+1, linear history$/m);
		assert.match(text, /^Anchors\s+none$/m);
		assert.match(text, /^! Unfinished tool calls: call-1\./m);
		assert.ok(
			lines.some((line) => /^ {10}\S/.test(line)),
			"a wrapped value keeps the label column",
		);
	});

	it("strips terminal escapes from untrusted names", async () => {
		const inspected = await inspectRetrospectiveSession(sourcePath);
		const text = formatInspect({ ...inspected, name: "Evil\x1b[31m name\x07" }, 60).join("\n");
		assert.match(text, /^Session\s+Evil name$/m);
		assert.ok(!text.includes("\x1b"));
		assert.ok(!text.includes("\x07"));
	});
});

describe("preview view", () => {
	it("shows the groups as an indented tree with state, title, entry counts, handoff mode and descendants", async () => {
		const preview = await previewRetrospectiveSession(planPath);
		const snapshot = await readSessionSnapshot(sourcePath);
		const plan = await readRetrospectivePlan(planPath);
		const lines = formatPreview(preview, 60, {
			entryIndex: entryIndex(snapshot.entries),
			titles: planTitles(plan),
		});
		const text = lines.join("\n");
		assertFits(lines, 60);
		assert.doesNotMatch(text, jsonLike);
		assert.match(text, /^New\s+Parser rewrite \(clone\)$/m);
		assert.match(text, /^Groups\s+3: 2 folded, 1 open$/m);
		assert.match(text, /^Handoff\s+mixed \(2 full, 1 synthesized\)$/m);
		assert.match(text, /^Family\s+none$/m);
		assert.match(text, /^Entries\s+10 original \+ \d+ added$/m);
		assert.match(text, /^ {2}\[folded\] Design: parser architecture/m);
		assert.match(text, /\(4 entries, full\)/);
		assert.match(text, /^ {4}\[folded\] sketch \(2 entries, synthesized\)$/m);
		assert.match(text, /^ {2}\[open\] {3}build \(2 entries, full\)$/m);
		assert.match(text, /Designed the parser and agreed on the tokenizer…$/m);
		assert.match(text, /^! Summary accuracy is not machine-verifiable\./m);
		assert.equal(previewBadge(preview), `3 groups · +${preview.addedEntries} entries`);
	});

	it("falls back to humanized names and no counts when the source facts are missing", async () => {
		const preview = await previewRetrospectiveSession(planPath);
		const text = formatPreview(preview, 60).join("\n");
		assert.match(text, /\[folded\] design phase \(full\)$/m);
		assert.doesNotMatch(text, /\d+ entr(y|ies)[,)]/);
	});

	it("counts descendant sessions as copied or restructured", async () => {
		const preview = await previewRetrospectiveSession(planPath);
		const text = formatPreview(
			{
				...preview,
				descendants: [
					{ source: "/a.jsonl", sourceSha256: "a", mode: "copied" },
					{ source: "/b.jsonl", sourceSha256: "b", mode: "restructured" },
					{ source: "/c.jsonl", sourceSha256: "c", mode: "copied" },
				],
			},
			60,
		).join("\n");
		assert.match(text, /^Family\s+3 descendant sessions: 2 copied unchanged, 1/m);
	});

	it("keeps deeply nested groups inside the width", async () => {
		const preview = await previewRetrospectiveSession(planPath);
		const groups = Array.from({ length: 30 }, (_, depth) => ({
			...preview.groups[0],
			name: `level-${depth}`,
			depth,
		}));
		assertFits(formatPreview({ ...preview, groups }, 60), 60);
	});
});

describe("create confirmation", () => {
	it("names the source, the added entries and the untouched original, without JSON", async () => {
		const preview = await previewRetrospectiveSession(planPath);
		const text = formatCreateConfirmation(preview);
		assert.doesNotMatch(text, jsonLike);
		assert.ok(text.includes(preview.source));
		assert.match(text, /Adds \d+ entries to the 10 original: 3 groups \(2 folded, 1 open\)\./);
		assert.match(text, /The original session will remain untouched/);
	});
});

describe("plan outline", () => {
	it("shows method, cost and warnings above and below the proposed tree", async () => {
		const plan = await readRetrospectivePlan(planPath);
		const info = {
			sessionName: "Parser rewrite",
			entries: 10,
			method: "model" as const,
			calls: 2,
			cost: 0.01234,
			warnings: ["Model plan failed graph-safety validation; using the heuristic proposal."],
		};
		const lines = formatPlanOutline(plan, info, 60, {
			titles: planTitles(plan),
		});
		const text = lines.join("\n");
		assertFits(lines, 60);
		assert.doesNotMatch(text, jsonLike);
		assert.match(text, /^Session\s+Parser rewrite · 10 entries$/m);
		assert.match(text, /^Method\s+model · 2 model requests · \$0\.0123$/m);
		assert.match(text, /^ {2}\[folded\] Design: parser architecture/m);
		assert.match(text, /^! Model plan failed graph-safety validation/m);
		assert.equal(outlineBadge(plan, info), "model · 3 groups");
	});
});
