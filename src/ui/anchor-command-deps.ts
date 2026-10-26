/** Session-backed dependencies for the anchor command and its settings screen. */

import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readBranchLedger } from "../continuity/continuity-store.ts";
import { collectActiveAnchors, resolveAnchorTarget, suggestFoldLabel } from "../core/anchors.ts";
import {
	loadTreeNavigatorConfig,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "../core/config.ts";
import { formatPct1, formatWindow, LABEL_PREFIX, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { estimateAdmissionTokens } from "../core/request-accounting.ts";
import { RewindHintTracker } from "../core/rewind-hint.ts";
import { readRuntimeConfig } from "../core/runtime-config.ts";
import type { createFoldAdaptersController } from "../fold/fold-adapters.ts";
import { MIN_SUMMARY_FOCUS_LENGTH, START_ANCHOR_LABEL } from "../fold/fold-policy.ts";
import type { AnchorCommandDeps } from "./anchor-command.ts";
import { createUserOpsWriter } from "./current-screen.ts";
import { runFoldWithoutUi } from "./fold-plan-screen.ts";
import { createSettingsScreenDeps } from "./settings-screen.ts";

/** Deferred factory state and the operations used by anchor commands. */
export interface AnchorCommandDepsBuilderDeps {
	pi: Pick<ExtensionAPI, "appendEntry">;
	getState(): Pick<NavigatorState, "config" | "anchors" | "automatic" | "continuity" | "folds">;
	minRewindSavingsTokens: number;
	applyNavigatorConfig(
		sessionId: string,
		config: Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"],
	): void;
	writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean;
	openManualFold: ReturnType<typeof createFoldAdaptersController>["openManualFold"];
	manualFoldDeps: ReturnType<typeof createFoldAdaptersController>["manualFoldDeps"];
}

/** Builds command dependencies without registering commands or reading deferred state. */
export function createAnchorCommandDeps({
	pi,
	getState,
	minRewindSavingsTokens,
	applyNavigatorConfig,
	writeLabel,
	openManualFold,
	manualFoldDeps,
}: AnchorCommandDepsBuilderDeps): AnchorCommandDeps {
	return {
		settings: {
			...createSettingsScreenDeps(),
			async onSaved(ctx) {
				const state = getState();
				const sm = ctx.sessionManager;
				const sessionId = sm.getSessionId();
				const hasUI = ctx.hasUI;
				const ui = ctx.ui;
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const oldReserve = resolveRewindHintReserve(
					{
						rewindHintReserveTokens: state.config.rewindHintReserveTokens,
						rewindHintModelReserveTokens: state.config.hintByModel,
					},
					modelKey,
				);
				const oldController = resolveAutoNavigateConfig(
					{
						autoNavigate: state.config.autoNavigateBase,
						autoNavigateByModel: state.config.autoNavigateByModel,
						proposal: state.config.proposalConfig,
					},
					modelKey,
				);
				const oldContinuity = state.config.continuity;
				const loaded = await loadTreeNavigatorConfig({
					agentDir: getAgentDir(),
					projectPath: join(ctx.cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME),
					projectTrusted: ctx.isProjectTrusted(),
					runtime: readRuntimeConfig(sessionId),
				});
				if (sm.getSessionId() !== sessionId) return;
				applyNavigatorConfig(sessionId, loaded.config);
				if (oldReserve !== resolveRewindHintReserve(loaded.config, modelKey))
					state.anchors.hintTracker = new RewindHintTracker();
				if (
					JSON.stringify(oldController) !==
					JSON.stringify(resolveAutoNavigateConfig(loaded.config, modelKey))
				)
					state.automatic.autoFoldStateBySession.delete(sessionId);
				if (
					oldContinuity.capture !== state.config.continuity.capture ||
					oldContinuity.intentClassifier !== state.config.continuity.intentClassifier
				) {
					state.continuity.classifierTimedOut.delete(sessionId);
					state.continuity.continuityWarned.delete(sessionId);
				}
				if (hasUI) for (const warning of loaded.warnings) ui.notify(warning, "warning");
			},
		},
		listAnchors(ctx) {
			const sm = ctx.sessionManager as SessionManager;
			const cw = ctx.model?.contextWindow ?? 0;
			const totalTokens = estimateAdmissionTokens(sm);
			return collectActiveAnchors(sm).map(({ name, tokens, beforeCompaction, hint }) => ({
				name,
				percent: cw > 0 ? (tokens / cw) * 100 : 0,
				tokens,
				savableTokens: Math.max(0, totalTokens - tokens),
				...(beforeCompaction ? { beforeCompaction } : {}),
				...(hint ? { afterPreview: hint } : {}),
				...(LABEL_PREFIX + name === START_ANCHOR_LABEL ? { auto: true } : {}),
			}));
		},
		setAnchor(ctx, name) {
			const state = getState();
			const sm = ctx.sessionManager as SessionManager;
			const sessionId = sm.getSessionId();
			if (
				!ctx.isIdle() ||
				state.folds.queuedFolds.has(sessionId) ||
				state.folds.runningFolds.has(sessionId)
			)
				return {
					ok: false,
					reason: "Wait until the agent and any pending fold finish before setting an anchor.",
				};
			const target = resolveAnchorTarget(sm, name);
			if (!target.ok) {
				const reasons = {
					"invalid-name": `Anchor names are lowercase kebab-case, at most ${MAX_NAME_LENGTH} characters (e.g. 'impl-start').`,
					"no-leaf": "No session entries yet — nothing to anchor.",
					duplicate: `A label '${name}' already exists on the active branch — labels are unique and immutable once written. Pick a fresh name.`,
				};
				return { ok: false, reason: reasons[target.problem] };
			}
			if (!writeLabel(sm, target.leafId, target.fullLabel)) {
				return { ok: false, reason: "The anchor label could not be written." };
			}
			return { ok: true };
		},
		suggestLabel: (ctx, anchor) =>
			suggestFoldLabel(ctx.sessionManager as SessionManager, anchor.name),
		minSavingsTokens: minRewindSavingsTokens,
		minFocusLength: MIN_SUMMARY_FOCUS_LENGTH,
		requestFold(ctx, anchorName) {
			void openManualFold(ctx, anchorName);
		},
		openFoldPlan(ctx, preselect) {
			return openManualFold(ctx, preselect);
		},
		foldWithoutUi(ctx, args) {
			return runFoldWithoutUi(ctx, manualFoldDeps(ctx), args);
		},
		contextBadge(ctx) {
			const cw = ctx.model?.contextWindow ?? 0;
			const tokens = estimateAdmissionTokens(ctx.sessionManager as SessionManager);
			return `ctx ${formatPct1(tokens, cw)}${cw > 0 ? ` of ${formatWindow(cw)}` : ""}`;
		},
		readLedger: (ctx) => readBranchLedger(ctx.sessionManager.getBranch()).ledger,
		applyUserOps: createUserOpsWriter(pi, () => getState().config.continuity.capture),
	};
}
