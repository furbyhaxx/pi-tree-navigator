/** Independent fold host and extension API contracts. */
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FoldCommitOutcome } from "./fold-commit.ts";
import type { FoldOutcome, FoldRequest, FoldRunOptions } from "./fold-engine.ts";

/** What an engine fold needs from its session, read from the live context before any await. */
export interface FoldHost {
	sm: SessionManager;
	model: Model<Api> | undefined;
	registry: Pick<ModelRegistry, "streamSimple" | "hasConfiguredAuth">;
	thinking: ThinkingLevel | "off";
	/** Set for an idle run: its commit refuses once the agent is working again. */
	isIdle?: () => boolean;
	recoveryEvidenceId?: string;
	foldPointId?: string;
}

/** What a landed engine fold reports on top of `commitFold`'s own result. */
export type FoldLanded = Omit<Extract<FoldCommitOutcome, { ok: true }>, "ok"> & {
	targetId: string;
	contextBefore: number;
	contextWindow: number;
};

export type FoldResult = FoldOutcome<FoldLanded>;

/** The queued-or-idle request shape: the session id comes from the caller's context. */
export type FoldRequestInput = Omit<FoldRequest, "sessionId">;

/** The engine entry points of one extension instance. */
export interface FoldApi {
	/**
	 * Queue a fold for the session's next `turn_end` boundary (a running agent).
	 * Refused while another fold is queued or running.
	 */
	queueFold(
		sessionId: string,
		request: FoldRequestInput,
	): { ok: true } | { ok: false; reason: string };
	/** Fold an idle session now and append the continuation without starting a turn. */
	runFoldNow(
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "isIdle">,
		request: FoldRequestInput,
		options?: FoldRunOptions,
	): Promise<FoldResult>;
}
