/** Tests for continuity ledger parser. */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	type ContinuityErrorCode,
	MAX_LEDGER_ITEMS,
} from "../../src/continuity/continuity-ledger-model.ts";
import { parseLedger, serializeLedger } from "../../src/continuity/continuity-ledger-parser.ts";
import { createLedger } from "../../src/continuity/continuity-ledger-reducer.ts";
import { build, rejectedWith, USER } from "./continuity-ledger-fixtures.ts";

describe("parseLedger and serialization", () => {
	const rich = (() => {
		let ledger = build(
			createLedger(),
			[
				{
					op: "add",
					kind: "objective",
					text: "Ship the parser",
					quote: "ship it",
				},
				{ op: "add", kind: "rule", text: "Use tabs" },
				{
					op: "add",
					kind: "steering",
					text: "Skip slow tests",
					scopeAnchor: "impl",
				},
				{
					op: "add",
					kind: "file",
					file: { path: "src/a.ts", sha256: "a".repeat(64), why: "entry" },
				},
			],
			USER,
		);
		ledger = build(ledger, [{ op: "pin", id: "T3" }], USER);
		return build(
			ledger,
			[
				{
					op: "supersede",
					ids: ["R2"],
					with: { kind: "rule", text: "Use spaces" },
				},
			],
			{ origin: "user", entryId: "e2" },
		);
	})();

	it("round-trips through plain JSON", () => {
		const stored = JSON.parse(JSON.stringify({ continuity: serializeLedger(rich) }));
		assert.deepEqual(parseLedger(stored.continuity), rich);
	});

	const garbage: [string, unknown, ContinuityErrorCode][] = [
		["undefined", undefined, "invalid_ledger"],
		["a string", JSON.stringify(rich), "invalid_ledger"],
		["an array", [], "invalid_ledger"],
		["an empty object", {}, "unsupported_version"],
		["version 2", { ...rich, version: 2 }, "unsupported_version"],
		["missing items", { version: 1, rev: 0, nextId: 1 }, "invalid_ledger"],
		["a negative rev", { ...rich, rev: -1 }, "invalid_ledger"],
		["an unknown field", { ...rich, extra: true }, "invalid_ledger"],
		[
			"a stray item field",
			{
				...rich,
				items: [{ ...rich.items[0], note: "x" }, ...rich.items.slice(1)],
			},
			"invalid_ledger",
		],
		["an id at nextId", { ...rich, nextId: 2 }, "invalid_ledger"],
		[
			"a kind/id mismatch",
			{
				...rich,
				items: [{ ...rich.items[0], id: "R1" }, ...rich.items.slice(1)],
			},
			"invalid_ledger",
		],
		["duplicate ids", { ...rich, items: [rich.items[0], rich.items[0]] }, "invalid_ledger"],
		[
			"a one-way lineage",
			{
				...rich,
				items: rich.items.map((i) =>
					i.id === "R2" ? { ...i, supersededBy: undefined, status: "active" } : i,
				),
			},
			"invalid_ledger",
		],
		[
			"an unknown status",
			{
				...rich,
				items: [{ ...rich.items[0], status: "gone" }, ...rich.items.slice(1)],
			},
			"invalid_ledger",
		],
		[
			"steering without scope",
			{
				...rich,
				items: rich.items.map((i) => {
					const { scopeAnchor: _s, ...rest } = i;
					return i.kind === "steering" ? rest : i;
				}),
			},
			"invalid_ledger",
		],
		[
			"too many items",
			{
				...rich,
				items: Array.from({ length: MAX_LEDGER_ITEMS + 1 }, () => rich.items[0]),
			},
			"invalid_ledger",
		],
	];
	for (const [name, value, code] of garbage) {
		it(`refuses ${name}`, () => {
			assert.throws(() => parseLedger(value), rejectedWith(code));
		});
	}
});
