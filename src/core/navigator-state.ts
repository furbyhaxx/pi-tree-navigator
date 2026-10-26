/** Shared per-factory state for navigator configuration and session activity. */

import type { Message } from "@earendil-works/pi-ai";
import type { AutoFoldState } from "../auto/auto-fold-planner.ts";
import type { AutoNavigatePartial } from "../auto/auto-navigate-config.ts";
import type { FoldRequest } from "../fold/fold-engine.ts";
import type { RewindMessageDraft } from "../fold/fold-receipts.ts";
import type { HandoffMode } from "../fold/handoff.ts";
import type { ProposalOptions } from "../retrospective/proposal-options.ts";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	type ConsolidationConfig,
} from "./config.ts";
import { RewindHintTracker } from "./rewind-hint.ts";

/** Replaceable configuration bindings, read at call time. */
export interface ConfigBindings {
	piSettingsSource: { cwd: string; agentDir: string; projectTrusted: boolean } | null;
	continuity: { capture: boolean; intentClassifier: string | null };
	consolidation: ConsolidationConfig;
	rewindHintReserveTokens: number | null;
	hintByModel: ReadonlyMap<string, number | null>;
	autoNavigateBase: AutoNavigatePartial | undefined;
	autoNavigateByModel: ReadonlyMap<string, AutoNavigatePartial | null>;
	proposalConfig: ProposalOptions | undefined;
}

/** Tool availability fails open until before_agent_start says otherwise. */
export interface ActivityState {
	toolActive: boolean;
	readonly toolActiveBySession: Map<string, boolean>;
}

/** Independent folds and the latest request system head, keyed by session. */
export interface FoldState {
	readonly parentModes: Map<string, HandoffMode>;
	readonly capturedSystems: Map<string, { modelKey: string; messages: Message[] }>;
	readonly queuedFolds: Map<string, FoldRequest>;
	readonly runningFolds: Set<string>;
}

/** Recovery ownership, decreasing-context attempts and pending settlement receipts. */
export interface RecoveryState {
	readonly requestBudgetFailures: Map<
		string,
		{
			inputEstimate: number;
			contextWindow: number;
			receiptId: string;
			detail?: string;
			providerOverflow?: boolean;
		}
	>;
	readonly recoveryAttempts: Map<string, { attempts: number; heuristicTokens: number }>;
	readonly nativeRetryOwned: Set<string>;
	readonly recoveryCuts: Map<string, string>;
	// Settlement persists receipts lost when another handler replaces boundary entries.
	readonly recoveryReceipts: Map<string, RewindMessageDraft[]>;
}

/** Fail-open capture warnings, classifier timeouts and one-shot fold nudges. */
export interface ContinuityState {
	readonly continuityWarned: Map<string, Set<string>>;
	readonly classifierTimedOut: Set<string>;
	readonly nudgedFolds: Set<string>;
}

/** Automatic fold planning history, keyed by session. */
export interface AutomaticState {
	readonly autoFoldStateBySession: Map<string, AutoFoldState>;
}

/** Rewind hints and session-bound start anchors. */
export interface AnchorState {
	hintTracker: RewindHintTracker;
	// Settled sessions survive lifecycle cleanup; a fresh factory rechecks existing anchors.
	readonly anchorStartSettled: Set<string>;
	readonly anchorStartTurnsBySession: Map<string, number>;
}

/** Turns whose fold or overflow ownership suppresses hints and start anchors. */
export interface TurnsState {
	readonly rewindTurns: WeakSet<object>;
	readonly overflowedTurns: WeakSet<object>;
}

/** Shared backing groups allocated once for each extension factory invocation. */
export interface NavigatorState {
	readonly config: ConfigBindings;
	readonly activity: ActivityState;
	readonly folds: FoldState;
	readonly recovery: RecoveryState;
	readonly continuity: ContinuityState;
	readonly automatic: AutomaticState;
	readonly anchors: AnchorState;
	readonly turns: TurnsState;
}

/** Creates fresh factory state with the navigator's initial configuration bindings. */
export function createNavigatorState(): NavigatorState {
	return {
		config: {
			piSettingsSource: null,
			continuity: { capture: CONTINUITY_CAPTURE_DEFAULT, intentClassifier: null },
			consolidation: CONSOLIDATION_DEFAULTS,
			rewindHintReserveTokens: null,
			hintByModel: new Map(),
			autoNavigateBase: undefined,
			autoNavigateByModel: new Map(),
			proposalConfig: undefined,
		},
		activity: { toolActive: true, toolActiveBySession: new Map() },
		folds: {
			parentModes: new Map(),
			capturedSystems: new Map(),
			queuedFolds: new Map(),
			runningFolds: new Set(),
		},
		recovery: {
			requestBudgetFailures: new Map(),
			recoveryAttempts: new Map(),
			nativeRetryOwned: new Set(),
			recoveryCuts: new Map(),
			recoveryReceipts: new Map(),
		},
		continuity: {
			continuityWarned: new Map(),
			classifierTimedOut: new Set(),
			nudgedFolds: new Set(),
		},
		automatic: { autoFoldStateBySession: new Map() },
		anchors: {
			hintTracker: new RewindHintTracker(),
			anchorStartSettled: new Set(),
			anchorStartTurnsBySession: new Map(),
		},
		turns: { rewindTurns: new WeakSet(), overflowedTurns: new WeakSet() },
	};
}
