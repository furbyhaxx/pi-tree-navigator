/** Session configuration reloads, lifecycle cleanup and native compaction ownership. */

import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionCompactFailedEvent,
	type SessionManager,
	type SessionShutdownEvent,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { RECOVERY_HEADROOM_TOKENS, RECOVERY_MIN_OUTPUT_TOKENS } from "../fold/fold-policy.ts";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	loadTreeNavigatorConfig,
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveRewindHintReserve,
	START_ANCHOR_DEFAULT_TURNS,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./config.ts";
import type { NavigatorState } from "./navigator-state.ts";
import { type OverflowModel, tokenCalibration } from "./request-accounting.ts";
import {
	buildReserveGuardWarning,
	buildReserveOrderWarning,
	RewindHintTracker,
} from "./rewind-hint.ts";
import { clearRuntimeConfig } from "./runtime-config.ts";

/** Lifecycle state groups; turn ownership retains its separate boundary lifetime. */
export interface SessionLifecycleDeps {
	state: Pick<
		NavigatorState,
		"config" | "activity" | "folds" | "recovery" | "automatic" | "anchors" | "continuity"
	>;
}

/** Creates lifecycle handlers without registering handlers or starting work. */
export function createSessionLifecycle({ state }: SessionLifecycleDeps) {
	// Recovery and queued folds cannot outlive the session.
	function onSessionShutdown(_event: SessionShutdownEvent, ctx: ExtensionContext) {
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
	}

	function onSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
		try {
			if (event.reason === "overflow" && event.willRetry) {
				state.recovery.nativeRetryOwned.add(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: preflight may still run on the retry.
		}
	}

	function onSessionCompactFailed(event: SessionCompactFailedEvent, ctx: ExtensionContext) {
		try {
			if (event.reason === "overflow") {
				state.recovery.nativeRetryOwned.delete(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: settlement clears the flag.
		}
	}

	function onSessionCompact(_event: SessionCompactEvent, ctx: ExtensionContext) {
		try {
			state.anchors.anchorStartSettled.delete(ctx.sessionManager.getSessionId());
		} catch {
			// Stale ctx: the start anchor settles again at its next write.
		}
	}

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
	async function onSessionStart(_event: SessionStartEvent, ctx: ExtensionContext) {
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
	}

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

	return {
		applyNavigatorConfig,
		onSessionStart,
		onSessionShutdown,
		onSessionBeforeCompact,
		onSessionCompactFailed,
		onSessionCompact,
	};
}
