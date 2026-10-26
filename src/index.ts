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
import { join, normalize } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	buildSessionProjection,
	CONFIG_DIR_NAME,
	type CompactionEntry,
	collectEntriesForBranchSummary,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
	type SessionBoundaryDraft,
	type SessionEntry,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { planAutomaticFold, pressureFoldBudget } from "./auto/auto-fold-planner.ts";
import { planPressureCut } from "./auto/pressure-compaction.ts";
import { isVisible, renderBriefing } from "./continuity/continuity-briefing.ts";
import {
	captureIntent,
	createModelClassifier,
	heuristicClassifier,
	type IntentClassifier,
} from "./continuity/continuity-capture.ts";
import { type LedgerOp, MAX_ITEM_TEXT_CHARS } from "./continuity/continuity-ledger-model.ts";
import { applyOps } from "./continuity/continuity-ledger-reducer.ts";
import {
	appendOpsEntry,
	type BranchLedger,
	CONTINUITY_OPS_CUSTOM_TYPE,
	compactionContinuity,
	readBranchLedger,
	userEntryIndexOf,
} from "./continuity/continuity-store.ts";
import { resolveIntentPolicy } from "./continuity/intent-policy.ts";
import { collectOpenUserRequests } from "./continuity/open-user-requests.ts";
import {
	activeAnchorNames,
	buildMinSavingsRejection,
	collectActiveAnchors,
	findLabelHint,
	formatActiveAnchors,
	hashPinnedFile,
	isFilled,
	resolveAnchorTarget,
	suggestFoldLabel,
} from "./core/anchors.ts";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	loadTreeNavigatorConfig,
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
	START_ANCHOR_DEFAULT_TURNS,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./core/config.ts";
import { estimateContentTokens, fixedOverheadNote } from "./core/context-tokens.ts";
import {
	type AnchorTableRow,
	extractTextContent,
	formatAnchorTable,
	formatPct1,
	formatWindow,
	isValidName,
	LABEL_PREFIX,
	MAX_NAME_LENGTH,
	TOOL_NAME,
	toOneLine,
} from "./core/helpers.ts";
import {
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
	legacyRewindOutcomeRow,
	legacySummaryRequestRow,
	sanitizeLegacyText,
} from "./core/legacy-rewind.ts";
import { createNavigatorState } from "./core/navigator-state.ts";
import {
	asInternals,
	captureSession,
	emitSessionCompact,
	findOwningSession,
	patchAgentSessionPrototype,
	REFLECTION_BOOTSTRAP_WARNING_LIST,
	REFLECTION_BOOTSTRAP_WARNING_REWIND,
	refreshAgentMessages,
	resetPrototype,
	sessionRefCount,
} from "./core/pi-internals.ts";
import {
	admissionMessages,
	buildContextMessages,
	effectiveRequestMessages,
	findLabeledEntry,
	precedesLatestCompaction,
	systemCheckpoint,
} from "./core/projection.ts";
import {
	ANCHOR_MANDATE,
	accountRequest,
	estimateAdmissionTokens,
	estimateAtEntry,
	noteOutgoingRequest,
	noteRequestUsage,
	type OverflowModel,
	overflowed,
	requestAccounting,
	tokenCalibration,
	tokenFactorOf,
} from "./core/request-accounting.ts";
import {
	buildNoAnchorText,
	buildReserveGuardWarning,
	buildReserveOrderWarning,
	buildRewindHintText,
	REWIND_COMPACTION_OFF_TEXT,
	REWIND_HINT_CUSTOM_TYPE,
	RewindHintTracker,
} from "./core/rewind-hint.ts";
import { clearRuntimeConfig, readRuntimeConfig } from "./core/runtime-config.ts";
import { trySessionWrite } from "./core/session-write.ts";
import { planConsolidation } from "./fold/consolidation-planner.ts";
import type {
	FoldApi,
	FoldHost,
	FoldLanded,
	FoldRequestInput,
	FoldResult,
} from "./fold/fold-api.ts";
import { commitFold, unrestoredFoldCursors } from "./fold/fold-commit.ts";
import {
	createFoldEngine,
	type FoldCommitResult,
	type FoldPrepared,
	type FoldRequest,
	type FoldRunOptions,
	selectFoldTarget,
} from "./fold/fold-engine.ts";
import {
	buildConsolidationSegment,
	buildFoldProjection,
	buildFoldSegment,
} from "./fold/fold-inputs.ts";
import {
	MIN_SUMMARY_FOCUS_LENGTH,
	RECOVERY_HEADROOM_TOKENS,
	RECOVERY_MIN_OUTPUT_TOKENS,
	START_ANCHOR_LABEL,
} from "./fold/fold-policy.ts";
import {
	continuityRequestSection,
	defaultFoldFocus,
	foldAdmission,
	foldPlaceholderSummary,
	foldRecommendationBudget,
	preparedInContext,
	priceFoldCandidates,
	recommendFoldIndex,
	summarizerReduceTokens,
} from "./fold/fold-pricing.ts";
import {
	buildRewindAcceptedText,
	buildRewindDoneText,
	CONTINUE_NUDGE_STATUS,
	CONTINUE_NUDGE_TEXT,
	foldDoneDraft,
	foldFailedDraft,
	hideDrafts,
	keepValidDrafts,
	REWIND_CUSTOM_TYPE,
	type RewindMessageDraft,
	rewindMessageDraft,
	StyledLines,
	toolError,
} from "./fold/fold-receipts.ts";
import { createFoldSummaryRunner, summarizeFold } from "./fold/fold-summarizer.ts";
import type { HandoffMode } from "./fold/handoff.ts";
import { installHandoffProjection, projectHandoffs } from "./fold/handoff-projection.ts";
import {
	appendContinuityBriefing,
	buildConsolidationRequestText,
	hasOpenWork,
} from "./fold/summary-prompt.ts";
import { recoveryCutOf } from "./recovery/recovery-cut.ts";
import { registerAnchorCommand } from "./ui/anchor-command.ts";
import { createUserOpsWriter } from "./ui/current-screen.ts";
import {
	type FoldPlan,
	type FoldPlanCandidate,
	type FoldPlanDeps,
	foldPlanResult,
	openFoldPlanScreen,
	runFoldWithoutUi,
} from "./ui/fold-plan-screen.ts";
import { registerHandoffRenderer } from "./ui/handoff-renderer.ts";
import { registerHistoryOutline } from "./ui/history-outline.ts";
import { createSettingsScreenDeps } from "./ui/settings-screen.ts";
import { renderContinuityOps, renderToolCall, renderToolResult } from "./ui/tool-renderer.ts";
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
/** The consolidation prompt asks for about 6,000 characters. */
const CONSOLIDATION_SUMMARY_TOKENS = Math.ceil(6000 / 3.5);

/** The smallest kept tail a pressure compaction shrinks to, as a share of `keep_recent_share`. */
const MIN_KEPT_SHARE_OF_CONFIGURED = 0.25;
/** Receipt of a background consolidation; visible, one line. */
export const CONSOLIDATION_CUSTOM_TYPE = "navigate-tree-consolidation";
/** Receipt of a tail-keeping pressure compaction. */
export const PRESSURE_COMPACTION_CUSTOM_TYPE = "navigate-tree-pressure-compaction";
/** Recoveries one request may get; each must start from less context than the last. */
const MAX_RECOVERY_ATTEMPTS = 3;
/** Token budget of the ledger briefing appended to `list`. */
const LIST_BRIEFING_MAX_TOKENS = 500;

/** Kinds the agent may pin; rules and the objective are the user's alone. */
const PIN_KINDS = ["sub-goal", "decision", "fact", "file", "steering"] as const;
type PinKind = (typeof PIN_KINDS)[number];
const isPinKind = (kind: unknown): kind is PinKind => PIN_KINDS.includes(kind as PinKind);

// Hint length cap for the hint shown in the `anchor` response. The anchor
// response is a single block of prose (not a column-aligned table) so it
// can afford a longer hint than `list`'s per-row preview.
const ANCHOR_HINT_MAX_LENGTH = 60;

/** Wall-clock bound on one continuity capture pass: a slow classifier must not stall a turn. */
const CONTINUITY_CAPTURE_TIMEOUT_MS = 15_000;

/** Whether the latest assistant message on `branch` still lacks tool results. */
function endsInOpenToolBatch(branch: readonly SessionEntry[]): boolean {
	const at = branch.findLastIndex(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const entry = branch[at];
	if (entry?.type !== "message" || entry.message.role !== "assistant") {
		return false;
	}
	const calls = entry.message.content.filter((block) => block.type === "toolCall").length;
	const results = branch
		.slice(at + 1)
		.filter((e) => e.type === "message" && e.message.role === "toolResult").length;
	return results < calls;
}

const foldApis = new WeakMap<ExtensionAPI, FoldApi>();

export default function (pi: ExtensionAPI) {
	registerAnchorCommand(pi, {
		settings: {
			...createSettingsScreenDeps(),
			async onSaved(ctx) {
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
		minSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
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
		applyUserOps: createUserOpsWriter(pi, () => state.config.continuity.capture),
	});
	patchAgentSessionPrototype();

	const state = createNavigatorState();
	const holdRecoveryReceipt = (sessionId: string, draft: RewindMessageDraft) => {
		draft.details.receiptId = randomUUID();
		state.recovery.recoveryReceipts.set(sessionId, [
			...(state.recovery.recoveryReceipts.get(sessionId) ?? []),
			draft,
		]);
		return draft;
	};
	const receiptOnBranch = (sm: SessionManager, receiptId: unknown) =>
		sm
			.getBranch()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					typeof entry.details === "object" &&
					entry.details !== null &&
					"receiptId" in entry.details &&
					entry.details.receiptId === receiptId,
			);
	const requestBudgetFailureDraft = (failure: {
		inputEstimate: number;
		contextWindow: number;
		receiptId: string;
		detail?: string;
		providerOverflow?: boolean;
	}) =>
		rewindMessageDraft(
			`[${TOOL_NAME}] ${failure.providerOverflow ? "Provider context overflow recovery failed." : `Request stopped before generation: estimated input ${failure.inputEstimate} tokens leaves fewer than ${RECOVERY_MIN_OUTPUT_TOKENS} output tokens plus ${RECOVERY_HEADROOM_TOKENS} headroom in the ${failure.contextWindow}-token operating window.`} No tool results were withheld.${failure.detail ? ` ${failure.detail}` : ""} Reduce context with /tree or /compact, or select a larger operating window.`,
			{
				status: "failed",
				reason: failure.providerOverflow
					? "provider context overflow"
					: "insufficient request headroom",
				inputEstimate: failure.inputEstimate,
				contextWindow: failure.contextWindow,
				appliedWithheld: 0,
				receiptId: failure.receiptId,
				...(failure.detail ? { detail: failure.detail } : {}),
			},
		);

	/**
	 * pi's compaction settings for `model` (#101, S3/S4/D9), or `null`. Read
	 * from the captured session's live settings manager, the one pi decides
	 * from; the disk (with the session's project trust) only when no session
	 * is captured.
	 */
	function piCompaction(
		sm: SessionManager,
		model: OverflowModel | undefined,
	): { enabled: boolean; reserveTokens: number } | null {
		try {
			const session = findOwningSession(sm);
			let settingsManager = session ? asInternals(session).settingsManager : undefined;
			if (!settingsManager) {
				if (!state.config.piSettingsSource) return null;
				settingsManager = SettingsManager.create(
					state.config.piSettingsSource.cwd,
					state.config.piSettingsSource.agentDir,
					{
						projectTrusted: state.config.piSettingsSource.projectTrusted,
					},
				);
			}
			const settings = settingsManager.getCompactionSettings(model);
			return {
				enabled: settings.enabled,
				reserveTokens: settings.reserveTokens,
			};
		} catch {
			// Invalid settings: pi's own compaction throws on them too.
			return null;
		}
	}

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

	/** The system head a request carries, kept for Strategy A of a later fold. */
	function captureSystemHead(
		sm: SessionManager,
		sessionId: string,
		model: OverflowModel | undefined,
		messages: AgentMessage[],
	): void {
		try {
			const head = effectiveRequestMessages(sm, messages).filter(
				(message): message is Message => message.role === "system",
			);
			if (!model || head.length === 0) state.folds.capturedSystems.delete(sessionId);
			else {
				state.folds.capturedSystems.set(sessionId, {
					modelKey: `${model.provider}/${model.id}`,
					messages: head,
				});
			}
		} catch {
			state.folds.capturedSystems.delete(sessionId);
		}
	}

	/** The fold's snapshot: the gates every entry point shares, then the summary inputs. */
	function prepareFold(host: FoldHost, request: FoldRequest): FoldPrepared | { error: string } {
		const { sm } = host;
		const { rewindTo, newLabel } = request;
		const sessionLeaf = sm.getLeafId();
		if (!sessionLeaf) return { error: "no session entries yet, nothing to fold" };
		const foldPointId =
			request.origin === "recovery"
				? state.recovery.recoveryCuts.get(request.sessionId)
				: (host.foldPointId ?? sessionLeaf);
		if (!foldPointId) {
			return { error: "the recovery boundary was not snapshotted" };
		}
		if (!isValidName(rewindTo) || !isValidName(newLabel)) {
			return {
				error: `anchor and label names are kebab-case, at most ${MAX_NAME_LENGTH} characters`,
			};
		}
		if (findLabeledEntry(sm, LABEL_PREFIX + newLabel)) {
			return {
				error: `a label '${newLabel}' already exists on the active branch`,
			};
		}
		const targetId = findLabeledEntry(sm, LABEL_PREFIX + rewindTo);
		if (!targetId) return { error: `no label '${rewindTo}' on the active branch` };
		if (targetId === foldPointId)
			return { error: `already at '${rewindTo}', nothing to summarize` };
		const { entries } = collectEntriesForBranchSummary(sm, foldPointId, targetId);
		if (entries.length === 0) {
			return {
				error: `no entries between the leaf and '${rewindTo}', nothing to summarize`,
			};
		}
		const allEntries = sm.getEntries();
		const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
		// The folded leaf is part of what the fold frees, and a pre-compaction
		// anchor is priced by the history it would restore.
		const savings = estimateAdmissionTokens(sm) - estimateAtEntry(sm, allEntries, targetId, byId);
		if (savings < MIN_REWIND_SAVINGS_TOKENS) {
			return {
				error: buildMinSavingsRejection(
					rewindTo,
					newLabel,
					savings,
					sm,
					host.model?.contextWindow ?? 0,
					allEntries,
					byId,
					precedesLatestCompaction(sm.getBranch(), targetId),
				),
			};
		}
		const inContext = preparedInContext(
			sm,
			targetId,
			foldPointId,
			state.folds.capturedSystems.get(request.sessionId),
			host.model,
		);
		return {
			leafId: foldPointId,
			targetId,
			segment: buildFoldSegment(allEntries, sessionLeaf, targetId, foldPointId),
			inContext,
			parent: {
				mode: state.folds.parentModes.get(request.sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT,
				childCount: entries.filter((entry) => entry.type === "branch_summary").length,
			},
			continuitySection: continuityRequestSection(sm, {
				target: targetId,
				rewindTo,
			}),
		};
	}

	/** Commit a summary the engine wrote: late input stays out of the fold and follows the summary. */
	async function commitEngineFold(
		host: FoldHost,
		request: FoldRequest,
		prepared: FoldPrepared,
		summaryText: string,
	): Promise<FoldCommitResult<FoldLanded>> {
		const { sm } = host;
		let idle = true;
		try {
			idle = host.isIdle?.() ?? true;
		} catch {
			idle = false;
		}
		if (!idle) {
			return {
				ok: false,
				reason: "the agent started working during the fold",
			};
		}
		const contextWindow = host.model?.contextWindow ?? 0;
		const contextBefore = estimateAdmissionTokens(sm);
		const outcome = await commitFold(sm, {
			targetId: prepared.targetId,
			rewindTo: request.rewindTo,
			newLabel: request.newLabel,
			summaryText,
			handoffMode: prepared.parent?.mode ?? "full",
			contextWindow,
			foldPointId: prepared.leafId,
			recoveryEvidenceId: host.recoveryEvidenceId,
			branchLabelEntryId: prepared.leafId,
			continuationText: (afterTokens) =>
				buildRewindDoneText(
					{
						rewindTo: request.rewindTo,
						newLabel: request.newLabel,
						beforeTokens: contextBefore,
						contextWindow,
					},
					afterTokens,
				),
			writeLabel: (entryId, label) => writeLabel(sm, entryId, label),
		});
		if (!outcome.ok) return outcome;
		return {
			...outcome,
			targetId: prepared.targetId,
			contextBefore,
			contextWindow,
		};
	}

	/** One engine per run: its admission policy reads the window of the model this run uses. */
	async function runFold(
		host: FoldHost,
		request: FoldRequest,
		options: FoldRunOptions = {},
	): Promise<FoldResult> {
		const { sessionId } = request;
		if (state.folds.runningFolds.has(sessionId)) return { status: "busy" };
		state.folds.runningFolds.add(sessionId);
		try {
			return await createFoldEngine<FoldLanded>({
				prepare: (req) => prepareFold(host, req),
				runner: (req) => {
					const { model, registry, thinking } = host;
					if (!model) return { error: "no model is selected" };
					if (!registry.hasConfiguredAuth(model)) {
						return {
							error: `no authentication is configured for ${model.provider}/${model.id}`,
						};
					}
					return createFoldSummaryRunner({
						registry,
						model,
						thinking,
						sessionId: req.sessionId,
					});
				},
				admit: foldAdmission(host.model?.contextWindow ?? 0, tokenFactorOf(host.sm)),
				commit: (req, prepared, summary) => commitEngineFold(host, req, prepared, summary.text),
			}).run(request, options);
		} finally {
			state.folds.runningFolds.delete(sessionId);
		}
	}

	async function recoverIndependently(
		ctx: ExtensionContext,
		host: FoldHost,
		signal: AbortSignal | undefined,
	): Promise<
		| { status: "done"; draft: RewindMessageDraft }
		| { status: "failed"; detail: string }
		| { status: "cancelled" }
	> {
		const { sm, model } = host;
		const sessionId = sm.getSessionId();
		const contextWindow = model?.contextWindow ?? 0;
		const runSignal = ctx.signal;
		if (signal?.aborted) return { status: "cancelled" };
		// Factor-free, so a calibration the overflow taught does not read as growth.
		const heuristicTokens = Math.round(estimateAdmissionTokens(sm) / tokenFactorOf(sm));
		const prior = state.recovery.recoveryAttempts.get(sessionId);
		if (prior && prior.attempts >= MAX_RECOVERY_ATTEMPTS)
			return {
				status: "failed",
				detail: `${prior.attempts} recoveries for this request did not bring it under the window`,
			};
		if (prior && heuristicTokens >= prior.heuristicTokens)
			return {
				status: "failed",
				detail: `the previous recovery for this request did not reduce context (~${formatWindow(prior.heuristicTokens)} -> ~${formatWindow(heuristicTokens)} heuristic tokens)`,
			};
		state.recovery.recoveryAttempts.set(sessionId, {
			attempts: (prior?.attempts ?? 0) + 1,
			heuristicTokens,
		});
		if (!model || contextWindow <= 0)
			return { status: "failed", detail: "no operating window is available" };
		const captured = state.folds.capturedSystems.get(sessionId);
		const systemHead = effectiveRequestMessages(
			sm,
			captured?.messages ?? sm.buildSessionContext().messages,
		).filter((message) => message.role === "system");
		const modelKey = `${model.provider}/${model.id}`;
		if (
			accountRequest(systemHead, tokenFactorOf(sm)).tokens +
				RECOVERY_MIN_OUTPUT_TOKENS +
				RECOVERY_HEADROOM_TOKENS >
			contextWindow
		)
			return {
				status: "failed",
				detail: "the system prompt alone leaves no room for a recovered request",
			};
		host.isIdle = () =>
			!signal?.aborted &&
			ctx.signal === runSignal &&
			ctx.sessionManager === sm &&
			ctx.sessionManager.getSessionId() === sessionId &&
			`${ctx.model?.provider}/${ctx.model?.id}` === modelKey &&
			ctx.model?.contextWindow === contextWindow &&
			state.folds.capturedSystems.get(sessionId) === captured;
		const handoffMode = state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT;
		const budget = foldRecommendationBudget(
			contextWindow,
			resolveRewindHintReserve(
				{
					rewindHintReserveTokens: state.config.rewindHintReserveTokens,
					rewindHintModelReserveTokens: state.config.hintByModel,
				},
				modelKey,
			),
		);
		// Without a usable fold, a tail-keeping compaction is the next relief.
		const compactInstead = async (
			why: string,
		): Promise<
			| { status: "done"; draft: RewindMessageDraft }
			| { status: "failed"; detail: string }
			| { status: "cancelled" }
		> => {
			if (signal?.aborted) return { status: "cancelled" };
			// A changed model or session is not a size problem; nothing may write.
			if (host.isIdle?.() === false) return { status: "failed", detail: why };
			const config = resolveAutoNavigateConfig(
				{
					autoNavigate: state.config.autoNavigateBase,
					autoNavigateByModel: state.config.autoNavigateByModel,
					proposal: state.config.proposalConfig,
				},
				modelKey,
			);
			const before = estimateAdmissionTokens(sm);
			let compacted: Awaited<ReturnType<typeof compactUnderPressure>>;
			try {
				compacted = await compactUnderPressure({
					sm,
					sessionId,
					host,
					budget,
					keepRecentTokens: Math.min(config.rewindAtTokens, budget) * config.keepRecentShare,
					trigger: `The next request (~${formatWindow(before)} tokens) does not fit the ${formatWindow(contextWindow)} operating window and no fold could relieve it (${toOneLine(why, 200) ?? "no target"})`,
					origin: "recovery",
					activeTokens: before,
					captured: state.folds.capturedSystems.get(sessionId),
					handoffMode,
					signal,
					isCurrent: () => host.isIdle?.() ?? false,
				});
			} catch (error) {
				compacted = {
					kind: "skip",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			if (signal?.aborted || compacted.kind === "stale") return { status: "cancelled" };
			if (compacted.kind === "done") return { status: "done", draft: compacted.draft };
			return {
				status: "failed",
				detail: `${why}; a compaction did not help either: ${compacted.reason}`,
			};
		};
		const cut = recoveryCutOf(sm, host.recoveryEvidenceId);
		// A malformed tool envelope is not a size problem; nothing may rewrite it.
		if (!cut.ok) return { status: "failed", detail: cut.detail };
		try {
			const focus = defaultFoldFocus(sm);
			const candidates = priceFoldCandidates(sm, {
				model,
				handoffMode,
				captured: state.folds.capturedSystems.get(sessionId),
				focus,
				suggestLabel: (name) => suggestFoldLabel(sm, name),
				foldPointId: cut.foldPointId,
				thinking: host.thinking,
			});
			const selected = selectFoldTarget(candidates, budget);
			if (!selected.ok) return compactInstead(selected.reasons.join("; "));
			const request: FoldRequest = {
				sessionId,
				origin: "recovery",
				rewindTo: selected.candidate.name,
				newLabel: selected.candidate.suggestedLabel,
				focus,
			};
			state.recovery.recoveryCuts.set(sessionId, cut.foldPointId);
			let outcome: FoldResult;
			try {
				outcome = await runFold(host, request, { signal });
			} finally {
				state.recovery.recoveryCuts.delete(sessionId);
			}
			if (signal?.aborted || outcome.status === "cancelled") return { status: "cancelled" };
			if (outcome.status !== "done") {
				const detail =
					outcome.status === "failed" ? `${outcome.reason}: ${outcome.detail}` : outcome.status;
				// A fold whose write left the cursor uncertain must not be followed by another write.
				return unrestoredFoldCursors.has(sm)
					? { status: "failed", detail }
					: compactInstead(`the fold to '${request.rewindTo}' failed: ${detail}`);
			}
			return { status: "done", draft: foldDoneDraft(request, outcome) };
		} catch (error) {
			return {
				status: "failed",
				detail: `independent recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/** What a fold reads from the live context; read before the first await (stale-ctx contract). */
	function foldHostOf(
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry">,
	): FoldHost {
		return {
			sm: ctx.sessionManager as SessionManager,
			model: ctx.model,
			registry: ctx.modelRegistry,
			thinking: summaryThinking(),
		};
	}

	/** Fold summaries are extraction and one write-up: reasoning above low adds latency and cost, not fidelity. */
	function summaryThinking(): ThinkingLevel | "off" {
		const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
		return level === "off" || level === "minimal" || level === "low" ? level : "low";
	}

	const gateFailed = (reason: string, detail: string): FoldResult => ({
		status: "failed",
		stage: "gate",
		reason,
		detail,
		usage: [],
	});

	/**
	 * A fold for the session's next `turn_end` (a running agent). One fold per
	 * session is queued or running at a time.
	 */
	function queueFold(
		sessionId: string,
		request: FoldRequestInput,
	): { ok: true } | { ok: false; reason: string } {
		if (state.folds.queuedFolds.has(sessionId) || state.folds.runningFolds.has(sessionId)) {
			return {
				ok: false,
				reason: "a fold is already queued or running for this session",
			};
		}
		state.folds.queuedFolds.set(sessionId, { ...request, sessionId });
		return { ok: true };
	}

	/** Persist a fold's receipt as a message that starts no turn; the session is idle. */
	function appendFoldMessage(sm: SessionManager, draft: RewindMessageDraft): void {
		if (unrestoredFoldCursors.has(sm)) return;
		const primary = trySessionWrite(sm, () =>
			pi.sendMessage(
				{
					customType: draft.customType,
					content: draft.content,
					display: draft.display,
					details: draft.details,
				},
				{ triggerTurn: false },
			),
		);
		if (primary.ok || !primary.cursorRestored) return;
		trySessionWrite(sm, () =>
			sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details),
		);
	}

	/** Fold an idle session now: nothing is written before the commit, then the continuation is appended. */
	async function runFoldNow(
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "isIdle">,
		request: FoldRequestInput,
		options: FoldRunOptions = {},
	): Promise<FoldResult> {
		let host: FoldHost;
		let full: FoldRequest;
		try {
			host = foldHostOf(ctx);
			host.isIdle = () => ctx.isIdle();
			full = { ...request, sessionId: host.sm.getSessionId() };
		} catch (error) {
			return gateFailed("exception", error instanceof Error ? error.message : String(error));
		}
		const outcome = await runFold(host, full, options);
		if (outcome.status === "done") appendFoldMessage(host.sm, foldDoneDraft(full, outcome));
		return outcome;
	}

	function foldBudget(ctx: ExtensionCommandContext): number {
		const model = ctx.model;
		return foldRecommendationBudget(
			model?.contextWindow ?? 0,
			resolveRewindHintReserve(
				{
					rewindHintReserveTokens: state.config.rewindHintReserveTokens,
					rewindHintModelReserveTokens: state.config.hintByModel,
				},
				model ? `${model.provider}/${model.id}` : undefined,
			),
		);
	}

	function manualFocus(plan: FoldPlan, sm: SessionManager): string {
		const typed = plan.focus?.trim();
		return typed && typed.length >= MIN_SUMMARY_FOCUS_LENGTH ? typed : defaultFoldFocus(sm);
	}

	/** Plan and engine access for a manual fold. `preselect` wraps the recommendation so list `r` lands on that anchor. */
	function manualFoldDeps(ctx: ExtensionCommandContext, preselect?: string): FoldPlanDeps {
		const recommend = (candidates: readonly FoldPlanCandidate[]) => {
			if (preselect) {
				const at = candidates.findIndex((candidate) => candidate.name === preselect);
				if (at >= 0) return at;
			}
			return recommendFoldIndex(candidates, foldBudget(ctx));
		};
		return {
			candidates(commandCtx) {
				const sm = commandCtx.sessionManager as SessionManager;
				const sessionId = sm.getSessionId();
				return priceFoldCandidates(sm, {
					model: commandCtx.model,
					handoffMode: state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT,
					captured: state.folds.capturedSystems.get(sessionId),
					focus: defaultFoldFocus(sm),
					suggestLabel: (name) => suggestFoldLabel(sm, name),
					thinking: foldHostOf(commandCtx).thinking,
				});
			},
			recommend,
			isAgentRunning: (commandCtx) => !commandCtx.isIdle(),
			summaryModel(commandCtx) {
				const model = commandCtx.model;
				if (!model) return "no model selected";
				return `${model.provider}/${model.id}:${summaryThinking()}`;
			},
			minFocusLength: MIN_SUMMARY_FOCUS_LENGTH,
			async start(commandCtx, plan, options) {
				const sm = commandCtx.sessionManager as SessionManager;
				const before = estimateAdmissionTokens(sm);
				const outcome = await runFoldNow(
					commandCtx,
					{
						origin: "manual",
						rewindTo: plan.anchor,
						newLabel: plan.label,
						focus: manualFocus(plan, sm),
					},
					{ signal: options.signal, onProgress: options.onProgress },
				);
				const landed = outcome.status === "done" ? outcome.commit : undefined;
				return foldPlanResult(outcome, {
					label: plan.label,
					beforeTokens: landed?.contextBefore ?? before,
					afterTokens: landed?.afterTokens ?? before,
				});
			},
			queue(commandCtx, plan) {
				try {
					const sm = commandCtx.sessionManager as SessionManager;
					return queueFold(sm.getSessionId(), {
						origin: "manual",
						rewindTo: plan.anchor,
						newLabel: plan.label,
						focus: manualFocus(plan, sm),
					});
				} catch (error) {
					return {
						ok: false,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			},
		};
	}

	function openManualFold(
		ctx: ExtensionCommandContext,
		preselect?: string,
	): Promise<"back" | "done"> {
		return openFoldPlanScreen(ctx, manualFoldDeps(ctx, preselect));
	}

	foldApis.set(pi, { queueFold, runFoldNow });

	/**
	 * The queued fold at a `turn_end` boundary, after this turn's tool results
	 * are on the branch: its receipt is a boundary draft. Esc cancels it; a
	 * landed fold continues the run; a precommit failure continues only when
	 * the model asked for it and the run was not cancelled. Undefined when the ctx
	 * is stale (the fold stays queued).
	 */
	async function runQueuedFold(
		sm: SessionManager,
		sessionId: string,
		request: FoldRequest,
		message: { stopReason?: string },
		event: { entries?: SessionBoundaryDraft[] },
		ctx: ExtensionContext,
	): Promise<{ entries: SessionBoundaryDraft[]; continue?: boolean } | undefined> {
		let host: FoldHost;
		let signal: AbortSignal | undefined;
		try {
			host = foldHostOf(ctx);
			signal = ctx.signal;
		} catch {
			return undefined;
		}
		state.folds.queuedFolds.delete(sessionId);
		state.turns.rewindTurns.add(message);
		const deliver = (draft: RewindMessageDraft, cont: boolean) => ({
			entries: keepValidDrafts<SessionBoundaryDraft>(sm, [...(event.entries ?? []), draft]),
			continue: cont,
		});
		const notLanded = (outcome: Exclude<FoldResult, { status: "done" }>) => {
			const draft = foldFailedDraft(request, outcome);
			if (unrestoredFoldCursors.has(sm)) {
				try {
					if (ctx.hasUI) ctx.ui.notify(String(draft.content), "error");
				} catch {
					// A stale UI cannot make a receipt append safe.
				}
				return { entries: [], continue: false };
			}
			return deliver(
				draft,
				request.origin === "agent" &&
					outcome.status !== "cancelled" &&
					!(outcome.status === "failed" && outcome.stage === "commit"),
			);
		};
		if (signal?.aborted || message.stopReason === "aborted") {
			return notLanded({ status: "cancelled", usage: [] });
		}
		let outcome: FoldResult;
		try {
			// The folded span's user input belongs in the ledger the fold starts from.
			await captureContinuity(sm, sessionId, ctx, message);
			outcome = await runFold(host, request, { signal });
		} catch (error) {
			outcome = gateFailed("exception", error instanceof Error ? error.message : String(error));
		}
		if (outcome.status !== "done") return notLanded(outcome);
		return deliver(foldDoneDraft(request, outcome), true);
	}

	// Runs at a `turn_end` boundary, where the assistant and all its tool
	// results are already on the branch, so the entry cannot land inside a tool
	// batch (`endsInOpenToolBatch` guards the rest). A plain `appendEntry` is
	// safe there: pi previews every handler's drafts against the live branch.
	// Fail-open and time-bounded; never throws into the turn.
	async function captureContinuity(
		sm: SessionManager,
		sessionId: string,
		ctx: {
			hasUI: boolean;
			ui: { notify(message: string, type?: "warning"): void };
			modelRegistry?: Parameters<typeof createModelClassifier>[0];
			signal?: AbortSignal;
		},
		message: { stopReason?: string },
	): Promise<void> {
		if (!state.config.continuity.capture) return;
		const captureConfig = state.config.continuity;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return;
		}
		// Every ctx getter is read before the first await (stale-ctx contract).
		let notify: ((text: string) => void) | undefined;
		let registry: typeof ctx.modelRegistry;
		let parentSignal: AbortSignal | undefined;
		let branch: SessionEntry[];
		let leafId: string | null;
		let base: BranchLedger;
		try {
			if (ctx.hasUI) {
				const ui = ctx.ui;
				notify = (text) => ui.notify(text, "warning");
			}
			registry = ctx.modelRegistry;
			parentSignal = ctx.signal;
			branch = sm.getBranch();
			leafId = sm.getLeafId();
			if (endsInOpenToolBatch(branch)) return;
			base = readBranchLedger(branch);
		} catch {
			return;
		}
		if (parentSignal?.aborted) return;
		const warned = state.continuity.continuityWarned.get(sessionId) ?? new Set<string>();
		state.continuity.continuityWarned.set(sessionId, warned);
		const warn = (text: string) => {
			if (state.config.continuity !== captureConfig || parentSignal?.aborted || warned.has(text))
				return;
			warned.add(text);
			try {
				notify?.(text);
			} catch {
				// Stale ctx: nothing left to surface with.
			}
		};
		const model = state.continuity.classifierTimedOut.has(sessionId)
			? null
			: state.config.continuity.intentClassifier;
		const controller = new AbortController();
		const abort = () => controller.abort();
		parentSignal?.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve("timeout");
			}, CONTINUITY_CAPTURE_TIMEOUT_MS);
		});
		const { ledger, watermark } = base;
		const run = (async () => {
			const classifier: IntentClassifier =
				(model !== null && registry
					? await createModelClassifier(registry, model, { onWarning: warn })
					: undefined) ?? heuristicClassifier;
			return {
				usedModel: classifier !== heuristicClassifier,
				result: await captureIntent(branch, watermark, ledger, classifier, {
					signal: controller.signal,
				}),
			};
		})().catch(() => undefined);
		let outcome: Awaited<typeof run> | "timeout";
		try {
			outcome = await Promise.race([run, deadline]);
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abort);
		}
		if (state.config.continuity !== captureConfig || parentSignal?.aborted) return;
		if (outcome === "timeout") {
			if (model === null) return;
			state.continuity.classifierTimedOut.add(sessionId);
			warn(
				`${TOOL_NAME}: continuity classifier ${model.startsWith("{") ? (resolveIntentPolicy(model)?.kind.model ?? "configured policy") : model} did not answer within ${CONTINUITY_CAPTURE_TIMEOUT_MS / 1000} s; capture uses heuristics for the rest of this session.`,
			);
			return await captureContinuity(sm, sessionId, ctx, message);
		}
		try {
			// A moved leaf or an abort during the await: the scan is stale.
			if (
				!outcome ||
				parentSignal?.aborted ||
				sm.getLeafId() !== leafId ||
				state.config.continuity !== captureConfig
			)
				return;
			const { result, usedModel } = outcome;
			for (const text of result.warnings) warn(text);
			// Heuristic verdicts are free to recompute; only a model's are worth a
			// watermark of their own.
			if (result.ops.length === 0 && !(usedModel && result.classified > 0)) {
				return;
			}
			appendOpsEntry(pi, result.ops, result.watermark);
		} catch {
			// Fail-open: the next turn rescans from the same watermark.
		}
	}

	// Folds (by summary entry id) whose first post-fold turn was already
	// nudged: at most one nudge per fold, even if pi dropped its draft.

	// The first assistant turn after a delivered fold continuation ended
	// text-only while the fold's summary still lists open work: one steer, so
	// the milestone summary is not read as a stop condition. No user turn may
	// sit between the continuation and the turn, and a fold that carried late
	// user input answers that input, so neither is nudged. A fold forced by a
	// context overflow is not nudged either.
	function continueNudgeDraft(
		sm: SessionManager,
		sessionId: string,
		message: { content?: unknown; stopReason?: string },
		event: { messageEntryId?: unknown; continue?: boolean },
		signal: AbortSignal | undefined,
	): RewindMessageDraft | undefined {
		if (event.continue || signal?.aborted) return;
		if ((state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false)
			return;
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.stopReason === "length" ||
			state.turns.rewindTurns.has(message) ||
			state.turns.overflowedTurns.has(message)
		) {
			return;
		}
		if (Array.isArray(message.content) && message.content.some((b) => b?.type === "toolCall")) {
			return;
		}
		try {
			const branch = sm.getBranch();
			const at =
				typeof event.messageEntryId === "string" && event.messageEntryId
					? branch.findIndex((e) => e.id === event.messageEntryId)
					: branch.length - 1;
			for (let i = at - 1; i >= 0; i--) {
				const entry = branch[i];
				if (
					entry.type === "message" ||
					entry.type === "branch_summary" ||
					entry.type === "compaction"
				) {
					return;
				}
				if (entry.type !== "custom_message" || entry.customType !== REWIND_CUSTOM_TYPE) {
					continue;
				}
				const d = entry.details as
					| {
							status?: unknown;
							summaryId?: unknown;
							reappendedLateMessages?: unknown;
							forced?: unknown;
					  }
					| undefined;
				if (
					d?.status !== "done" ||
					typeof d.summaryId !== "string" ||
					d.forced === true ||
					Number(d.reappendedLateMessages) > 0 ||
					state.continuity.nudgedFolds.has(d.summaryId)
				) {
					return;
				}
				const fold = sm.getEntry(d.summaryId);
				if (fold?.type !== "branch_summary" || !hasOpenWork(fold.summary)) return;
				state.continuity.nudgedFolds.add(d.summaryId);
				return rewindMessageDraft(CONTINUE_NUDGE_TEXT, {
					status: CONTINUE_NUDGE_STATUS,
					summaryId: d.summaryId,
				});
			}
		} catch {
			// Fail-open: no nudge.
		}
		return undefined;
	}

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

	// Rewind hint (#44): one check per turn, after the turn's tool results and
	// before the agent loop's steering drain — so a `pi.sendMessage` from this
	// handler is delivered in the same run. Synchronous by design: no await
	// before any ctx use. Fires once per reserve crossing; see
	// `RewindHintTracker` for the re-arm semantics.
	pi.on("turn_end", (event, ctx) => {
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
	});

	async function maybeRunAutomaticFold(
		sm: SessionManager,
		sessionId: string,
		message: { role?: string; stopReason?: string; content?: unknown },
		event: { entries?: SessionBoundaryDraft[]; continue?: boolean },
		ctx: ExtensionContext,
	): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean } | undefined> {
		if (
			(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			state.turns.rewindTurns.has(message) ||
			state.turns.overflowedTurns.has(message) ||
			state.folds.queuedFolds.has(sessionId) ||
			state.folds.runningFolds.has(sessionId) ||
			unrestoredFoldCursors.has(sm)
		)
			return;
		let host: FoldHost;
		let signal: AbortSignal | undefined;
		let registry: ModelRegistry;
		let notify: ((text: string) => void) | undefined;
		try {
			host = foldHostOf(ctx);
			signal = ctx.signal;
			registry = ctx.modelRegistry;
			const ui = ctx.hasUI ? ctx.ui : undefined;
			notify = ui ? (text) => ui.notify(text, "warning") : undefined;
			if (host.sm !== sm || sm.getSessionId() !== sessionId) return;
		} catch {
			return;
		}
		if (!host.model) return;
		host.model = structuredClone(host.model);
		const modelKey = `${host.model.provider}/${host.model.id}`;
		const modelSnapshot = JSON.stringify(host.model);
		const currentConfig = () =>
			resolveAutoNavigateConfig(
				{
					autoNavigate: state.config.autoNavigateBase,
					autoNavigateByModel: state.config.autoNavigateByModel,
					proposal: state.config.proposalConfig,
				},
				modelKey,
			);
		const config = structuredClone(currentConfig());
		if (!config.enabled) return;
		const signature = JSON.stringify(config);
		const capturedSource = state.folds.capturedSystems.get(sessionId);
		const captured = structuredClone(capturedSource);
		const handoffMode = state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT;
		const reserve = resolveRewindHintReserve(
			{
				rewindHintReserveTokens: state.config.rewindHintReserveTokens,
				rewindHintModelReserveTokens: state.config.hintByModel,
			},
			modelKey,
		);
		const leafId = sm.getLeafId();
		if (!leafId) return;
		const entries = structuredClone(sm.getEntries());
		const labels = new Map(entries.map((entry) => [entry.id, sm.getLabel(entry.id)]));
		const snapshot = JSON.stringify(entries);
		const branch = sm.getBranch();
		const newestAnchorId = branch.findLast((entry) =>
			labels.get(entry.id)?.startsWith(LABEL_PREFIX),
		)?.id;
		const activeTokens = estimateAdmissionTokens(sm);
		const anchorTokens = newestAnchorId
			? estimateAtEntry(
					sm,
					entries,
					newestAnchorId,
					new Map(entries.map((entry) => [entry.id, entry])),
				)
			: 0;
		let expectedState = state.automatic.autoFoldStateBySession.get(sessionId);
		const isCurrent = () => {
			try {
				return (
					!signal?.aborted &&
					ctx.signal === signal &&
					ctx.sessionManager === sm &&
					sm.getSessionId() === sessionId &&
					sm.getLeafId() === leafId &&
					`${ctx.model?.provider}/${ctx.model?.id}` === modelKey &&
					JSON.stringify(ctx.model) === modelSnapshot &&
					ctx.modelRegistry === registry &&
					state.folds.capturedSystems.get(sessionId) === capturedSource &&
					JSON.stringify(capturedSource) === JSON.stringify(captured) &&
					(state.folds.parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT) === handoffMode &&
					resolveRewindHintReserve(
						{
							rewindHintReserveTokens: state.config.rewindHintReserveTokens,
							rewindHintModelReserveTokens: state.config.hintByModel,
						},
						modelKey,
					) === reserve &&
					JSON.stringify(currentConfig()) === signature &&
					JSON.stringify(sm.getEntries()) === snapshot &&
					entries.every((entry) => sm.getLabel(entry.id) === labels.get(entry.id)) &&
					state.automatic.autoFoldStateBySession.get(sessionId) === expectedState &&
					(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) !==
						false &&
					!state.folds.queuedFolds.has(sessionId) &&
					!unrestoredFoldCursors.has(sm)
				);
			} catch {
				return false;
			}
		};
		const plan = await planAutomaticFold({
			state: expectedState,
			sessionId,
			modelKey,
			config,
			activeTokens,
			newestAnchorId,
			anchorTokens,
			calledNavigateTree:
				Array.isArray(message.content) &&
				message.content.some(
					(block: { type?: string; name?: string }) =>
						block?.type === "toolCall" && block.name === TOOL_NAME,
				),
			entries,
			leafId,
			getLabel: (id) => labels.get(id),
			registry,
			signal,
			isCurrent: () => isCurrent() && !state.folds.runningFolds.has(sessionId),
		});
		if (!isCurrent() || state.folds.runningFolds.has(sessionId)) return;
		expectedState = plan.state;
		state.automatic.autoFoldStateBySession.set(sessionId, plan.state);
		const warnings = plan.warnings
			.slice(0, 3)
			.map((text) => toOneLine(text, 500) ?? "Automatic fold check unavailable.");
		const drafts: SessionBoundaryDraft[] = [...(event.entries ?? [])];
		if (warnings.length) {
			const text = warnings.join("\n");
			try {
				notify?.(text);
			} catch {
				/* A stale UI must not block the receipt. */
			}
			drafts.push({
				type: "custom_message",
				customType: "navigate-tree-auto-warning",
				content: text,
				display: true,
			});
		}
		const deliver = (draft?: RewindMessageDraft, cont = false) => ({
			entries: keepValidDrafts<SessionBoundaryDraft>(sm, [...drafts, ...(draft ? [draft] : [])]),
			continue: cont,
		});
		const anchor = (entryId: string, name: string) => {
			if (
				!isCurrent() ||
				state.folds.runningFolds.has(sessionId) ||
				!sm.getBranch().some((entry) => entry.id === entryId) ||
				sm.getLabel(entryId) !== undefined
			)
				return;
			let unique = name;
			for (let n = 2; findLabeledEntry(sm, LABEL_PREFIX + unique); n++) {
				const suffix = `-${n}`;
				unique = name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, "") + suffix;
			}
			if (isValidName(unique)) writeLabel(sm, entryId, LABEL_PREFIX + unique);
		};
		if (plan.action.kind === "anchor") {
			anchor(plan.action.entryId, plan.action.suggestedName);
		} else if (plan.action.kind === "pressure-fold") {
			// Canonical cut and shared materialized preview as in recovery: the newest
			// anchor that lands under the pressure budget, else the oldest valid one.
			// A fold that lands high still relieves pressure; the retry runway keeps
			// it from repeating every few turns.
			const skipped = (reason: string) => {
				let overhead: string | undefined;
				try {
					overhead = fixedOverheadNote({
						messages: admissionMessages(sm),
						activeTokens,
						limit: config.rewindAtTokens,
						factor: tokenFactorOf(sm),
					});
				} catch {
					/* The diagnosis is advisory; the warning still lands. */
				}
				const text = `[${TOOL_NAME} auto_navigate] Context ~${formatWindow(activeTokens)} crossed rewind_at_tokens ${formatWindow(config.rewindAtTokens)}, but no fold ran: ${toOneLine(reason, 400) ?? "no target"}${overhead ? `. ${overhead}` : ""}`;
				try {
					notify?.(text);
				} catch {
					/* A stale UI must not block the receipt. */
				}
				drafts.push({
					type: "custom_message",
					customType: "navigate-tree-auto-warning",
					content: text,
					display: true,
				});
				return deliver();
			};
			if (config.pressure === "compact") {
				const compacted = await compactUnderPressure({
					sm,
					sessionId,
					host,
					budget: pressureFoldBudget(config.rewindAtTokens),
					keepRecentTokens: config.rewindAtTokens * config.keepRecentShare,
					trigger: `Context ~${formatWindow(activeTokens)} crossed rewind_at_tokens ${formatWindow(config.rewindAtTokens)}`,
					origin: "pressure",
					activeTokens,
					captured,
					handoffMode,
					signal,
					isCurrent,
				});
				if (compacted.kind === "stale") return;
				if (compacted.kind === "skip") return skipped(compacted.reason);
				drafts.push(compacted.draft);
				return deliver(undefined, event.continue ?? false);
			}
			const cut = recoveryCutOf(sm);
			if (!cut.ok) return skipped(cut.detail);
			const focus = defaultFoldFocus(sm);
			const candidates = priceFoldCandidates(sm, {
				model: host.model,
				handoffMode,
				captured,
				focus,
				suggestLabel: (name) => suggestFoldLabel(sm, name),
				foldPointId: cut.foldPointId,
				thinking: host.thinking,
			});
			const budget = pressureFoldBudget(config.rewindAtTokens);
			const selected = selectFoldTarget(candidates, budget);
			if (!selected.ok) return skipped(selected.reasons.join("; "));
			if (!isCurrent() || state.folds.runningFolds.has(sessionId)) return;
			const request: FoldRequest = {
				sessionId,
				origin: "auto",
				rewindTo: selected.candidate.name,
				newLabel: selected.candidate.suggestedLabel,
				focus,
			};
			host.isIdle = isCurrent;
			host.foldPointId = cut.foldPointId;
			state.turns.rewindTurns.add(message);
			let outcome: FoldResult;
			try {
				outcome = await runFold(host, request, { signal });
			} catch (error) {
				outcome = gateFailed("exception", error instanceof Error ? error.message : String(error));
			}
			if (outcome.status === "done") {
				const done = foldDoneDraft(request, outcome);
				if (!selected.withinBudget) {
					done.content += `\n\n[${TOOL_NAME} auto_navigate] No anchor lands under the ~${formatWindow(budget)} pressure target (half of rewind_at_tokens), so this fold used the oldest valid anchor; it still relieves context, and the next pressure fold waits for the retry runway.`;
					done.details.aboveTarget = true;
					done.details.target = budget;
				}
				return deliver(done, true);
			}
			const draft = foldFailedDraft(request, outcome);
			if (unrestoredFoldCursors.has(sm)) {
				try {
					notify?.(String(draft.content));
				} catch {
					/* The cursor is quarantined. */
				}
				return { entries: [], continue: false };
			}
			return deliver(draft);
		}
		return warnings.length ? deliver() : undefined;
	}

	/**
	 * Tail-keeping pressure relief: summarize the projected work older than the
	 * newest `keep_recent_share` of rewind_at_tokens into a native compaction and
	 * keep the recent tool turns verbatim, so the agent does not re-read them.
	 * Open user requests and the continuity briefing ride along verbatim; the
	 * compaction entry gets an anchor, the floor later folds and recovery use.
	 */
	async function compactUnderPressure(input: {
		sm: SessionManager;
		sessionId: string;
		host: FoldHost;
		/** Tokens the compacted request should land under; a guide, not a gate. */
		budget: number;
		keepRecentTokens: number;
		/** Receipt lead, e.g. "Context ~150k crossed rewind_at_tokens 200k". */
		trigger: string;
		origin: "pressure" | "recovery";
		activeTokens: number;
		captured: { modelKey: string; messages: Message[] } | undefined;
		handoffMode: HandoffMode;
		signal: AbortSignal | undefined;
		isCurrent(): boolean;
	}): Promise<
		| { kind: "done"; draft: RewindMessageDraft }
		| { kind: "skip"; reason: string }
		| { kind: "stale" }
	> {
		const { sm, sessionId, host, budget, activeTokens, signal } = input;
		const { model, registry } = host;
		const leafId = sm.getLeafId();
		if (!model || !leafId) return { kind: "stale" };
		const all = sm.getEntries();
		const projected = buildFoldProjection(all, leafId).entries;
		if (!registry.hasConfiguredAuth(model))
			return {
				kind: "skip",
				reason: `no authentication is configured for ${model.provider}/${model.id}`,
			};
		const cutEntries = projected.map((entry) => {
			const messages = entry.messages.filter((m) => m.role !== "system");
			return {
				entryId: entry.sourceEntry.id,
				tokens: estimateContentTokens(messages),
				roles: messages.map((m) => m.role),
				toolCallIds: messages.flatMap((m) =>
					m.role === "assistant"
						? m.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
						: [],
				),
				toolResultIds: messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
			};
		});
		// One candidate cut: its records, open requests and the priced request a
		// compaction with a full-size summary would leave.
		const planAt = (keepRecentTokens: number) => {
			const cut = planPressureCut({ keepRecentTokens, entries: cutEntries });
			if (cut.kind === "skip") return { kind: "skip" as const, reason: cut.detail };
			const cutAt = projected.findIndex((entry) => entry.sourceEntry.id === cut.firstKeptEntryId);
			const records = buildConsolidationSegment(all, leafId, cut.firstKeptEntryId);
			if (cutAt < 0 || !records.length)
				return {
					kind: "skip" as const,
					reason: "the cut is no longer in the projected context",
				};
			const requests = collectOpenUserRequests(
				projected,
				leafId,
				new Set(projected.slice(cutAt).map((entry) => entry.sourceEntry.id)),
				REWIND_CUSTOM_TYPE,
			);
			const quoted = requests.length
				? "\n\n## Open user requests\nThe work above was compacted to free context. The user request(s) below are still open and quoted verbatim; continue them.\n" +
					requests
						.map(
							(request) =>
								`\nQuoted user request (source entry ID: ${request.sourceEntryId}):\n<archived-user-request>\n${request.text}\n</archived-user-request>`,
						)
						.join("\n")
				: "";
			const details = (summary?: { strategy: string; calls: number }) => ({
				navigateTree: {
					pressure: {
						keptTokens: Math.round(cut.keptTokens * tokenFactorOf(sm)),
						prefixTokens: cut.prefixTokens,
						...(summary && {
							strategy: summary.strategy,
							calls: summary.calls,
						}),
						openUserRequests: requests,
					},
				},
			});
			const compactionText = (summaryText: string) => {
				const continuity = compactionContinuity(sm.getBranch(), summaryText);
				return continuity.briefing === undefined
					? continuity.summaryText + quoted
					: appendContinuityBriefing(continuity.summaryText + quoted, continuity.briefing);
			};
			const previewOf = (summary: string, info?: object): CompactionEntry => ({
				type: "compaction",
				id: "tree-navigator-pressure-preview",
				parentId: leafId,
				timestamp: new Date().toISOString(),
				summary,
				firstKeptEntryId: cut.firstKeptEntryId,
				tokensBefore: activeTokens,
				details: info,
				fromHook: true,
				...systemCheckpoint(sm),
			});
			// The request after the compaction, priced as the request guard prices it,
			// including the effective system state and the model-visible receipt.
			const admissionAfter = (preview: CompactionEntry, receipt: string) => {
				const withPreview = [...sm.getEntries(), preview];
				return requestAccounting(sm, [
					...projectHandoffs(buildSessionProjection(withPreview, preview.id), withPreview).messages,
					{
						role: "custom",
						customType: PRESSURE_COMPACTION_CUSTOM_TYPE,
						content: receipt,
						display: true,
						timestamp: Date.now(),
					},
				]).tokens;
			};
			const receiptText = (after: number, anchor?: string) =>
				`[${TOOL_NAME} ${input.origin === "pressure" ? "auto_navigate" : "recovery"}] ${input.trigger}: older work was compacted, context ~${formatWindow(activeTokens)} -> ~${formatWindow(after)} tokens${after > budget ? `, above the ~${formatWindow(budget)} target (the system prompt, tools, kept work and summary leave no smaller result)` : ""}. The newest ~${formatWindow(cut.keptTokens)} tokens of work stay verbatim${requests.length ? `; ${requests.length} open request(s) are quoted in the summary` : ""}.${anchor ? ` Anchor '${anchor}' marks the compaction.` : ""} The original entries remain in the session file.`;
			const floor = admissionAfter(
				previewOf(compactionText(foldPlaceholderSummary(summarizerReduceTokens(model))), details()),
				receiptText(activeTokens, "compacted-00"),
			);
			return {
				kind: "plan" as const,
				cut,
				cutAt,
				records,
				requests,
				details,
				compactionText,
				previewOf,
				admissionAfter,
				receiptText,
				floor,
			};
		};
		// The newest work stays verbatim, but a kept tail too large to land under
		// the budget shrinks first, down to a quarter of the configured share.
		// Cut entries are raw heuristic tokens; the configured tail is calibrated.
		const configuredKeep = Math.floor(input.keepRecentTokens / tokenFactorOf(sm));
		const minKeep = Math.ceil(configuredKeep * MIN_KEPT_SHARE_OF_CONFIGURED);
		let plan = planAt(configuredKeep);
		for (let tries = 0; tries < 4; tries++) {
			if (plan.kind !== "plan" || plan.floor <= budget) break;
			const next =
				Math.min(configuredKeep, plan.cut.keptTokens) -
				Math.ceil(((plan.floor - budget) / tokenFactorOf(sm)) * 1.05);
			if (next < minKeep) break;
			const smaller = planAt(next);
			if (smaller.kind !== "plan" || smaller.cut.keptTokens >= plan.cut.keptTokens) break;
			plan = smaller;
		}
		// Over budget is still relief: the compaction runs with the smallest tail
		// tried, and only a compaction that frees too little is skipped.
		if (plan.kind !== "plan") return plan;
		const {
			cut,
			cutAt,
			records,
			requests,
			details,
			compactionText,
			previewOf,
			admissionAfter,
			receiptText,
		} = plan;
		state.folds.runningFolds.add(sessionId);
		try {
			const summary = await summarizeFold({
				runner: createFoldSummaryRunner({
					registry,
					model,
					thinking: host.thinking,
					sessionId,
				}),
				focus: `${defaultFoldFocus(sm)} The newest ~${formatWindow(cut.keptTokens)} tokens of work stay verbatim after this summary; record the state of the work in progress and what comes next.`,
				parent: {
					mode: input.handoffMode,
					childCount: projected
						.slice(0, cutAt)
						.filter((entry) => entry.sourceEntry.type === "branch_summary").length,
				},
				inContext: preparedInContext(sm, undefined, leafId, input.captured, model),
				segment: { background: "", records },
				admit: foldAdmission(model.contextWindow ?? 0, tokenFactorOf(sm)),
				signal,
			});
			if (!input.isCurrent()) return { kind: "stale" };
			if (!summary.ok) return { kind: "skip", reason: `${summary.reason}: ${summary.detail}` };
			const text = compactionText(summary.text);
			const info = details(summary);
			const preview = previewOf(text, info);
			const now = sm.getEntries();
			const before = estimateContentTokens(buildFoldProjection(now, leafId).messages);
			const after = estimateContentTokens(
				buildFoldProjection([...now, preview], preview.id).messages,
			);
			const projectedAfter = admissionAfter(preview, receiptText(activeTokens, "compacted-00"));
			if ((before - after) * tokenFactorOf(sm) < MIN_REWIND_SAVINGS_TOKENS)
				return {
					kind: "skip",
					reason: `the compaction does not free enough context (estimated ${before} -> ${after} tokens); original history was kept`,
				};
			const written = trySessionWrite(sm, () =>
				sm.appendCompaction(text, cut.firstKeptEntryId, activeTokens, info, true),
			);
			if (!written.ok) {
				if (!written.cursorRestored) unrestoredFoldCursors.add(sm);
				return {
					kind: "skip",
					reason: `the compaction could not be written (${written.error instanceof Error ? written.error.message : String(written.error)}); ${written.cursorRestored ? "the session cursor was restored" : "persistence is uncertain, reload the session before folding again"}`,
				};
			}
			let name = "compacted";
			for (let n = 2; findLabeledEntry(sm, LABEL_PREFIX + name); n++) name = `compacted-${n}`;
			const anchored = writeLabel(sm, written.value, LABEL_PREFIX + name);
			refreshAgentMessages(sm);
			await emitSessionCompact(sm, written.value);
			return {
				kind: "done",
				draft: {
					type: "custom_message",
					customType: PRESSURE_COMPACTION_CUSTOM_TYPE,
					content: receiptText(projectedAfter, anchored ? name : undefined),
					display: true,
					details: {
						origin: input.origin,
						compactionId: written.value,
						anchor: anchored ? name : undefined,
						before: activeTokens,
						after: projectedAfter,
						target: budget,
						aboveTarget: projectedAfter > budget,
						keptTokens: cut.keptTokens,
						strategy: summary.strategy,
						calls: summary.calls,
						openUserRequests: requests.length,
					},
				},
			};
		} catch (error) {
			return {
				kind: "skip",
				reason: error instanceof Error ? error.message : String(error),
			};
		} finally {
			state.folds.runningFolds.delete(sessionId);
		}
	}

	/**
	 * Background handoff consolidation at a turn boundary nothing else used:
	 * merge every projected entry before the oldest of the newest handoffs into
	 * one native compaction. Pi projects that compaction followed by the kept
	 * entries; later folds carry it forward (`carriedCompaction`). Returns the
	 * receipt or warning to append, or nothing when no check was due.
	 */
	async function maybeConsolidate(
		sm: SessionManager,
		sessionId: string,
		message: { stopReason?: string },
		ctx: ExtensionContext,
	): Promise<SessionBoundaryDraft[] | undefined> {
		const config = state.config.consolidation;
		if (
			!config.enabled ||
			(state.activity.toolActiveBySession.get(sessionId) ?? state.activity.toolActive) === false ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			state.folds.queuedFolds.has(sessionId) ||
			state.folds.runningFolds.has(sessionId) ||
			unrestoredFoldCursors.has(sm)
		)
			return;
		let host: FoldHost;
		let signal: AbortSignal | undefined;
		let notify: ((text: string) => void) | undefined;
		try {
			host = foldHostOf(ctx);
			signal = ctx.signal;
			const ui = ctx.hasUI ? ctx.ui : undefined;
			notify = ui ? (text) => ui.notify(text, "warning") : undefined;
			if (host.sm !== sm || sm.getSessionId() !== sessionId) return;
		} catch {
			return;
		}
		const { model, registry } = host;
		const leafId = sm.getLeafId();
		if (!model || !leafId || signal?.aborted) return;
		const contextWindow = model.contextWindow ?? 0;
		const entries = sm.getEntries();
		const projected = buildFoldProjection(entries, leafId).entries;
		const handoffs: {
			entryId: string;
			tokens: number;
			prefixTokens: number;
		}[] = [];
		let prefixTokens = 0;
		for (const entry of projected) {
			const messages = entry.messages.filter((m) => m.role !== "system");
			const tokens = estimateContentTokens(messages);
			if (entry.sourceEntry.type === "branch_summary")
				handoffs.push({ entryId: entry.sourceEntry.id, tokens, prefixTokens });
			prefixTokens += tokens;
		}
		const plan = planConsolidation({
			limits: config,
			handoffs,
			contextWindow,
			summaryTokens: CONSOLIDATION_SUMMARY_TOKENS,
			minSavingTokens: MIN_REWIND_SAVINGS_TOKENS,
		});
		if (plan.kind === "skip") return;
		const warn = (reason: string): SessionBoundaryDraft[] => {
			const text = `[${TOOL_NAME} consolidation] ${plan.merged} older handoffs (~${formatWindow(plan.prefixTokens)} tokens) were not consolidated: ${toOneLine(reason, 400) ?? "unknown reason"}`;
			try {
				notify?.(text);
			} catch {
				/* A stale UI must not block the receipt. */
			}
			return [
				{
					type: "custom_message",
					customType: "navigate-tree-auto-warning",
					content: text,
					display: true,
				},
			];
		};
		const cutAt = projected.findIndex((entry) => entry.sourceEntry.id === plan.firstKeptEntryId);
		const prefixCalls = new Set<string>();
		for (const entry of projected.slice(0, cutAt))
			for (const m of entry.messages)
				if (m.role === "assistant")
					for (const block of m.content) if (block.type === "toolCall") prefixCalls.add(block.id);
		const split = projected
			.slice(cutAt)
			.some((entry) =>
				entry.messages.some((m) => m.role === "toolResult" && prefixCalls.has(m.toolCallId)),
			);
		if (split) return warn("a tool call before the cut has its result after it");
		const records = buildConsolidationSegment(entries, leafId, plan.firstKeptEntryId);
		if (!records.length) return;
		if (!registry.hasConfiguredAuth(model))
			return warn(`no authentication is configured for ${model.provider}/${model.id}`);
		const isCurrent = () => {
			try {
				return (
					!signal?.aborted &&
					ctx.signal === signal &&
					ctx.sessionManager === sm &&
					sm.getSessionId() === sessionId &&
					sm.getLeafId() === leafId &&
					!state.folds.queuedFolds.has(sessionId) &&
					!unrestoredFoldCursors.has(sm)
				);
			} catch {
				return false;
			}
		};
		state.folds.runningFolds.add(sessionId);
		try {
			const summary = await summarizeFold({
				runner: createFoldSummaryRunner({
					registry,
					model,
					thinking: host.thinking,
					sessionId,
				}),
				focus:
					"The consolidated project history: goals, constraints, delivered work, decisions, open items and standing authorization.",
				instruction: buildConsolidationRequestText,
				segment: { background: "", records },
				admit: foldAdmission(contextWindow, tokenFactorOf(sm)),
				signal,
			});
			if (!isCurrent()) return;
			if (!summary.ok) return warn(`${summary.reason}: ${summary.detail}`);
			const text = summary.text;
			const tokensBefore = estimateAdmissionTokens(sm);
			const details = {
				navigateTree: {
					consolidation: {
						merged: plan.merged,
						trigger: plan.trigger,
						strategy: summary.strategy,
						calls: summary.calls,
					},
				},
			};
			// Deterministic gate: the compaction must free context as Pi will project it.
			const all = sm.getEntries();
			const preview = {
				type: "compaction",
				id: "tree-navigator-consolidation-preview",
				parentId: leafId,
				timestamp: new Date().toISOString(),
				summary: text,
				firstKeptEntryId: plan.firstKeptEntryId,
				tokensBefore,
				details,
				fromHook: true,
				...systemCheckpoint(sm),
			} satisfies CompactionEntry;
			const before = estimateContentTokens(buildFoldProjection(all, leafId).messages);
			const after = estimateContentTokens(
				buildFoldProjection([...all, preview], preview.id).messages,
			);
			if (before - after < MIN_REWIND_SAVINGS_TOKENS)
				return warn(
					`the consolidated history does not free enough context (estimated ${before} -> ${after} tokens); original history was kept`,
				);
			const written = trySessionWrite(sm, () =>
				sm.appendCompaction(text, plan.firstKeptEntryId, tokensBefore, details, true),
			);
			if (!written.ok) {
				if (!written.cursorRestored) unrestoredFoldCursors.add(sm);
				return warn(
					`the compaction could not be written (${written.error instanceof Error ? written.error.message : String(written.error)}); ${written.cursorRestored ? "the session cursor was restored" : "persistence is uncertain, reload the session before folding again"}`,
				);
			}
			refreshAgentMessages(sm);
			await emitSessionCompact(sm, written.value);
			return [
				{
					type: "custom_message",
					customType: CONSOLIDATION_CUSTOM_TYPE,
					content: `[${TOOL_NAME} consolidation] Merged ${plan.merged} older handoffs into the project history: context ~${formatWindow(before)} -> ~${formatWindow(after)} tokens. The newest ${config.keepNewest} handoffs stay verbatim; the original entries remain in the session file.`,
					display: true,
					details: {
						compactionId: written.value,
						merged: plan.merged,
						trigger: plan.trigger,
						before,
						after,
						calls: summary.calls,
					},
				},
			];
		} catch (error) {
			return warn(error instanceof Error ? error.message : String(error));
		} finally {
			state.folds.runningFolds.delete(sessionId);
		}
	}

	// Auto start anchor (#55) run-end fallback: a run that finishes before its
	// X-th turn still settles (a one-turn first run anchors at turn 1).
	// `agent_end` fires on complete / aborted / errored runs; the settled set
	// makes this a no-op once the turn trigger already wrote.
	pi.on("agent_end", (event, ctx) => {
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
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Navigate Tree",
		// Stateful: every action mutates SessionManager; concurrent calls would
		// race on `leafId` / `labelsById` and produce an undefined tree.
		executionMode: "sequential",
		promptGuidelines: [
			`${TOOL_NAME}: when rewinding, prefer the oldest anchor that keeps what you'd otherwise re-read or re-derive; persist durable findings to files first.`,
			`${TOOL_NAME}: don't rewind while a user decision or unresolved question is pending — ask the user instead.`,
			`${TOOL_NAME}: pin durable sub-goals, decisions, facts and file pointers you must not lose across folds; the user's own rules and goals are captured automatically and cannot be pinned or changed by you.`,
		],
		description: `Long-session context management via the pi session tree. Anchor named milestones, then collapse work between them into a model-generated summary to free context.
\`rewind\` does not restore prior state: it forks a sibling branch from the anchor and continues forward from a model-generated summary.

Operations (set \`action\`):
  • 'anchor', name='<milestone-name>': label the current point. Anchor at the start of a stage you'll summarize (e.g. 'impl-start').
  • 'rewind', rewindTo='<existing>', newLabel='<new>': collapse work between rewindTo and the current leaf into a branch_summary labeled newLabel, so rewinds can chain.
  • 'list': show all anchors on the active branch, oldest first, with cumulative context % at each.
  • 'pin', kind='sub-goal'|'decision'|'fact'|'file'|'steering', text='<what to keep>': record a durable item that survives folds; \`list\` shows them. 'file' takes path+why instead of text; 'steering' belongs to an anchor (scopeAnchor, default newest). Refused when the user disabled the continuity ledger (continuity.capture=false).

\`name\` (anchor) and \`newLabel\` (rewind) write into one shared anchor namespace: labels are unique on the active branch — both actions refuse a name that already exists — and everything written there is addressable as a future \`rewindTo\`. Avoid the reserved \`${LABEL_PREFIX}\` prefix.`,
		promptSnippet:
			"Use to anchor named milestones and rewind the conversation tree to a prior point with a model-generated summary, for token-efficient long autonomous sessions. Also pins durable sub-goals, decisions, facts and file pointers that survive folds.",
		// The schema is intentionally a flat `Type.Object` with everything-but-
		// `action` optional, with action-conditional required-ness enforced at
		// runtime in `execute`. Discriminated unions / property-level required-
		// when-action shapes break the Kiro/CodeWhisperer adapter, which forwards
		// `inputSchema.json` verbatim and 400s on non-`type: "object"` roots.
		// The runtime guards in `execute` provide the conditional-required
		// behavior the schema can't express.
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("anchor"), Type.Literal("rewind"), Type.Literal("list"), Type.Literal("pin")],
				{
					description: "Which operation to perform.",
				},
			),
			name: Type.Optional(
				Type.String({
					description: `Required when action='anchor'. Kebab-case milestone label, max ${MAX_NAME_LENGTH} chars.`,
				}),
			),
			rewindTo: Type.Optional(
				Type.String({
					description: `Required when action='rewind'. Kebab-case name of an existing anchor on the active branch to rewind to.`,
				}),
			),
			newLabel: Type.Optional(
				Type.String({
					description: `Required when action='rewind'. Kebab-case label for the resulting branch_summary entry; reusable as a future rewindTo.`,
				}),
			),
			summaryFocus: Type.Optional(
				Type.String({
					description: `Required when action='rewind'; ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim. Encode: (1) the user's most recent instruction verbatim, (2) what's done in the collapsed segment, (3) what's left to do as a next action; if the user authorized continuing, name the next work item, not a report or wrap-up.`,
				}),
			),
			kind: Type.Optional(
				Type.Union(
					PIN_KINDS.map((kind) => Type.Literal(kind)),
					{
						description: `Required when action='pin'. Your sub-goal, a decision you made, a key fact, a file pointer, or steering that lapses when its anchor is folded.`,
					},
				),
			),
			text: Type.Optional(
				Type.String({
					description: `Required when action='pin' unless kind='file'. What to remember, max ${MAX_ITEM_TEXT_CHARS} chars.`,
				}),
			),
			path: Type.Optional(
				Type.String({
					description: `Required when action='pin' and kind='file'. File path.`,
				}),
			),
			lines: Type.Optional(
				Type.String({
					description: `Optional with kind='file': N or N-M.`,
				}),
			),
			why: Type.Optional(
				Type.String({
					description: `Required when action='pin' and kind='file'. Why the file matters.`,
				}),
			),
			scopeAnchor: Type.Optional(
				Type.String({
					description: `Anchor name for kind='steering' (default: newest anchor); optional for 'sub-goal'.`,
				}),
			),
		}),
		renderCall: (args, theme, context) => renderToolCall(args, theme, context.expanded),
		renderResult: (result, options, theme, context) =>
			renderToolResult(result, options, theme, context.isError),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const sm = ctx.sessionManager as SessionManager;
			const p = params as {
				action: "anchor" | "rewind" | "list" | "pin";
				name?: string;
				rewindTo?: string;
				newLabel?: string;
				summaryFocus?: string;
				kind?: string;
				text?: string;
				path?: string;
				lines?: string;
				why?: string;
				scopeAnchor?: string;
			};

			// --- list ---
			if (p.action === "list") {
				const cw = ctx.model?.contextWindow ?? 0;
				const totalTokens = estimateAdmissionTokens(sm);
				const reflectionOk = !!findOwningSession(sm);

				const rows: AnchorTableRow[] = collectActiveAnchors(sm).map(({ name, tokens, hint }) => ({
					pct: formatPct1(tokens, cw),
					name,
					...(hint ? { after: hint } : {}),
				}));

				const reflectionWarning = reflectionOk ? "" : ` · ${REFLECTION_BOOTSTRAP_WARNING_LIST}`;
				const header = `[list] · ${rows.length} label${rows.length === 1 ? "" : "s"} · ctx ${formatPct1(totalTokens, cw)}${cw > 0 ? ` of ${formatWindow(cw)}` : ""}${reflectionWarning}`;
				const body = rows.length ? formatAnchorTable(rows, cw) : "No labels on the active branch.";
				const { ledger } = readBranchLedger(sm.getBranch());
				const ledgerText = ledger.items.some(isVisible)
					? `\n\n${renderBriefing(ledger, { maxTokens: LIST_BRIEFING_MAX_TOKENS }).text}`
					: "";
				return {
					content: [{ type: "text", text: `${header}\n\n${body}${ledgerText}` }],
					details: {
						count: rows.length,
						contextTokens: totalTokens,
						contextWindow: cw,
						reflectionOk,
					},
				};
			}

			// --- anchor ---
			if (p.action === "anchor") {
				const target = resolveAnchorTarget(sm, p.name);
				if (!target.ok) {
					if (target.problem === "invalid-name") {
						return toolError(
							`anchor requires \`name\` in kebab-case, max ${MAX_NAME_LENGTH} chars (e.g. 'impl-start').`,
						);
					}
					if (target.problem === "no-leaf") {
						return toolError("No session entries yet — nothing to anchor.");
					}
					return toolError(
						`A label '${p.name}' already exists on the active branch — labels are unique and immutable once written. Use action='list' to review the active labels, then pick a fresh name.`,
					);
				}
				const { leafId, fullLabel } = target;
				// Atomic anchor: compute the estimate BEFORE writing the label. A
				// throw from the estimator must not leave a label on disk —
				// otherwise the agent sees an error yet a retry with the same
				// name is rejected as a duplicate.
				const cw = ctx.model?.contextWindow ?? 0;
				const tokensHere = estimateAdmissionTokens(sm);
				const labelHint = findLabelHint(sm, leafId, ANCHOR_HINT_MAX_LENGTH);
				const positionLine = `${formatPct1(tokensHere, cw)}${cw > 0 ? ` of ${formatWindow(cw)}` : ""}`;
				const hintLine = labelHint ? ` (after: “${labelHint}”)` : "";
				pi.setLabel(leafId, fullLabel);
				return {
					content: [
						{
							type: "text",
							text:
								`[anchor '${p.name}'] set at ${positionLine}${hintLine}\n\n` +
								`Once real work has accumulated after this anchor, collapse it into a summary with: ${TOOL_NAME}(action='rewind', rewindTo='<oldest appropriate anchor>', newLabel='<milestone-name>', summaryFocus='<≥${MIN_SUMMARY_FOCUS_LENGTH}-char focus: latest user instruction + done + remaining>').`,
						},
					],
					details: {
						label: p.name,
						entryId: leafId,
						contextTokens: tokensHere,
						labelHint,
					},
				};
			}

			// --- pin ---
			// Agent-origin ledger item: the reducer decides duplicates, caps and
			// limits; only the agent-allowed kinds and the params of each kind are
			// checked here. A pin is not a rewind: no solo-call guard.
			if (p.action === "pin") {
				if (!state.config.continuity.capture) {
					return toolError("continuity ledger is disabled by config");
				}
				if (!isPinKind(p.kind)) {
					return toolError(
						p.kind === "rule" || p.kind === "objective"
							? `pin cannot record a ${p.kind}: the user's rules and objective are captured automatically.`
							: `pin requires \`kind\`: ${PIN_KINDS.join(", ")}.`,
					);
				}
				let op: LedgerOp;
				if (p.kind === "file") {
					if (!isFilled(p.path) || !isFilled(p.why)) {
						return toolError("pin kind='file' requires `path` and `why`.");
					}
					const path = normalize(p.path.trim());
					const sha = await hashPinnedFile(ctx.cwd, path);
					op = {
						op: "add",
						kind: "file",
						file: {
							path,
							...(isFilled(p.lines) && { lines: p.lines.trim() }),
							...(sha !== undefined && { sha256: sha }),
							why: p.why,
						},
					};
				} else {
					if (!isFilled(p.text)) {
						return toolError(`pin kind='${p.kind}' requires \`text\`.`);
					}
					let scopeAnchor: string | undefined;
					if (p.kind === "steering" || p.kind === "sub-goal") {
						const anchors = activeAnchorNames(sm);
						scopeAnchor = isFilled(p.scopeAnchor)
							? p.scopeAnchor.trim()
							: p.kind === "steering"
								? anchors.at(-1)
								: undefined;
						if (scopeAnchor === undefined && p.kind === "steering") {
							return toolError(
								"steering belongs to an anchor and the active branch has none — anchor first.",
							);
						}
						if (scopeAnchor !== undefined && !anchors.includes(scopeAnchor)) {
							return toolError(
								`No label '${scopeAnchor}' on the active branch. Use action='list' to see available labels.`,
							);
						}
					}
					op = {
						op: "add",
						kind: p.kind,
						text: p.text,
						...(scopeAnchor !== undefined && { scopeAnchor }),
					};
				}
				const branch = sm.getBranch();
				const result = applyOps(readBranchLedger(branch).ledger, [op], {
					origin: "agent",
					userEntryIndex: userEntryIndexOf(branch),
				});
				const outcome = result.applied[0];
				if (!outcome) {
					const reason = result.rejected[0]?.reason;
					return toolError(`pin rejected: ${reason?.message ?? "no change"}`, {
						...(reason && { code: reason.code }),
					});
				}
				const { id } = outcome.item;
				const details = {
					id,
					kind: p.kind,
					effect: outcome.effect,
					rev: result.ledger.rev,
				};
				if (outcome.effect === "duplicate") {
					return {
						content: [
							{
								type: "text",
								text: `[pin] ${id} already records this ${p.kind}; nothing added.`,
							},
						],
						details,
					};
				}
				appendOpsEntry(pi, [{ op, ctx: { origin: "agent" } }]);
				const cut =
					p.kind !== "file" && outcome.item.text !== p.text?.trim()
						? ` (text cut to ${MAX_ITEM_TEXT_CHARS} chars)`
						: "";
				return {
					content: [{ type: "text", text: `[pin] ${id} ${p.kind} recorded${cut}` }],
					details,
				};
			}

			// --- rewind ---
			if (!isValidName(p.rewindTo)) {
				return toolError(
					`rewind requires \`rewindTo\` in kebab-case, max ${MAX_NAME_LENGTH} chars.`,
				);
			}
			if (!isValidName(p.newLabel)) {
				return toolError(
					`rewind requires \`newLabel\` in kebab-case, max ${MAX_NAME_LENGTH} chars.`,
				);
			}
			if (!p.summaryFocus || p.summaryFocus.trim().length < MIN_SUMMARY_FOCUS_LENGTH) {
				const focusLen = p.summaryFocus?.trim().length ?? 0;
				return toolError(
					`\`summaryFocus\` must be ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim (got ${focusLen}). The user's most recent instruction (which triggered this rewind) lives on the chain that's about to be collapsed — if summaryFocus doesn't preserve it, the post-rewind turn won't know what's left to do.\n\n` +
						`Include in summaryFocus:\n` +
						`  1. the user's most recent instruction verbatim,\n` +
						`  2. which parts have already been done in the work being collapsed,\n` +
						`  3. which parts remain unactioned.`,
				);
			}

			// Label uniqueness (issue #55, C8): a `newLabel` already on the
			// active branch is refused BEFORE any fold is queued — labels are
			// immutable once written, so the anchor→rewind rename-forward idiom is
			// retired. The existing label stays addressable via `rewindTo`.
			const existingLabel = findLabeledEntry(sm, LABEL_PREFIX + p.newLabel);
			if (existingLabel) {
				if (sm.getEntry(existingLabel)?.type === "branch_summary") {
					return toolError(
						`Label '${p.newLabel}' already names a stored handoff on the active branch. This request did not create another fold. If you intended that completed milestone, continue from the newest handoff's remaining work instead of repeating it. Use action='list' to inspect the active labels; choose a fresh newLabel only for different, uncollapsed work.`,
					);
				}
				return toolError(
					`A label '${p.newLabel}' already exists on the active branch — labels are unique and immutable once written, so rewind requires a fresh \`newLabel\`. The existing '${p.newLabel}' label stays addressable via \`rewindTo\`. Use action='list' to review the active labels, then pick a fresh newLabel.`,
				);
			}

			const target = findLabeledEntry(sm, LABEL_PREFIX + p.rewindTo);
			if (!target) {
				return toolError(
					`No label '${p.rewindTo}' on the active branch. Use action='list' to see available labels.`,
				);
			}

			const oldLeaf = sm.getLeafId();
			if (!oldLeaf || oldLeaf === target) {
				return toolError(`Already at '${p.rewindTo}' — nothing to summarize.`);
			}

			// Token math (#21): pure SessionManager reads, so the min-savings
			// floor below can reject before a fold is queued.
			// `allEntries`/`byId` are hoisted out of the parented-assistant branch
			// because the floor rejection copy reports per-anchor percentages from
			// the same maps.
			//
			// The leaf at execute time is the assistant that just streamed the
			// rewind tool call. Its `usage.input` is the *minimum* of recent API
			// calls in this turn, so estimating from it understates what the
			// user just saw. Use the chain up to its parent (which has the prior
			// assistant's usage as baseline) so beforeTokens matches the value
			// `list` would have reported on the previous turn.
			const oldLeafEntry = sm.getEntry(oldLeaf);
			const allEntries = sm.getEntries();
			const byId = new Map<string, SessionEntry>();
			for (const e of allEntries) byId.set(e.id, e);
			let beforeTokens: number;
			if (
				oldLeafEntry &&
				oldLeafEntry.type === "message" &&
				oldLeafEntry.message.role === "assistant" &&
				oldLeafEntry.parentId
			) {
				beforeTokens = estimateAtEntry(sm, allEntries, oldLeafEntry.parentId, byId);
			} else {
				beforeTokens = estimateAdmissionTokens(sm);
			}
			const tokensAtTarget = estimateAtEntry(sm, allEntries, target, byId);
			const contextWindow = ctx.model?.contextWindow ?? 0;

			const { entries } = collectEntriesForBranchSummary(sm, oldLeaf, target);
			if (entries.length === 0) {
				return toolError(`No entries between leaf and '${p.rewindTo}' — nothing to summarize.`);
			}
			// Minimum-savings floor (#21): refuse rewinds whose apparent savings
			// is below MIN_REWIND_SAVINGS_TOKENS — collapsing a near-empty segment
			// pays for a summary, forks a junk branch_summary, consumes a
			// milestone label, and grows live context.
			const apparentSavings = beforeTokens - tokensAtTarget;
			if (apparentSavings < MIN_REWIND_SAVINGS_TOKENS) {
				return toolError(
					buildMinSavingsRejection(
						p.rewindTo,
						p.newLabel,
						apparentSavings,
						sm,
						contextWindow,
						allEntries,
						byId,
						precedesLatestCompaction(sm.getBranch(), target),
					),
					{ rejected: "min-savings", apparentSavings },
				);
			}

			let sessionId: string;
			try {
				sessionId = sm.getSessionId();
			} catch (err) {
				return toolError(
					`Could not read the session id: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// The fold runs at this turn's `turn_end`, after the tool results are
			// on the branch, through the independent engine: the summary is written
			// by side calls, so a session whose next main request the admission
			// guard would refuse can still fold.
			const queued = queueFold(sessionId, {
				origin: "agent",
				rewindTo: p.rewindTo,
				newLabel: p.newLabel,
				focus: p.summaryFocus,
				toolCallId,
			});
			if (!queued.ok) return toolError(`Rewind refused: ${queued.reason}.`);

			return {
				content: [
					{
						type: "text",
						text: buildRewindAcceptedText(p.rewindTo, p.newLabel),
					},
				],
				details: {
					status: "queued",
					rewindTo: p.rewindTo,
					newLabel: p.newLabel,
					targetId: target,
					contextBefore: beforeTokens,
					tokensAtTarget,
					contextWindow,
				},
			};
		},
	});
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
