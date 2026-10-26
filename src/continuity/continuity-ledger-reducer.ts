/** Pure ledger operations, authority checks, revision stamping and retention. */

import {
	type AppliedOp,
	ContinuityError,
	ID_PREFIX,
	type ItemSource,
	type ItemStatus,
	isProtected,
	LEDGER_VERSION,
	type Ledger,
	type LedgerItem,
	type LedgerOp,
	locator,
	MAX_ITEM_TEXT_CHARS,
	MAX_LEDGER_ITEMS,
	MAX_QUOTE_CHARS,
	normalizeText,
	type OpContext,
	type OpEffect,
	type ReduceResult,
	type RejectedOp,
	USER_ORIGINS,
} from "./continuity-ledger-model.ts";
import {
	capRequired,
	invalid,
	type Normalized,
	normalizeFile,
	normalizeNewItem,
} from "./continuity-ledger-validation.ts";

export interface Work {
	items: LedgerItem[];
	nextId: number;
	/** Revision stamped on everything this transaction touches. */
	rev: number;
	changed: boolean;
	applied: AppliedOp[];
	rejected: RejectedOp[];
	evicted: string[];
}

export const begin = (ledger: Ledger): Work => ({
	items: [...ledger.items],
	nextId: ledger.nextId,
	rev: ledger.rev + 1,
	changed: false,
	applied: [],
	rejected: [],
	evicted: [],
});

export function finish(base: Ledger, work: Work): ReduceResult {
	const ledger: Ledger = work.changed
		? {
				version: LEDGER_VERSION,
				rev: work.rev,
				nextId: work.nextId,
				items: work.items,
			}
		: base;
	return {
		ledger,
		applied: work.applied,
		rejected: work.rejected,
		evicted: work.evicted,
	};
}

function find(work: Work, id: string): LedgerItem {
	const item = work.items.find((candidate) => candidate.id === id);
	if (!item) {
		throw new ContinuityError("unknown_item", `unknown ledger item ${id}`, id);
	}
	return item;
}

function replace(work: Work, item: LedgerItem): void {
	work.items = work.items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

function requireStatus(item: LedgerItem, allowed: readonly ItemStatus[], verb: string): void {
	if (!allowed.includes(item.status)) {
		throw new ContinuityError(
			"not_live",
			`cannot ${verb} ${item.id}: it is ${item.status}`,
			item.id,
		);
	}
}

function guardProtected(item: LedgerItem, ctx: OpContext, verb: string): void {
	if (isProtected(item) && !USER_ORIGINS.has(ctx.origin)) {
		throw new ContinuityError(
			"protected_item",
			`${item.id} (${item.kind}, ${item.source.origin}) is protected: ${ctx.origin} ops cannot ${verb} it`,
			item.id,
		);
	}
}

function checkCitation(item: LedgerItem, cited: string | undefined, ctx: OpContext): void {
	const reject = (why: string) =>
		new ContinuityError(
			"invalid_citation",
			`superseding protected item ${item.id} ${why}`,
			item.id,
		);
	if (!cited) throw reject("requires citing a newer user entry");
	const index = ctx.userEntryIndex?.(cited);
	const selfCited = USER_ORIGINS.has(ctx.origin) && cited === ctx.entryId;
	if (index === undefined && !selfCited) {
		throw reject(`cites ${cited}, which is not a known user entry`);
	}
	const own = item.source.entryId;
	if (own === undefined) return;
	if (cited === own) throw reject(`cites its own source entry ${cited}`);
	// An unresolvable own entry was folded off the active branch, so it is older.
	const ownIndex = ctx.userEntryIndex?.(own);
	if (index !== undefined && ownIndex !== undefined && index <= ownIndex) {
		throw reject(`cites ${cited}, which is not newer than ${own}`);
	}
}

const DEAD_STATUSES: ReadonlySet<ItemStatus> = new Set(["archived", "completed", "superseded"]);

/**
 * Drop the oldest dead item, with the items it superseded (the lineage check
 * needs both ends), and unlink it from its heir. Active and stale items stay.
 */
function evictOldestDead(work: Work): boolean {
	const oldest = work.items.find((item) => DEAD_STATUSES.has(item.status));
	if (!oldest) return false;
	const drop = new Set<string>();
	const collect = (item: LedgerItem): void => {
		if (drop.has(item.id)) return;
		drop.add(item.id);
		for (const id of item.supersedes ?? []) {
			const older = work.items.find((candidate) => candidate.id === id);
			if (older) collect(older);
		}
	};
	collect(oldest);
	work.items = work.items
		.filter((item) => !drop.has(item.id))
		.map((item) => {
			const kept = item.supersedes?.filter((id) => !drop.has(id));
			if (!kept || kept.length === item.supersedes?.length) return item;
			const { supersedes: _dropped, ...rest } = item;
			return kept.length > 0 ? { ...rest, supersedes: kept } : rest;
		});
	work.evicted.push(...drop);
	return true;
}

function create(
	work: Work,
	fields: Normalized,
	ctx: OpContext,
	supersedes: readonly LedgerItem[],
	source?: ItemSource,
): LedgerItem {
	while (work.items.length >= MAX_LEDGER_ITEMS) {
		if (!evictOldestDead(work)) {
			throw new ContinuityError(
				"ledger_full",
				`ledger holds ${MAX_LEDGER_ITEMS} active items; archive or complete one before adding another`,
			);
		}
	}
	const pinned = ctx.origin === "pin" || supersedes.some((old) => old.pinned);
	const item: LedgerItem = {
		id: `${ID_PREFIX[fields.kind]}${work.nextId}`,
		kind: fields.kind,
		text: fields.text,
		status: "active",
		source: source ?? {
			...(ctx.entryId !== undefined && { entryId: ctx.entryId }),
			origin: ctx.origin,
		},
		...(fields.quote !== undefined && { quote: fields.quote }),
		...(fields.scopeAnchor !== undefined && {
			scopeAnchor: fields.scopeAnchor,
		}),
		...(fields.file !== undefined && { file: fields.file }),
		...(supersedes.length > 0 && { supersedes: supersedes.map((o) => o.id) }),
		...(pinned && { pinned: true as const }),
		createdRev: work.rev,
		updatedRev: work.rev,
	};
	work.nextId += 1;
	work.items.push(item);
	return item;
}

function applyAdd(work: Work, op: LedgerOp & { op: "add" }, ctx: OpContext) {
	const fields = normalizeNewItem(op);
	const key = normalizeText(fields.text);
	const existing = work.items.find(
		(item) =>
			item.status === "active" && item.kind === fields.kind && normalizeText(item.text) === key,
	);
	if (existing) return applied(op, "duplicate", existing);
	if (
		fields.kind === "objective" &&
		work.items.some((i) => i.kind === "objective" && i.status === "active")
	) {
		throw invalid("an active objective exists; supersede it instead");
	}
	return applied(op, "added", create(work, fields, ctx, []));
}

function applyUpdate(work: Work, op: LedgerOp & { op: "update" }, ctx: OpContext) {
	const item = find(work, op.id);
	guardProtected(item, ctx, "rewrite");
	requireStatus(item, ["active", "stale"], "update");
	if (op.text === undefined && op.quote === undefined && !op.file) {
		throw invalid("update needs text, quote or file", item.id);
	}
	let next: LedgerItem = item;
	if (op.text !== undefined) {
		if (item.kind === "file") throw invalid("file text is derived", item.id);
		next = { ...next, text: capRequired(op.text, MAX_ITEM_TEXT_CHARS, "text") };
	}
	if (op.file !== undefined) {
		if (item.kind !== "file") throw invalid("only file items take a file", item.id);
		const file = normalizeFile(op.file);
		next = { ...next, text: locator(file), file, status: "active" };
	}
	if (op.quote !== undefined) {
		next = { ...next, quote: capRequired(op.quote, MAX_QUOTE_CHARS, "quote") };
	}
	next = { ...next, updatedRev: work.rev };
	replace(work, next);
	return applied(op, "updated", next);
}

function applySupersede(work: Work, op: LedgerOp & { op: "supersede" }, ctx: OpContext) {
	if (op.ids.length === 0 || new Set(op.ids).size !== op.ids.length) {
		throw invalid("supersede needs one or more distinct ids");
	}
	const olds = op.ids.map((id) => find(work, id));
	const fields = normalizeNewItem(op.with);
	const cited = op.citedEntryId ?? (USER_ORIGINS.has(ctx.origin) ? ctx.entryId : undefined);
	for (const old of olds) {
		requireStatus(old, ["active", "stale"], "supersede");
		if (old.kind !== fields.kind) {
			throw new ContinuityError(
				"wrong_kind",
				`${old.id} is a ${old.kind}; its replacement must be one too, not a ${fields.kind}`,
				old.id,
			);
		}
		if (isProtected(old)) checkCitation(old, cited, ctx);
	}
	// A protected item's replacement keeps its authority: the cited user entry is the source.
	const heir = olds.find(isProtected);
	const source: ItemSource | undefined = heir && {
		...(cited !== undefined && { entryId: cited }),
		origin: heir.source.origin,
	};
	const created = create(work, fields, ctx, olds, source);
	for (const old of olds) {
		replace(work, {
			...old,
			status: "superseded",
			supersededBy: created.id,
			updatedRev: work.rev,
		});
	}
	return applied(op, "superseded", created);
}

function applyArchive(work: Work, op: LedgerOp & { op: "archive" }, ctx: OpContext) {
	const item = find(work, op.id);
	guardProtected(item, ctx, "archive");
	if (op.expectKind !== undefined && item.kind !== op.expectKind) {
		throw new ContinuityError(
			"wrong_kind",
			`${item.id} is a ${item.kind}, not ${op.expectKind}`,
			item.id,
		);
	}
	requireStatus(item, ["active", "stale", "completed"], "archive");
	const next = { ...item, status: "archived" as const, updatedRev: work.rev };
	replace(work, next);
	return applied(op, "archived", next);
}

function applyComplete(work: Work, op: LedgerOp & { op: "complete" }, ctx: OpContext) {
	const item = find(work, op.id);
	guardProtected(item, ctx, "complete");
	if (item.kind !== "objective" && item.kind !== "sub-goal") {
		throw new ContinuityError(
			"wrong_kind",
			`${item.id} is a ${item.kind}; only goals can be completed`,
			item.id,
		);
	}
	requireStatus(item, ["active"], "complete");
	const next = { ...item, status: "completed" as const, updatedRev: work.rev };
	replace(work, next);
	return applied(op, "completed", next);
}

function applyMarkStale(work: Work, op: LedgerOp & { op: "markStale" }) {
	const item = find(work, op.id);
	if (item.kind !== "file") {
		throw new ContinuityError(
			"wrong_kind",
			`${item.id} is a ${item.kind}; only file pointers go stale`,
			item.id,
		);
	}
	requireStatus(item, ["active"], "mark stale");
	const next = { ...item, status: "stale" as const, updatedRev: work.rev };
	replace(work, next);
	return applied(op, "stale", next);
}

function applyPin(work: Work, op: LedgerOp & { op: "pin" | "unpin" }, ctx: OpContext) {
	const item = find(work, op.id);
	if (!USER_ORIGINS.has(ctx.origin)) {
		throw new ContinuityError(
			"protected_item",
			`${ctx.origin} ops cannot ${op.op} ${item.id}`,
			item.id,
		);
	}
	requireStatus(item, ["active", "stale", "completed"], op.op);
	if (op.op === "pin") {
		if (item.pinned) throw invalid(`${item.id} is already pinned`, item.id);
		const next = { ...item, pinned: true as const, updatedRev: work.rev };
		replace(work, next);
		return applied(op, "pinned", next);
	}
	if (!item.pinned) throw invalid(`${item.id} is not pinned`, item.id);
	const { pinned: _pinned, ...rest } = item;
	const next: LedgerItem = { ...rest, updatedRev: work.rev };
	replace(work, next);
	return applied(op, "unpinned", next);
}

const applied = (op: LedgerOp, effect: OpEffect, item: LedgerItem): AppliedOp => ({
	op,
	effect,
	item,
});

function applyOne(work: Work, op: LedgerOp, ctx: OpContext): AppliedOp {
	switch (op.op) {
		case "add":
			return applyAdd(work, op, ctx);
		case "update":
			return applyUpdate(work, op, ctx);
		case "supersede":
			return applySupersede(work, op, ctx);
		case "archive":
			return applyArchive(work, op, ctx);
		case "complete":
			return applyComplete(work, op, ctx);
		case "markStale":
			return applyMarkStale(work, op);
		case "pin":
		case "unpin":
			return applyPin(work, op, ctx);
		default:
			throw invalid(`unknown op ${String((op as { op?: unknown }).op)}`);
	}
}

export function runOps(work: Work, ops: readonly LedgerOp[], ctx: OpContext): void {
	for (const op of ops) {
		try {
			const result = applyOne(work, op, ctx);
			work.applied.push(result);
			if (result.effect !== "duplicate") work.changed = true;
		} catch (error) {
			if (!(error instanceof ContinuityError)) throw error;
			work.rejected.push({ op, reason: error });
		}
	}
}

/**
 * Apply ops in order. Each op is atomic: a rejected op leaves the ledger as it was
 * and is reported in `rejected`; later ops still run. One call is one revision.
 */
export function applyOps(ledger: Ledger, ops: readonly LedgerOp[], ctx: OpContext): ReduceResult {
	const work = begin(ledger);
	runOps(work, ops, ctx);
	return finish(ledger, work);
}

export function createLedger(): Ledger {
	return { version: LEDGER_VERSION, rev: 0, nextId: 1, items: [] };
}
