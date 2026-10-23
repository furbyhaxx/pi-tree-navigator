import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Result of a synchronous append, including whether a failed append's cursor was restored. */
export type SessionWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; cursorRestored: boolean };

type SessionCursor = Pick<SessionManager, "getLeafId" | "branch" | "resetLeaf">;

/** Restore the in-memory cursor on failure so a later write cannot parent an unpersisted entry. */
export function trySessionWrite<T>(
  session: SessionCursor,
  write: () => T,
): SessionWriteResult<T> {
  const before = session.getLeafId();
  try {
    return { ok: true, value: write() };
  } catch (error) {
    try {
      if (session.getLeafId() !== before) {
        if (before === null) session.resetLeaf();
        else session.branch(before);
      }
      return {
        ok: false,
        error,
        cursorRestored: session.getLeafId() === before,
      };
    } catch {
      return { ok: false, error, cursorRestored: false };
    }
  }
}
