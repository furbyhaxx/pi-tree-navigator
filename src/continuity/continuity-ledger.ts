/** Fold reconciliation, steering expiry, file staleness and rewind snapshots. */

import {
	type ContinuityDelta,
	type FoldContext,
	LEDGER_VERSION,
	type Ledger,
	type LedgerItem,
	type LedgerOp,
	type OpContext,
	type ReduceResult,
} from "./continuity-ledger-model.ts";
import { applyOps, begin, finish, runOps } from "./continuity-ledger-reducer.ts";

// Deterministic operations (fold-time archiving, hash checks) carry no extra authority.
const SYSTEM_CTX: OpContext = { origin: "agent" };

const steeringArchiveOps = (items: readonly LedgerItem[], anchorName: string): LedgerOp[] =>
	items
		// Pinned steering was explicitly kept by the user, so a fold does not expire it.
		.filter(
			(item) =>
				item.kind === "steering" &&
				item.status === "active" &&
				item.scopeAnchor === anchorName &&
				!item.pinned,
		)
		.map((item) => ({
			op: "archive",
			id: item.id,
			expectKind: "steering",
		}));

/** Archive (never delete) active steering scoped to `anchorName`; each appears in `applied`. */
export function archiveSteeringForAnchor(ledger: Ledger, anchorName: string): ReduceResult {
	const work = begin(ledger);
	runOps(work, steeringArchiveOps(work.items, anchorName), SYSTEM_CTX);
	return finish(ledger, work);
}

function deltaOps(delta: ContinuityDelta): LedgerOp[] {
	return [
		...(delta.expiredSteering ?? []).map(
			(id): LedgerOp => ({ op: "archive", id, expectKind: "steering" }),
		),
		...(delta.completed ?? []).map((id): LedgerOp => ({ op: "complete", id })),
		...(delta.superseded ?? []).map(
			(entry): LedgerOp => ({
				op: "supersede",
				ids: entry.ids,
				with: entry.with,
				...(entry.citedEntryId !== undefined && {
					citedEntryId: entry.citedEntryId,
				}),
			}),
		),
		...(delta.ratified ?? []).map((item): LedgerOp => ({ op: "add", ...item })),
	];
}

/**
 * Reconcile a model-proposed delta through the normal invariants, then archive the
 * folded anchor's steering. Rejections are per op; nothing is dropped or accepted silently.
 */
export function reconcileFold(
	ledger: Ledger,
	delta: ContinuityDelta,
	foldCtx: FoldContext,
): ReduceResult {
	const work = begin(ledger);
	runOps(work, deltaOps(delta), foldCtx);
	runOps(work, steeringArchiveOps(work.items, foldCtx.anchorName), SYSTEM_CTX);
	return finish(ledger, work);
}

export function markFilePointerStale(ledger: Ledger, id: string): ReduceResult {
	return applyOps(ledger, [{ op: "markStale", id }], SYSTEM_CTX);
}

/**
 * Mark active file pointers stale when `hashOf(path)` differs from the recorded
 * sha256 (a missing file counts as different). Pointers without a hash are unchecked.
 */
export function checkFilePointers(
	ledger: Ledger,
	hashOf: (path: string) => string | undefined,
): ReduceResult {
	const ops: LedgerOp[] = ledger.items
		.filter(
			(item) =>
				item.kind === "file" &&
				item.status === "active" &&
				item.file?.sha256 !== undefined &&
				hashOf(item.file.path) !== item.file.sha256,
		)
		.map((item) => ({ op: "markStale", id: item.id }));
	return applyOps(ledger, ops, SYSTEM_CTX);
}

/**
 * Replace the active ledger with an earlier snapshot (a rewind) without letting the
 * id counter or revision go backwards past what the abandoned ledger already issued.
 */
export function rewindLedger(snapshot: Ledger, abandoned: Ledger): Ledger {
	return {
		version: LEDGER_VERSION,
		rev: Math.max(snapshot.rev, abandoned.rev) + 1,
		nextId: Math.max(snapshot.nextId, abandoned.nextId),
		items: snapshot.items,
	};
}
