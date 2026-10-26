/** Pi session reflection, capture and extension event emission. */

import {
	AgentSession,
	type SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Cap on captured AgentSession refs across /new + /resume + /reload cycles.
// Worst case is ~one ref per long-lived session before reaping dead WeakRefs;
// 16 leaves headroom for the deepest session-fanout pattern observed (a few
// /resume cycles on top of a couple of /new cycles) without prematurely
// reaping a still-live session. Bump if the reaper fires while a session
// is still live.
export const MAX_SESSION_REFS = 16;

const ORIG_PROMPT_KEY = Symbol.for("navigate-tree.orig-prompt");

// Two warnings: list-site (read-only path; warns about the next turn's
// context view) and rewind-site (wrote to disk; leads with that). Both
// suggest /reload first, then restart pi, in that order.
export const REFLECTION_BOOTSTRAP_WARNING_LIST =
	"⚠ reflection bootstrap missing — anchors and rewinds still work, but the next assistant turn may snapshot pre-bootstrap context. Run `/reload` (or restart pi) to recover.";
export const REFLECTION_BOOTSTRAP_WARNING_REWIND =
	"⚠ reflection bootstrap missing — the rewind landed on disk but the next assistant turn may still see the pre-rewind context. Run `/reload` (or restart pi) to recover.";

// ---------------------------------------------------------------------------
// Typed views over pi internals.
//
// pi-coding-agent doesn't expose `agent`, `state`, `prepareNextTurn`, or
// `sessionManager` on `AgentSession` in its public types, but they are plain
// (non-`#`-private) fields on the class. Each cast point is a fragility
// surface for pi version bumps; grouping them here makes the dependency
// surface explicit.
// ---------------------------------------------------------------------------

export interface PiInternals {
	agent: {
		state: {
			messages: unknown[];
		};
	};
	/**
	 * Plain field on `AgentSession` (#79). Used only to emit `session_tree`
	 * after a rewind, mirroring pi's own `navigateTree`, so extensions that
	 * mirror the conversation (pi-claude-bridge's Claude Code session) rebuild
	 * from the rewound chain instead of continuing on their stale copy.
	 */
	_extensionRunner?: {
		emit?: (event: unknown) => Promise<unknown> | unknown;
	};
	sessionManager: SessionManager;
	/**
	 * Plain field on `AgentSession` in pi 1.3.0 (#101, S3): the live settings
	 * pi decides compaction from. Optional: older pi versions may lack it.
	 */
	settingsManager?: SettingsManager;
	// Pi applies a forced prompt after extension context transforms.
	_runSystemPromptOptions?: { forceSystemPrompt?: string };
}

export function asInternals(session: AgentSession): PiInternals {
	return session as unknown as PiInternals;
}

// =============================================================================
// Reflection bootstrap & in-loop refresh
// =============================================================================

const sessionInstances: WeakRef<AgentSession>[] = [];
let seenSessions = new WeakSet<AgentSession>();

export function captureSession(session: AgentSession): void {
	if (seenSessions.has(session)) return;
	seenSessions.add(session);
	sessionInstances.push(new WeakRef(session));
	// Reap dead WeakRefs occasionally so the array doesn't grow unbounded
	// across /new and /resume cycles.
	if (sessionInstances.length > MAX_SESSION_REFS) {
		for (let i = sessionInstances.length - 1; i >= 0; i--) {
			if (!sessionInstances[i].deref()) sessionInstances.splice(i, 1);
		}
	}
}

export function patchAgentSessionPrototype(): void {
	const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
	// Stash the truly-original prompt the FIRST time we patch. On subsequent
	// /reloads the value is already there — we don't overwrite, we just read it
	// back so the new wrapper still calls the original (not a previous wrapper).
	if (!proto[ORIG_PROMPT_KEY]) {
		proto[ORIG_PROMPT_KEY] = proto.prompt;
	}
	const orig = proto[ORIG_PROMPT_KEY] as (...args: unknown[]) => unknown;

	// Always replace the wrapper, even if a previous load already patched. On
	// /reload the previous wrapper closes over the previous module's
	// `sessionInstances` — if we don't replace, captures land in the dead
	// module and reflection finds nothing.
	const patched = function (this: AgentSession, ...args: unknown[]) {
		captureSession(this);
		return orig.apply(this, args);
	};
	proto.prompt = patched;
}

export function findOwningSession(sm: SessionManager): AgentSession | null {
	for (const ref of sessionInstances) {
		const s = ref.deref();
		if (s && asInternals(s).sessionManager === sm) {
			return s;
		}
	}
	return null;
}

export function refreshAgentMessages(sm: SessionManager): boolean {
	// Manually replicate the agent-state refresh that pi's
	// commandCtx.navigateTree does after branchWithSummary. Returns true on
	// success, false if reflection couldn't find the owning AgentSession (in
	// which case the rewind is structurally complete on disk, but the next LLM
	// call will still see stale messages).
	const session = findOwningSession(sm);
	if (!session) return false;
	try {
		const sessionContext = sm.buildSessionContext();
		const agent = asInternals(session).agent;
		if (!agent?.state) return false;
		agent.state.messages = sessionContext.messages;
		return true;
	} catch {
		return false;
	}
}

export async function emitSessionTree(
	sm: SessionManager,
	oldLeafId: string | null,
	summaryId: string,
): Promise<boolean> {
	// Replicate the `session_tree` emit that pi's own `navigateTree` does after
	// `branchWithSummary` (#79). A tool-driven rewind skips it, so extensions
	// that mirror the conversation never learn the history was rewritten:
	// pi-claude-bridge keeps resuming its Claude Code session with the full
	// pre-rewind context. Returns false when the runner is unreachable or a
	// handler throws; the rewind itself is already complete either way.
	const session = findOwningSession(sm);
	const runner = session ? asInternals(session)._extensionRunner : undefined;
	if (typeof runner?.emit !== "function") return false;
	try {
		await runner.emit({
			type: "session_tree",
			newLeafId: sm.getLeafId(),
			oldLeafId,
			summaryEntry: sm.getEntry(summaryId),
			fromExtension: true,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Emit `session_compact` for a compaction the extension appended, as pi does
 * after its own. History-mirroring providers rebuild from it. False when the
 * runner is unreachable or a handler throws; the compaction is written either way.
 */
export async function emitSessionCompact(
	sm: SessionManager,
	compactionId: string,
): Promise<boolean> {
	const session = findOwningSession(sm);
	const runner = session ? asInternals(session)._extensionRunner : undefined;
	if (typeof runner?.emit !== "function") return false;
	try {
		await runner.emit({
			type: "session_compact",
			compactionEntry: sm.getEntry(compactionId),
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		return true;
	} catch {
		return false;
	}
}

export function resetPrototype(): void {
	const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
	const orig = proto[ORIG_PROMPT_KEY];
	if (typeof orig === "function") {
		proto.prompt = orig;
		delete proto[ORIG_PROMPT_KEY];
	}
	sessionInstances.length = 0;
	// WeakSet has no .clear(); rebind to a fresh instance so a test that
	// re-captures the SAME session identity post-reset isn't deduped by
	// stale state from the previous test's capture.
	seenSessions = new WeakSet();
}

export function sessionRefCount(): number {
	return sessionInstances.length;
}
