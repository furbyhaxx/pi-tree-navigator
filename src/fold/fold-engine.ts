import type { Usage } from "@earendil-works/pi-ai";
import {
	type FoldSummaryProgress,
	type FoldSummaryRunner,
	type SummarizeFoldOptions,
	type SummarizeFoldResult,
	summarizeFold,
} from "./fold-summarizer.ts";

/** Who asked for the fold. */
export type FoldOrigin = "manual" | "agent" | "auto" | "recovery";

/** One fold of the session's active branch back to an anchor. */
export interface FoldRequest {
	sessionId: string;
	origin: FoldOrigin;
	rewindTo: string;
	newLabel: string;
	focus: string;
	toolCallId?: string;
}

/** The snapshot a fold summarizes and commits; taken once, at a safe point. */
export interface FoldPrepared {
	leafId: string;
	targetId: string;
	segment: SummarizeFoldOptions["segment"];
	inContext?: SummarizeFoldOptions["inContext"];
	parent?: SummarizeFoldOptions["parent"];
	continuitySection?: string | undefined;
}

/** A successful summary, as handed to the commit. */
export type FoldSummary = Extract<SummarizeFoldResult, { ok: true }>;

/** What a commit reports; `C` carries the caller's own success details. */
export type FoldCommitResult<C extends object = object> =
	| ({ ok: true } & C)
	| { ok: false; reason: string };

/**
 * How a run ended. `failed.reason` is a stable code: `prepare`, `runner`,
 * `exception` (a dependency threw), a summarizer reason, or `commit-refused`
 * (then `detail` is the commit's own reason). `usage` is whatever the summary
 * calls spent, whatever the ending.
 */
export type FoldOutcome<C extends object = object> =
	| {
			status: "done";
			text: string;
			strategy: FoldSummary["strategy"];
			calls: number;
			chunks: number;
			usage: Usage[];
			commit: { ok: true } & C;
	  }
	| {
			status: "failed";
			stage: "gate" | "summary" | "commit";
			reason: string;
			detail: string;
			usage: Usage[];
	  }
	| { status: "cancelled"; usage: Usage[] }
	| { status: "busy" };

type MaybePromise<T> = T | Promise<T>;

/** Everything the engine needs from its host; the engine imports no session or UI code. */
export interface FoldEngineDeps<C extends object = object> {
	prepare(request: FoldRequest): MaybePromise<FoldPrepared | { error: string }>;
	runner(request: FoldRequest): MaybePromise<FoldSummaryRunner | { error: string }>;
	admit: SummarizeFoldOptions["admit"];
	/** Validate, materialize and write the fold. Called at most once per run, after the summary. */
	commit(
		request: FoldRequest,
		prepared: FoldPrepared,
		summary: FoldSummary,
	): Promise<FoldCommitResult<C>>;
	limits?: SummarizeFoldOptions["limits"];
}

/** Per-run controls. */
export interface FoldRunOptions {
	/** Cancels the run until the commit starts; a started commit always finishes. */
	signal?: AbortSignal | undefined;
	onProgress?(progress: FoldSummaryProgress): void;
}

/** Serializes folds per session and runs prepare, summary and commit in order. */
export interface FoldEngine<C extends object = object> {
	run(request: FoldRequest, options?: FoldRunOptions): Promise<FoldOutcome<C>>;
	isBusy(sessionId: string): boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Create the engine; a second request for a session that is folding returns `busy` without any call. */
export function createFoldEngine<C extends object = object>(
	deps: FoldEngineDeps<C>,
): FoldEngine<C> {
	const running = new Set<string>();

	const failed = (
		stage: "gate" | "summary" | "commit",
		reason: string,
		detail: string,
		usage: Usage[] = [],
	): FoldOutcome<C> => ({ status: "failed", stage, reason, detail, usage });

	async function execute(request: FoldRequest, options: FoldRunOptions): Promise<FoldOutcome<C>> {
		const { signal } = options;
		if (signal?.aborted) return { status: "cancelled", usage: [] };

		let prepared: FoldPrepared;
		let runner: FoldSummaryRunner;
		try {
			const snapshot = await deps.prepare(request);
			if ("error" in snapshot) return failed("gate", "prepare", snapshot.error);
			const model = await deps.runner(request);
			if ("error" in model) return failed("gate", "runner", model.error);
			prepared = snapshot;
			runner = model;
		} catch (error) {
			return failed("gate", "exception", messageOf(error));
		}

		let summary: SummarizeFoldResult;
		try {
			summary = await summarizeFold({
				runner,
				focus: request.focus,
				parent: prepared.parent,
				continuitySection: prepared.continuitySection,
				inContext: prepared.inContext,
				segment: prepared.segment,
				admit: deps.admit,
				limits: deps.limits,
				signal,
				onProgress: options.onProgress,
			});
		} catch (error) {
			return failed("summary", "exception", messageOf(error));
		}
		if (!summary.ok)
			return summary.reason === "aborted"
				? { status: "cancelled", usage: summary.usage }
				: failed("summary", summary.reason, summary.detail, summary.usage);

		let committed: FoldCommitResult<C>;
		try {
			committed = await deps.commit(request, prepared, summary);
		} catch (error) {
			return failed("commit", "exception", messageOf(error), summary.usage);
		}
		if (!committed.ok) return failed("commit", "commit-refused", committed.reason, summary.usage);
		return {
			status: "done",
			text: summary.text,
			strategy: summary.strategy,
			calls: summary.calls,
			chunks: summary.chunks,
			usage: summary.usage,
			commit: committed,
		};
	}

	return {
		async run(request, options = {}) {
			if (running.has(request.sessionId)) return { status: "busy" };
			running.add(request.sessionId);
			try {
				return await execute(request, options);
			} finally {
				running.delete(request.sessionId);
			}
		},
		isBusy: (sessionId) => running.has(sessionId),
	};
}

/** An anchor a recovery or automatic fold could target; candidates are listed root to leaf. */
export interface FoldTargetCandidate {
	name: string;
	valid: boolean;
	reason?: string;
	/** Estimated request size after folding to this anchor. */
	projectedAfterTokens: number;
}

/**
 * Deterministic target choice: the newest valid anchor whose projected request
 * fits `budget`, else the oldest valid anchor (`withinBudget` is then false).
 * Without a valid anchor the reasons name why each one was refused.
 */
export function selectFoldTarget<T extends FoldTargetCandidate>(
	candidates: readonly T[],
	budget: number,
): { ok: true; candidate: T; withinBudget: boolean } | { ok: false; reasons: string[] } {
	const valid = candidates.filter((candidate) => candidate.valid);
	const fitting = valid.findLast((candidate) => candidate.projectedAfterTokens <= budget);
	if (fitting) return { ok: true, candidate: fitting, withinBudget: true };
	const oldest = valid[0];
	if (oldest) return { ok: true, candidate: oldest, withinBudget: false };
	return {
		ok: false,
		reasons: candidates.length
			? candidates.map((candidate) => `${candidate.name}: ${candidate.reason ?? "not valid"}`)
			: ["no anchors on the active branch"],
	};
}
