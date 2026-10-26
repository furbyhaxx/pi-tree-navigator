/** Tests for continuity ledger reducer. */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	type Ledger,
	type LedgerOp,
	MAX_ITEM_TEXT_CHARS,
	MAX_LEDGER_ITEMS,
	MAX_QUOTE_CHARS,
	type OpContext,
	TRUNCATION_MARKER,
} from "../../src/continuity/continuity-ledger-model.ts";
import { parseLedger, serializeLedger } from "../../src/continuity/continuity-ledger-parser.ts";
import { applyOps, createLedger } from "../../src/continuity/continuity-ledger-reducer.ts";
import { AGENT, build, item, rejectedWith, USER } from "./continuity-ledger-fixtures.ts";

describe("protected items", () => {
	const seeded = build(
		createLedger(),
		[
			{
				op: "add",
				kind: "rule",
				text: "Never edit the lockfile",
				quote: "don't touch pnpm-lock",
			},
			{ op: "add", kind: "fact", text: "CI runs on node 22" },
		],
		USER,
	);

	for (const origin of ["agent", "classifier"] as const) {
		it(`${origin} ops cannot archive, rewrite or complete a user rule, and the rejection names it`, () => {
			const result = applyOps(
				seeded,
				[
					{ op: "archive", id: "R1" },
					{ op: "update", id: "R1", text: "Edit the lockfile freely" },
					{ op: "complete", id: "R1" },
				],
				{ origin },
			);
			assert.equal(result.applied.length, 0);
			assert.equal(result.rejected.length, 3);
			for (const { reason } of result.rejected) {
				assert.equal(reason.code, "protected_item");
				assert.equal(reason.itemId, "R1");
				assert.match(reason.message, /R1/);
			}
			assert.equal(result.ledger, seeded);
		});
	}

	it("lets the user rewrite their own rule and agents change unprotected items", () => {
		const edited = build(seeded, [{ op: "update", id: "R1", text: "Never edit lockfiles" }], {
			origin: "user",
			entryId: "e2",
		});
		assert.equal(item(edited, "R1").text, "Never edit lockfiles");
		const archived = build(seeded, [{ op: "archive", id: "F2" }], AGENT);
		assert.equal(item(archived, "F2").status, "archived");
	});

	it("protects agent items once the user pins them, and refuses agent pinning", () => {
		const withAgentRule = build(
			seeded,
			[{ op: "add", kind: "rule", text: "Prefer small commits" }],
			AGENT,
		);
		assert.equal(
			applyOps(withAgentRule, [{ op: "pin", id: "R3" }], AGENT).rejected[0]?.reason.code,
			"protected_item",
		);
		const pinned = build(withAgentRule, [{ op: "pin", id: "R3" }], USER);
		const blocked = applyOps(pinned, [{ op: "archive", id: "R3" }], AGENT);
		assert.equal(blocked.rejected[0]?.reason.itemId, "R3");
	});

	it("allows only one active objective; replacing it is a supersession", () => {
		const l1 = build(
			createLedger(),
			[{ op: "add", kind: "objective", text: "Ship the parser" }],
			USER,
		);
		const second = applyOps(l1, [{ op: "add", kind: "objective", text: "Ship the linter" }], USER);
		assert.equal(second.rejected[0]?.reason.code, "invalid_op");
		const replaced = build(
			l1,
			[
				{
					op: "supersede",
					ids: ["G1"],
					with: { kind: "objective", text: "Ship the linter" },
				},
			],
			{ origin: "user", entryId: "e2" },
		);
		assert.equal(item(replaced, "G2").status, "active");
	});
});

describe("supersession", () => {
	const entries = new Map([
		["e1", 1],
		["e5", 5],
	]);
	const ctx: OpContext = {
		origin: "classifier",
		userEntryIndex: (id) => entries.get(id),
	};
	const seeded = build(
		createLedger(),
		[{ op: "add", kind: "rule", text: "Use spaces for indentation" }],
		USER,
	);
	const replacement = {
		kind: "rule",
		text: "Use tabs for indentation",
		quote: "actually, tabs",
	} as const;

	it("accepts a newer cited user entry and records the lineage both ways", () => {
		const result = applyOps(
			seeded,
			[{ op: "supersede", ids: ["R1"], with: replacement, citedEntryId: "e5" }],
			ctx,
		);
		assert.deepEqual(result.rejected, []);
		const old = item(result.ledger, "R1");
		const heir = item(result.ledger, "R2");
		assert.equal(old.status, "superseded");
		assert.equal(old.supersededBy, "R2");
		assert.deepEqual(heir.supersedes, ["R1"]);
		assert.equal(heir.status, "active");
		assert.deepEqual(heir.source, { entryId: "e5", origin: "user" });
		assert.equal(parseLedger(serializeLedger(result.ledger)).items.length, 2);
	});

	it("rejects missing, non-user, own-source and not-newer citations", () => {
		const attempts: (string | undefined)[] = [undefined, "assistant-entry", "e1"];
		for (const citedEntryId of attempts) {
			const result = applyOps(
				seeded,
				[
					{
						op: "supersede",
						ids: ["R1"],
						with: replacement,
						...(citedEntryId && { citedEntryId }),
					},
				],
				ctx,
			);
			assert.equal(result.ledger, seeded);
			assert.ok(rejectedWith("invalid_citation", "R1")(result.rejected[0]?.reason));
		}
		const later = build(createLedger(), [{ op: "add", kind: "rule", text: "Use spaces" }], {
			origin: "user",
			entryId: "e5",
		});
		const older = applyOps(
			later,
			[{ op: "supersede", ids: ["R1"], with: replacement, citedEntryId: "e1" }],
			ctx,
		);
		assert.ok(rejectedWith("invalid_citation", "R1")(older.rejected[0]?.reason));
	});

	it("lets agents supersede unprotected items without a citation", () => {
		const l1 = build(createLedger(), [{ op: "add", kind: "fact", text: "Node 20" }], AGENT);
		const l2 = build(
			l1,
			[
				{
					op: "supersede",
					ids: ["F1"],
					with: { kind: "fact", text: "Node 22" },
				},
			],
			AGENT,
		);
		assert.equal(item(l2, "F1").supersededBy, "F2");
	});
});

describe("duplicates and caps", () => {
	it("reports an equal active item as a duplicate and returns its id without a new revision", () => {
		const l1 = build(createLedger(), [{ op: "add", kind: "rule", text: "Use  Tabs." }], USER);
		const result = applyOps(l1, [{ op: "add", kind: "rule", text: " use tabs. " }], AGENT);
		assert.deepEqual(
			result.applied.map((a) => [a.effect, a.item.id]),
			[["duplicate", "R1"]],
		);
		assert.equal(result.ledger, l1);
		const other = build(l1, [{ op: "add", kind: "fact", text: "Use Tabs." }], AGENT);
		assert.equal(other.items.length, 2);
	});

	it("truncates oversize text and quotes with a visible marker", () => {
		const l1 = build(
			createLedger(),
			[
				{
					op: "add",
					kind: "rule",
					text: "x".repeat(2000),
					quote: "q".repeat(2000),
				},
			],
			USER,
		);
		const [rule] = l1.items;
		assert.equal(rule?.text.length, MAX_ITEM_TEXT_CHARS);
		assert.ok(rule?.text.endsWith(TRUNCATION_MARKER));
		assert.equal(rule?.quote?.length, MAX_QUOTE_CHARS);
		assert.ok(rule?.quote?.endsWith(TRUNCATION_MARKER));
	});

	it("rejects additions with an explicit error once the ledger is full", () => {
		const ops: LedgerOp[] = Array.from({ length: MAX_LEDGER_ITEMS }, (_, i) => ({
			op: "add",
			kind: "fact",
			text: `fact ${i}`,
		}));
		const full = build(createLedger(), ops, AGENT);
		const result = applyOps(full, [{ op: "add", kind: "fact", text: "one more" }], AGENT);
		assert.ok(rejectedWith("ledger_full")(result.rejected[0]?.reason));
		assert.equal(result.ledger, full);
	});
});

describe("retention at the item cap", () => {
	const fill = (count: number): Ledger =>
		build(
			createLedger(),
			Array.from({ length: count }, (_, n) => ({
				op: "add" as const,
				kind: "fact" as const,
				text: `fact number ${n}`,
			})),
			AGENT,
		);

	it("evicts the oldest dead item instead of refusing, and the ledger stays parseable", () => {
		const full = build(fill(MAX_LEDGER_ITEMS), [{ op: "archive", id: "F3" }], AGENT);
		const next = applyOps(full, [{ op: "add", kind: "fact", text: "one more" }], AGENT);
		assert.deepEqual(next.rejected, []);
		assert.deepEqual(next.evicted, ["F3"]);
		assert.equal(next.ledger.items.length, MAX_LEDGER_ITEMS);
		assert.deepEqual(parseLedger(serializeLedger(next.ledger)), next.ledger);
	});

	it("evicts a superseded item and unlinks its active heir so the lineage stays valid", () => {
		const withDecision = build(
			createLedger(),
			[{ op: "add", kind: "decision", text: "use sqlite" }],
			USER,
		);
		const first = withDecision.items[0];
		assert.ok(first);
		const filled = build(
			withDecision,
			Array.from({ length: MAX_LEDGER_ITEMS - 2 }, (_, n) => ({
				op: "add" as const,
				kind: "fact" as const,
				text: `fact number ${n}`,
			})),
			AGENT,
		);
		const superseded = build(
			filled,
			[
				{
					op: "supersede",
					ids: [first.id],
					with: { kind: "decision", text: "use postgres" },
					citedEntryId: "e2",
				},
			],
			{ origin: "user", entryId: "e2" },
		);
		assert.equal(superseded.items.length, MAX_LEDGER_ITEMS);
		const next = applyOps(superseded, [{ op: "add", kind: "fact", text: "overflow" }], AGENT);
		assert.deepEqual(next.rejected, []);
		assert.deepEqual(next.evicted, [first.id]);
		const heir = next.ledger.items.find((i) => i.text === "use postgres");
		assert.ok(heir);
		assert.equal(heir.supersedes, undefined);
		assert.deepEqual(parseLedger(serializeLedger(next.ledger)), next.ledger);
	});

	it("still refuses when every item is active", () => {
		const result = applyOps(
			fill(MAX_LEDGER_ITEMS),
			[{ op: "add", kind: "fact", text: "no room" }],
			AGENT,
		);
		assert.equal(result.rejected.length, 1);
		const rejected = result.rejected[0];
		assert.ok(rejected);
		assert.ok(rejectedWith("ledger_full")(rejected.reason));
		assert.deepEqual(result.evicted, []);
	});
});
