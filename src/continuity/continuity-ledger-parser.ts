/** Strict parsing and JSON serialization of stored ledgers and proposed deltas. */

import { isValidName } from "../core/helpers.ts";
import {
	type ContinuityDelta,
	ContinuityError,
	type DeltaSupersession,
	type FilePointer,
	ID_PREFIX,
	ID_RE,
	ITEM_KINDS,
	ITEM_ORIGINS,
	ITEM_STATUSES,
	type ItemSource,
	LEDGER_VERSION,
	type Ledger,
	type LedgerItem,
	LINES_RE,
	locator,
	MAX_ITEM_TEXT_CHARS,
	MAX_LEDGER_ITEMS,
	MAX_PATH_CHARS,
	MAX_QUOTE_CHARS,
	type NewItem,
	SHA256_RE,
} from "./continuity-ledger-model.ts";

export type ParseCode = "invalid_ledger" | "invalid_delta";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readRecord(
	value: unknown,
	path: string,
	code: ParseCode,
	keys: readonly string[],
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ContinuityError(code, `${path}: expected an object`);
	}
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) {
			throw new ContinuityError(code, `${path}: unknown field "${key}"`);
		}
	}
	return value;
}

function readString(value: unknown, path: string, code: ParseCode): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContinuityError(code, `${path}: expected a non-empty string`);
	}
	return value;
}

function readStringList(value: unknown, path: string, code: ParseCode): string[] {
	if (!Array.isArray(value)) {
		throw new ContinuityError(code, `${path}: expected an array`);
	}
	return value.map((entry, i) => readString(entry, `${path}[${i}]`, code));
}

function readOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	code: ParseCode,
): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new ContinuityError(code, `${path}: expected one of ${allowed.join(", ")}`);
	}
	return value as T;
}

function readCount(value: unknown, path: string, min: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min) {
		throw new ContinuityError("invalid_ledger", `${path}: expected an integer >= ${min}`);
	}
	return value as number;
}

function readFilePointer(value: unknown, path: string, code: ParseCode): FilePointer {
	const raw = readRecord(value, path, code, ["path", "lines", "sha256", "why"]);
	const file: FilePointer = {
		path: readString(raw.path, `${path}.path`, code),
		...(raw.lines !== undefined && {
			lines: readString(raw.lines, `${path}.lines`, code),
		}),
		...(raw.sha256 !== undefined && {
			sha256: readString(raw.sha256, `${path}.sha256`, code),
		}),
		why: readString(raw.why, `${path}.why`, code),
	};
	if (file.lines !== undefined && !LINES_RE.test(file.lines)) {
		throw new ContinuityError(code, `${path}.lines: expected N or N-M`);
	}
	if (file.sha256 !== undefined && !SHA256_RE.test(file.sha256)) {
		throw new ContinuityError(code, `${path}.sha256: expected 64 hex digits`);
	}
	return file;
}

function parseNewItem(value: unknown, path: string, code: ParseCode): NewItem {
	const raw = readRecord(value, path, code, ["kind", "text", "quote", "scopeAnchor", "file"]);
	return {
		kind: readOneOf(raw.kind, ITEM_KINDS, `${path}.kind`, code),
		...(raw.text !== undefined && {
			text: readString(raw.text, `${path}.text`, code),
		}),
		...(raw.quote !== undefined && {
			quote: readString(raw.quote, `${path}.quote`, code),
		}),
		...(raw.scopeAnchor !== undefined && {
			scopeAnchor: readString(raw.scopeAnchor, `${path}.scopeAnchor`, code),
		}),
		...(raw.file !== undefined && {
			file: readFilePointer(raw.file, `${path}.file`, code),
		}),
	};
}

function parseItem(value: unknown, path: string, ledgerRev: number, nextId: number): LedgerItem {
	const code = "invalid_ledger";
	const fail = (message: string): never => {
		throw new ContinuityError(code, `${path}: ${message}`);
	};
	const raw = readRecord(value, path, code, [
		"id",
		"kind",
		"text",
		"status",
		"source",
		"quote",
		"scopeAnchor",
		"file",
		"supersedes",
		"supersededBy",
		"pinned",
		"createdRev",
		"updatedRev",
	]);
	const id = readString(raw.id, `${path}.id`, code);
	const kind = readOneOf(raw.kind, ITEM_KINDS, `${path}.kind`, code);
	if (!ID_RE.test(id) || id[0] !== ID_PREFIX[kind]) {
		fail(`id ${id} does not match kind ${kind}`);
	}
	if (Number(id.slice(1)) >= nextId) fail(`id ${id} is at or beyond nextId`);
	const text = readString(raw.text, `${path}.text`, code);
	const status = readOneOf(raw.status, ITEM_STATUSES, `${path}.status`, code);
	const src = readRecord(raw.source, `${path}.source`, code, ["entryId", "origin"]);
	const source: ItemSource = {
		...(src.entryId !== undefined && {
			entryId: readString(src.entryId, `${path}.source.entryId`, code),
		}),
		origin: readOneOf(src.origin, ITEM_ORIGINS, `${path}.source.origin`, code),
	};
	const quote = raw.quote === undefined ? undefined : readString(raw.quote, `${path}.quote`, code);
	if (quote !== undefined && quote.length > MAX_QUOTE_CHARS) {
		fail("quote exceeds the cap");
	}
	const scopeAnchor =
		raw.scopeAnchor === undefined
			? undefined
			: readString(raw.scopeAnchor, `${path}.scopeAnchor`, code);
	if (kind === "steering" && scopeAnchor === undefined) {
		fail("steering requires scopeAnchor");
	}
	if (scopeAnchor !== undefined) {
		if (kind !== "steering" && kind !== "sub-goal") {
			fail(`${kind} cannot have scopeAnchor`);
		}
		if (!isValidName(scopeAnchor)) fail("scopeAnchor is not an anchor name");
	}
	const file = raw.file === undefined ? undefined : readFilePointer(raw.file, `${path}.file`, code);
	if ((kind === "file") !== (file !== undefined)) {
		fail("file pointer is required for, and only for, file items");
	}
	if (file) {
		if (file.path.length > MAX_PATH_CHARS || file.why.length > MAX_ITEM_TEXT_CHARS) {
			fail("file pointer exceeds the caps");
		}
		if (text !== locator(file)) fail("file text must be its path[:lines] locator");
	} else if (text.length > MAX_ITEM_TEXT_CHARS) {
		fail("text exceeds the cap");
	}
	if (status === "stale" && kind !== "file") fail("only files can be stale");
	if (status === "completed" && kind !== "objective" && kind !== "sub-goal") {
		fail("only goals can be completed");
	}
	const supersedes =
		raw.supersedes === undefined
			? undefined
			: readStringList(raw.supersedes, `${path}.supersedes`, code);
	const supersededBy =
		raw.supersededBy === undefined
			? undefined
			: readString(raw.supersededBy, `${path}.supersededBy`, code);
	if ((status === "superseded") !== (supersededBy !== undefined)) {
		fail("supersededBy is required for, and only for, superseded items");
	}
	if (raw.pinned !== undefined && raw.pinned !== true) {
		fail("pinned must be true when present");
	}
	const createdRev = readCount(raw.createdRev, `${path}.createdRev`, 1);
	const updatedRev = readCount(raw.updatedRev, `${path}.updatedRev`, 1);
	if (createdRev > updatedRev || updatedRev > ledgerRev) {
		fail("revisions must satisfy createdRev <= updatedRev <= rev");
	}
	return {
		id,
		kind,
		text,
		status,
		source,
		...(quote !== undefined && { quote }),
		...(scopeAnchor !== undefined && { scopeAnchor }),
		...(file !== undefined && { file }),
		...(supersedes !== undefined && { supersedes }),
		...(supersededBy !== undefined && { supersededBy }),
		...(raw.pinned === true && { pinned: true as const }),
		createdRev,
		updatedRev,
	};
}

function checkLineage(items: readonly LedgerItem[]): void {
	const byId = new Map(items.map((item) => [item.id, item]));
	if (byId.size !== items.length) {
		throw new ContinuityError("invalid_ledger", "duplicate item ids");
	}
	const bad = (message: string) => new ContinuityError("invalid_ledger", `lineage: ${message}`);
	for (const item of items) {
		for (const oldId of item.supersedes ?? []) {
			if (byId.get(oldId)?.supersededBy !== item.id) {
				throw bad(`${item.id} supersedes ${oldId}, which does not point back`);
			}
		}
		if (item.supersededBy !== undefined) {
			const heir = byId.get(item.supersededBy);
			if (!heir?.supersedes?.includes(item.id)) {
				throw bad(`${item.id} is superseded by ${item.supersededBy}, which does not point back`);
			}
		}
	}
}

const DELTA_KEYS = ["completed", "ratified", "superseded", "expiredSteering"];

/** Strictly parse an untrusted delta object; throws `ContinuityError("invalid_delta")`. */
export function parseDelta(value: unknown): ContinuityDelta {
	const code = "invalid_delta";
	const raw = readRecord(value, "delta", code, DELTA_KEYS);
	const list = (key: string): unknown[] | undefined => {
		const entry = raw[key];
		if (entry === undefined) return undefined;
		if (!Array.isArray(entry)) {
			throw new ContinuityError(code, `delta.${key}: expected an array`);
		}
		return entry;
	};
	const ratified = list("ratified");
	const superseded = list("superseded");
	return {
		...(raw.completed !== undefined && {
			completed: readStringList(raw.completed, "delta.completed", code),
		}),
		...(ratified && {
			ratified: ratified.map((entry, i) => parseNewItem(entry, `delta.ratified[${i}]`, code)),
		}),
		...(superseded && {
			superseded: superseded.map((entry, i): DeltaSupersession => {
				const path = `delta.superseded[${i}]`;
				const item = readRecord(entry, path, code, ["ids", "with", "citedEntryId"]);
				return {
					ids: readStringList(item.ids, `${path}.ids`, code),
					with: parseNewItem(item.with, `${path}.with`, code),
					...(item.citedEntryId !== undefined && {
						citedEntryId: readString(item.citedEntryId, `${path}.citedEntryId`, code),
					}),
				};
			}),
		}),
		...(raw.expiredSteering !== undefined && {
			expiredSteering: readStringList(raw.expiredSteering, "delta.expiredSteering", code),
		}),
	};
}

/** Strictly parse a stored ledger. Throws `ContinuityError`; never returns an empty ledger for garbage. */
export function parseLedger(value: unknown): Ledger {
	const code = "invalid_ledger";
	if (!isRecord(value)) {
		throw new ContinuityError(code, "ledger: expected an object");
	}
	if (value.version !== LEDGER_VERSION) {
		throw new ContinuityError(
			"unsupported_version",
			`ledger: unsupported version ${JSON.stringify(value.version)}`,
		);
	}
	const raw = readRecord(value, "ledger", code, ["version", "rev", "nextId", "items"]);
	const rev = readCount(raw.rev, "ledger.rev", 0);
	const nextId = readCount(raw.nextId, "ledger.nextId", 1);
	if (!Array.isArray(raw.items)) {
		throw new ContinuityError(code, "ledger.items: expected an array");
	}
	if (raw.items.length > MAX_LEDGER_ITEMS) {
		throw new ContinuityError(
			code,
			`ledger.items: ${raw.items.length} exceeds the cap of ${MAX_LEDGER_ITEMS}`,
		);
	}
	const items = raw.items.map((entry, i) => parseItem(entry, `ledger.items[${i}]`, rev, nextId));
	checkLineage(items);
	return { version: LEDGER_VERSION, rev, nextId, items };
}

/** Plain-JSON copy for `branch_summary.details[LEDGER_DETAILS_KEY]`; re-validated so garbage is never persisted. */
export function serializeLedger(ledger: Ledger): Ledger {
	return parseLedger(JSON.parse(JSON.stringify(ledger)));
}
