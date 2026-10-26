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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	type SessionBoundaryDraft,
	type SessionEntry,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAutomaticFoldController } from "./auto/automatic-fold.ts";
import { createContinuityRuntime } from "./continuity/continuity-runtime.ts";
import { CONTINUITY_OPS_CUSTOM_TYPE } from "./continuity/continuity-store.ts";
import { findLabelHint } from "./core/anchors.ts";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	loadTreeNavigatorConfig,
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveRewindHintReserve,
	START_ANCHOR_DEFAULT_TURNS,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./core/config.ts";
import { extractTextContent, TOOL_NAME } from "./core/helpers.ts";
import { createHintController } from "./core/hint-and-start-anchor.ts";
import {
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
	legacyRewindOutcomeRow,
	legacySummaryRequestRow,
	sanitizeLegacyText,
} from "./core/legacy-rewind.ts";
import { createNavigatorState } from "./core/navigator-state.ts";
import { createPiCompactionController } from "./core/pi-compaction.ts";
import {
	captureSession,
	findOwningSession,
	patchAgentSessionPrototype,
	REFLECTION_BOOTSTRAP_WARNING_LIST,
	REFLECTION_BOOTSTRAP_WARNING_REWIND,
	refreshAgentMessages,
	resetPrototype,
	sessionRefCount,
} from "./core/pi-internals.ts";
import {
	buildContextMessages,
	effectiveRequestMessages,
	findLabeledEntry,
} from "./core/projection.ts";
import {
	ANCHOR_MANDATE,
	estimateAdmissionTokens,
	noteOutgoingRequest,
	noteRequestUsage,
	type OverflowModel,
	overflowed,
	requestAccounting,
	tokenCalibration,
} from "./core/request-accounting.ts";
import {
	buildReserveGuardWarning,
	buildReserveOrderWarning,
	RewindHintTracker,
} from "./core/rewind-hint.ts";
import { clearRuntimeConfig } from "./core/runtime-config.ts";
import { trySessionWrite } from "./core/session-write.ts";
import { createConsolidationController } from "./fold/consolidation-runtime.ts";
import { createFoldAdaptersController } from "./fold/fold-adapters.ts";
import type { FoldApi, FoldHost } from "./fold/fold-api.ts";
import { unrestoredFoldCursors } from "./fold/fold-commit.ts";
import { RECOVERY_HEADROOM_TOKENS, RECOVERY_MIN_OUTPUT_TOKENS } from "./fold/fold-policy.ts";
import {
	CONTINUE_NUDGE_STATUS,
	hideDrafts,
	keepValidDrafts,
	REWIND_CUSTOM_TYPE,
	StyledLines,
} from "./fold/fold-receipts.ts";
import { createFoldRuntime } from "./fold/fold-runtime.ts";
import { installHandoffProjection } from "./fold/handoff-projection.ts";
import { createIndependentRecoveryController } from "./recovery/independent-recovery.ts";
import { createPressureCompactionController } from "./recovery/pressure-compaction.ts";
import { createNavigateTreeTool } from "./tool/navigate-tree-tool.ts";
import { registerAnchorCommand } from "./ui/anchor-command.ts";
import { createAnchorCommandDeps } from "./ui/anchor-command-deps.ts";
import { registerHandoffRenderer } from "./ui/handoff-renderer.ts";
import { registerHistoryOutline } from "./ui/history-outline.ts";
import { renderContinuityOps } from "./ui/tool-renderer.ts";
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
	registerAnchorCommand(
		pi,
		createAnchorCommandDeps({
			pi,
			getState: () => state,
			minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
			applyNavigatorConfig,
			writeLabel,
			openManualFold: (...args) => openManualFold(...args),
			manualFoldDeps: (...args) => manualFoldDeps(...args),
		}),
	);
	patchAgentSessionPrototype();

	const state = createNavigatorState();
	const { piCompaction } = createPiCompactionController({ state });
	const hint = createHintController({ pi, state, piCompaction });

	/** Best-effort label write: `pi.setLabel`, else the captured manager. */
	function writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean {
		if (unrestoredFoldCursors.has(sm)) return false;
		const primary = trySessionWrite(sm, () => pi.setLabel(entryId, label));
		if (primary.ok) return true;
		if (!primary.cursorRestored) return false;
		return trySessionWrite(sm, () => sm.appendLabelChange(entryId, label)).ok;
	}

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

	foldApis.set(pi, { queueFold, runFoldNow });

	// Fold and recovery commits precede hint / start-anchor context measurements.
	pi.on("turn_end", async (event, ctx) => {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		// Every return keeps other handlers' entries (pi replaces the list per
		// handler) and drops `context_edit`s whose target left the branch, ours
		// included (one invalid draft makes pi drop the whole list).
		const deliverRaw = (drafts: SessionBoundaryDraft[], cont: boolean) => ({
			entries: keepValidDrafts(sm, [...(event.entries ?? []), ...drafts]),
			continue: cont,
		});
		const message = event.message as {
			role?: string;
			content?: unknown;
			stopReason?: string;
		};
		if (message?.role !== "assistant") return;
		const operatingWindow = ctx.model?.contextWindow ?? 0;
		noteRequestUsage(sessionId, message, operatingWindow);
		const usage = (message as Partial<AssistantMessage>).usage;
		// The recovered request generated within the window: a later overflow in
		// this run is a new request and may recover again. Only a recovery that
		// did not let the next request through is final. A tool call the provider
		// accepted beyond the operating window did not fit either.
		if (
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			!overflowed(message, ctx.model) &&
			!(operatingWindow > 0 && (usage?.input ?? 0) + (usage?.cacheRead ?? 0) > operatingWindow)
		)
			state.recovery.recoveryAttempts.delete(sessionId);
		const messageEntryId = typeof event.messageEntryId === "string" ? event.messageEntryId : "";
		const turnIds = messageEntryId
			? [
					messageEntryId,
					...(event.toolResultEntryIds ?? []).filter((id): id is string => typeof id === "string"),
				]
			: [];
		const budgetFailure = state.recovery.requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			return deliverRaw([...hideDrafts(turnIds), requestBudgetFailureDraft(budgetFailure)], false);
		}
		// The queued fold (E12), after this turn's tool results are committed. It
		// waits across an error turn pi retries.
		const queuedFold = state.folds.queuedFolds.get(sessionId);
		if (queuedFold && message.stopReason !== "error") {
			const folded = await runQueuedFold(sm, sessionId, queuedFold, message, event, ctx);
			if (folded) return folded;
		}
		// Another extension's continuation owns this boundary.
		if (!event.continue && messageEntryId && overflowed(message, ctx.model)) {
			state.turns.overflowedTurns.add(message);
			if (message.stopReason === "error") return;
			if (
				ctx.signal?.aborted ||
				state.recovery.nativeRetryOwned.has(sessionId) ||
				(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) ===
					false ||
				piCompaction(sm, ctx.model)?.enabled !== false
			)
				return;
			state.turns.rewindTurns.add(message);
			// A truncated tool envelope must not enter the next request.
			if (message.stopReason === "length") {
				for (const id of turnIds) sm.appendContextEdit(id, null);
				refreshAgentMessages(sm);
			}
			const host = foldHostOf(ctx);
			if (message.stopReason === "stop") host.recoveryEvidenceId = messageEntryId;
			const outcome = await recoverIndependently(ctx, host, ctx.signal);
			if (ctx.signal?.aborted || outcome.status === "cancelled") return;
			if (outcome.status === "failed") {
				const failure = {
					inputEstimate: estimateAdmissionTokens(sm),
					contextWindow: host.model?.contextWindow ?? 0,
					receiptId: randomUUID(),
					detail: outcome.detail,
					providerOverflow: true,
				};
				state.recovery.requestBudgetFailures.set(sessionId, failure);
				return deliverRaw([requestBudgetFailureDraft(failure)], false);
			}
			refreshAgentMessages(sm);
			return deliverRaw([holdRecoveryReceipt(sessionId, outcome.draft)], true);
		}
		if (!state.turns.rewindTurns.has(message) && !state.turns.overflowedTurns.has(message)) {
			await captureContinuity(sm, sessionId, ctx, message);
		}
		const auto = await maybeRunAutomaticFold(sm, sessionId, message, event, ctx);
		if (auto) return auto;
		if (!state.turns.rewindTurns.has(message) && !state.turns.overflowedTurns.has(message)) {
			const consolidated = await maybeConsolidate(sm, sessionId, message, ctx);
			if (consolidated) return deliverRaw(consolidated, event.continue);
		}
		let signal: AbortSignal | undefined;
		try {
			signal = ctx.signal;
		} catch {
			return;
		}
		const nudge = continueNudgeDraft(sm, sessionId, message, event, signal);
		return nudge ? deliverRaw([nudge], true) : undefined;
	});

	// Explicit provider errors end the loop before turn_end can continue it.
	pi.on("agent_before_settle", async (event, ctx) => {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		// Rewind-driven compaction (#101, D2): an explicit overflow error ended
		// the loop; pi did not retry (overflow) or compact (off). Recover in the
		// same run. Another extension's `continue` owns the recovery.
		if (event.outcome === "error" && !event.continue) {
			let last: SessionEntry | undefined;
			try {
				last = sm
					.getBranch()
					.findLast((e) => e.type === "message" && e.message.role === "assistant");
			} catch {
				last = undefined;
			}
			const failed = last?.type === "message" ? last.message : undefined;
			if (
				last &&
				(failed as { stopReason?: string } | undefined)?.stopReason === "error" &&
				overflowed(failed, ctx.model)
			) {
				const signal = ctx.signal;
				if (
					signal?.aborted ||
					(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) ===
						false ||
					piCompaction(sm, ctx.model)?.enabled !== false ||
					state.recovery.nativeRetryOwned.has(sessionId)
				)
					return;
				const host = foldHostOf(ctx);
				// The SDK has no agent signal between runs at before-settlement.
				const session = findOwningSession(sm);
				const cancellation = new AbortController();
				const originalAbort = session?.abort;
				const recoveryAbort =
					session && originalAbort
						? function (this: AgentSession) {
								cancellation.abort();
								return originalAbort.call(this);
							}
						: undefined;
				if (session && recoveryAbort) session.abort = recoveryAbort;
				let outcome: Awaited<ReturnType<typeof recoverIndependently>>;
				try {
					outcome = await recoverIndependently(
						ctx,
						host,
						signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal,
					);
				} finally {
					if (session && originalAbort && session.abort === recoveryAbort)
						session.abort = originalAbort;
				}
				if (signal?.aborted || cancellation.signal.aborted || outcome.status === "cancelled")
					return;
				if (outcome.status === "failed") {
					const failure = {
						inputEstimate: estimateAdmissionTokens(sm),
						contextWindow: host.model?.contextWindow ?? 0,
						receiptId: randomUUID(),
						detail: outcome.detail,
						providerOverflow: true,
					};
					state.recovery.requestBudgetFailures.set(sessionId, failure);
					return {
						entries: keepValidDrafts(sm, [
							...(event.entries ?? []),
							requestBudgetFailureDraft(failure),
						]),
						continue: false,
					};
				}
				refreshAgentMessages(sm);
				return {
					entries: keepValidDrafts(sm, [
						...(event.entries ?? []),
						holdRecoveryReceipt(sessionId, outcome.draft),
					]),
					continue: true,
				};
			}
		}
		return undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		let sm: SessionManager;
		let sessionId: string;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
		} catch {
			return;
		}
		state.recovery.recoveryAttempts.delete(sessionId);
		state.recovery.nativeRetryOwned.delete(sessionId);
		// A rewind the run never reached a boundary for would fold at an
		// unrelated later turn, and block every rewind until then.
		if (state.folds.queuedFolds.get(sessionId)?.origin === "agent")
			state.folds.queuedFolds.delete(sessionId);
		for (const draft of state.recovery.recoveryReceipts.get(sessionId) ?? [])
			if (!receiptOnBranch(sm, draft.details.receiptId)) appendFoldMessage(sm, draft);
		state.recovery.recoveryReceipts.delete(sessionId);
		const budgetFailure = state.recovery.requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			if (!receiptOnBranch(sm, budgetFailure.receiptId))
				appendFoldMessage(sm, requestBudgetFailureDraft(budgetFailure));
			state.recovery.requestBudgetFailures.delete(sessionId);
			return;
		}
	});

	// Recovery and queued folds cannot outlive the session.
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			state.recovery.requestBudgetFailures.delete(sessionId);
			state.recovery.recoveryReceipts.delete(sessionId);
			state.folds.capturedSystems.delete(sessionId);
			state.recovery.recoveryAttempts.delete(sessionId);
			state.recovery.nativeRetryOwned.delete(sessionId);
			state.recovery.recoveryCuts.delete(sessionId);
			state.folds.queuedFolds.delete(sessionId);
			tokenCalibration.delete(sessionId);
			state.automatic.autoFoldStateBySession.delete(sessionId);
		} catch {
			// Fail-open: session_start clears it too.
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		try {
			if (event.reason === "overflow" && event.willRetry) {
				state.recovery.nativeRetryOwned.add(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: preflight may still run on the retry.
		}
	});

	pi.on("session_compact_failed", (event, ctx) => {
		try {
			if (event.reason === "overflow") {
				state.recovery.nativeRetryOwned.delete(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: settlement clears the flag.
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		try {
			state.anchors.anchorStartSettled.delete(ctx.sessionManager.getSessionId());
		} catch {
			// Stale ctx: the start anchor settles again at its next write.
		}
	});

	// TUI rows: local components styled through `theme`.
	pi.registerEntryRenderer(CONTINUITY_OPS_CUSTOM_TYPE, renderContinuityOps);
	pi.registerMessageRenderer(LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE, (message, options, theme) => {
		const lines = [legacySummaryRequestRow(message.details)];
		if (options.expanded) {
			lines.push("", ...sanitizeLegacyText(extractTextContent(message.content)).split("\n"));
		}
		return new StyledLines(
			lines,
			(line) => theme.fg("customMessageText", line),
			options.outputPad ?? 1,
			options.expanded,
		);
	});
	pi.registerEntryRenderer(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, (entry, _options, theme) => {
		const row = legacyRewindOutcomeRow(entry.data);
		if (!row) return undefined;
		const status = (entry.data as { status?: unknown } | undefined)?.status;
		const failed = status === "failed";
		return new StyledLines(
			[`${failed ? "✗" : "⚠"} ${row}`],
			(line) => theme.fg(failed ? "error" : "warning", line),
			1,
			false,
		);
	});
	// The final error of rewind-driven compaction (#101, D8): one
	// error-styled row, full text, nothing to expand. The continue nudge is
	// one line, expandable. Every other rewind message (the continuation, the
	// forced-rewind message) keeps pi's default rendering.
	pi.registerMessageRenderer(REWIND_CUSTOM_TYPE, (message, options, theme) => {
		const status = (message.details as { status?: unknown } | undefined)?.status;
		if (status === CONTINUE_NUDGE_STATUS) {
			const lines = [
				"[navigate_tree] turn ended right after a rewind \u00b7 nudged once to continue",
			];
			if (options.expanded) {
				lines.push("", ...extractTextContent(message.content).split("\n"));
			}
			return new StyledLines(
				lines,
				(line) => theme.fg("customMessageText", line),
				options.outputPad ?? 1,
			);
		}
		if (status !== "failed") return undefined;
		return new StyledLines(
			extractTextContent(message.content).split("\n"),
			(line) => theme.fg("error", line),
			options.outputPad ?? 1,
		);
	});

	function applyNavigatorConfig(
		sessionId: string,
		config: Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"],
	): void {
		state.config.rewindHintReserveTokens = config.rewindHintReserveTokens;
		state.config.hintByModel = config.rewindHintModelReserveTokens;
		state.config.autoNavigateBase = config.autoNavigate;
		state.config.autoNavigateByModel = config.autoNavigateByModel ?? new Map();
		state.config.proposalConfig = config.proposal;
		state.config.continuity = config.continuity;
		state.config.consolidation = config.consolidation;
		state.anchors.anchorStartTurnsBySession.set(sessionId, config.anchorStartAfterTurns);
		state.folds.parentModes.set(sessionId, config.parentHandoffMode);
	}

	// Config (#44 hint + #55 start anchor): reload at session start and settings save. Every
	// ctx getter is read BEFORE the first await — `ctx.ui` / `isProjectTrusted`
	// / `cwd` / `hasUI` assert against the live session (pi-steering
	// precedent), and `loadTreeNavigatorConfig` is async. The settled set is
	// deliberately NOT reset: it is per-session state keyed by session id.
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;
		const projectTrusted = ctx.isProjectTrusted();
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const sm = ctx.sessionManager as SessionManager;
		const sessionId = sm.getSessionId();
		let model: OverflowModel | undefined;
		try {
			model = ctx.model;
		} catch {
			model = undefined;
		}
		const agentDir = getAgentDir();
		// pi's settings as this session reads them (#101, S4).
		state.config.piSettingsSource = { cwd, agentDir, projectTrusted };
		state.recovery.requestBudgetFailures.delete(sessionId);
		state.folds.capturedSystems.delete(sessionId);
		state.recovery.recoveryAttempts.delete(sessionId);
		state.recovery.nativeRetryOwned.delete(sessionId);
		state.recovery.recoveryCuts.delete(sessionId);
		state.folds.queuedFolds.delete(sessionId);
		tokenCalibration.delete(sessionId);
		state.config.rewindHintReserveTokens = null;
		state.config.hintByModel = new Map();
		state.config.autoNavigateBase = undefined;
		state.config.autoNavigateByModel = new Map();
		state.config.proposalConfig = undefined;
		state.automatic.autoFoldStateBySession.delete(sessionId);
		state.anchors.hintTracker = new RewindHintTracker();
		state.activity.toolActive = true;
		state.config.continuity = {
			capture: CONTINUITY_CAPTURE_DEFAULT,
			intentClassifier: null,
		};
		state.config.consolidation = CONSOLIDATION_DEFAULTS;
		state.continuity.continuityWarned.delete(sessionId);
		state.continuity.classifierTimedOut.delete(sessionId);
		clearRuntimeConfig(sessionId);
		state.anchors.anchorStartTurnsBySession.set(sessionId, START_ANCHOR_DEFAULT_TURNS);
		state.folds.parentModes.set(sessionId, PARENT_HANDOFF_MODE_DEFAULT);
		let warnings: string[] = [];
		try {
			const loaded = await loadTreeNavigatorConfig({
				agentDir,
				projectPath: join(cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME),
				projectTrusted,
			});
			applyNavigatorConfig(sessionId, loaded.config);
			warnings = loaded.warnings;
		} catch {
			// The loader is fail-closed and should never throw; this guard exists
			// so a loader bug can never break session start. Silent: every loader
			// failure already carries a user-facing warning, and a new string here
			// would only fire on an unreachable path.
			warnings = [];
		}
		// Fresh leg: the per-session gate re-arms on the next
		// `before_agent_start`; absent = fail-open in the meantime.
		state.activity.toolActiveBySession.delete(sessionId);
		if (state.config.rewindHintReserveTokens !== null || state.config.hintByModel.size > 0) {
			warnings.push(...reserveOrderWarnings(model));
		}
		if (hasUI) {
			for (const warning of warnings) ui.notify(warning, "warning");
		}
	});

	/**
	 * D10 (#101): one warning per model whose hint reserve is below pi's
	 * `compaction.reserveTokens` (both have per-model overrides), while pi's
	 * compaction is off (on, both features are off and D9 says so).
	 */
	function reserveOrderWarnings(model: OverflowModel | undefined): string[] {
		if (!state.config.piSettingsSource) return [];
		const warnings: string[] = [];
		try {
			const settings = SettingsManager.create(
				state.config.piSettingsSource.cwd,
				state.config.piSettingsSource.agentDir,
				{
					projectTrusted: state.config.piSettingsSource.projectTrusted,
				},
			);
			if (settings.getCompactionSettings(model).enabled) return [];
			const keys = new Set<string>();
			if (model) keys.add(`${model.provider}/${model.id}`);
			for (const key of state.config.hintByModel.keys()) keys.add(key);
			const overrides = settings.getSettings().compaction?.modelOverrides;
			for (const key of Object.keys(overrides ?? {})) keys.add(key);
			for (const key of keys) {
				if (key.includes("*")) continue;
				const slash = key.indexOf("/");
				if (slash <= 0) continue;
				// Per key: one model's invalid setting does not skip the others.
				try {
					const hint = resolveRewindHintReserve(
						{
							rewindHintReserveTokens: state.config.rewindHintReserveTokens,
							rewindHintModelReserveTokens: state.config.hintByModel,
						},
						key,
					);
					const piReserve = settings.getCompactionReserveTokens({
						provider: key.slice(0, slash),
						id: key.slice(slash + 1),
					});
					if (hint !== null && hint < piReserve) {
						warnings.push(buildReserveOrderWarning(hint, piReserve, key));
					}
					const guardTokens = RECOVERY_MIN_OUTPUT_TOKENS + RECOVERY_HEADROOM_TOKENS;
					if (hint !== null && hint <= guardTokens) {
						warnings.push(buildReserveGuardWarning(hint, guardTokens, key));
					}
				} catch {
					// Invalid pi setting for this model: pi reports it itself.
				}
			}
		} catch {
			// Invalid pi settings: pi reports them itself.
		}
		return warnings;
	}

	// Public context event: replace the wire messages with the session-tree
	// projection before every LLM call. This is the public-API replacement for
	// the deleted `agent.prepareNextTurnWithContext` per-turn refresh — it
	// fires inside `streamAssistantResponse` (via `Agent.transformContext` →
	// `runner.emitContext`), before EVERY LLM call including the turn right
	// after a mid-loop rewind, so the rewound chain (branch_summary +
	// continuation message) reaches the next API call.
	//
	pi.on("context", (_event, ctx) => ({
		messages: buildContextMessages(ctx.sessionManager as SessionManager),
	}));

	pi.on("context_with_system", async (event, ctx) => {
		let sm: SessionManager;
		let sessionId: string;
		let model: OverflowModel | undefined;
		let signal: AbortSignal | undefined;
		let host: FoldHost;
		try {
			sm = ctx.sessionManager as SessionManager;
			sessionId = sm.getSessionId();
			model = ctx.model;
			signal = ctx.signal;
			host = foldHostOf(ctx);
		} catch {
			return;
		}
		// Captured before any await: Strategy A and the returned request share it.
		const systemHead = effectiveRequestMessages(sm, event.messages).filter(
			(message) => message.role === "system",
		);
		captureSystemHead(sm, sessionId, model, event.messages);
		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		if (modelKey)
			noteOutgoingRequest(sessionId, modelKey, effectiveRequestMessages(sm, event.messages));
		if (signal?.aborted) return;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (state.recovery.nativeRetryOwned.has(sessionId)) {
			state.recovery.nativeRetryOwned.delete(sessionId);
			return;
		}
		if (!model?.contextWindow || model.contextWindow <= 0) return;
		// Native auto-compaction owns recovery when it is enabled (single owner).
		if (piCompaction(sm, model)?.enabled !== false) return;
		const contextWindow = model.contextWindow;
		const inputEstimate = requestAccounting(sm, event.messages).tokens;
		const reserve = RECOVERY_MIN_OUTPUT_TOKENS + RECOVERY_HEADROOM_TOKENS;
		if (inputEstimate + reserve <= contextWindow) return;
		const refuse = (detail?: string) => {
			state.recovery.requestBudgetFailures.set(sessionId, {
				inputEstimate,
				contextWindow,
				receiptId: randomUUID(),
				...(detail ? { detail } : {}),
			});
			try {
				ctx.abort();
			} catch {
				// Stale ctx: settlement still persists the receipt.
			}
		};
		try {
			const outcome = await recoverIndependently(ctx, host, signal);
			if (outcome.status === "cancelled") return;
			if (outcome.status === "failed") {
				refuse(outcome.detail);
				return;
			}
			const { draft } = outcome;
			// Contain the receipt write: an unpersisted receipt must not become the
			// parent of the next main-agent reply.
			const receipt = trySessionWrite(sm, () =>
				sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details),
			);
			if (!receipt.ok && !receipt.cursorRestored) {
				unrestoredFoldCursors.add(sm);
				refuse("the fold landed but its receipt could not be written, so persistence is uncertain");
				return;
			}
			refreshAgentMessages(sm);
			try {
				const recovered = [...systemHead, ...buildContextMessages(sm)];
				if (modelKey) noteOutgoingRequest(sessionId, modelKey, recovered);
				return { messages: recovered };
			} catch {
				refuse("the recovered projection could not be built");
				return;
			}
		} catch (error) {
			refuse(
				`independent recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	});

	// Anchor mandate (#31): a before_agent_start append lands at the END of
	// the system prompt — stronger than the mid-prompt Guidelines block, and
	// re-applied on every prompt instead of living in the conversation. Skip
	// only when the tool is verifiably absent from the active set; fail-open
	// when `selectedTools` is undefined (this extension always registers it).
	// The same check gates the rewind hint (#44): an inactive tool must not
	// fire `turn_end` nudges the model can't act on.
	pi.on("before_agent_start", async (event, ctx) => {
		const selected = event.systemPromptOptions?.selectedTools;
		state.activity.toolActive = !Array.isArray(selected) || selected.includes(TOOL_NAME);
		// Per-session copy of the gate (#55): the shared `toolActive` above
		// drives the hint, but an in-process sibling session must not clear this
		// session's auto-anchor gate.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			state.recovery.requestBudgetFailures.delete(sessionId);
			state.recovery.recoveryReceipts.delete(sessionId);
			state.recovery.recoveryAttempts.delete(sessionId);
			state.recovery.nativeRetryOwned.delete(sessionId);
			state.activity.toolActiveBySession.set(sessionId, state.activity.toolActive);
		} catch {
			// Fail-open: the per-session gate stays absent.
		}
		if (!state.activity.toolActive) return {};
		return { systemPrompt: `${event.systemPrompt}\n\n${ANCHOR_MANDATE}` };
	});

	// Refusals must render (and be recorded) as failed tool calls. A returned
	// `isError: true` never reaches the host's error channel — pi-agent-core
	// only finalizes a call as failed when `execute()` throws, overwriting the
	// flag with its own boolean — so `toolError` tags its details with
	// `refusal: true` and this handler flips the host's `isError`, which drives
	// the TUI's `toolErrorBg` shell, the transcript entry, and any other
	// extension's `tool_result` view. Content is left untouched, so the model
	// still reads the refusal copy.
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_NAME) return undefined;
		const details = event.details as { refusal?: boolean } | undefined;
		if (details?.refusal === true) {
			return { isError: true };
		}
		return undefined;
	});

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
