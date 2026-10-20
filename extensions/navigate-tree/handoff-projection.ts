import {
  type SessionEntry,
  SessionManager,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { handoffContext } from "./handoff.ts";

/** Project work handoffs and invalidate historical context measurements without changing accounting. */
export function projectHandoffs(
  projection: SessionProjection,
  entries: readonly SessionEntry[],
): SessionProjection {
  const provenance = entries.findLast(
    (entry) =>
      entry.type === "custom" && entry.customType === "tree-clone-provenance",
  );
  let originalIds: readonly unknown[] = [];
  if (
    provenance?.type === "custom" &&
    typeof provenance.data === "object" &&
    provenance.data !== null &&
    "history" in provenance.data
  ) {
    const history = provenance.data.history;
    if (
      typeof history === "object" &&
      history !== null &&
      "sourceOrder" in history &&
      Array.isArray(history.sourceOrder)
    )
      originalIds = history.sourceOrder;
  }
  const historical = new Set(originalIds);
  const projected = projection.entries.map((entry) => {
    const messages = handoffContext(entry.sourceEntry, entry.messages).map(
      (message) => {
        if (
          !historical.has(entry.sourceEntry.id) ||
          message.role !== "assistant"
        )
          return message;
        return {
          ...message,
          usage: {
            ...message.usage,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        };
      },
    );
    return { ...entry, messages };
  });
  return {
    ...projection,
    entries: projected,
    messages: projected.flatMap((entry) => entry.messages),
  };
}

const originalKey = Symbol.for("pi-tree-navigator.session-projection.original");
type ProjectionMethod = SessionManager["buildSessionProjection"] & {
  [originalKey]?: SessionManager["buildSessionProjection"];
};

/** Patch the shared host manager so native pre-request estimation sees the same safe projection. */
export function installHandoffProjection(): () => void {
  const previous: ProjectionMethod =
    SessionManager.prototype.buildSessionProjection;
  const original = previous[originalKey] ?? previous;
  const replacement: ProjectionMethod = function (this: SessionManager) {
    return projectHandoffs(original.call(this), this.getEntries());
  };
  replacement[originalKey] = original;
  SessionManager.prototype.buildSessionProjection = replacement;
  return () => {
    if (SessionManager.prototype.buildSessionProjection === replacement)
      SessionManager.prototype.buildSessionProjection = original;
  };
}
