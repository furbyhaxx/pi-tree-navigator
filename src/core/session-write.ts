import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Result of a synchronous append, including what landed and whether the cursor was restored. */
export type SessionWriteResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: unknown;
			cursorRestored: boolean;
			/** Entries that reached the branch before the failure, newest last. */
			appended: SessionEntry[];
	  };

type SessionCursor = Pick<SessionManager, "getLeafId" | "branch" | "resetLeaf" | "getBranch">;

const CHUNK_BYTES = 1_048_576;
/** Refuse to scan more than this: an unreadable tail is uncertain persistence. */
const MAX_SCAN_BYTES = 64 * 1_048_576;

/**
 * Entries the active branch gained after `leafId`; empty when that leaf is gone.
 * Used to tell a failed write from a throw that happened after the write landed.
 */
export function entriesAppendedAfter(
	session: Pick<SessionManager, "getBranch">,
	leafId: string | null,
): SessionEntry[] {
	const branch = session.getBranch();
	if (leafId === null) return branch;
	const at = branch.findIndex((entry) => entry.id === leafId);
	return at < 0 ? [] : branch.slice(at + 1);
}

/**
 * Recover the ids that are complete, parseable JSONL records in the session file.
 * Reading records rather than substrings keeps a truncated or nested mention from
 * counting as a durable write; entries larger than one read chunk are supported
 * because the scan keeps reading until the file ends.
 */
function persistedIds(file: string): Set<string> {
	const ids = new Set<string>();
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const { size } = fstatSync(fd);
		if (size > MAX_SCAN_BYTES) return ids;
		let position = 0;
		let pending = "";
		const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(size, 1)));
		while (position < size) {
			const read = readSync(fd, buffer, 0, buffer.length, position);
			if (read <= 0) break;
			position += read;
			pending += buffer.subarray(0, read).toString("utf8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const id = topLevelId(line);
				if (id !== undefined) ids.add(id);
			}
		}
		const last = topLevelId(pending);
		if (last !== undefined) ids.add(last);
		return ids;
	} catch {
		return ids;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function topLevelId(line: string): string | undefined {
	const text = line.trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const id = (parsed as { id?: unknown }).id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether every entry id is a complete record in the session file. In-memory
 * sessions persist nothing by construction, so their branch is the durable state.
 */
export function persistedOnDisk(
	session: Pick<SessionManager, "getSessionFile">,
	entryIds: readonly string[],
): boolean {
	const file = session.getSessionFile();
	if (!file) return true;
	if (entryIds.length === 0) return true;
	const ids = persistedIds(file);
	return entryIds.every((id) => ids.has(id));
}

/** Restore the in-memory cursor on failure so a later write cannot parent an unpersisted entry. */
export function trySessionWrite<T>(session: SessionCursor, write: () => T): SessionWriteResult<T> {
	const before = session.getLeafId();
	try {
		return { ok: true, value: write() };
	} catch (error) {
		let appended: SessionEntry[] = [];
		try {
			// Read before restoring: another wrapper may throw after its own append landed.
			appended = entriesAppendedAfter(session, before);
		} catch {
			appended = [];
		}
		try {
			if (session.getLeafId() !== before) {
				if (before === null) session.resetLeaf();
				else session.branch(before);
			}
			return {
				ok: false,
				error,
				cursorRestored: session.getLeafId() === before,
				appended,
			};
		} catch {
			return { ok: false, error, cursorRestored: false, appended };
		}
	}
}
