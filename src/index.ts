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
import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	isContextOverflow,
	isRecoverableLength,
	type Message,
	type Model,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	AgentSession,
	buildSessionProjection,
	CONFIG_DIR_NAME,
	type CompactionEntry,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
	prepareBranchEntries,
	type SessionBoundaryDraft,
	type SessionEntry,
	type SessionManager,
	SettingsManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AutoFoldState,
	planAutomaticFold,
	pressureFoldBudget,
} from "./auto/auto-fold-planner.ts";
import type { AutoNavigatePartial } from "./auto/auto-navigate-config.ts";
import { planPressureCut } from "./auto/pressure-compaction.ts";
import {
	isVisible,
	renderBriefing,
	renderFoldCaptureSection,
} from "./continuity/continuity-briefing.ts";
import {
	captureIntent,
	createModelClassifier,
	heuristicClassifier,
	type IntentClassifier,
} from "./continuity/continuity-capture.ts";
import {
	LEDGER_DETAILS_KEY,
	type LedgerOp,
	MAX_ITEM_TEXT_CHARS,
} from "./continuity/continuity-ledger-model.ts";
import { applyOps } from "./continuity/continuity-ledger-reducer.ts";
import {
	appendOpsEntry,
	type BranchLedger,
	CONTINUITY_OPS_CUSTOM_TYPE,
	compactionContinuity,
	type FoldContinuity,
	readBranchLedger,
	reconcileFoldContinuity,
	spanUserEntryRefs,
	userEntryIndexOf,
} from "./continuity/continuity-store.ts";
import { resolveIntentPolicy } from "./continuity/intent-policy.ts";
import {
	collectOpenUserRequests,
	type OpenUserRequest,
	renderOpenUserRequests,
} from "./continuity/open-user-requests.ts";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	type ConsolidationConfig,
	loadTreeNavigatorConfig,
	PARENT_HANDOFF_MODE_DEFAULT,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
	START_ANCHOR_DEFAULT_TURNS,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./core/config.ts";
import {
	DEFAULT_TOKEN_FACTOR,
	estimateContentTokens,
	estimateRawRequestTokens,
	estimateRequestTokens,
	fixedOverheadNote,
	measuredTokenFactor,
} from "./core/context-tokens.ts";
import {
	type AnchorTableRow,
	BRANCH_LABEL_PREFIX,
	extractTextContent,
	formatAnchorTable,
	formatContextDelta,
	formatPct1,
	formatWindow,
	isValidName,
	LABEL_PREFIX,
	MAX_NAME_LENGTH,
	stripBranchSummaryBoilerplate,
	TOOL_NAME,
	toOneLine,
} from "./core/helpers.ts";
import {
	collectLegacyRewindOutcomes,
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
	legacyRewindOutcomeRow,
	legacySummaryRequestRow,
	sanitizeLegacyText,
	withLegacyOutcome,
} from "./core/legacy-rewind.ts";
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
import { persistedOnDisk, trySessionWrite } from "./core/session-write.ts";
import { planConsolidation } from "./fold/consolidation-planner.ts";
import {
	createFoldEngine,
	type FoldCommitResult,
	type FoldOutcome,
	type FoldPrepared,
	type FoldRequest,
	type FoldRunOptions,
	type FoldTargetCandidate,
	selectFoldTarget,
} from "./fold/fold-engine.ts";
import {
	anchorMessageIndex,
	buildConsolidationSegment,
	buildFoldProjection,
	buildFoldSegment,
	buildInContextMessages,
} from "./fold/fold-inputs.ts";
import {
	createFoldSummaryRunner,
	DEFAULT_REDUCE_OUTPUT_TOKENS,
	reasoningAllowance,
	type SummarizeFoldOptions,
	summarizeFold,
} from "./fold/fold-summarizer.ts";
import {
	getHandoff,
	type HandoffMode,
	handoffContext,
	makeHandoff,
	materializeHandoff,
} from "./fold/handoff.ts";
import {
	installHandoffProjection,
	invalidateStaleUsage,
	projectHandoffs,
} from "./fold/handoff-projection.ts";
import {
	appendContinuityBriefing,
	buildConsolidationRequestText,
	buildSummaryRequestText,
	computeFileLists,
	formatFileOperations,
	hasOpenWork,
	stripContinuityBriefing,
} from "./fold/summary-prompt.ts";
import type { ProposalOptions } from "./retrospective/proposal-options.ts";
import { sha256 } from "./retrospective/retrospective-plan.ts";
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

/**
 * Always-on anchor mandate appended to the system prompt on every agent
 * start (gated on the tool being active). Same lever as pi-napkin's vault
 * mandate: `promptGuidelines` bullets land mid-prompt; this append lands
 * at the very end of the system prompt, after <project_context> and
 * skills, and is re-applied on every prompt (never compacted). Byte-stable
 * (module constant, no per-session interpolation) for provider caching.
 */
export const ANCHOR_MANDATE = `${TOOL_NAME}: gather all context, then anchor \`context-gathered\`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.`;

/**
 * Label written by the automatic start anchor (#55). Exported for the test
 * suite; production callers should rely on the registered tool surface.
 */
export const START_ANCHOR_LABEL = `${LABEL_PREFIX}start`;

// ---------------------------------------------------------------------------
// Exported boundary constants below (MAX_SESSION_REFS, MAX_HINT_WALK_DEPTH,
// MIN_SUMMARY_FOCUS_LENGTH, MIN_REWIND_SAVINGS_TOKENS).
//
// Stability: these are internal tunables. Exported only so the test suite
// can pin boundary cases by constant rather than literal. Re-tuning is
// NOT a semver-breaking change for this package — production callers
// should rely on the registered `navigate_tree` tool surface, not import
// these constants directly. The `__testHooks` JSDoc carries the same
// caveat for module-internal helpers.
// ---------------------------------------------------------------------------
// Cap on captured AgentSession refs across /new + /resume + /reload cycles.
// Worst case is ~one ref per long-lived session before reaping dead WeakRefs;
// 16 leaves headroom for the deepest session-fanout pattern observed (a few
// /resume cycles on top of a couple of /new cycles) without prematurely
// reaping a still-live session. Bump if the reaper fires while a session
// is still live.
export const MAX_SESSION_REFS = 16;
// Cap on parentId chain walks in `findLabelHint` (UX preview only;
// no need to walk to the root for a 50-char snippet).
export const MAX_HINT_WALK_DEPTH = 50;
// Floor on `summaryFocus` length (after trim) for `rewind`. The user's most
// recent instruction lives on the chain about to be collapsed; if the focus
// is shorter than this, it almost always elides that instruction (a terse
// "finish parser fix" is 17 chars and conveys nothing the next turn can
// act on). 20 is the empirical threshold below which the post-rewind turn
// reliably loses continuity — raising it forces more useful focus text
// without inviting verbosity.
export const MIN_SUMMARY_FOCUS_LENGTH = 20;
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
const RECOVERY_MIN_OUTPUT_TOKENS = 1_024;
const RECOVERY_HEADROOM_TOKENS = 4_096;
/** Recoveries one request may get; each must start from less context than the last. */
const MAX_RECOVERY_ATTEMPTS = 3;
// Hint length cap for the per-row hint shown in `list` output. 50 chars
// fits one terminal column without wrapping in typical 80-column TUIs.
const LIST_HINT_MAX_LENGTH = 50;

/** Token budget of the ledger briefing appended to `list`. */
const LIST_BRIEFING_MAX_TOKENS = 500;

/** Kinds the agent may pin; rules and the objective are the user's alone. */
const PIN_KINDS = ["sub-goal", "decision", "fact", "file", "steering"] as const;
type PinKind = (typeof PIN_KINDS)[number];
const isPinKind = (kind: unknown): kind is PinKind => PIN_KINDS.includes(kind as PinKind);

/** Larger files are pinned without a hash rather than read whole. */
const PIN_HASH_MAX_BYTES = 2 * 1024 * 1024;

// Hint length cap for the hint shown in the `anchor` response. The anchor
// response is a single block of prose (not a column-aligned table) so it
// can afford a longer hint than `list`'s per-row preview.
const ANCHOR_HINT_MAX_LENGTH = 60;
const ORIG_PROMPT_KEY = Symbol.for("navigate-tree.orig-prompt");

// Two warnings: list-site (read-only path; warns about the next turn's
// context view) and rewind-site (wrote to disk; leads with that). Both
// suggest /reload first, then restart pi, in that order.
const REFLECTION_BOOTSTRAP_WARNING_LIST =
	"⚠ reflection bootstrap missing — anchors and rewinds still work, but the next assistant turn may snapshot pre-bootstrap context. Run `/reload` (or restart pi) to recover.";
const REFLECTION_BOOTSTRAP_WARNING_REWIND =
	"⚠ reflection bootstrap missing — the rewind landed on disk but the next assistant turn may still see the pre-rewind context. Run `/reload` (or restart pi) to recover.";

// ---------------------------------------------------------------------------
// Typed views over pi internals.
//
// pi-coding-agent doesn't expose `agent`, `state`, `prepareNextTurn`, or
// `sessionManager` on `AgentSession` in its public types, but they are plain
// (non-`#`-private) fields on the class. Each cast point is a fragility
// surface for pi version bumps; grouping them here makes the dependency
// surface explicit.
// ---------------------------------------------------------------------------

interface PiInternals {
	agent: {
		state: {
			messages: unknown[];
		};
	};
	/**
	 * Plain field on `AgentSession` (#79). Used only to emit `session_tree`
	 * after a rewind, mirroring pi's own `navigateTree`, so extensions that
	 * mirror the conversation (pi-claude-bridge's Claude Code session) rebuild
	 * from the rewound chain instead of continuing on their stale copy.
	 */
	_extensionRunner?: {
		emit?: (event: unknown) => Promise<unknown> | unknown;
	};
	sessionManager: SessionManager;
	/**
	 * Plain field on `AgentSession` in pi 1.3.0 (#101, S3): the live settings
	 * pi decides compaction from. Optional: older pi versions may lack it.
	 */
	settingsManager?: SettingsManager;
	// Pi applies a forced prompt after extension context transforms.
	_runSystemPromptOptions?: { forceSystemPrompt?: string };
}

function asInternals(session: AgentSession): PiInternals {
	return session as unknown as PiInternals;
}

// =============================================================================
// Reflection bootstrap & in-loop refresh
// =============================================================================

const sessionInstances: WeakRef<AgentSession>[] = [];
let seenSessions = new WeakSet<AgentSession>();

function captureSession(session: AgentSession): void {
	if (seenSessions.has(session)) return;
	seenSessions.add(session);
	sessionInstances.push(new WeakRef(session));
	// Reap dead WeakRefs occasionally so the array doesn't grow unbounded
	// across /new and /resume cycles.
	if (sessionInstances.length > MAX_SESSION_REFS) {
		for (let i = sessionInstances.length - 1; i >= 0; i--) {
			if (!sessionInstances[i].deref()) sessionInstances.splice(i, 1);
		}
	}
}

function patchAgentSessionPrototype(): void {
	const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
	// Stash the truly-original prompt the FIRST time we patch. On subsequent
	// /reloads the value is already there — we don't overwrite, we just read it
	// back so the new wrapper still calls the original (not a previous wrapper).
	if (!proto[ORIG_PROMPT_KEY]) {
		proto[ORIG_PROMPT_KEY] = proto.prompt;
	}
	const orig = proto[ORIG_PROMPT_KEY] as (...args: unknown[]) => unknown;

	// Always replace the wrapper, even if a previous load already patched. On
	// /reload the previous wrapper closes over the previous module's
	// `sessionInstances` — if we don't replace, captures land in the dead
	// module and reflection finds nothing.
	const patched = function (this: AgentSession, ...args: unknown[]) {
		captureSession(this);
		return orig.apply(this, args);
	};
	proto.prompt = patched;
}

function findOwningSession(sm: SessionManager): AgentSession | null {
	for (const ref of sessionInstances) {
		const s = ref.deref();
		if (s && asInternals(s).sessionManager === sm) {
			return s;
		}
	}
	return null;
}

/**
 * Project the session tree's active branch into the messages the next LLM
 * call should see — the public-API replacement for the deleted
 * `prepareNextTurn` double-wrap (which rebuilt `messages` from
 * `sessionManager.buildSessionContext()` between every turn).
 *
 * Registered as a `context` extension handler: pi fires the `context` event
 * inside `streamAssistantResponse` before EVERY LLM call (wired through
 * `Agent.transformContext` → `runner.emitContext`), so this projection is
 * applied at the wire boundary itself rather than at a turn-boundary
 * snapshot. The loop's own `currentContext.messages` is never mutated — the
 * handler only replaces the clone that `convertToLlm` consumes.
 *
 * Prefers the canonical `buildSessionProjection().messages` (>= 0.87.0): that
 * is exactly what pi itself treats as the model context, applying
 * `context_edit` omissions/replacements written by pi's own overflow recovery
 * and by extensions such as the fallback provider. Returning the raw
 * `buildContextEntries()` view would reintroduce edited-away messages into the
 * request. The entry walk remains only as a defensive fallback for structural
 * test doubles.
 *
 * The result is CONVERSATION-ONLY: the `context` event contract is "transform
 * conversation messages without prompt and tool system messages; Pi restores
 * that state afterward" (pi docs, `context` section), and `runner.emitContext`
 * hands handlers `currentMessages.filter(role !== "system")` and re-attaches
 * the current head via `restoreSystemMessages`. Returning the projection's
 * system entries would make that re-attach prepend the head to a list still
 * carrying the persisted system entry — a duplicated head on runs where
 * `forceSystemPrompt` is unset.
 *
 * We always replace (no leaf-gating): every `appendMessage` advances the
 * session leaf, so a "leaf changed since last turn" heuristic would fire on
 * essentially every call anyway — and always-replace is byte-for-byte the
 * behavior of the old wrapper (per-turn rebuild from the tree).
 *
 * The parameter is typed structurally because `ReadonlySessionManager` is
 * NOT re-exported from the package barrel (only `SessionManager` and
 * `sessionEntryToContextMessages` are public); `ctx.sessionManager` at the
 * event site is `ReadonlySessionManager`.
 */
export function buildContextMessages(
	sm: {
		buildContextEntries(): SessionEntry[];
		getBranch?(): SessionEntry[];
		getEntries?(): SessionEntry[];
		buildSessionProjection?(): {
			entries?: Array<{ sourceEntry: SessionEntry; messages: AgentMessage[] }>;
			messages: AgentMessage[];
			model?: { provider: string; modelId: string } | null;
		};
		getLabel?(id: string): string | undefined;
	},
	throughId?: string,
): ReturnType<typeof sessionEntryToContextMessages> {
	let entries: Array<{ sourceEntry: SessionEntry | null; messages: AgentMessage[] }> | undefined;
	let model: { provider: string; modelId: string } | null | undefined;
	try {
		if (throughId && typeof sm.getEntries === "function") {
			const projection = buildSessionProjection(sm.getEntries(), throughId);
			model = projection.model;
			entries = Array.isArray(projection.entries)
				? projection.entries
				: [{ sourceEntry: null, messages: projection.messages }];
		} else if (typeof sm.buildSessionProjection === "function") {
			const projection = sm.buildSessionProjection();
			model = projection.model;
			entries = Array.isArray(projection.entries)
				? projection.entries
				: [{ sourceEntry: null, messages: projection.messages }];
		}
	} catch {
		// Fall through to the raw entry projection — pi rewrites the context
		// handlers' output at the wire boundary anyway.
	}
	entries ??= sm.buildContextEntries().map((entry) => ({
		sourceEntry: entry,
		messages: sessionEntryToContextMessages(entry),
	}));
	let legacyOutcomes = new Map<string, string>();
	try {
		if (sm.getBranch) {
			legacyOutcomes = collectLegacyRewindOutcomes(sm.getBranch());
		}
	} catch {
		// Projection-only callers may not expose an active branch.
	}
	// Withholding can append edits after the entries a stale usage covers.
	entries = invalidateStaleUsage(entries, model);
	// Sessions written before the independent engine carry summary
	// instructions of the in-band turn; none is ever written now, and a stale
	// one must not reach the model.
	const messages = entries
		.filter(
			(e) =>
				!(
					e.sourceEntry?.type === "custom_message" &&
					e.sourceEntry.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE
				),
		)
		.flatMap((e) => {
			const legacyOwned =
				e.sourceEntry?.type === "branch_summary" &&
				e.sourceEntry.fromHook === true &&
				sm.getLabel?.(e.sourceEntry.id)?.startsWith(LABEL_PREFIX) === true;
			const messages = withLegacyOutcome(e.messages, legacyOutcomes.get(e.sourceEntry?.id ?? ""));
			return handoffContext(e.sourceEntry, messages, legacyOwned);
		});
	return messages.filter((message) => message.role !== "system");
}

function refreshAgentMessages(sm: SessionManager): boolean {
	// Manually replicate the agent-state refresh that pi's
	// commandCtx.navigateTree does after branchWithSummary. Returns true on
	// success, false if reflection couldn't find the owning AgentSession (in
	// which case the rewind is structurally complete on disk, but the next LLM
	// call will still see stale messages).
	const session = findOwningSession(sm);
	if (!session) return false;
	try {
		const sessionContext = sm.buildSessionContext();
		const agent = asInternals(session).agent;
		if (!agent?.state) return false;
		agent.state.messages = sessionContext.messages;
		return true;
	} catch {
		return false;
	}
}

async function emitSessionTree(
	sm: SessionManager,
	oldLeafId: string | null,
	summaryId: string,
): Promise<boolean> {
	// Replicate the `session_tree` emit that pi's own `navigateTree` does after
	// `branchWithSummary` (#79). A tool-driven rewind skips it, so extensions
	// that mirror the conversation never learn the history was rewritten:
	// pi-claude-bridge keeps resuming its Claude Code session with the full
	// pre-rewind context. Returns false when the runner is unreachable or a
	// handler throws; the rewind itself is already complete either way.
	const session = findOwningSession(sm);
	const runner = session ? asInternals(session)._extensionRunner : undefined;
	if (typeof runner?.emit !== "function") return false;
	try {
		await runner.emit({
			type: "session_tree",
			newLeafId: sm.getLeafId(),
			oldLeafId,
			summaryEntry: sm.getEntry(summaryId),
			fromExtension: true,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Emit `session_compact` for a compaction the extension appended, as pi does
 * after its own. History-mirroring providers rebuild from it. False when the
 * runner is unreachable or a handler throws; the compaction is written either way.
 */
async function emitSessionCompact(sm: SessionManager, compactionId: string): Promise<boolean> {
	const session = findOwningSession(sm);
	const runner = session ? asInternals(session)._extensionRunner : undefined;
	if (typeof runner?.emit !== "function") return false;
	try {
		await runner.emit({
			type: "session_compact",
			compactionEntry: sm.getEntry(compactionId),
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		});
		return true;
	} catch {
		return false;
	}
}

// =============================================================================
// Helpers (extension-internal; pure helpers in ./helpers.ts)
// =============================================================================

function findLabeledEntry(sm: SessionManager, fullLabel: string): string | null {
	const path = sm.getBranch();
	for (let i = path.length - 1; i >= 0; i--) {
		if (sm.getLabel(path[i].id) === fullLabel) return path[i].id;
	}
	return null;
}

/**
 * The latest compaction on `branch` that a fold to `targetId` carries
 * forward: the target lies inside its kept range (at or after
 * `firstKeptEntryId`, before the compaction). Branching there drops the
 * compaction from the ancestry, so the fold re-appends a copy.
 */
function carriedCompaction(
	branch: readonly SessionEntry[],
	targetId: string,
): CompactionEntry | undefined {
	const at = branch.findIndex((entry) => entry.id === targetId);
	const compactionAt = branch.findLastIndex((e) => e.type === "compaction");
	if (at < 0 || compactionAt <= at) return undefined;
	const compaction = branch[compactionAt] as CompactionEntry;
	const keptAt = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	return keptAt >= 0 && keptAt <= at ? compaction : undefined;
}

/**
 * The system checkpoint `appendCompaction` stores on a compaction: projection
 * restarts at a compaction, so a preview without it prices no system prompt.
 */
function systemCheckpoint(sm: SessionManager): {
	systemMessage?: CompactionEntry["systemMessage"];
} {
	const systemMessage = getCurrentSystemMessage(sm.buildSessionProjection().messages);
	return systemMessage ? { systemMessage } : {};
}

/** An unsaved copy of `compaction` under `parentId`, as `commitFold` appends it. */
function compactionCopy(
	compaction: CompactionEntry,
	parentId: string,
	taken: ReadonlyMap<string, unknown>,
): CompactionEntry {
	let id = "tree-navigator-carried-compaction";
	while (taken.has(id)) id += "-";
	return {
		...compaction,
		id,
		parentId,
		details: carriedDetails(compaction),
	};
}

function carriedDetails(compaction: CompactionEntry): unknown {
	const base =
		compaction.details && typeof compaction.details === "object"
			? (compaction.details as Record<string, unknown>)
			: {};
	return { ...base, carriedFrom: compaction.id };
}

/**
 * The messages a branch rooted at `entryId` would carry: what a fold to that
 * entry leaves behind before its handoff is added. `commitFold` projects
 * its preview the same way: a compaction whose kept range holds `entryId` is
 * carried forward, an earlier one only counts when `entryId` lies after it.
 */
function projectAtEntry(
	entries: SessionEntry[],
	entryId: string,
	byId: Map<string, SessionEntry>,
	carry?: CompactionEntry,
): AgentMessage[] {
	if (!carry) {
		return projectHandoffs(buildSessionProjection(entries, entryId, byId), entries).messages;
	}
	const copy = compactionCopy(carry, entryId, byId);
	const withCopy = [...entries, copy];
	return projectHandoffs(buildSessionProjection(withCopy, copy.id), withCopy).messages;
}

/** The admission estimate (see `estimateAdmissionTokens`) for the branch a fold to `entryId` leaves. */
function estimateAtEntry(
	sm: SessionManager,
	entries: SessionEntry[],
	entryId: string,
	byId: Map<string, SessionEntry>,
): number {
	const carry = carriedCompaction(sm.getBranch(), entryId);
	return requestAccounting(sm, projectAtEntry(entries, entryId, byId, carry)).tokens;
}

/**
 * Whether `targetId` precedes the latest compaction's kept range on `branch`.
 * A fold there parents its summary before every entry the compaction kept,
 * so the copy cannot be carried and the summarized history would return.
 */
function precedesLatestCompaction(branch: readonly SessionEntry[], targetId: string): boolean {
	const at = branch.findIndex((entry) => entry.id === targetId);
	return (
		at >= 0 &&
		at < branch.findLastIndex((e) => e.type === "compaction") &&
		!carriedCompaction(branch, targetId)
	);
}

/** The anchors on the active branch, root → leaf, with the context footprint at each. */
function collectActiveAnchors(sm: SessionManager): {
	name: string;
	tokens: number;
	beforeCompaction: boolean;
	hint: string | null;
}[] {
	const path = sm.getBranch();
	const allEntries = sm.getEntries();
	const byId = new Map<string, SessionEntry>();
	for (const e of allEntries) byId.set(e.id, e);
	const anchors: ReturnType<typeof collectActiveAnchors> = [];
	for (const e of path) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		anchors.push({
			name: lbl.slice(LABEL_PREFIX.length),
			tokens: estimateAtEntry(sm, allEntries, e.id, byId),
			beforeCompaction: precedesLatestCompaction(path, e.id),
			hint: findLabelHint(sm, e.id, LIST_HINT_MAX_LENGTH),
		});
	}
	return anchors;
}

/** Anchor names on the active branch, root → leaf, as `list` shows them. */
function activeAnchorNames(sm: SessionManager): string[] {
	const names: string[] = [];
	for (const e of sm.getBranch()) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		const name = lbl.slice(LABEL_PREFIX.length);
		if (isValidName(name)) names.push(name);
	}
	return names;
}

const isFilled = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

/** sha256 of a pinned file; undefined when it is unreadable or too large. */
async function hashPinnedFile(cwd: string, path: string): Promise<string | undefined> {
	try {
		const file = resolve(cwd, path);
		if ((await stat(file)).size > PIN_HASH_MAX_BYTES) return undefined;
		return sha256(await readFile(file));
	} catch {
		return undefined;
	}
}

/** What stops a new anchor: shared by the tool's `anchor` action and `/anchor`. */
type AnchorTarget =
	| { ok: true; leafId: string; fullLabel: string }
	| { ok: false; problem: "invalid-name" | "no-leaf" | "duplicate" };

function resolveAnchorTarget(sm: SessionManager, name: unknown): AnchorTarget {
	if (!isValidName(name)) return { ok: false, problem: "invalid-name" };
	const leafId = sm.getLeafId();
	if (!leafId) return { ok: false, problem: "no-leaf" };
	// Labels are unique on the active branch (issue #55, C8): an
	// existing label is never moved or overwritten, and the caller
	// must pick a fresh name. Manual `/tree` duplicates are the only
	// duplicate path; move-on-collision is retired for both writers.
	const fullLabel = LABEL_PREFIX + name;
	if (findLabeledEntry(sm, fullLabel)) return { ok: false, problem: "duplicate" };
	return { ok: true, leafId, fullLabel };
}

/** A fresh `newLabel` suggestion for folding to `anchorName`. */
function suggestFoldLabel(sm: SessionManager, anchorName: string): string {
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? "-folded" : `-folded-${n}`;
		const base = anchorName.slice(0, MAX_NAME_LENGTH - suffix.length);
		const candidate = base.replace(/-+$/, "") + suffix;
		if (!findLabeledEntry(sm, LABEL_PREFIX + candidate)) return candidate;
	}
}

/**
 * Every active anchor — chronological root→leaf, same walk order as `list`
 * — with its cumulative context percentage, rendered as the shared anchor
 * table (#101, D19). Shared by min-savings rejections and rewind hints.
 * A manual
 * `/tree` label `anchor:x` CAN put the same name on two entries —
 * duplicates print twice, exactly as `list` prints them. Names `rewindTo`
 * would reject (e.g. an empty `anchor:` label) are skipped: both callers
 * point the model at rewind targets.
 */
function formatActiveAnchors(
	sm: SessionManager,
	cw: number,
	allEntries: SessionEntry[],
	byId: Map<string, SessionEntry>,
): { names: string[]; text: string } {
	const names: string[] = [];
	const rows: AnchorTableRow[] = [];
	const branch = sm.getBranch();
	for (const e of branch) {
		const lbl = sm.getLabel(e.id);
		if (!lbl?.startsWith(LABEL_PREFIX)) continue;
		const name = lbl.slice(LABEL_PREFIX.length);
		if (!isValidName(name)) continue;
		names.push(name);
		rows.push({
			pct: formatPct1(estimateAtEntry(sm, allEntries, e.id, byId), cw),
			name,
		});
	}
	// cw=0 → percents fall back to formatPct1's k-format and the header
	// drops the window, mirroring `list`.
	return { names, text: formatAnchorTable(rows, cw) };
}

/**
 * Rejection copy for the rewind min-savings floor (#21). Reports the
 * apparent savings plus every active anchor (including rewindTo itself)
 * with its cumulative context percentage, so the agent can pick a
 * genuinely earlier anchor or keep working.
 *
 * Deliberately does NOT print the floor value anywhere: an agent-visible
 * numeric bar invites grinding up to it instead of doing real work.
 */
function buildMinSavingsRejection(
	rewindTo: string,
	newLabel: string,
	apparentSavings: number,
	sm: SessionManager,
	cw: number,
	allEntries: SessionEntry[],
	byId: Map<string, SessionEntry>,
	beforeCompaction: boolean,
): string {
	const anchors = formatActiveAnchors(sm, cw, allEntries, byId);
	if (beforeCompaction) {
		const outcome =
			apparentSavings > 0
				? `free only ~${formatPct1(apparentSavings, 0)} tokens`
				: "not free any context";
		return `Rewinding to '${rewindTo}' (as '${newLabel}') would ${outcome}: '${rewindTo}' lies before the latest compaction, so a fold there restores the compacted history. Rewind to an anchor created after the compaction, or keep working.\n${anchors.text}`;
	}
	const guidance =
		anchors.names[0] === rewindTo
			? "No earlier anchors — keep working and rewind later once more has accumulated above it."
			: "Rewind further back to actually free context, or keep working.";
	return `Rewinding to '${rewindTo}' (as '${newLabel}') would free only ~${formatPct1(apparentSavings, 0)} tokens. ${guidance}\n${anchors.text}`;
}

/**
 * Walk parentId chain back from `fromId` and return a one-line preview of
 * the first entry that has meaningful text content. Branch summaries are
 * prefixed with `summary:` so the source is clear; user/assistant text is
 * shown as-is.
 */
function findLabelHint(sm: SessionManager, fromId: string, maxLen: number): string | null {
	let cur: string | null | undefined = fromId;
	let depth = 0;
	while (cur && depth < MAX_HINT_WALK_DEPTH) {
		const e = sm.getEntry(cur);
		if (!e) break;
		let text = "";
		let prefix = "";
		if (e.type === "branch_summary" && e.summary) {
			text = stripBranchSummaryBoilerplate(e.summary);
			prefix = "summary: ";
		} else if (e.type === "message") {
			const role = e.message.role;
			if (role === "user" || role === "assistant") {
				text = extractTextContent(e.message.content);
			}
		} else if (e.type === "custom_message") {
			text = extractTextContent(e.content);
		}
		const oneLine = toOneLine(text, maxLen - prefix.length);
		if (oneLine) return prefix + oneLine;
		cur = e.parentId;
		depth++;
	}
	return null;
}

// =============================================================================
// Extension
// =============================================================================

/**
 * Earlier handlers' boundary drafts that still apply after a rewind moved the
 * branch. A `context_edit` draft can target an entry the rewind just
 * abandoned; pi validates the whole list in a preview (`appendContextEdit`
 * throws for a target off the active branch) and drops ALL of it, ours
 * included, when one draft fails — so such drafts are dropped here instead.
 * Every other draft passes through: pi never validates a compaction's
 * `firstKeptEntryId` (`null` is a valid self-retaining compaction).
 */
function keepValidDrafts<T>(sm: SessionManager, drafts: readonly T[]): T[] {
	let onBranch: Set<string>;
	try {
		onBranch = new Set(sm.getBranch().map((e) => e.id));
	} catch {
		return [...drafts];
	}
	return drafts.filter((draft) => {
		const d = draft as { type?: string; targetId?: string };
		if (d?.type === "context_edit") return onBranch.has(d.targetId ?? "");
		return true;
	});
}

/** A `navigate-tree-rewind` message, delivered as a `turn_end` boundary entry. */
interface RewindMessageDraft {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

function rewindMessageDraft(content: string, details: Record<string, unknown>): RewindMessageDraft {
	return {
		type: "custom_message",
		customType: REWIND_CUSTOM_TYPE,
		content,
		display: true,
		details,
	};
}

/** The model fields rewind-driven compaction reads (#101). */
interface OverflowModel {
	api?: string;
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * True when `message` is a context overflow by pi's own checks (#101, D1):
 * an explicit overflow error, a silent overflow, or a reply squeezed by the
 * context (`isRecoverableLength`). Same model only (pi's `sameModel`): a
 * reply from another model says nothing about this window.
 */
function overflowed(message: unknown, model: OverflowModel | undefined): boolean {
	const m = message as Partial<AssistantMessage> | undefined;
	if (m?.role !== "assistant" || !model) return false;
	if (m.provider !== model.provider || m.model !== model.id) return false;
	try {
		return (
			isContextOverflow(m as AssistantMessage, model.contextWindow) ||
			isRecoverableLength(m as AssistantMessage, model.maxTokens ?? 0)
		);
	} catch {
		return false;
	}
}

/** The request `messages` as pi will send them: a forced system prompt replaces the head. */
function effectiveRequestMessages(sm: SessionManager, messages: AgentMessage[]): AgentMessage[] {
	const session = findOwningSession(sm);
	const forcedPrompt = session
		? asInternals(session)._runSystemPromptOptions?.forceSystemPrompt
		: undefined;
	if (forcedPrompt === undefined) return messages;
	const currentSystem = getCurrentSystemMessage(messages);
	return [
		{
			role: "system",
			content: forcedPrompt,
			...(currentSystem?.toolsAdded ? { toolsAdded: currentSystem.toolsAdded } : {}),
			timestamp: currentSystem?.timestamp ?? 0,
		},
		...messages.filter((message) => message.role !== "system"),
	];
}

function requestAccounting(sm: SessionManager, messages: AgentMessage[]) {
	return accountRequest(effectiveRequestMessages(sm, messages), tokenFactorOf(sm));
}

/**
 * Per session, for the model that served its latest request: estimated tokens
 * per heuristic token that model reported, and the heuristic of the request
 * still awaiting its usage. A model switch drops the measurement, because
 * tokenizers differ.
 */
const tokenCalibration = new Map<string, { modelKey: string; factor?: number; pending?: number }>();

function tokenFactorOf(sm: { getSessionId(): string }): number {
	try {
		return tokenCalibration.get(sm.getSessionId())?.factor ?? DEFAULT_TOKEN_FACTOR;
	} catch {
		return DEFAULT_TOKEN_FACTOR;
	}
}

/** Remember the heuristic of the request about to go to `modelKey`. */
function noteOutgoingRequest(sessionId: string, modelKey: string, effective: AgentMessage[]): void {
	const current = tokenCalibration.get(sessionId);
	tokenCalibration.set(sessionId, {
		modelKey,
		...(current?.modelKey === modelKey && { factor: current.factor }),
		pending: estimateRawRequestTokens(effective),
	});
}

/** Calibrate from the usage the model reported for the noted request. */
function noteRequestUsage(sessionId: string, message: unknown, contextWindow = 0): void {
	const current = tokenCalibration.get(sessionId);
	const m = message as Partial<AssistantMessage> | undefined;
	if (
		current?.pending === undefined ||
		m?.role !== "assistant" ||
		`${m.provider}/${m.model}` !== current.modelKey ||
		m.stopReason === "error" ||
		m.stopReason === "aborted" ||
		!m.usage
	)
		return;
	const factor = measuredTokenFactor(
		calculateContextTokens(m.usage) - (m.usage.output ?? 0),
		current.pending,
		contextWindow,
	);
	tokenCalibration.set(sessionId, {
		modelKey: current.modelKey,
		factor: factor ?? current.factor,
	});
}

/** The admission estimate of a complete request whose system state is already effective. */
function accountRequest(effective: AgentMessage[], factor = DEFAULT_TOKEN_FACTOR) {
	const system = getCurrentSystemMessage(effective);
	const mandated = system !== undefined && getSystemMessageText(system).includes(ANCHOR_MANDATE);
	return {
		messages: effective,
		tokens:
			estimateRequestTokens(effective, factor) +
			(mandated ? 0 : Math.ceil((ANCHOR_MANDATE.length / 4) * factor)),
	};
}

/**
 * The one number the extension gates and reports context on: what the next
 * request on the active branch would cost, as the request guard estimates it.
 * The branch is projected as `context` sends it, under the effective system
 * state `requestAccounting` uses.
 */
export function estimateAdmissionTokens(sm: SessionManager): number {
	return accountRequest(admissionMessages(sm), tokenFactorOf(sm)).tokens;
}

/** The next request on the active branch under the effective system state. */
function admissionMessages(sm: SessionManager): AgentMessage[] {
	const system = getCurrentSystemMessage(sm.buildSessionContext().messages);
	return effectiveRequestMessages(sm, [...(system ? [system] : []), ...buildContextMessages(sm)]);
}

/** `context_edit` drafts hiding `ids` (a failed attempt). */
function hideDrafts(ids: readonly string[]): SessionBoundaryDraft[] {
	return ids.map((targetId) => ({
		type: "context_edit",
		targetId,
		replacement: null,
	}));
}

/** customType of the rewind continuation and receipt messages. */
export const REWIND_CUSTOM_TYPE = "navigate-tree-rewind";

/** The rewind's tool result: the fold is queued and lands after this turn's tool results. */
export function buildRewindAcceptedText(rewindTo: string, newLabel: string): string {
	return `[${TOOL_NAME}] Rewind to '${rewindTo}' accepted (collapse as '${newLabel}'). The fold runs after this turn's tool results; the continuation follows in the same run.`;
}

/**
 * The continuity block of the summary request: what the ledger keeps in force
 * and the user messages the model may cite. Absent (the request is then
 * byte-identical to one without a ledger) when the ledger has nothing active
 * and the folded span holds no user message. Fail-open: a fold never depends
 * on it.
 */
function continuityRequestSection(
	sm: SessionManager,
	fold: { target: string; rewindTo: string },
): string | undefined {
	try {
		const branch = sm.getBranch();
		const { ledger } = readBranchLedger(branch);
		const userEntries = spanUserEntryRefs(branch, fold.target);
		if (userEntries.length === 0 && !ledger.items.some((item) => item.status === "active")) {
			return undefined;
		}
		return renderFoldCaptureSection(ledger, fold.rewindTo, userEntries);
	} catch {
		return undefined;
	}
}

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

/**
 * Minimal TUI component (pi-tui's `Component` shape) rendering plain lines,
 * word-wrapped to the width in terminal cells and styled per line. pi-tui
 * throws on any rendered line wider than the terminal, so every line is
 * measured and wrapped with pi-tui's own helpers (pi's extension loader
 * aliases `@earendil-works/pi-tui` to its bundled copy at runtime).
 */
class StyledLines {
	private readonly lines: string[];
	private readonly style: (line: string) => string;
	private readonly padX: number;
	private readonly wrap: boolean;

	constructor(lines: string[], style: (line: string) => string, padX = 1, wrap = true) {
		this.lines = lines;
		this.style = style;
		this.padX = padX;
		this.wrap = wrap;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2 * this.padX);
		const pad = " ".repeat(Math.max(0, Math.min(this.padX, width - 1)));
		const out: string[] = [];
		for (const line of this.lines) {
			const pieces = this.wrap ? wrapPlainLine(line, inner) : [truncateToWidth(line, inner, "…")];
			for (const piece of pieces) {
				const row = pad + this.style(piece);
				// Final guard: pi-tui throws on a line wider than the terminal.
				out.push(visibleWidth(row) <= width ? row : truncateToWidth(row, Math.max(0, width), ""));
			}
		}
		return out;
	}

	invalidate(): void {}
}

/**
 * Word-wrap one plain-text line to `width` terminal cells (hard-break words
 * longer than the width). Cells, not code points: `summaryFocus` and error
 * reasons can carry wide characters (CJK, emoji) and tabs. Tabs are
 * expanded first (pi-tui measures one as 3 cells); every piece is then
 * truncated to the width as a final guard (a 2-cell character cannot fit a
 * 1-cell width).
 */
export function wrapPlainLine(line: string, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const text = line.replace(/\t/g, "   ");
	if (visibleWidth(text) <= w) return [text];
	return wrapTextWithAnsi(text, w).map((piece) =>
		visibleWidth(piece) <= w ? piece : truncateToWidth(piece, w, ""),
	);
}

/**
 * Why a fold no longer matches the active branch, or `null`. The fold point
 * (`afterEntryId`) must still be on the branch, and no compaction may have
 * landed after it: one landing during the summary would leave the summarized
 * evidence out of step with the raw segment.
 */
function rewindStaleReason(sm: SessionManager, afterEntryId: string): string | null {
	let branch: SessionEntry[];
	try {
		branch = sm.getBranch();
	} catch {
		return null;
	}
	const start = branch.findIndex((e) => e.id === afterEntryId);
	if (start < 0) return "the folded work is no longer on the active branch";
	return branch.slice(start + 1).some((e) => e.type === "compaction")
		? "the context was compacted"
		: null;
}

/**
 * Entries that arrived on the active branch after `afterEntryId` (the fold
 * point) from outside the conversation's own
 * turns: user messages (steers drained at the rewind turn's boundary) and
 * other extensions' custom messages (subagent results, timers). Oldest
 * first; this extension's own rewind and rewind-hint messages are excluded
 * (a pre-rewind rewind hint is stale once it lands).
 */
export type LateEntry =
	| {
			kind: "user" | "assistant";
			message: Extract<SessionEntry, { type: "message" }>["message"];
	  }
	| {
			kind: "custom";
			customType: string;
			content: Extract<SessionEntry, { type: "custom_message" }>["content"];
			display: boolean;
			details: unknown;
	  };

function isPreservedLateEntry(entry: SessionEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user") return true;
	return (
		entry.type === "custom_message" &&
		entry.customType !== REWIND_CUSTOM_TYPE &&
		entry.customType !== REWIND_HINT_CUSTOM_TYPE
	);
}

function toolEnvelopeIds(message: AgentMessage): {
	calls: string[];
	result?: string;
} {
	if (message.role === "toolResult") {
		return { calls: [], result: message.toolCallId };
	}
	if (message.role !== "assistant") return { calls: [] };
	return {
		calls: message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
	};
}

/** Read-only fold boundary in the current canonical context, preserving unanswered input. */
export function recoveryCutOf(
	sm: SessionManager,
	incompleteReplyId?: string,
): { ok: true; foldPointId: string } | { ok: false; detail: string } {
	try {
		const allEntries = sm.getEntries();
		const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
		const order = new Map(allEntries.map((entry, index) => [entry.id, index]));
		const projection = buildSessionProjection(allEntries, sm.getLeafId(), byId);
		const occurrence = (entryId: string, callId: string) => JSON.stringify([entryId, callId]);
		const archived = new Map<string, Set<string>>();
		const visiting = new Set<string>();
		// A summary can discharge only the exact occurrence completed on its fromId ancestry.
		const completedThrough = (leafId: string): Set<string> => {
			const cached = archived.get(leafId);
			if (cached) return cached;
			if (visiting.has(leafId)) throw new Error("cyclic summary history");
			visiting.add(leafId);
			const path: SessionEntry[] = [];
			const seen = new Set<string>();
			let id: string | null = leafId;
			while (id !== null) {
				if (seen.has(id)) throw new Error("cyclic session history");
				seen.add(id);
				const entry = byId.get(id);
				if (!entry) throw new Error("missing summary history");
				path.push(entry);
				id = entry.parentId;
			}
			const pending = new Map<string, string>();
			const completed = new Set<string>();
			for (const entry of path.reverse()) {
				if (entry.type === "branch_summary" && entry.fromId !== "root") {
					const evidence = completedThrough(entry.fromId);
					for (const [callId, key] of pending) {
						if (!evidence.has(key)) continue;
						pending.delete(callId);
						completed.add(key);
					}
				}
				for (const message of sessionEntryToContextMessages(entry)) {
					const envelope = toolEnvelopeIds(message);
					for (const callId of envelope.calls) {
						if (pending.has(callId)) throw new Error("duplicate outstanding archived tool call");
						pending.set(callId, occurrence(entry.id, callId));
					}
					if (envelope.result !== undefined) {
						const key = pending.get(envelope.result);
						if (!key) throw new Error("orphan archived tool result");
						pending.delete(envelope.result);
						completed.add(key);
					}
				}
			}
			visiting.delete(leafId);
			archived.set(leafId, completed);
			return completed;
		};

		const pending = new Map<string, string>();
		let foldPointId: string | undefined;
		let unansweredInput = false;
		// Native projection places the compaction before its older retained messages.
		const chronological = projection.entries.toSorted(
			(a, b) => (order.get(a.sourceEntry.id) ?? -1) - (order.get(b.sourceEntry.id) ?? -1),
		);
		for (const { sourceEntry, messages } of chronological) {
			if (messages.length === 0 || sourceEntry.id === incompleteReplyId) continue;
			if (isPreservedLateEntry(sourceEntry)) unansweredInput = true;
			if (
				pending.size > 0 &&
				sourceEntry.type === "branch_summary" &&
				sourceEntry.fromId !== "root"
			) {
				const evidence = completedThrough(sourceEntry.fromId);
				for (const [callId, key] of pending) {
					if (evidence.has(key)) pending.delete(callId);
				}
			}
			for (const message of messages) {
				const envelope = toolEnvelopeIds(message);
				for (const callId of envelope.calls) {
					if (pending.has(callId)) throw new Error("duplicate outstanding tool call");
					pending.set(callId, occurrence(sourceEntry.id, callId));
				}
				if (envelope.result !== undefined) {
					if (unansweredInput) throw new Error("tool result crosses unanswered input");
					if (!pending.delete(envelope.result)) throw new Error("tool result without its call");
				}
				if (
					(message.role === "assistant" &&
						message.stopReason !== "error" &&
						message.stopReason !== "aborted") ||
					message.role === "toolResult" ||
					sourceEntry.type === "branch_summary"
				) {
					foldPointId = sourceEntry.id;
					unansweredInput = false;
				} else if (sourceEntry.type === "compaction" && !unansweredInput) {
					foldPointId = sourceEntry.id;
				}
			}
		}
		if (pending.size) throw new Error("tool call without its result");
		if (!foldPointId) {
			return {
				ok: false,
				detail: "the active context has no completed work to fold",
			};
		}
		return { ok: true, foldPointId };
	} catch (error) {
		return {
			ok: false,
			detail: `the recovery cut is unsafe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function collectLateEntries(
	sm: SessionManager,
	afterEntryId: string,
	recoveryEvidenceId?: string,
): LateEntry[] {
	let branch: SessionEntry[];
	try {
		branch = sm.getBranch();
	} catch {
		return [];
	}
	const start = branch.findIndex((e) => e.id === afterEntryId);
	if (start < 0) return [];
	const late: LateEntry[] = [];
	for (const entry of branch.slice(start + 1)) {
		if (
			entry.id === recoveryEvidenceId &&
			entry.type === "message" &&
			entry.message.role === "assistant"
		) {
			// Replayed evidence is neither a fresh usage baseline nor a second billed call.
			late.push({
				kind: "assistant",
				message: {
					...entry.message,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				},
			});
			continue;
		}
		if (!isPreservedLateEntry(entry)) continue;
		if (entry.type === "message" && entry.message.role === "user") {
			late.push({ kind: "user", message: entry.message });
		} else if (entry.type === "custom_message") {
			late.push({
				kind: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
			});
		}
	}
	return late;
}

export function buildRewindDoneText(
	fold: {
		rewindTo: string;
		newLabel: string;
		beforeTokens: number;
		contextWindow: number;
	},
	afterTokens: number,
): string {
	return (
		`[rewind to '${fold.rewindTo}' · collapsed as '${fold.newLabel}'] · ${formatContextDelta(fold.beforeTokens, afterTokens, fold.contextWindow)}\n\n` +
		`A branch_summary of the collapsed work has been appended to your context. It is the newest branch_summary, the current state; earlier branch_summary messages, if present, are older collapsed segments. Items under '### Done' are complete. Items under '### In Progress', '### Blocked', or '## Next Steps' are the resume point: continue the latest branch_summary's work without re-confirming with the user.\n\n` +
		`A branch_summary marks a milestone, not the end of the task. Your authority, highest first: the user's standing instruction retained above (including any authorization to work autonomously until the task is complete or a real blocker appears), the authorized plan or todo list, then this summary's open items. If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope. Retained user messages already answered above are historical — do not re-answer them; their standing instructions still apply.`
	);
}

/** Sent once when the first turn after a fold ends text-only with work still open. */
export const CONTINUE_NUDGE_TEXT =
	"[navigate_tree] You ended the turn immediately after a rewind. Its branch_summary is a milestone summary, not a stop condition: if the user's standing instruction or the authorized plan still has open work, continue with it now, in this turn. End the turn only when the authorized scope is done and verified, or a real blocker needs the user — and say which.";

const CONTINUE_NUDGE_STATUS = "continue-nudge";

export function buildLateEntriesNote(count: number): string {
	return count === 1
		? "The message between the branch_summary and this one arrived while the rewind was pending — it is new and still unanswered; handle it now."
		: `The ${count} messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.`;
}

/** What the preview stage of a fold needs: a commit's input without its session writes. */
export interface FoldPreviewInput {
	/** The anchor entry the new branch starts from. */
	targetId: string;
	/** The anchor name that must still resolve to `targetId`. */
	rewindTo: string;
	/** The summary's label; must still be free. */
	newLabel: string;
	/** The model's summary, continuity delta included. */
	summaryText: string;
	handoffMode: HandoffMode;
	/** Tokens; 0 skips the headroom gate. */
	contextWindow: number;
	/** The last folded entry: input after it is late, kept out of the fold and re-appended after it. */
	foldPointId: string;
	/** Successful overflow evidence retained after the pending input. */
	recoveryEvidenceId?: string;
	/** Gets the `branch:<newLabel>` completion marker before the branch is written. */
	branchLabelEntryId?: string;
	/** The continuation's lead text for a post-fold request of `afterTokens`. */
	continuationText(afterTokens: number): string;
}

/** What the commit stage of a fold needs; the caller owns the summary and its own bookkeeping. */
export interface FoldCommitInput extends FoldPreviewInput {
	/** Synchronous label write; false when it failed. */
	writeLabel(entryId: string, label: string | undefined): boolean;
}

/** Everything a fold writes, prepared from session reads alone. */
export interface FoldMaterialization {
	/** The leaf the fold abandons. */
	oldLeafId: string | null;
	/** The `branch_summary` text: handoff, full child reports and the continuity briefing. */
	materialized: string;
	/** The `branch_summary` details: file lists, handoff metadata and the ledger snapshot. */
	details: Record<string, unknown>;
	/** The entries between the target and the leaf. */
	collapsedEntries: number;
	readFiles: string[];
	modifiedFiles: string[];
	/** Input after the fold point, re-appended after the summary. */
	lateEntries: LateEntry[];
	continuity: FoldContinuity;
	/** Open collapsed user instructions, separate from generated narrative. */
	openUserRequests: OpenUserRequest[];
	/** The latest compaction, re-appended after the summary because its kept range holds the target. */
	carriedCompaction?: CompactionEntry;
}

/** `ok: false` is the reason `commitFold` would refuse for; nothing was written either way. */
export type FoldPreview =
	| { ok: false; reason: string }
	| ({
			ok: true;
			/** The admission estimate of the first request after the fold, continuation included. */
			projectedAfterTokens: number;
			foldEstimateBefore: number;
			foldEstimateAfter: number;
	  } & FoldMaterialization);

/** `ok: false` writes nothing; the session is as the caller found it. */
export type FoldCommitOutcome =
	| { ok: false; reason: string }
	| {
			ok: true;
			summaryId: string;
			oldLeafId: string | null;
			collapsedEntries: number;
			afterTokens: number;
			foldEstimateBefore: number;
			foldEstimateAfter: number;
			/** Late entries re-appended after the summary. */
			reappended: number;
			refreshed: boolean;
			historyRewriteNotified: boolean;
			readFiles: string[];
			modifiedFiles: string[];
			/** The message that tells the model the fold landed. */
			continuation: string;
			openUserRequests: OpenUserRequest[];
			continuityNotice?: string;
			continuityReport?: FoldContinuity["report"];
	  };

/**
 * Everything a fold commit decides, from session reads alone: revalidate the
 * target, collect the span and the late input, reconcile the continuity
 * ledger, materialize the handoff, project the branch it leaves (full child
 * handoffs, briefing, late input and continuation included) and gate it on
 * reducing context and on the request headroom. `commitFold` lands exactly
 * this; candidate pricing reuses it with a placeholder `summaryText`.
 * A session read failing during the target checks throws; any later one is a
 * refusal.
 */
export function previewFoldCommit(sm: SessionManager, input: FoldPreviewInput): FoldPreview {
	const { targetId, rewindTo, newLabel, foldPointId } = input;
	const refuse = (reason: string): FoldPreview => ({ ok: false, reason });
	// A compaction or tree move since the summary was requested invalidates the
	// fold: the anchor must still be the same labeled entry on the active
	// branch, and the new label must still be free.
	if (findLabeledEntry(sm, LABEL_PREFIX + rewindTo) !== targetId) {
		return refuse(`'${rewindTo}' is no longer on the active branch`);
	}
	if (findLabeledEntry(sm, LABEL_PREFIX + newLabel)) {
		return refuse(`a label '${newLabel}' now exists on the active branch`);
	}
	const staleReason = rewindStaleReason(sm, foldPointId);
	if (staleReason) return refuse(staleReason);
	const oldLeafId = sm.getLeafId();
	// Input that arrived after the fold point (user steers drained at the
	// rewind turn's boundary, other extensions' messages) sits on the segment
	// about to be abandoned. It is new input, not collapsed work: it is
	// re-appended onto the new branch, in order, ahead of the continuation
	// (which flags it as unanswered).
	const lateEntries = collectLateEntries(sm, foldPointId, input.recoveryEvidenceId);
	try {
		const { entries } = collectEntriesForBranchSummary(sm, oldLeafId, targetId);
		const { fileOps } = prepareBranchEntries(entries, Number.MAX_SAFE_INTEGER);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		const children = entries.filter((entry) => entry.type === "branch_summary");
		const all = new Map(sm.getEntries().map((entry) => [entry.id, entry]));
		const sourceIds = new Set(
			entries.filter((entry) => entry.type !== "branch_summary").map((entry) => entry.id),
		);
		for (const child of children) {
			sourceIds.add(child.id);
			const metadata = getHandoff(child);
			if (metadata) for (const id of metadata.sourceIds) sourceIds.add(id);
			else if (child.type === "branch_summary") {
				const path = sm.getBranch(child.fromId);
				const at = path.findIndex((entry) => entry.id === child.parentId);
				for (const entry of path.slice(at + 1)) sourceIds.add(entry.id);
			}
		}
		// Pure: the ledger only changes through the branch_summary a commit
		// writes, so every failure ending before it leaves the ledger untouched.
		const continuity = reconcileFoldContinuity(sm.getBranch(), input.summaryText, rewindTo);
		const handoff = makeHandoff({
			name: newLabel,
			report: continuity.summaryText + formatFileOperations(readFiles, modifiedFiles),
			mode: input.handoffMode,
			children: children.map((child) => child.id),
			sourceEntries: [...sourceIds].flatMap((id) => {
				const entry = all.get(id);
				return entry ? [entry] : [];
			}),
		});
		// A child's own briefing is stale in its parent: only this fold's stays.
		const handoffText = materializeHandoff(
			handoff,
			children.flatMap((child) =>
				child.type === "branch_summary"
					? [
							{
								id: child.id,
								summary: stripContinuityBriefing(child.summary),
								handoff: getHandoff(child),
							},
						]
					: [],
			),
		);
		const materialized =
			continuity.briefing === undefined
				? handoffText
				: appendContinuityBriefing(handoffText, continuity.briefing);
		const details = {
			readFiles,
			modifiedFiles,
			treeNavigator: handoff,
			...(continuity.snapshot && {
				[LEDGER_DETAILS_KEY]: continuity.snapshot,
			}),
		};
		let previewId = "tree-navigator-fold-preview";
		while (all.has(previewId)) previewId += "-";
		const preview: SessionEntry = {
			type: "branch_summary",
			id: previewId,
			parentId: targetId,
			timestamp: new Date().toISOString(),
			fromId: oldLeafId ?? foldPointId,
			summary: materialized,
			details,
			fromHook: true,
		};
		const carry = carriedCompaction(sm.getBranch(), targetId);
		const prospectiveEntries: SessionEntry[] = [...all.values(), preview];
		let prospectiveLeaf = previewId;
		if (carry) {
			const copy = compactionCopy(
				carry,
				previewId,
				new Map(prospectiveEntries.map((entry) => [entry.id, entry])),
			);
			prospectiveEntries.push(copy);
			prospectiveLeaf = copy.id;
		}
		const prospective = projectHandoffs(
			buildSessionProjection(prospectiveEntries, prospectiveLeaf),
			prospectiveEntries,
		).messages;
		const lateMessages: AgentMessage[] = lateEntries.map((late) =>
			late.kind !== "custom"
				? late.message
				: {
						role: "custom",
						customType: late.customType,
						content: late.content,
						display: late.display,
						details: late.details,
						timestamp: Date.now(),
					},
		);
		prospective.push(...lateMessages);
		const currentEntries = sm.buildSessionProjection().entries;
		const foldPointAt = currentEntries.findIndex((entry) => entry.sourceEntry.id === foldPointId);
		if (foldPointAt < 0) return refuse("the folded work is no longer in the projected context");
		const retainedIds = new Set(
			buildSessionProjection(sm.getEntries(), targetId).entries.map(
				(entry) => entry.sourceEntry.id,
			),
		);
		const openUserRequests = collectOpenUserRequests(
			currentEntries,
			foldPointId,
			retainedIds,
			REWIND_CUSTOM_TYPE,
		);
		const foldEstimateBefore = estimateContentTokens([
			...currentEntries.slice(0, foldPointAt + 1).flatMap((entry) => entry.messages),
			...lateMessages,
		]);
		prospective.push({
			role: "custom" as const,
			customType: REWIND_CUSTOM_TYPE,
			content:
				input.continuationText(requestAccounting(sm, prospective).tokens) +
				renderOpenUserRequests(openUserRequests) +
				(continuity.notice ? `\n\n${continuity.notice}` : "") +
				(lateEntries.length ? `\n\n${buildLateEntriesNote(lateEntries.length)}` : "") +
				`\n\n${REFLECTION_BOOTSTRAP_WARNING_REWIND}`,
			display: true,
			timestamp: Date.now(),
		});
		const foldEstimateAfter = estimateContentTokens(prospective);
		if (foldEstimateAfter >= foldEstimateBefore) {
			const restoresCompacted =
				precedesLatestCompaction(sm.getBranch(), targetId) &&
				estimateContentTokens(projectAtEntry(sm.getEntries(), targetId, all)) >= foldEstimateBefore;
			return refuse(
				restoresCompacted
					? `'${rewindTo}' lies before the latest compaction, so folding to it restores the compacted history instead of reducing projected context (estimated ${foldEstimateBefore} -> ${foldEstimateAfter} tokens); original history was kept`
					: `the materialized handoff does not reduce projected context (estimated ${foldEstimateBefore} -> ${foldEstimateAfter} tokens); original history was kept`,
			);
		}
		const projectedAfterTokens = requestAccounting(sm, prospective).tokens;
		if (
			input.contextWindow > 0 &&
			projectedAfterTokens + RECOVERY_MIN_OUTPUT_TOKENS + RECOVERY_HEADROOM_TOKENS >
				input.contextWindow
		) {
			return refuse(
				"the materialized handoff leaves insufficient request headroom; original history was kept",
			);
		}
		return {
			ok: true,
			projectedAfterTokens,
			foldEstimateBefore,
			foldEstimateAfter,
			oldLeafId,
			materialized,
			details,
			collapsedEntries: entries.length,
			readFiles,
			modifiedFiles,
			lateEntries,
			continuity,
			openUserRequests,
			...(carry && { carriedCompaction: carry }),
		};
	} catch (err) {
		return refuse(
			`the fold could not be prepared (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

const unrestoredFoldCursors = new WeakSet<SessionManager>();

/**
 * The commit stage of a fold: preview it (`previewFoldCommit`), then branch
 * from the target, label, re-append late input, refresh the agent and emit
 * `session_tree`. Throws only before anything is written; every step after the
 * branch is guarded.
 */
export async function commitFold(
	sm: SessionManager,
	input: FoldCommitInput,
): Promise<FoldCommitOutcome> {
	if (unrestoredFoldCursors.has(sm)) {
		return {
			ok: false,
			reason:
				"A previous fold could not restore the session cursor. Persistence remains uncertain; reload the session before another fold.",
		};
	}
	const preview = previewFoldCommit(sm, input);
	if (!preview.ok) return preview;
	const {
		oldLeafId,
		materialized,
		details,
		collapsedEntries,
		readFiles,
		modifiedFiles,
		lateEntries,
		continuity,
		openUserRequests,
		foldEstimateBefore,
		foldEstimateAfter,
		carriedCompaction: carry,
	} = preview;
	const { targetId, newLabel, branchLabelEntryId } = input;
	const previousLabel = branchLabelEntryId ? sm.getLabel(branchLabelEntryId) : undefined;
	const labelWrite = (entryId: string, label: string | undefined) =>
		trySessionWrite(sm, () => {
			if (!input.writeLabel(entryId, label)) {
				throw new Error("label write failed");
			}
		});
	const refuseWrite = (step: string, error: unknown): FoldCommitOutcome => {
		let cursorRestored = false;
		try {
			if (oldLeafId === null) sm.resetLeaf();
			else sm.branch(oldLeafId);
			cursorRestored = sm.getLeafId() === oldLeafId;
		} catch {
			// No append is safe until the original cursor has been restored.
		}
		let restorationAppended = false;
		if (cursorRestored) {
			const restoration = branchLabelEntryId
				? labelWrite(branchLabelEntryId, previousLabel)
				: trySessionWrite(sm, () =>
						sm.appendCustomEntry("navigate-tree-fold-restoration", {
							oldLeafId,
							newLabel,
						}),
					);
			restorationAppended = restoration.ok;
			cursorRestored = restoration.ok || restoration.cursorRestored;
		}
		if (cursorRestored) unrestoredFoldCursors.delete(sm);
		else unrestoredFoldCursors.add(sm);
		refreshAgentMessages(sm);
		return {
			ok: false,
			reason: `${step} (${error instanceof Error ? error.message : String(error)}). ${
				cursorRestored
					? "Original active branch restored in memory."
					: "Original active branch could not be restored in memory."
			} ${
				restorationAppended
					? "A restoration append succeeded."
					: "No restoration append succeeded; durable rollback and completion-marker restoration are not confirmed."
			} Persistence remains uncertain after the write failure; original archived entries were retained. Stop and inspect the session before continuing.`,
		};
	};
	// An unrelated existing label must remain addressable on the archived branch.
	if (branchLabelEntryId && previousLabel === undefined) {
		const marker = labelWrite(branchLabelEntryId, BRANCH_LABEL_PREFIX + newLabel);
		if (!marker.ok) return refuseWrite("the completion marker could not be written", marker.error);
	}
	const branch = trySessionWrite(sm, () =>
		sm.branchWithSummary(targetId, materialized, details, true),
	);
	if (!branch.ok) return refuseWrite("the branch could not be written", branch.error);
	const summaryId = branch.value;
	const label = labelWrite(summaryId, LABEL_PREFIX + newLabel);
	if (!label.ok) return refuseWrite("the summary label could not be written", label.error);
	if (carry) {
		const carried = trySessionWrite(sm, () =>
			sm.appendCompaction(
				carry.summary,
				carry.firstKeptEntryId,
				carry.tokensBefore,
				carriedDetails(carry),
				carry.fromHook,
			),
		);
		if (!carried.ok)
			return refuseWrite("the carried compaction could not be written", carried.error);
	}
	// Direct appends, not the steer queue: no second pass through other
	// extensions' input handlers, and anything still queued is delivered
	// after these, keeping the original order.
	let reappended = 0;
	for (const late of lateEntries) {
		const appended = trySessionWrite(sm, () => {
			if (late.kind !== "custom") {
				sm.appendMessage(late.message as Parameters<SessionManager["appendMessage"]>[0]);
			} else {
				sm.appendCustomMessageEntry(
					late.customType,
					late.content as Parameters<SessionManager["appendCustomMessageEntry"]>[1],
					late.display,
					late.details,
				);
			}
		});
		if (!appended.ok) {
			// Another wrapper can throw after this append reached the file. Keep a
			// write that is durably there; refuse one that only reached memory.
			const matched = (appended.appended ?? []).filter((entry) =>
				late.kind === "custom"
					? entry.type === "custom_message" && entry.customType === late.customType
					: entry.type === "message" &&
						entry.message.role === (late.message as { role?: string }).role,
			);
			const landed =
				matched.length > 0 &&
				persistedOnDisk(
					sm,
					matched.map((entry) => entry.id),
				);
			if (!landed) return refuseWrite("late input could not be written", appended.error);
			// Re-branch to the landed entry: the restored cursor would drop it.
			const keep = appended.appended.at(-1)?.id;
			try {
				if (keep) sm.branch(keep);
			} catch {
				return refuseWrite("late input could not be kept", appended.error);
			}
		}
		reappended++;
	}
	// The branch has landed: every step below is guarded so the
	// continuation always reaches the model.
	let afterTokens = 0;
	try {
		afterTokens = estimateAdmissionTokens(sm);
	} catch {
		afterTokens = 0;
	}
	const refreshed = refreshAgentMessages(sm);
	const historyRewriteNotified = await emitSessionTree(sm, oldLeafId, summaryId);
	return {
		ok: true,
		summaryId,
		oldLeafId,
		collapsedEntries,
		afterTokens,
		foldEstimateBefore,
		foldEstimateAfter,
		reappended,
		refreshed,
		historyRewriteNotified,
		readFiles,
		modifiedFiles,
		openUserRequests,
		continuation:
			input.continuationText(afterTokens) +
			renderOpenUserRequests(openUserRequests) +
			(continuity.notice ? `\n\n${continuity.notice}` : "") +
			(reappended > 0 ? `\n\n${buildLateEntriesNote(reappended)}` : "") +
			(refreshed ? "" : `\n\n${REFLECTION_BOOTSTRAP_WARNING_REWIND}`),
		...(continuity.notice && { continuityNotice: continuity.notice }),
		...(continuity.report && { continuityReport: continuity.report }),
	};
}

/** What an engine fold needs from its session, read from the live context before any await. */
interface FoldHost {
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
type FoldLanded = Omit<Extract<FoldCommitOutcome, { ok: true }>, "ok"> & {
	targetId: string;
	contextBefore: number;
	contextWindow: number;
};

type FoldResult = FoldOutcome<FoldLanded>;

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

/**
 * The shared admission policy for the engine's in-context request: the
 * estimate of the complete request (system prompt and tools included), the
 * output allowance and the recovery headroom must fit the model's window.
 */
function foldAdmission(
	contextWindow: number,
	factor = DEFAULT_TOKEN_FACTOR,
): SummarizeFoldOptions["admit"] {
	return (request, maxOutputTokens) => {
		const inputEstimate =
			accountRequest(
				[
					...(request.systemPrompt
						? [
								{
									role: "system" as const,
									content: request.systemPrompt,
									timestamp: 0,
								},
							]
						: []),
					...request.messages,
				],
				factor,
			).tokens +
			(request.tools ? Math.ceil((JSON.stringify(request.tools).length / 4) * factor) : 0);
		return {
			fits: inputEstimate + maxOutputTokens + RECOVERY_HEADROOM_TOKENS <= contextWindow,
			inputEstimate,
		};
	};
}

/** Output cap the reduce pass and a prospective summary are sized to. */
export function foldSummaryPlaceholderTokens(maxTokens: number | undefined): number {
	return Math.min(
		DEFAULT_REDUCE_OUTPUT_TOKENS,
		typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : DEFAULT_REDUCE_OUTPUT_TOKENS,
	);
}

/** A valid summary whose text estimates to `tokens` at four characters per token. */
export function foldPlaceholderSummary(tokens: number): string {
	const head = "## Goal\nContinue the latest request and the open work.\n";
	const chars = Math.max(1, tokens) * 4;
	if (head.length >= chars) return head.slice(0, chars);
	return head + "x".repeat(chars - head.length);
}

/**
 * Tokens the post-fold request may use: the window minus the hint reserve, or
 * 75% of the window when the hint is off.
 */
export function foldRecommendationBudget(
	contextWindow: number,
	hintReserve: number | null,
): number {
	if (contextWindow <= 0) return 0;
	const reserve = hintReserve === null ? Math.floor(contextWindow * 0.25) : hintReserve;
	return Math.max(0, contextWindow - reserve);
}

/** Index of {@link selectFoldTarget}'s choice, or undefined when none is valid. */
export function recommendFoldIndex<T extends FoldTargetCandidate>(
	candidates: readonly T[],
	budget: number,
): number | undefined {
	const selected = selectFoldTarget(candidates, budget);
	if (!selected.ok) return undefined;
	const index = candidates.indexOf(selected.candidate);
	return index >= 0 ? index : undefined;
}

/** One priced fold target, root to leaf, for the plan and for recovery or auto. */
export interface FoldCandidatePrice extends FoldPlanCandidate {
	targetId: string;
}

/**
 * What a fold would replay for Strategy A, or undefined when that request cannot
 * be captured. Without `targetId` every message is summarized.
 */
function preparedInContext(
	sm: SessionManager,
	targetId: string | undefined,
	throughId: string,
	captured: { modelKey: string; messages: Message[] } | undefined,
	model: { provider: string; id: string } | undefined,
): SummarizeFoldOptions["inContext"] | undefined {
	if (!captured || !model || captured.modelKey !== `${model.provider}/${model.id}`)
		return undefined;
	const allEntries = sm.getEntries();
	const leafId = sm.getLeafId();
	if (!leafId) return undefined;
	const projection = buildFoldProjection(allEntries, leafId, throughId);
	const projectedMessages = buildContextMessages({
		buildContextEntries: () => sm.buildContextEntries(),
		buildSessionProjection: () => projection,
		getBranch: () => sm.getBranch(),
		getLabel: (id) => sm.getLabel(id),
	});
	return buildInContextMessages(
		captured.messages,
		projectedMessages,
		targetId === undefined
			? -1
			: anchorMessageIndex(
					{
						entries: projection.entries.map((entry) => ({
							...entry,
							messages: entry.messages.filter((message) => message.role !== "system"),
						})),
					},
					targetId,
				),
	);
}

/** The reduce allowance `summarizeFold` admits, including the runner's window cap. */
function summarizerReduceTokens(
	model:
		| {
				maxTokens?: number;
				contextWindow?: number;
		  }
		| undefined,
): number {
	const runnerMax = summarizerOutputCap(model);
	if (runnerMax === undefined) return foldSummaryPlaceholderTokens(undefined);
	return Math.min(DEFAULT_REDUCE_OUTPUT_TOKENS, runnerMax);
}

/** `createFoldSummaryRunner`'s response cap, or undefined without a model limit. */
function summarizerOutputCap(
	model: { maxTokens?: number; contextWindow?: number } | undefined,
): number | undefined {
	const maxTokens = model?.maxTokens;
	if (typeof maxTokens !== "number" || maxTokens <= 0) return undefined;
	return Math.min(maxTokens, Math.floor((model?.contextWindow ?? 0) / 4));
}

function previewStrategy(
	inContext: SummarizeFoldOptions["inContext"] | undefined,
	contextWindow: number,
	reduceOut: number,
	focus: string,
	parent: { mode: HandoffMode; childCount: number },
	continuitySection: string | undefined,
	factor: number,
): "in-context" | "chunked" {
	if (!inContext) return "chunked";
	const admitted = foldAdmission(contextWindow, factor)(
		{
			systemPrompt: inContext.systemPrompt,
			tools: inContext.tools,
			messages: [
				...inContext.messages,
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildSummaryRequestText(inContext.first, focus, parent, continuitySection),
						},
					],
					timestamp: 0,
				},
			],
		},
		reduceOut,
	);
	return admitted.fits ? "in-context" : "chunked";
}

const FOCUS_REQUEST_CHARS = 400;

/** Focus for a manual fold: the latest user request and whether a handoff still has open work. */
function defaultFoldFocus(sm: SessionManager): string {
	let latest = "";
	let newestSummary = "";
	try {
		for (const entry of sm.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const text = extractTextContent(entry.message.content).replace(/\s+/g, " ").trim();
				if (text) latest = text;
			} else if (entry.type === "branch_summary") {
				newestSummary = entry.summary;
			}
		}
	} catch {
		latest = "";
		newestSummary = "";
	}
	const open = newestSummary !== "" && hasOpenWork(newestSummary);
	const request = latest
		? `Latest request: ${latest.slice(0, FOCUS_REQUEST_CHARS).trimEnd()}`
		: "Latest request: continue the work on this branch.";
	const remaining = open
		? "Open work remains in the newest handoff; continue it rather than wrapping up."
		: "Continue the unfinished work still on this branch from that request.";
	const focus = `${request} ${remaining}`;
	return focus.length >= MIN_SUMMARY_FOCUS_LENGTH
		? focus
		: `${focus} Continue the authorized work.`;
}

/**
 * Price every active anchor with the commit preview, including full child
 * handoffs, the ledger and the continuation. `projectedAfterTokens` is that
 * preview, never the anchor's own footprint subtracted from the current total.
 */
export function priceFoldCandidates(
	sm: SessionManager,
	input: {
		model?: {
			provider: string;
			id: string;
			contextWindow?: number;
			maxTokens?: number;
		};
		handoffMode: HandoffMode;
		captured?: { modelKey: string; messages: Message[] };
		focus: string;
		suggestLabel(anchorName: string): string;
		/** Last folded entry. Later user and custom input is priced as late, not subtracted. */
		foldPointId?: string;
		/** The summarizer's reasoning level; its allowance decides whether the in-context call fits. */
		thinking?: ThinkingLevel | "off";
	},
): FoldCandidatePrice[] {
	const contextWindow = input.model?.contextWindow ?? 0;
	const beforeTokens = estimateAdmissionTokens(sm);
	const reduceOut = summarizerReduceTokens(input.model);
	const reduceCeiling = Math.min(
		reduceOut + reasoningAllowance(input.thinking ?? "off"),
		summarizerOutputCap(input.model) ?? Number.POSITIVE_INFINITY,
	);
	const placeholder = foldPlaceholderSummary(reduceOut);
	const leafId = input.foldPointId ?? sm.getLeafId();
	return collectActiveAnchors(sm).map((anchor) => {
		const suggestedLabel = input.suggestLabel(anchor.name);
		const targetId = findLabeledEntry(sm, LABEL_PREFIX + anchor.name) ?? "";
		const priced = {
			name: anchor.name,
			targetId,
			...(LABEL_PREFIX + anchor.name === START_ANCHOR_LABEL ? { auto: true as const } : {}),
			...(anchor.hint ? { afterPreview: anchor.hint } : {}),
			beforeTokens,
			projectedAfterTokens: beforeTokens,
			contextWindow,
			strategy: "chunked" as const,
			suggestedLabel,
		};
		if (!leafId || !targetId || !isValidName(anchor.name)) {
			return {
				...priced,
				valid: false,
				reason: !isValidName(anchor.name)
					? `anchor names are kebab-case, at most ${MAX_NAME_LENGTH} characters`
					: `'${anchor.name}' is no longer on the active branch`,
			};
		}
		let strategy: "in-context" | "chunked" = "chunked";
		try {
			const { entries } = collectEntriesForBranchSummary(sm, leafId, targetId);
			strategy = previewStrategy(
				preparedInContext(sm, targetId, leafId, input.captured, input.model),
				contextWindow,
				reduceCeiling,
				input.focus,
				{
					mode: input.handoffMode,
					childCount: entries.filter((entry) => entry.type === "branch_summary").length,
				},
				continuityRequestSection(sm, {
					target: targetId,
					rewindTo: anchor.name,
				}),
				tokenFactorOf(sm),
			);
		} catch {
			strategy = "chunked";
		}
		try {
			const preview = previewFoldCommit(sm, {
				targetId,
				rewindTo: anchor.name,
				newLabel: suggestedLabel,
				summaryText: placeholder,
				handoffMode: input.handoffMode,
				contextWindow,
				foldPointId: leafId,
				continuationText: (afterTokens) =>
					buildRewindDoneText(
						{
							rewindTo: anchor.name,
							newLabel: suggestedLabel,
							beforeTokens,
							contextWindow,
						},
						afterTokens,
					),
			});
			if (!preview.ok) {
				return { ...priced, strategy, valid: false, reason: preview.reason };
			}
			return {
				...priced,
				strategy,
				valid: true,
				projectedAfterTokens: preview.projectedAfterTokens,
			};
		} catch (error) {
			return {
				...priced,
				strategy,
				valid: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	});
}

/** The receipt of a fold that landed: the continuation text plus the fold's figures. */
function foldDoneDraft(
	request: FoldRequest,
	done: Extract<FoldResult, { status: "done" }>,
): RewindMessageDraft {
	const landed = done.commit;
	return rewindMessageDraft(landed.continuation, {
		status: "done",
		rewindTo: request.rewindTo,
		newLabel: request.newLabel,
		targetId: landed.targetId,
		summaryId: landed.summaryId,
		collapsedEntries: landed.collapsedEntries,
		contextBefore: landed.contextBefore,
		contextAfter: landed.afterTokens,
		contextWindow: landed.contextWindow,
		origin: request.origin,
		summaryStrategy: done.strategy,
		summaryCalls: done.calls,
		foldEstimateBefore: landed.foldEstimateBefore,
		foldEstimateAfter: landed.foldEstimateAfter,
		agentMessagesRefreshed: landed.refreshed,
		historyRewriteNotified: landed.historyRewriteNotified,
		readFiles: landed.readFiles,
		modifiedFiles: landed.modifiedFiles,
		reappendedLateMessages: landed.reappended,
		openUserRequests: landed.openUserRequests,
		...(landed.continuityReport && { continuity: landed.continuityReport }),
	});
}

/** The receipt of a fold that did not finish, including uncertain commit writes. */
function foldFailedDraft(
	request: FoldRequest,
	outcome: Exclude<FoldResult, { status: "done" }>,
): RewindMessageDraft {
	const head = `[${TOOL_NAME}] Fold to '${request.rewindTo}' (collapse as '${request.newLabel}')`;
	const base = {
		status: "failed",
		rewindTo: request.rewindTo,
		newLabel: request.newLabel,
		origin: request.origin,
		...(request.toolCallId && { toolCallId: request.toolCallId }),
	};
	if (outcome.status === "failed") {
		return rewindMessageDraft(
			`${head} failed at the ${outcome.stage} stage (${outcome.reason}): ${outcome.detail}${outcome.stage === "commit" ? "" : "\n\nNothing was collapsed."}`,
			{
				...base,
				stage: outcome.stage,
				reason: outcome.reason,
				detail: outcome.detail,
			},
		);
	}
	const reason = outcome.status === "busy" ? "busy" : "cancelled";
	return rewindMessageDraft(
		outcome.status === "busy"
			? `${head} was not started: another fold is running for this session. Nothing was collapsed.`
			: `${head} was cancelled. Nothing was collapsed.`,
		{ ...base, reason },
	);
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

function toolError(text: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text }],
		// `isError` is a statement of intent only: pi-agent-core ignores the flag
		// on a *returned* result (only a thrown `execute()` is finalized as
		// failed), so without the `refusal` marker below the host records this
		// as a successful call and the TUI paints the row with `toolSuccessBg`.
		// The `tool_result` handler in the factory promotes the marker into the
		// host's real error channel.
		details: { ...details, refusal: true },
		isError: true,
	};
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
						rewindHintReserveTokens,
						rewindHintModelReserveTokens: hintByModel,
					},
					modelKey,
				);
				const oldController = resolveAutoNavigateConfig(
					{
						autoNavigate: autoNavigateBase,
						autoNavigateByModel,
						proposal: proposalConfig,
					},
					modelKey,
				);
				const oldContinuity = continuityConfig;
				const loaded = await loadTreeNavigatorConfig({
					agentDir: getAgentDir(),
					projectPath: join(ctx.cwd, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME),
					projectTrusted: ctx.isProjectTrusted(),
					runtime: readRuntimeConfig(sessionId),
				});
				if (sm.getSessionId() !== sessionId) return;
				applyNavigatorConfig(sessionId, loaded.config);
				if (oldReserve !== resolveRewindHintReserve(loaded.config, modelKey))
					hintTracker = new RewindHintTracker();
				if (
					JSON.stringify(oldController) !==
					JSON.stringify(resolveAutoNavigateConfig(loaded.config, modelKey))
				)
					autoFoldStateBySession.delete(sessionId);
				if (
					oldContinuity.capture !== continuityConfig.capture ||
					oldContinuity.intentClassifier !== continuityConfig.intentClassifier
				) {
					classifierTimedOut.delete(sessionId);
					continuityWarned.delete(sessionId);
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
			if (!ctx.isIdle() || queuedFolds.has(sessionId) || runningFolds.has(sessionId))
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
		applyUserOps: createUserOpsWriter(pi, () => continuityConfig.capture),
	});
	patchAgentSessionPrototype();

	const parentModes = new Map<string, HandoffMode>();
	// Independent folds (engine host), keyed by session id. The system head of
	// the latest request is what Strategy A replays; a queued fold (the rewind
	// tool's) runs at the session's next `turn_end`; a session in
	// `runningFolds` is folding now.
	const capturedSystems = new Map<string, { modelKey: string; messages: Message[] }>();
	const queuedFolds = new Map<string, FoldRequest>();
	const runningFolds = new Set<string>();
	// Hints and automatic start anchors skip turns owned by a fold or recovery.
	const rewindTurns = new WeakSet<object>();
	// Turns that overflowed the window (#101, D14): marked by the rewind handler,
	// whether or not rewind-driven compaction is on, so the start anchor skips
	// them.
	const overflowedTurns = new WeakSet<object>();

	const requestBudgetFailures = new Map<
		string,
		{
			inputEstimate: number;
			contextWindow: number;
			receiptId: string;
			detail?: string;
			providerOverflow?: boolean;
		}
	>();
	// Recoveries for the current request: each must start from less context than
	// the last, up to MAX_RECOVERY_ATTEMPTS. Native overflow retry owns the next request.
	const recoveryAttempts = new Map<string, { attempts: number; heuristicTokens: number }>();
	const nativeRetryOwned = new Set<string>();
	const recoveryCuts = new Map<string, string>();
	// Receipts of recoveries that landed at a turn boundary; another handler can
	// replace the boundary's entries, so settlement persists what went missing.
	const recoveryReceipts = new Map<string, RewindMessageDraft[]>();
	const holdRecoveryReceipt = (sessionId: string, draft: RewindMessageDraft) => {
		draft.details.receiptId = randomUUID();
		recoveryReceipts.set(sessionId, [...(recoveryReceipts.get(sessionId) ?? []), draft]);
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

	// Where pi's settings are read from (#101, S4): the session's cwd, agent
	// dir and project trust, set at `session_start`. `null` = cannot tell.
	let piSettingsSource: {
		cwd: string;
		agentDir: string;
		projectTrusted: boolean;
	} | null = null;

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
				if (!piSettingsSource) return null;
				settingsManager = SettingsManager.create(piSettingsSource.cwd, piSettingsSource.agentDir, {
					projectTrusted: piSettingsSource.projectTrusted,
				});
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
			if (!model || head.length === 0) capturedSystems.delete(sessionId);
			else {
				capturedSystems.set(sessionId, {
					modelKey: `${model.provider}/${model.id}`,
					messages: head,
				});
			}
		} catch {
			capturedSystems.delete(sessionId);
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
				? recoveryCuts.get(request.sessionId)
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
			capturedSystems.get(request.sessionId),
			host.model,
		);
		return {
			leafId: foldPointId,
			targetId,
			segment: buildFoldSegment(allEntries, sessionLeaf, targetId, foldPointId),
			inContext,
			parent: {
				mode: parentModes.get(request.sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT,
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
		if (runningFolds.has(sessionId)) return { status: "busy" };
		runningFolds.add(sessionId);
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
			runningFolds.delete(sessionId);
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
		const prior = recoveryAttempts.get(sessionId);
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
		recoveryAttempts.set(sessionId, {
			attempts: (prior?.attempts ?? 0) + 1,
			heuristicTokens,
		});
		if (!model || contextWindow <= 0)
			return { status: "failed", detail: "no operating window is available" };
		const captured = capturedSystems.get(sessionId);
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
			capturedSystems.get(sessionId) === captured;
		const handoffMode = parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT;
		const budget = foldRecommendationBudget(
			contextWindow,
			resolveRewindHintReserve(
				{
					rewindHintReserveTokens,
					rewindHintModelReserveTokens: hintByModel,
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
					autoNavigate: autoNavigateBase,
					autoNavigateByModel,
					proposal: proposalConfig,
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
					captured: capturedSystems.get(sessionId),
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
				captured: capturedSystems.get(sessionId),
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
			recoveryCuts.set(sessionId, cut.foldPointId);
			let outcome: FoldResult;
			try {
				outcome = await runFold(host, request, { signal });
			} finally {
				recoveryCuts.delete(sessionId);
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
		if (queuedFolds.has(sessionId) || runningFolds.has(sessionId)) {
			return {
				ok: false,
				reason: "a fold is already queued or running for this session",
			};
		}
		queuedFolds.set(sessionId, { ...request, sessionId });
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
					rewindHintReserveTokens,
					rewindHintModelReserveTokens: hintByModel,
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
					handoffMode: parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT,
					captured: capturedSystems.get(sessionId),
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
		queuedFolds.delete(sessionId);
		rewindTurns.add(message);
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

	// Continuity capture: the user's instructions on the active branch become
	// ledger ops, persisted as one `navigate-tree-continuity-ops` entry. Config
	// is per `session_start`, like the hint's.
	let continuityConfig = {
		capture: CONTINUITY_CAPTURE_DEFAULT,
		intentClassifier: null as string | null,
	};
	const continuityWarned = new Map<string, Set<string>>();
	// Sessions whose model classifier hung once: heuristics only from then on.
	const classifierTimedOut = new Set<string>();
	let consolidationConfig: ConsolidationConfig = CONSOLIDATION_DEFAULTS;

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
		if (!continuityConfig.capture) return;
		const captureConfig = continuityConfig;
		if ((toolActiveBySession.get(sessionId) ?? toolActive) === false) return;
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
		const warned = continuityWarned.get(sessionId) ?? new Set<string>();
		continuityWarned.set(sessionId, warned);
		const warn = (text: string) => {
			if (continuityConfig !== captureConfig || parentSignal?.aborted || warned.has(text)) return;
			warned.add(text);
			try {
				notify?.(text);
			} catch {
				// Stale ctx: nothing left to surface with.
			}
		};
		const model = classifierTimedOut.has(sessionId) ? null : continuityConfig.intentClassifier;
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
		if (continuityConfig !== captureConfig || parentSignal?.aborted) return;
		if (outcome === "timeout") {
			if (model === null) return;
			classifierTimedOut.add(sessionId);
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
				continuityConfig !== captureConfig
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
	const nudgedFolds = new Set<string>();

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
		if ((toolActiveBySession.get(sessionId) ?? toolActive) === false) return;
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.stopReason === "length" ||
			rewindTurns.has(message) ||
			overflowedTurns.has(message)
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
					nudgedFolds.has(d.summaryId)
				) {
					return;
				}
				const fold = sm.getEntry(d.summaryId);
				if (fold?.type !== "branch_summary" || !hasOpenWork(fold.summary)) return;
				nudgedFolds.add(d.summaryId);
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
			recoveryAttempts.delete(sessionId);
		const messageEntryId = typeof event.messageEntryId === "string" ? event.messageEntryId : "";
		const turnIds = messageEntryId
			? [
					messageEntryId,
					...(event.toolResultEntryIds ?? []).filter((id): id is string => typeof id === "string"),
				]
			: [];
		const budgetFailure = requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			return deliverRaw([...hideDrafts(turnIds), requestBudgetFailureDraft(budgetFailure)], false);
		}
		// The queued fold (E12), after this turn's tool results are committed. It
		// waits across an error turn pi retries.
		const queuedFold = queuedFolds.get(sessionId);
		if (queuedFold && message.stopReason !== "error") {
			const folded = await runQueuedFold(sm, sessionId, queuedFold, message, event, ctx);
			if (folded) return folded;
		}
		// Another extension's continuation owns this boundary.
		if (!event.continue && messageEntryId && overflowed(message, ctx.model)) {
			overflowedTurns.add(message);
			if (message.stopReason === "error") return;
			if (
				ctx.signal?.aborted ||
				nativeRetryOwned.has(sessionId) ||
				(toolActiveBySession.get(sessionId) ?? toolActive) === false ||
				piCompaction(sm, ctx.model)?.enabled !== false
			)
				return;
			rewindTurns.add(message);
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
				requestBudgetFailures.set(sessionId, failure);
				return deliverRaw([requestBudgetFailureDraft(failure)], false);
			}
			refreshAgentMessages(sm);
			return deliverRaw([holdRecoveryReceipt(sessionId, outcome.draft)], true);
		}
		if (!rewindTurns.has(message) && !overflowedTurns.has(message)) {
			await captureContinuity(sm, sessionId, ctx, message);
		}
		const auto = await maybeRunAutomaticFold(sm, sessionId, message, event, ctx);
		if (auto) return auto;
		if (!rewindTurns.has(message) && !overflowedTurns.has(message)) {
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
					(toolActiveBySession.get(sessionId) ?? toolActive) === false ||
					piCompaction(sm, ctx.model)?.enabled !== false ||
					nativeRetryOwned.has(sessionId)
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
					requestBudgetFailures.set(sessionId, failure);
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
		recoveryAttempts.delete(sessionId);
		nativeRetryOwned.delete(sessionId);
		// A rewind the run never reached a boundary for would fold at an
		// unrelated later turn, and block every rewind until then.
		if (queuedFolds.get(sessionId)?.origin === "agent") queuedFolds.delete(sessionId);
		for (const draft of recoveryReceipts.get(sessionId) ?? [])
			if (!receiptOnBranch(sm, draft.details.receiptId)) appendFoldMessage(sm, draft);
		recoveryReceipts.delete(sessionId);
		const budgetFailure = requestBudgetFailures.get(sessionId);
		if (budgetFailure) {
			if (!receiptOnBranch(sm, budgetFailure.receiptId))
				appendFoldMessage(sm, requestBudgetFailureDraft(budgetFailure));
			requestBudgetFailures.delete(sessionId);
			return;
		}
	});

	// Recovery and queued folds cannot outlive the session.
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			requestBudgetFailures.delete(sessionId);
			recoveryReceipts.delete(sessionId);
			capturedSystems.delete(sessionId);
			recoveryAttempts.delete(sessionId);
			nativeRetryOwned.delete(sessionId);
			recoveryCuts.delete(sessionId);
			queuedFolds.delete(sessionId);
			tokenCalibration.delete(sessionId);
			autoFoldStateBySession.delete(sessionId);
		} catch {
			// Fail-open: session_start clears it too.
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		try {
			if (event.reason === "overflow" && event.willRetry) {
				nativeRetryOwned.add(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: preflight may still run on the retry.
		}
	});

	pi.on("session_compact_failed", (event, ctx) => {
		try {
			if (event.reason === "overflow") {
				nativeRetryOwned.delete(ctx.sessionManager.getSessionId());
			}
		} catch {
			// Stale ctx: settlement clears the flag.
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		try {
			anchorStartSettled.delete(ctx.sessionManager.getSessionId());
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

	// Rewind-hint closure state (#44): fresh per factory invocation and reset
	// on every `session_start`, so `/new` / `/resume` / `/reload` sessions
	// never inherit a spent crossing or another session's config. `toolActive`
	// fails open until `before_agent_start` says otherwise. `hintByModel`
	// (#86) holds the `modelOverrides` reserves; the reserve is resolved
	// against the live `ctx.model` on every `turn_end`, so a model switch
	// mid-session takes effect on the next turn.
	let toolActive = true;
	let rewindHintReserveTokens: number | null = null;
	let hintByModel: ReadonlyMap<string, number | null> = new Map();
	let autoNavigateBase: AutoNavigatePartial | undefined;
	let autoNavigateByModel: ReadonlyMap<string, AutoNavigatePartial | null> = new Map();
	let proposalConfig: ProposalOptions | undefined;
	const autoFoldStateBySession = new Map<string, AutoFoldState>();
	let hintTracker = new RewindHintTracker();

	// Auto start-anchor closure state (#55). All of it is keyed by session id
	// and NEVER cleared in-process: once a session has settled (write or
	// found-existing), no later prompt / agent loop re-inserts the label.
	// `/reload` builds a fresh closure, so a reloaded session re-settles once
	// via the existence check (no duplicate write). The per-session maps keep
	// two in-process sessions (e.g. the main session and a subagent) from
	// sharing each other's config value, tool-active gate, or settle marker.
	const anchorStartSettled = new Set<string>();
	const anchorStartTurnsBySession = new Map<string, number>();
	const toolActiveBySession = new Map<string, boolean>();

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
		if (toolActiveBySession.get(sessionId) === false) return;
		if (anchorStartSettled.has(sessionId)) return;
		// Per-session threshold (#55): two sessions started with different
		// project configs must not share one closure value.
		const startAfterTurns = anchorStartTurnsBySession.get(sessionId) ?? START_ANCHOR_DEFAULT_TURNS;
		if (completedTurns < startAfterTurns) return;
		try {
			// The existence check is authoritative: a `start` already on the
			// active branch (manual `/tree` label, pre-reload write, prior
			// settle) wins and settles the session without another write.
			if (findLabeledEntry(sm, START_ANCHOR_LABEL)) {
				anchorStartSettled.add(sessionId);
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
			anchorStartSettled.add(sessionId);
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
				anchorStartSettled.add(sessionId);
			} catch {
				// Fail-open: never throw into the agent loop.
			}
		}
	}

	function applyNavigatorConfig(
		sessionId: string,
		config: Awaited<ReturnType<typeof loadTreeNavigatorConfig>>["config"],
	): void {
		rewindHintReserveTokens = config.rewindHintReserveTokens;
		hintByModel = config.rewindHintModelReserveTokens;
		autoNavigateBase = config.autoNavigate;
		autoNavigateByModel = config.autoNavigateByModel ?? new Map();
		proposalConfig = config.proposal;
		continuityConfig = config.continuity;
		consolidationConfig = config.consolidation;
		anchorStartTurnsBySession.set(sessionId, config.anchorStartAfterTurns);
		parentModes.set(sessionId, config.parentHandoffMode);
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
		piSettingsSource = { cwd, agentDir, projectTrusted };
		requestBudgetFailures.delete(sessionId);
		capturedSystems.delete(sessionId);
		recoveryAttempts.delete(sessionId);
		nativeRetryOwned.delete(sessionId);
		recoveryCuts.delete(sessionId);
		queuedFolds.delete(sessionId);
		tokenCalibration.delete(sessionId);
		rewindHintReserveTokens = null;
		hintByModel = new Map();
		autoNavigateBase = undefined;
		autoNavigateByModel = new Map();
		proposalConfig = undefined;
		autoFoldStateBySession.delete(sessionId);
		hintTracker = new RewindHintTracker();
		toolActive = true;
		continuityConfig = {
			capture: CONTINUITY_CAPTURE_DEFAULT,
			intentClassifier: null,
		};
		consolidationConfig = CONSOLIDATION_DEFAULTS;
		continuityWarned.delete(sessionId);
		classifierTimedOut.delete(sessionId);
		clearRuntimeConfig(sessionId);
		anchorStartTurnsBySession.set(sessionId, START_ANCHOR_DEFAULT_TURNS);
		parentModes.set(sessionId, PARENT_HANDOFF_MODE_DEFAULT);
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
		toolActiveBySession.delete(sessionId);
		if (rewindHintReserveTokens !== null || hintByModel.size > 0) {
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
		if (!piSettingsSource) return [];
		const warnings: string[] = [];
		try {
			const settings = SettingsManager.create(piSettingsSource.cwd, piSettingsSource.agentDir, {
				projectTrusted: piSettingsSource.projectTrusted,
			});
			if (settings.getCompactionSettings(model).enabled) return [];
			const keys = new Set<string>();
			if (model) keys.add(`${model.provider}/${model.id}`);
			for (const key of hintByModel.keys()) keys.add(key);
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
							rewindHintReserveTokens,
							rewindHintModelReserveTokens: hintByModel,
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
		if ((toolActiveBySession.get(sessionId) ?? toolActive) === false) return;
		if (nativeRetryOwned.has(sessionId)) {
			nativeRetryOwned.delete(sessionId);
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
			requestBudgetFailures.set(sessionId, {
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
		toolActive = !Array.isArray(selected) || selected.includes(TOOL_NAME);
		// Per-session copy of the gate (#55): the shared `toolActive` above
		// drives the hint, but an in-process sibling session must not clear this
		// session's auto-anchor gate.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			requestBudgetFailures.delete(sessionId);
			recoveryReceipts.delete(sessionId);
			recoveryAttempts.delete(sessionId);
			nativeRetryOwned.delete(sessionId);
			toolActiveBySession.set(sessionId, toolActive);
		} catch {
			// Fail-open: the per-session gate stays absent.
		}
		if (!toolActive) return {};
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
			!!event.message && typeof event.message === "object" && rewindTurns.has(event.message);
		// An overflowed turn is never anchored (#101, D14): with pi compaction on,
		// rewind-driven compaction stands down and does not mark it owned.
		const overflowedTurn =
			!!event.message && typeof event.message === "object" && overflowedTurns.has(event.message);
		if (sm && !rewindOwned && !overflowedTurn) {
			writeStartAnchorIfNeeded(sm as SessionManager, event.turnIndex + 1);
		}
		// Per-session hint gate (#58): an in-process sibling session's
		// `before_agent_start` (e.g. a subagent whose tool subset omits
		// `navigate_tree`) must not clear THIS session's hint. Mirrors the auto
		// start-anchor's per-session gate; the shared `toolActive` remains the
		// fallback for sessions with no recorded gate (fail-open).
		let hintToolActive = toolActive;
		if (sm) {
			try {
				const gated = toolActiveBySession.get(sm.getSessionId());
				if (gated !== undefined) hintToolActive = gated;
			} catch {
				// Stale ctx: keep the shared fallback.
			}
		}
		// Hint off everywhere: nothing can fire or re-arm.
		if (!hintToolActive || (rewindHintReserveTokens === null && hintByModel.size === 0)) {
			return;
		}
		let modelKey: string | undefined;
		if (hintByModel.size > 0) {
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
				rewindHintReserveTokens,
				rewindHintModelReserveTokens: hintByModel,
			},
			modelKey,
		);
		// During a fold or recovery a hint would be stale or push a second rewind.
		// The crossing stays
		// unspent for the next turn.
		if (event.message && typeof event.message === "object" && rewindTurns.has(event.message)) {
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
			hintTracker.observe(tokensLeft, reserve);
			return;
		}
		// Spent: skip the anchor walk below (it estimates every anchor).
		if (hintTracker.isSpent()) return;
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
		if (!hintTracker.observe(tokensLeft, reserve)) return;
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
			(toolActiveBySession.get(sessionId) ?? toolActive) === false ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			rewindTurns.has(message) ||
			overflowedTurns.has(message) ||
			queuedFolds.has(sessionId) ||
			runningFolds.has(sessionId) ||
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
					autoNavigate: autoNavigateBase,
					autoNavigateByModel,
					proposal: proposalConfig,
				},
				modelKey,
			);
		const config = structuredClone(currentConfig());
		if (!config.enabled) return;
		const signature = JSON.stringify(config);
		const capturedSource = capturedSystems.get(sessionId);
		const captured = structuredClone(capturedSource);
		const handoffMode = parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT;
		const reserve = resolveRewindHintReserve(
			{ rewindHintReserveTokens, rewindHintModelReserveTokens: hintByModel },
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
		let expectedState = autoFoldStateBySession.get(sessionId);
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
					capturedSystems.get(sessionId) === capturedSource &&
					JSON.stringify(capturedSource) === JSON.stringify(captured) &&
					(parentModes.get(sessionId) ?? PARENT_HANDOFF_MODE_DEFAULT) === handoffMode &&
					resolveRewindHintReserve(
						{
							rewindHintReserveTokens,
							rewindHintModelReserveTokens: hintByModel,
						},
						modelKey,
					) === reserve &&
					JSON.stringify(currentConfig()) === signature &&
					JSON.stringify(sm.getEntries()) === snapshot &&
					entries.every((entry) => sm.getLabel(entry.id) === labels.get(entry.id)) &&
					autoFoldStateBySession.get(sessionId) === expectedState &&
					(toolActiveBySession.get(sessionId) ?? toolActive) !== false &&
					!queuedFolds.has(sessionId) &&
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
			isCurrent: () => isCurrent() && !runningFolds.has(sessionId),
		});
		if (!isCurrent() || runningFolds.has(sessionId)) return;
		expectedState = plan.state;
		autoFoldStateBySession.set(sessionId, plan.state);
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
				runningFolds.has(sessionId) ||
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
			if (!isCurrent() || runningFolds.has(sessionId)) return;
			const request: FoldRequest = {
				sessionId,
				origin: "auto",
				rewindTo: selected.candidate.name,
				newLabel: selected.candidate.suggestedLabel,
				focus,
			};
			host.isIdle = isCurrent;
			host.foldPointId = cut.foldPointId;
			rewindTurns.add(message);
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
		runningFolds.add(sessionId);
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
			runningFolds.delete(sessionId);
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
		const config = consolidationConfig;
		if (
			!config.enabled ||
			(toolActiveBySession.get(sessionId) ?? toolActive) === false ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			queuedFolds.has(sessionId) ||
			runningFolds.has(sessionId) ||
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
					!queuedFolds.has(sessionId) &&
					!unrestoredFoldCursors.has(sm)
				);
			} catch {
				return false;
			}
		};
		runningFolds.add(sessionId);
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
			runningFolds.delete(sessionId);
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
				if (!continuityConfig.capture) {
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
	resetPrototype(): void {
		const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
		const orig = proto[ORIG_PROMPT_KEY];
		if (typeof orig === "function") {
			proto.prompt = orig;
			delete proto[ORIG_PROMPT_KEY];
		}
		sessionInstances.length = 0;
		// WeakSet has no .clear(); rebind to a fresh instance so a test that
		// re-captures the SAME session identity post-reset isn't deduped by
		// stale state from the previous test's capture.
		seenSessions = new WeakSet();
	},
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
	sessionRefCount(): number {
		return sessionInstances.length;
	},
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
