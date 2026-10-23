import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

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

const TAIL_BYTES = 1_048_576;

/**
 * Whether every entry id reached the session file. In-memory sessions persist
 * nothing by construction, so their branch is the whole durable state.
 * Reads only the file tail: a fold appends at the end.
 */
export function persistedOnDisk(
  session: Pick<SessionManager, "getSessionFile">,
  entryIds: readonly string[],
): boolean {
  const file = session.getSessionFile();
  if (!file) return true;
  if (entryIds.length === 0) return true;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const tail = buffer.toString("utf8");
    return entryIds.every((id) => tail.includes(`"id":"${id}"`));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type SessionCursor = Pick<
  SessionManager,
  "getLeafId" | "branch" | "resetLeaf" | "getBranch"
>;

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

/** Restore the in-memory cursor on failure so a later write cannot parent an unpersisted entry. */
export function trySessionWrite<T>(
  session: SessionCursor,
  write: () => T,
): SessionWriteResult<T> {
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
