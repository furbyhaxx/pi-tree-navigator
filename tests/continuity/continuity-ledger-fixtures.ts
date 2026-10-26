/** Shared ledger builders and assertions for continuity tests. */

import * as assert from "node:assert/strict";
import {
	ContinuityError,
	type ContinuityErrorCode,
	type Ledger,
	type LedgerOp,
	type OpContext,
} from "../../src/continuity/continuity-ledger-model.ts";
import { applyOps } from "../../src/continuity/continuity-ledger-reducer.ts";

export const USER: OpContext = { origin: "user", entryId: "e1" };
export const AGENT: OpContext = { origin: "agent" };

export function build(ledger: Ledger, ops: readonly LedgerOp[], ctx: OpContext): Ledger {
	const result = applyOps(ledger, ops, ctx);
	assert.deepEqual(result.rejected, []);
	return result.ledger;
}

export const item = (ledger: Ledger, id: string) => {
	const found = ledger.items.find((candidate) => candidate.id === id);
	assert.ok(found, `missing ${id}`);
	return found;
};

export const rejectedWith = (code: ContinuityErrorCode, itemId?: string) => (e: unknown) =>
	e instanceof ContinuityError && e.code === code && (itemId === undefined || e.itemId === itemId);
