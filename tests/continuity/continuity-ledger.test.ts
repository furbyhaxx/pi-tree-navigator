/** Tests for continuity ledger. */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	archiveSteeringForAnchor,
	checkFilePointers,
	reconcileFold,
	rewindLedger,
} from "../../src/continuity/continuity-ledger.ts";
import { parseLedger, serializeLedger } from "../../src/continuity/continuity-ledger-parser.ts";
import { createLedger } from "../../src/continuity/continuity-ledger-reducer.ts";
import { AGENT, build, item, USER } from "./continuity-ledger-fixtures.ts";

describe("reconcileFold", () => {
	it("rejects each invalid delta entry by itself while valid ones still apply", () => {
		const withRule = build(
			createLedger(),
			[{ op: "add", kind: "rule", text: "Keep the public API stable" }],
			{ origin: "pin" },
		);
		const base = build(
			withRule,
			[
				{
					op: "add",
					kind: "sub-goal",
					text: "Port the parser",
					scopeAnchor: "port",
				},
				{
					op: "add",
					kind: "steering",
					text: "Skip the slow tests",
					scopeAnchor: "port",
				},
			],
			USER,
		);
		const result = reconcileFold(
			base,
			{
				completed: ["S2", "S99"],
				expiredSteering: ["R1", "T3"],
				superseded: [{ ids: ["R1"], with: { kind: "rule", text: "Break the API" } }],
				ratified: [{ kind: "decision", text: "Use a streaming parser" }],
			},
			{ anchorName: "port", origin: "classifier" },
		);
		assert.deepEqual(
			result.rejected.map((r) => [r.op.op, r.reason.code, r.reason.itemId]),
			[
				["archive", "protected_item", "R1"],
				["complete", "unknown_item", "S99"],
				["supersede", "invalid_citation", "R1"],
			],
		);
		assert.deepEqual(
			result.applied.map((a) => [a.effect, a.item.id]),
			[
				["archived", "T3"],
				["completed", "S2"],
				["added", "D4"],
			],
		);
		assert.equal(item(result.ledger, "R1").status, "active");
		assert.equal(item(result.ledger, "S2").status, "completed");
		assert.equal(item(result.ledger, "D4").source.origin, "classifier");
		assert.equal(result.ledger.rev, base.rev + 1);
	});

	it("archives the folded anchor's steering and reports it as applied", () => {
		const base = build(
			createLedger(),
			[
				{
					op: "add",
					kind: "steering",
					text: "Use the staging db",
					scopeAnchor: "impl-start",
				},
				{
					op: "add",
					kind: "steering",
					text: "Review before merge",
					scopeAnchor: "other-work",
				},
			],
			USER,
		);
		const result = reconcileFold(base, {}, { anchorName: "impl-start", origin: "agent" });
		assert.deepEqual(
			result.applied.map((a) => [a.effect, a.item.id, a.item.text]),
			[["archived", "T1", "Use the staging db"]],
		);
		assert.equal(item(result.ledger, "T1").status, "archived");
		assert.equal(item(result.ledger, "T2").status, "active");
		assert.equal(result.ledger.items.length, 2);
	});
});

describe("archiveSteeringForAnchor", () => {
	it("archives unpinned steering of the anchor, keeps pinned and others, and never deletes", () => {
		const base = build(
			createLedger(),
			[
				{ op: "add", kind: "steering", text: "A", scopeAnchor: "one" },
				{ op: "add", kind: "steering", text: "B", scopeAnchor: "one" },
				{ op: "add", kind: "steering", text: "C", scopeAnchor: "two" },
			],
			USER,
		);
		const pinned = build(base, [{ op: "pin", id: "T2" }], USER);
		const result = archiveSteeringForAnchor(pinned, "one");
		assert.deepEqual(
			result.applied.map((a) => a.item.id),
			["T1"],
		);
		assert.deepEqual(
			result.ledger.items.map((i) => i.status),
			["archived", "active", "active"],
		);
		assert.equal(archiveSteeringForAnchor(result.ledger, "one").ledger, result.ledger);
	});
});

describe("ids and rewinds", () => {
	it("never reuses an id after rewinding to an earlier snapshot", () => {
		const l0 = build(createLedger(), [{ op: "add", kind: "rule", text: "Rule one" }], USER);
		const snapshot = JSON.parse(JSON.stringify(serializeLedger(l0)));
		const l1 = build(
			l0,
			[
				{ op: "add", kind: "fact", text: "first" },
				{ op: "add", kind: "fact", text: "second" },
			],
			AGENT,
		);
		const rewound = rewindLedger(parseLedger(snapshot), l1);
		const l2 = build(rewound, [{ op: "add", kind: "fact", text: "third" }], AGENT);
		const used = l1.items.map((i) => i.id);
		assert.deepEqual(used, ["R1", "F2", "F3"]);
		assert.equal(l2.items.at(-1)?.id, "F4");
		assert.ok(l2.rev > l1.rev);
		assert.equal(l2.items.length, 2);
	});
});

describe("file pointers", () => {
	const sha = (c: string) => c.repeat(64);
	const base = build(
		createLedger(),
		[
			{
				op: "add",
				kind: "file",
				file: {
					path: "src/a.ts",
					lines: "10-40",
					sha256: sha("a"),
					why: "parser entry",
				},
			},
			{
				op: "add",
				kind: "file",
				file: { path: "src/b.ts", sha256: sha("b"), why: "config" },
			},
			{
				op: "add",
				kind: "file",
				file: { path: "src/c.ts", sha256: sha("c"), why: "gone" },
			},
			{ op: "add", kind: "file", file: { path: "src/d.ts", why: "no hash" } },
		],
		USER,
	);

	it("flags pointers whose hash differs or whose file is missing, and leaves unhashed ones alone", () => {
		const hashes: Record<string, string> = {
			"src/a.ts": sha("z"),
			"src/b.ts": sha("b"),
		};
		const result = checkFilePointers(base, (path) => hashes[path]);
		assert.deepEqual(
			result.applied.map((a) => [a.effect, a.item.id]),
			[
				["stale", "P1"],
				["stale", "P3"],
			],
		);
		assert.equal(item(result.ledger, "P1").text, "src/a.ts:10-40");
		assert.deepEqual(
			result.ledger.items.map((i) => i.status),
			["stale", "active", "stale", "active"],
		);
		const again = checkFilePointers(result.ledger, (path) => hashes[path]);
		assert.equal(again.ledger, result.ledger);
	});
});
