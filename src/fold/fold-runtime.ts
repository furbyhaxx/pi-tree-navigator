/** Independent fold snapshots, summary runs and commits. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	collectEntriesForBranchSummary,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildMinSavingsRejection } from "../core/anchors.ts";
import { PARENT_HANDOFF_MODE_DEFAULT } from "../core/config.ts";
import { isValidName, LABEL_PREFIX, MAX_NAME_LENGTH } from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import {
	effectiveRequestMessages,
	findLabeledEntry,
	precedesLatestCompaction,
} from "../core/projection.ts";
import {
	estimateAdmissionTokens,
	estimateAtEntry,
	type OverflowModel,
	tokenFactorOf,
} from "../core/request-accounting.ts";
import type { FoldHost, FoldLanded, FoldResult } from "./fold-api.ts";
import { commitFold } from "./fold-commit.ts";
import {
	createFoldEngine,
	type FoldCommitResult,
	type FoldPrepared,
	type FoldRequest,
	type FoldRunOptions,
} from "./fold-engine.ts";
import { buildFoldSegment } from "./fold-inputs.ts";
import { continuityRequestSection, foldAdmission, preparedInContext } from "./fold-pricing.ts";
import { buildRewindDoneText } from "./fold-receipts.ts";
import { createFoldSummaryRunner } from "./fold-summarizer.ts";

/** Shared fold state, admission floor and the factory's best-effort label writer. */
export interface FoldRuntimeDeps {
	state: Pick<NavigatorState, "folds" | "recovery">;
	minRewindSavingsTokens: number;
	writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean;
}

/** Creates fold operations without registering handlers or starting work. */
export function createFoldRuntime({ state, minRewindSavingsTokens, writeLabel }: FoldRuntimeDeps) {
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
		if (savings < minRewindSavingsTokens) {
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
			...(host.recoveryEvidenceId === undefined
				? {}
				: { recoveryEvidenceId: host.recoveryEvidenceId }),
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

	return { captureSystemHead, prepareFold, commitEngineFold, runFold };
}
