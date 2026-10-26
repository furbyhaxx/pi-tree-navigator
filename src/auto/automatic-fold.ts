/** Automatic turn-boundary folding, milestone anchors and pressure relief. */

import type {
	ExtensionContext,
	ModelRegistry,
	SessionBoundaryDraft,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { suggestFoldLabel } from "../core/anchors.ts";
import {
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
} from "../core/config.ts";
import { fixedOverheadNote } from "../core/context-tokens.ts";
import {
	formatWindow,
	isValidName,
	LABEL_PREFIX,
	MAX_NAME_LENGTH,
	TOOL_NAME,
	toOneLine,
} from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { admissionMessages, findLabeledEntry } from "../core/projection.ts";
import {
	estimateAdmissionTokens,
	estimateAtEntry,
	tokenFactorOf,
} from "../core/request-accounting.ts";
import type { FoldHost, FoldResult } from "../fold/fold-api.ts";
import { unrestoredFoldCursors } from "../fold/fold-commit.ts";
import { type FoldRequest, type FoldRunOptions, selectFoldTarget } from "../fold/fold-engine.ts";
import { defaultFoldFocus, priceFoldCandidates } from "../fold/fold-pricing.ts";
import {
	foldDoneDraft,
	foldFailedDraft,
	keepValidDrafts,
	type RewindMessageDraft,
} from "../fold/fold-receipts.ts";
import type { createPressureCompactionController } from "../recovery/pressure-compaction.ts";
import { recoveryCutOf } from "../recovery/recovery-cut.ts";
import { planAutomaticFold, pressureFoldBudget } from "./auto-fold-planner.ts";

/** Automatic planning state and the factory's fold and label operations. */
export interface AutomaticFoldDeps {
	state: Pick<NavigatorState, "config" | "activity" | "folds" | "turns" | "automatic">;
	foldHostOf(ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry">): FoldHost;
	gateFailed(reason: string, detail: string): FoldResult;
	writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean;
	runFold(host: FoldHost, request: FoldRequest, options?: FoldRunOptions): Promise<FoldResult>;
	compactUnderPressure: ReturnType<
		typeof createPressureCompactionController
	>["compactUnderPressure"];
}

/** Creates automatic fold operations without registering handlers or starting work. */
export function createAutomaticFoldController({
	state,
	foldHostOf,
	gateFailed,
	writeLabel,
	runFold,
	compactUnderPressure,
}: AutomaticFoldDeps) {
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
					...(state.config.autoNavigateBase === undefined
						? {}
						: { autoNavigate: state.config.autoNavigateBase }),
					autoNavigateByModel: state.config.autoNavigateByModel,
					...(state.config.proposalConfig === undefined
						? {}
						: { proposal: state.config.proposalConfig }),
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
					done.details["aboveTarget"] = true;
					done.details["target"] = budget;
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

	return { maybeRunAutomaticFold };
}
