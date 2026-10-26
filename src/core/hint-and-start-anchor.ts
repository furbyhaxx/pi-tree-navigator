/** Rewind reserve hints and automatic start-anchor writes. */

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionManager,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { START_ANCHOR_LABEL } from "../fold/fold-policy.ts";
import { formatActiveAnchors } from "./anchors.ts";
import { resolveRewindHintReserve, START_ANCHOR_DEFAULT_TURNS } from "./config.ts";
import { TOOL_NAME } from "./helpers.ts";
import type { NavigatorState } from "./navigator-state.ts";
import type { createPiCompactionController } from "./pi-compaction.ts";
import { findLabeledEntry } from "./projection.ts";
import { estimateAdmissionTokens, overflowed } from "./request-accounting.ts";
import {
	buildNoAnchorText,
	buildRewindHintText,
	REWIND_COMPACTION_OFF_TEXT,
	REWIND_HINT_CUSTOM_TYPE,
} from "./rewind-hint.ts";

/** Hint and anchor state with live Pi delivery and compaction settings. */
export interface HintDeps {
	pi: ExtensionAPI;
	state: Pick<NavigatorState, "activity" | "anchors" | "config" | "turns">;
	piCompaction: ReturnType<typeof createPiCompactionController>["piCompaction"];
}

/** Creates hint and start-anchor operations without registering handlers or starting work. */
export function createHintController({ pi, state, piCompaction }: HintDeps) {
	// Auto start anchor (#55): silent `anchor:start` write, shared by the
	// `turn_end` trigger and the `agent_end` fallback. `completedTurns` is the
	// number of finished turns in the current agent run
	// (`Number.POSITIVE_INFINITY` for the run-end fallback). Fail-open
	// everywhere: any read/write failure leaves the session unsettled so the
	// next turn or run end retries, and nothing throws into the agent loop.
	function writeStartAnchorIfNeeded(sm: SessionManager, completedTurns: number): void {
		// Kill switch read at write time:
		// a mid-process change applies without an extension reload.
		if (process.env.PI_NAVIGATE_TREE_START_ANCHOR === "0") return;
		let sessionId: string;
		try {
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		// Per-session tool gate (#55): a sibling session's `before_agent_start`
		// (e.g. a subagent whose tool subset omits `navigate_tree`) must not
		// clear this session's gate. Absent = fail-open until a gate is set.
		if (state.activity.toolActiveBySession.get(sessionId) === false) return;
		if (state.anchors.anchorStartSettled.has(sessionId)) return;
		// Per-session threshold (#55): two sessions started with different
		// project configs must not share one closure value.
		const startAfterTurns =
			state.anchors.anchorStartTurnsBySession.get(sessionId) ?? START_ANCHOR_DEFAULT_TURNS;
		if (completedTurns < startAfterTurns) return;
		try {
			// The existence check is authoritative: a `start` already on the
			// active branch (manual `/tree` label, pre-reload write, prior
			// settle) wins and settles the session without another write.
			if (findLabeledEntry(sm, START_ANCHOR_LABEL)) {
				state.anchors.anchorStartSettled.add(sessionId);
				return;
			}
		} catch {
			return;
		}
		let leafId: string | null;
		try {
			leafId = sm.getLeafId();
		} catch {
			return;
		}
		if (!leafId) return;
		try {
			pi.setLabel(leafId, START_ANCHOR_LABEL);
			state.anchors.anchorStartSettled.add(sessionId);
		} catch {
			// Loader-level setLabel can throw on a stale runtime while the
			// captured SessionManager still writes; same fallback shape as the
			// hint's appendCustomMessageEntry path. A successful direct append
			// settles; a missing or throwing append stays unsettled and retries
			// later (an optional call on a missing method must NOT read as a
			// successful write).
			try {
				const append = (sm as Partial<SessionManager>).appendLabelChange;
				if (typeof append !== "function") return;
				append.call(sm, leafId, START_ANCHOR_LABEL);
				state.anchors.anchorStartSettled.add(sessionId);
			} catch {
				// Fail-open: never throw into the agent loop.
			}
		}
	}

	// Rewind hint (#44): one check per turn, after the turn's tool results and
	// before the agent loop's steering drain — so a `pi.sendMessage` from this
	// handler is delivered in the same run. Synchronous by design: no await
	// before any ctx use. Fires once per reserve crossing; see
	// `RewindHintTracker` for the re-arm semantics.
	function onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
		// Single `sessionManager` capture shared by the auto start-anchor and
		// the rewind hint: the stale-ctx contract is exactly one read, before
		// any throw-capable call. A throwing getter (replaced session) skips
		// both paths without throwing into the loop.
		let sm: typeof ctx.sessionManager | null;
		try {
			sm = ctx.sessionManager;
		} catch {
			sm = null;
		}
		// Auto start anchor (#55): fires at the X-th turn of the run. Runs
		// BEFORE and independently of the hint block — the two fields have
		// separate config semantics (the hint can be off/null while the start
		// anchor still applies). Native per-run `turnIndex` is 0-based, hence
		// the pre-increment. (The turn's entry ids, `messageEntryId` /
		// `toolResultEntryIds`, exist since pi 0.87; the rewind handler reads
		// them, this one needs only `turnIndex` and `message`.) A turn a rewind
		// owns is skipped: a recovery reply may be hidden, and the rewind
		// turn's leaf is the abandoned branch's.
		const rewindOwned =
			!!event.message &&
			typeof event.message === "object" &&
			state.turns.rewindTurns.has(event.message);
		// An overflowed turn is never anchored (#101, D14): with pi compaction on,
		// rewind-driven compaction stands down and does not mark it owned.
		const overflowedTurn =
			!!event.message &&
			typeof event.message === "object" &&
			state.turns.overflowedTurns.has(event.message);
		if (sm && !rewindOwned && !overflowedTurn) {
			writeStartAnchorIfNeeded(sm as SessionManager, event.turnIndex + 1);
		}
		// Per-session hint gate (#58): an in-process sibling session's
		// `before_agent_start` (e.g. a subagent whose tool subset omits
		// `navigate_tree`) must not clear THIS session's hint. Mirrors the auto
		// start-anchor's per-session gate; the shared `toolActive` remains the
		// fallback for sessions with no recorded gate (fail-open).
		let hintToolActive = state.activity.toolActive;
		if (sm) {
			try {
				const gated = state.activity.toolActiveBySession.get(sm.getSessionId());
				if (gated !== undefined) hintToolActive = gated;
			} catch {
				// Stale ctx: keep the shared fallback.
			}
		}
		// Hint off everywhere: nothing can fire or re-arm.
		if (
			!hintToolActive ||
			(state.config.rewindHintReserveTokens === null && state.config.hintByModel.size === 0)
		) {
			return;
		}
		let modelKey: string | undefined;
		if (state.config.hintByModel.size > 0) {
			try {
				const model = ctx.model;
				if (model) modelKey = `${model.provider}/${model.id}`;
			} catch {
				// Stale ctx: no hint this turn.
				return;
			}
		}
		const reserve = resolveRewindHintReserve(
			{
				rewindHintReserveTokens: state.config.rewindHintReserveTokens,
				rewindHintModelReserveTokens: state.config.hintByModel,
			},
			modelKey,
		);
		// During a fold or recovery a hint would be stale or push a second rewind.
		// The crossing stays
		// unspent for the next turn.
		if (
			event.message &&
			typeof event.message === "object" &&
			state.turns.rewindTurns.has(event.message)
		) {
			return;
		}
		const usage = ctx.getContextUsage();
		// `tokens == null` / `percent == null` is pi's post-compaction state
		// (unknown tokens), and `contextWindow <= 0` has no meaningful bar to
		// compare against. All are no-ops that leave the crossing unspent.
		if (!usage || usage.tokens == null || usage.percent == null || usage.contextWindow <= 0) {
			return;
		}
		// The hint measures the same admission estimate the request guard
		// gates on, so a crossing and a refused request cannot disagree. pi's
		// `usage` still supplies the window and the unknown-tokens state.
		if (!sm) return;
		let admission: number;
		try {
			admission = estimateAdmissionTokens(sm as SessionManager);
		} catch {
			return;
		}
		const tokensLeft = usage.contextWindow - admission;
		const percent = (admission / usage.contextWindow) * 100;
		if (reserve === null || tokensLeft > reserve) {
			// Hint off for this model, or outside the reserve: re-arm only.
			state.anchors.hintTracker.observe(tokensLeft, reserve);
			return;
		}
		// Spent: skip the anchor walk below (it estimates every anchor).
		if (state.anchors.hintTracker.isSpent()) return;
		// Collect anchors BEFORE marking the crossing spent: a throwing
		// `getBranch` / `getLabel` / `getEntries` must leave the crossing
		// unspent so the next turn can retry — never burn the one shot on a
		// failed state read. The shared `sm` was captured before any
		// throw-capable call, so the fallback append never re-reads a lazy ctx
		// getter after a throw.
		let anchors: { names: string[]; text: string };
		try {
			const allEntries = sm.getEntries();
			const byId = new Map<string, SessionEntry>();
			for (const e of allEntries) byId.set(e.id, e);
			anchors = formatActiveAnchors(sm as SessionManager, usage.contextWindow, allEntries, byId);
		} catch {
			return;
		}
		if (!state.anchors.hintTracker.observe(tokensLeft, reserve)) return;
		// Either-or with pi's compaction (#101, S3/D9), read at the crossing
		// (between crossings the hint has no effect, so no per-turn read): on,
		// the hint and rewind-driven compaction are off, and the crossing shows
		// why (TUI only; headless stays silent). The crossing is spent.
		// (`compaction.enabled` has no per-model override: no `ctx.model` read.)
		if (piCompaction(sm as SessionManager, undefined)?.enabled) {
			if (ctx.hasUI) ctx.ui.notify(REWIND_COMPACTION_OFF_TEXT, "error");
			return;
		}
		if (anchors.names.length > 0) {
			const text = buildRewindHintText(
				percent,
				tokensLeft,
				reserve,
				usage.contextWindow,
				anchors.text,
			);
			try {
				// Pinned delivery semantics — do not "improve": NO options bag
				// (never `triggerTurn`, never `sendUserMessage`). Streaming → the
				// loop steers and reacts once in the same run; idle → a plain
				// append, no turn started (the user-confirmation property is
				// intentional).
				pi.sendMessage({
					customType: REWIND_HINT_CUSTOM_TYPE,
					content: text,
					display: true,
				});
			} catch {
				// Defensively unreachable by construction on pi 0.84.2 / 0.85.1:
				// `ctx.getContextUsage()` — this handler's first API touch — asserts
				// the same staleness flag as `pi.sendMessage`, and after `bindCore`
				// `sendMessage`'s only synchronous throw is that flag (delivery
				// delegates to an async wrapper that catches). Kept as
				// defense-in-depth for host drift or a future async window in this
				// handler: the captured SessionManager outlives `assertActive()`,
				// the lazy ctx getters do not. The direct append is safe — the
				// `context` handler rebuilds wire messages from the session tree, so
				// the text still reaches the next LLM call; only the live TUI render
				// is deferred. Unlike pi-napkin's `onFallbackFailure`, the notify
				// below is itself try-guarded: a failure path must never throw.
				try {
					(sm as Partial<SessionManager>).appendCustomMessageEntry?.(
						REWIND_HINT_CUSTOM_TYPE,
						text,
						true,
					);
				} catch (err) {
					try {
						if (ctx.hasUI) {
							ctx.ui.notify(
								`${TOOL_NAME}: could not deliver the rewind hint (${err instanceof Error ? err.message : String(err)}).`,
								"warning",
							);
						}
					} catch {
						// Stale ctx getters — nothing left to surface with.
					}
				}
			}
		} else if (ctx.hasUI) {
			ctx.ui.notify(buildNoAnchorText(percent, usage.contextWindow), "warning");
		}
	}

	// Auto start anchor (#55) run-end fallback: a run that finishes before its
	// X-th turn still settles (a one-turn first run anchors at turn 1).
	// `agent_end` fires on complete / aborted / errored runs; the settled set
	// makes this a no-op once the turn trigger already wrote.
	function onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext) {
		let sm: typeof ctx.sessionManager;
		try {
			sm = ctx.sessionManager;
			// A run that ended on an overflow (#101, D14): its leaf is at the
			// context limit, a useless rewind target.
			const last = (event.messages ?? []).findLast((m) => m.role === "assistant");
			if (last && overflowed(last, ctx.model)) return;
		} catch {
			return;
		}
		writeStartAnchorIfNeeded(sm as SessionManager, Number.POSITIVE_INFINITY);
	}

	return { onTurnEnd, onAgentEnd, writeStartAnchorIfNeeded };
}
