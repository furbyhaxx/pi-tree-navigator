/**
 * Session-scoped, in-memory runtime config for /anchor settings.
 *
 * The stored root has the same shape as a `tree-navigator.json` file and is
 * passed to `loadTreeNavigatorConfig({ runtime })`, which layers it over the
 * global and project files. Nothing here touches disk: a session reload or
 * switch clears the entry and file resolution applies again.
 */

const store = new Map<string, Record<string, unknown>>();

/** The runtime root for `sessionId` (a fresh empty object when none is set). */
export function readRuntimeConfig(sessionId: string): Record<string, unknown> {
  const root = store.get(sessionId);
  return root === undefined ? {} : structuredClone(root);
}

/** Replace the runtime root for `sessionId` with a copy of `root`. */
export function writeRuntimeConfig(
  sessionId: string,
  root: Record<string, unknown>,
): void {
  store.set(sessionId, structuredClone(root));
}

/** Drop the runtime root for `sessionId`. */
export function clearRuntimeConfig(sessionId: string): void {
  store.delete(sessionId);
}
