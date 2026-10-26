/**
 * navigate-tree — agent-callable session tree navigation.
 *
 * See docs/how-it-works.md for the user-facing narrative
 * (independent fold engine, same-loop context refresh, reflection
 * bootstrap). This file-level JSDoc carries only source-internal facts
 * the docs don't.
 *
 * `/tree`-visible artifacts (empirical):
 *   • The abandoned branch of every rewind ends with the rewind tool
 *     call and its "accepted" result (labeled `branch:<newLabel>`); the
 *     active branch continues from the `branch_summary` with the
 *     `navigate-tree-rewind` continuation message. The summary is written
 *     by registry side calls, never by a main-agent turn.
 *   • Dangling tool_use on the anchor entry whose original
 *     tool_results were cut off by the rewind. Anthropic accepts this
 *     — the dangling tool_use is buffered behind the branch_summary's
 *     user-text rendering and the API doesn't reject it. No walk-up
 *     logic at anchor time.
 *
 * Reflection bootstrap replicates pi's own slash-command line
 * verbatim (kept symmetric so a pi rename here surfaces as the
 * runtime warning rather than silently drifting):
 *
 *   this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
 *
 * Risks of the reflection approach:
 *   • If pi switches either of the two fields this extension reads —
 *     `AgentSession.prototype.prompt` or `agent.state.messages` —
 *     to ES `#` private fields, this breaks fundamentally.
 *   • If pi renames or restructures any of these fields, this breaks.
 *   • `AgentSession._extensionRunner` (#79) is read only to emit
 *     `session_tree` after a rewind; losing it degrades silently
 *     (`historyRewriteNotified: false`, history mirrors stay stale).
 *   • Patches `AgentSession.prototype.prompt` globally on import; not
 *     reversible without a process restart; affects every session in
 *     the pi process, including sessions that never call
 *     `navigate_tree`.
 *
 * Verified against pi 1.3.0 via `scripts/pi-upstream-probe.mjs`.
 * In-loop context refresh runs through the public `context` extension
 * event (see `buildContextMessages`), not `agent.prepareNextTurn*`
 * reflection.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAutomaticFoldController } from "./auto/automatic-fold.ts";
import { createContinuityRuntime } from "./continuity/continuity-runtime.ts";
import { findLabelHint } from "./core/anchors.ts";
import { createHintController } from "./core/hint-and-start-anchor.ts";
import { createLabelWriter } from "./core/label-writer.ts";
import { createNavigatorState } from "./core/navigator-state.ts";
import { createPiCompactionController } from "./core/pi-compaction.ts";
import {
	captureSession,
	patchAgentSessionPrototype,
	REFLECTION_BOOTSTRAP_WARNING_LIST,
	REFLECTION_BOOTSTRAP_WARNING_REWIND,
	refreshAgentMessages,
	resetPrototype,
	sessionRefCount,
} from "./core/pi-internals.ts";
import { buildContextMessages, findLabeledEntry } from "./core/projection.ts";
import { createSessionLifecycle } from "./core/session-lifecycle.ts";
import { createConsolidationController } from "./fold/consolidation-runtime.ts";
import { createFoldAdaptersController } from "./fold/fold-adapters.ts";
import type { FoldApi } from "./fold/fold-api.ts";
import { createFoldRuntime } from "./fold/fold-runtime.ts";
import { installHandoffProjection } from "./fold/handoff-projection.ts";
import { createIndependentRecoveryController } from "./recovery/independent-recovery.ts";
import { createPressureCompactionController } from "./recovery/pressure-compaction.ts";
import { createRequestGuard } from "./recovery/request-guard.ts";
import { createTurnBoundary } from "./recovery/turn-boundary.ts";
import { createNavigateTreeTool } from "./tool/navigate-tree-tool.ts";
import { registerAnchorCommand } from "./ui/anchor-command.ts";
import { createAnchorCommandDeps } from "./ui/anchor-command-deps.ts";
import { registerHandoffRenderer } from "./ui/handoff-renderer.ts";
import { registerHistoryOutline } from "./ui/history-outline.ts";
import { registerNavigatorRenderers } from "./ui/navigator-renderers.ts";
// Floor on the *apparent* token savings (`beforeTokens − tokensAtTarget`) a
// `rewind` must clear to execute. Absolute threshold, deliberately NOT
// window-relative: % semantics drift with window size, so a fixed token bar
// is the only stable shape. Every rewind carries ≈350–900 tokens of fixed
// overhead (the branch_summary adds ~300–800 permanent tokens on the kept
// chain, plus the continuation message), so
// apparent savings OVERSTATES true freed context. Empirically the degenerate
// anchor→immediate-rewind case measures ~100 apparent tokens while a healthy
// stage measures ~20k — 4k separates them cleanly (~200×) and roughly equals
// one 300-line source-file read (~5.9k tokens measured). Below the floor a
// rewind pays for a summary, forks a junk branch_summary, consumes
// a milestone label, and GROWS live context.
export const MIN_REWIND_SAVINGS_TOKENS = 4000;

/** Receipt of a background consolidation; visible, one line. */
export const CONSOLIDATION_CUSTOM_TYPE = "navigate-tree-consolidation";
/** Receipt of a tail-keeping pressure compaction. */
export const PRESSURE_COMPACTION_CUSTOM_TYPE = "navigate-tree-pressure-compaction";

const foldApis = new WeakMap<ExtensionAPI, FoldApi>();

export default function (pi: ExtensionAPI) {
	const state = createNavigatorState();
	const lifecycle = createSessionLifecycle({ state });
	const { piCompaction } = createPiCompactionController({ state });
	const hint = createHintController({ pi, state, piCompaction });

	const writeLabel = createLabelWriter(pi);
	// ---------------------------------------------------------------------------
	// Independent folds (engine host): a fold summarized by side calls through
	// `createFoldEngine`, never by a main-agent turn, so it works for a session
	// whose next main request the admission guard would refuse.
	// ---------------------------------------------------------------------------

	const { captureSystemHead, runFold } = createFoldRuntime({
		state,
		minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
		writeLabel,
	});

	const { compactUnderPressure } = createPressureCompactionController({
		state,
		minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
		pressureCompactionCustomType: PRESSURE_COMPACTION_CUSTOM_TYPE,
		writeLabel,
	});

	const { recoverIndependently, holdRecoveryReceipt, receiptOnBranch, requestBudgetFailureDraft } =
		createIndependentRecoveryController({ state, runFold, compactUnderPressure });

	const { captureContinuity, continueNudgeDraft } = createContinuityRuntime({ pi, state });

	const {
		foldHostOf,
		gateFailed,
		queueFold,
		appendFoldMessage,
		runFoldNow,
		manualFoldDeps,
		openManualFold,
		runQueuedFold,
	} = createFoldAdaptersController({ pi, state, runFold, captureContinuity });

	const { maybeRunAutomaticFold } = createAutomaticFoldController({
		state,
		foldHostOf,
		gateFailed,
		writeLabel,
		runFold,
		compactUnderPressure,
	});

	const { maybeConsolidate } = createConsolidationController({
		state,
		minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
		consolidationCustomType: CONSOLIDATION_CUSTOM_TYPE,
		foldHostOf,
	});

	const requestGuard = createRequestGuard({
		state,
		piCompaction,
		foldHostOf,
		captureSystemHead,
		recoverIndependently,
	});

	foldApis.set(pi, { queueFold, runFoldNow });

	const turnBoundary = createTurnBoundary({
		state,
		piCompaction,
		foldHostOf,
		runQueuedFold,
		appendFoldMessage,
		recoverIndependently,
		holdRecoveryReceipt,
		receiptOnBranch,
		requestBudgetFailureDraft,
		captureContinuity,
		continueNudgeDraft,
		maybeRunAutomaticFold,
		maybeConsolidate,
	});

	registerAnchorCommand(
		pi,
		createAnchorCommandDeps({
			pi,
			getState: () => state,
			minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
			applyNavigatorConfig: lifecycle.applyNavigatorConfig,
			writeLabel,
			openManualFold,
			manualFoldDeps,
		}),
	);
	patchAgentSessionPrototype();

	// Fold and recovery commits precede hint / start-anchor context measurements.
	pi.on("turn_end", turnBoundary.onTurnEnd);
	pi.on("agent_before_settle", turnBoundary.onAgentBeforeSettle);
	pi.on("agent_settled", turnBoundary.onAgentSettled);

	// Recovery and queued folds cannot outlive the session.
	pi.on("session_shutdown", lifecycle.onSessionShutdown);
	pi.on("session_before_compact", lifecycle.onSessionBeforeCompact);
	pi.on("session_compact_failed", lifecycle.onSessionCompactFailed);
	pi.on("session_compact", lifecycle.onSessionCompact);

	registerNavigatorRenderers(pi);

	pi.on("session_start", lifecycle.onSessionStart);

	pi.on("context", requestGuard.onContext);
	pi.on("context_with_system", requestGuard.onContextWithSystem);
	pi.on("before_agent_start", requestGuard.onBeforeAgentStart);
	pi.on("tool_result", requestGuard.onToolResult);

	pi.on("turn_end", hint.onTurnEnd);

	pi.on("agent_end", hint.onAgentEnd);

	pi.registerTool(
		createNavigateTreeTool({
			pi,
			state,
			queueFold,
			minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
		}),
	);
	registerHandoffRenderer(pi);
	registerHistoryOutline(pi);
	const restoreProjection = installHandoffProjection();
	pi.on("session_shutdown", restoreProjection);
}

/**
 * Non-stable testing-only hooks. **Do NOT import in production code.**
 *
 * The `__` prefix and individual member names are subject to change in any
 * release without a semver-major bump. Intended exclusively for hermetic
 * tests within this package; the hooks reach into module-internal state
 * (the `AgentSession.prototype` patch, the `seenSessions` WeakSet, the
 * `sessionInstances` array) and are
 * not designed for external consumption.
 *
 * If you found this via `node_modules` archaeology, you're holding it
 * wrong — use the registered tool surface (`navigate_tree`) instead.
 */
export const __testHooks = {
	/**
	 * Restore the original `AgentSession.prototype.prompt` (stashed by
	 * `patchAgentSessionPrototype` under the `ORIG_PROMPT_KEY` symbol) and
	 * drain the captured-session refs. Idempotent: a no-op if the patch was
	 * never installed or has already been reset.
	 */
	resetPrototype,
	/** Module-internal helpers exposed for hermetic unit tests. */
	findLabelHint,
	findLabeledEntry,
	buildContextMessages,
	refreshAgentMessages,
	captureSession,
	/** The independent-fold entry points of the extension instance registered on `pi`. */
	foldApi(pi: ExtensionAPI): FoldApi | undefined {
		return foldApis.get(pi);
	},
	/** Read-only view of captured-session ref count for reaping assertions. */
	sessionRefCount,
	/**
	 * The reflection-bootstrap-missing warning strings, split per site.
	 * Exported so tests can pin the per-site verbatim wording (the `list`
	 * site is read-only and uses the read-only phrasing; the `rewind` site
	 * writes to disk and uses the write phrasing). Tests assert literal
	 * containment at each site to catch drift.
	 */
	REFLECTION_BOOTSTRAP_WARNING_LIST,
	REFLECTION_BOOTSTRAP_WARNING_REWIND,
};
