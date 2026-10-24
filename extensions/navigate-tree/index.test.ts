/**
 * Tests for navigate-tree dispatch + reflection bootstrap.
 *
 * Node test runner. Run with: pnpm test
 *
 * The pi extension loader treats `./index.ts` as the entry point and ignores
 * sibling files \u2014 so this test file is not loaded as a separate extension.
 *
 * Test architecture:
 *   - Each test gets a fresh in-memory SessionManager (no fs writes).
 *   - A minimal fake `ExtensionAPI` captures the registered tool and routes
 *     `setLabel` calls into `sm.appendLabelChange` so `sm.getLabel` reflects
 *     state set by the tool.
 *   - Tests that exercise reflection install a fake AgentSession-shaped
 *     object on the module-internal `sessionInstances` array via
 *     `__testHooks.captureSession` (the prototype patch is restored between
 *     tests via `__testHooks.resetPrototype()` in `afterEach`).
 *   - `rewind` queues an independent fold (fold engine): the tool call only
 *     returns "accepted"; tests then fire the registered `turn_end` handlers,
 *     exactly as the agent loop would, and the fold lands there. The summary
 *     is written by registry side calls, answered by a fake `modelRegistry`
 *     on the fake ctx.
 */

import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  type AssistantMessage,
  type ClassifierContext,
  type Context,
  createAssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  type AgentSession,
  buildSessionContext,
  CONFIG_DIR_NAME,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  START_ANCHOR_DEFAULT_TURNS,
  START_ANCHOR_MAX_TURNS,
  START_ANCHOR_MIN_TURNS,
  TREE_NAVIGATOR_CONFIG_FILENAME,
} from "./config.ts";
import {
  estimateContentTokens,
  estimateRequestTokens,
} from "./context-tokens.ts";
import { renderBriefing } from "./continuity-briefing.ts";
import {
  LEDGER_DETAILS_KEY,
  MAX_ITEM_TEXT_CHARS,
  parseLedger,
} from "./continuity-ledger.ts";
import {
  appendOpsEntry,
  CONTINUITY_OPS_CUSTOM_TYPE,
  readBranchLedger,
  type StoredOp,
} from "./continuity-store.ts";
import { DEFAULT_REDUCE_OUTPUT_TOKENS } from "./fold-summarizer.ts";
import { getHandoff, materializeHandoff } from "./handoff.ts";
import { formatPct1, MAX_NAME_LENGTH, TOOL_NAME } from "./helpers.ts";
import navigateTree, {
  __testHooks,
  ANCHOR_MANDATE,
  buildLateEntriesNote,
  buildRewindAcceptedText,
  buildRewindDoneText,
  CONTINUE_NUDGE_TEXT,
  commitFold,
  estimateAdmissionTokens,
  type FoldCommitInput,
  type FoldPreviewInput,
  foldPlaceholderSummary,
  foldRecommendationBudget,
  foldSummaryPlaceholderTokens,
  MAX_HINT_WALK_DEPTH,
  MAX_SESSION_REFS,
  MIN_REWIND_SAVINGS_TOKENS,
  MIN_SUMMARY_FOCUS_LENGTH,
  previewFoldCommit,
  priceFoldCandidates,
  REWIND_CUSTOM_TYPE,
  recommendFoldIndex,
  START_ANCHOR_LABEL,
  wrapPlainLine,
} from "./index.ts";
import {
  LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
  LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
} from "./legacy-rewind.ts";
import {
  buildNoAnchorText,
  buildReserveGuardWarning,
  buildReserveOrderWarning,
  buildRewindHintText,
  COMPACTION_FAILED_NO_ANCHOR,
  REWIND_COMPACTION_OFF_TEXT,
  REWIND_HINT_CUSTOM_TYPE,
} from "./rewind-hint.ts";
import { extractSummaryText } from "./summary-prompt.ts";

afterEach(() => {
  __testHooks.resetPrototype();
});

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
  [k: string]: unknown;
}

interface FakePi {
  pi: ExtensionAPI;
  setLabelCalls: Array<[string, string | undefined]>;
  registered: CapturedTool[];
  commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
  /** Captured `on(event, handler)` registrations, keyed by event name. */
  onCalls: Map<string, Array<(e: never, c: never) => unknown>>;
  /**
   * Raw argument arrays for every `sendMessage` call. Storing the full args
   * (not just the message object) is deliberate: the rewind hint's pinned
   * contract is a ONE-argument call (no options bag). Rewind messages never
   * go through `sendMessage`: they are `turn_end` boundary entries.
   */
  sendMessageCalls: unknown[][];
  /**
   * Raw argument arrays for every `sendUserMessage` call. Late input is
   * re-appended directly, never re-sent: tests pin this stays empty.
   */
  sendUserMessageCalls: unknown[][];
  /** Interleaved `sendMessage` / `sendUserMessage` call order. */
  sendLog: Array<"sendMessage" | "sendUserMessage">;
  /** Folded `turn_end` boundary results, one per `fireTurnEndAll`. */
  boundaryResults: BoundaryResult[];
  /** `appendEntry(customType, data)` calls (routed to `sm.appendCustomEntry`). */
  appendEntryCalls: Array<[string, unknown]>;
  /** `registerMessageRenderer` registrations, keyed by customType. */
  messageRenderers: Map<string, (...args: never[]) => unknown>;
  /** `registerEntryRenderer` registrations, keyed by customType. */
  entryRenderers: Map<string, (...args: never[]) => unknown>;
}

/**
 * A boundary entry draft (pi's `SessionBoundaryDraft` union, loosely typed):
 * `custom_message` (customType/content/display/details), `custom`
 * (customType/data), `context_edit` (targetId/replacement) or `compaction`.
 */
interface BoundaryDraft {
  type: string;
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown>;
  data?: Record<string, unknown>;
  targetId?: string;
  replacement?: { content: unknown } | null;
  summary?: string;
  firstKeptEntryId?: string | null;
}

/** The folded `turn_end` boundary result, as `emitBoundary` returns it. */
interface BoundaryResult {
  entries: BoundaryDraft[];
  continue: boolean;
}

/**
 * Build a minimal fake ExtensionAPI. `registerTool` captures the registered
 * tool definition; `setLabel` writes through to the SessionManager so
 * `sm.getLabel(...)` reflects the current state. Other methods throw on
 * access \u2014 the tool's `execute` only touches `setLabel`, so unknown calls
 * indicate a contract drift the tests want to surface.
 */
function makeFakePi(sm: SessionManager): FakePi {
  const setLabelCalls: Array<[string, string | undefined]> = [];
  const registered: CapturedTool[] = [];
  const commands: FakePi["commands"] = new Map();
  const onCalls = new Map<string, Array<(e: never, c: never) => unknown>>();
  const sendMessageCalls: unknown[][] = [];
  const sendUserMessageCalls: unknown[][] = [];
  const sendLog: FakePi["sendLog"] = [];
  const boundaryResults: BoundaryResult[] = [];
  const appendEntryCalls: Array<[string, unknown]> = [];
  const messageRenderers = new Map<string, (...args: never[]) => unknown>();
  const entryRenderers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      appendEntryCalls.push([customType, data]);
      sm.appendCustomEntry(customType, data);
    },
    registerMessageRenderer(
      customType: string,
      renderer: (...args: never[]) => unknown,
    ) {
      messageRenderers.set(customType, renderer);
    },
    registerEntryRenderer(
      customType: string,
      renderer: (...args: never[]) => unknown,
    ) {
      entryRenderers.set(customType, renderer);
    },
    registerTool(tool: CapturedTool) {
      registered.push(tool);
    },
    registerCommand(
      name: string,
      options: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      commands.set(name, options);
    },
    setLabel(entryId: string, label: string | undefined) {
      setLabelCalls.push([entryId, label]);
      // Route the label through the SessionManager so reads via
      // `sm.getLabel(...)` reflect the state the tool just set. Production
      // pi does this via the ExtensionRunner; in tests we shortcut.
      sm.appendLabelChange(entryId, label);
    },
    on(event: string, handler: (e: never, c: never) => unknown) {
      const list = onCalls.get(event) ?? [];
      list.push(handler);
      onCalls.set(event, list);
    },
    sendMessage(...args: unknown[]) {
      sendMessageCalls.push(args);
      sendLog.push("sendMessage");
    },
    sendUserMessage(...args: unknown[]) {
      sendUserMessageCalls.push(args);
      sendLog.push("sendUserMessage");
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    setLabelCalls,
    registered,
    onCalls,
    sendMessageCalls,
    sendUserMessageCalls,
    sendLog,
    boundaryResults,
    appendEntryCalls,
    messageRenderers,
    entryRenderers,
    commands,
  };
}

interface FakeCtx {
  sessionManager: SessionManager;
  model:
    | {
        api: string;
        provider: string;
        id: string;
        contextWindow?: number;
      }
    | undefined;
  /** UI availability as pi exposes it on the extension ctx. */
  hasUI: boolean;
  /** Current working directory (session_start derives the project config path). */
  cwd: string;
  /** Project-trust flag for the project config layer. */
  isProjectTrusted(): boolean;
  /** Captured `ui.notify` calls as `[message, type]`. */
  notifyCalls: Array<[string, "info" | "warning" | "error" | undefined]>;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  /** Context-usage probe (same shape as pi's `ctx.getContextUsage()`). */
  getContextUsage(): ContextUsage | undefined;
  /** Test-only setter driving `getContextUsage`. */
  setContextUsage(usage: ContextUsage | undefined): void;
  /** The current abort signal (pi: undefined when not streaming). */
  signal: AbortSignal | undefined;
  /** The registry a fold's side calls go through (see `fakeRegistry`). */
  modelRegistry: ReturnType<typeof fakeRegistry>["registry"];
  /** Every side call the default registry saw. */
  registryCalls: RegistryCall[];
}

function makeCtx(
  sm: SessionManager,
  opts: {
    contextWindow?: number;
    noModel?: boolean;
    hasUI?: boolean;
    cwd?: string;
    projectTrusted?: boolean;
    contextUsage?: ContextUsage;
  } = {},
): FakeCtx {
  const model = opts.noModel
    ? undefined
    : {
        api: "anthropic",
        provider: "claude",
        id: "claude-sonnet-4-5",
        contextWindow: opts.contextWindow ?? 1_000_000,
      };
  let usage = opts.contextUsage;
  const notifyCalls: Array<[string, "info" | "warning" | "error" | undefined]> =
    [];
  const registry = fakeRegistry();
  return {
    modelRegistry: registry.registry,
    registryCalls: registry.calls,
    sessionManager: sm,
    model,
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd ?? "/tmp",
    isProjectTrusted: () => opts.projectTrusted ?? false,
    notifyCalls,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifyCalls.push([message, type]);
      },
    },
    getContextUsage: () => usage,
    setContextUsage(next: ContextUsage | undefined) {
      usage = next;
      // pi derives its usage from the session: record the measurement the
      // extension's own estimate reads.
      if (next?.tokens) {
        sm.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "measured" }],
          api: "anthropic",
          provider: "claude",
          model: "claude-sonnet-4-5",
          stopReason: "endTurn",
          timestamp: Date.now(),
          usage: usageOf(next.tokens),
        } as never);
      }
    },
    signal: undefined,
  };
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

function usageOf(totalTokens: number) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: ZERO_COST,
  };
}

/**
 * Append a complete user/assistant turn so the chain has a labelable assistant
 * leaf with usage. Returns the assistant entry id so the caller can label it.
 */
function appendTurn(
  sm: SessionManager,
  userText: string,
  assistantText: string,
  totalTokens = 100,
  recordWork = false,
): { userId: string; assistantId: string } {
  const userId = sm.appendMessage({
    role: "user",
    content: [
      { type: "text", text: userText },
      ...(recordWork
        ? [{ type: "text", text: "Recorded work and evidence.\n".repeat(1200) }]
        : []),
    ],
  } as never);
  const assistantId = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
    api: "anthropic",
    provider: "claude",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: usageOf(totalTokens),
  } as never);
  return { userId, assistantId };
}

/** An assistant message as the agent loop hands it to `turn_end`. */
type AssistantTurn = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  stopReason: string;
  [k: string]: unknown;
};

function assistantMessage(
  content: Array<Record<string, unknown>>,
  stopReason: string,
  totalTokens = 0,
): AssistantTurn {
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "claude",
    model: "claude-sonnet-4-5",
    stopReason,
    timestamp: Date.now(),
    usage: usageOf(totalTokens),
  };
}

/**
 * Append an assistant message declaring tool calls (each with `arguments`),
 * the shape the model emits for the rewind call itself or for a blocked
 * forced attempt. Returns the appended message (for `turn_end`) and its id.
 */
function appendToolCallAssistant(
  sm: SessionManager,
  toolCalls: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
  }>,
  totalTokens = 30_000,
): { id: string; message: AssistantTurn } {
  const message = assistantMessage(
    toolCalls.map((tc) => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments ?? { action: "rewind" },
    })),
    "toolUse",
    totalTokens,
  );
  return { id: sm.appendMessage(message as never), message };
}

/** Append the tool_result pi records after a tool's `execute` returns. */
function appendToolResult(
  sm: SessionManager,
  toolCallId: string,
  toolName: string,
  text: string,
  details: unknown = {},
): string {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp: Date.now(),
  } as never);
}

/** Canonical well-formed summary text (r5d headings). */
const SUMMARY_TEXT =
  "## Goal\nTest the rewind happy path.\n\n## Progress\n### Done\n- [x] Appended turns.\n\n## Next Steps\n1. Verify the branch_summary.";

interface RegistryCall {
  model: unknown;
  context: Context;
  options: SimpleStreamOptions;
}

function reply(
  text: string,
  stopReason: "stop" | "error" | "aborted" = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "claude",
    model: "claude-sonnet-4-5",
    stopReason,
    errorMessage,
    timestamp: Date.now(),
    usage: usageOf(10),
  } as unknown as AssistantMessage;
}

/** A fake `modelRegistry` recording every side call; `respond` scripts the answer. */
function fakeRegistry(
  respond: (
    call: RegistryCall,
    index: number,
  ) => AssistantMessage | Promise<AssistantMessage> = () => reply(SUMMARY_TEXT),
) {
  const calls: RegistryCall[] = [];
  const registry = {
    hasConfiguredAuth: () => true,
    streamSimple(
      model: unknown,
      context: Context,
      options: SimpleStreamOptions,
    ) {
      const call = { model, context, options };
      const index = calls.push(call) - 1;
      const stream = createAssistantMessageEventStream();
      void Promise.resolve(respond(call, index)).then((message) =>
        stream.end(message),
      );
      return stream;
    },
  };
  return { calls, registry };
}

/**
 * Register the navigate-tree tool against a fresh fake pi + SessionManager
 * and return the captured tool plus the helpers tests need.
 */
function setup(opts: { contextWindow?: number; noModel?: boolean } = {}): {
  sm: SessionManager;
  pi: FakePi;
  ctx: FakeCtx;
  tool: CapturedTool;
} {
  const sm = SessionManager.inMemory("/tmp");
  const pi = makeFakePi(sm);
  navigateTree(pi.pi);
  assert.equal(pi.registered.length, 1);
  const tool = pi.registered[0];
  const ctx = makeCtx(sm, opts);
  return { sm, pi, ctx, tool };
}

/**
 * Build a fake AgentSession-shaped object with the mutable `agent.state`
 * surface the reflection bootstrap touches. Cast through unknown so the test
 * doesn't depend on every field of the real class.
 */
interface FakeAgentSession {
  sessionManager: SessionManager;
  agent: {
    state: { systemPrompt: string; messages: unknown[]; tools: unknown[] };
    prepareNextTurn?: unknown;
    prepareNextTurnWithContext?: unknown;
  };
  /** Plain field on `AgentSession`; the rewind emits `session_tree` on it (#79). */
  _extensionRunner?: { emit?: (event: unknown) => Promise<unknown> | unknown };
}

function makeFakeSession(sm: SessionManager): FakeAgentSession {
  return {
    sessionManager: sm,
    agent: {
      state: { systemPrompt: "SYSTEM", messages: [], tools: [] },
      prepareNextTurn: undefined,
      prepareNextTurnWithContext: undefined,
    },
  };
}

/**
 * Build the canonical rewindable fixture: an anchored first assistant turn
 * plus N follow-up turns (default 3) whose cumulative usage totals grow well
 * past MIN_REWIND_SAVINGS_TOKENS above the anchor (the #21 floor rejects
 * sub-floor rewinds, so every successful-rewind fixture must clear it),
 * optionally with a captured AgentSession so the reflection bootstrap finds
 * it.
 */
function setupRewindable(
  sm: SessionManager,
  pi: FakePi,
  opts: {
    capture?: boolean;
    turnsAfter?: number;
    rewindToName?: string;
    tokenCounts?: number[];
  } = {},
): { fake?: FakeAgentSession; anchorId: string } {
  const rewindToName = opts.rewindToName ?? "start";
  const turnsAfter = opts.turnsAfter ?? 3;
  const tokenCounts = opts.tokenCounts ?? [
    6_000, 12_000, 18_000, 24_000, 30_000,
  ];
  const t1 = appendTurn(sm, "u1", "a1", tokenCounts[0]);
  pi.pi.setLabel(t1.assistantId, `anchor:${rewindToName}`);
  for (let i = 0; i < turnsAfter; i++) {
    appendTurn(sm, `u${i + 2}`, `a${i + 2}`, tokenCounts[i + 1] ?? 100, true);
  }
  if (opts.capture) {
    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);
    return { fake, anchorId: t1.assistantId };
  }
  return { anchorId: t1.assistantId };
}

/**
 * `setupRewindable` with a folded span of assistant turns only: no user
 * message between the anchor and the leaf (autonomous work).
 */
function setupAutonomousSpan(
  sm: SessionManager,
  pi: FakePi,
  tokenCounts = [12_000, 18_000, 24_000],
): { anchorId: string } {
  const first = appendTurn(sm, "u1", "a1", 6_000);
  pi.pi.setLabel(first.assistantId, "anchor:start");
  for (const totalTokens of tokenCounts) {
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Recorded work and evidence.\n".repeat(1200) },
      ],
      api: "anthropic",
      provider: "claude",
      model: "claude-sonnet-4-5",
      stopReason: "endTurn",
      timestamp: Date.now(),
      usage: usageOf(totalTokens),
    } as never);
  }
  return { anchorId: first.assistantId };
}

// -----------------------------------------------------------------------------
// Rewind drivers
// -----------------------------------------------------------------------------

/**
 * Commit boundary drafts the way pi's `_commitBoundaryDrafts` does: all or
 * nothing. pi previews the whole list (`runner.emitBoundary` →
 * `buildContext`), and a `context_edit` whose target is off the active
 * branch invalidates it, dropping every draft. Returns false when dropped.
 */
function commitBoundaryDrafts(
  sm: SessionManager,
  drafts: readonly BoundaryDraft[],
): boolean {
  let onBranch: Set<string>;
  try {
    onBranch = new Set(sm.getBranch().map((e) => e.id));
  } catch {
    return false;
  }
  if (
    drafts.some(
      (d) => d.type === "context_edit" && !onBranch.has(d.targetId ?? ""),
    )
  ) {
    return false;
  }
  for (const draft of drafts) {
    switch (draft.type) {
      case "custom_message":
        sm.appendCustomMessageEntry(
          draft.customType,
          draft.content,
          draft.display,
          draft.details,
        );
        break;
      case "custom":
        sm.appendCustomEntry(draft.customType, draft.data);
        break;
      case "context_edit":
        sm.appendContextEdit(
          draft.targetId as string,
          (draft.replacement ?? null) as never,
        );
        break;
      case "compaction":
        sm.appendCompaction(
          draft.summary ?? "",
          (draft.firstKeptEntryId ?? null) as never,
          0,
          draft.details,
          true,
        );
        break;
    }
  }
  return true;
}

/**
 * The turn's persisted entry ids, as pi resolves them for `turn_end`: the
 * assistant's entry (`messageEntryId`) and the tool results that follow it
 * on the branch (`toolResults` / `toolResultEntryIds`).
 */
function resolveTurnEntries(
  sm: SessionManager,
  message: unknown,
): {
  messageEntryId: string | undefined;
  toolResults: unknown[];
  toolResultEntryIds: string[];
} {
  let branch: ReturnType<SessionManager["getBranch"]>;
  try {
    branch = sm.getBranch();
  } catch {
    // A test that stubs getBranch to throw drives the handlers anyway.
    branch = [];
  }
  const index = branch.findIndex(
    (e) => e.type === "message" && (e.message as unknown) === message,
  );
  if (index < 0) {
    return {
      messageEntryId: undefined,
      toolResults: [],
      toolResultEntryIds: [],
    };
  }
  const toolResults: unknown[] = [];
  const toolResultEntryIds: string[] = [];
  for (const entry of branch.slice(index + 1)) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") break;
    toolResults.push(entry.message);
    toolResultEntryIds.push(entry.id);
  }
  return { messageEntryId: branch[index].id, toolResults, toolResultEntryIds };
}

/**
 * Fold boundary handlers exactly as pi's `ExtensionRunner.emitBoundary`
 * does: every handler sees the running `{ entries, continue }`, and a result
 * carrying `entries` / `continue` replaces it. Then commit the drafts
 * all-or-nothing (pi's `_commitBoundaryDrafts`); an invalid list folds to
 * `{ entries: [], continue: false }` like pi's preview failure.
 */
async function foldBoundary(
  handlers: Array<(e: never, c: never) => unknown>,
  ctx: FakeCtx,
  base: Record<string, unknown>,
  opts: { entries?: BoundaryDraft[]; continue?: boolean; commit?: boolean },
): Promise<BoundaryResult> {
  let entries = opts.entries ?? [];
  let shouldContinue = opts.continue ?? false;
  for (const handler of handlers) {
    const result = (await handler(
      { ...base, entries, continue: shouldContinue } as never,
      ctx as never,
    )) as { entries?: BoundaryDraft[]; continue?: boolean } | undefined;
    if (result?.entries !== undefined) entries = result.entries;
    if (result?.continue !== undefined) shouldContinue = result.continue;
  }
  if (opts.commit === false) return { entries, continue: shouldContinue };
  if (!commitBoundaryDrafts(ctx.sessionManager, entries)) {
    return { entries: [], continue: false };
  }
  return { entries, continue: shouldContinue };
}

/**
 * Fire every registered `turn_end` handler in registration order, awaiting
 * each, with the event fields pi passes (`messageEntryId`, `toolResults`,
 * `toolResultEntryIds`, `outcome`), and fold + commit their results (see
 * `foldBoundary`). The folded result is returned and recorded on
 * `pi.boundaryResults`. `entries` seeds the list (another extension's drafts
 * earlier in the chain). `commit: false` skips pi's commit. `turnIndex`
 * defaults to 0 so the auto start-anchor (default X=2) stays out of the way.
 */
async function fireTurnEndAll(
  pi: FakePi,
  ctx: FakeCtx,
  message: unknown,
  opts: {
    turnIndex?: number;
    entries?: BoundaryDraft[];
    continue?: boolean;
    commit?: boolean;
    messageEntryId?: string;
  } = {},
): Promise<BoundaryResult> {
  const handlers = pi.onCalls.get("turn_end");
  assert.ok(handlers, "factory must register turn_end handlers");
  const resolved = resolveTurnEntries(ctx.sessionManager, message);
  const stopReason = (message as { stopReason?: string } | undefined)
    ?.stopReason;
  const folded = await foldBoundary(
    handlers,
    ctx,
    {
      type: "turn_end",
      turnIndex: opts.turnIndex ?? 0,
      message,
      toolResults: resolved.toolResults,
      messageEntryId: opts.messageEntryId ?? resolved.messageEntryId,
      toolResultEntryIds: resolved.toolResultEntryIds,
      outcome:
        stopReason === "aborted"
          ? "aborted"
          : stopReason === "error"
            ? "error"
            : "completed",
    },
    opts,
  );
  pi.boundaryResults.push(folded);
  return folded;
}

/** Fire every `agent_before_settle` handler (a boundary, folded + committed). */
async function fireAgentBeforeSettle(
  pi: FakePi,
  ctx: FakeCtx,
  opts: {
    outcome?: "completed" | "aborted" | "error";
    continue?: boolean;
    entries?: BoundaryDraft[];
    commit?: boolean;
  } = {},
): Promise<BoundaryResult> {
  const handlers = pi.onCalls.get("agent_before_settle") ?? [];
  const folded = await foldBoundary(
    handlers,
    ctx,
    { type: "agent_before_settle", outcome: opts.outcome ?? "completed" },
    opts,
  );
  pi.boundaryResults.push(folded);
  return folded;
}

/** Fire every `agent_settled` handler. */
async function fireAgentSettled(
  pi: FakePi,
  ctx: FakeCtx,
  aborted = false,
): Promise<void> {
  for (const handler of pi.onCalls.get("agent_settled") ?? []) {
    await handler({ type: "agent_settled", aborted } as never, ctx as never);
  }
}

/** Fire the `context` handler and return the messages it would send. */
function fireContext(pi: FakePi, ctx: FakeCtx): Array<Record<string, unknown>> {
  const handlers = pi.onCalls.get("context");
  assert.ok(handlers, "factory must register a context handler");
  assert.equal(handlers.length, 1);
  const result = handlers[0](
    { type: "context", messages: [] } as never,
    ctx as never,
  ) as { messages: Array<Record<string, unknown>> };
  return result.messages;
}

/** Fire the `tool_call` gate for a tool call in `ctx`'s session. */
function fireToolCall(
  pi: FakePi,
  ctx: FakeCtx,
  toolName = "bash",
  input: Record<string, unknown> = { command: "true" },
): unknown {
  const handlers = pi.onCalls.get("tool_call") ?? [];
  for (const handler of handlers) {
    const result = handler(
      { type: "tool_call", toolCallId: "tc-gate", toolName, input } as never,
      ctx as never,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

const REWIND_ARGS = {
  action: "rewind",
  rewindTo: "start",
  newLabel: "end",
  summaryFocus: "Preserve user instructions and continue.",
} as const;

/**
 * The rewind call exactly as the agent loop runs it: the model's assistant
 * turn declaring the call is persisted, `execute` queues the fold, pi
 * persists the tool_result, and the turn ends. The fold lands inside that
 * `turn_end`; `leafBeforeFold` is the abandoned branch's last entry.
 */
async function requestRewind(
  f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx; tool: CapturedTool },
  args: Record<string, unknown> = REWIND_ARGS,
  toolCallId = "tc-rewind",
  totalTokens?: number,
  turn: {
    entries?: BoundaryDraft[];
    commit?: boolean;
    turnIndex?: number;
  } = {},
) {
  const call = appendToolCallAssistant(
    f.sm,
    [{ id: toolCallId, name: TOOL_NAME, arguments: args }],
    totalTokens,
  );
  const result = await f.tool.execute(
    toolCallId,
    args,
    undefined,
    undefined,
    f.ctx,
  );
  appendToolResult(
    f.sm,
    toolCallId,
    TOOL_NAME,
    result.content[0].text,
    result.details,
  );
  const leafBeforeFold = f.sm.getLeafId() as string;
  const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message, turn);
  return { result, callId: call.id, boundary, leafBeforeFold };
}

/**
 * Rewind messages delivered as `turn_end` boundary entries, oldest first,
 * each with its boundary's folded `continue`. Also pins that no rewind
 * message ever goes through `pi.sendMessage`.
 */
function rewindMessages(
  pi: FakePi,
): Array<{ message: BoundaryDraft; continue: boolean }> {
  assert.ok(
    !pi.sendMessageCalls.some(
      (args) =>
        (args[0] as { customType?: string } | undefined)?.customType ===
        REWIND_CUSTOM_TYPE,
    ),
    "rewind messages must be boundary entries, never pi.sendMessage",
  );
  return pi.boundaryResults.flatMap((result) =>
    result.entries
      .filter((draft) => draft.customType === REWIND_CUSTOM_TYPE)
      .map((message) => ({ message, continue: result.continue })),
  );
}

/** Ids hidden (last `context_edit` null) on the active branch. */
function hiddenIds(sm: SessionManager): Set<string> {
  const last = new Map<string, unknown>();
  for (const e of sm.getBranch()) {
    if (e.type === "context_edit") last.set(e.targetId, e.replacement);
  }
  return new Set([...last].filter(([, r]) => r === null).map(([id]) => id));
}

async function configureParentMode(
  f: ReturnType<typeof setup>,
  mode: "full" | "digest",
) {
  const fixture = makeConfigFixture();
  try {
    writeGlobalConfig(fixture, JSON.stringify({ parentHandoffMode: mode }));
    await runSessionStart(f.pi, f.ctx, fixture);
  } finally {
    cleanupConfigFixture(fixture);
  }
}

/**
 * Full rewind: canonical fixture and the rewind call, whose fold lands at its
 * `turn_end`. Returns the fixture plus the call's result and the continuation
 * message.
 */
async function rewindFixture(
  opts: { capture?: boolean; summary?: string; mode?: "full" | "digest" } = {},
) {
  const f = setup();
  if (opts.mode) await configureParentMode(f, opts.mode);
  if (opts.summary !== undefined) {
    const summary = opts.summary;
    f.ctx.modelRegistry = fakeRegistry(() => reply(summary)).registry;
  }
  const { fake, anchorId } = setupRewindable(f.sm, f.pi, {
    capture: opts.capture ?? true,
  });
  const oldLeafBeforeCall = f.sm.getLeafId();
  const { result, leafBeforeFold } = await requestRewind(f);
  const messages = rewindMessages(f.pi);
  return {
    ...f,
    fake,
    anchorId,
    result,
    oldLeafBeforeCall,
    leafBeforeFold,
    done: messages[messages.length - 1],
  };
}

// =============================================================================
// context event handler
//
// The public `context` extension event (wired to pi's `Agent.transformContext`
// → `runner.emitContext`) is the replacement for the deleted
// `prepareNextTurn` double-wrap. It fires before EVERY LLM call with the
// session-tree projection; these pins cover the registration, the projection
// shape, and the post-rewind invariant (the README's headline feature).
// =============================================================================

/**
 * pi-ai's own `estimateContextTokens` (#101). The package root does not export
 * it and the exports map blocks subpaths, so resolve the file beside the entry.
 */
async function piAiEstimateContextTokens(messages: unknown[]) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const { estimateContextTokens } = await import(
    new URL("./utils/estimate.js", entry).href
  );
  return estimateContextTokens(messages) as {
    tokens: number;
    usageTokens: number;
    trailingTokens: number;
    lastUsageIndex: number | null;
  };
}

describe("context event handler", () => {
  it("registers exactly one context handler via pi.on", () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("context");
    assert.ok(handlers, "factory must register a context handler");
    assert.equal(handlers.length, 1);
  });

  it("buildContextMessages projects the active branch (leaf-relative, no args)", () => {
    // The deleted wrapper rebuilt messages from buildSessionContext() every
    // turn; the context handler must produce the same projection from the
    // PUBLIC ReadonlySessionManager surface (buildContextEntries is exposed,
    // buildSessionContext is not). Pin the projection equals the session
    // context's messages on a plain chain.
    const { sm } = setup();
    appendTurn(sm, "u1", "a1", 100);
    appendTurn(sm, "u2", "a2", 200);
    const projected = __testHooks.buildContextMessages(sm);
    assert.deepEqual(
      projected,
      sm
        .buildSessionContext()
        .messages.filter((message) => message.role !== "system"),
    );
  });

  it("buildContextMessages is conversation-only (Pi re-attaches the head)", () => {
    // `context` handlers transform conversation messages only; the runner
    // filters system state out before the handler and re-attaches the current
    // head afterwards. Returning a projection that still carries the
    // persisted system entry would duplicate the head whenever
    // `forceSystemPrompt` is unset.
    const { sm } = setup();
    sm.appendMessage({ role: "system", content: "PERSISTED HEAD" } as never);
    appendTurn(sm, "u1", "a1", 100);
    const projected = __testHooks.buildContextMessages(sm);
    assert.ok(
      projected.every((message) => message.role !== "system"),
      "the context payload must not carry system messages",
    );
    assert.ok(
      sm.buildSessionContext().messages.some((m) => m.role === "system"),
      "the raw session context still contains the persisted system entry",
    );
  });

  it("buildContextMessages applies context_edit omissions (projection beats raw entries)", () => {
    const { sm } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 100);
    appendTurn(sm, "u2", "a2", 200);
    // pi's overflow recovery and the fallback provider omit failed attempts
    // with a null-replacement context_edit. The wire projection must drop
    // the message; the raw buildContextEntries walk would reintroduce it.
    sm.appendContextEdit(t1.assistantId, null);
    const projected = __testHooks.buildContextMessages(sm);
    assert.ok(
      !projected.some((message) => JSON.stringify(message).includes("a1")),
      "the omitted assistant must not be reintroduced",
    );
    assert.ok(
      sm.buildContextEntries().some((entry) => entry.id === t1.assistantId),
      "the raw entry walk still contains the omitted entry",
    );
    assert.equal(projected.length, sm.buildSessionContext().messages.length);
  });

  it("projects active-branch legacy rewind failures and aborts without mutating results", () => {
    const { sm } = setup();
    const resultId = appendToolResult(
      sm,
      "legacy-rewind-call",
      TOOL_NAME,
      "Rewind accepted.",
    );
    const failure = "Summarization failed: the branch could not be written.";
    sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
      status: "failed",
      toolResultEntryId: resultId,
      text: failure,
    });
    const abortedResultId = appendToolResult(
      sm,
      "legacy-aborted-rewind-call",
      TOOL_NAME,
      "Rewind accepted.",
    );
    const aborted = "The historical rewind was aborted.";
    sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
      status: "aborted",
      toolResultEntryId: abortedResultId,
      text: aborted,
    });
    sm.appendCustomMessageEntry(
      LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
      "Historical summary instruction must remain hidden.",
      true,
    );

    const original = sm.getEntry(resultId);
    const originalAborted = sm.getEntry(abortedResultId);
    assert.ok(original?.type === "message");
    assert.ok(originalAborted?.type === "message");
    const originalMessage = structuredClone(original.message);
    const originalAbortedMessage = structuredClone(originalAborted.message);
    assert.equal(original.message.role, "toolResult");
    assert.equal(original.message.isError, false);
    assert.equal(originalAborted.message.role, "toolResult");
    assert.equal(originalAborted.message.isError, false);

    const projected = __testHooks.buildContextMessages(sm);
    const results = projected.filter(
      (message) => message.role === "toolResult",
    );
    assert.deepEqual(
      results.map((message) => ({
        isError: message.isError,
        content: message.content,
      })),
      [
        { isError: true, content: [{ type: "text", text: failure }] },
        { isError: true, content: [{ type: "text", text: aborted }] },
      ],
    );
    assert.ok(
      !JSON.stringify(projected).includes("Historical summary instruction"),
      "legacy summary requests remain hidden from model context",
    );
    assert.deepEqual(original.message, originalMessage);
    assert.deepEqual(originalAborted.message, originalAbortedMessage);
  });

  it("ignores legacy rewind outcomes on an abandoned branch", () => {
    const { sm } = setup();
    const resultId = appendToolResult(
      sm,
      "legacy-rewind-call",
      TOOL_NAME,
      "Rewind accepted.",
    );
    const outcomeId = sm.appendCustomEntry(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, {
      status: "failed",
      toolResultEntryId: resultId,
      text: "failure from an abandoned attempt",
    });
    sm.branch(resultId);
    assert.ok(!sm.getBranch().some((entry) => entry.id === outcomeId));

    const projected = __testHooks.buildContextMessages(sm);
    const result = projected.find((message) => message.role === "toolResult");
    assert.ok(result);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [
      { type: "text", text: "Rewind accepted." },
    ]);
  });

  it("withheld results zero the usage of the assistants after them (#101)", async () => {
    // pi's output clamp sizes max_tokens from the last assistant usage. That
    // usage still counts the withheld result, so the clamp saw no room and
    // capped the reply at 1 token (a false overflow). The assistant before
    // the result counted only earlier content, so its usage stays exact.
    const { sm } = setup();
    const at = Date.now();
    const model = {
      api: "anthropic",
      provider: "claude",
      model: "claude-sonnet-4-5",
    };
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "read it" }],
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      ...model,
      stopReason: "toolUse",
      timestamp: at,
      usage: usageOf(10),
    } as never);
    const resultId = sm.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(40_000) }],
      isError: false,
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "next" }],
      ...model,
      stopReason: "endTurn",
      timestamp: at,
      usage: usageOf(90_000),
    } as never);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "go on" }],
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      ...model,
      stopReason: "endTurn",
      timestamp: at,
      usage: usageOf(95_000),
    } as never);
    sm.appendContextEdit(resultId, {
      content: [{ type: "text", text: "[navigate_tree] Output withheld" }],
    } as never);

    const projected = __testHooks.buildContextMessages(sm);
    assert.deepEqual(
      projected.flatMap((m) =>
        m.role === "assistant" ? [m.usage.totalTokens] : [],
      ),
      [10, 0, 0],
    );
    // pi-ai falls back to the exact usage before the edit, and the rest is
    // chars/3.5: the notice and two short messages, not the stale 95k.
    const estimate = await piAiEstimateContextTokens(projected);
    assert.equal(estimate.lastUsageIndex, 1);
    assert.equal(estimate.usageTokens, 10);
    assert.ok(
      estimate.trailingTokens < 1_000,
      `trailing estimate should be chars/3.5, got ${estimate.trailingTokens}`,
    );
    // The session's own objects are untouched (the clone is per request).
    assert.deepEqual(
      sm
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "assistant"
            ? [entry.message.usage.totalTokens]
            : [],
        ),
      [10, 90_000, 95_000],
    );
  });

  it("an assistant produced after the edit keeps its exact usage (#101)", async () => {
    // The edit applied before this turn was sent, so its usage counts only the
    // edited context and is exact. Only the turn between target and edit is
    // stale.
    const { sm } = setup();
    const at = Date.now();
    const model = {
      api: "anthropic",
      provider: "claude",
      model: "claude-sonnet-4-5",
    };
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "read it" }],
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      ...model,
      stopReason: "toolUse",
      timestamp: at,
      usage: usageOf(10),
    } as never);
    const resultId = sm.appendMessage({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(40_000) }],
      isError: false,
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "next" }],
      ...model,
      stopReason: "endTurn",
      timestamp: at,
      usage: usageOf(90_000),
    } as never);
    sm.appendContextEdit(resultId, {
      content: [{ type: "text", text: "[navigate_tree] Output withheld" }],
    } as never);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "go on" }],
      timestamp: at,
    } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      ...model,
      stopReason: "endTurn",
      timestamp: at,
      usage: usageOf(5_000),
    } as never);

    const projected = __testHooks.buildContextMessages(sm);
    assert.deepEqual(
      projected.flatMap((m) =>
        m.role === "assistant" ? [m.usage.totalTokens] : [],
      ),
      [10, 0, 5_000],
    );
    // pi-ai anchors on the newest assistant, the one sent after the edit.
    const estimate = await piAiEstimateContextTokens(projected);
    assert.equal(estimate.lastUsageIndex, projected.length - 1);
    assert.equal(estimate.usageTokens, 5_000);
  });

  it("without context_edits the projection keeps every assistant's usage (#101)", () => {
    const { sm } = setup();
    appendTurn(sm, "u1", "a1", 100);
    appendTurn(sm, "u2", "a2", 90_000);
    const projected = __testHooks.buildContextMessages(sm);
    assert.deepEqual(
      projected,
      sm
        .buildSessionContext()
        .messages.filter((message) => message.role !== "system"),
    );
    assert.deepEqual(
      projected.flatMap((m) =>
        m.role === "assistant" ? [m.usage.totalTokens] : [],
      ),
      [100, 90_000],
    );
  });

  it("handler returns messages = tree projection on every call (no leaf-gating)", () => {
    // R7: every appendMessage advances the leaf, so a "leaf changed since
    // last turn" heuristic would fire on essentially every call. Always-
    // replace degenerates to exactly what the deleted wrapper did. Fire the
    // captured handler twice with no tree change in between — both must
    // return the same projection (no pass-through case exists to pin, but
    // this guards against a future conditional reintroducing gating).
    const { sm, pi } = setup();
    appendTurn(sm, "u1", "a1", 100);
    const handlers = pi.onCalls.get("context");
    assert.ok(handlers, "factory must register a context handler");
    const first = handlers[0](
      { type: "context", messages: [] } as never,
      { sessionManager: sm } as never,
    );
    const second = handlers[0](
      { type: "context", messages: [] } as never,
      { sessionManager: sm } as never,
    );
    assert.deepEqual(first, second);
    assert.deepEqual(
      (first as { messages: unknown[] }).messages,
      sm.buildSessionContext().messages,
    );
  });

  it("post-rewind: handler returns anchor chain + branch_summary + continuation, none of the abandoned segment", async () => {
    // The headline invariant (#80 shape): after the fold lands, the next LLM
    // call (the very next context event) must see the chain up to the
    // anchor, the branch_summary, and the continuation message — and none of
    // the collapsed turns, the rewind tool call or its result (all on the
    // abandoned branch).
    const f = await rewindFixture();
    assert.ok(f.done, "the rewind must deliver its continuation message");

    const handlers = f.pi.onCalls.get("context");
    assert.ok(handlers, "factory must register a context handler");
    const outcome = handlers[0](
      { type: "context", messages: [] } as never,
      { sessionManager: f.sm } as never,
    ) as {
      messages: Array<{
        role: string;
        customType?: string;
        summary?: string;
        content?: unknown;
      }>;
    };
    const messages = outcome.messages;
    const json = JSON.stringify(messages);

    // Ends with branch_summary then the continuation.
    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];
    assert.equal(prev.role, "custom");
    assert.equal(prev.customType, "navigate-tree-handoff");
    assert.equal(
      prev.content,
      `# Work handoff: end\n\n${SUMMARY_TEXT}`,
      "the projected summary is the stored text",
    );
    assert.equal(last.role, "custom");
    assert.equal(last.customType, REWIND_CUSTOM_TYPE);
    assert.equal(last.content, f.done.message.content);

    // Anchor turn retained; collapsed turns, the rewind call and its result
    // are gone.
    assert.ok(json.includes('"a1"'), "the anchor turn is retained");
    for (const gone of ['"a2"', '"a3"', '"a4"', "tc-rewind"]) {
      assert.ok(
        !json.includes(gone),
        `${gone} must be on the abandoned branch`,
      );
    }
    assert.ok(
      !messages.some(
        (m) => m.role === "assistant" && JSON.stringify(m).includes("## Goal"),
      ),
      "the summary text is not replayed as an assistant message",
    );
    assert.ok(
      !messages.some((m) => m.role === "toolResult"),
      "no tool_result survives on the rewound chain",
    );

    // idempotent: a second invocation with no tree change returns the same.
    const again = handlers[0](
      { type: "context", messages: [] } as never,
      { sessionManager: f.sm } as never,
    );
    assert.deepEqual(again, outcome);
  });
});

// =============================================================================
// before_agent_start anchor mandate (#31)
//
// The #29 `promptGuidelines` bullet landed mid-prompt (inside the Guidelines
// section) and did not move behavior. #31 moves the policy to a
// `before_agent_start` append, which lands at the very END of the system
// prompt (after <project_context> and skills), is re-applied on every prompt,
// and survives compaction. These pins cover registration, the append shape
// (with the approved mandate spelled as a literal), the active-tool gate,
// fail-open semantics, and byte-stability for prompt caching.
// =============================================================================

describe("before_agent_start anchor mandate", () => {
  it("registers exactly one before_agent_start handler via pi.on", () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("before_agent_start");
    assert.ok(handlers, "factory must register a before_agent_start handler");
    assert.equal(handlers.length, 1);
  });

  it("appends the approved mandate to the system prompt when the tool is active", async () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("before_agent_start");
    assert.ok(handlers, "factory must register a before_agent_start handler");
    const out = await handlers[0](
      {
        type: "before_agent_start",
        prompt: "do the thing",
        systemPrompt: "BASE",
        systemPromptOptions: {
          selectedTools: ["read", "bash", "navigate_tree"],
        },
      } as never,
      {} as never,
    );
    assert.deepEqual(out, {
      systemPrompt:
        "BASE\n\nnavigate_tree: gather all context, then anchor `context-gathered`; list anchors and rewind after every milestone or rabbit hole / dead end to keep context low.",
    });
  });

  it("skips the append when the tool is verifiably absent from selectedTools", async () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("before_agent_start");
    assert.ok(handlers, "factory must register a before_agent_start handler");
    const out = await handlers[0](
      {
        type: "before_agent_start",
        prompt: "do the thing",
        systemPrompt: "BASE",
        systemPromptOptions: { selectedTools: ["read", "bash"] },
      } as never,
      {} as never,
    );
    assert.deepEqual(out, {});
  });

  it("fails open when selectedTools is undefined (mandate still appended)", async () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("before_agent_start");
    assert.ok(handlers, "factory must register a before_agent_start handler");
    const out = await handlers[0](
      {
        type: "before_agent_start",
        prompt: "do the thing",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      } as never,
      {} as never,
    );
    assert.deepEqual(out, { systemPrompt: `BASE\n\n${ANCHOR_MANDATE}` });
  });

  it("is byte-stable across identical calls (prompt-caching contract)", async () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("before_agent_start");
    assert.ok(handlers, "factory must register a before_agent_start handler");
    const event = {
      type: "before_agent_start",
      prompt: "do the thing",
      systemPrompt: "BASE",
      systemPromptOptions: {
        selectedTools: ["read", "bash", "navigate_tree"],
      },
    } as never;
    const first = (await handlers[0](event, {} as never)) as {
      systemPrompt: string;
    };
    const second = (await handlers[0](event, {} as never)) as {
      systemPrompt: string;
    };
    assert.deepEqual(first, second);
    assert.equal(first.systemPrompt, second.systemPrompt);
  });
});

// =============================================================================
// Schema shape (Kiro compatibility)
// =============================================================================

describe("schema shape \u2014 Kiro compatibility", () => {
  it("registers a tool with a flat object root and `action` required", () => {
    // The Kiro/CodeWhisperer adapter forwards inputSchema.json verbatim and
    // 400s on non-`type: "object"` roots (anyOf/oneOf/discriminated unions).
    // Pin the working shape so a future TypeBox refactor surfaces here.
    const { tool } = setup();
    const params = tool.parameters as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      anyOf?: unknown;
      oneOf?: unknown;
    };
    assert.equal(params.type, "object");
    // Tighter pin: `action` is the ONLY required field at the schema level.
    // Runtime guards (in execute) handle the action-conditional required-ness
    // for `name`, `rewindTo`, `newLabel`, `summaryFocus`. A regression
    // that lifts a runtime guard into the schema (e.g. adding
    // `summaryFocus` to `required`) would re-introduce the original Kiro
    // 400 — this assertion catches it.
    assert.deepEqual(params.required, ["action"]);
    // Each action-conditional field must still exist in `properties` so the
    // schema describes the full surface to the model.
    const props = params.properties ?? {};
    for (const key of [
      "name",
      "rewindTo",
      "newLabel",
      "summaryFocus",
      "kind",
      "text",
      "path",
      "lines",
      "why",
      "scopeAnchor",
    ]) {
      assert.ok(key in props, `${key} must be a schema property`);
    }
    assert.equal(params.anyOf, undefined);
    assert.equal(params.oneOf, undefined);
  });

  it("offers `pin` and exactly the agent-pinnable kinds: rule and objective stay user-only", () => {
    const { tool } = setup();
    const props = (
      tool.parameters as {
        properties: Record<string, { anyOf?: Array<{ const: string }> }>;
      }
    ).properties;
    const literals = (key: string) => props[key].anyOf?.map((l) => l.const);
    assert.deepEqual(literals("action"), ["anchor", "rewind", "list", "pin"]);
    assert.deepEqual(literals("kind"), [
      "sub-goal",
      "decision",
      "fact",
      "file",
      "steering",
    ]);
  });

  it("schema clean break: rewindTo/newLabel registered, legacy names absent (#43)", () => {
    // #43 is a clean break — no aliases. The schema must expose only the
    // new param names; a legacy key reappearing in `properties` would keep
    // the old vocabulary in the model-facing tool definition (and the
    // cached prefix it sits at the head of). Legacy key names are
    // assembled at runtime so the repo's zero-hit ref audit stays clean.
    const legacyRewindTo = `label${"Start"}`;
    const legacyNewLabel = `label${"End"}`;
    const { tool } = setup();
    const props = (tool.parameters as { properties: Record<string, unknown> })
      .properties;
    assert.ok("rewindTo" in props, "rewindTo must be a schema property");
    assert.ok("newLabel" in props, "newLabel must be a schema property");
    assert.ok(
      !(legacyRewindTo in props),
      `no legacy ${legacyRewindTo} alias in the schema`,
    );
    assert.ok(
      !(legacyNewLabel in props),
      `no legacy ${legacyNewLabel} alias in the schema`,
    );
  });

  it("declares executionMode: 'sequential' (concurrency contract)", () => {
    // Concurrent dispatch would race on the SessionManager's leaf pointer
    // and corrupt the tree. The tool relies on the pi runtime to serialize
    // calls. A regression that drops or flips this property is the only
    // practical defense — source has no in-process double-call guard.
    const { tool } = setup();
    assert.equal(tool.executionMode, "sequential");
  });

  it("each conditional-required field carries an action-conditional description", () => {
    // The schema descriptions encode the conditional-required contract
    // for the model (the `Required when action='X'` phrase). A drift in
    // this prose silently degrades model tool-use accuracy. Pin presence
    // of the canonical conditional phrase so a future copy-edit that
    // drops it surfaces here.
    const { tool } = setup();
    const props = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    assert.match(props.name.description ?? "", /Required when action='anchor'/);
    assert.match(
      props.rewindTo.description ?? "",
      /Required when action='rewind'/,
    );
    assert.match(
      props.newLabel.description ?? "",
      /Required when action='rewind'/,
    );
    assert.match(
      props.summaryFocus.description ?? "",
      /Required when action='rewind'/,
    );
    for (const key of ["kind", "text", "path", "why"]) {
      assert.match(
        props[key].description ?? "",
        /Required when action='pin'/,
        `${key} states when it is required`,
      );
    }
    // Pin schema-description interpolation of the named constants. The
    // runtime guard error pins MIN_SUMMARY_FOCUS_LENGTH symmetrically
    // (see the `summaryFocus` validation-guards table below); the
    // schema-description side is the model-facing surface and deserves
    // the same anti-drift pin. A regression that hardcodes "max 40" or
    // "≥20" (instead of interpolating) silently desyncs when the
    // constants are re-tuned.
    assert.match(
      props.name.description ?? "",
      new RegExp(`max ${MAX_NAME_LENGTH}`),
    );
    assert.match(
      props.summaryFocus.description ?? "",
      new RegExp(`\u2265${MIN_SUMMARY_FOCUS_LENGTH}`),
    );
    assert.match(
      props.text.description ?? "",
      new RegExp(`max ${MAX_ITEM_TEXT_CHARS}`),
    );
  });
});

// =============================================================================
// Tool definition text — issue #22 token-trim pins
// =============================================================================

describe("tool definition \u2014 #22 token-trim pins", () => {
  // Owner-approved copy from issue #22 (~848 → ~470 tok/request). The
  // expectations are reconstructed with the SAME template literals the
  // source interpolates (${MAX_NAME_LENGTH}, ${MIN_SUMMARY_FOCUS_LENGTH})
  // so constant re-tunes stay honest — hardcoding 40/20 here would let a
  // schema/expectation desync slip through.
  const expectedDescription = `Long-session context management via the pi session tree. Anchor named milestones, then collapse work between them into a model-generated summary to free context.
\`rewind\` does not restore prior state: it forks a sibling branch from the anchor and continues forward from a model-generated summary.

Operations (set \`action\`):
  • 'anchor', name='<milestone-name>': label the current point. Anchor at the start of a stage you'll summarize (e.g. 'impl-start').
  • 'rewind', rewindTo='<existing>', newLabel='<new>': collapse work between rewindTo and the current leaf into a branch_summary labeled newLabel, so rewinds can chain.
  • 'list': show all anchors on the active branch, oldest first, with cumulative context % at each.
  • 'pin', kind='sub-goal'|'decision'|'fact'|'file'|'steering', text='<what to keep>': record a durable item that survives folds; \`list\` shows them. 'file' takes path+why instead of text; 'steering' belongs to an anchor (scopeAnchor, default newest). Refused when the user disabled the continuity ledger (continuity.capture=false).

\`name\` (anchor) and \`newLabel\` (rewind) write into one shared anchor namespace: labels are unique on the active branch — both actions refuse a name that already exists — and everything written there is addressable as a future \`rewindTo\`. Avoid the reserved \`anchor:\` prefix.`;

  it("description byte-equals the issue-approved trimmed string", () => {
    // Byte-exact snapshot: any wording change to the tool description must
    // land consciously through these pins, not by silent drift.
    const { tool } = setup();
    assert.equal(tool.description, expectedDescription);
  });

  it("each parameter description byte-equals its issue-approved string", () => {
    const { tool } = setup();
    const props = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    assert.equal(props.action.description, "Which operation to perform.");
    assert.equal(
      props.name.description,
      `Required when action='anchor'. Kebab-case milestone label, max ${MAX_NAME_LENGTH} chars.`,
    );
    assert.equal(
      props.rewindTo.description,
      `Required when action='rewind'. Kebab-case name of an existing anchor on the active branch to rewind to.`,
    );
    assert.equal(
      props.newLabel.description,
      `Required when action='rewind'. Kebab-case label for the resulting branch_summary entry; reusable as a future rewindTo.`,
    );
    assert.equal(
      props.summaryFocus.description,
      `Required when action='rewind'; ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim. Encode: (1) the user's most recent instruction verbatim, (2) what's done in the collapsed segment, (3) what's left to do as a next action; if the user authorized continuing, name the next work item, not a report or wrap-up.`,
    );
    assert.equal(
      props.kind.description,
      `Required when action='pin'. Your sub-goal, a decision you made, a key fact, a file pointer, or steering that lapses when its anchor is folded.`,
    );
    assert.equal(
      props.text.description,
      `Required when action='pin' unless kind='file'. What to remember, max ${MAX_ITEM_TEXT_CHARS} chars.`,
    );
    assert.equal(
      props.path.description,
      `Required when action='pin' and kind='file'. File path.`,
    );
    assert.equal(
      props.lines.description,
      `Optional with kind='file': N or N-M.`,
    );
    assert.equal(
      props.why.description,
      `Required when action='pin' and kind='file'. Why the file matters.`,
    );
    assert.equal(
      props.scopeAnchor.description,
      `Anchor name for kind='steering' (default: newest anchor); optional for 'sub-goal'.`,
    );
  });

  it("re-bloat tripwire: description + param descriptions stay ≤600 tok at chars/4", () => {
    // Every character of the tool definition is paid per request. The #22
    // trim landed at 1477 chars = 369.25 tok (#43 rename recompute); the
    // `pin` action (operations line + six parameter descriptions) raised the
    // bound to 600 consciously; the summaryFocus authorization hint (stop
    // after fold) took it from 555.5 to 576.75 tok. This bound guards against
    // silently regrowing the schema — a future legit edit that needs more
    // room must raise this number consciously, not bleed past it.
    const { tool } = setup();
    const props = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    const all = [
      tool.description,
      props.action.description ?? "",
      props.name.description ?? "",
      props.rewindTo.description ?? "",
      props.newLabel.description ?? "",
      props.summaryFocus.description ?? "",
      props.kind.description ?? "",
      props.text.description ?? "",
      props.path.description ?? "",
      props.lines.description ?? "",
      props.why.description ?? "",
      props.scopeAnchor.description ?? "",
    ].join("");
    assert.ok(
      all.length / 4 <= 600,
      `tool definition re-bloated: ${all.length} chars = ${(all.length / 4).toFixed(2)} tok > 600`,
    );
  });
});

// =============================================================================
// factory registration
// =============================================================================

describe("factory registration", () => {
  it("registers with the single pi argument and `list` succeeds", async () => {
    // Production callers (pi's extension loader) pass a single arg; the
    // fold's summarizer is not injectable: it goes through `ctx.modelRegistry`.
    const sm = SessionManager.inMemory("/tmp");
    const fakePi = makeFakePi(sm);
    navigateTree(fakePi.pi);
    assert.equal(fakePi.registered.length, 1);
    const tool = fakePi.registered[0];
    const ctx = makeCtx(sm);
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
  });

  it("registers the rewind fold turn_end handler BEFORE the hint/start-anchor handler", () => {
    // Order matters: a completed rewind must already be on the branch when
    // the hint handler reads context usage. The rewind handler is async;
    // the hint handler is synchronous by design.
    const { pi } = setup();
    const handlers = pi.onCalls.get("turn_end");
    assert.ok(handlers);
    assert.equal(handlers.length, 2);
    assert.equal(handlers[0].constructor.name, "AsyncFunction");
    assert.notEqual(handlers[1].constructor.name, "AsyncFunction");
    assert.equal(pi.onCalls.has("tool_call"), false);
  });
});
// =============================================================================
// dispatch: list
// =============================================================================

describe("dispatch: list action", () => {
  it("returns 'No labels' on an empty session", async () => {
    const { tool, ctx } = setup();
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /No labels on the active branch\./);
    assert.equal(result.details.count, 0);
  });

  it("renders anchored labels in chronological order", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 100);
    pi.pi.setLabel(t1.assistantId, "anchor:first");
    const t2 = appendTurn(sm, "u2", "a2", 200);
    pi.pi.setLabel(t2.assistantId, "anchor:second");

    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.details.count, 2);
    const text = result.content[0].text;
    // Chronological order: 'first' appears before 'second' in the text.
    const firstIdx = text.indexOf("first");
    const secondIdx = text.indexOf("second");
    assert.ok(firstIdx >= 0 && secondIdx > firstIdx);
  });

  it("pins the per-row line shape: percentage column then label column", async () => {
    // Pin the actual rendered shape so a formatting refactor that swaps
    // column order or drops the percentage prefix surfaces here. The
    // regex matches one or more leading spaces, a `\d+\.\d%` percent,
    // more whitespace, then a non-whitespace label. We don't pin
    // character offsets — padStart/padEnd widths are implementation
    // details — just the shape.
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 100);
    pi.pi.setLabel(t1.assistantId, "anchor:short");
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text;
    assert.match(text, /^\s+\d+\.\d+%\s+\S+/m);
  });

  it("renders the shared anchor table with an aligned (after:) column for a 40-char name (#101 D19)", async () => {
    const { sm, pi, tool, ctx } = setup();
    const long = "a".repeat(MAX_NAME_LENGTH);
    const t1 = appendTurn(sm, "u1", "first reply", 100);
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    const t2 = appendTurn(sm, "u2", "second reply", 200);
    pi.pi.setLabel(t2.assistantId, `anchor:${long}`);
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    const body = result.content[0].text.split("\n\n")[1];
    assert.equal(
      body,
      [
        "Active anchors (root → leaf, % of 1.0M):",
        `   0.0%  ${"start".padEnd(MAX_NAME_LENGTH)}  (after: “first reply”)`,
        `   0.0%  ${long}  (after: “second reply”)`,
      ].join("\n"),
    );
  });

  it("omits ' of <window>' from the header when contextWindow is 0", async () => {
    const { sm, tool, ctx } = setup({ contextWindow: 0 });
    appendTurn(sm, "u", "a");
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    // Header includes context as 'Nk' fallback but no ' of 1.0M' tail.
    const header = result.content[0].text.split("\n")[0];
    assert.ok(!header.includes(" of "), `header had ' of ': ${header}`);
  });

  it("includes the reflection-bootstrap warning when no captured session", async () => {
    // No __testHooks.captureSession() called \u2014 reflection finds nothing.
    const { tool, ctx } = setup();
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /reflection bootstrap missing/);
    assert.equal(result.details.reflectionOk, false);
  });

  it("clears the reflection warning when the owning session is captured", async () => {
    const { sm, tool, ctx } = setup();
    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);
    const result = await tool.execute(
      "tc-1",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(result.content[0].text, /reflection bootstrap missing/);
    assert.equal(result.details.reflectionOk, true);
  });

  it("list and rewind warnings cite their site-specific REFLECTION_BOOTSTRAP_WARNING constants verbatim", async () => {
    // Two SSOT constants — one per emission site — because the prose
    // differs (`list` is read-only; `rewind` wrote to disk). Pin literal
    // containment of the matching constant at each site so a future
    // drift (e.g. dropping the /reload recovery hint at one site, or
    // accidentally swapping the constants between sites) surfaces here.
    const listSentinel = __testHooks.REFLECTION_BOOTSTRAP_WARNING_LIST;
    const rewindSentinel = __testHooks.REFLECTION_BOOTSTRAP_WARNING_REWIND;
    assert.ok(listSentinel.length > 0, "list-warning must be non-empty");
    assert.ok(rewindSentinel.length > 0, "rewind-warning must be non-empty");
    // The two are distinct — distinct prose for distinct call shapes.
    // (If they ever converge again, this asserts that fact deliberately.)
    assert.notEqual(
      listSentinel,
      rewindSentinel,
      "list and rewind warnings must use site-specific phrasing",
    );
    // Both share the recovery hint with `/reload` mentioned
    // (`/reload` is the lighter-weight recovery and is named first;
    // restarting pi is the heavier alternative). A regression that
    // drops `/reload` from either constant surfaces here.
    assert.match(
      listSentinel,
      /\/reload/,
      "list-warning must mention /reload as a recovery option",
    );
    assert.match(
      rewindSentinel,
      /\/reload/,
      "rewind-warning must mention /reload as a recovery option",
    );

    // List site: no captured session — reflection finds nothing. The
    // list-specific constant must appear verbatim; the rewind-specific
    // constant must NOT (they're cross-site distinct).
    {
      const { tool, ctx } = setup();
      const result = await tool.execute(
        "tc-list",
        { action: "list" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(
        result.content[0].text.includes(listSentinel),
        "list output must include REFLECTION_BOOTSTRAP_WARNING_LIST verbatim",
      );
      assert.ok(
        !result.content[0].text.includes(rewindSentinel),
        "list output must NOT include the rewind-specific phrasing",
      );
    }

    // Rewind site: same conditions — the bootstrap-missing footer on the
    // continuation message (written once the fold lands) must
    // contain the rewind-specific constant verbatim, NOT the list one.
    {
      const { done } = await rewindFixture({ capture: false });
      assert.ok(
        done.message.content.includes(rewindSentinel),
        "rewind continuation must include REFLECTION_BOOTSTRAP_WARNING_REWIND verbatim",
      );
      assert.ok(
        !done.message.content.includes(listSentinel),
        "rewind continuation must NOT include the list-specific phrasing",
      );
    }
  });
});

// =============================================================================
// dispatch: anchor
// =============================================================================

describe("dispatch: anchor action", () => {
  // The `isValidName` predicate is exhaustively pinned in helpers.test.ts;
  // here we just verify the predicate's verdict propagates into the dispatch
  // error path. Two rows: a representative invalid shape + the boundary case.
  const invalidNames: Array<[string, unknown]> = [
    ["uppercase", "Impl-Start"],
    ["over max length", "a".repeat(MAX_NAME_LENGTH + 1)],
  ];
  for (const [label, value] of invalidNames) {
    it(`rejects invalid name (${label}) with kebab-case message`, async () => {
      const { sm, tool, ctx } = setup();
      appendTurn(sm, "u", "a");
      const result = await tool.execute(
        "tc-1",
        { action: "anchor", name: value },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /kebab-case/);
    });
  }

  it("errors when the session has no entries yet", async () => {
    // Fresh inMemory SM \u2014 no appendMessage \u2014 leafId is null.
    const { tool, ctx } = setup();
    const result = await tool.execute(
      "tc-1",
      { action: "anchor", name: "iter-start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No session entries yet/);
  });

  it("happy path: setLabel called with the prefixed label and details surface entryId", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t = appendTurn(sm, "u", "a");
    const result = await tool.execute(
      "tc-1",
      { action: "anchor", name: "impl-start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    // pi.setLabel called with prefixed label on the leaf.
    const labelCall = pi.setLabelCalls.find(
      ([, lbl]) => lbl === "anchor:impl-start",
    );
    assert.ok(labelCall, "setLabel was not called with anchor:impl-start");
    assert.equal(labelCall?.[0], t.assistantId);
    assert.equal(result.details.label, "impl-start");
    assert.equal(result.details.entryId, t.assistantId);
    // Pin the anchor follow-up hint prose. This is the load-bearing
    // nudge that gets the agent to chain `anchor → rewind` correctly
    // with a populated `summaryFocus`. A future copy-edit that drops
    // the `summaryFocus` mention or the `MIN_SUMMARY_FOCUS_LENGTH`
    // interpolation would silently degrade the model's tool-use
    // accuracy on the very first rewind.
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /navigate_tree\(action='rewind'/);
    assert.match(text, /rewindTo='<oldest appropriate anchor>'/);
    assert.match(text, /summaryFocus=/);
    assert.match(text, new RegExp(`\u2265${MIN_SUMMARY_FOCUS_LENGTH}`));
  });

  it("estimate throws before the label write: the error propagates and no label is written (atomic anchor)", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t = appendTurn(sm, "u1", "a1");

    // Force the token estimate to throw. The old ordering wrote the label
    // first, so a throw here still left `anchor:impl-start` on disk (the
    // tool reported an error, and a retry with the same name was rejected
    // as a duplicate). Compute-before-write is the fix this pins.
    const origBuild = sm.buildSessionContext.bind(sm);
    (
      sm as { buildSessionContext: typeof sm.buildSessionContext }
    ).buildSessionContext = (() => {
      throw new Error("anchor estimate boom");
    }) as typeof sm.buildSessionContext;

    let thrown: unknown;
    try {
      await tool.execute(
        "tc-1",
        { action: "anchor", name: "impl-start" },
        undefined,
        undefined,
        ctx,
      );
    } catch (e) {
      thrown = e;
    } finally {
      (
        sm as { buildSessionContext: typeof sm.buildSessionContext }
      ).buildSessionContext = origBuild;
    }

    assert.ok(thrown, "the estimate throw must propagate");
    assert.match(
      thrown instanceof Error ? thrown.message : String(thrown),
      /anchor estimate boom/,
    );
    assert.equal(
      pi.setLabelCalls.length,
      0,
      "anchor must not write its label before the estimate succeeds",
    );
    assert.equal(sm.getLabel(t.assistantId), undefined);
  });

  it("duplicate refusal: re-anchoring an existing name is refused with no write and no prior-clear", async () => {
    // Issue #55 (C8): labels are unique on the active branch and immutable
    // once written. Re-anchoring the same name must be refused BEFORE any
    // write; the prior label stays exactly where it was (retired
    // move-on-collision).
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1");
    const first = await tool.execute(
      "tc-1",
      { action: "anchor", name: "iter-start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(first.isError, undefined);
    assert.equal(sm.getLabel(t1.assistantId), "anchor:iter-start");
    const setLabelCountBefore = pi.setLabelCalls.length;

    const t2 = appendTurn(sm, "u2", "a2");
    const result = await tool.execute(
      "tc-2",
      { action: "anchor", name: "iter-start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already exists on the active branch/);
    assert.match(result.content[0].text, /labels are unique/);
    assert.match(result.content[0].text, /action='list'/);
    assert.match(result.content[0].text, /fresh name/);
    assert.equal(result.details.refusal, true);
    // No write at all: no set, no clear, and the prior label and the new
    // leaf are untouched.
    assert.equal(
      pi.setLabelCalls.length,
      setLabelCountBefore,
      "a refused anchor must not call setLabel",
    );
    assert.equal(sm.getLabel(t1.assistantId), "anchor:iter-start");
    assert.equal(sm.getLabel(t2.assistantId), undefined);
    assert.equal(result.details.movedFromPriorEntry, undefined);
  });

  it("refusal copy names the colliding name and points at list + a fresh name", async () => {
    const { sm, pi, tool, ctx } = setup();
    appendTurn(sm, "u1", "a1");
    await tool.execute(
      "tc-1",
      { action: "anchor", name: "phase1" },
      undefined,
      undefined,
      ctx,
    );
    appendTurn(sm, "u2", "a2");
    const result = await tool.execute(
      "tc-2",
      { action: "anchor", name: "phase1" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    // Byte-exact copy pin (same string the source builds).
    assert.equal(
      text,
      "A label 'phase1' already exists on the active branch — labels are unique and immutable once written. Use action='list' to review the active labels, then pick a fresh name.",
    );
    void pi;
  });

  it("manual /tree duplicate labels remain possible and resolve leaf-most", async () => {
    // Issue #55 (C8): the tool never creates duplicates, but a manual
    // `/tree` label can put the same name on two entries. `findLabeledEntry`
    // walks leaf→root, so `rewindTo` resolves to the leaf-most match —
    // documented and accepted.
    const { sm, pi } = setup();
    const t1 = appendTurn(sm, "u1", "a1");
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    const t2 = appendTurn(sm, "u2", "a2");
    pi.pi.setLabel(t2.assistantId, "anchor:start");
    assert.equal(
      __testHooks.findLabeledEntry(sm, "anchor:start"),
      t2.assistantId,
      "duplicate labels must resolve leaf-most",
    );
  });

  it("falls through with a misleading rewind error on unknown `action`", async () => {
    // The schema declares `action` as a Union(anchor|rewind|list), but the
    // runtime dispatch is three `if` checks with no explicit default —
    // an unknown action falls through to the rewind validation block.
    // Pin the current behavior so a future explicit `else` guard surfaces
    // here as a deliberate change.
    const { sm, tool, ctx } = setup();
    appendTurn(sm, "u", "a");
    const result = await tool.execute(
      "tc-1",
      { action: "bogus" } as unknown as Record<string, unknown>,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    // Pin that the unknown-action falls through to the rewind-validation
    // site specifically (not just "any error"). The rewind dispatch's
    // first guard rejects a missing/invalid `rewindTo` with a
    // "kebab-case" message; pinning that text confirms the fall-through
    // landed at the rewindTo guard, not at a future explicit
    // unknown-action default.
    assert.match(
      (result.content[0] as { text: string }).text,
      /rewindTo.*kebab-case/,
    );
  });
});

// =============================================================================
// dispatch: rewind validation guards
// =============================================================================

describe("dispatch: rewind validation guards", () => {
  // Each row produces an isError=true result whose text matches the regex.
  // The order matches the guard order in execute(): rewindTo, newLabel,
  // summaryFocus, then label-existence.
  const cases: Array<{
    name: string;
    params: Record<string, unknown>;
    want: RegExp;
  }> = [
    {
      name: "missing rewindTo",
      params: { action: "rewind" },
      want: /rewindTo.*kebab-case/,
    },
    {
      name: "rewindTo present, missing newLabel",
      params: { action: "rewind", rewindTo: "ok" },
      want: /newLabel.*kebab-case/,
    },
    {
      name: "rewindTo and newLabel valid, missing summaryFocus",
      params: { action: "rewind", rewindTo: "ok", newLabel: "ok2" },
      want: /summaryFocus/,
    },
    {
      name: "summaryFocus shorter than min length",
      params: {
        action: "rewind",
        rewindTo: "ok",
        newLabel: "ok2",
        summaryFocus: "x".repeat(MIN_SUMMARY_FOCUS_LENGTH - 1), // just under the floor
      },
      want: /summaryFocus/,
    },
    {
      // Trim-presence pin on the rejection path: raw length is above the
      // floor (so a regression dropping `.trim()` would accept it), but
      // trimmed length is below it. The guard with `.trim()` rejects;
      // without `.trim()` it would slip past this row.
      name: "summaryFocus shorter than min length after trim",
      params: {
        action: "rewind",
        rewindTo: "ok",
        newLabel: "ok2",
        summaryFocus: `  ${"x".repeat(MIN_SUMMARY_FOCUS_LENGTH - 1)}  `,
      },
      want: /summaryFocus/,
    },
    {
      name: "summaryFocus mentions the 20-char threshold in error text",
      params: {
        action: "rewind",
        rewindTo: "ok",
        newLabel: "ok2",
        summaryFocus: "short",
      },
      // Pin that the error text surfaces MIN_SUMMARY_FOCUS_LENGTH literally;
      // the regex tracks the constant if the floor is bumped.
      want: new RegExp(`\u2265${MIN_SUMMARY_FOCUS_LENGTH}`),
    },
    {
      name: "rewindTo kebab-invalid (uppercase)",
      params: { action: "rewind", rewindTo: "Bad-Name" },
      want: /rewindTo.*kebab-case/,
    },
    {
      name: "newLabel kebab-invalid (snake_case)",
      params: { action: "rewind", rewindTo: "ok", newLabel: "snake_case" },
      want: /newLabel.*kebab-case/,
    },
    {
      name: "all valid but no such rewindTo on the active branch",
      params: {
        action: "rewind",
        rewindTo: "missing",
        newLabel: "after",
        summaryFocus: "x".repeat(MIN_SUMMARY_FOCUS_LENGTH),
      },
      want: /No label 'missing'/,
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { sm, tool, ctx } = setup();
      // Append a turn so the no-such-label case can pass earlier guards
      // and reach the label-existence check.
      appendTurn(sm, "u", "a");
      const result = await tool.execute(
        "tc-1",
        c.params,
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, c.want);
    });
  }

  it("old-name rewind calls reach execute and are refused by the new-name guards (clean break)", async () => {
    // #43 clean break: pi-ai's argument validation passes unknown keys
    // through (the schema has no `additionalProperties`), so a resumed
    // session replaying old-name params still reaches `execute` — the
    // runtime guards are the path exercised here, representative of the
    // live one-retry self-heal (each error names the new param). An
    // execute-level alias fallback would not add a schema key, so the
    // second row is the only guard against it. Legacy key names are
    // assembled at runtime so the repo's zero-hit ref audit stays clean.
    const legacyRewindTo = `label${"Start"}`;
    const legacyNewLabel = `label${"End"}`;
    const cases: Array<{
      name: string;
      params: Record<string, unknown>;
      want: RegExp;
    }> = [
      {
        name: "legacy rewindTo key only",
        params: { action: "rewind", [legacyRewindTo]: "ok" },
        want: /rewind requires `rewindTo` in kebab-case/,
      },
      {
        name: "legacy newLabel key only (valid rewindTo + summaryFocus)",
        params: {
          action: "rewind",
          rewindTo: "ok",
          [legacyNewLabel]: "ok2",
          summaryFocus: "x".repeat(MIN_SUMMARY_FOCUS_LENGTH),
        },
        want: /rewind requires `newLabel` in kebab-case/,
      },
    ];
    for (const c of cases) {
      const { sm, tool, ctx } = setup();
      appendTurn(sm, "u", "a");
      const result = await tool.execute(
        "tc-old-name",
        c.params,
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, true, `${c.name}: must be refused`);
      assert.match(
        (result.content[0] as { text: string }).text,
        c.want,
        `${c.name}: refusal must name the new param`,
      );
    }
  });

  it("summaryFocus exactly 20 chars after trim passes the guard", async () => {
    // Boundary: summaryFocus.trim().length >= MIN_SUMMARY_FOCUS_LENGTH (the
    // >= boundary, not strict >). The call still errors at the next guard
    // (no rewindTo on chain), but it moves past the focus-length check —
    // pinning that the comparison is inclusive at exactly MIN. Trim-
    // presence on the rejection path is pinned by the
    // "shorter than min length after trim" row above, not here.
    const { sm, tool, ctx } = setup();
    appendTurn(sm, "u", "a");
    const result = await tool.execute(
      "tc-1",
      {
        action: "rewind",
        rewindTo: "missing",
        newLabel: "after",
        summaryFocus: `  ${"x".repeat(MIN_SUMMARY_FOCUS_LENGTH)}  `,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    // Past the focus guard, into the label-existence guard.
    assert.match(result.content[0].text, /No label 'missing'/);
  });
});

// =============================================================================
// dispatch: refusal results surface as failed tool calls
//
// `AgentToolResult` has no `isError` field in pi-agent-core's contract, and
// the agent runtime overwrites any returned flag with its own boolean (only a
// thrown `execute()` is finalized as an error). `toolError` therefore tags
// its details with `refusal: true` and the factory's `tool_result` handler
// flips the host's `isError` — the signal that turns the TUI row and the
// transcript entry red. These pins cover registration, the flip, and the
// no-op paths.
// =============================================================================

describe("dispatch: refusal results surface as failed tool calls", () => {
  function toolResultHandler(): (e: unknown) => unknown {
    const { pi } = setup();
    const handlers = pi.onCalls.get("tool_result");
    assert.ok(handlers, "factory must register a tool_result handler");
    assert.equal(handlers.length, 1);
    return handlers[0] as unknown as (e: unknown) => unknown;
  }

  it("returns isError:true for a navigate_tree refusal", () => {
    const out = toolResultHandler()({
      type: "tool_result",
      toolName: "navigate_tree",
      toolCallId: "tc-refusal",
      input: { action: "rewind" },
      content: [
        { type: "text", text: "Rewinding to 'start' would free only…" },
      ],
      // Shape produced by `toolError`.
      details: { refusal: true, rejected: "min-savings" },
      isError: false,
    });
    assert.deepEqual(out, { isError: true });
  });

  it("leaves successful navigate_tree results untouched", () => {
    const out = toolResultHandler()({
      type: "tool_result",
      toolName: "navigate_tree",
      toolCallId: "tc-anchor",
      input: { action: "anchor" },
      content: [{ type: "text", text: "[anchor 'start'] set at 1.0%" }],
      details: { label: "start", contextTokens: 1_234 },
      isError: false,
    });
    assert.equal(out, undefined);
  });

  it("ignores other tools even with a refusal-shaped payload", () => {
    const out = toolResultHandler()({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "tc-bash",
      input: { command: "true" },
      content: [{ type: "text", text: "ok" }],
      details: { refusal: true },
      isError: false,
    });
    assert.equal(out, undefined);
  });

  it("toolError tags every refusal with the marker, keeping caller details", async () => {
    const { tool, ctx } = setup();
    const result = await tool.execute(
      "tc-bad-focus",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "end",
        summaryFocus: "too short",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refusal, true);
    assert.match(result.content[0].text, /summaryFocus/);
  });
});

// =============================================================================
// dispatch: rewind queues an independent fold
//
// The rewind tool call neither summarizes nor mutates anything: it validates,
// queues the fold and answers "accepted". The fold runs at the turn's
// `turn_end`, after every tool result of the turn is on the branch.
// =============================================================================

describe("dispatch: rewind queues an engine fold", () => {
  it("returns only the byte-exact 'accepted' text and the queued details", async () => {
    const { sm, pi, tool, ctx } = setup();
    const { anchorId } = setupRewindable(sm, pi);
    appendToolCallAssistant(sm, [
      { id: "tc-rewind", name: TOOL_NAME, arguments: REWIND_ARGS },
    ]);
    const result = await tool.execute(
      "tc-rewind",
      REWIND_ARGS,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(
      result.content[0].text,
      "[navigate_tree] Rewind to 'start' accepted (collapse as 'end'). The fold runs after this turn's tool results; the continuation follows in the same run.",
    );
    assert.equal(
      result.content[0].text,
      buildRewindAcceptedText("start", "end"),
    );
    assert.deepEqual(result.details, {
      status: "queued",
      rewindTo: "start",
      newLabel: "end",
      targetId: anchorId,
      contextBefore: result.details.contextBefore,
      tokensAtTarget: result.details.tokensAtTarget,
      contextWindow: 1_000_000,
    });
    assert.equal(typeof result.details.contextBefore, "number");
    assert.equal(typeof result.details.tokensAtTarget, "number");
  });

  it("the rewind turn's turn_end folds through side calls, continues the run and writes no summary request", async () => {
    const f = setup();
    setupAutonomousSpan(f.sm, f.pi);
    const { boundary } = await requestRewind(f);
    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries.length, 1);
    const draft = boundary.entries[0];
    assert.equal(draft.type, "custom_message");
    assert.equal(draft.customType, REWIND_CUSTOM_TYPE);
    assert.equal(draft.details.status, "done");
    assert.equal(draft.details.origin, "agent");
    assert.ok(f.ctx.registryCalls.length > 0, "summarized by side calls");
    for (const call of f.ctx.registryCalls) {
      assert.equal(call.options.toolChoice, "none");
      assert.equal(call.options.sessionId, f.sm.getSessionId());
    }
    assert.ok(
      f.sm
        .getEntries()
        .every(
          (e) =>
            !(
              e.type === "custom_message" &&
              e.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE
            ),
        ),
      "no summary request is written",
    );
    assert.equal(f.pi.sendMessageCalls.length, 0);
    assert.equal(f.pi.sendUserMessageCalls.length, 0);
    assert.ok(f.sm.getBranch().some((e) => e.type === "branch_summary"));
    assert.equal(f.sm.getLeafId(), f.sm.getBranch().at(-1)?.id);
    assert.equal(
      f.sm.getEntry(f.sm.getLeafId() as string)?.type,
      "custom_message",
    );
  });

  it("Esc during the rewind turn cancels the queued fold: a receipt, no side call, no continue", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    const controller = new AbortController();
    controller.abort();
    f.ctx.signal = controller.signal;
    const before = f.sm.getEntries().length;
    const { boundary } = await requestRewind(f);
    assert.equal(boundary.continue, false);
    assert.equal(boundary.entries.length, 1);
    assert.equal(boundary.entries[0].details.status, "failed");
    assert.equal(boundary.entries[0].details.reason, "cancelled");
    assert.equal(f.ctx.registryCalls.length, 0);
    assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
    assert.ok(
      f.sm.getEntries().length > before,
      "only the call, its result and the receipt were added",
    );
    assert.equal(fireToolCall(f.pi, f.ctx), undefined);
  });

  it("does not mutate the tree, send a message, or write a label at call time", async () => {
    const { sm, pi, tool, ctx } = setup();
    setupRewindable(sm, pi, { capture: true });
    appendToolCallAssistant(sm, [{ id: "tc-rewind", name: TOOL_NAME }]);
    const entriesBefore = sm.getEntries().length;
    const leafBefore = sm.getLeafId();
    const labelCallsBefore = pi.setLabelCalls.length;
    const result = await tool.execute(
      "tc-rewind",
      REWIND_ARGS,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(sm.getLeafId(), leafBefore);
    assert.equal(sm.getEntries().length, entriesBefore);
    assert.ok(
      !sm.getEntries().some((e) => e.type === "branch_summary"),
      "the call must not branch",
    );
    assert.equal(pi.setLabelCalls.length, labelCallsBefore);
    assert.equal(pi.sendMessageCalls.length, 0);
    assert.equal(ctx.registryCalls.length, 0);
  });

  it("is accepted without a model, then fails at the boundary with a receipt the model reads", async () => {
    const f = setup({ noModel: true });
    setupRewindable(f.sm, f.pi);
    const before = f.sm.getEntries().length;
    const { result, boundary } = await requestRewind(f);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "queued");
    assert.equal(result.details.contextWindow, 0);
    assert.equal(boundary.continue, true, "the model hears about it");
    assert.equal(boundary.entries[0].details.status, "failed");
    assert.equal(boundary.entries[0].details.stage, "gate");
    assert.match(boundary.entries[0].content, /no model is selected/);
    assert.match(boundary.entries[0].content, /Nothing was collapsed/);
    assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
    assert.equal(f.sm.getEntries().length, before + 3);
  });

  it("hands the focus to the summary request verbatim (no truncation, no {first} left over)", async () => {
    const f = setup();
    setupAutonomousSpan(f.sm, f.pi);
    const focus = `user said: ship it. ${"detail ".repeat(400)}`.trim();
    const { result } = await requestRewind(f, {
      ...REWIND_ARGS,
      summaryFocus: focus,
    });
    assert.equal(result.isError, undefined);
    const last = f.ctx.registryCalls.at(-1)?.context.messages.at(-1);
    const text = JSON.stringify(last);
    assert.ok(
      text.includes(JSON.stringify(`Additional focus: ${focus}`).slice(1, -1)),
    );
    assert.doesNotMatch(text, /\{first\}/);
  });

  it("a refused rewind queues nothing: the next turn_end folds nothing and a later rewind is accepted", async () => {
    const f = setup();
    appendTurn(f.sm, "u", "a");
    const { result, boundary } = await requestRewind(f);
    assert.equal(result.isError, true);
    assert.equal(boundary.entries.length, 0);
    assert.equal(f.ctx.registryCalls.length, 0);
    assert.equal(fireToolCall(f.pi, f.ctx), undefined);
    setupRewindable(f.sm, f.pi, { rewindToName: "start" });
    const second = await requestRewind(f, REWIND_ARGS, "tc-2");
    assert.equal(second.result.isError, undefined);
    assert.equal(second.boundary.entries[0].details.status, "done");
  });

  it("refuses a second rewind while one is queued, with the engine's reason", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    appendToolCallAssistant(f.sm, [
      { id: "tc-1", name: TOOL_NAME, arguments: REWIND_ARGS },
      {
        id: "tc-2",
        name: TOOL_NAME,
        arguments: { ...REWIND_ARGS, newLabel: "other" },
      },
    ]);
    const first = await f.tool.execute(
      "tc-1",
      REWIND_ARGS,
      undefined,
      undefined,
      f.ctx,
    );
    const second = await f.tool.execute(
      "tc-2",
      { ...REWIND_ARGS, newLabel: "other" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, true);
    assert.equal(second.details.refusal, true);
    assert.match(second.content[0].text, /already queued or running/);
  });

  it("a rewind may share its message with other tool calls: all run, and their results are in the folded segment", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const call = appendToolCallAssistant(f.sm, [
      { id: "tc-read", name: "read", arguments: { path: "src/a.ts" } },
      { id: "tc-rewind", name: TOOL_NAME, arguments: REWIND_ARGS },
      { id: "tc-bash", name: "bash", arguments: { command: "true" } },
    ]);
    // pi runs the batch in order; the rewind only queues its fold.
    appendToolResult(f.sm, "tc-read", "read", "READ-RESULT-MARKER");
    const result = await f.tool.execute(
      "tc-rewind",
      REWIND_ARGS,
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(result.isError, undefined);
    appendToolResult(f.sm, "tc-rewind", TOOL_NAME, result.content[0].text);
    appendToolResult(f.sm, "tc-bash", "bash", "BASH-RESULT-MARKER");
    const leafBeforeFold = f.sm.getLeafId() as string;
    assert.equal(f.sm.getLabel(leafBeforeFold), undefined);

    const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message);

    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries[0].details.status, "done");
    assert.equal(f.sm.getLabel(leafBeforeFold), "branch:end");
    assert.ok(!f.sm.getBranch().some((e) => e.id === leafBeforeFold));
    const summarized = JSON.stringify(
      f.ctx.registryCalls.map((c) => c.context.messages),
    );
    assert.match(summarized, /READ-RESULT-MARKER/);
    assert.match(summarized, /BASH-RESULT-MARKER/);
    assert.deepEqual(boundary.entries[0].details.readFiles, ["src/a.ts"]);
  });

  it("accepts a codemode script's rewind at any position among its nested calls", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const call = appendToolCallAssistant(f.sm, [
      { id: "tc-code", name: "codemode", arguments: { code: "script" } },
    ]);
    const gate = f.pi.onCalls.get("tool_call") ?? [];
    const nested = (id: string, action: string) =>
      gate[0]?.(
        {
          type: "tool_call",
          toolCallId: id,
          parentToolCallId: "tc-code",
          toolName: TOOL_NAME,
          input: { action },
        } as never,
        f.ctx as never,
      );
    assert.equal(nested("tc-code/1", "list"), undefined);
    const list = await f.tool.execute(
      "tc-code/1",
      { action: "list" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(list.isError, undefined);
    assert.equal(nested("tc-code/2", "rewind"), undefined);
    const result = await f.tool.execute(
      "tc-code/2",
      REWIND_ARGS,
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "queued");
    appendToolResult(f.sm, "tc-code", "codemode", "script finished");
    const leafBeforeFold = f.sm.getLeafId() as string;

    const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message);

    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries[0].details.status, "done");
    assert.equal(f.sm.getLabel(leafBeforeFold), "branch:end");
    assert.ok(f.sm.getBranch().some((e) => e.type === "branch_summary"));
  });

  it("never blocks a tool call outside a forced rewind, even with a fold queued", async () => {
    const { sm, pi, tool, ctx } = setup();
    setupRewindable(sm, pi);
    assert.equal(fireToolCall(pi, ctx), undefined);
    appendToolCallAssistant(sm, [{ id: "tc-rewind", name: TOOL_NAME }]);
    await tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, ctx);
    assert.equal(fireToolCall(pi, ctx), undefined);
    assert.equal(
      fireToolCall(pi, ctx, TOOL_NAME, { action: "list" }),
      undefined,
    );
  });

  it("does not run another session's queued fold, and fails open when the session id cannot be read", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    appendToolCallAssistant(f.sm, [{ id: "tc-rewind", name: TOOL_NAME }]);
    await f.tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, f.ctx);
    const otherSm = SessionManager.inMemory("/tmp");
    const other = makeCtx(otherSm);
    await fireTurnEndAll(
      f.pi,
      other,
      assistantMessage([{ type: "text", text: "hi" }], "stop"),
    );
    await fireTurnEndAll(f.pi, f.ctx, {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    await fireTurnEndAll(f.pi, f.ctx, undefined);
    assert.equal(rewindMessages(f.pi).length, 0);
    assert.equal(f.ctx.registryCalls.length, 0);
    const stale = {
      get sessionManager(): SessionManager {
        throw new Error("stale ctx");
      },
    } as unknown as FakeCtx;
    assert.equal(fireToolCall(f.pi, stale), undefined);
    // The queued fold still runs at its own session's boundary.
    const message = assistantMessage([{ type: "text", text: "next" }], "stop");
    f.sm.appendMessage(message as never);
    const boundary = await fireTurnEndAll(f.pi, f.ctx, message);
    assert.equal(boundary.entries[0].details.status, "done");
  });
});

// =============================================================================
// rewind: the landed fold, at the rewind turn's turn_end
// =============================================================================

describe("rewind: completion", () => {
  it("branches from the anchor with a work handoff, labels it, and moves the leaf", async () => {
    const f = await rewindFixture();
    const summaryId = f.done.message.details.summaryId as string;
    const entry = f.sm.getEntry(summaryId);
    assert.ok(entry && entry.type === "branch_summary");
    assert.equal(entry.parentId, f.anchorId, "child of the anchor entry");
    assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
    const details = entry.details as {
      readFiles: string[];
      modifiedFiles: string[];
      treeNavigator: { title: string; children: string[] };
    };
    assert.deepEqual(details.readFiles, []);
    assert.deepEqual(details.modifiedFiles, []);
    assert.equal(details.treeNavigator.title, "end");
    assert.deepEqual(details.treeNavigator.children, []);
    // Extension-provided summary, as pi's navigateTree marks it.
    assert.equal(entry.fromHook, true);
    assert.equal(f.sm.getLabel(summaryId), "anchor:end");
    // The summary is followed by its label change (the same shape as pi's
    // own `/tree` label write) and then the committed continuation.
    const branch = f.sm.getBranch();
    const at = branch.findIndex((e) => e.id === summaryId);
    assert.equal(branch[at + 1].type, "label");
    assert.equal(branch[at + 2].type, "custom_message");
    assert.equal(f.sm.getLeafId(), branch[at + 2].id);
    // The abandoned branch keeps the rewind call and its result, marked as
    // finished.
    assert.equal(f.sm.getLabel(f.leafBeforeFold), "branch:end");
    assert.ok(f.sm.getEntry(f.leafBeforeFold));
    assert.ok(!branch.some((e) => e.id === f.leafBeforeFold));
  });

  it("delivers the continuation as a boundary entry: buildRewindDoneText content, continue, done details", async () => {
    const f = await rewindFixture();
    const calls = rewindMessages(f.pi);
    assert.equal(calls.length, 1);
    const { message } = calls[0];
    assert.equal(calls[0].continue, true);
    assert.equal(message.type, "custom_message");
    assert.equal(message.customType, REWIND_CUSTOM_TYPE);
    assert.equal(message.display, true);
    const d = message.details;
    assert.equal(
      message.content,
      buildRewindDoneText(
        {
          rewindTo: "start",
          newLabel: "end",
          beforeTokens: d.contextBefore as number,
          contextWindow: 1_000_000,
        },
        d.contextAfter as number,
      ),
    );
    assert.deepEqual(d, {
      status: "done",
      rewindTo: "start",
      newLabel: "end",
      targetId: f.anchorId,
      summaryId: d.summaryId,
      collapsedEntries: d.collapsedEntries,
      contextBefore: d.contextBefore,
      contextAfter: d.contextAfter,
      contextWindow: 1_000_000,
      origin: "agent",
      summaryStrategy: "chunked",
      summaryCalls: d.summaryCalls,
      foldEstimateBefore: d.foldEstimateBefore,
      foldEstimateAfter: d.foldEstimateAfter,
      agentMessagesRefreshed: true,
      historyRewriteNotified: false,
      readFiles: [],
      modifiedFiles: [],
      reappendedLateMessages: 0,
      openUserRequests: [],
    });
    // Collapsed: the anchor's label-change entry, u2..a4 (6), the rewind
    // call and its result, all left on the abandoned branch.
    assert.equal(d.collapsedEntries, 9);
    assert.ok(Number(d.summaryCalls) >= 2, "a map call and the reduce");
    assert.ok(
      (d.contextBefore as number) > (d.contextAfter as number),
      "the rewound chain must be smaller",
    );
    assert.ok(
      Number(d.foldEstimateAfter) > SUMMARY_TEXT.length / 4,
      "the fold check includes continuation overhead",
    );
    assert.ok(Number(d.foldEstimateAfter) < Number(d.foldEstimateBefore));
  });

  it("continuation prose: [rewind] header + pending-work guidance", async () => {
    const f = await rewindFixture();
    const text = f.done.message.content;
    assert.match(text, /^\[rewind to 'start' · collapsed as 'end'\] · /);
    assert.match(text, /### Done/);
    assert.match(text, /### In Progress/);
    assert.match(text, /### Blocked/);
    assert.match(text, /## Next Steps/);
    assert.match(text, /are the resume point/);
    assert.match(text, /It is the newest branch_summary, the current state/);
    assert.match(text, /continue the latest branch_summary's work/);
  });

  it("continuation prose: the authority order outranks the summary, and retained messages keep their standing instructions", async () => {
    const f = await rewindFixture();
    const text = f.done.message.content;
    assert.match(
      text,
      /A branch_summary marks a milestone, not the end of the task/,
    );
    assert.match(
      text,
      /Your authority, highest first: the user's standing instruction retained above \(including any authorization to work autonomously until the task is complete or a real blocker appears\), the authorized plan or todo list, then this summary's open items/,
    );
    assert.match(
      text,
      /If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope/,
    );
    assert.match(
      text,
      /do not re-answer them; their standing instructions still apply/,
    );
    assert.doesNotMatch(text, /predate this rewind/);
    assert.doesNotMatch(text, /execute them next/);
  });

  it("refreshes agent.state.messages to the rewound chain", async () => {
    const f = await rewindFixture();
    assert.ok(f.fake);
    assert.equal(f.done.message.details.agentMessagesRefreshed, true);
    // pi commits the receipt after the handlers, once the state is refreshed.
    const chain = f.sm.buildSessionContext().messages;
    assert.deepEqual(f.fake.agent.state.messages, chain.slice(0, -1));
    assert.equal(
      (chain.at(-1) as { customType?: string }).customType,
      REWIND_CUSTOM_TYPE,
    );
  });

  it("bootstrap-missing: continuation carries the rewind warning and refreshed=false", async () => {
    const f = await rewindFixture({ capture: false });
    assert.equal(f.done.message.details.status, "done");
    assert.equal(f.done.message.details.agentMessagesRefreshed, false);
    assert.ok(
      f.done.message.content.endsWith(
        `\n\n${__testHooks.REFLECTION_BOOTSTRAP_WARNING_REWIND}`,
      ),
    );
  });

  it("strips any preamble before '## Goal' from the stored summary", async () => {
    const f = await rewindFixture({
      summary: `Sure — here is the summary.\n\n${SUMMARY_TEXT}\n\n`,
    });
    const entry = f.sm.getEntry(f.done.message.details.summaryId as string);
    assert.ok(entry && entry.type === "branch_summary");
    assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
  });

  it("appends read/modified file tags from read/edit/write calls in the collapsed segment", async () => {
    const f = setup();
    const t1 = appendTurn(f.sm, "u1", "a1", 6_000);
    f.pi.pi.setLabel(t1.assistantId, "anchor:start");
    appendToolCallAssistant(
      f.sm,
      [
        { id: "r1", name: "read", arguments: { path: "src/a.ts" } },
        { id: "r2", name: "read", arguments: { path: "src/b.ts" } },
        { id: "e1", name: "edit", arguments: { path: "src/b.ts" } },
        { id: "w1", name: "write", arguments: { path: "src/c.ts" } },
      ],
      12_000,
    );
    for (const id of ["r1", "r2", "e1", "w1"]) {
      appendToolResult(f.sm, id, "read", "ok");
    }
    appendTurn(f.sm, "u3", "a3", 24_000, true);
    await requestRewind(f);
    const { details } = rewindMessages(f.pi)[0].message;
    assert.deepEqual(details.readFiles, ["src/a.ts"]);
    assert.deepEqual(details.modifiedFiles, ["src/b.ts", "src/c.ts"]);
    const entry = f.sm.getEntry(details.summaryId as string);
    assert.ok(entry && entry.type === "branch_summary");
    assert.equal(
      entry.summary,
      `# Work handoff: end\n\n${SUMMARY_TEXT}\n\n<read-files>\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>`,
    );
    const fileDetails = entry.details as {
      readFiles: string[];
      modifiedFiles: string[];
    };
    assert.deepEqual(fileDetails.readFiles, ["src/a.ts"]);
    assert.deepEqual(fileDetails.modifiedFiles, ["src/b.ts", "src/c.ts"]);
  });

  it("emits session_tree after the rewind so history mirrors rebuild (#79)", async () => {
    // pi-claude-bridge mirrors the conversation in a Claude Code session and
    // rebuilds it only on `session_tree` / `session_compact`. A tool-driven
    // rewind must emit the same event pi's own navigateTree emits, AFTER the
    // branch and the agent-state refresh, so a handler reading the session
    // sees the rewound chain.
    const f = setup();
    setupRewindable(f.sm, f.pi);
    const fake = makeFakeSession(f.sm);
    const events: Array<Record<string, unknown>> = [];
    let messagesAtEmit: unknown[] | undefined;
    let deliveredBeforeEmit = -1;
    fake._extensionRunner = {
      emit: async (event) => {
        events.push(event as Record<string, unknown>);
        messagesAtEmit = fake.agent.state.messages;
        deliveredBeforeEmit = rewindMessages(f.pi).length;
      },
    };
    __testHooks.captureSession(fake as unknown as AgentSession);
    const { leafBeforeFold } = await requestRewind(f);

    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.historyRewriteNotified, true);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.type, "session_tree");
    assert.equal(
      event.oldLeafId,
      leafBeforeFold,
      "old leaf = the abandoned branch's last entry",
    );
    assert.equal(
      f.sm.getEntry(f.sm.getLeafId() as string)?.parentId,
      event.newLeafId,
      "the receipt follows the new leaf",
    );
    assert.equal(
      f.sm.getEntry(event.newLeafId as string)?.parentId,
      done.details.summaryId,
      "new leaf = the label entry on the summary",
    );
    assert.equal(
      (event.summaryEntry as { id?: string } | undefined)?.id,
      done.details.summaryId,
    );
    assert.equal(event.fromExtension, true);
    assert.deepEqual(
      messagesAtEmit,
      f.sm.buildSessionContext().messages.slice(0, -1),
      "the chain before pi commits the receipt",
    );
    assert.equal(
      deliveredBeforeEmit,
      0,
      "emit precedes the continuation message",
    );
  });

  it("reports historyRewriteNotified=false without a reachable runner (#79)", async () => {
    const f = await rewindFixture();
    assert.equal(f.done.message.details.agentMessagesRefreshed, true);
    assert.equal(f.done.message.details.historyRewriteNotified, false);
  });

  it("a throwing session_tree handler does not fail the rewind (#79)", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    const fake = makeFakeSession(f.sm);
    fake._extensionRunner = {
      emit: async () => {
        throw new Error("handler boom");
      },
    };
    __testHooks.captureSession(fake as unknown as AgentSession);
    await requestRewind(f);
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    assert.equal(done.details.historyRewriteNotified, false);
    assert.match(done.content, /^\[rewind to 'start'/);
  });

  it("a throwing pi.sendMessage cannot affect delivery (rewind messages never use it)", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    (
      f.pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
    ).sendMessage = () => {
      throw new Error("stale session runtime");
    };
    const { boundary } = await requestRewind(f);
    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries.length, 1);
    assert.equal(boundary.entries[0].details.status, "done");
    // Committed by pi (replicated by `fireTurnEndAll`) after the branch_summary.
    const leaf = f.sm.getEntry(f.sm.getLeafId() as string);
    assert.ok(leaf && leaf.type === "custom_message");
    assert.equal(leaf.customType, REWIND_CUSTOM_TYPE);
    assert.equal(leaf.display, true);
    assert.match(String(leaf.content), /^\[rewind to 'start'/);
    assert.ok(
      f.sm.getBranch().some((e) => e.type === "branch_summary"),
      "the continuation follows the branch_summary on the active branch",
    );
  });

  it("setLabel throw falls back to appendLabelChange for both labels", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    (f.pi.pi as { setLabel: typeof f.pi.pi.setLabel }).setLabel = () => {
      throw new Error("stale session runtime");
    };
    const { leafBeforeFold } = await requestRewind(f);
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    assert.equal(f.sm.getLabel(done.details.summaryId as string), "anchor:end");
    assert.equal(f.sm.getLabel(leafBeforeFold), "branch:end");
  });

  it("chained rewinds: a→b then b→c keeps prior labels and re-anchors the new summary", async () => {
    const f = setup();
    const tA = appendTurn(f.sm, "u1", "a1", 6_000);
    f.pi.pi.setLabel(tA.assistantId, "anchor:a");
    appendTurn(f.sm, "u2", "a2", 12_000, true);
    appendTurn(f.sm, "u3", "a3", 18_000, true);
    __testHooks.captureSession(
      makeFakeSession(f.sm) as unknown as AgentSession,
    );

    await requestRewind(f, { ...REWIND_ARGS, rewindTo: "a", newLabel: "b" });
    const first = rewindMessages(f.pi)[0].message;
    assert.equal(first.details.status, "done");
    const sumB = first.details.summaryId as string;

    appendTurn(f.sm, "u4", "a4", 24_000, true);
    appendTurn(f.sm, "u5", "a5", 30_000, true);
    const { result: r2 } = await requestRewind(
      f,
      {
        ...REWIND_ARGS,
        rewindTo: "b",
        newLabel: "c",
        summaryFocus: "Preserve user instructions across the second rewind.",
      },
      "tc-2",
    );
    assert.equal(r2.details.targetId, sumB);
    const second = rewindMessages(f.pi)[1].message;
    assert.equal(second.details.status, "done");
    const sumC = second.details.summaryId as string;
    assert.equal(f.sm.getEntry(sumC)?.parentId, sumB);
    assert.equal(f.sm.getLabel(sumC), "anchor:c");
    assert.equal(
      f.sm.getLabel(sumB),
      "anchor:b",
      "the b-summary's anchor:b label must survive the second rewind",
    );
    assert.equal(f.sm.getLabel(tA.assistantId), "anchor:a");
    const leaf = f.sm.getEntry(f.sm.getLeafId() as string);
    assert.equal(
      f.sm.getEntry(leaf?.parentId as string)?.parentId,
      sumC,
      "the continuation follows the c-summary's label",
    );
  });

  it("refuses a growing materialized summary without writing a branch or completion label", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    f.ctx.modelRegistry = fakeRegistry(() =>
      reply(`${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`),
    ).registry;
    const { boundary, leafBeforeFold } = await requestRewind(f);
    assert.equal(
      f.sm.getEntries().filter((entry) => entry.type === "branch_summary")
        .length,
      0,
    );
    assert.equal(f.sm.getLabel(leafBeforeFold), undefined);
    assert.ok(
      !f.sm
        .getBranch()
        .some((entry) => f.sm.getLabel(entry.id) === "anchor:end"),
    );
    assert.equal(
      boundary.continue,
      false,
      "commit-stage refusals stop the run",
    );
    assert.equal(boundary.entries[0].details.status, "failed");
    assert.equal(boundary.entries[0].details.stage, "commit");
    assert.match(
      String(boundary.entries[0].details.detail),
      /does not reduce projected context/,
    );
    assert.equal(fireToolCall(f.pi, f.ctx), undefined);
  });

  it("compares fold content on the same heuristic despite low recorded usage", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { tokenCounts: [6000, 8000, 10000, 11000] });
    f.ctx.modelRegistry = fakeRegistry(() =>
      reply(`${SUMMARY_TEXT}\n${"evidence ".repeat(4500)}`),
    ).registry;
    await requestRewind(f);
    const done = rewindMessages(f.pi).at(-1)?.message;
    assert.equal(done?.details.status, "done");
    assert.ok(
      Number(done?.details.foldEstimateAfter) <
        Number(done?.details.foldEstimateBefore),
    );
  });

  it("checks the currently edited view rather than the old pre-withholding measurement", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    // The context is edited while the summary is being written.
    f.ctx.modelRegistry = fakeRegistry((_call, index) => {
      if (index === 0) {
        for (const entry of f.sm.getBranch()) {
          if (entry.type === "message" && entry.message.role === "user")
            f.sm.appendContextEdit(entry.id, { content: "short" });
        }
      }
      return reply(SUMMARY_TEXT);
    }).registry;
    const { boundary } = await requestRewind(f);
    assert.equal(
      f.sm.getEntries().filter((entry) => entry.type === "branch_summary")
        .length,
      0,
    );
    assert.match(
      String(boundary.entries[0].details.detail),
      /does not reduce projected context/,
    );
  });

  it("includes full child reports in the net-fold check", async () => {
    const f = setup();
    await configureParentMode(f, "full");
    setupRewindable(f.sm, f.pi);
    const leaf = f.sm.getLeafId();
    assert.ok(leaf);
    f.sm.branchWithSummary(
      leaf,
      `CHILD ${"evidence ".repeat(12_000)}`,
      {},
      true,
    );
    f.ctx.modelRegistry = fakeRegistry(() =>
      reply(`${SUMMARY_TEXT}\n${"report ".repeat(16_000)}`),
    ).registry;
    const beforeCount = f.sm
      .getEntries()
      .filter((entry) => entry.type === "branch_summary").length;
    const { boundary } = await requestRewind(f);
    assert.equal(
      f.sm.getEntries().filter((entry) => entry.type === "branch_summary")
        .length,
      beforeCount,
    );
    assert.match(
      String(boundary.entries[0].details.detail),
      /does not reduce projected context/,
    );
  });

  it("folds an earlier child handoff into a parent once and projects honest work context", async () => {
    const f = await rewindFixture({ mode: "full" });
    const childId = f.done.message.details.summaryId as string;
    appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
    appendTurn(f.sm, "parent-verification", "parent-result", 30000, true);
    const parentReport =
      "## Goal\nParent scope\n\n## Progress\nParent final outcome\n\n## Next Steps\nContinue.";
    const parentRegistry = fakeRegistry(() => reply(parentReport));
    f.ctx.modelRegistry = parentRegistry.registry;
    await requestRewind(
      f,
      { ...REWIND_ARGS, rewindTo: "start", newLabel: "parent" },
      "tc-parent",
    );
    const instruction = parentRegistry.calls.at(-1)?.context.messages.at(-1);
    assert.match(JSON.stringify(instruction), /no fixed 4000-character cap/);
    const latest = rewindMessages(f.pi).at(-1);
    assert.ok(latest);
    const parent = f.sm.getEntry(latest.message.details.summaryId as string);
    assert.ok(parent?.type === "branch_summary");
    assert.equal(
      parent.summary.split("Test the rewind happy path.").length - 1,
      1,
    );
    assert.match(parent.summary, /Parent final outcome/);
    const details = parent.details as {
      treeNavigator: { children: string[]; sourceIds: string[] };
    };
    assert.deepEqual(details.treeNavigator.children, [childId]);
    assert.equal(
      new Set(details.treeNavigator.sourceIds).size,
      details.treeNavigator.sourceIds.length,
    );
    const projected = __testHooks.buildContextMessages(f.sm);
    assert.equal(
      projected.filter(
        (message) =>
          message.role === "custom" &&
          message.customType === "navigate-tree-handoff",
      ).length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(projected),
      /explored a different conversation|came back from/,
    );
  });

  it("defaults parent folds to a digest while retaining full child evidence for synthesis", async () => {
    const f = await rewindFixture();
    const childId = f.done.message.details.summaryId as string;
    const child = f.sm.getEntry(childId);
    assert.ok(child?.type === "branch_summary");
    appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
    appendTurn(f.sm, "parent-verification", "parent-result", 30000, true);
    const parentReport =
      "## Goal\nParent scope\n\n## Outcome\nParent delivered.";
    const registry = fakeRegistry(() => reply(parentReport));
    f.ctx.modelRegistry = registry.registry;
    await requestRewind(
      f,
      { ...REWIND_ARGS, rewindTo: "start", newLabel: "digest-parent" },
      "tc-digest",
    );
    const latest = rewindMessages(f.pi).at(-1);
    assert.ok(latest);
    const parent = f.sm.getEntry(latest.message.details.summaryId as string);
    assert.ok(parent?.type === "branch_summary");
    const handoff = getHandoff(parent);
    assert.ok(handoff);
    assert.equal(handoff.mode, "digest");
    assert.match(parent.summary, /Earlier handoffs in this span \(digest\)/);
    assert.ok(parent.summary.includes(`entry ${childId}`));
    assert.ok(!parent.summary.includes(child.summary));
    assert.ok(!parent.summary.includes(SUMMARY_TEXT));
    assert.ok(
      JSON.stringify(registry.calls).includes("Test the rewind happy path."),
    );
    const full = materializeHandoff({ ...handoff, mode: "full" }, [
      { id: childId, summary: child.summary },
    ]);
    assert.ok(parent.summary.length < full.length);
  });

  it("includes a native child summary’s own generation usage in parent recorded statistics", async () => {
    const f = setup();
    const anchor = appendTurn(f.sm, "root-user", "root-answer", 6000);
    f.pi.pi.setLabel(anchor.assistantId, "anchor:start");
    appendTurn(f.sm, "child-user", "child-answer", 12000);
    const childId = f.sm.branchWithSummary(
      anchor.assistantId,
      "## Goal\nNative child",
      {},
      true,
      {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, total: 7 },
      },
    );
    f.pi.pi.setLabel(childId, "anchor:child");
    appendTurn(f.sm, "parent-work", "parent-delivery", 24000, true);
    __testHooks.captureSession(
      makeFakeSession(f.sm) as unknown as AgentSession,
    );
    await requestRewind(f, { ...REWIND_ARGS, newLabel: "parent" });
    const done = rewindMessages(f.pi).at(-1);
    assert.ok(done);
    const entry = f.sm.getEntry(done.message.details.summaryId as string);
    assert.ok(entry?.type === "branch_summary");
    const details = entry.details as {
      treeNavigator: { sourceIds: string[]; stats: { cost: number } };
    };
    assert.ok(details.treeNavigator.sourceIds.includes(childId));
    assert.equal(details.treeNavigator.stats.cost, 7);
  });

  it("immediate re-rewind of a just-landed summary is refused and queues nothing", async () => {
    const f = await rewindFixture();
    const { result, boundary } = await requestRewind(
      f,
      { ...REWIND_ARGS, rewindTo: "end", newLabel: "again" },
      "tc-2",
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.rejected, "min-savings");
    assert.equal(boundary.entries.length, 0);
    assert.equal(fireToolCall(f.pi, f.ctx), undefined);
  });

  it("never calls pi.sendMessage / sendUserMessage for rewind messages", async () => {
    const f = await rewindFixture();
    assert.equal(f.done.message.details.status, "done");
    assert.deepEqual(f.pi.sendMessageCalls, []);
    assert.deepEqual(f.pi.sendUserMessageCalls, []);
  });

  it("keeps entries from a handler earlier in the chain: [foreign, ours]", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const foreign: BoundaryDraft = {
      type: "custom_message",
      customType: "other-extension",
      content: "queued by another extension",
      display: false,
      details: { from: "other" },
    };
    const { boundary } = await requestRewind(
      f,
      REWIND_ARGS,
      "tc-rewind",
      undefined,
      {
        entries: [foreign],
      },
    );
    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries.length, 2);
    assert.equal(boundary.entries[0], foreign, "the foreign draft, untouched");
    assert.equal(boundary.entries[1].customType, REWIND_CUSTOM_TYPE);
    assert.equal(boundary.entries[1].details.status, "done");
  });

  it("drops earlier context_edit drafts the rewind made stale, keeps the rest (compactions included)", async () => {
    // pi validates the whole boundary list in a preview and drops ALL of it
    // when one draft fails; a draft targeting an entry the rewind abandoned
    // would take the continuation down with it.
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const anchorId = f.sm
      .getBranch()
      .find((e) => f.sm.getLabel(e.id) === "anchor:start")?.id;
    assert.ok(anchorId);
    const call = appendToolCallAssistant(f.sm, [
      { id: "tc-rewind", name: TOOL_NAME, arguments: REWIND_ARGS },
    ]);
    const result = await f.tool.execute(
      "tc-rewind",
      REWIND_ARGS,
      undefined,
      undefined,
      f.ctx,
    );
    appendToolResult(f.sm, "tc-rewind", TOOL_NAME, result.content[0].text);
    const staleEdit = {
      type: "context_edit",
      targetId: call.id,
      replacement: { content: "x" },
    };
    // pi never validates a compaction's firstKeptEntryId, so compaction
    // drafts pass through untouched — null (self-retaining) and stale ids.
    const staleCompaction = {
      type: "compaction",
      summary: "s",
      firstKeptEntryId: call.id,
    };
    const selfCompaction = {
      type: "compaction",
      summary: "s",
      firstKeptEntryId: null,
    };
    const liveEdit = {
      type: "context_edit",
      targetId: anchorId,
      replacement: { content: "y" },
    };
    const foreign = {
      type: "custom_message",
      customType: "other-extension",
      content: "kept",
      display: true,
      details: {},
    };
    const boundary = await fireTurnEndAll(f.pi, f.ctx, call.message, {
      entries: [
        staleEdit,
        staleCompaction,
        selfCompaction,
        liveEdit,
        foreign,
      ] as never,
    });
    assert.equal(boundary.continue, true);
    assert.deepEqual(
      boundary.entries.slice(0, -1),
      [staleCompaction, selfCompaction, liveEdit, foreign],
      "only the stale context_edit dropped, the rest kept in order",
    );
    assert.equal(boundary.entries.at(-1)?.customType, REWIND_CUSTOM_TYPE);
  });

  it("returns nothing on turns without a queued fold", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi);
    const handlers = f.pi.onCalls.get("turn_end");
    assert.ok(handlers);
    const result = await handlers[0](
      {
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage(
          [{ type: "text", text: SUMMARY_TEXT }],
          "stop",
        ),
        toolResults: [],
        entries: [],
        continue: false,
      } as never,
      f.ctx as never,
    );
    assert.equal(result, undefined);
  });
});

// =============================================================================
// TUI renderers
// =============================================================================

describe("rewind: TUI renderers", () => {
  it("wrapPlainLine word-wraps and hard-breaks long words", () => {
    assert.deepEqual(wrapPlainLine("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
    assert.deepEqual(wrapPlainLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    assert.deepEqual(wrapPlainLine("short", 10), ["short"]);
  });

  it("wrapPlainLine wraps by terminal cells: CJK, emoji and tabs never exceed the width", () => {
    for (const text of [
      "保持用户指令并继续工作，直到完成所有任务为止。".repeat(3),
      "🚀🔥✅ emoji focus 🧪🧪🧪🧪🧪🧪🧪🧪🧪🧪",
      "\tTabbed\tfocus\twith\ttabs\teverywhere\t\t\t",
    ]) {
      for (const width of [1, 2, 3, 5, 8, 13, 400]) {
        for (const line of wrapPlainLine(text, width)) {
          assert.ok(
            visibleWidth(line) <= width,
            `${JSON.stringify(line)} is ${visibleWidth(line)} cells > ${width}`,
          );
          assert.ok(!line.includes("\t"), `${JSON.stringify(line)} has a tab`);
        }
      }
    }
  });

  it("registers compact historical rewind renderers and expands the old instruction", () => {
    const f = setup();
    const summaryRenderer = f.pi.messageRenderers.get(
      LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
    ) as (...args: unknown[]) => { render(width: number): string[] };
    const outcomeRenderer = f.pi.entryRenderers.get(
      LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
    ) as (
      ...args: unknown[]
    ) => { render(width: number): string[] } | undefined;
    assert.ok(summaryRenderer);
    assert.ok(outcomeRenderer);
    const theme = {
      fg: (color: string, text: string) =>
        `\x1b[${color === "error" ? "31" : color === "warning" ? "33" : "36"}m${text}\x1b[39m`,
    };
    const instruction = `Summarize historical work only.\n${"Preserve the original instruction in full. ".repeat(8)}`;
    const message = {
      role: "custom",
      customType: LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
      content: `${instruction}\nDo not show this escape: \x1b[2J hidden.\x01`,
      display: true,
      details: {
        rewindTo: "a",
        newLabel: "b",
        contextBefore: 80_000,
        tokensAtTarget: 40_000,
        contextWindow: 100_000,
      },
      timestamp: 0,
    };
    for (const width of [60, 130]) {
      const collapsed = summaryRenderer(
        message,
        { expanded: false, outputPad: 1 },
        theme,
      ).render(width);
      assert.equal(collapsed.length, 1);
      assert.ok(visibleWidth(collapsed[0] ?? "") <= width);
      assert.match(
        stripVTControlCharacters(collapsed[0] ?? ""),
        /summary requested/,
      );

      const expanded = summaryRenderer(
        message,
        { expanded: true, outputPad: 1 },
        theme,
      ).render(width);
      assert.ok(expanded.length > 1);
      assert.ok(expanded.every((line) => visibleWidth(line) <= width));
      const expandedText = stripVTControlCharacters(expanded.join("\n"));
      assert.ok(
        expandedText
          .replace(/\s+/gu, " ")
          .includes(instruction.replace(/\s+/gu, " ")),
        `the full instruction is retained at ${width} columns`,
      );
      assert.ok(
        !expandedText.includes("[2J") && !expandedText.includes("\x01"),
        "historical escapes and controls are removed",
      );

      for (const [status, color] of [
        ["failed", "31"],
        ["aborted", "33"],
      ] as const) {
        const rendered = outcomeRenderer(
          {
            data: {
              status,
              rewindTo: "a",
              newLabel: "b",
              reason: `branch failed \x1b[2J hidden`,
            },
          },
          { expanded: false, outputPad: 1 },
          theme,
        );
        assert.ok(rendered);
        const row = rendered.render(width);
        assert.equal(row.length, 1);
        assert.ok(visibleWidth(row[0] ?? "") <= width);
        assert.ok(row[0]?.includes(`\x1b[${color}m`));
        assert.ok(!stripVTControlCharacters(row[0] ?? "").includes("[2J"));
      }
    }
  });

  it("renderers never emit a line wider than the terminal (pi-tui crashes on one)", async () => {
    const ansi = {
      fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
    };
    const f = setup();
    const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (
      ...a: unknown[]
    ) => { render(w: number): string[] };
    assert.ok(renderer);
    const failed = {
      role: "custom",
      customType: REWIND_CUSTOM_TYPE,
      content:
        "[navigate_tree] Fold to '开始' (collapse as '结束🚀') failed at the commit stage (commit-refused): the branch could not be written (磁盘已满 🚫\tdisk)\n\nNothing was collapsed.",
      display: true,
      details: { status: "failed" },
      timestamp: 0,
    };
    for (const width of [1, 2, 3, 7, 10, 17, 40, 400]) {
      for (const line of renderer(
        failed,
        { expanded: true, outputPad: 1 },
        ansi,
      ).render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `${JSON.stringify(line)} is ${visibleWidth(line)} cells > ${width}`,
        );
        // Tabs are expanded to spaces: no raw tab reaches a row.
        assert.ok(!line.includes("\t"), `${JSON.stringify(line)} has a tab`);
      }
    }
  });
});

// =============================================================================
// extractSummaryText
// =============================================================================

describe("extractSummaryText", () => {
  it("returns the text from the '## Goal' heading on, trimmed", () => {
    assert.equal(extractSummaryText(`${SUMMARY_TEXT}\n\n`), SUMMARY_TEXT);
  });

  it("drops a preamble before the heading", () => {
    assert.equal(
      extractSummaryText(`Here you go:\n\n${SUMMARY_TEXT}`),
      SUMMARY_TEXT,
    );
  });

  it("returns null without a line-start '## Goal' heading", () => {
    for (const text of [
      "",
      "Okay, summarizing.",
      "### Goal\nx",
      "## Goals\nx",
      "text ## Goal inline",
      "## goal\nlowercase",
    ]) {
      assert.equal(extractSummaryText(text), null, JSON.stringify(text));
    }
  });

  it("refuses a bare heading line: the body after it must be non-empty", () => {
    assert.equal(extractSummaryText("## Goal"), null);
    assert.equal(extractSummaryText("## Goal: ship"), null);
    assert.equal(extractSummaryText("preamble\n## Goal   \n\n  "), null);
    assert.equal(extractSummaryText("## Goal\nx"), "## Goal\nx");
    assert.equal(extractSummaryText("## Goal: ship\nx"), "## Goal: ship\nx");
  });
});
// =============================================================================
// fold summary blocks and late-entry re-append (#80)
// =============================================================================

describe("rewind: multi-block summaries and late entries", () => {
  /** The summary reply as the provider streams it: one text block per entry. */
  const replyBlocks = (texts: string[]) => ({
    ...reply(""),
    content: texts.map((text) => ({ type: "text" as const, text })),
  });

  async function summaryBlocksRewind(texts: string[]) {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    f.ctx.modelRegistry = fakeRegistry(() => replyBlocks(texts)).registry;
    await requestRewind(f);
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    const entry = f.sm.getEntry(done.details.summaryId as string);
    assert.ok(entry && entry.type === "branch_summary");
    return entry;
  }

  it("joins text blocks with a newline: a preamble block before the summary completes", async () => {
    const entry = await summaryBlocksRewind([
      "Here is the summary:",
      SUMMARY_TEXT,
    ]);
    assert.equal(entry.summary, `# Work handoff: end\n\n${SUMMARY_TEXT}`);
  });

  it("a heading split across blocks is joined with a newline, not glued", async () => {
    // `""` join would yield "## GoalShip it." — no `## Goal\b` heading.
    const entry = await summaryBlocksRewind([
      "## Goal",
      "Ship it.\n\n## Next Steps\n1. x",
    ]);
    assert.equal(
      entry.summary,
      `# Work handoff: end\n\n## Goal\nShip it.\n\n## Next Steps\n1. x`,
    );
  });

  const NOTE_ONE =
    "The message between the branch_summary and this one arrived while the rewind was pending — it is new and still unanswered; handle it now.";
  const NOTE_TWO =
    "The 2 messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.";

  function appendLateUser(sm: SessionManager, text: string): string {
    return sm.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    } as never);
  }

  /**
   * The rewind call whose fold runs at its `turn_end`; `late` runs while the
   * first summary side call is in flight, so what it appends arrives after
   * the fold point.
   */
  async function rewindWithLate(
    f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx; tool: CapturedTool },
    late: () => void,
  ) {
    f.ctx.modelRegistry = fakeRegistry((_call, index) => {
      if (index === 0) late();
      return reply(SUMMARY_TEXT);
    }).registry;
    return requestRewind(f);
  }

  /** Active-branch entries from the new branch_summary on, as compact tags. */
  function tailAfterSummary(sm: SessionManager, withReceipt = false): string[] {
    const branch = sm.getBranch();
    const at = branch.findIndex((e) => e.type === "branch_summary");
    assert.ok(at >= 0, "a branch_summary must be on the active branch");
    return branch
      .slice(at)
      .filter(
        (e) =>
          withReceipt ||
          !(e.type === "custom_message" && e.customType === REWIND_CUSTOM_TYPE),
      )
      .map((e) => {
        if (e.type === "message") {
          return `${e.message.role}:${JSON.stringify(
            (e.message as { content?: unknown }).content,
          )}`;
        }
        if (e.type === "custom_message") {
          return `custom:${e.customType}:${JSON.stringify(e.content)}`;
        }
        return e.type;
      });
  }

  /** The newest active-branch entry before the fold's receipt. */
  function lastBeforeReceipt(sm: SessionManager) {
    const branch = sm.getBranch();
    const receipt = branch.at(-1);
    assert.ok(
      receipt?.type === "custom_message" &&
        receipt.customType === REWIND_CUSTOM_TYPE,
      "the receipt ends the branch",
    );
    return branch.at(-2);
  }

  it("re-appends a late user steer and another extension's message, in order, onto the new branch", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const late: string[] = [];
    await rewindWithLate(f, () => {
      late.push(appendLateUser(f.sm, "steer: also fix the docs"));
      late.push(
        f.sm.appendCustomMessageEntry(
          "subagent-result",
          "subagent finished: 3 files changed",
          true,
          { job: 7 },
        ),
      );
    });

    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    assert.equal(done.details.reappendedLateMessages, 2);
    assert.deepEqual(tailAfterSummary(f.sm), [
      "branch_summary",
      "label",
      'user:[{"type":"text","text":"steer: also fix the docs"}]',
      'custom:subagent-result:"subagent finished: 3 files changed"',
    ]);
    const last = lastBeforeReceipt(f.sm);
    assert.ok(last && last.type === "custom_message");
    assert.equal(last.display, true);
    assert.deepEqual(last.details, { job: 7 });
    // Re-appended copies, not the originals (those stay on the abandoned
    // segment).
    const branchIds = new Set(f.sm.getBranch().map((e) => e.id));
    for (const id of late) {
      assert.ok(f.sm.getEntry(id), "the original stays on disk");
      assert.ok(!branchIds.has(id), "but off the active branch");
    }
    // No steer queue: re-appends never go back through input handlers.
    assert.deepEqual(f.pi.sendUserMessageCalls, []);
    assert.ok(done.content.endsWith(`\n\n${NOTE_TWO}`));
  });

  it("the continuation follows the re-appended entries once delivered", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    await rewindWithLate(f, () => appendLateUser(f.sm, "steer"));
    const done = rewindMessages(f.pi)[0].message;
    assert.deepEqual(tailAfterSummary(f.sm, true), [
      "branch_summary",
      "label",
      'user:[{"type":"text","text":"steer"}]',
      `custom:${REWIND_CUSTOM_TYPE}:${JSON.stringify(done.content)}`,
    ]);
  });

  it("the late note is byte-exact for one message", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    await rewindWithLate(f, () => appendLateUser(f.sm, "steer"));
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.reappendedLateMessages, 1);
    assert.ok(done.content.endsWith(`\n\n${NOTE_ONE}`));
    assert.equal(buildLateEntriesNote(1), NOTE_ONE);
    assert.equal(buildLateEntriesNote(2), NOTE_TWO);
    assert.equal(
      buildLateEntriesNote(3),
      "The 3 messages between the branch_summary and this one arrived while the rewind was pending — they are new and still unanswered; handle them now.",
    );
  });

  it("does not re-append a rewind-hint message that landed after the rewind call", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    await rewindWithLate(f, () => {
      f.sm.appendCustomMessageEntry(
        REWIND_HINT_CUSTOM_TYPE,
        expectedHint(91),
        true,
        undefined,
      );
      appendLateUser(f.sm, "steer");
    });
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    assert.equal(done.details.reappendedLateMessages, 1);
    assert.deepEqual(tailAfterSummary(f.sm), [
      "branch_summary",
      "label",
      'user:[{"type":"text","text":"steer"}]',
    ]);
  });

  it("a re-appended hidden custom message stays hidden (display: false)", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    await rewindWithLate(f, () => {
      f.sm.appendCustomMessageEntry("timer", "tick", false, { n: 1 });
    });
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.reappendedLateMessages, 1);
    assert.deepEqual(tailAfterSummary(f.sm), [
      "branch_summary",
      "label",
      'custom:timer:"tick"',
    ]);
    const last = lastBeforeReceipt(f.sm);
    assert.ok(last && last.type === "custom_message");
    assert.equal(last.display, false);
    assert.deepEqual(last.details, { n: 1 });
  });

  it("entries before the rewind call are not re-appended", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    f.sm.appendCustomMessageEntry("subagent-result", "early", true, {});
    appendLateUser(f.sm, "early user");
    appendTurn(f.sm, "u9", "a9", 34_000);
    await requestRewind(f);
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.reappendedLateMessages, 0);
    assert.deepEqual(tailAfterSummary(f.sm), ["branch_summary", "label"]);
  });

  it("a throwing late-input append fails the rewind and stops the late batch", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    // Arm the appendMessage throw only once the branch has been written.
    const sm = f.sm as unknown as {
      branchWithSummary: (...a: unknown[]) => string;
      appendMessage: (...a: unknown[]) => string;
    };
    const origBranch = sm.branchWithSummary.bind(f.sm);
    sm.branchWithSummary = (...a: unknown[]) => {
      const id = origBranch(...a);
      sm.appendMessage = () => {
        throw new Error("append boom");
      };
      return id;
    };
    let lateId = "";
    const { boundary } = await rewindWithLate(f, () => {
      lateId = appendLateUser(f.sm, "lost steer");
      f.sm.appendCustomMessageEntry("subagent-result", "kept", true, {});
    });
    // The original user input must stay active; a partial fold cannot continue.
    const failed = rewindMessages(f.pi)[0].message;
    assert.equal(failed.details.status, "failed");
    assert.equal(boundary.continue, false);
    assert.match(failed.content, /late input could not be written/);
    assert.ok(!failed.content.includes("Nothing was collapsed"));
    assert.ok(f.sm.getBranch().some((entry) => entry.id === lateId));
    assert.equal(
      f.sm
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "subagent-result",
        ).length,
      1,
      "the custom input after the failed user append was not copied",
    );
  });

  it("late-input cursor restoration failure stops without appending a receipt to the uncertain branch", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const branchWithSummary = f.sm.branchWithSummary.bind(f.sm);
    f.sm.branchWithSummary = (...args) => {
      const id = branchWithSummary(...args);
      const append = f.sm.appendMessage.bind(f.sm);
      f.sm.appendMessage = (...messages) => {
        append(...messages);
        f.sm.branch = () => {
          throw new Error("cursor restoration unavailable");
        };
        throw new Error("late append failed after memory update");
      };
      return id;
    };
    const { boundary } = await rewindWithLate(f, () =>
      appendLateUser(f.sm, "retained original input"),
    );
    assert.equal(boundary.continue, false);
    assert.deepEqual(boundary.entries, []);
    assert.ok(
      f.ctx.notifyCalls.some(
        ([message, level]) =>
          level === "error" &&
          message.includes("could not be restored in memory"),
      ),
    );
    assert.equal(rewindMessages(f.pi).length, 0);
  });

  it("an estimator throw after the branch still delivers the continuation with contextAfter 0", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const sm = f.sm as unknown as {
      branchWithSummary: (...a: unknown[]) => string;
      buildSessionContext: () => unknown;
    };
    const origBranch = sm.branchWithSummary.bind(f.sm);
    sm.branchWithSummary = (...a: unknown[]) => {
      const id = origBranch(...a);
      sm.buildSessionContext = () => {
        throw new Error("estimate boom");
      };
      return id;
    };
    await requestRewind(f);
    const done = rewindMessages(f.pi)[0].message;
    assert.equal(done.details.status, "done");
    assert.equal(done.details.contextAfter, 0);
    assert.equal(done.details.agentMessagesRefreshed, false);
    assert.match(done.content, / → 0\.0% of 1\.0M\n\n/);
    assert.ok(
      f.sm.getBranch().some((e) => e.type === "branch_summary"),
      "the branch landed",
    );
  });

  it("a throwing getBranch during the fold ends the turn without throwing and leaves the history as found", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const sm = f.sm as unknown as { getBranch: () => unknown };
    const origGetBranch = sm.getBranch;
    const entryCount = f.sm.getEntries().length;
    f.ctx.modelRegistry = fakeRegistry(() => {
      sm.getBranch = () => {
        throw new Error("branch boom");
      };
      return reply(SUMMARY_TEXT);
    }).registry;
    try {
      await assert.doesNotReject(() => requestRewind(f));
    } finally {
      sm.getBranch = origGetBranch;
    }
    assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
    assert.equal(
      f.sm.getEntries().length,
      entryCount + 2,
      "only the rewind call and its result were added",
    );
    assert.equal(fireToolCall(f.pi, f.ctx), undefined, "gate reopened");
  });
});

// =============================================================================
// commitFold, engine shape: the fold point is the leaf; input after it follows
// the summary
// =============================================================================

describe("commitFold: engine shape", () => {
  function reopenSession(sm: SessionManager) {
    const path = sm.getSessionFile();
    assert.ok(path);
    return SessionManager.open(path);
  }

  function engineFold(
    f: { sm: SessionManager },
    anchorId: string,
    overrides: Partial<FoldCommitInput> = {},
  ) {
    const leaf = f.sm.getLeafId() as string;
    const lead: number[] = [];
    const input: FoldCommitInput = {
      targetId: anchorId,
      rewindTo: "start",
      newLabel: "end",
      summaryText: SUMMARY_TEXT,
      handoffMode: "full",
      contextWindow: 200_000,
      foldPointId: leaf,
      branchLabelEntryId: leaf,
      continuationText: (afterTokens) => {
        lead.push(afterTokens);
        return `folded to ${afterTokens}`;
      },
      writeLabel: (entryId, label) => {
        f.sm.appendLabelChange(entryId, label);
        return true;
      },
      ...overrides,
    };
    return { leaf, lead, input };
  }

  it("branches from the target, labels both ends and re-appends input after the fold point", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const run = engineFold(f, anchorId);
    const lateId = f.sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "late steer" }],
      timestamp: 1,
    } as never);
    const outcome = await commitFold(f.sm, run.input);
    assert.ok(outcome.ok);
    const summary = f.sm.getEntry(outcome.summaryId);
    assert.ok(summary && summary.type === "branch_summary");
    assert.equal(summary.parentId, anchorId);
    assert.equal(outcome.oldLeafId, lateId);
    assert.equal(f.sm.getLabel(run.leaf), "branch:end");
    assert.equal(f.sm.getLabel(outcome.summaryId), "anchor:end");
    assert.equal(outcome.reappended, 1);
    const branch = f.sm.getBranch();
    const tail = branch
      .slice(branch.findIndex((e) => e.id === outcome.summaryId) + 1)
      .filter((e) => e.type !== "label");
    assert.equal(tail.length, 1);
    assert.notEqual(tail[0].id, lateId);
    assert.ok(tail[0].type === "message" && tail[0].message.role === "user");
    assert.equal(tail[0].id, f.sm.getLeafId());
    assert.ok(outcome.refreshed);
    assert.ok(outcome.foldEstimateAfter < outcome.foldEstimateBefore);
    assert.equal(outcome.afterTokens, estimateAdmissionTokens(f.sm));
    assert.equal(
      outcome.continuation,
      `folded to ${outcome.afterTokens}\n\n${buildLateEntriesNote(1)}`,
    );
    assert.equal(run.lead.length, 2, "prospective estimate, then final");
  });

  it("late-input persistence failure restores the original branch without dangling receipt parents", async () => {
    for (const persistent of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "fold-persistence-"));
      try {
        const sm = SessionManager.create(dir, dir);
        const pi = makeFakePi(sm);
        const { anchorId } = setupRewindable(sm, pi);
        const run = engineFold({ sm }, anchorId);
        const originalInput = sm.appendMessage({
          role: "user",
          content: "late original",
          timestamp: 1,
        });
        const originalLeaf = sm.appendCustomMessageEntry(
          "subagent-result",
          "late result",
          true,
        );
        const internals = sm as unknown as {
          _persist(entry: SessionEntry): void;
        };
        const persist = internals._persist.bind(sm);
        let failedId = "";
        internals._persist = (entry) => {
          if (failedId && persistent)
            throw new Error("persistent disk failure");
          if (
            entry.type === "message" &&
            entry.message.role === "user" &&
            !failedId
          ) {
            failedId = entry.id;
            throw new Error("injected late-input disk failure");
          }
          persist(entry);
        };
        const outcome = await commitFold(sm, run.input);
        assert.ok(!outcome.ok, JSON.stringify(outcome));
        assert.match(outcome.reason, /late input could not be written/);
        assert.match(outcome.reason, /[Pp]ersistence.*uncertain/);
        if (persistent) {
          assert.equal(sm.getLeafId(), originalLeaf);
          assert.match(outcome.reason, /[Nn]o restoration append succeeded/);
        } else {
          assert.match(outcome.reason, /restoration append succeeded/);
        }
        assert.ok(sm.getBranch().some((entry) => entry.id === originalInput));
        assert.ok(sm.getBranch().some((entry) => entry.id === originalLeaf));
        assert.equal(
          sm.getLabel(run.leaf),
          persistent ? "branch:end" : undefined,
        );
        assert.equal(
          sm
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "subagent-result",
            ).length,
          1,
        );
        internals._persist = persist;
        const receipt = sm.appendCustomEntry("receipt", {});
        const reopened = reopenSession(sm);
        assert.equal(reopened.getLeafId(), receipt);
        assert.deepEqual(
          reopened.getBranch().map((entry) => entry.id),
          sm.getBranch().map((entry) => entry.id),
        );
        const ids = new Set(reopened.getEntries().map((entry) => entry.id));
        assert.ok(!ids.has(failedId));
        for (const entry of reopened.getEntries()) {
          assert.ok(
            entry.parentId === null || ids.has(entry.parentId),
            `dangling parent ${entry.parentId}`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("persistence failures in the branch or mandatory labels refuse and preserve unrelated labels", async () => {
    for (const step of ["marker", "branch", "summary-label"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "fold-write-"));
      try {
        const sm = SessionManager.create(dir, dir);
        const pi = makeFakePi(sm);
        const { anchorId } = setupRewindable(sm, pi);
        const run = engineFold({ sm }, anchorId);
        if (step !== "marker")
          sm.appendLabelChange(run.leaf, "unrelated bookmark");
        const originalLeaf = sm.getLeafId();
        const internals = sm as unknown as {
          _persist(entry: SessionEntry): void;
        };
        const persist = internals._persist.bind(sm);
        let failedId = "";
        internals._persist = (entry) => {
          const matches =
            step === "branch"
              ? entry.type === "branch_summary"
              : entry.type === "label" &&
                entry.label ===
                  (step === "marker" ? "branch:end" : "anchor:end");
          if (matches && !failedId) {
            failedId = entry.id;
            throw new Error(`injected ${step} failure`);
          }
          persist(entry);
        };
        const outcome = await commitFold(sm, run.input);
        assert.ok(!outcome.ok, JSON.stringify(outcome));
        assert.match(outcome.reason, /restoration append succeeded/);
        assert.ok(sm.getBranch().some((entry) => entry.id === originalLeaf));
        assert.equal(
          sm.getLabel(run.leaf),
          step === "marker" ? undefined : "unrelated bookmark",
        );
        const reopened = reopenSession(sm);
        assert.deepEqual(
          reopened.getBranch().map((entry) => entry.id),
          sm.getBranch().map((entry) => entry.id),
        );
        const ids = new Set(reopened.getEntries().map((entry) => entry.id));
        assert.ok(!ids.has(failedId));
        for (const entry of reopened.getEntries())
          assert.ok(entry.parentId === null || ids.has(entry.parentId));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("persistence label retry and receipt retry never parent failed in-memory entries", async () => {
    for (const operation of ["label", "receipt"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "fold-retry-"));
      try {
        const sm = SessionManager.create(dir, dir);
        const pi = makeFakePi(sm);
        navigateTree(pi.pi);
        const ctx = makeCtx(sm);
        const { anchorId } = setupRewindable(sm, pi);
        const internals = sm as unknown as {
          _persist(entry: SessionEntry): void;
        };
        const persist = internals._persist.bind(sm);
        let failedId = "";
        internals._persist = (entry) => {
          if (
            !failedId &&
            (operation === "label"
              ? entry.type === "label"
              : entry.type === "custom_message")
          ) {
            failedId = entry.id;
            throw new Error(`injected ${operation} failure`);
          }
          persist(entry);
        };
        pi.pi.sendMessage = (message) => {
          sm.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display ?? true,
            message.details,
          );
        };
        const api = __testHooks.foldApi(pi.pi);
        assert.ok(api);
        const outcome = await api.runFoldNow(
          { ...ctx, isIdle: () => true } as never,
          {
            origin: "manual",
            rewindTo: "start",
            newLabel: "end",
            focus: "Preserve user instructions and continue the work.",
          },
        );
        assert.equal(outcome.status, "done", JSON.stringify(outcome));
        assert.equal(sm.getEntry(anchorId)?.id, anchorId);
        assert.ok(failedId);
        const reopened = reopenSession(sm);
        assert.deepEqual(
          reopened.getBranch().map((entry) => entry.id),
          sm.getBranch().map((entry) => entry.id),
        );
        const ids = new Set(reopened.getEntries().map((entry) => entry.id));
        assert.ok(!ids.has(failedId));
        for (const entry of reopened.getEntries())
          assert.ok(entry.parentId === null || ids.has(entry.parentId));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("preserves additive requests across a second fold without nesting continuations", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const firstText = "First open request.\n  Exact whitespace.\n";
    const firstId = f.sm.appendMessage({
      role: "user",
      content: firstText,
      timestamp: 1,
    });
    const secondText = "Also do the second request.";
    const secondId = f.sm.appendMessage({
      role: "user",
      content: secondText,
      timestamp: 2,
    });
    f.sm.appendMessage(
      assistantMessage(
        [{ type: "toolCall", id: "work", name: "read", arguments: {} }],
        "toolUse",
      ) as never,
    );
    f.sm.appendMessage({
      role: "toolResult",
      toolCallId: "work",
      toolName: "read",
      content: [{ type: "text", text: "evidence" }],
      isError: false,
      timestamp: 3,
    });
    f.sm.appendMessage(
      assistantMessage(
        [{ type: "text", text: "failed response" }],
        "error",
      ) as never,
    );
    f.sm.appendMessage(assistantMessage([], "stop") as never);
    f.sm.appendMessage(
      assistantMessage(
        [
          { type: "text", text: "still using tools" },
          { type: "toolCall", id: "more", name: "read", arguments: {} },
        ],
        "stop",
      ) as never,
    );
    f.sm.appendMessage({
      role: "toolResult",
      toolCallId: "more",
      toolName: "read",
      content: [{ type: "text", text: "more evidence" }],
      isError: false,
      timestamp: 4,
    });
    f.sm.appendCustomMessageEntry(
      REWIND_CUSTOM_TYPE,
      "historical continuation without typed requests",
      true,
    );
    f.sm.appendCustomMessageEntry("notification", "new notification", true);
    const run = engineFold(f, anchorId);
    const lateText = "Late input is reappended, not quoted.";
    f.sm.appendMessage({ role: "user", content: lateText, timestamp: 4 });
    const expected = [
      { sourceEntryId: firstId, text: firstText },
      { sourceEntryId: secondId, text: secondText },
    ];
    const first = await commitFold(f.sm, run.input);
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual(first.openUserRequests, expected);
    assert.ok(!first.continuation.includes(lateText));
    f.sm.appendCustomMessageEntry(
      REWIND_CUSTOM_TYPE,
      first.continuation,
      true,
      { status: "done", openUserRequests: first.openUserRequests },
    );
    f.sm.appendCustomMessageEntry(
      REWIND_CUSTOM_TYPE,
      "duplicate receipt",
      true,
      {
        openUserRequests: first.openUserRequests,
      },
    );
    f.sm.appendCustomMessageEntry(
      "evidence",
      "extra work ".repeat(5_000),
      false,
    );
    const second = await commitFold(
      f.sm,
      engineFold(f, anchorId, { newLabel: "end-two" }).input,
    );
    assert.ok(second.ok, JSON.stringify(second));
    assert.deepEqual(second.openUserRequests.slice(0, 2), expected);
    assert.equal(
      second.openUserRequests.length,
      3,
      "late input becomes collapsed on the second fold",
    );
    assert.equal(second.continuation.split(firstText).length, 2);
    assert.ok(!second.continuation.includes(first.continuation));
    const summary = f.sm.getEntry(second.summaryId);
    assert.ok(summary?.type === "branch_summary");
    assert.ok(!summary.summary.includes(firstText));
    f.sm.appendCustomMessageEntry(
      REWIND_CUSTOM_TYPE,
      second.continuation,
      true,
      {
        openUserRequests: second.openUserRequests,
      },
    );
    f.sm.appendMessage(
      assistantMessage(
        [{ type: "text", text: "requests fulfilled" }],
        "stop",
      ) as never,
    );
    f.sm.appendCustomMessageEntry(
      "evidence",
      "more work ".repeat(5_000),
      false,
    );
    const third = await commitFold(
      f.sm,
      engineFold(f, anchorId, { newLabel: "end-three" }).input,
    );
    assert.ok(third.ok, JSON.stringify(third));
    assert.deepEqual(third.openUserRequests, []);
    assert.ok(!third.continuation.includes(firstText));
  });

  it("uses current edited user bytes and clears open requests only after a successful final reply", async () => {
    for (const final of [false, true]) {
      const f = setup();
      const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
      const sourceEntryId = f.sm.appendMessage({
        role: "user",
        content: "original discarded text",
        timestamp: 1,
      });
      f.sm.appendContextEdit(sourceEntryId, {
        content: "edited current request\n",
      });
      const hiddenId = f.sm.appendMessage({
        role: "user",
        content: "hidden request",
        timestamp: 2,
      });
      f.sm.appendContextEdit(hiddenId, null);
      if (final)
        f.sm.appendMessage(
          assistantMessage(
            [{ type: "text", text: "completed answer" }],
            "stop",
          ) as never,
        );
      f.sm.appendCustomMessageEntry("notification", "late notification", true);
      const result = await commitFold(f.sm, engineFold(f, anchorId).input);
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(
        result.openUserRequests,
        final ? [] : [{ sourceEntryId, text: "edited current request\n" }],
      );
      assert.ok(!result.continuation.includes("original discarded text"));
      assert.ok(!result.continuation.includes("hidden request"));
    }
  });

  it("does not quote an open user request in the retained prefix", async () => {
    const f = setup();
    const id = f.sm.appendMessage({
      role: "user",
      content: "retained instruction",
      timestamp: 1,
    });
    f.pi.pi.setLabel(id, "anchor:start");
    f.sm.appendCustomMessageEntry(
      "work",
      "large evidence ".repeat(6_000),
      false,
    );
    const result = await commitFold(f.sm, engineFold(f, id).input);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.openUserRequests, []);
    assert.ok(!result.continuation.includes("retained instruction"));
  });

  it("prices all preserved user bytes and refuses an oversized request without mutation", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const text = "unanswered user bytes ".repeat(10_000);
    const sourceEntryId = f.sm.appendMessage({
      role: "user",
      content: text,
      timestamp: 1,
    });
    const run = engineFold(f, anchorId);
    const preview = previewFoldCommit(f.sm, run.input);
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.deepEqual(preview.openUserRequests, [{ sourceEntryId, text }]);
    assert.ok(
      preview.foldEstimateAfter >
        estimateContentTokens([{ role: "user", content: text, timestamp: 1 }]),
    );
    const before = {
      leaf: f.sm.getLeafId(),
      entries: f.sm.getEntries(),
      label: f.sm.getLabel(run.leaf),
    };
    const result = await commitFold(f.sm, {
      ...run.input,
      contextWindow: preview.projectedAfterTokens + 1_024 + 4_096 - 1,
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /insufficient request headroom/);
    assert.equal(f.sm.getLeafId(), before.leaf);
    assert.deepEqual(f.sm.getEntries(), before.entries);
    assert.equal(f.sm.getLabel(run.leaf), before.label);
  });

  it("counts the folded leaf in the pre-fold estimate when one large turn is folded", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, {
      capture: true,
      turnsAfter: 0,
    });
    appendTurn(f.sm, "u2", "evidence ".repeat(20_000), 52_000);
    const run = engineFold(f, anchorId);
    const outcome = await commitFold(f.sm, run.input);
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
    assert.ok(outcome.foldEstimateBefore > 45_000);
    assert.ok(outcome.foldEstimateAfter < outcome.foldEstimateBefore);
  });

  it("refuses a non-reducing materialization and writes nothing", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const run = engineFold(f, anchorId, {
      summaryText: `${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`,
    });
    const entryCount = f.sm.getEntries().length;
    const outcome = await commitFold(f.sm, run.input);
    assert.ok(!outcome.ok);
    assert.match(
      outcome.reason,
      /^the materialized handoff does not reduce projected context \(estimated \d+ -> \d+ tokens\); original history was kept$/,
    );
    assert.equal(f.sm.getLeafId(), run.leaf);
    assert.equal(f.sm.getEntries().length, entryCount);
    assert.equal(f.sm.getLabel(run.leaf), undefined);
  });

  it("refuses a label that became taken and writes nothing", async () => {
    const f = setup();
    const { anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const run = engineFold(f, anchorId);
    f.pi.pi.setLabel(run.leaf, "anchor:end");
    const leafBefore = f.sm.getLeafId();
    const entryCount = f.sm.getEntries().length;
    const outcome = await commitFold(f.sm, run.input);
    assert.deepEqual(outcome, {
      ok: false,
      reason: "a label 'end' now exists on the active branch",
    });
    assert.equal(f.sm.getLeafId(), leafBefore);
    assert.equal(f.sm.getEntries().length, entryCount);
  });
});

// =============================================================================
// previewFoldCommit: the read-only preparation commitFold lands
// =============================================================================

describe("previewFoldCommit", () => {
  const userMessage = (text: string) =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    }) as never;
  const CHILD_EVIDENCE = "child evidence ";

  /** Make every session write throw, so a preview that wrote anything fails loudly. */
  function forbidWrites(sm: SessionManager): void {
    const sink = sm as unknown as Record<string, unknown>;
    for (const name of [
      "appendMessage",
      "appendCustomMessageEntry",
      "appendCustomEntry",
      "appendLabelChange",
      "appendContextEdit",
      "appendCompaction",
      "appendModelChange",
      "appendThinkingLevelChange",
      "appendUsage",
      "appendSessionInfo",
      "branch",
      "branchWithSummary",
      "resetLeaf",
      "newSession",
      "createBranchedSession",
    ]) {
      sink[name] = () => {
        throw new Error(`the preview wrote through ${name}`);
      };
    }
  }

  const snapshotOf = (sm: SessionManager) => ({
    leaf: sm.getLeafId(),
    entries: JSON.stringify(sm.getEntries()),
  });

  function inputFor(
    sm: SessionManager,
    targetId: string,
    overrides: Partial<FoldPreviewInput> = {},
  ) {
    const leaf = sm.getLeafId() as string;
    const lead: number[] = [];
    const input: FoldPreviewInput = {
      targetId,
      rewindTo: "start",
      newLabel: "parent",
      summaryText: SUMMARY_TEXT,
      handoffMode: "full",
      contextWindow: 0,
      foldPointId: leaf,
      branchLabelEntryId: leaf,
      continuationText: (afterTokens) => {
        lead.push(afterTokens);
        return `folded to ${afterTokens}`;
      },
      ...overrides,
    };
    const commit: FoldCommitInput = {
      ...input,
      writeLabel: (entryId, label) => {
        sm.appendLabelChange(entryId, label);
        return true;
      },
    };
    return { leaf, lead, input, commit };
  }

  /**
   * A rule on the kept chain and a steering item scoped to the anchor, a
   * large child fold between the anchor and the leaf (its full report is
   * re-attached by the parent's full handoff), parent work, then a user
   * steer that arrives after the fold point.
   */
  function nestedFold() {
    const f = setup();
    const u0 = f.sm.appendMessage(userMessage("u0 never edit the lockfile"));
    appendOpsEntry(f.pi.pi, [
      {
        op: {
          op: "add",
          kind: "rule",
          text: "Never edit the lockfile",
          quote: "never edit the lockfile",
        },
        ctx: { origin: "user", entryId: u0 },
      },
    ]);
    const root = appendTurn(f.sm, "u1", "a1", 0);
    f.pi.pi.setLabel(root.assistantId, "anchor:start");
    const steer = appendTurn(
      f.sm,
      "u2 look at the parser first",
      "a2",
      0,
      true,
    );
    appendOpsEntry(f.pi.pi, [
      {
        op: {
          op: "add",
          kind: "steering",
          text: "Look at the parser first",
          scopeAnchor: "start",
        },
        ctx: { origin: "user", entryId: steer.userId },
      },
    ]);
    for (const n of [3, 4, 5]) appendTurn(f.sm, `u${n}`, `a${n}`, 0, true);
    const childRun = inputFor(f.sm, root.assistantId, {
      newLabel: "child",
      summaryText: `${SUMMARY_TEXT}\n${CHILD_EVIDENCE.repeat(3_200)}`,
    });
    return { ...f, root, childRun };
  }

  async function nestedFoldWithLateInput() {
    const f = nestedFold();
    const child = await commitFold(f.sm, f.childRun.commit);
    assert.ok(child.ok, child.ok ? "" : child.reason);
    for (const n of [6, 7, 8, 9]) appendTurn(f.sm, `u${n}`, `a${n}`, 0, true);
    const run = inputFor(f.sm, f.root.assistantId);
    f.sm.appendMessage(userMessage("late steer"));
    return { ...f, child, run };
  }

  it("prepares exactly the admission commitFold lands: large full child handoff, ledger and late input", async () => {
    const f = await nestedFoldWithLateInput();
    const before = snapshotOf(f.sm);
    const preview = previewFoldCommit(f.sm, f.run.input);
    assert.deepEqual(snapshotOf(f.sm), before, "the preview wrote nothing");
    assert.ok(preview.ok, preview.ok ? "" : preview.reason);
    assert.ok(preview.materialized.includes(CHILD_EVIDENCE.repeat(3_200)));
    assert.ok(preview.materialized.includes("Never edit the lockfile"));
    assert.ok(!preview.materialized.includes("Look at the parser first"));
    assert.equal(preview.lateEntries.length, 1);
    assert.ok(preview.foldEstimateAfter < preview.foldEstimateBefore);

    // An anchor estimate alone leaves the child's report and the summary out.
    const anchorOnly =
      estimateRequestTokens(
        buildSessionContext(f.sm.getEntries(), f.root.assistantId).messages,
      ) + Math.ceil(ANCHOR_MANDATE.length / 3.5);
    assert.ok(
      preview.projectedAfterTokens - anchorOnly >
        estimateContentTokens([
          userMessage(CHILD_EVIDENCE.repeat(3_200)) as never,
        ]),
    );

    const outcome = await commitFold(f.sm, f.run.commit);
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
    const summary = f.sm.getEntry(outcome.summaryId);
    assert.ok(summary && summary.type === "branch_summary");
    assert.equal(summary.summary, preview.materialized);
    assert.deepEqual(summary.details, preview.details);
    assert.equal(outcome.foldEstimateBefore, preview.foldEstimateBefore);
    assert.equal(outcome.foldEstimateAfter, preview.foldEstimateAfter);
    assert.equal(outcome.collapsedEntries, preview.collapsedEntries);
    assert.deepEqual(outcome.readFiles, preview.readFiles);
    assert.deepEqual(outcome.modifiedFiles, preview.modifiedFiles);
    assert.equal(outcome.reappended, preview.lateEntries.length);
    const [previewed, committed, landed] = f.run.lead;
    assert.equal(f.run.lead.length, 3);
    assert.equal(previewed, committed, "commit re-prices the same request");
    assert.equal(landed, outcome.afterTokens);
    assert.equal(
      previewed,
      outcome.afterTokens,
      "the request the preview prices is the one the landed fold leaves",
    );
    assert.ok(preview.projectedAfterTokens > outcome.afterTokens);
  });

  it("refuses what commitFold refuses, with the same reason, and writes nothing", async () => {
    const f = await nestedFoldWithLateInput();
    const bloated = inputFor(f.sm, f.root.assistantId, {
      summaryText: `${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`,
    });
    const before = snapshotOf(f.sm);
    forbidWrites(f.sm);
    const preview = previewFoldCommit(f.sm, bloated.input);
    assert.ok(!preview.ok);
    assert.match(
      preview.reason,
      /^the materialized handoff does not reduce projected context \(estimated \d+ -> \d+ tokens\); original history was kept$/,
    );
    assert.deepEqual(snapshotOf(f.sm), before);
    assert.equal(f.sm.getLabel(bloated.leaf), undefined);

    const stale = previewFoldCommit(f.sm, {
      ...bloated.input,
      rewindTo: "gone",
    });
    assert.deepEqual(stale, {
      ok: false,
      reason: "'gone' is no longer on the active branch",
    });
    const taken = previewFoldCommit(f.sm, {
      ...bloated.input,
      newLabel: "child",
    });
    assert.deepEqual(taken, {
      ok: false,
      reason: "a label 'child' now exists on the active branch",
    });
  });

  it("commitFold refuses with the preview's reason and keeps the original history", async () => {
    const f = await nestedFoldWithLateInput();
    const bloated = inputFor(f.sm, f.root.assistantId, {
      summaryText: `${SUMMARY_TEXT}\n${"detail ".repeat(20_000)}`,
    });
    const preview = previewFoldCommit(f.sm, bloated.input);
    const before = snapshotOf(f.sm);
    const outcome = await commitFold(f.sm, bloated.commit);
    assert.deepEqual(outcome, preview);
    assert.deepEqual(snapshotOf(f.sm), before);
    assert.equal(f.sm.getLabel(bloated.leaf), undefined);
  });

  it("turns a session read failing after the target checks into a refusal", async () => {
    const f = await nestedFoldWithLateInput();
    const before = snapshotOf(f.sm);
    (
      f.sm as unknown as { buildSessionProjection: () => never }
    ).buildSessionProjection = () => {
      throw new Error("projection boom");
    };
    const preview = previewFoldCommit(f.sm, f.run.input);
    assert.deepEqual(preview, {
      ok: false,
      reason: "the fold could not be prepared (projection boom)",
    });
    assert.deepEqual(snapshotOf(f.sm), before);
  });

  it("gates on the projected request it returns", async () => {
    const f = await nestedFoldWithLateInput();
    const open = previewFoldCommit(f.sm, f.run.input);
    assert.ok(open.ok);
    assert.ok(open.projectedAfterTokens > 5_120);
    const tight = previewFoldCommit(f.sm, {
      ...f.run.input,
      contextWindow: open.projectedAfterTokens,
    });
    assert.deepEqual(tight, {
      ok: false,
      reason:
        "the materialized handoff leaves insufficient request headroom; original history was kept",
    });
    const roomy = previewFoldCommit(f.sm, {
      ...f.run.input,
      contextWindow: open.projectedAfterTokens * 2,
    });
    assert.ok(roomy.ok);
    assert.equal(roomy.projectedAfterTokens, open.projectedAfterTokens);
  });

  describe("anchors before a compaction", () => {
    /** Five pre-compaction turns (the compaction keeps the fifth), then two more. */
    function compacted(usageOf = (_turn: number) => 0) {
      const f = setup();
      const early = appendTurn(f.sm, "u1", "a1", usageOf(1));
      f.pi.pi.setLabel(early.assistantId, "anchor:early");
      for (const n of [2, 3, 4])
        appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
      const cut = appendTurn(f.sm, "u5", "a5", usageOf(5), true);
      f.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
      f.sm.appendCompaction("Compacted summary", cut.userId, 0);
      for (const n of [6, 7])
        appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
      return { ...f, early, cut };
    }

    it("prices the restored history of a pre-compaction target", () => {
      const f = compacted();
      const run = inputFor(f.sm, f.early.assistantId, {
        rewindTo: "early",
        newLabel: "folded",
      });
      const preview = previewFoldCommit(f.sm, run.input);
      assert.ok(preview.ok, preview.ok ? "" : preview.reason);
      const restored =
        estimateRequestTokens(
          buildSessionContext(f.sm.getEntries(), f.early.assistantId).messages,
        ) + Math.ceil(ANCHOR_MANDATE.length / 3.5);
      assert.ok(preview.projectedAfterTokens > restored);
      assert.ok(
        preview.foldEstimateAfter >
          estimateContentTokens(
            buildSessionContext(f.sm.getEntries(), f.early.assistantId)
              .messages,
          ),
      );
    });

    it("refuses a target whose restored history the recorded usage prices low, naming the compaction", () => {
      const f = compacted((turn) =>
        turn <= 5 ? 6_000 : turn === 6 ? 20_000 : 30_000,
      );
      const run = inputFor(f.sm, f.cut.assistantId, {
        rewindTo: "before-cut",
        newLabel: "folded",
      });
      const before = snapshotOf(f.sm);
      forbidWrites(f.sm);
      const preview = previewFoldCommit(f.sm, run.input);
      assert.ok(!preview.ok);
      assert.match(
        preview.reason,
        /'before-cut' lies before the latest compaction.*\(estimated \d+ -> \d+ tokens\); original history was kept/,
      );
      assert.deepEqual(snapshotOf(f.sm), before);
    });
  });
});

// =============================================================================
// post-fold continue nudge
// =============================================================================

describe("rewind: one-time continue nudge after a fold", () => {
  const OPEN_PROGRESS_SUMMARY =
    "## Goal\nShip it.\n\n## Progress\n### Done\n- [x] Parser.\n\n### In Progress\n- [ ] Wire the CLI.\n\n## Next Steps\n(none)";
  const NO_OPEN_SUMMARY =
    "## Goal\nShip it.\n\n## Progress\n### Done\n- [x] Parser.\n\n### In Progress\n- [ ] (none)\n\n## Next Steps\n(none)";

  /** A committed fold: the continuation is on the branch, no turn since. */
  const foldedFixture = (summary = SUMMARY_TEXT) => rewindFixture({ summary });

  /** One post-fold assistant turn, persisted and run through `turn_end`. */
  async function turn(
    f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx },
    content: Array<Record<string, unknown>> = [
      { type: "text", text: "Final report." },
    ],
    stopReason = "stop",
    opts: { continue?: boolean; commit?: boolean } = {},
  ) {
    const message = assistantMessage(content, stopReason, 100);
    f.sm.appendMessage(message as never);
    const boundary = await fireTurnEndAll(f.pi, f.ctx, message, opts);
    return {
      message,
      boundary,
      nudges: boundary.entries.filter(
        (d) =>
          d.customType === REWIND_CUSTOM_TYPE &&
          d.details?.status === "continue-nudge",
      ),
    };
  }

  const userSteer = (sm: SessionManager, text = "also fix the docs") =>
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    } as never);

  it("nudges once, with continue, when the first post-fold turn is text-only and the summary has open work", async () => {
    const f = await foldedFixture();
    const { boundary, nudges } = await turn(f);
    assert.equal(nudges.length, 1);
    assert.equal(boundary.continue, true);
    assert.equal(nudges[0].content, CONTINUE_NUDGE_TEXT);
    assert.equal(nudges[0].display, true);
    assert.deepEqual(nudges[0].details, {
      status: "continue-nudge",
      summaryId: f.done.message.details.summaryId,
    });
    const last = f.sm.getBranch().at(-1);
    assert.ok(last && last.type === "custom_message");
    assert.equal(last.content, CONTINUE_NUDGE_TEXT);
    assert.deepEqual(f.pi.sendMessageCalls, [], "a boundary entry, not a send");
  });

  it("a second text-only turn is not nudged again", async () => {
    const f = await foldedFixture();
    assert.equal((await turn(f)).nudges.length, 1);
    const second = await turn(f);
    assert.deepEqual(second.nudges, []);
    assert.equal(second.boundary.continue, false);
  });

  it("is at most once per fold even when pi drops the draft and the same turn ends again", async () => {
    const f = await foldedFixture();
    const message = assistantMessage(
      [{ type: "text", text: "Final report." }],
      "stop",
      100,
    );
    f.sm.appendMessage(message as never);
    const first = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
    assert.equal(first.entries.length, 1);
    const again = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
    assert.deepEqual(again.entries, []);
  });

  it("a new fold is nudged again", async () => {
    const f = await foldedFixture();
    assert.equal((await turn(f)).nudges.length, 1);
    const anchored = appendTurn(f.sm, "u9", "a9", 6_000);
    f.pi.pi.setLabel(anchored.assistantId, "anchor:a2");
    appendTurn(f.sm, "u10", "a10", 30_000, true);
    f.ctx.modelRegistry = fakeRegistry(() =>
      reply("## Goal\nSecond.\n\n## Next Steps\n1. Go on."),
    ).registry;
    await requestRewind(
      f,
      { ...REWIND_ARGS, rewindTo: "a2", newLabel: "end2" },
      "tc-rewind-2",
      50_000,
    );
    const folds = rewindMessages(f.pi).filter(
      (m) => m.message.details.status === "done",
    );
    assert.equal(folds.length, 2);
    assert.equal((await turn(f)).nudges.length, 1);
  });

  it("does not nudge when the first post-fold turn calls a tool, nor on a later text-only turn", async () => {
    const f = await foldedFixture();
    const call = appendToolCallAssistant(f.sm, [
      { id: "tc-work", name: "bash", arguments: { command: "true" } },
    ]);
    appendToolResult(f.sm, "tc-work", "bash", "ok");
    const worked = await fireTurnEndAll(f.pi, f.ctx, call.message);
    assert.deepEqual(worked.entries, []);
    assert.deepEqual((await turn(f)).nudges, []);
  });

  it("nudges on an open '### In Progress' item alone; placeholders are not open work", async () => {
    const open = await foldedFixture(OPEN_PROGRESS_SUMMARY);
    assert.equal((await turn(open)).nudges.length, 1);
    const none = await foldedFixture(NO_OPEN_SUMMARY);
    const quiet = await turn(none);
    assert.deepEqual(quiet.nudges, []);
    assert.equal(quiet.boundary.continue, false);
  });

  it("does not nudge after a failed fold", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    f.ctx.modelRegistry = fakeRegistry(() =>
      reply("", "error", "overloaded"),
    ).registry;
    await requestRewind(f);
    assert.equal(
      rewindMessages(f.pi).filter((m) => m.message.details.status === "done")
        .length,
      0,
    );
    assert.deepEqual((await turn(f)).nudges, []);
  });

  it("does not nudge when a user message sits between the continuation and the turn", async () => {
    const f = await foldedFixture();
    userSteer(f.sm);
    assert.deepEqual((await turn(f)).nudges, []);
  });

  it("does not nudge a fold that re-appended late user input: the turn answers it", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    f.ctx.modelRegistry = fakeRegistry((_call, index) => {
      if (index === 0) userSteer(f.sm, "steer while pending");
      return reply(SUMMARY_TEXT);
    }).registry;
    await requestRewind(f);
    assert.equal(
      rewindMessages(f.pi).at(-1)?.message.details.reappendedLateMessages,
      1,
    );
    assert.deepEqual((await turn(f)).nudges, []);
  });

  it("does not nudge an error, aborted or cut-off turn", async () => {
    for (const stopReason of ["error", "aborted", "length"]) {
      const f = await foldedFixture();
      assert.deepEqual(
        (await turn(f, [{ type: "text", text: "partial" }], stopReason)).nudges,
        [],
        stopReason,
      );
    }
  });

  it("does not nudge while navigate_tree is out of the active tools", async () => {
    const f = await foldedFixture();
    await fireBeforeAgentStart(f.pi, f.ctx, ["read"]);
    assert.deepEqual((await turn(f)).nudges, []);
  });

  it("leaves a turn another handler already continues alone, and keeps the nudge unspent", async () => {
    const f = await foldedFixture();
    const message = assistantMessage(
      [{ type: "text", text: "Final report." }],
      "stop",
      100,
    );
    f.sm.appendMessage(message as never);
    const owned = await fireTurnEndAll(f.pi, f.ctx, message, {
      continue: true,
      commit: false,
    });
    assert.deepEqual(owned.entries, []);
    const later = await fireTurnEndAll(f.pi, f.ctx, message, { commit: false });
    assert.equal(later.entries.length, 1);
  });

  it("a headless session is nudged too", async () => {
    const f = await foldedFixture();
    f.ctx.hasUI = false;
    assert.equal((await turn(f)).nudges.length, 1);
  });

  it("renders as one line, expanding to the full text; the continuation keeps pi's default box", async () => {
    const f = await foldedFixture();
    const { nudges } = await turn(f);
    const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (
      ...a: unknown[]
    ) => { render(w: number): string[] } | undefined;
    assert.ok(renderer);
    const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
    const message = {
      role: "custom",
      customType: REWIND_CUSTOM_TYPE,
      content: nudges[0].content,
      display: true,
      details: nudges[0].details,
      timestamp: 0,
    };
    const row = renderer(message, { expanded: false, outputPad: 1 }, theme);
    assert.deepEqual(row?.render(400), [
      " <customMessageText>[navigate_tree] turn ended right after a rewind · nudged once to continue",
    ]);
    const lines = renderer(
      message,
      { expanded: true, outputPad: 1 },
      theme,
    )?.render(10_000);
    assert.ok(lines?.some((l) => l.includes("not a stop condition")));
    assert.equal(
      renderer(
        { ...message, details: f.done.message.details },
        { expanded: false, outputPad: 1 },
        theme,
      ),
      undefined,
    );
  });
});

// =============================================================================
// rewind message copy — byte-exact literals (no builder recomputation)
// =============================================================================

describe("rewind message copy (byte-exact)", () => {
  it("buildRewindDoneText", () => {
    assert.equal(
      buildRewindDoneText(
        {
          rewindTo: "start",
          newLabel: "end",
          beforeTokens: 30_000,
          contextWindow: 1_000_000,
        },
        4_000,
      ),
      "[rewind to 'start' · collapsed as 'end'] · context 3.0% → 0.4% of 1.0M\n\nA branch_summary of the collapsed work has been appended to your context. It is the newest branch_summary, the current state; earlier branch_summary messages, if present, are older collapsed segments. Items under '### Done' are complete. Items under '### In Progress', '### Blocked', or '## Next Steps' are the resume point: continue the latest branch_summary's work without re-confirming with the user.\n\nA branch_summary marks a milestone, not the end of the task. Your authority, highest first: the user's standing instruction retained above (including any authorization to work autonomously until the task is complete or a real blocker appears), the authorized plan or todo list, then this summary's open items. If the summary's only open item is a report, hand-off or wrap-up while an authorized instruction or plan item is still open, do that work first and report once, at the end of the authorized scope. Retained user messages already answered above are historical — do not re-answer them; their standing instructions still apply.",
    );
  });

  it("buildRewindDoneText without a context window uses the token form", () => {
    assert.equal(
      buildRewindDoneText(
        {
          rewindTo: "start",
          newLabel: "end",
          beforeTokens: 30_000,
          contextWindow: 0,
        },
        4_000,
      ).split("\n")[0],
      "[rewind to 'start' · collapsed as 'end'] · tokens 30000 → 4000",
    );
  });

  it("buildRewindAcceptedText (#90 S2)", () => {
    assert.equal(
      buildRewindAcceptedText("context-gathered", "parser-done"),
      "[navigate_tree] Rewind to 'context-gathered' accepted (collapse as 'parser-done'). The fold runs after this turn's tool results; the continuation follows in the same run.",
    );
  });
});

// =============================================================================
// dispatch: rewind newLabel uniqueness (#55)
// =============================================================================

describe("dispatch: rewind newLabel uniqueness", () => {
  it("newLabel collision: rewind refuses before queueing a fold and mutates nothing", async () => {
    // Issue #55 (C8): a `newLabel` already on the active branch is refused
    // BEFORE a fold is queued or any tree mutation. Setup ordering mirrors
    // the retired move-on-collision test: the prior `anchor:b` sits on the
    // ancestral side of `rewindTo` (= tA), so the old behavior would have
    // moved it to the new summary.
    //   root → tB(anchor:b) → tA(anchor:a) → t3 → leaf
    const { sm, pi, tool, ctx } = setup();
    const tB = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(tB.assistantId, "anchor:b");
    const tA = appendTurn(sm, "u2", "a2", 16_000);
    pi.pi.setLabel(tA.assistantId, "anchor:a");
    appendTurn(sm, "u3", "a3", 22_000);
    appendTurn(sm, "u4", "a4", 28_000);

    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);

    const entriesBefore = sm.getEntries().length;
    const leafBefore = sm.getLeafId();

    const result = await tool.execute(
      "tc-rewind",
      {
        action: "rewind",
        rewindTo: "a",
        newLabel: "b",
        summaryFocus: "Preserve the user's instruction and continue the work.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.refusal, true);
    assert.match(
      result.content[0].text,
      /A label 'b' already exists on the active branch/,
    );
    assert.match(result.content[0].text, /fresh `newLabel`/);
    assert.match(result.content[0].text, /stays addressable via `rewindTo`/);
    // Refusal before the fold is queued: nothing is pending.
    assert.equal(
      fireToolCall(pi, ctx),
      undefined,
      "a duplicate-newLabel refusal must not leave a rewind queued",
    );
    assert.equal(pi.sendMessageCalls.length, 0);
    // No mutation: entry count, leaf, and both labels are untouched.
    assert.equal(sm.getEntries().length, entriesBefore);
    assert.equal(sm.getLeafId(), leafBefore);
    assert.equal(sm.getLabel(tB.assistantId), "anchor:b");
    assert.equal(sm.getLabel(tA.assistantId), "anchor:a");
    assert.equal(
      __testHooks.findLabeledEntry(sm, "anchor:b"),
      tB.assistantId,
      "the existing label must stay where it was",
    );
  });

  it("identifies an already stored handoff without scheduling a redundant fold", async () => {
    const { sm, pi, tool, ctx } = setup();
    const first = appendTurn(sm, "review all partitions", "review one", 6_000);
    pi.pi.setLabel(first.assistantId, "anchor:start");
    appendTurn(sm, "review two", "reviewed two", 16_000);
    const summaryId = sm.branchWithSummary(
      first.assistantId,
      "## Goal\nReview\n## Next Steps\nReview partition 3",
    );
    pi.pi.setLabel(summaryId, "anchor:reviewed-two");
    const before = sm.getEntries();
    const leaf = sm.getLeafId();
    const result = await tool.execute(
      "tc-repeat",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "reviewed-two",
        summaryFocus: "Continue the authorized review of all partitions.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already names a stored handoff/);
    assert.match(result.content[0].text, /continue from the newest handoff/);
    assert.deepEqual(sm.getEntries(), before);
    assert.equal(sm.getLeafId(), leaf);
    assert.equal(fireToolCall(pi, ctx), undefined);
  });

  it("newLabel collision refusal copy is byte-exact", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:taken");
    appendTurn(sm, "u2", "a2", 16_000);
    const result = await tool.execute(
      "tc-rewind",
      {
        action: "rewind",
        rewindTo: "taken",
        newLabel: "taken",
        summaryFocus: "Preserve the user's instruction and continue the work.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "A label 'taken' already exists on the active branch — labels are unique and immutable once written, so rewind requires a fresh `newLabel`. The existing 'taken' label stays addressable via `rewindTo`. Use action='list' to review the active labels, then pick a fresh newLabel.",
    );
  });
});

// =============================================================================
// refreshAgentMessages
// =============================================================================

describe("refreshAgentMessages", () => {
  it("returns false when no session was captured", () => {
    const sm = SessionManager.inMemory("/tmp");
    assert.equal(__testHooks.refreshAgentMessages(sm), false);
  });

  it("returns false when agent.state is missing", () => {
    const sm = SessionManager.inMemory("/tmp");
    const fake = {
      sessionManager: sm,
      // agent present but state missing
      agent: { state: undefined, prepareNextTurn: undefined },
    };
    __testHooks.captureSession(fake as unknown as AgentSession);
    assert.equal(__testHooks.refreshAgentMessages(sm), false);
  });

  it("mutates agent.state.messages on success", () => {
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    } as never);
    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);
    assert.equal(fake.agent.state.messages.length, 0);
    assert.equal(__testHooks.refreshAgentMessages(sm), true);
    assert.deepEqual(
      fake.agent.state.messages,
      sm.buildSessionContext().messages,
    );
  });
});

// =============================================================================
// captureSession reaping
// =============================================================================

describe("captureSession reaping", () => {
  it("deduplicates the same session and bounds growth across many distinct sessions", () => {
    // Register a batch of short-lived sessions well above
    // MAX_SESSION_REFS so the reaper has work to do; the seenSessions
    // WeakSet dedupes within the same identity, and the sessionInstances
    // array gets reaped once length exceeds MAX_SESSION_REFS.
    //
    // Since WeakRef GC timing is non-deterministic, the bounded
    // assertion is the contract: the array doesn't grow proportional to
    // the number of pushes. (`Bun.gc(true)` is best-effort; if the
    // runtime doesn't expose it, we still get the dedupe + reap
    // bookkeeping.)
    const pushes = MAX_SESSION_REFS * 6 + 4; // comfortably above the cap
    for (let i = 0; i < pushes; i++) {
      const sm = SessionManager.inMemory("/tmp");
      const fake = makeFakeSession(sm);
      __testHooks.captureSession(fake as unknown as AgentSession);
      // Drop our reference each iteration so the WeakRef can be reaped.
    }
    // Best-effort GC nudge.
    const g = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun;
    if (typeof g?.gc === "function") g.gc(true);
    // Force the reaper to run by capturing one more session. The reaper
    // is gated inside `captureSession` on `length > MAX_SESSION_REFS` \u2014
    // it only runs at push time, never externally.
    const trailerSm = SessionManager.inMemory("/tmp");
    const trailerFake = makeFakeSession(trailerSm);
    __testHooks.captureSession(trailerFake as unknown as AgentSession);

    const refs = __testHooks.sessionRefCount();
    // Loose bound: the array shouldn't grow proportional to the number
    // of pushes once the reaper has fired.
    assert.ok(refs <= pushes + 1, `sessionRefCount=${refs} grew unbounded`);
    // Tighter bound when GC ran: post-reap, only live ref(s) remain.
    // (most of the prior pushes were dead, plus the trailer = at most
    // a few \u2014 well under MAX_SESSION_REFS.)
    if (typeof g?.gc === "function") {
      assert.ok(
        refs <= MAX_SESSION_REFS,
        `sessionRefCount=${refs}; expected the reaper to bound it at MAX_SESSION_REFS=${MAX_SESSION_REFS}`,
      );
    }
  });

  it("dedupes the same session on repeated capture", () => {
    const sm = SessionManager.inMemory("/tmp");
    const fake = makeFakeSession(sm);
    const before = __testHooks.sessionRefCount();
    __testHooks.captureSession(fake as unknown as AgentSession);
    const afterFirst = __testHooks.sessionRefCount();
    __testHooks.captureSession(fake as unknown as AgentSession);
    __testHooks.captureSession(fake as unknown as AgentSession);
    const afterRepeats = __testHooks.sessionRefCount();
    assert.equal(afterFirst - before, 1);
    assert.equal(afterRepeats, afterFirst);
  });

  it("resetPrototype clears seenSessions so a re-captured identity isn't deduped", () => {
    // Pre-reset: capturing the same identity twice dedupes (afterRepeat
    // === afterFirst). Post-reset: the SAME identity captures freshly,
    // proving the WeakSet was rebound. WeakSet has no .clear() so this
    // pins the rebind contract — a regression that drops the rebind in
    // resetPrototype would silently observe stale dedupe across tests.
    const sm = SessionManager.inMemory("/tmp");
    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);
    const afterFirst = __testHooks.sessionRefCount();
    __testHooks.captureSession(fake as unknown as AgentSession);
    const afterRepeat = __testHooks.sessionRefCount();
    assert.equal(afterRepeat, afterFirst, "pre-reset: dedupe is active");

    __testHooks.resetPrototype();
    // After reset, sessionInstances is drained and seenSessions is fresh.
    assert.equal(__testHooks.sessionRefCount(), 0);
    // Re-capturing the SAME identity must succeed (count goes from 0 → 1).
    __testHooks.captureSession(fake as unknown as AgentSession);
    assert.equal(__testHooks.sessionRefCount(), 1);
  });

  it("captureSession tolerates a session with no agent internals", () => {
    // The deleted installPrepareNextTurn hook (which read agent.state.*
    // at prompt time) had an early-exit for sessions with no agent; the
    // replacement context-event refresh captures sessions for
    // refreshAgentMessages only, so a session without agent internals
    // must be capturable without throwing — findOwningSession just won't
    // match it.
    const sm = SessionManager.inMemory("/tmp");
    const ghost = { sessionManager: sm }; // no `agent` field at all
    const before = __testHooks.sessionRefCount();
    assert.doesNotThrow(() =>
      __testHooks.captureSession(ghost as unknown as AgentSession),
    );
    // The ghost is captured (ref count advanced) but findOwningSession
    // still resolves nothing for it (it has no agent.state.messages to
    // refresh — refreshAgentMessages returns false).
    assert.equal(__testHooks.sessionRefCount(), before + 1);
    assert.equal(__testHooks.refreshAgentMessages(sm), false);
  });
});

// =============================================================================
// findLabelHint depth limit
// =============================================================================

describe("findLabelHint", () => {
  it("returns null when no text is found within MAX_HINT_WALK_DEPTH", () => {
    // Build a chain whose head is a custom_message with no text content,
    // followed by user-text entries beyond the walker's reach \u2014 the
    // walker should give up at depth MAX_HINT_WALK_DEPTH and never
    // reach the texts.
    const sm = SessionManager.inMemory("/tmp");
    // First push the deep texts (positioned beyond the walker's reach).
    for (let i = 0; i < 100; i++) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `deep ${i}` }],
      } as never);
    }
    // Now push thinking-only assistant messages on top so the walk
    // bottoms out before reaching the user texts. We need at least
    // MAX_HINT_WALK_DEPTH thinking entries; use +10 for safety margin.
    for (let i = 0; i < MAX_HINT_WALK_DEPTH + 10; i++) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "..." }],
        api: "anthropic",
        provider: "claude",
        model: "claude-sonnet-4-5",
        stopReason: "endTurn",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as never);
    }
    const leafId = sm.getLeafId();
    assert.ok(leafId);
    const hint = __testHooks.findLabelHint(sm, leafId, 50);
    assert.equal(hint, null);
  });

  it("returns a preview when text is within the depth limit", () => {
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "the user's instruction" }],
    } as never);
    // 5 thinking entries on top \u2014 well within the 50-step cap.
    for (let i = 0; i < 5; i++) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "..." }],
        api: "anthropic",
        provider: "claude",
        model: "claude-sonnet-4-5",
        stopReason: "endTurn",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as never);
    }
    const leafId = sm.getLeafId();
    assert.ok(leafId);
    const hint = __testHooks.findLabelHint(sm, leafId, 50);
    assert.ok(hint);
    if (hint) assert.match(hint, /the user's instruction/);
  });

  it("branch_summary entry: returns 'summary: <stripped lead-in>'", () => {
    // findLabelHint walks the parent chain; when it lands on a
    // branch_summary entry, the hint should be prefixed with 'summary: '
    // and stripBranchSummaryBoilerplate should remove pi's prelude. A
    // regression that drops the prefix or the strip call would surface
    // here.
    const sm = SessionManager.inMemory("/tmp");
    appendTurn(sm, "u1", "a1");
    const leafId = sm.getLeafId();
    assert.ok(leafId);
    const summaryId = sm.branchWithSummary(
      leafId,
      "This is the summary content of the rewound branch.",
    );
    const hint = __testHooks.findLabelHint(sm, summaryId, 80);
    assert.ok(hint, "branch_summary entry should produce a hint");
    if (hint) {
      assert.match(hint, /^summary: /);
      assert.match(hint, /summary content of the rewound branch/);
    }
  });

  it("custom_message entry: hint extracts the content text", () => {
    // findLabelHint also walks into `custom_message` entries (e.g. the
    // `/tree` view's label entries). Pin: the text content lands
    // in the hint, no prefix.
    const sm = SessionManager.inMemory("/tmp");
    sm.appendCustomMessageEntry(
      "some-custom-type",
      [{ type: "text", text: "custom message content" }],
      true,
    );
    const leafId = sm.getLeafId();
    assert.ok(leafId);
    const hint = __testHooks.findLabelHint(sm, leafId, 80);
    assert.ok(hint, "custom_message entry should produce a hint");
    if (hint) assert.match(hint, /custom message content/);
  });
});

// =============================================================================
// findLabeledEntry
// =============================================================================

describe("findLabeledEntry", () => {
  it("returns null when the label isn't on the active branch", () => {
    const sm = SessionManager.inMemory("/tmp");
    appendTurn(sm, "u", "a");
    assert.equal(__testHooks.findLabeledEntry(sm, "anchor:nope"), null);
  });

  it("returns the entry id when the label is set", () => {
    const sm = SessionManager.inMemory("/tmp");
    const t = appendTurn(sm, "u", "a");
    sm.appendLabelChange(t.assistantId, "anchor:found");
    assert.equal(
      __testHooks.findLabeledEntry(sm, "anchor:found"),
      t.assistantId,
    );
  });
});

// =============================================================================
// adversarial inputs
// =============================================================================

describe("dispatch: adversarial inputs", () => {
  it("100KB summaryFocus passes the length guard and reaches the no-such-label guard", async () => {
    // Pin behavior: no input-size cap on summaryFocus. The guard checks
    // a minimum, not a maximum. The test reaches the next guard
    // (no rewindTo on active branch) without crashing.
    const { sm, tool, ctx } = setup();
    appendTurn(sm, "u", "a");
    const huge = "x".repeat(100_000);
    const result = await tool.execute(
      "tc-1",
      {
        action: "rewind",
        rewindTo: "missing",
        newLabel: "after",
        summaryFocus: huge,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No label 'missing'/);
  });

  it("newLabel === rewindTo passes name validation; surfaces as a 'no such label' error if not pre-anchored", async () => {
    // Both pass isValidName; pinning that the dispatch doesn't reject
    // rewindTo === newLabel up front. (Without a pre-set anchor, the
    // label-existence guard fires.)
    const { sm, tool, ctx } = setup();
    appendTurn(sm, "u", "a");
    const result = await tool.execute(
      "tc-1",
      {
        action: "rewind",
        rewindTo: "same",
        newLabel: "same",
        summaryFocus: "x".repeat(MIN_SUMMARY_FOCUS_LENGTH),
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No label 'same'/);
  });
});

// =============================================================================
// rewind error branches
// =============================================================================

describe("dispatch: rewind error branches", () => {
  it("'Already at <rewindTo>' fires when the rewindTo anchor is on the leaf", async () => {
    // setLabel itself advances the leaf (it appends a label-type entry as
    // child of the prior leaf), so anchoring then driving rewind doesn't
    // naturally hit `oldLeaf === target`. Reset the leaf back to the
    // labeled assistant via `sm.branch(...)` so the guard fires. This is
    // the contract the message pins ("Already at <rewindTo>"); the
    // path-construction is test-internal.
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 100);
    pi.pi.setLabel(t1.assistantId, "anchor:here");
    sm.branch(t1.assistantId);
    const result = await tool.execute(
      "tc-1",
      {
        action: "rewind",
        rewindTo: "here",
        newLabel: "after",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /Already at 'here' \u2014 nothing to summarize/,
    );
  });
});

// =============================================================================
// dispatch: rewind min-savings floor (#21)
//
// Scenario pins from the issue-#20 repro, hermetic:
//   A — anchor→immediate rewind (zero/negligible work above the anchor)
//       must be REJECTED by the min-savings floor, never summarized;
//   B — healthy stages (≥20k apparent savings) must still request the
//       summary. (The immediate re-rewind of a just-landed summary is
//       pinned in the phase-2 block.)
// =============================================================================

describe("dispatch: rewind min-savings floor (#21)", () => {
  /** No newLabel may survive a rejected rewind — the label isn't consumed. */
  function assertLabelAbsent(sm: SessionManager, label: string): void {
    for (const e of sm.getBranch()) {
      assert.notEqual(sm.getLabel(e.id), label);
    }
  }

  it("A-pin variant A: anchor→immediate rewind with an earlier anchor present is rejected with the active-anchor list", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:kickoff");
    const t2 = appendTurn(sm, "u2", "a2", 12_000);
    pi.pi.setLabel(t2.assistantId, "anchor:impl-start");

    // setLabel advances the leaf (label-change entry), so the leaf here is
    // the impl-start label entry — exactly the issue-#20 repro shape:
    // anchor, then immediately rewind with zero work above.
    const branchBefore = sm.getBranch().map((e) => e.id);
    const leafBefore = sm.getLeafId();

    const r = await tool.execute(
      "tc-floor-a",
      {
        action: "rewind",
        rewindTo: "impl-start",
        newLabel: "done",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(r.isError, true);
    assert.equal(r.details.rejected, "min-savings");
    assert.ok(typeof r.details.apparentSavings === "number");
    const text = r.content[0].text;
    assert.match(text, /would free only/);
    // Movement-order copy (#43): rewind TO the anchor, collapsed AS the new
    // label. An arrow reading `'impl-start' → 'done'` inverts the operation.
    assert.match(text, /Rewinding to 'impl-start' \(as 'done'\)/);
    // Variant A guidance + the full chronological anchor list, including
    // rewindTo itself.
    assert.match(text, /Rewind further back to actually free context/);
    assert.match(text, / {2}kickoff\n/);
    assert.match(text, / {2}impl-start$/);
    // Byte-exact pin (#84 moved the anchor walk into formatActiveAnchors).
    assert.equal(
      text,
      "Rewinding to 'impl-start' (as 'done') would free only ~0.0k tokens. Rewind further back to actually free context, or keep working.\nActive anchors (root → leaf, % of 1.0M):\n   0.6%  kickoff\n   1.2%  impl-start",
    );
    // The numeric bar itself is NEVER printed agent-visible.
    assert.ok(
      !text.includes(String(MIN_REWIND_SAVINGS_TOKENS)),
      "rejection copy must not print the floor value",
    );
    // Nothing pending; newLabel not consumed; tree untouched.
    assert.equal(fireToolCall(pi, ctx), undefined);
    assertLabelAbsent(sm, "anchor:done");
    assert.deepEqual(
      sm.getBranch().map((e) => e.id),
      branchBefore,
    );
    assert.equal(sm.getLeafId(), leafBefore);
  });

  it("A-pin variant B: rewinding the OLDEST anchor is rejected with 'No earlier anchors'", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    // One tiny turn above the anchor: measured savings ≈ 1 token.
    appendTurn(sm, "u2", "a2", 6_001);

    const r = await tool.execute(
      "tc-floor-b",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "done",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(r.isError, true);
    assert.equal(r.details.rejected, "min-savings");
    const text = r.content[0].text;
    assert.match(text, /would free only/);
    assert.match(
      text,
      /No earlier anchors — keep working and rewind later once more has accumulated above it\./,
    );
    assert.match(text, /'start'/);
    assert.equal(
      text,
      "Rewinding to 'start' (as 'done') would free only ~0.0k tokens. No earlier anchors — keep working and rewind later once more has accumulated above it.\nActive anchors (root → leaf, % of 1.0M):\n   0.6%  start",
    );
    assert.ok(!text.includes(String(MIN_REWIND_SAVINGS_TOKENS)));
    assert.equal(fireToolCall(pi, ctx), undefined);
    assertLabelAbsent(sm, "anchor:done");
  });

  it("A-pin variant B at contextWindow 0: k-format percents, no window suffix", async () => {
    const { sm, pi, tool, ctx } = setup({ contextWindow: 0 });
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    appendTurn(sm, "u2", "a2", 6_001);
    const r = await tool.execute(
      "tc-floor-b0",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "done",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(r.details.rejected, "min-savings");
    assert.equal(
      r.content[0].text,
      "Rewinding to 'start' (as 'done') would free only ~0.0k tokens. No earlier anchors — keep working and rewind later once more has accumulated above it.\nActive anchors (root → leaf):\n   6.0k  start",
    );
  });

  it("an empty-named manual label never counts as the oldest anchor", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t0 = appendTurn(sm, "u0", "a0", 3_000);
    pi.pi.setLabel(t0.assistantId, "anchor:");
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    appendTurn(sm, "u2", "a2", 6_001);
    const r = await tool.execute(
      "tc-floor-empty",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "done",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(r.details.rejected, "min-savings");
    assert.match(
      r.content[0].text,
      /No earlier anchors — keep working and rewind later once more has accumulated above it\./,
    );
    // The rejection lists only names rewindTo accepts (no `''`).
    assert.match(
      r.content[0].text,
      /\nActive anchors \(root → leaf, % of 1\.0M\):\n +[\d.]+% {2}start$/,
    );
  });

  it("B-pin: healthy stage (≥20k apparent savings) queues the fold", async () => {
    const { sm, pi, tool, ctx } = setup();
    const t1 = appendTurn(sm, "u1", "a1", 6_000);
    pi.pi.setLabel(t1.assistantId, "anchor:start");
    appendTurn(sm, "u2", "a2", 27_000);
    appendTurn(sm, "u3", "a3", 28_000);

    const r = await tool.execute(
      "tc-floor-bpin",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "end",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(r.isError, undefined);
    assert.equal(r.details.status, "queued");
    // Apparent savings = contextBefore − anchor-time total (6_000).
    const before = r.details.contextBefore as number;
    assert.ok(
      before - 6_000 >= 20_000,
      `expected ≥20k apparent savings; got ${before - 6_000}`,
    );
    assert.equal(
      fireToolCall(pi, ctx),
      undefined,
      "a queued fold gates no sibling call",
    );
  });

  it("boundary: apparent savings just under the floor rejects; exactly at the floor accepts", async () => {
    // Deterministic measurement math: the leaf a3 sits on u3, whose 2 chars
    // are 1 host token, 2 once scaled to the SDK's heuristic. A chain
    // anchored at a1(T1) therefore measures beforeTokens = T2 + 2 + M and
    // tokensAtTarget = T1 + M (M: the mandate the next prompt appends), i.e.
    //   apparentSavings = T2 + 2 − T1.
    async function floorFixture(t2Total: number) {
      const { sm, pi, tool, ctx } = setup();
      const t1 = appendTurn(sm, "u1", "a1", 5_000);
      pi.pi.setLabel(t1.assistantId, "anchor:start");
      appendTurn(sm, "u2", "a2", t2Total);
      appendTurn(sm, "u3", "a3", t2Total + 1_000);
      return { pi, tool, ctx };
    }
    const rewindArgs = {
      action: "rewind",
      rewindTo: "start",
      newLabel: "end",
      summaryFocus: "Preserve user instructions and continue.",
    } as const;

    // Just UNDER: savings = MIN − 1.
    const under = await floorFixture(5_000 + MIN_REWIND_SAVINGS_TOKENS - 3);
    const ru = await under.tool.execute(
      "tc-under",
      rewindArgs,
      undefined,
      undefined,
      under.ctx,
    );
    assert.equal(ru.isError, true);
    assert.equal(ru.details.rejected, "min-savings");
    assert.equal(ru.details.apparentSavings, MIN_REWIND_SAVINGS_TOKENS - 1);
    assert.equal(fireToolCall(under.pi, under.ctx), undefined);

    // AT the floor: savings = MIN exactly (the guard is strict `<`, so this
    // accepts).
    const at = await floorFixture(5_000 + MIN_REWIND_SAVINGS_TOKENS - 2);
    const ra = await at.tool.execute(
      "tc-at",
      rewindArgs,
      undefined,
      undefined,
      at.ctx,
    );
    assert.equal(ra.isError, undefined);
    assert.equal(ra.details.status, "queued");
  });

  it("anchor response tells the agent to wait for accumulated work (#21 copy)", async () => {
    const { sm, tool, ctx } = setup();
    appendTurn(sm, "u1", "a1", 100);

    const r = await tool.execute(
      "tc-anchor-copy",
      { action: "anchor", name: "impl-start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(r.isError, undefined);
    const text = r.content[0].text;
    assert.ok(
      text.includes("Once real work has accumulated after this anchor"),
      `anchor copy must steer toward accumulating work; got: ${text}`,
    );
    assert.ok(
      !text.includes("When you finish this stage"),
      "pre-#21 anchor copy must be gone",
    );
    // The focus-length constant stays interpolated (no hardcoded 20).
    assert.ok(text.includes(`≥${MIN_SUMMARY_FOCUS_LENGTH}-char focus`));
  });

  it("registers the rewind-hygiene and pin promptGuidelines byte-exactly and in order", () => {
    // Exact array length + per-element byte equality + order (the 2026-09-13
    // reflection's Lesson 3: `includes`-only pins pass under reordering).
    // These bullets are static and NOT config-gated — `registerTool` fixes
    // the array at registration, so every active-tool session carries them
    // (and pays the one-time prompt-cache prefix invalidation on upgrade).
    const { tool } = setup();
    const guidelines = tool.promptGuidelines as string[] | undefined;
    assert.ok(Array.isArray(guidelines), "promptGuidelines must be registered");
    const expected = [
      "navigate_tree: when rewinding, prefer the oldest anchor that keeps what you'd otherwise re-read or re-derive; persist durable findings to files first.",
      "navigate_tree: don't rewind while a user decision or unresolved question is pending — ask the user instead.",
      "navigate_tree: pin durable sub-goals, decisions, facts and file pointers you must not lose across folds; the user's own rules and goals are captured automatically and cannot be pinned or changed by you.",
    ];
    assert.equal(
      guidelines?.length,
      expected.length,
      `promptGuidelines must carry exactly ${expected.length} bullets; got: ${guidelines?.length}`,
    );
    assert.deepEqual(guidelines, expected);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(
        guidelines?.[i],
        expected[i],
        `guidelines[${i}] must be byte-exact; got: ${guidelines?.[i]}`,
      );
    }
  });
});

// =============================================================================
// non-assistant oldLeafEntry fallback
// =============================================================================

describe("dispatch: rewind beforeTokens fallback", () => {
  it("non-assistant leaf: beforeTokens uses estimateActiveBranchTokens fallback (smoke)", async () => {
    // Build chain ending in a user message (not an assistant). The
    // happy-path beforeTokens math gates on role==='assistant' &&
    // parentId; otherwise falls back to estimateActiveBranchTokens.
    // Smoke-level pin: a sensible non-zero contextBefore lands in details.
    const { sm, pi, tool, ctx } = setup();
    setupRewindable(sm, pi);
    // Append a trailing user message so the leaf isn't an assistant.
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "u3" }],
    } as never);

    const fake = makeFakeSession(sm);
    __testHooks.captureSession(fake as unknown as AgentSession);

    // Pre-snapshot: leaf at execute time IS NOT a role==='assistant'
    // entry. This is the precondition for the fallback branch — without
    // it the test would silently exercise the happy path.
    const oldLeafId = sm.getLeafId();
    assert.ok(oldLeafId);
    const oldLeaf = sm.getEntry(oldLeafId as string);
    assert.ok(oldLeaf && oldLeaf.type === "message");
    if (oldLeaf && oldLeaf.type === "message") {
      assert.equal(
        oldLeaf.message.role,
        "user",
        "precondition: oldLeaf must NOT be assistant for fallback branch",
      );
    }

    const result = await tool.execute(
      "tc-1",
      {
        action: "rewind",
        rewindTo: "start",
        newLabel: "end",
        summaryFocus: "Preserve user instructions and continue.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined);
    const before = result.details.contextBefore as number;
    assert.ok(
      typeof before === "number" && before > 0,
      `expected non-zero contextBefore; got ${before}`,
    );
  });
});
// =============================================================================
// Rewind-hint integration (#44)
//
// The factory's hint state is closure-scoped: `session_start` is the only
// writer, so these tests drive the real handler against a temp
// `PI_CODING_AGENT_DIR` fixture (real loader, real fs) and then invoke the
// captured synchronous `turn_end` handler. No LLM and no session file —
// `SessionManager` stays in-memory, and the temp fixture is removed in a
// `finally` so nothing leaks between tests or into the user's real agent dir.
// =============================================================================

interface ConfigFixture {
  root: string;
  agentDir: string;
  projectDir: string;
}

function makeConfigFixture(): ConfigFixture {
  const root = mkdtempSync(join(tmpdir(), "navigate-tree-hint-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // pi's auto-compaction defaults to on, which turns the hint off (#101,
  // D9): the fixture's pi settings turn it off unless a test says otherwise.
  writePiSettings(
    { root, agentDir, projectDir },
    { compaction: { enabled: false } },
  );
  return { root, agentDir, projectDir };
}

/** Write the fixture's global pi `settings.json` (#101). */
function writePiSettings(fixture: ConfigFixture, settings: unknown): void {
  writeFileSync(
    join(fixture.agentDir, "settings.json"),
    JSON.stringify(settings),
  );
}

/** Write the fixture's project pi `.pi/settings.json` (#101). */
function writeProjectPiSettings(
  fixture: ConfigFixture,
  settings: unknown,
): void {
  const dir = join(fixture.projectDir, CONFIG_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

function cleanupConfigFixture(fixture: ConfigFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function writeGlobalConfig(fixture: ConfigFixture, raw: string): void {
  writeFileSync(join(fixture.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME), raw);
}

function writeProjectConfig(fixture: ConfigFixture, raw: string): void {
  const dir = join(fixture.projectDir, CONFIG_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TREE_NAVIGATOR_CONFIG_FILENAME), raw);
}

function globalConfigPath(fixture: ConfigFixture): string {
  return join(fixture.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME);
}

function projectConfigPath(fixture: ConfigFixture): string {
  return join(
    fixture.projectDir,
    CONFIG_DIR_NAME,
    TREE_NAVIGATOR_CONFIG_FILENAME,
  );
}

/** Context-usage shape at `percent` of `contextWindow`. */
function usageAt(percent: number, contextWindow = 1_000_000): ContextUsage {
  return {
    tokens: Math.round((percent / 100) * contextWindow),
    contextWindow,
    percent,
  };
}

/**
 * The hint text at `percent` of `contextWindow` (via `usageAt`), with the
 * reserve the test config sets and the active-anchor list the handler must
 * render (default: the lone `anchorStart` label at 0.0% of 1.0M).
 */
function expectedHint(
  percent: number,
  anchors = "Active anchors (root → leaf, % of 1.0M):\n   0.0%  start",
  reserve = 100_000,
  contextWindow = 1_000_000,
): string {
  const usage = usageAt(percent, contextWindow);
  return buildRewindHintText(
    percent,
    contextWindow - (usage.tokens ?? 0),
    reserve,
    contextWindow,
    anchors,
  );
}

/**
 * Drive the captured `session_start` handler with `PI_CODING_AGENT_DIR`
 * pointed at the fixture's agent dir (the loader reads the real fs). The env
 * var is always restored, so the suite never touches the user's real config.
 */
async function runSessionStart(
  pi: FakePi,
  ctx: FakeCtx,
  fixture: ConfigFixture,
  reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): Promise<void> {
  const handlers = pi.onCalls.get("session_start");
  assert.ok(handlers, "factory must register a session_start handler");
  assert.equal(handlers.length, 3);
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  try {
    for (const handler of handlers)
      await handler({ type: "session_start", reason } as never, ctx as never);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

/**
 * Fire the captured synchronous hint / start-anchor `turn_end` handler. The
 * factory registers two `turn_end` handlers: the async rewind summary
 * handler (#80) first, this one last. Only this one is fired here so the
 * stale-ctx pins (exactly one `sessionManager` read) stay about this
 * handler; rewind tests use `fireTurnEndAll`.
 */
function fireTurnEnd(pi: FakePi, ctx: FakeCtx, turnIndex = 0): void {
  const handlers = pi.onCalls.get("turn_end");
  assert.ok(handlers, "factory must register a turn_end handler");
  assert.equal(handlers.length, 2);
  handlers[1]({ type: "turn_end", turnIndex } as never, ctx as never);
}

/** Fire the captured `agent_end` handler (run-end fallback). */
function fireAgentEnd(pi: FakePi, ctx: FakeCtx): void {
  const handlers = pi.onCalls.get("agent_end");
  assert.ok(handlers, "factory must register an agent_end handler");
  assert.equal(handlers.length, 1);
  handlers[0]({ type: "agent_end", messages: [] } as never, ctx as never);
}

/** Drive the `before_agent_start` handler to (re)compute the tool gate. */
async function fireBeforeAgentStart(
  pi: FakePi,
  ctx: FakeCtx,
  selectedTools: string[] | undefined,
): Promise<void> {
  const handlers = pi.onCalls.get("before_agent_start");
  assert.ok(handlers, "factory must register a before_agent_start handler");
  assert.equal(handlers.length, 1);
  await handlers[0](
    {
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: "BASE",
      systemPromptOptions: selectedTools === undefined ? {} : { selectedTools },
    } as never,
    ctx as never,
  );
}

/** Label the current leaf `anchor:start` so the hint path has an anchor. */
function anchorStart(sm: SessionManager, pi: FakePi): void {
  const t = appendTurn(sm, "u-anchor", "a-anchor");
  pi.pi.setLabel(t.assistantId, "anchor:start");
}

describe("settings live application", () => {
  it("runtime capture save immediately blocks pin without writing config, and reload restores file settings", async () => {
    const fixture = makeConfigFixture();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ continuity: { capture: true } }),
      );
      const before = readFileSync(globalConfigPath(fixture), "utf8");
      const f = setup();
      f.ctx.cwd = fixture.projectDir;
      anchorStart(f.sm, f.pi);
      await runSessionStart(f.pi, f.ctx, fixture);
      const keys = [
        ["t"],
        ["\x1b[H", "\x1b[B", "\x1b[B", "\x1b[B", "\r"],
        ["s"],
        ["\r"],
        ["\x1b"],
      ];
      const ctx = {
        ...f.ctx,
        hasUI: true,
        isIdle: () => true,
        ui: {
          ...f.ctx.ui,
          confirm: async () => true,
          custom(
            factory: (...args: unknown[]) => {
              render(width: number): string[];
              handleInput(key: string): void;
            },
          ) {
            return new Promise((resolve) => {
              const screen = factory(
                { terminal: { rows: 50, columns: 130 }, requestRender() {} },
                {
                  fg: (_: string, text: string) => text,
                  bold: (text: string) => text,
                  italic: (text: string) => text,
                },
                undefined,
                resolve,
              );
              screen.render(130);
              const script = keys.shift();
              assert.ok(script, "unexpected settings screen");
              for (const key of script) screen.handleInput(key);
            });
          },
        },
      } as unknown as ExtensionCommandContext;
      const command = f.pi.commands.get("anchor");
      assert.ok(command);
      await command.handler("settings", ctx);
      assert.equal(keys.length, 0);
      const refused = await f.tool.execute(
        "runtime-pin",
        { action: "pin", kind: "fact", text: "Runtime was applied" },
        undefined,
        undefined,
        f.ctx,
      );
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /disabled by config/);
      assert.equal(readFileSync(globalConfigPath(fixture), "utf8"), before);
      await runSessionStart(f.pi, f.ctx, fixture, "reload");
      const allowed = await f.tool.execute(
        "file-pin",
        { action: "pin", kind: "fact", text: "File settings restored" },
        undefined,
        undefined,
        f.ctx,
      );
      assert.equal(allowed.isError, undefined);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      cleanupConfigFixture(fixture);
    }
  });
});

describe("rewind hint: session_start config wiring (#44)", () => {
  it("loads the global threshold and fires on the first crossing", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 100_000 }),
      );
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, [], "valid config must not warn");

      ctx.setContextUsage(usageAt(89.9));
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        0,
        "below-threshold observation must not fire",
      );

      ctx.setContextUsage(usageAt(90));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      // Real call arity: exactly one argument (no options bag).
      assert.equal(pi.sendMessageCalls[0].length, 1);
      assert.deepEqual(pi.sendMessageCalls[0], [
        {
          customType: REWIND_HINT_CUSTOM_TYPE,
          content: expectedHint(90),
          display: true,
        },
      ]);
      // Byte-exact pin: the anchors are named, so no `list` call is needed.
      assert.equal(
        pi.sendMessageCalls[0][0].content,
        "[navigate_tree hint] Context is at 90.0% of 1.0M — 100.0k tokens left, within the 100.0k reserve. Persist what matters to files now, then rewind to the oldest appropriate anchor.\nActive anchors (root → leaf, % of 1.0M):\n   0.0%  start",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("project layer overrides global when trusted; untrusted ignores the file", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 100_000 }),
      );
      writeProjectConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 500_000 }),
      );

      // Trusted: the project's 500k reserve wins over the global 100k.
      {
        const { sm, pi, ctx } = setup();
        anchorStart(sm, pi);
        ctx.cwd = fixture.projectDir;
        ctx.isProjectTrusted = () => true;
        await runSessionStart(pi, ctx, fixture);
        ctx.setContextUsage(usageAt(50));
        fireTurnEnd(pi, ctx);
        assert.equal(pi.sendMessageCalls.length, 1);
        assert.deepEqual(ctx.notifyCalls, []);
      }

      // Untrusted: the project file is ignored silently; 50% does not
      // fire (500k left > 100k), 90% does.
      {
        const { sm, pi, ctx } = setup();
        anchorStart(sm, pi);
        ctx.cwd = fixture.projectDir;
        await runSessionStart(pi, ctx, fixture);
        ctx.setContextUsage(usageAt(50));
        fireTurnEnd(pi, ctx);
        assert.equal(pi.sendMessageCalls.length, 0);
        assert.deepEqual(ctx.notifyCalls, []);
        ctx.setContextUsage(usageAt(90));
        fireTurnEnd(pi, ctx);
        assert.equal(pi.sendMessageCalls.length, 1);
      }
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("invalid config disables the hint and surfaces one warning per layer", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, "{ not json");
      writeProjectConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: true }),
      );
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      ctx.cwd = fixture.projectDir;
      ctx.isProjectTrusted = () => true;
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, [
        [
          `navigate_tree: invalid JSON in global config at ${globalConfigPath(fixture)} — that layer was ignored.`,
          "warning",
        ],
        [
          `navigate_tree: invalid rewindHintReserveTokens in project config at ${projectConfigPath(fixture)} — expected integer 1000-1000000 or a disable sentinel (null, false, "off", "disabled"); rewind hint disabled for this session.`,
          "warning",
        ],
      ]);
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.equal(
        ctx.notifyCalls.length,
        2,
        "the turn must not add config warnings",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("the removed rewindHintAtPercent warns and leaves the hint off", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ rewindHintAtPercent: "90" }));
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, [
        [
          `navigate_tree: rewindHintAtPercent in global config at ${globalConfigPath(fixture)} was removed in 0.3.0 and is ignored — use rewindHintReserveTokens (tokens left in the window when the hint fires, e.g. 50000).`,
          "warning",
        ],
      ]);
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("suppresses config warnings when the session has no UI", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, "{ not json");
      const { pi, ctx } = setup();
      ctx.hasUI = false;
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("is default-off when no config exists (ENOENT is silent)", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, []);
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("reload resets the tracker and the toolActive gate", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 100_000 }),
      );
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);

      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        1,
        "spent crossing must not re-fire",
      );

      // Tool gate off: no fire, even across the threshold.
      await fireBeforeAgentStart(pi, ctx, ["read", "bash"]);
      ctx.setContextUsage(usageAt(10));
      fireTurnEnd(pi, ctx);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);

      // session_start resets both: gate back on, tracker re-armed.
      await runSessionStart(pi, ctx, fixture);
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        2,
        "reload must re-arm the tracker",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });
});

describe("rewind hint: turn_end handler (#44)", () => {
  const ENABLED_CONFIG = JSON.stringify({ rewindHintReserveTokens: 100_000 });

  async function enabledSetup(): Promise<{
    fixture: ConfigFixture;
    sm: SessionManager;
    pi: FakePi;
    ctx: FakeCtx;
  }> {
    const fixture = makeConfigFixture();
    writeGlobalConfig(fixture, ENABLED_CONFIG);
    const { sm, pi, ctx } = setup();
    anchorStart(sm, pi);
    await runSessionStart(pi, ctx, fixture);
    return { fixture, sm, pi, ctx };
  }

  it("does not fire when disabled by a sentinel", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: null }),
      );
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("does not fire when the tool is inactive", async () => {
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      await fireBeforeAgentStart(pi, ctx, ["read"]);
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("keeps the tool gate per-session (#58): a sibling session must not clear this session's hint", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, ENABLED_CONFIG);
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);

      // Session A runs with the tool active, recording A's per-session gate.
      await fireBeforeAgentStart(pi, ctx, [TOOL_NAME, "read"]);

      // Sibling session B (e.g. an in-process subagent) starts without it.
      const smB = SessionManager.inMemory("/tmp");
      const ctxB = makeCtx(smB);
      await fireBeforeAgentStart(pi, ctxB, ["read"]);

      // A crosses: the hint must still fire — i.e. B's `before_agent_start`
      // did not clear A's per-session gate.
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        1,
        "a sibling session's before_agent_start must not clear A's hint gate",
      );

      // Re-arm the shared tracker, then flip the shared fallback back on.
      ctx.setContextUsage(usageAt(10));
      fireTurnEnd(pi, ctx);
      await fireBeforeAgentStart(pi, ctx, [TOOL_NAME, "read"]);

      // B's own false gate must be honored (not silently fall back to the
      // shared true): B stays silent, must not spend the crossing, and A
      // must still fire after it.
      ctxB.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctxB);
      assert.equal(ctxB.notifyCalls.length, 0);
      assert.equal(pi.sendMessageCalls.length, 1);

      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 2);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("no-ops on missing/percent-null/zero-window usage without spending the crossing", async () => {
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      ctx.setContextUsage(undefined);
      fireTurnEnd(pi, ctx);
      ctx.setContextUsage({
        tokens: null,
        contextWindow: 1_000_000,
        percent: null,
      });
      fireTurnEnd(pi, ctx);
      ctx.setContextUsage({ tokens: 100, contextWindow: 0, percent: 95 });
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);

      // The crossing is still unspent — the first valid observation fires.
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("no-ops on tokens-null usage even when percent is set", async () => {
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      // A 50k window under the 100k reserve: without the tokens guard,
      // `contextWindow - null` (50k) would read as inside the reserve.
      ctx.setContextUsage({
        tokens: null,
        contextWindow: 50_000,
        percent: 99,
      });
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("fires on an overrun window (tokens > contextWindow) with 0.0k left", async () => {
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      ctx.setContextUsage({
        tokens: 1_050_000,
        contextWindow: 1_000_000,
        percent: 105,
      });
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      assert.equal(
        (pi.sendMessageCalls[0][0] as { content: string }).content,
        "[navigate_tree hint] Context is at 105.0% of 1.0M — 0.0k tokens left, within the 100.0k reserve. Persist what matters to files now, then rewind to the oldest appropriate anchor.\nActive anchors (root → leaf, % of 1.0M):\n   0.0%  start",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a spent crossing skips the anchor walk entirely", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);

      const calls = { getEntries: 0, getBranch: 0, getLabel: 0 };
      const target = sm as unknown as Record<
        keyof typeof calls,
        (...args: unknown[]) => unknown
      >;
      const originals = { ...calls } as unknown as typeof target;
      for (const name of Object.keys(calls) as Array<keyof typeof calls>) {
        const original = target[name].bind(sm);
        originals[name] = target[name];
        target[name] = (...args: unknown[]) => {
          calls[name]++;
          return original(...args);
        };
      }
      try {
        fireTurnEnd(pi, ctx);
        fireTurnEnd(pi, ctx);
      } finally {
        Object.assign(target, originals);
      }
      assert.equal(pi.sendMessageCalls.length, 1);
      // The hint's anchor walk reads every branch entry's label; the
      // admission estimate that precedes it reads entries only.
      assert.equal(calls.getLabel, 0);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("fires once per crossing and re-arms only after a drop below the bar", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 800_000 }),
      );
      const { sm, pi, ctx } = setup();
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(19));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);

      ctx.setContextUsage(usageAt(20));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);

      ctx.setContextUsage(usageAt(45));
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        1,
        "spent crossing must not re-fire",
      );

      ctx.setContextUsage(usageAt(12));
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        1,
        "re-arming alone must not fire",
      );

      ctx.setContextUsage(usageAt(21));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 2);
      assert.deepEqual(pi.sendMessageCalls[1], [
        {
          customType: REWIND_HINT_CUSTOM_TYPE,
          content: expectedHint(21, undefined, 800_000),
          display: true,
        },
      ]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("with no anchors: TUI notify with the exact copy, no model message", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, ENABLED_CONFIG);
      const { pi, ctx } = setup();
      // Deliberately NO anchor.
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, [
        [buildNoAnchorText(95, 1_000_000), "warning"],
      ]);

      // Spent: no second toast while still above.
      fireTurnEnd(pi, ctx);
      assert.equal(ctx.notifyCalls.length, 1);

      // Drop + re-cross re-arms.
      ctx.setContextUsage(usageAt(10));
      fireTurnEnd(pi, ctx);
      ctx.setContextUsage(usageAt(96));
      fireTurnEnd(pi, ctx);
      assert.equal(ctx.notifyCalls.length, 2);
      assert.deepEqual(ctx.notifyCalls[1], [
        buildNoAnchorText(96, 1_000_000),
        "warning",
      ]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("lists only names rewindTo accepts", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, ENABLED_CONFIG);
      const { sm, pi, ctx } = setup();
      const t0 = appendTurn(sm, "u-empty", "a-empty");
      pi.pi.setLabel(t0.assistantId, "anchor:");
      const t1 = appendTurn(sm, "u-upper", "a-upper");
      pi.pi.setLabel(t1.assistantId, "anchor:Foo");
      anchorStart(sm, pi);
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      const text = String(
        (pi.sendMessageCalls[0][0] as { content: unknown }).content,
      );
      assert.match(
        text,
        /\nActive anchors \(root → leaf, % of 1\.0M\):\n +[\d.]+% {2}start$/,
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("an empty-named manual label alone counts as no anchors", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, ENABLED_CONFIG);
      const { sm, pi, ctx } = setup();
      // `anchor:` is not a valid `rewindTo`, so the model must not be
      // pointed at it.
      const t = appendTurn(sm, "u-empty", "a-empty");
      pi.pi.setLabel(t.assistantId, "anchor:");
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, [
        [buildNoAnchorText(95, 1_000_000), "warning"],
      ]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("with no anchors and no UI: silent", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, ENABLED_CONFIG);
      const { pi, ctx } = setup();
      ctx.hasUI = false;
      await runSessionStart(pi, ctx, fixture);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("sendMessage throw falls back to appendCustomMessageEntry(customType, text, true)", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      const appendCalls: unknown[][] = [];
      (
        sm as unknown as {
          appendCustomMessageEntry: (...args: unknown[]) => string;
        }
      ).appendCustomMessageEntry = (...args: unknown[]) => {
        appendCalls.push(args);
        return "custom-id";
      };
      (
        pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
      ).sendMessage = () => {
        throw new Error("stale session runtime");
      };

      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.deepEqual(appendCalls, [
        [REWIND_HINT_CUSTOM_TYPE, expectedHint(95), true],
      ]);
      assert.deepEqual(
        ctx.notifyCalls,
        [],
        "a successful fallback must not warn",
      );

      // The crossing is spent even on the fallback path.
      ctx.setContextUsage(usageAt(96));
      fireTurnEnd(pi, ctx);
      assert.equal(appendCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("sendMessage + append double throw: warns with the exact copy, never throws", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      (
        sm as unknown as {
          appendCustomMessageEntry: (...args: unknown[]) => string;
        }
      ).appendCustomMessageEntry = () => {
        throw new Error("append exploded");
      };
      (
        pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
      ).sendMessage = () => {
        throw new Error("stale session runtime");
      };

      ctx.setContextUsage(usageAt(95));
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
      assert.deepEqual(ctx.notifyCalls, [
        [
          `${TOOL_NAME}: could not deliver the rewind hint (append exploded).`,
          "warning",
        ],
      ]);

      // The crossing is spent even on the double-failure path.
      fireTurnEnd(pi, ctx);
      assert.equal(ctx.notifyCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("double throw with no UI: silent, no throw, crossing spent", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      ctx.hasUI = false;
      let sendAttempts = 0;
      (
        sm as unknown as {
          appendCustomMessageEntry: (...args: unknown[]) => string;
        }
      ).appendCustomMessageEntry = () => {
        throw new Error("append exploded");
      };
      (
        pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
      ).sendMessage = () => {
        sendAttempts += 1;
        throw new Error("stale session runtime");
      };

      ctx.setContextUsage(usageAt(95));
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
      assert.equal(sendAttempts, 1);
      assert.deepEqual(ctx.notifyCalls, []);

      // The crossing is spent even on the double-failure path.
      fireTurnEnd(pi, ctx);
      assert.equal(sendAttempts, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a throwing ui.notify in the double-failure path cannot escape", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      (
        sm as unknown as {
          appendCustomMessageEntry: (...args: unknown[]) => string;
        }
      ).appendCustomMessageEntry = () => {
        throw new Error("append exploded");
      };
      (
        pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
      ).sendMessage = () => {
        throw new Error("stale session runtime");
      };
      let notifyAttempts = 0;
      ctx.ui.notify = () => {
        notifyAttempts += 1;
        throw new Error("notify exploded");
      };

      ctx.setContextUsage(usageAt(95));
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
      assert.equal(notifyAttempts, 1);

      // The crossing is spent even when the warning itself fails.
      fireTurnEnd(pi, ctx);
      assert.equal(notifyAttempts, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("captures sessionManager before sendMessage (post-throw ctx reads fail)", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      const appendCalls: unknown[][] = [];
      (
        sm as unknown as {
          appendCustomMessageEntry: (...args: unknown[]) => string;
        }
      ).appendCustomMessageEntry = (...args: unknown[]) => {
        appendCalls.push(args);
        return "custom-id";
      };
      (
        pi.pi as unknown as { sendMessage: (...args: unknown[]) => void }
      ).sendMessage = () => {
        throw new Error("stale session runtime");
      };

      // `sessionManager` serves exactly one read (the capture); a second
      // read is the stale-getter failure the fix must not depend on.
      let reads = 0;
      const proxyCtx = {
        get sessionManager(): SessionManager {
          reads += 1;
          if (reads > 1) throw new Error("stale session runtime");
          return sm;
        },
        getContextUsage: ctx.getContextUsage,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
      } as unknown as FakeCtx;

      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, proxyCtx);
      assert.equal(reads, 1, "sessionManager must be read exactly once");
      assert.deepEqual(appendCalls, [
        [REWIND_HINT_CUSTOM_TYPE, expectedHint(95), true],
      ]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a throwing anchor collection leaves the crossing unspent for a retry", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      const originalGetBranch = sm.getBranch;
      (sm as unknown as { getBranch: () => never }).getBranch = () => {
        throw new Error("getBranch exploded");
      };
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);

      (sm as unknown as { getBranch: typeof originalGetBranch }).getBranch =
        originalGetBranch;
      fireTurnEnd(pi, ctx);
      assert.equal(
        pi.sendMessageCalls.length,
        1,
        "a successful retry must still fire the crossing",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a throwing getEntries leaves the crossing unspent for a retry", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      const originalGetEntries = sm.getEntries;
      (sm as unknown as { getEntries: () => never }).getEntries = () => {
        throw new Error("getEntries exploded");
      };
      ctx.setContextUsage(usageAt(95));
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx));
      assert.equal(pi.sendMessageCalls.length, 0);

      (sm as unknown as { getEntries: typeof originalGetEntries }).getEntries =
        originalGetEntries;
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("the fired custom message is projected by the existing context handler", async () => {
    const { fixture, sm, pi, ctx } = await enabledSetup();
    try {
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);

      // pi's runtime persists a sent custom message as a `custom_message`
      // entry via `appendCustomMessageEntry`; emulate that write, then run
      // the extension's own `context` projection and assert the hint text
      // survives (no customType filtering in `buildContextMessages`).
      const text = expectedHint(95);
      sm.appendCustomMessageEntry(REWIND_HINT_CUSTOM_TYPE, text, true);
      const contextHandlers = pi.onCalls.get("context");
      assert.ok(contextHandlers, "factory must register a context handler");
      const projected = contextHandlers[0](
        { type: "context", messages: [] } as never,
        { sessionManager: sm } as never,
      ) as { messages: unknown[] };
      assert.ok(
        JSON.stringify(projected.messages).includes(
          JSON.stringify(text).slice(1, -1),
        ),
        "the rewind hint custom_message must survive the context projection",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("fails open when selectedTools is undefined (gate stays on)", async () => {
    // Complement to the earlier "tool inactive" case: an undefined
    // `selectedTools` (the fail-open branch) must leave the gate ON.
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      await fireBeforeAgentStart(pi, ctx, undefined);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("fires while TOOL_NAME is in the selected set", async () => {
    const { fixture, pi, ctx } = await enabledSetup();
    try {
      await fireBeforeAgentStart(pi, ctx, ["read", TOOL_NAME]);
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });
});

// =============================================================================
// automatic start anchor (#55)
//
// The extension writes a silent `anchor:start` label at the X-th turn of the
// agent run (config `anchorStartAfterTurns`, default 2), or at the run's end
// when the run finishes earlier. Per-session state (settle marker, config
// value, tool-active gate) is keyed by session id; the `findLabeledEntry`
// existence check on the active branch is authoritative. These tests drive
// the real session_start / turn_end / agent_end handlers against temp config
// fixtures (real loader, real fs) and in-memory SessionManagers. No LLM is
// involved.
// =============================================================================

describe("rewind hint: suppressed on turns a rewind owns (#80)", () => {
  /** Hint `sendMessage` calls (the only kind this extension makes). */
  function hintCalls(pi: FakePi): unknown[][] {
    return pi.sendMessageCalls.filter(
      (args) =>
        (args[0] as { customType?: string } | undefined)?.customType ===
        REWIND_HINT_CUSTOM_TYPE,
    );
  }

  it("skips the turn that runs the rewind's fold; the crossing fires on the next normal turn", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 100_000 }),
      );
      const f = setup();
      setupRewindable(f.sm, f.pi, { capture: true });
      await runSessionStart(f.pi, f.ctx, fixture);
      f.ctx.setContextUsage(usageAt(95));

      await requestRewind(f);
      assert.equal(rewindMessages(f.pi)[0].message.details.status, "done");
      assert.equal(hintCalls(f.pi).length, 0, "the rewind call's turn");

      // The crossing stayed unspent: the next normal turn fires it once.
      // The fold replaced the measured context, so pi measures it again.
      f.ctx.setContextUsage(usageAt(95));
      const next = assistantMessage([{ type: "text", text: "next" }], "stop");
      f.sm.appendMessage(next as never);
      const boundary = await fireTurnEndAll(f.pi, f.ctx, next);
      assert.deepEqual(boundary, { entries: [], continue: false });
      assert.deepEqual(hintCalls(f.pi), [
        [
          {
            customType: REWIND_HINT_CUSTOM_TYPE,
            content: expectedHint(
              95,
              "Active anchors (root → leaf, % of 1.0M):\n   0.6%  start\n   0.6%  end",
            ),
            display: true,
          },
        ],
      ]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("the start anchor skips the turn that runs the rewind's fold (#90)", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 100_000 }),
      );
      const f = setup();
      // Anchor `a`, not `start`: the auto start anchor must be the writer.
      setupRewindable(f.sm, f.pi, { capture: true, rewindToName: "a" });
      await runSessionStart(f.pi, f.ctx, fixture);
      assert.deepEqual(f.ctx.notifyCalls, []);
      f.ctx.setContextUsage(usageAt(95));
      // The turn is the default X=2: the anchor would be written here.
      await requestRewind(
        f,
        { ...REWIND_ARGS, rewindTo: "a" },
        "tc-rewind",
        undefined,
        { turnIndex: 1 },
      );
      assert.equal(rewindMessages(f.pi)[0].message.details.status, "done");
      assert.equal(hintCalls(f.pi).length, 0);
      assert.ok(
        !f.sm
          .getEntries()
          .some((e) => e.type === "label" && e.label === START_ANCHOR_LABEL),
        "never on a turn whose work is about to be folded away",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });
});

describe("rewind hint: per-model modelOverrides (#86)", () => {
  const SONNET = "claude/claude-sonnet-4-5";

  async function overrideSetup(config: unknown): Promise<{
    fixture: ConfigFixture;
    pi: FakePi;
    ctx: FakeCtx;
  }> {
    const fixture = makeConfigFixture();
    writeGlobalConfig(fixture, JSON.stringify(config));
    const { sm, pi, ctx } = setup();
    anchorStart(sm, pi);
    await runSessionStart(pi, ctx, fixture);
    return { fixture, pi, ctx };
  }

  it("a matching entry overrides the base reserve", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 20_000,
      modelOverrides: { [SONNET]: { rewindHintReserveTokens: 100_000 } },
    });
    try {
      // 92% of 1M = 80k left: inside the 100k entry, outside the 20k base.
      ctx.setContextUsage(usageAt(92));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      assert.match(
        String((pi.sendMessageCalls[0][0] as { content: unknown }).content),
        /within the 100\.0k reserve/,
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("an off entry disables the hint for that model only", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 100_000,
      modelOverrides: { [SONNET]: { rewindHintReserveTokens: "off" } },
    });
    try {
      ctx.setContextUsage(usageAt(99));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      // Switching to an unmatched model falls back to the base reserve.
      ctx.model = { api: "openai", provider: "x", id: "other" };
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      assert.match(
        String((pi.sendMessageCalls[0][0] as { content: unknown }).content),
        /within the 100\.0k reserve/,
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("an entry enables a model while the base is off", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      modelOverrides: { [SONNET]: { rewindHintReserveTokens: 100_000 } },
    });
    try {
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      // An unmatched model gets no hint (base off), but its turns still
      // observe the climb back out, so the next crossing fires again.
      ctx.model = { api: "openai", provider: "x", id: "other" };
      ctx.setContextUsage(usageAt(96));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      ctx.setContextUsage(usageAt(10));
      fireTurnEnd(pi, ctx);
      ctx.model = {
        api: "anthropic",
        provider: "claude",
        id: "claude-sonnet-4-5",
      };
      ctx.setContextUsage(usageAt(96));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 2);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a model switch re-reads the reserve on the next turn", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 20_000,
      modelOverrides: { "x/big": { rewindHintReserveTokens: 100_000 } },
    });
    try {
      // 80k left: outside the 20k base for the default model.
      ctx.setContextUsage(usageAt(92));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      ctx.model = { api: "openai", provider: "x", id: "big" };
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("no model falls back to the base reserve", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 100_000,
      modelOverrides: { [SONNET]: { rewindHintReserveTokens: "off" } },
    });
    try {
      ctx.model = undefined;
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("a throwing ctx.model getter skips the turn without spending the crossing", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 100_000,
      modelOverrides: { "x/y": { rewindHintReserveTokens: 50_000 } },
    });
    try {
      const live = ctx.model;
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get() {
          throw new Error("stale ctx");
        },
      });
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 0);
      Object.defineProperty(ctx, "model", {
        configurable: true,
        writable: true,
        value: live,
      });
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("without modelOverrides, ctx.model is never read", async () => {
    const { fixture, pi, ctx } = await overrideSetup({
      rewindHintReserveTokens: 100_000,
    });
    try {
      let reads = 0;
      const live = ctx.model;
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get() {
          reads++;
          return live;
        },
      });
      ctx.setContextUsage(usageAt(95));
      fireTurnEnd(pi, ctx);
      assert.equal(pi.sendMessageCalls.length, 1);
      assert.equal(reads, 0);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });
});

describe("automatic start anchor (#55)", () => {
  const ENV_KEY = "PI_NAVIGATE_TREE_START_ANCHOR";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    savedEnv = undefined;
  });

  it("registers exactly one agent_end handler", () => {
    const { pi } = setup();
    const handlers = pi.onCalls.get("agent_end");
    assert.ok(handlers, "factory must register an agent_end handler");
    assert.equal(handlers.length, 1);
  });

  it("defaults to X=2 with no config: silent write at the 2nd turn, no model message, no UI", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, [], "absent config must not warn");

      appendTurn(sm, "u1", "a1");
      const leaf1 = sm.getLeafId();
      fireTurnEnd(pi, ctx, 0); // turn 1: below X
      assert.equal(pi.setLabelCalls.length, 0);
      assert.equal(sm.getLabel(leaf1 as string), undefined);

      appendTurn(sm, "u2", "a2");
      const leaf2 = sm.getLeafId();
      fireTurnEnd(pi, ctx, 1); // turn 2: triggers
      assert.equal(pi.setLabelCalls.length, 1);
      assert.deepEqual(pi.setLabelCalls[0], [leaf2, START_ANCHOR_LABEL]);
      assert.equal(sm.getLabel(leaf2 as string), START_ANCHOR_LABEL);
      assert.equal(__testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL), leaf2);
      // Silent: label entry only — no model message, no UI.
      assert.equal(pi.sendMessageCalls.length, 0);
      assert.deepEqual(ctx.notifyCalls, []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("honors a configured X and anchors the X-th turn's persisted tail", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 3 }));
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);

      appendTurn(sm, "u1", "a1");
      fireTurnEnd(pi, ctx, 0);
      assert.equal(pi.setLabelCalls.length, 0, "turn 1 must not fire at X=3");
      appendTurn(sm, "u2", "a2");
      fireTurnEnd(pi, ctx, 1);
      assert.equal(pi.setLabelCalls.length, 0, "turn 2 must not fire at X=3");
      appendTurn(sm, "u3", "a3");
      const leaf = sm.getLeafId();
      fireTurnEnd(pi, ctx, 2);
      assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("project X overrides global when trusted; an untrusted project is ignored", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 5 }));
      writeProjectConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 2 }));

      // Trusted: project 2 fires at the 2nd turn.
      {
        const { sm, pi, ctx } = setup();
        ctx.cwd = fixture.projectDir;
        ctx.isProjectTrusted = () => true;
        await runSessionStart(pi, ctx, fixture);
        appendTurn(sm, "u1", "a1");
        appendTurn(sm, "u2", "a2");
        fireTurnEnd(pi, ctx, 1);
        assert.equal(pi.setLabelCalls.length, 1);
      }

      // Untrusted: global 5 applies; the 2nd turn must not fire.
      {
        const { sm, pi, ctx } = setup();
        ctx.cwd = fixture.projectDir;
        await runSessionStart(pi, ctx, fixture);
        appendTurn(sm, "u1", "a1");
        appendTurn(sm, "u2", "a2");
        fireTurnEnd(pi, ctx, 1);
        assert.equal(pi.setLabelCalls.length, 0);
      }
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("invalid project X warns and falls through to the valid global layer", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 3 }));
      writeProjectConfig(
        fixture,
        JSON.stringify({ anchorStartAfterTurns: "nope" }),
      );
      const { sm, pi, ctx } = setup();
      ctx.cwd = fixture.projectDir;
      ctx.isProjectTrusted = () => true;
      await runSessionStart(pi, ctx, fixture);
      assert.deepEqual(ctx.notifyCalls, [
        [
          `navigate_tree: invalid anchorStartAfterTurns in project config at ${projectConfigPath(fixture)} — expected integer ${START_ANCHOR_MIN_TURNS}-${START_ANCHOR_MAX_TURNS}; falling back to the other layer's valid value, else the default ${START_ANCHOR_DEFAULT_TURNS}.`,
          "warning",
        ],
      ]);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const leaf = sm.getLeafId();
      fireTurnEnd(pi, ctx, 2); // global X=3
      assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("loads the field for all five session_start reasons", async () => {
    const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
    for (const reason of reasons) {
      const fixture = makeConfigFixture();
      try {
        writeGlobalConfig(
          fixture,
          JSON.stringify({ anchorStartAfterTurns: 4 }),
        );
        const { sm, pi, ctx } = setup();
        await runSessionStart(pi, ctx, fixture, reason);
        assert.deepEqual(
          ctx.notifyCalls,
          [],
          `${reason}: valid config must not warn`,
        );
        for (let i = 0; i < 3; i++) {
          appendTurn(sm, `u${i}`, `a${i}`);
          fireTurnEnd(pi, ctx, i);
        }
        assert.equal(pi.setLabelCalls.length, 0, `${reason}: below X`);
        appendTurn(sm, "u4", "a4");
        fireTurnEnd(pi, ctx, 3);
        assert.equal(pi.setLabelCalls.length, 1, `${reason}: X-th turn writes`);
      } finally {
        cleanupConfigFixture(fixture);
      }
    }
  });

  it("agent_end fallback settles a run shorter than X at the run's end", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ anchorStartAfterTurns: 5 }));
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      fireTurnEnd(pi, ctx, 0);
      appendTurn(sm, "u2", "a2");
      fireTurnEnd(pi, ctx, 1);
      const leaf = sm.getLeafId();
      assert.equal(pi.setLabelCalls.length, 0);
      fireAgentEnd(pi, ctx);
      assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
      assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("agent_end after a run with no turns anchors the last persisted entry (user message)", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      const userId = sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: "only a user message" }],
      } as never);
      fireAgentEnd(pi, ctx);
      assert.deepEqual(pi.setLabelCalls, [[userId, START_ANCHOR_LABEL]]);
      assert.equal(sm.getLabel(userId), START_ANCHOR_LABEL);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("settles after the first write: later turns and a second agent run never re-insert", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const firstLeaf = sm.getLeafId();
      fireTurnEnd(pi, ctx, 1);
      assert.equal(pi.setLabelCalls.length, 1);
      fireAgentEnd(pi, ctx); // same run's end: settled, no-op
      appendTurn(sm, "u3", "a3");
      fireTurnEnd(pi, ctx, 1); // second run's 2nd turn: no-op
      fireAgentEnd(pi, ctx);
      assert.equal(pi.setLabelCalls.length, 1, "must never re-insert");
      assert.equal(
        __testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL),
        firstLeaf,
        "the original label target must not move",
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("an existing anchor:start wins (manual /tree label): skip + settle, never write", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      const t = appendTurn(sm, "u1", "a1");
      pi.pi.setLabel(t.assistantId, START_ANCHOR_LABEL);
      appendTurn(sm, "u2", "a2");
      const writesBefore = pi.setLabelCalls.length;
      fireTurnEnd(pi, ctx, 1);
      fireAgentEnd(pi, ctx);
      appendTurn(sm, "u3", "a3");
      fireTurnEnd(pi, ctx, 1);
      assert.equal(
        pi.setLabelCalls.length,
        writesBefore,
        "an existing label must settle the session without a write",
      );
      assert.equal(sm.getLabel(t.assistantId), START_ANCHOR_LABEL);
      assert.equal(
        __testHooks.findLabeledEntry(sm, START_ANCHOR_LABEL),
        t.assistantId,
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("toolActive gate: inactive tool skips; reactivated tool writes", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      await fireBeforeAgentStart(pi, ctx, ["read"]);
      fireTurnEnd(pi, ctx, 1);
      fireAgentEnd(pi, ctx);
      assert.equal(pi.setLabelCalls.length, 0);
      await fireBeforeAgentStart(pi, ctx, ["read", TOOL_NAME]);
      fireAgentEnd(pi, ctx);
      assert.equal(pi.setLabelCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("kill switch is read at write time: =0 skips both triggers; unset retries", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const leaf = sm.getLeafId();
      process.env[ENV_KEY] = "0";
      fireTurnEnd(pi, ctx, 1);
      fireAgentEnd(pi, ctx);
      assert.equal(
        pi.setLabelCalls.length,
        0,
        "kill switch must suppress both triggers",
      );
      delete process.env[ENV_KEY];
      // A skipped settle left the session unsettled: the next trigger retries.
      fireAgentEnd(pi, ctx);
      assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("setLabel throw falls back to appendLabelChange(leafId, 'anchor:start') and settles", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const leaf = sm.getLeafId();
      const appendCalls: unknown[][] = [];
      const origAppend = sm.appendLabelChange.bind(sm);
      (
        sm as unknown as {
          appendLabelChange: (...args: unknown[]) => string;
        }
      ).appendLabelChange = (...args: unknown[]) => {
        appendCalls.push(args);
        return origAppend(args[0] as string, args[1] as string | undefined);
      };
      (
        pi.pi as unknown as { setLabel: (...args: unknown[]) => void }
      ).setLabel = () => {
        throw new Error("stale session runtime");
      };
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
      assert.deepEqual(appendCalls, [[leaf, START_ANCHOR_LABEL]]);
      assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
      // Settled via the fallback: later triggers are no-ops.
      fireTurnEnd(pi, ctx, 1);
      fireAgentEnd(pi, ctx);
      assert.equal(appendCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("double write failure stays fail-open and unsettled for the next retry", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const origSetLabel = pi.pi.setLabel.bind(pi.pi);
      const origAppend = sm.appendLabelChange.bind(sm);
      (
        pi.pi as unknown as { setLabel: (...args: unknown[]) => void }
      ).setLabel = () => {
        throw new Error("stale session runtime");
      };
      (
        sm as unknown as {
          appendLabelChange: (...args: unknown[]) => string;
        }
      ).appendLabelChange = () => {
        throw new Error("append exploded");
      };
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
      assert.equal(pi.setLabelCalls.length, 0);
      // Restore both: the unsettled session retries and succeeds at the
      // run end.
      (pi.pi as unknown as { setLabel: typeof pi.pi.setLabel }).setLabel =
        origSetLabel;
      (
        sm as unknown as { appendLabelChange: typeof sm.appendLabelChange }
      ).appendLabelChange = origAppend;
      fireAgentEnd(pi, ctx);
      assert.equal(pi.setLabelCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("existence-check read failure leaves the session unsettled (retries later)", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const origGetBranch = sm.getBranch.bind(sm);
      let armed = true;
      (sm as unknown as { getBranch: () => unknown }).getBranch = () => {
        if (armed) throw new Error("getBranch boom");
        return origGetBranch();
      };
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
      assert.equal(pi.setLabelCalls.length, 0);
      armed = false;
      fireAgentEnd(pi, ctx);
      assert.equal(pi.setLabelCalls.length, 1);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("setLabel throw with a missing appendLabelChange stays unsettled and retries", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const leaf = sm.getLeafId();
      const origSetLabel = pi.pi.setLabel.bind(pi.pi);
      const origAppend = sm.appendLabelChange.bind(sm);
      (
        pi.pi as unknown as { setLabel: (...args: unknown[]) => void }
      ).setLabel = () => {
        throw new Error("stale session runtime");
      };
      (sm as unknown as { appendLabelChange: unknown }).appendLabelChange =
        undefined;
      // A missing fallback method is NOT a successful write: no label, no
      // settle, and nothing throws into the loop.
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
      assert.equal(
        sm.getLabel(leaf as string),
        undefined,
        "no write may be recorded",
      );
      // Restore both: the still-unsettled session retries at the run end.
      (pi.pi as unknown as { setLabel: typeof pi.pi.setLabel }).setLabel =
        origSetLabel;
      (
        sm as unknown as { appendLabelChange: typeof sm.appendLabelChange }
      ).appendLabelChange = origAppend;
      fireAgentEnd(pi, ctx);
      assert.deepEqual(pi.setLabelCalls, [[leaf, START_ANCHOR_LABEL]]);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("appendLabelChange fallback preserves the method receiver (this === SessionManager)", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      const leaf = sm.getLeafId();
      const origAppend = sm.appendLabelChange.bind(sm);
      // Prototype-style method that needs its receiver: an unbound
      // `append(...)` call loses `this` and throws instead of writing.
      (
        sm as unknown as {
          appendLabelChange: (
            entryId: string,
            label: string | undefined,
          ) => string;
        }
      ).appendLabelChange = function (
        this: unknown,
        entryId: string,
        label: string | undefined,
      ) {
        if (this !== sm) {
          throw new Error("appendLabelChange lost its receiver");
        }
        return origAppend(entryId, label);
      };
      (
        pi.pi as unknown as { setLabel: (...args: unknown[]) => void }
      ).setLabel = () => {
        throw new Error("stale session runtime");
      };
      assert.doesNotThrow(() => fireTurnEnd(pi, ctx, 1));
      assert.equal(sm.getLabel(leaf as string), START_ANCHOR_LABEL);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("per-session config: a later session_start must not retune an earlier session", async () => {
    const fixtureA = makeConfigFixture();
    const fixtureB = makeConfigFixture();
    try {
      writeGlobalConfig(fixtureA, JSON.stringify({ anchorStartAfterTurns: 5 }));
      writeGlobalConfig(fixtureB, JSON.stringify({ anchorStartAfterTurns: 1 }));
      const smA = SessionManager.inMemory("/tmp");
      const smB = SessionManager.inMemory("/tmp");
      const pi = makeFakePi(smA);
      navigateTree(pi.pi);
      const ctxA = makeCtx(smA);
      const ctxB = makeCtx(smB);
      const writes: Array<[string, string | undefined]> = [];
      let target = smA;
      (
        pi.pi as unknown as {
          setLabel: (entryId: string, label: string | undefined) => void;
        }
      ).setLabel = (entryId, label) => {
        writes.push([entryId, label]);
        target.appendLabelChange(entryId, label);
      };
      // B starts second and loads X=1; A must keep its own X=5.
      await runSessionStart(pi, ctxA, fixtureA);
      await runSessionStart(pi, ctxB, fixtureB);

      appendTurn(smA, "a-u1", "a-a1");
      appendTurn(smA, "a-u2", "a-a2");
      appendTurn(smB, "b-u1", "b-a1");

      fireTurnEnd(pi, ctxA, 1); // A: 2 < 5, no write
      assert.equal(writes.length, 0, "A must keep its X=5");

      target = smB;
      const leafB = smB.getLeafId();
      fireTurnEnd(pi, ctxB, 0); // B: 1 >= 1, writes at its first turn
      assert.deepEqual(writes, [[leafB, START_ANCHOR_LABEL]]);
      assert.equal(
        __testHooks.findLabeledEntry(smA, START_ANCHOR_LABEL),
        null,
        "A must stay unanchored",
      );
    } finally {
      cleanupConfigFixture(fixtureA);
      cleanupConfigFixture(fixtureB);
    }
  });

  it("per-session toolActive: a sibling session's inactive gate must not suppress this one", async () => {
    const fixture = makeConfigFixture();
    try {
      const smA = SessionManager.inMemory("/tmp");
      const smB = SessionManager.inMemory("/tmp");
      const pi = makeFakePi(smA);
      navigateTree(pi.pi);
      const ctxA = makeCtx(smA);
      const ctxB = makeCtx(smB);
      const writes: Array<[string, string | undefined]> = [];
      let target = smA;
      (
        pi.pi as unknown as {
          setLabel: (entryId: string, label: string | undefined) => void;
        }
      ).setLabel = (entryId, label) => {
        writes.push([entryId, label]);
        target.appendLabelChange(entryId, label);
      };
      await runSessionStart(pi, ctxA, fixture);
      await runSessionStart(pi, ctxB, fixture);
      appendTurn(smA, "a-u1", "a-a1");
      appendTurn(smA, "a-u2", "a-a2");
      appendTurn(smB, "b-u1", "b-a1");
      appendTurn(smB, "b-u2", "b-a2");

      // A has the tool active; B is a restricted sibling session.
      await fireBeforeAgentStart(pi, ctxA, ["read", TOOL_NAME]);
      await fireBeforeAgentStart(pi, ctxB, ["read"]);

      target = smA;
      fireTurnEnd(pi, ctxA, 1);
      assert.equal(writes.length, 1, "A must write despite B's inactive gate");
      target = smB;
      fireTurnEnd(pi, ctxB, 1);
      assert.equal(writes.length, 1, "B must stay gated");
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("per-session keying: interleaved sessions settle independently", async () => {
    const fixture = makeConfigFixture();
    try {
      const smA = SessionManager.inMemory("/tmp");
      const smB = SessionManager.inMemory("/tmp");
      const pi = makeFakePi(smA);
      navigateTree(pi.pi);
      const ctxA = makeCtx(smA);
      const ctxB = makeCtx(smB);
      const writes: Array<[string, string | undefined]> = [];
      let target = smA;
      (
        pi.pi as unknown as {
          setLabel: (entryId: string, label: string | undefined) => void;
        }
      ).setLabel = (entryId, label) => {
        writes.push([entryId, label]);
        target.appendLabelChange(entryId, label);
      };
      await runSessionStart(pi, ctxA, fixture);
      await runSessionStart(pi, ctxB, fixture);

      appendTurn(smA, "a-u1", "a-a1");
      appendTurn(smB, "b-u1", "b-a1");
      appendTurn(smA, "a-u2", "a-a2");
      appendTurn(smB, "b-u2", "b-a2");

      // B settles first; that must not suppress A's independent settle.
      target = smB;
      fireTurnEnd(pi, ctxB, 1);
      assert.equal(writes.length, 1);
      target = smA;
      fireTurnEnd(pi, ctxA, 1);
      assert.equal(writes.length, 2);

      // Both settled: interleaved re-fires are no-ops.
      fireTurnEnd(pi, ctxB, 1);
      fireTurnEnd(pi, ctxA, 1);
      fireAgentEnd(pi, ctxB);
      fireAgentEnd(pi, ctxA);
      assert.equal(writes.length, 2);
      assert.ok(__testHooks.findLabeledEntry(smA, START_ANCHOR_LABEL));
      assert.ok(__testHooks.findLabeledEntry(smB, START_ANCHOR_LABEL));
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("anchor(name='start') is refused when the automatic label exists (reservation moot)", async () => {
    const fixture = makeConfigFixture();
    try {
      const { sm, pi, tool, ctx } = setup();
      await runSessionStart(pi, ctx, fixture);
      appendTurn(sm, "u1", "a1");
      appendTurn(sm, "u2", "a2");
      fireTurnEnd(pi, ctx, 1);
      assert.equal(pi.setLabelCalls.length, 1);
      appendTurn(sm, "u3", "a3");
      const result = await tool.execute(
        "tc-1",
        { action: "anchor", name: "start" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /A label 'start' already exists on the active branch/,
      );
    } finally {
      cleanupConfigFixture(fixture);
    }
  });
});

describe("README: history-mirroring providers", () => {
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );

  it("does not claim the summary is the paused Claude Code query", () => {
    assert.doesNotMatch(readme, /paused Claude Code query/);
  });

  it("marks independent summary calls as untested on mirroring providers", () => {
    assert.match(
      readme,
      /Independent summary calls\.\*\* Registry side requests and chunked evidence are unverified on this history-mirroring provider/,
    );
  });
});

describe("README: independent overflow recovery", () => {
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );

  it("documents recovery without forced rewinds or withheld tool results", () => {
    assert.match(readme, /### Independent overflow recovery/);
    assert.doesNotMatch(readme, /rewind-driven compaction/);
    assert.doesNotMatch(readme, /withheld notice/);
    assert.doesNotMatch(readme, /only rewind is allowed until it lands/);
  });

  it("documents the failure receipt instead of a forced-rewind gate", () => {
    assert.ok(
      readme.includes("Request stopped before generation: estimated input"),
    );
    assert.match(readme, /actionable receipt instead of an unbounded retry/);
  });
});

// =============================================================================
// Rewind-driven compaction (#101)
//
// The overflow turns are simulated: the overflowed assistant is appended as
// pi persists it, then the boundaries fire in pi's order (`turn_end`,
// `agent_end`, `agent_before_settle`, `agent_settled`). Window 100k, hint
// reserve 20k, pi's compaction off with its default reserve (16384), so the
// target is 83 616 tokens.
// =============================================================================

describe("rewind-driven compaction (#101)", () => {
  const WINDOW = 100_000;
  const BIG = "x".repeat(48_000); // ~12k tokens
  const theme = { fg: (color: string, text: string) => `<${color}>${text}` };

  interface Forced {
    fixture: ConfigFixture;
    sm: SessionManager;
    pi: FakePi;
    ctx: FakeCtx;
    tool: CapturedTool;
    /** The batch: the issuing assistant and its two big results (r1, r2). */
    issuerId: string;
    r1: string;
    r2: string;
  }

  async function forcedSetup(
    opts: {
      config?: Record<string, unknown>;
      piSettings?: Record<string, unknown>;
      anchor?: boolean;
      issuerTokens?: number;
    } = {},
  ): Promise<Forced> {
    const fixture = makeConfigFixture();
    writeGlobalConfig(
      fixture,
      JSON.stringify(opts.config ?? { rewindHintReserveTokens: 20_000 }),
    );
    if (opts.piSettings) writePiSettings(fixture, opts.piSettings);
    const f = setup({ contextWindow: WINDOW });
    (f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
    f.ctx.cwd = fixture.projectDir;
    await runSessionStart(f.pi, f.ctx, fixture);
    const t = appendTurn(f.sm, "u1", "a1", 5_000);
    if (opts.anchor ?? true) f.pi.pi.setLabel(t.assistantId, "anchor:start");
    appendTurn(f.sm, "u2", "a2", 20_000);
    const issuer = appendToolCallAssistant(
      f.sm,
      [
        { id: "r1", name: "read", arguments: { path: "a" } },
        { id: "r2", name: "read", arguments: { path: "b" } },
      ],
      opts.issuerTokens ?? 60_000,
    );
    const r1 = appendToolResult(f.sm, "r1", "read", BIG);
    const r2 = appendToolResult(f.sm, "r2", "read", BIG);
    return { fixture, ...f, issuerId: issuer.id, r1, r2 };
  }

  function errorOverflow(sm: SessionManager, provider = "claude") {
    const message = {
      ...assistantMessage([], "error", 0),
      provider,
      errorMessage: "prompt is too long: 106000 tokens > 100000 maximum",
    };
    return { id: sm.appendMessage(message as never), message };
  }

  /** pi's order after an error turn: turn_end, agent_end, before_settle. */
  async function runErrorEnd(f: Forced, message: unknown, cont = false) {
    const turn = await fireTurnEndAll(f.pi, f.ctx, message);
    for (const h of f.pi.onCalls.get("agent_end") ?? []) {
      h({ type: "agent_end", messages: [message] } as never, f.ctx as never);
    }
    const settle = await fireAgentBeforeSettle(f.pi, f.ctx, {
      outcome: "error",
      continue: cont,
    });
    return { turn, settle };
  }

  function forcedDrafts(result: BoundaryResult) {
    return result.entries.filter((d) => d.customType === REWIND_CUSTOM_TYPE);
  }

  it("explicit error: independently folds at agent_before_settle without withholding results", async () => {
    const f = await forcedSetup();
    try {
      const archived = structuredClone(f.sm.getEntries());
      const err = errorOverflow(f.sm);
      const { turn, settle } = await runErrorEnd(f, err.message);
      assert.deepEqual(turn.entries, []);
      assert.equal(settle.continue, true);
      assert.equal(
        settle.entries.some((entry) => entry.type === "context_edit"),
        false,
      );
      const [done] = forcedDrafts(settle);
      assert.equal(done.details.status, "done");
      assert.ok(f.ctx.registryCalls.length > 0);
      assert.ok(
        f.sm.getBranch().some((entry) => entry.type === "branch_summary"),
      );
      for (const entry of archived)
        assert.deepEqual(f.sm.getEntry(entry.id), entry);
      const wire = fireContext(f.pi, f.ctx);
      assert.ok(!wire.some((message) => message.stopReason === "error"));
      assert.ok(!JSON.stringify(wire).includes("Output withheld"));
      assert.equal(f.sm.getLabel(err.id), undefined);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  for (const change of ["model", "session"] as const) {
    it(`explicit recovery refuses a stale ${change} before committing`, async () => {
      const f = await forcedSetup();
      try {
        f.ctx.modelRegistry = fakeRegistry(() => {
          if (change === "model") {
            assert.ok(f.ctx.model);
            f.ctx.model = { ...f.ctx.model, id: "changed-model" };
          } else
            f.ctx.sessionManager = SessionManager.inMemory(
              "/tmp/replaced-recovery-session",
            );
          return reply(SUMMARY_TEXT);
        }).registry;
        const { settle } = await runErrorEnd(f, errorOverflow(f.sm).message);
        assert.equal(settle.continue, false);
        assert.equal(
          f.sm.getBranch().some((entry) => entry.type === "branch_summary"),
          false,
        );
        assert.equal(forcedDrafts(settle)[0].details.status, "failed");
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    });
  }

  it("squeezed length: recovered at turn_end, the reply and its failed calls hidden", async () => {
    const f = await forcedSetup();
    try {
      const message = {
        ...assistantMessage(
          [{ type: "toolCall", id: "w1", name: "write", arguments: {} }],
          "length",
          0,
        ),
        usage: { ...usageOf(99_000), output: 100 },
      };
      const id = f.sm.appendMessage(message as never);
      const failed = appendToolResult(f.sm, "w1", "write", "truncated");
      const turn = await fireTurnEndAll(f.pi, f.ctx, message, {
        turnIndex: 1,
      });
      assert.equal(turn.continue, true);
      const edits = turn.entries.filter((d) => d.type === "context_edit");
      assert.deepEqual(
        edits.map((d) => [d.targetId, d.replacement === null]),
        [],
      );
      const suppressed = f.sm
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "context_edit" && entry.replacement === null,
        )
        .map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
      assert.deepEqual(suppressed, [id, failed]);
      const wire = JSON.stringify(fireContext(f.pi, f.ctx));
      assert.ok(!wire.includes("truncated"));
      assert.ok(!wire.includes('"w1"'));
      assert.equal(forcedDrafts(turn)[0].details.status, "done");
      assert.ok(f.ctx.registryCalls.length > 0);
      // Rewind-owned: no start anchor on the overflowed turn (X = 2).
      assert.equal(f.sm.getLabel(id), undefined);
      assert.equal(f.pi.sendMessageCalls.length, 0, "no hint");
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  for (const stopReason of ["length", "stop"] as const) {
    for (const owner of [
      "extension",
      "native",
      "native-retry",
      "cancel",
    ] as const) {
      it(`${stopReason} recovery stands down for ${owner} ownership`, async () => {
        const f = await forcedSetup({
          piSettings: { compaction: { enabled: owner === "native" } },
        });
        try {
          const aborter = new AbortController();
          const ctx = { ...f.ctx, signal: aborter.signal };
          if (owner === "cancel") aborter.abort();
          if (owner === "native-retry") {
            for (const handler of f.pi.onCalls.get("session_before_compact") ??
              []) {
              await handler(
                {
                  type: "session_before_compact",
                  reason: "overflow",
                  willRetry: true,
                } as never,
                ctx as never,
              );
            }
          }
          const message = {
            ...assistantMessage(
              [{ type: "text", text: "overflow evidence" }],
              stopReason,
              0,
            ),
            usage: { ...usageOf(105_000), input: 105_000 },
          };
          f.sm.appendMessage(message as never);
          const before = structuredClone(f.sm.getEntries());
          const boundary = await fireTurnEndAll(f.pi, ctx, message, {
            continue: owner === "extension",
          });
          assert.equal(boundary.continue, owner === "extension");
          assert.deepEqual(boundary.entries, []);
          assert.deepEqual(f.sm.getEntries(), before);
          assert.equal(f.ctx.registryCalls.length, 0);
          assert.equal(f.pi.onCalls.has("tool_call"), false);
        } finally {
          cleanupConfigFixture(f.fixture);
        }
      });
    }
  }

  it("pi compaction on: the overflowed reply gets no start anchor (#101, D14)", async () => {
    // Pi compaction is on: rewind-driven compaction stands down, so the
    // overflowed turn is not rewind-owned. It must still not be anchored.
    const f = await forcedSetup({
      anchor: false,
      piSettings: { compaction: { enabled: true } },
    });
    try {
      const message = {
        ...assistantMessage([{ type: "text", text: "done" }], "stop", 0),
        usage: { ...usageOf(105_000), input: 105_000 },
      };
      const id = f.sm.appendMessage(message as never);
      await fireTurnEndAll(f.pi, f.ctx, message, { turnIndex: 1 });
      assert.equal(f.sm.getLabel(id), undefined);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("silent stop overflow: preserves successful evidence and the pending input without withholding", async () => {
    const f = await forcedSetup();
    try {
      f.sm.appendMessage({
        role: "user",
        content: "protected".repeat(7_000),
        timestamp: 0,
      } as never);
      const message = {
        ...assistantMessage([{ type: "text", text: "done" }], "stop", 0),
        usage: { ...usageOf(105_000), input: 105_000 },
      };
      const id = f.sm.appendMessage(message as never);
      const turn = await fireTurnEndAll(f.pi, f.ctx, message);
      assert.equal(turn.continue, true);
      const edits = turn.entries.filter((d) => d.type === "context_edit");
      assert.deepEqual(edits, []);
      assert.ok(!hiddenIds(f.sm).has(id));
      assert.equal(forcedDrafts(turn)[0].details.status, "done");
      const wire = fireContext(f.pi, f.ctx);
      assert.ok(JSON.stringify(wire).includes("protected"));
      assert.ok(JSON.stringify(wire).includes("done"));
      assert.ok(!JSON.stringify(wire).includes("Output withheld"));
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("does not trigger: another model, a non-overflow error, compaction on, another extension's continue", async () => {
    // Another model.
    {
      const f = await forcedSetup();
      try {
        const err = errorOverflow(f.sm, "other");
        const { settle } = await runErrorEnd(f, err.message);
        assert.deepEqual(settle.entries, []);
        assert.equal(fireToolCall(f.pi, f.ctx), undefined);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    // A rate limit is not an overflow.
    {
      const f = await forcedSetup();
      try {
        const message = {
          ...assistantMessage([], "error", 0),
          errorMessage: "rate limit exceeded",
        };
        f.sm.appendMessage(message as never);
        const { settle } = await runErrorEnd(f, message);
        assert.deepEqual(settle.entries, []);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    // pi's compaction on (pi's default): pi owns the overflow.
    {
      const f = await forcedSetup({ piSettings: {} });
      try {
        const err = errorOverflow(f.sm);
        const { settle } = await runErrorEnd(f, err.message);
        assert.deepEqual(settle.entries, []);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    // Recovery is on even when proactive hints are disabled.
    {
      const f = await forcedSetup({ config: {} });
      try {
        const err = errorOverflow(f.sm);
        const { settle } = await runErrorEnd(f, err.message);
        assert.equal(settle.continue, true);
        assert.equal(forcedDrafts(settle)[0].details.status, "done");
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    // Another extension already continues (e.g. a fallback provider).
    {
      const f = await forcedSetup();
      try {
        const err = errorOverflow(f.sm);
        const { settle } = await runErrorEnd(f, err.message, true);
        assert.deepEqual(settle.entries, []);
        assert.equal(settle.continue, true);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  async function providerPayload(
    f: Forced,
    payload: unknown,
  ): Promise<unknown> {
    let current = payload;
    for (const handler of f.pi.onCalls.get("before_provider_request") ?? []) {
      current =
        (await handler(
          { type: "before_provider_request", payload: current } as never,
          f.ctx as never,
        )) ?? current;
    }
    return current;
  }

  it("aborts an infeasible complete request before sending a one-token continuation", async () => {
    const f = await forcedSetup({ issuerTokens: 99_000, anchor: false });
    try {
      const aborter = new AbortController();
      const ctx = {
        ...f.ctx,
        signal: aborter.signal,
        abort: () => aborter.abort(),
      };
      const messages = [
        { role: "system", content: "rules", timestamp: 0 },
        ...fireContext(f.pi, f.ctx),
      ];
      const handlers = f.pi.onCalls.get("context_with_system") ?? [];
      assert.ok(handlers.length > 0);
      for (const handler of handlers) {
        await handler(
          { type: "context_with_system", messages } as never,
          ctx as never,
        );
      }
      assert.equal(aborter.signal.aborted, true);
      const aborted = assistantMessage([], "aborted", 0);
      f.sm.appendMessage(aborted as never);
      const result = await fireTurnEndAll(f.pi, f.ctx, aborted, {
        commit: true,
      });
      assert.equal(result.continue, false);
      const failed = forcedDrafts(result).at(-1);
      assert.equal(failed?.details.reason, "insufficient request headroom");
      assert.ok(Number(failed?.details.inputEstimate) > WINDOW);
      assert.match(failed?.content ?? "", /No tool results were withheld/);
      assert.ok(
        !result.entries.some(
          (entry) =>
            entry.type === "context_edit" && entry.replacement !== null,
        ),
      );
      await fireAgentSettled(f.pi, f.ctx, true);
      assert.equal(
        f.pi.sendMessageCalls.length,
        0,
        "the committed receipt is not duplicated",
      );
      let requests = 0;
      const response = await streamSimple(
        {
          api: "openai-completions",
          provider: "offline",
          id: "budget-fixture",
          name: "Budget fixture",
          baseUrl: "https://offline.invalid/v1",
          reasoning: false,
          input: ["text"],
          contextWindow: WINDOW,
          maxTokens: 64_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        normalizeContext({
          messages: [{ role: "user", content: "test", timestamp: 1 }],
        }),
        {
          apiKey: "offline-test-only",
          signal: aborter.signal,
          maxRetries: 0,
          fetch: async () => {
            requests++;
            throw new Error("transport must not run");
          },
        },
      ).result();
      assert.equal(response.stopReason, "aborted");
      assert.equal(requests, 0);
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => {
          requests++;
          throw new Error("transport must not run");
        };
        await streamGoogle(
          {
            api: "google-generative-ai",
            provider: "google",
            id: "budget-fixture",
            name: "Budget fixture",
            baseUrl: "https://offline.invalid",
            reasoning: false,
            input: ["text"],
            contextWindow: WINDOW,
            maxTokens: 64_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          normalizeContext({
            messages: [{ role: "user", content: "test", timestamp: 1 }],
          }),
          {
            apiKey: "offline-test-only",
            signal: aborter.signal,
            maxRetries: 0,
            onPayload: (payload) => providerPayload(f, payload),
          },
        ).result();
        assert.equal(requests, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  describe("one admission estimate", () => {
    /** Host-heuristic tokens (4 chars each) of filler text. */
    const filler = (tokens: number) => "x".repeat(tokens * 4);
    const userMessage = (text: string) =>
      ({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 0,
      }) as never;

    /** A session at `window` with a pre-baseline body, a measured turn and a short tail. */
    async function admissionSetup(
      window: number,
      baseline: { bodyTokens: number; measured: number; tailTokens: number },
    ) {
      const fixture = makeConfigFixture();
      writeGlobalConfig(
        fixture,
        JSON.stringify({ rewindHintReserveTokens: 20_000 }),
      );
      const f = setup({ contextWindow: window });
      f.ctx.cwd = fixture.projectDir;
      await runSessionStart(f.pi, f.ctx, fixture);
      const turn = appendTurn(
        f.sm,
        filler(baseline.bodyTokens),
        "a1",
        baseline.measured,
      );
      f.pi.pi.setLabel(turn.assistantId, "anchor:start");
      f.sm.appendMessage(userMessage(filler(baseline.tailTokens)));
      return { fixture, ...f, userId: turn.userId };
    }

    /** Fire the request guard on `messages`; the aborter tells whether it refused. */
    async function guard(
      f: { pi: FakePi; ctx: FakeCtx },
      messages: Array<Record<string, unknown>>,
    ) {
      const aborter = new AbortController();
      const ctx = {
        ...f.ctx,
        signal: aborter.signal,
        abort: () => aborter.abort(),
      };
      for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
        await handler(
          { type: "context_with_system", messages } as never,
          ctx as never,
        );
      }
      return aborter.signal.aborted;
    }

    /** What a refused request leaves behind: the failure receipt's estimate. */
    async function refusalEstimate(f: {
      sm: SessionManager;
      pi: FakePi;
      ctx: FakeCtx;
    }) {
      const aborted = assistantMessage([], "aborted", 0);
      f.sm.appendMessage(aborted as never);
      const result = await fireTurnEndAll(f.pi, f.ctx, aborted, {
        commit: true,
      });
      assert.equal(result.continue, false);
      const failed = forcedDrafts(result).at(-1);
      assert.equal(failed?.details.reason, "insufficient request headroom");
      return Number(failed?.details.inputEstimate);
    }

    // The reported session: a 372k window, a valid 307,882-token usage
    // baseline, a ~4.8k-token tail, and a whole-content scan (324.5k host
    // tokens, 371k once scaled to the SDK's heuristic) that out-grows the
    // measured baseline.
    const REPORTED = {
      bodyTokens: 319_700,
      measured: 307_882,
      tailTokens: 4_800,
    };

    it("admits a request whose recorded usage plus its tail fits, though a whole-content scan would not", async () => {
      const f = await admissionSetup(372_000, REPORTED);
      try {
        const messages = [
          { role: "system", content: "rules", timestamp: 0 },
          ...fireContext(f.pi, f.ctx),
        ];
        const scan = estimateRequestTokens(
          messages.map((m) => ({ ...m, usage: undefined })) as never,
        );
        assert.ok(scan + 5_120 > 372_000, "the whole-content scan refuses it");
        assert.equal(await guard(f, messages), false);
        const admission = estimateAdmissionTokens(f.sm);
        assert.ok(admission + 5_120 <= 372_000);
        assert.ok(admission > REPORTED.measured);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    });

    it("still refuses when the baseline is stale: a model switch or a context edit", async () => {
      for (const invalidate of ["model switch", "context edit"]) {
        const f = await admissionSetup(372_000, REPORTED);
        try {
          if (invalidate === "model switch") {
            f.sm.appendModelChange("other", "other-model");
          } else {
            f.sm.appendContextEdit(f.userId, {
              content: [
                { type: "text", text: filler(REPORTED.bodyTokens - 1_000) },
              ],
            } as never);
          }
          const messages = [
            { role: "system", content: "rules", timestamp: 0 },
            ...fireContext(f.pi, f.ctx),
          ];
          assert.equal(await guard(f, messages), true, invalidate);
          assert.ok(
            (await refusalEstimate(f)) + 5_120 > 372_000,
            `${invalidate}: the receipt carries the whole-content estimate`,
          );
        } finally {
          cleanupConfigFixture(f.fixture);
        }
      }
    });

    it("counts the anchor mandate once: not when the system message already carries it", async () => {
      // 94,880 + the 5,120 the guard keeps free is exactly the 100k window.
      const chars = 332_080;
      const withMandate = {
        role: "system",
        content: "x".repeat(chars - ANCHOR_MANDATE.length) + ANCHOR_MANDATE,
        timestamp: 0,
      };
      const without = { ...withMandate, content: "x".repeat(chars) };
      assert.equal(estimateRequestTokens([withMandate] as never), 94_880);
      assert.equal(estimateRequestTokens([without] as never), 94_880);

      const carried = await admissionSetup(100_000, {
        bodyTokens: 1,
        measured: 0,
        tailTokens: 1,
      });
      try {
        assert.equal(await guard(carried, [withMandate]), false);
      } finally {
        cleanupConfigFixture(carried.fixture);
      }
      const bare = await admissionSetup(100_000, {
        bodyTokens: 1,
        measured: 0,
        tailTokens: 1,
      });
      try {
        assert.equal(await guard(bare, [without]), true);
        assert.equal(
          await refusalEstimate(bare),
          94_880 + Math.ceil(ANCHOR_MANDATE.length / 3.5),
        );
      } finally {
        cleanupConfigFixture(bare.fixture);
      }
    });

    it("derives the hint, the anchor list and the request guard from one number", async () => {
      const WINDOW_TOKENS = 100_000;
      const f = await admissionSetup(WINDOW_TOKENS, {
        bodyTokens: 100,
        measured: 95_000,
        tailTokens: 1_000,
      });
      try {
        const mandate = Math.ceil(ANCHOR_MANDATE.length / 3.5);
        const admission = estimateAdmissionTokens(f.sm);
        assert.equal(admission, 95_000 + Math.ceil((1_000 * 8) / 7) + mandate);
        // pi's own estimate disagrees on purpose.
        f.ctx.getContextUsage = () => ({
          tokens: 90_000,
          contextWindow: WINDOW_TOKENS,
          percent: 90,
        });

        const listed = await f.tool.execute(
          "tc-list",
          { action: "list" },
          undefined,
          undefined,
          f.ctx,
        );
        assert.equal(listed.details.contextTokens, admission);
        assert.match(
          listed.content[0].text,
          new RegExp(`ctx ${formatPct1(admission, WINDOW_TOKENS)} of 100k`),
        );

        const anchorCommand = f.pi.commands.get("anchor");
        assert.ok(anchorCommand);
        const command = makeCtx(f.sm, {
          contextWindow: WINDOW_TOKENS,
          hasUI: false,
        });
        await anchorCommand.handler(
          "list",
          command as unknown as ExtensionCommandContext,
        );
        // The anchor sits on the measured turn: its footprint is the usage and the mandate.
        const savable = admission - (95_000 + mandate);
        assert.ok(
          command.notifyCalls[0][0].includes(
            `−${(savable / 1000).toFixed(1)}k savable`,
          ),
          command.notifyCalls[0][0],
        );

        const messages = [
          { role: "system", content: "rules", timestamp: 0 },
          ...fireContext(f.pi, f.ctx),
        ];
        assert.equal(await guard(f, messages), true);

        fireTurnEnd(f.pi, f.ctx);
        const hint = (f.pi.sendMessageCalls[0][0] as { content: string })
          .content;
        assert.equal(
          hint.split("\n")[0],
          buildRewindHintText(
            (admission / WINDOW_TOKENS) * 100,
            WINDOW_TOKENS - admission,
            20_000,
            WINDOW_TOKENS,
            "",
          ).split("\n")[0],
        );

        assert.equal(await refusalEstimate(f), admission);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    });
  });

  it("delivers a failure receipt if a later handler invalidates the boundary", async () => {
    const f = await forcedSetup();
    try {
      const aborter = new AbortController();
      const ctx = {
        ...f.ctx,
        signal: aborter.signal,
        abort: () => aborter.abort(),
      };
      for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
        await handler(
          {
            type: "context_with_system",
            messages: [
              { role: "system", content: "s".repeat(350_000), timestamp: 0 },
            ],
          } as never,
          ctx as never,
        );
      assert.equal(aborter.signal.aborted, true);
      f.pi.onCalls.get("turn_end")?.push((event) => ({
        entries: [
          ...(event as { entries: BoundaryDraft[] }).entries,
          { type: "context_edit", targetId: "off-branch", replacement: null },
        ],
        continue: false,
      }));
      const aborted = assistantMessage([], "aborted", 0);
      f.sm.appendMessage(aborted as never);
      const boundary = await fireTurnEndAll(f.pi, f.ctx, aborted);
      assert.deepEqual(boundary.entries, [], "Pi rejects the whole boundary");
      await fireAgentSettled(f.pi, f.ctx, true);
      assert.equal(f.pi.sendMessageCalls.length, 1);
      const receipt = f.pi.sendMessageCalls[0][0] as { content: string };
      assert.match(receipt.content, /Request stopped before generation/);
      await fireAgentSettled(f.pi, f.ctx, true);
      assert.equal(f.pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("accounts for the final forced prompt rather than the earlier persisted system view", async () => {
    for (const oversized of [true, false]) {
      const f = await forcedSetup();
      try {
        const fake = {
          ...makeFakeSession(f.sm),
          _runSystemPromptOptions: {
            forceSystemPrompt: oversized
              ? "s".repeat(350_000)
              : "short final prompt",
          },
        };
        __testHooks.captureSession(fake as unknown as AgentSession);
        const aborter = new AbortController();
        const ctx = {
          ...f.ctx,
          signal: aborter.signal,
          abort: () => aborter.abort(),
        };
        const messages = [
          {
            role: "system",
            content: oversized ? "old short prompt" : "s".repeat(350_000),
            timestamp: 0,
          },
        ];
        for (const handler of f.pi.onCalls.get("context_with_system") ?? [])
          await handler(
            { type: "context_with_system", messages } as never,
            ctx as never,
          );
        assert.equal(aborter.signal.aborted, oversized);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  it("refuses independent recovery when the final forced system prompt cannot fit", async () => {
    const f = await forcedSetup();
    try {
      f.sm.appendModelChange("other", "other-model");
      __testHooks.captureSession({
        ...makeFakeSession(f.sm),
        _runSystemPromptOptions: { forceSystemPrompt: "s".repeat(350_000) },
      } as unknown as AgentSession);
      const { settle } = await runErrorEnd(f, errorOverflow(f.sm).message);
      assert.equal(settle.continue, false);
      assert.ok(!settle.entries.some((entry) => entry.type === "context_edit"));
      assert.equal(forcedDrafts(settle)[0].details.status, "failed");
      assert.match(forcedDrafts(settle)[0].content, /system prompt alone/);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("keeps a feasible complete request and system declarations intact", async () => {
    const f = await forcedSetup();
    try {
      const aborter = new AbortController();
      const ctx = {
        ...f.ctx,
        signal: aborter.signal,
        abort: () => aborter.abort(),
      };
      const messages = [{ role: "system", content: "rules", timestamp: 0 }];
      for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
        const result = await handler(
          { type: "context_with_system", messages } as never,
          ctx as never,
        );
        assert.equal(result, undefined);
      }
      assert.equal(aborter.signal.aborted, false);
      assert.equal(messages[0].content, "rules");
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  async function autoFixture(
    answer: (
      context: ClassifierContext,
    ) => Promise<{ status: string; boundary?: string }>,
    config: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    const policy = {
      classifier: { model: "test/milestone" },
      confirmer: { model: null },
    };
    const f = await forcedSetup({
      config: {
        auto_navigate: {
          enabled: true,
          milestone: policy,
          check_every_turns: 3,
          min_tokens_since_anchor: 100_000,
          rewind_at_tokens: 80_000,
          ...config,
        },
        ...overrides,
      },
    });
    const summaries = fakeRegistry();
    const questions: ClassifierContext[] = [];
    const classifierModels: string[] = [];
    Object.assign(f.ctx, {
      modelRegistry: {
        ...summaries.registry,
        getAvailableOfType: async (type: string) =>
          type === "classifier"
            ? ["milestone", "base"].map((id) => ({
                provider: "test",
                id,
                api: "decisions",
              }))
            : [],
        classify: async (model: { id: string }, context: ClassifierContext) => {
          classifierModels.push(model.id);
          questions.push(context);
          const result = await answer(context);
          const choices = {
            status: result.status,
            boundary: result.boundary ?? "none",
          };
          return {
            answers: Object.fromEntries(
              Object.entries(choices).map(([id, choice]) => [
                id,
                { type: "choice", choice, confidence: 0.95, probabilities: {} },
              ]),
            ),
            stopReason: "stop",
          };
        },
      },
    });
    return { ...f, summaries, questions, classifierModels };
  }

  async function autoTurn(f: Forced, tokens: number, text = "working") {
    const turn = appendTurn(f.sm, "continue", text, tokens);
    const entry = f.sm.getEntry(turn.assistantId);
    assert.ok(entry?.type === "message");
    return fireTurnEndAll(f.pi, f.ctx, entry.message);
  }

  const newestBoundary = (context: ClassifierContext) => {
    const question = context.questions.boundary;
    assert.ok(question?.type === "choice");
    const records = (context.state as { records: { id: string }[] }).records;
    const id = records.at(-1)?.id;
    assert.ok(id && id in question.criteria);
    return id;
  };

  function assertNoAutoSteer(f: Forced, boundary: BoundaryResult) {
    assert.ok(
      !boundary.entries.some(
        (entry) => entry.customType === "navigate-tree-auto-rewind",
      ),
    );
    assert.equal(f.pi.sendUserMessageCalls.length, 0);
    assert.ok(
      !f.pi.sendMessageCalls.some(
        (args) =>
          (args[0] as { customType?: string }).customType ===
          "navigate-tree-auto-rewind",
      ),
    );
  }

  it("auto_navigate classifies on its cadence below rewind_at_tokens and never folds", async () => {
    const f = await autoFixture(async () => ({ status: "continue" }));
    try {
      await autoTurn(f, 50_000);
      await autoTurn(f, 51_000);
      assert.equal(f.questions.length, 0);
      await autoTurn(f, 52_000);
      assert.equal(f.questions.length, 1);
      await autoTurn(f, 53_000);
      await autoTurn(f, 54_000);
      assert.equal(f.questions.length, 1);
      await autoTurn(f, 55_000);
      assert.equal(f.questions.length, 2);
      assert.equal(f.summaries.calls.length, 0);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate anchors an older accepted boundary without folding or recounting work", async () => {
    let target = "";
    const f = await autoFixture(
      async () => ({ status: "milestone", boundary: target }),
      { min_tokens_since_anchor: 10_000 },
    );
    try {
      target = appendTurn(
        f.sm,
        "earlier",
        "# Earlier milestone",
        20_000,
      ).assistantId;
      const boundary = await autoTurn(f, 50_000);
      assert.equal(f.sm.getLabel(target), "anchor:earlier-milestone");
      assert.equal(f.summaries.calls.length, 0);
      assertNoAutoSteer(f, boundary);
      assert.ok(
        !f.sm.getEntries().some((entry) => entry.type === "branch_summary"),
      );
      await autoTurn(f, 51_000);
      assert.equal(f.questions.length, 1);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate folds at rewind_at_tokens through the engine without asking a classifier", async () => {
    const f = await autoFixture(async () => {
      throw new Error("a classifier must not decide a pressure fold");
    });
    try {
      const boundary = await autoTurn(f, 90_000);
      assert.equal(boundary.continue, true);
      const [done] = forcedDrafts(boundary);
      assert.equal(done?.details.status, "done", JSON.stringify(boundary));
      assert.equal(done.details.origin, "auto");
      assert.equal(done.details.rewindTo, "start");
      assert.equal(f.questions.length, 0);
      assert.ok(f.summaries.calls.length > 0);
      assert.ok(
        f.sm.getBranch().some((entry) => entry.type === "branch_summary"),
      );
      assertNoAutoSteer(f, boundary);
      const calls = f.summaries.calls.length;
      await autoTurn(f, 85_000);
      assert.equal(
        f.summaries.calls.length,
        calls,
        "another pressure fold needs min_tokens_since_anchor fresh tokens",
      );
      assert.equal(f.questions.length, 0);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate persists a visible warning when a pressure fold has no valid target", async () => {
    const f = await autoFixture(async () => ({ status: "continue" }));
    try {
      const base = f.sm
        .getBranch()
        .find((entry) => f.sm.getLabel(entry.id) === "anchor:start");
      assert.ok(base);
      f.pi.pi.setLabel(base.id, undefined);
      const boundary = await autoTurn(f, 90_000);
      const warnings = boundary.entries.filter(
        (entry) => entry.customType === "navigate-tree-auto-warning",
      );
      assert.equal(warnings.length, 1, JSON.stringify(boundary));
      assert.match(
        String(warnings[0].content),
        /crossed rewind_at_tokens .* but no fold ran/,
      );
      assert.ok(
        f.ctx.notifyCalls.some(
          ([text, level]) =>
            level === "warning" && text.includes("no fold ran"),
        ),
      );
      assert.equal(boundary.continue, false);
      assert.equal(f.questions.length, 0);
      assert.equal(f.summaries.calls.length, 0);
      assert.ok(
        !f.sm.getEntries().some((entry) => entry.type === "branch_summary"),
      );
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate keeps an unanswered request verbatim through a pressure fold", async () => {
    const f = await autoFixture(async () => ({ status: "continue" }));
    try {
      const done = appendTurn(f.sm, "completed task", "# Done", 90_000);
      const entry = f.sm.getEntry(done.assistantId);
      assert.ok(entry?.type === "message");
      const request = "A new unanswered request: also update the changelog.";
      f.sm.appendMessage({ role: "user", content: request, timestamp: 1 });
      const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);
      const [result] = forcedDrafts(boundary);
      assert.equal(result?.details.status, "done", JSON.stringify(boundary));
      const branch = f.sm.getBranch();
      const summaryAt = branch.findIndex(
        (value) => value.type === "branch_summary",
      );
      assert.ok(summaryAt >= 0);
      assert.ok(
        branch
          .slice(summaryAt)
          .some(
            (value) =>
              value.type === "message" &&
              value.message.role === "user" &&
              value.message.content === request,
          ),
        "the open request stays a user message after the handoff",
      );
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate never partially folds an unsafe pending tool envelope", async () => {
    const f = await autoFixture(async () => ({ status: "continue" }));
    try {
      const pending = appendToolCallAssistant(
        f.sm,
        [{ id: "pending", name: "read", arguments: { path: "unfinished" } }],
        90_000,
      );
      const boundary = await fireTurnEndAll(f.pi, f.ctx, pending.message);
      assert.equal(f.summaries.calls.length, 0);
      assert.ok(
        !f.sm.getEntries().some((entry) => entry.type === "branch_summary"),
      );
      assert.ok(f.sm.getBranch().some((entry) => entry.id === pending.id));
      const [warning] = boundary.entries.filter(
        (entry) => entry.customType === "navigate-tree-auto-warning",
      );
      assert.match(
        String(warning?.content),
        /no fold ran: .*tool call without its result/,
      );
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate rejects pre-compaction targets and folds to a feasible fresh anchor", async () => {
    const f = await autoFixture(async () => ({ status: "continue" }), {
      min_tokens_since_anchor: 10_000,
    });
    try {
      const old = appendTurn(f.sm, "old", "old answer", 90_000);
      f.sm.appendCompaction("Compacted summary", old.userId, 90_000);
      const refused = await autoTurn(f, 92_000);
      assert.equal(f.summaries.calls.length, 0);
      assert.ok(
        refused.entries.some(
          (entry) => entry.customType === "navigate-tree-auto-warning",
        ),
        JSON.stringify(refused),
      );
      assert.ok(
        !f.sm.getEntries().some((entry) => entry.type === "branch_summary"),
      );
      assertNoAutoSteer(f, refused);
      const fresh = appendTurn(f.sm, "new work", "ready", 20_000);
      f.pi.pi.setLabel(fresh.assistantId, "anchor:fresh");
      const workTurn = async (tokens: number) => {
        const turn = appendTurn(f.sm, "new work", "working", tokens, true);
        const entry = f.sm.getEntry(turn.assistantId);
        assert.ok(entry?.type === "message");
        return fireTurnEndAll(f.pi, f.ctx, entry.message);
      };
      await workTurn(40_000);
      const boundary = await workTurn(93_000);
      const [done] = forcedDrafts(boundary);
      assert.equal(done?.details.status, "done", JSON.stringify(boundary));
      assert.equal(done.details.rewindTo, "fresh");
      assert.ok(f.summaries.calls.length > 0);
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate discards stale input and does not consume its cadence", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await autoFixture(
      async (context) => {
        started();
        await reply;
        return { status: "milestone", boundary: newestBoundary(context) };
      },
      { check_every_turns: 1 },
    );
    try {
      const pending = autoTurn(f, 50_000);
      await ready;
      const oldLeaf = f.sm.getLeafId();
      f.sm.appendMessage({
        role: "user",
        content: "Stop; requirements changed.",
        timestamp: 1,
      });
      release();
      await pending;
      assert.equal(f.sm.getLabel(oldLeaf as string), undefined);
      assert.equal(f.summaries.calls.length, 0);
      await autoTurn(f, 51_000);
      assert.equal(
        f.questions.length,
        2,
        "the stale crossing was never installed",
      );
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate resolves wildcard policy overrides and applies disclosure before classification", async () => {
    const f = await autoFixture(
      async (context) => ({
        status: "milestone",
        boundary: newestBoundary(context),
      }),
      {
        enabled: false,
        milestone: { classifier: { model: "test/base" } },
        tools: { read: "omit" },
      },
      {
        model_overrides: {
          "*sonnet*": {
            auto_navigate: {
              enabled: true,
              milestone: {
                classifier: { model: "test/milestone" },
                confirmer: { model: null },
              },
              check_every_turns: 1,
              mode: "anchor-only",
            },
          },
        },
      },
    );
    try {
      const boundary = await autoTurn(f, 90_000, "# Verified milestone");
      assert.ok(f.questions.length > 0);
      assert.deepEqual(f.classifierModels, ["milestone"]);
      const text = JSON.stringify(f.questions[0]);
      assert.ok(
        !text.includes(BIG),
        "omitted read results never reach the policy",
      );
      assert.match(text, /omit|withheld/);
      assert.equal(f.summaries.calls.length, 0);
      assert.ok(
        f.sm
          .getBranch()
          .some(
            (entry) => f.sm.getLabel(entry.id) === "anchor:verified-milestone",
          ),
      );
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate refuses changed model, window, signal, labels, config and competing folds", async () => {
    for (const change of [
      "model",
      "window",
      "signal",
      "label",
      "config",
      "queued",
    ] as const) {
      let mutate: () => Promise<void> = async () => {};
      const f = await autoFixture(
        async (context) => {
          const boundary = newestBoundary(context);
          await mutate();
          return { status: "milestone", boundary };
        },
        { check_every_turns: 1 },
      );
      try {
        mutate = async () => {
          if (change === "model" && f.ctx.model) f.ctx.model.id = "changed";
          if (change === "window" && f.ctx.model)
            f.ctx.model.contextWindow = 200_000;
          if (change === "signal") f.ctx.signal = new AbortController().signal;
          if (change === "label")
            f.pi.pi.setLabel(f.sm.getLeafId() as string, "user bookmark");
          if (change === "config") {
            writeGlobalConfig(
              f.fixture,
              JSON.stringify({ auto_navigate: false }),
            );
            await runSessionStart(f.pi, f.ctx, f.fixture);
          }
          if (change === "queued") {
            const api = __testHooks.foldApi(f.pi.pi);
            assert.ok(api);
            assert.ok(
              api.queueFold(f.sm.getSessionId(), {
                origin: "manual",
                rewindTo: "start",
                newLabel: "manual-fold",
                focus:
                  "Preserve completed work and continue the remaining requested task.",
              }).ok,
            );
          }
        };
        const boundary = await autoTurn(f, 50_000);
        assert.equal(f.questions.length, 1, change);
        assert.equal(f.summaries.calls.length, 0, change);
        assert.ok(
          !f.sm
            .getBranch()
            .some((entry) =>
              /^anchor:(?!start$)/.test(f.sm.getLabel(entry.id) ?? ""),
            ),
          `${change}: a stale decision must not place an anchor`,
        );
        assert.ok(
          !f.sm.getEntries().some((entry) => entry.type === "branch_summary"),
          change,
        );
        assert.equal(forcedDrafts(boundary).length, 0, change);
        assertNoAutoSteer(f, boundary);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  it("auto_navigate preserves an unanswered suffix and anchors only the accepted milestone", async () => {
    let target = "";
    const f = await autoFixture(
      async () => ({
        status: "milestone",
        boundary: target,
      }),
      { check_every_turns: 1 },
    );
    try {
      target = appendTurn(f.sm, "completed task", "# Done", 50_000).assistantId;
      const entry = f.sm.getEntry(target);
      assert.ok(entry?.type === "message");
      const userId = f.sm.appendMessage({
        role: "user",
        content: "A new unanswered request.",
        timestamp: 1,
      });
      const boundary = await fireTurnEndAll(f.pi, f.ctx, entry.message);
      assert.equal(f.summaries.calls.length, 0);
      assert.equal(f.sm.getLabel(target), "anchor:done");
      assert.ok(f.sm.getBranch().some((value) => value.id === userId));
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate reports summary and commit failures without continuing", async () => {
    for (const stage of ["summary", "commit"] as const) {
      const f = await autoFixture(async (context) => ({
        status: "milestone",
        boundary: newestBoundary(context),
      }));
      const internals = f.sm as unknown as {
        _persist(entry: SessionEntry): void;
      };
      const persist = internals._persist.bind(f.sm);
      try {
        if (stage === "summary") {
          const failed = fakeRegistry(() => ({
            ...reply(""),
            stopReason: "error",
            errorMessage: "injected provider failure",
          }));
          Object.assign(f.ctx.modelRegistry, {
            streamSimple: failed.registry.streamSimple,
          });
        } else {
          internals._persist = (entry) => {
            if (entry.type === "branch_summary")
              throw new Error("injected write failure");
            persist(entry);
          };
        }
        const boundary = await autoTurn(f, 90_000);
        const [failed] = forcedDrafts(boundary);
        assert.equal(
          failed?.details.status,
          "failed",
          JSON.stringify(boundary),
        );
        assert.equal(failed.details.stage, stage);
        assert.equal(failed.details.origin, "auto");
        assert.equal(boundary.continue, false);
        assert.ok(
          !f.sm.getBranch().some((entry) => entry.type === "branch_summary"),
        );
        assertNoAutoSteer(f, boundary);
      } finally {
        internals._persist = persist;
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  it("auto_navigate refuses stale context getters before evaluating", async () => {
    const f = await autoFixture(async () => ({ status: "milestone" }));
    try {
      Object.defineProperty(f.ctx, "hasUI", {
        get() {
          throw new Error("stale context");
        },
      });
      await autoTurn(f, 90_000);
      assert.equal(f.questions.length, 0);
      assert.equal(f.summaries.calls.length, 0);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate stops without a receipt append when a failed commit quarantines the cursor", async () => {
    const f = await autoFixture(async (context) => ({
      status: "milestone",
      boundary: newestBoundary(context),
    }));
    const internals = f.sm as unknown as {
      _persist(entry: SessionEntry): void;
    };
    const persist = internals._persist.bind(f.sm);
    const branch = f.sm.branch.bind(f.sm);
    let failed = false;
    try {
      internals._persist = (entry) => {
        if (entry.type === "branch_summary") {
          failed = true;
          throw new Error("injected write failure");
        }
        persist(entry);
      };
      f.sm.branch = (id) => {
        if (failed) throw new Error("injected cursor restoration failure");
        return branch(id);
      };
      const boundary = await autoTurn(f, 90_000);
      assert.equal(failed, true);
      assert.equal(boundary.continue, false);
      assert.deepEqual(boundary.entries, []);
      assert.ok(
        f.ctx.notifyCalls.some(([text]) =>
          text.includes("failed at the commit stage"),
        ),
      );
      const checks = f.questions.length;
      await fireTurnEndAll(
        f.pi,
        f.ctx,
        assistantMessage([{ type: "text", text: "unchanged" }], "stop", 90_000),
      );
      assert.equal(f.questions.length, checks);
      assertNoAutoSteer(f, boundary);
    } finally {
      internals._persist = persist;
      f.sm.branch = branch;
      cleanupConfigFixture(f.fixture);
    }
  });

  it("auto_navigate persists bounded operational warnings without claiming completion", async () => {
    const f = await autoFixture(
      async () => {
        throw new Error("offline failure");
      },
      { check_every_turns: 1 },
    );
    try {
      const boundary = await autoTurn(f, 50_000);
      const warnings = boundary.entries.filter(
        (entry) => entry.customType === "navigate-tree-auto-warning",
      );
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0].content), /offline failure/);
      assert.ok(
        f.ctx.notifyCalls.some(
          ([text, level]) =>
            level === "warning" && text.includes("offline failure"),
        ),
      );
      assert.ok(
        f.sm
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "navigate-tree-auto-warning",
          ),
      );
      assert.ok(String(warnings[0].content).length <= 1502);
      assert.equal(boundary.continue, false);
      assert.equal(forcedDrafts(boundary).length, 0);
      assert.equal(f.summaries.calls.length, 0);
      assertNoAutoSteer(f, boundary);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  describe("anchors before a compaction", () => {
    const WINDOW = 100_000;

    /**
     * Five pre-compaction turns (the compaction keeps only the fifth), then two
     * more. Zero recorded usage by default, so the request-time estimate and the
     * fold gate price the same characters.
     */
    function compactedSession(usageOf = (_turn: number) => 0) {
      const f = setup({ contextWindow: WINDOW });
      const early = appendTurn(f.sm, "u1", "a1", usageOf(1));
      f.pi.pi.setLabel(early.assistantId, "anchor:early");
      for (const n of [2, 3, 4])
        appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
      const cut = appendTurn(f.sm, "u5", "a5", usageOf(5), true);
      f.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
      f.sm.appendCompaction("Compacted summary", cut.userId, 0);
      const late = appendTurn(f.sm, "u6", "a6", usageOf(6), true);
      f.pi.pi.setLabel(late.assistantId, "anchor:after-cut");
      appendTurn(f.sm, "u7", "a7", usageOf(7), true);
      return {
        ...f,
        ids: {
          early: early.assistantId,
          cut: cut.assistantId,
          late: late.assistantId,
        },
      };
    }

    /** What a fold at `entryId` leaves before any handoff: Pi's own context at that leaf. */
    const footprintAt = (sm: SessionManager, entryId: string) =>
      estimateContentTokens(
        buildSessionContext(sm.getEntries(), entryId).messages,
      );

    /** The same footprint as the request guard prices it: SDK-scaled, plus the mandate the prompt appends. */
    const admissionAt = (sm: SessionManager, entryId: string) =>
      estimateRequestTokens(
        buildSessionContext(sm.getEntries(), entryId).messages,
      ) + Math.ceil(ANCHOR_MANDATE.length / 3.5);

    const parentOf = (sm: SessionManager, entryId: string) => {
      const parentId = sm.getEntry(entryId)?.parentId;
      assert.ok(parentId);
      return parentId;
    };

    const foldArgs = (rewindTo: string) => ({
      ...REWIND_ARGS,
      rewindTo,
      newLabel: "folded",
    });

    it("lists a pre-compaction anchor at its un-compacted footprint, not the compaction baseline", async () => {
      const { sm, tool, ctx, ids } = compactedSession();
      const res = await tool.execute(
        "tc-list",
        { action: "list" },
        undefined,
        undefined,
        ctx,
      );
      const text = res.content[0].text;
      for (const [name, id] of [
        ["early", ids.early],
        ["before-cut", ids.cut],
        ["after-cut", ids.late],
      ]) {
        const pct = formatPct1(admissionAt(sm, id), WINDOW).replace(".", "\\.");
        assert.match(text, new RegExp(`${pct}\\s+${name}\\b`), text);
      }
      assert.ok(
        footprintAt(sm, ids.cut) >
          estimateContentTokens(sm.buildSessionContext().messages),
        "the fixture's pre-compaction anchor costs more than the compacted context",
      );
    });

    it("flags in /anchor list only the pre-compaction anchors a fold cannot free", async () => {
      const f = compactedSession();
      const ctx = makeCtx(f.sm, { contextWindow: WINDOW, hasUI: false });
      const command = f.pi.commands.get("anchor");
      assert.ok(command);
      await command.handler("list", ctx as unknown as ExtensionCommandContext);
      const lines = ctx.notifyCalls[0][0].split("\n");
      const row = (name: string) =>
        lines.find((line) => line.includes(` ${name} `)) ?? "";
      assert.match(row("before-cut"), /−0 savable {2}\(before compaction\)$/);
      assert.match(row("early"), /savable$/);
      assert.match(row("after-cut"), /savable$/);
    });

    it("refuses a fold to a pre-compaction anchor at request time, before any fold is queued", async () => {
      const f = compactedSession();
      const { result, callId } = await requestRewind(
        f,
        foldArgs("before-cut"),
        "tc-cut",
        0,
      );
      assert.equal(result.isError, true);
      assert.equal(result.details.rejected, "min-savings");
      assert.match(result.content[0].text, /lies before the latest compaction/);
      assert.equal(
        result.details.apparentSavings,
        admissionAt(f.sm, parentOf(f.sm, callId)) -
          admissionAt(f.sm, f.ids.cut),
      );
      assert.ok(Number(result.details.apparentSavings) < 0);
      assert.deepEqual(
        f.pi.boundaryResults.flatMap((r) => r.entries),
        [],
        "no fold ran",
      );
      assert.equal(f.ctx.registryCalls.length, 0);
    });

    for (const [anchor, key] of [
      ["after-cut", "late"],
      ["early", "early"],
    ] as const) {
      it(`prices '${anchor}' by the footprint its fold leaves, so the gate agrees`, async () => {
        const f = compactedSession();
        const { result, callId, leafBeforeFold } = await requestRewind(
          f,
          foldArgs(anchor),
          "tc-fold",
          0,
        );
        assert.equal(result.isError, undefined);
        const priced = footprintAt(f.sm, f.ids[key]);
        // The fold point is the rewind call's tool result, which the fold collapses too.
        const before = footprintAt(f.sm, leafBeforeFold);
        assert.equal(
          result.details.tokensAtTarget,
          admissionAt(f.sm, f.ids[key]),
        );
        assert.equal(
          result.details.contextBefore,
          admissionAt(f.sm, parentOf(f.sm, callId)),
        );

        const done = rewindMessages(f.pi).at(-1)?.message;
        assert.equal(done?.details.status, "done");
        assert.equal(done?.details.foldEstimateBefore, before);
        assert.ok(Number(done?.details.foldEstimateAfter) > priced);
        const messages = f.sm.buildSessionContext().messages;
        const handoffAt = messages.findIndex(
          (m) =>
            m.role === "custom" && m.customType === "navigate-tree-handoff",
        );
        assert.ok(handoffAt > 0);
        assert.equal(
          estimateContentTokens(messages.slice(0, handoffAt)),
          priced,
        );
      });
    }

    it("names the compaction when the gate refuses a pre-compaction target that recorded usage under-priced", async () => {
      const f = compactedSession((turn) =>
        turn <= 5 ? 6_000 : turn === 6 ? 20_000 : 30_000,
      );
      const { result, boundary } = await requestRewind(
        f,
        foldArgs("before-cut"),
        "tc-cut",
        0,
      );
      assert.equal(result.isError, undefined, "usage prices the target low");
      assert.equal(
        f.sm.getEntries().filter((entry) => entry.type === "branch_summary")
          .length,
        0,
      );
      assert.equal(boundary.entries[0].details.status, "failed");
      assert.equal(boundary.entries[0].details.stage, "commit");
      assert.match(
        String(boundary.entries[0].details.detail),
        /'before-cut' lies before the latest compaction.*\(estimated \d+ -> \d+ tokens\); original history was kept/,
      );
    });
  });

  it("D9: compaction on → TUI error once per crossing, no hint; headless silent; re-read per crossing", async () => {
    const f = await forcedSetup({
      piSettings: { compaction: { enabled: true } },
    });
    try {
      f.ctx.setContextUsage(usageAt(90, WINDOW));
      fireTurnEnd(f.pi, f.ctx);
      fireTurnEnd(f.pi, f.ctx);
      assert.deepEqual(f.ctx.notifyCalls, [
        [REWIND_COMPACTION_OFF_TEXT, "error"],
      ]);
      assert.equal(f.pi.sendMessageCalls.length, 0);
      // Settings change between crossings: the next crossing hints.
      writePiSettings(f.fixture, { compaction: { enabled: false } });
      f.ctx.setContextUsage(usageAt(10, WINDOW));
      fireTurnEnd(f.pi, f.ctx);
      f.ctx.setContextUsage(usageAt(90, WINDOW));
      fireTurnEnd(f.pi, f.ctx);
      assert.equal(f.pi.sendMessageCalls.length, 1);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
    const g = await forcedSetup({ piSettings: {} });
    try {
      g.ctx.hasUI = false;
      g.ctx.setContextUsage(usageAt(90, WINDOW));
      fireTurnEnd(g.pi, g.ctx);
      assert.deepEqual(g.ctx.notifyCalls, []);
      assert.equal(g.pi.sendMessageCalls.length, 0);
    } finally {
      cleanupConfigFixture(g.fixture);
    }
  });

  it("D9: project settings count only when the project is trusted", async () => {
    for (const trusted of [false, true]) {
      const fixture = makeConfigFixture();
      try {
        writeGlobalConfig(
          fixture,
          JSON.stringify({ rewindHintReserveTokens: 20_000 }),
        );
        writeProjectPiSettings(fixture, { compaction: { enabled: true } });
        const f = setup({ contextWindow: WINDOW });
        f.ctx.cwd = fixture.projectDir;
        f.ctx.isProjectTrusted = () => trusted;
        await runSessionStart(f.pi, f.ctx, fixture);
        anchorStart(f.sm, f.pi);
        f.ctx.setContextUsage(usageAt(90, WINDOW));
        fireTurnEnd(f.pi, f.ctx);
        assert.equal(f.pi.sendMessageCalls.length, trusted ? 0 : 1);
        assert.equal(f.ctx.notifyCalls.length, trusted ? 1 : 0);
      } finally {
        cleanupConfigFixture(fixture);
      }
    }
  });

  it("D9 (S3): the live session's compaction setting decides, not the disk (#101)", async () => {
    for (const live of [true, false]) {
      // The disk says the opposite of the session's in-memory settings.
      const f = await forcedSetup({
        piSettings: { compaction: { enabled: !live } },
      });
      try {
        const session = {
          sessionManager: f.sm,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: live },
          }),
        };
        __testHooks.captureSession(session as unknown as AgentSession);
        f.ctx.setContextUsage(usageAt(90, WINDOW));
        fireTurnEnd(f.pi, f.ctx);
        assert.equal(
          f.pi.sendMessageCalls.length,
          live ? 0 : 1,
          `live=${live}`,
        );
        assert.equal(f.ctx.notifyCalls.length, live ? 1 : 0, `live=${live}`);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  it("warns for the concrete active model rather than treating wildcard patterns as models", async () => {
    const f = await forcedSetup({
      config: {
        model_overrides: { "claude/*": { rewind_hint_reserve_tokens: 10_000 } },
      },
    });
    try {
      assert.deepEqual(f.ctx.notifyCalls, [
        [
          buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"),
          "warning",
        ],
      ]);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("D10: warns per model when the hint reserve is below pi's, only with compaction off", async () => {
    const f = await forcedSetup({
      config: {
        rewindHintReserveTokens: 10_000,
        modelOverrides: { "openai/gpt-x": { rewindHintReserveTokens: 50_000 } },
      },
      piSettings: {
        compaction: {
          enabled: false,
          modelOverrides: { "openai/gpt-x": { reserveTokens: 60_000 } },
        },
      },
    });
    try {
      assert.deepEqual(f.ctx.notifyCalls, [
        [
          buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"),
          "warning",
        ],
        [buildReserveOrderWarning(50_000, 60_000, "openai/gpt-x"), "warning"],
      ]);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
    const g = await forcedSetup({
      config: { rewindHintReserveTokens: 10_000 },
      piSettings: {},
    });
    try {
      assert.deepEqual(g.ctx.notifyCalls, [], "compaction on: D9's case");
    } finally {
      cleanupConfigFixture(g.fixture);
    }
  });

  it("D10: warns when the hint reserve does not exceed what the request guard keeps free", async () => {
    // The guard keeps 1,024 output + 4,096 headroom tokens free.
    for (const [reserve, guarded] of [
      [4_000, true],
      [5_120, true],
      [5_121, false],
    ] as const) {
      const f = await forcedSetup({
        config: { rewindHintReserveTokens: reserve },
      });
      try {
        assert.deepEqual(f.ctx.notifyCalls, [
          [
            buildReserveOrderWarning(
              reserve,
              16_384,
              "claude/claude-sonnet-4-5",
            ),
            "warning",
          ],
          ...(guarded
            ? [
                [
                  buildReserveGuardWarning(
                    reserve,
                    5_120,
                    "claude/claude-sonnet-4-5",
                  ),
                  "warning",
                ] as const,
              ]
            : []),
        ]);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    const g = await forcedSetup({
      config: { rewindHintReserveTokens: 4_000 },
      piSettings: {},
    });
    try {
      assert.deepEqual(g.ctx.notifyCalls, [], "compaction on: D9's case");
    } finally {
      cleanupConfigFixture(g.fixture);
    }
  });

  it("D10 (fix 9): one model's invalid pi reserve does not skip the others", async () => {
    const f = await forcedSetup({
      config: {
        rewindHintReserveTokens: 10_000,
        modelOverrides: {
          "openai/bad": { rewindHintReserveTokens: 50_000 },
          "openai/gpt-x": { rewindHintReserveTokens: 50_000 },
        },
      },
      piSettings: {
        compaction: {
          enabled: false,
          modelOverrides: {
            "openai/bad": { reserveTokens: "x" },
            "openai/gpt-x": { reserveTokens: 60_000 },
          },
        },
      },
    });
    try {
      assert.deepEqual(f.ctx.notifyCalls, [
        [
          buildReserveOrderWarning(10_000, 16_384, "claude/claude-sonnet-4-5"),
          "warning",
        ],
        [buildReserveOrderWarning(50_000, 60_000, "openai/gpt-x"), "warning"],
      ]);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("renders D8 as one error-styled row; the forced message keeps pi's default box", async () => {
    const f = await forcedSetup();
    try {
      const renderer = f.pi.messageRenderers.get(REWIND_CUSTOM_TYPE) as (
        ...a: unknown[]
      ) => { render(w: number): string[] } | undefined;
      assert.ok(renderer);
      const text = "the forced rewind was aborted";
      const row = renderer(
        {
          role: "custom",
          customType: REWIND_CUSTOM_TYPE,
          content: text,
          display: true,
          details: { status: "failed" },
        },
        { expanded: false, outputPad: 1 },
        theme,
      );
      assert.deepEqual(row?.render(1000), [` <error>${text}`]);
      assert.equal(
        renderer(
          {
            role: "custom",
            customType: REWIND_CUSTOM_TYPE,
            content: "x",
            display: true,
            details: { status: "forced" },
          },
          { expanded: false, outputPad: 1 },
          theme,
        ),
        undefined,
      );
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });
});

// =============================================================================
// Session continuity ledger on the live fold
// =============================================================================

describe("rewind: continuity ledger", () => {
  const userMessage = (text: string) =>
    ({ role: "user", content: [{ type: "text", text }] }) as never;

  /**
   * u1 (rule R1 on the kept chain) → a1 [anchor:start] → span with a steering
   * item (T2, scoped to `start`) and another rule (R3) that exist only on the
   * branch about to be abandoned.
   */
  function ledgerSetup() {
    const f = setup();
    const u1 = f.sm.appendMessage(userMessage("u1 never edit the lockfile"));
    appendOpsEntry(f.pi.pi, [
      {
        op: {
          op: "add",
          kind: "rule",
          text: "Never edit the lockfile",
          quote: "never edit the lockfile",
        },
        ctx: { origin: "user", entryId: u1 },
      },
    ]);
    const a1 = f.sm.appendMessage(
      assistantMessage([{ type: "text", text: "a1" }], "stop", 6_000) as never,
    );
    f.pi.pi.setLabel(a1, "anchor:start");
    const t2 = appendTurn(
      f.sm,
      "u2 look at the parser first",
      "a2",
      12_000,
      true,
    );
    appendOpsEntry(f.pi.pi, [
      {
        op: {
          op: "add",
          kind: "steering",
          text: "Look at the parser first",
          scopeAnchor: "start",
        },
        ctx: { origin: "user", entryId: t2.userId },
      },
    ]);
    const t3 = appendTurn(f.sm, "u3 always run the linter", "a3", 24_000, true);
    appendOpsEntry(f.pi.pi, [
      {
        op: { op: "add", kind: "rule", text: "Always run the linter" },
        ctx: { origin: "user", entryId: t3.userId },
      },
    ]);
    const leafBeforeFold = f.sm.getLeafId() as string;
    const before = readBranchLedger(f.sm.getBranch());
    return { ...f, u1, a1, t2, t3, leafBeforeFold, before };
  }

  /** The rewind call, folded with `summary` as the side calls' answer; `calls` are the side calls. */
  async function foldWith(
    f: ReturnType<typeof ledgerSetup>,
    summary: string,
    args: Record<string, unknown> = REWIND_ARGS,
    toolCallId = "tc-rewind",
    totalTokens?: number,
  ) {
    const registry = fakeRegistry(() => reply(summary));
    f.ctx.modelRegistry = registry.registry;
    const rewound = await requestRewind(f, args, toolCallId, totalTokens);
    return { ...rewound, calls: registry.calls };
  }

  async function ledgerFixture(opts: { summary?: string } = {}) {
    const f = ledgerSetup();
    const rewound = await foldWith(f, opts.summary ?? SUMMARY_TEXT);
    return { ...f, rewound };
  }

  /** The text of the request a side call carried. */
  const requestText = (call: RegistryCall) => {
    const last = call.context.messages.at(-1);
    assert.equal(last?.role, "user");
    const { content } = last as { content: unknown };
    return typeof content === "string"
      ? content
      : (content as Array<{ text: string }>).map((b) => b.text).join("\n");
  };

  const foldedEntry = (sm: SessionManager, pi: FakePi) => {
    const done = rewindMessages(pi).at(-1);
    assert.ok(done, "a continuation was delivered");
    const entry = sm.getEntry(done.message.details.summaryId as string);
    assert.ok(entry && entry.type === "branch_summary");
    return { done: done.message, entry };
  };

  const deltaBlock = (body: unknown) =>
    `\n\n<continuity-delta>\n${JSON.stringify(body)}\n</continuity-delta>`;

  it("sends the ledger and the span's user messages with the summary request", async () => {
    const f = await ledgerFixture();
    const text = requestText(f.rewound.calls.at(-1) as RegistryCall);
    const at = text.indexOf("\n\nContinuity ledger rev 3.");
    assert.ok(at > 0, "the final request carries the continuity section");
    assert.ok(
      text
        .slice(0, at)
        .endsWith(`Additional focus: ${REWIND_ARGS.summaryFocus}`),
    );
    const section = text.slice(at);
    assert.match(section, /R1 Never edit the lockfile/);
    assert.match(section, /R3 Always run the linter/);
    assert.match(
      section,
      /Steering scoped to start \(archived by this fold\):\nT2 /,
    );
    assert.ok(
      section.includes(`- ${f.t2.userId}: u2 look at the parser first`),
    );
    assert.ok(section.includes(`- ${f.t3.userId}: u3 always run the linter`));
    assert.ok(!section.includes(f.u1), "u1 is before the anchor");
  });

  it("stores the reconciled snapshot and the briefing; the rule stays active, the steering is archived", async () => {
    const f = await ledgerFixture({ summary: SUMMARY_TEXT });
    const { done, entry } = foldedEntry(f.sm, f.pi);
    const snapshot = parseLedger(
      (entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
    );
    const status = (id: string) =>
      snapshot.items.find((item) => item.id === id)?.status;
    assert.equal(status("R1"), "active");
    assert.equal(status("R3"), "active");
    assert.equal(status("T2"), "archived");
    // Carried by the snapshot, not by the abandoned span's ops entries.
    assert.equal(
      f.sm.getBranch().some((e) => e.id === f.t3.userId),
      false,
    );
    assert.deepEqual(readBranchLedger(f.sm.getBranch()), {
      ledger: snapshot,
      warnings: [],
    });
    const briefing = renderBriefing(snapshot, { maxTokens: 2500 }).text;
    assert.equal(
      entry.summary,
      `# Work handoff: end\n\n${SUMMARY_TEXT}\n\n## Continuity ledger\n\n${briefing}`,
    );
    assert.ok(entry.summary.includes("R1 Never edit the lockfile"));
    assert.ok(!entry.summary.includes("Look at the parser first"));
    assert.deepEqual(done.details.continuity, {
      rev: snapshot.rev,
      applied: 1,
      rejected: [],
      evicted: [],
    });
    assert.equal(
      done.content,
      `${buildRewindDoneText(
        {
          rewindTo: "start",
          newLabel: "end",
          beforeTokens: done.details.contextBefore as number,
          contextWindow: 1_000_000,
        },
        done.details.contextAfter as number,
      )}\n\n${__testHooks.REFLECTION_BOOTSTRAP_WARNING_REWIND}`,
      "nothing to report: the continuation copy is unchanged",
    );
    assert.equal(
      f.sm.buildSessionContext().messages.some((m) => {
        const text = JSON.stringify(m);
        return text.includes("Never edit the lockfile");
      }),
      true,
      "the briefing reaches the model through the handoff",
    );
  });

  it("a summary that ends with a Standing authorization section and a delta block folds: the delta applies, the section is kept", async () => {
    const authorization =
      '## Standing authorization\n"work autonomously until done" — scope not complete.';
    const f = await ledgerFixture({
      summary:
        `${SUMMARY_TEXT}\n\n${authorization}` +
        deltaBlock({ ratified: [{ kind: "decision", text: "Use sqlite" }] }),
    });
    const { done, entry } = foldedEntry(f.sm, f.pi);
    assert.equal(done.details.status, "done");
    const snapshot = parseLedger(
      (entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
    );
    assert.equal(
      snapshot.items.find((i) => i.text === "Use sqlite")?.status,
      "active",
    );
    assert.ok(!entry.summary.includes("continuity-delta"));
    assert.ok(
      entry.summary.includes(
        `${SUMMARY_TEXT}\n\n${authorization}\n\n## Continuity ledger`,
      ),
      "the section sits between the summary and the briefing",
    );
  });

  it("rejects a delta that archives a user rule per item, applies the valid ones and says so", async () => {
    const f = await ledgerFixture({
      summary:
        SUMMARY_TEXT +
        deltaBlock({
          expiredSteering: ["R1"],
          ratified: [{ kind: "decision", text: "Use sqlite" }],
        }),
    });
    const { done, entry } = foldedEntry(f.sm, f.pi);
    const snapshot = parseLedger(
      (entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
    );
    assert.equal(snapshot.items.find((i) => i.id === "R1")?.status, "active");
    assert.equal(
      snapshot.items.find((i) => i.text === "Use sqlite")?.status,
      "active",
    );
    assert.ok(!entry.summary.includes("continuity-delta"));
    assert.ok(entry.summary.includes("Use sqlite"), "in the briefing");
    const report = done.details.continuity as {
      applied: number;
      rejected: Array<{ id?: string; reason: string }>;
    };
    assert.equal(report.applied, 2);
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0].id, "R1");
    const lines = done.content.split("\n\n");
    const notice = lines.find((line) => line.startsWith("Continuity: "));
    assert.ok(notice, "the model is told its attempt was refused");
    assert.match(
      notice,
      /^Continuity: 1 delta op rejected \(R1 .*protected.*\)\.$/,
    );
  });

  it("accepts a supersession that cites a newer user message of the active branch and refuses a bogus citation", async () => {
    const delta = (citedEntryId: string) =>
      SUMMARY_TEXT +
      deltaBlock({
        superseded: [
          {
            ids: ["R1"],
            with: { kind: "rule", text: "Edit the lockfile only via pnpm" },
            citedEntryId,
          },
        ],
      });
    const f = ledgerSetup();
    await foldWith(f, delta(f.a1));
    const refused = foldedEntry(f.sm, f.pi);
    assert.equal(
      (refused.done.details.continuity as { rejected: unknown[] }).rejected
        .length,
      1,
    );
    const g = ledgerSetup();
    await foldWith(g, delta(g.t3.userId));
    const accepted = foldedEntry(g.sm, g.pi);
    assert.deepEqual(
      (accepted.done.details.continuity as { rejected: unknown[] }).rejected,
      [],
    );
    const { ledger } = readBranchLedger(g.sm.getBranch());
    assert.equal(ledger.items.find((i) => i.id === "R1")?.status, "superseded");
    assert.equal(
      ledger.items.find((i) => i.text === "Edit the lockfile only via pnpm")
        ?.source.origin,
      "user",
      "the replacement keeps the user's authority",
    );
  });

  it("a malformed delta never fails the fold: reported, nothing applied, block stripped", async () => {
    const f = await ledgerFixture({
      summary: `${SUMMARY_TEXT}\n\n<continuity-delta>\n{ nope\n</continuity-delta>`,
    });
    const { done, entry } = foldedEntry(f.sm, f.pi);
    assert.equal(done.details.status, "done");
    assert.ok(!entry.summary.includes("continuity-delta"));
    const report = done.details.continuity as {
      applied: number;
      deltaError?: string;
    };
    assert.equal(report.applied, 1, "only the deterministic steering archive");
    assert.match(report.deltaError ?? "", /not valid JSON/);
    assert.match(done.content, /\n\nContinuity: delta ignored \(/);
    assert.equal(
      readBranchLedger(f.sm.getBranch()).ledger.items.find((i) => i.id === "R1")
        ?.status,
      "active",
    );
  });

  it("keeps a stray delta tag in the stored prose and reports nothing", async () => {
    const stray = `${SUMMARY_TEXT}\n\nThe tag <continuity-delta> is mentioned here.`;
    const f = await ledgerFixture({ summary: stray });
    const { done, entry } = foldedEntry(f.sm, f.pi);
    assert.ok(
      entry.summary.includes("The tag <continuity-delta> is mentioned here."),
    );
    assert.equal(
      (done.details.continuity as { deltaError?: string }).deltaError,
      undefined,
    );
    assert.ok(!done.content.includes("Continuity:"));
  });

  it("the pre-fold leaf still reads the pre-fold ledger", async () => {
    const f = await ledgerFixture({ summary: SUMMARY_TEXT });
    const after = readBranchLedger(f.sm.getBranch());
    assert.equal(
      after.ledger.items.find((i) => i.id === "T2")?.status,
      "archived",
    );
    f.sm.branch(f.leafBeforeFold);
    const recovered = readBranchLedger(f.sm.getBranch());
    assert.deepEqual(recovered, f.before);
    assert.equal(
      recovered.ledger.items.find((i) => i.id === "T2")?.status,
      "active",
    );
  });

  it("an empty ledger and a span without user messages change nothing", async () => {
    const f = setup();
    setupAutonomousSpan(f.sm, f.pi);
    const registry = fakeRegistry(() =>
      reply(`${SUMMARY_TEXT}\n\nA stray </continuity-delta> in prose.`),
    );
    f.ctx.modelRegistry = registry.registry;
    await requestRewind(f);
    assert.ok(
      requestText(registry.calls.at(-1) as RegistryCall).endsWith(
        `Additional focus: ${REWIND_ARGS.summaryFocus}`,
      ),
      "no continuity section in the request",
    );
    const { done, entry } = foldedEntry(f.sm, f.pi);
    assert.equal(
      entry.summary,
      `# Work handoff: end\n\n${SUMMARY_TEXT}\n\nA stray </continuity-delta> in prose.`,
    );
    assert.ok(!(LEDGER_DETAILS_KEY in (entry.details as object)));
    assert.ok(!("continuity" in done.details));
    assert.ok(!done.content.includes("Continuity"));
  });

  it("a failed fold applies nothing: the ledger and the branch stay as they were", async () => {
    const f = ledgerSetup();
    const { boundary } = await foldWith(
      f,
      `no goal heading${deltaBlock({ ratified: [{ kind: "decision", text: "Hidden" }] })}`,
    );
    assert.equal(boundary.entries[0].details.status, "failed");
    assert.ok(!f.sm.getEntries().some((e) => e.type === "branch_summary"));
    assert.deepEqual(
      readBranchLedger(f.sm.getBranch()).ledger,
      f.before.ledger,
    );
  });

  it("a refused preview writes nothing, and the briefing counts toward the size check", async () => {
    const run = async (rules: number) => {
      const f = setup();
      const first = appendTurn(f.sm, "u1", "a1", 6_000);
      f.pi.pi.setLabel(first.assistantId, "anchor:start");
      const ops: StoredOp[] = Array.from({ length: rules }, (_, i) => ({
        op: {
          op: "add",
          kind: "rule",
          text: `Rule ${i}: ${"binding ".repeat(60)}`,
        },
        ctx: { origin: "user" },
      }));
      appendOpsEntry(f.pi.pi, ops);
      for (const totalTokens of [20_000, 30_000]) {
        f.sm.appendMessage(
          assistantMessage(
            [{ type: "text", text: "work. ".repeat(400) }],
            "stop",
            totalTokens,
          ) as never,
        );
      }
      const before = readBranchLedger(f.sm.getBranch());
      const { boundary } = await requestRewind(f);
      return { f, before, boundary };
    };
    const small = await run(0);
    assert.ok(
      small.f.sm.getEntries().some((e) => e.type === "branch_summary"),
      "without a ledger the fold reduces",
    );
    const big = await run(12);
    assert.ok(!big.f.sm.getEntries().some((e) => e.type === "branch_summary"));
    assert.equal(big.boundary.entries[0].details.status, "failed");
    assert.equal(big.boundary.entries[0].details.stage, "commit");
    assert.match(
      String(big.boundary.entries[0].details.detail),
      /does not reduce projected context/,
    );
    assert.deepEqual(readBranchLedger(big.f.sm.getBranch()), big.before);
  });

  it("a parent fold embeds only its own briefing, not the child's", async () => {
    const f = await ledgerFixture({ summary: SUMMARY_TEXT });
    await configureParentMode(f, "full");
    const first = foldedEntry(f.sm, f.pi);
    assert.match(first.entry.summary, /continuity ledger rev 4\]/);
    appendTurn(f.sm, "u4 prefer small diffs", "a4", 40_000, true);
    appendOpsEntry(f.pi.pi, [
      {
        op: { op: "add", kind: "rule", text: "Prefer small diffs" },
        ctx: { origin: "user" },
      },
    ]);
    appendTurn(f.sm, "u5", "a5", 60_000, true);
    await foldWith(
      f,
      "## Goal\nSecond fold.\n\n## Next Steps\n1. Go.",
      { ...REWIND_ARGS, newLabel: "end2" },
      "tc-rewind-2",
      70_000,
    );
    const second = foldedEntry(f.sm, f.pi);
    assert.equal(second.entry.summary.split("## Continuity ledger").length, 2);
    assert.match(second.entry.summary, /Child handoffs in chronological order/);
    assert.ok(second.entry.summary.includes(SUMMARY_TEXT));
    assert.ok(second.entry.summary.endsWith("Prefer small diffs"));
    const { ledger } = readBranchLedger(f.sm.getBranch());
    assert.deepEqual(
      ledger.items.filter((i) => i.status === "active").map((i) => i.text),
      [
        "Never edit the lockfile",
        "Always run the linter",
        "Prefer small diffs",
      ],
    );
  });
});

// =============================================================================
// Session continuity ledger: the agent's `pin` action
// =============================================================================

describe("dispatch: pin action", () => {
  type Fixture = ReturnType<typeof setup>;
  let calls = 0;

  /** One tool call as the agent loop runs it: the assistant's call, `execute`, then its result. */
  async function pin(f: Fixture, params: Record<string, unknown>) {
    const id = `tc-pin-${++calls}`;
    appendToolCallAssistant(f.sm, [
      { id, name: TOOL_NAME, arguments: { action: "pin", ...params } },
    ]);
    const result = await f.tool.execute(
      id,
      { action: "pin", ...params },
      undefined,
      undefined,
      f.ctx,
    );
    appendToolResult(
      f.sm,
      id,
      TOOL_NAME,
      result.content[0].text,
      result.details,
    );
    return result;
  }

  const opsWritten = (f: Fixture) =>
    f.pi.appendEntryCalls.filter(
      ([type]) => type === CONTINUITY_OPS_CUSTOM_TYPE,
    );
  const items = (f: Fixture) => readBranchLedger(f.sm.getBranch()).ledger.items;

  /** An anchored first turn, so steering has an anchor to belong to. */
  function anchored(f: Fixture, name = "start") {
    const first = appendTurn(f.sm, "u1 setting the stage", "a1", 6_000);
    f.pi.pi.setLabel(first.assistantId, `anchor:${name}`);
  }

  it("records a decision as an agent-origin item and a fold carries it in the snapshot, the report and the briefing", async () => {
    const f = setup();
    anchored(f);
    appendTurn(f.sm, "u2 pick a store", "a2", 12_000, true);
    const result = await pin(f, {
      kind: "decision",
      text: "Use sqlite for the index",
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "[pin] D1 decision recorded");
    assert.deepEqual(result.details, {
      id: "D1",
      kind: "decision",
      effect: "added",
      rev: 1,
    });
    assert.deepEqual(opsWritten(f), [
      [
        CONTINUITY_OPS_CUSTOM_TYPE,
        {
          ops: [
            {
              op: {
                op: "add",
                kind: "decision",
                text: "Use sqlite for the index",
              },
              ctx: { origin: "agent" },
            },
          ],
        },
      ],
    ]);
    const [decision, ...rest] = items(f);
    assert.equal(rest.length, 0);
    assert.equal(decision.kind, "decision");
    assert.equal(decision.status, "active");
    assert.equal(decision.text, "Use sqlite for the index");
    assert.equal(decision.source.origin, "agent");
    assert.equal(
      decision.pinned,
      undefined,
      "an agent pin is not user-protected",
    );

    appendTurn(f.sm, "u3 keep going", "a3", 24_000, true);
    await requestRewind(f);
    const done = rewindMessages(f.pi).at(-1);
    assert.ok(done, "a continuation was delivered");
    const entry = f.sm.getEntry(done.message.details.summaryId as string);
    assert.ok(entry && entry.type === "branch_summary");
    const snapshot = parseLedger(
      (entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
    );
    assert.deepEqual(
      snapshot.items.map((i) => [i.id, i.status, i.source.origin]),
      [["D1", "active", "agent"]],
    );
    assert.deepEqual(readBranchLedger(f.sm.getBranch()).ledger, snapshot);
    assert.deepEqual(done.message.details.continuity, {
      rev: snapshot.rev,
      applied: 0,
      rejected: [],
      evicted: [],
    });
    const briefing = renderBriefing(snapshot, { maxTokens: 2500 }).text;
    assert.ok(briefing.includes("Use sqlite for the index"));
    assert.ok(entry.summary.endsWith(`## Continuity ledger\n\n${briefing}`));
  });

  it("refuses rule, objective and unknown kinds before anything is written", async () => {
    const f = setup();
    anchored(f);
    for (const kind of ["rule", "objective", "nonsense", undefined]) {
      const result = await pin(f, { kind, text: "Always use tabs" });
      assert.equal(result.isError, true, `kind ${String(kind)}`);
      assert.equal(result.details.refusal, true);
    }
    const rule = await pin(f, { kind: "rule", text: "Always use tabs" });
    assert.match(rule.content[0].text, /captured automatically/);
    const unknown = await pin(f, { kind: "nonsense", text: "x" });
    assert.match(
      unknown.content[0].text,
      /sub-goal, decision, fact, file, steering/,
    );
    assert.equal(opsWritten(f).length, 0);
    assert.deepEqual(items(f), []);
  });

  it("validates the params each kind needs and writes nothing when one is missing", async () => {
    const f = setup();
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ kind: "decision" }, /requires `text`/],
      [{ kind: "fact", text: "   " }, /requires `text`/],
      [{ kind: "file", why: "design notes" }, /requires `path` and `why`/],
      [{ kind: "file", path: "notes.md" }, /requires `path` and `why`/],
      [{ kind: "steering", text: "Parser first" }, /anchor first/],
      [
        { kind: "file", path: "notes.md", why: "w", lines: "ten" },
        /file\.lines must be N or N-M/,
      ],
    ];
    for (const [params, message] of refused) {
      const result = await pin(f, params);
      assert.equal(result.isError, true, JSON.stringify(params));
      assert.match(result.content[0].text, message);
    }
    assert.equal(opsWritten(f).length, 0);
  });

  it("scopes steering to the newest anchor by default and sub-goals only when asked", async () => {
    const f = setup();
    anchored(f, "start");
    const second = appendTurn(f.sm, "u2", "a2", 12_000);
    f.pi.pi.setLabel(second.assistantId, "anchor:parser-work");
    await pin(f, { kind: "steering", text: "Parser first" });
    await pin(f, {
      kind: "steering",
      text: "Then the lexer",
      scopeAnchor: "start",
    });
    await pin(f, { kind: "sub-goal", text: "Port the lexer" });
    await pin(f, {
      kind: "sub-goal",
      text: "Port the parser",
      scopeAnchor: "parser-work",
    });
    assert.deepEqual(
      items(f).map((i) => [i.id, i.kind, i.scopeAnchor]),
      [
        ["T1", "steering", "parser-work"],
        ["T2", "steering", "start"],
        ["S3", "sub-goal", undefined],
        ["S4", "sub-goal", "parser-work"],
      ],
    );
    const unknown = await pin(f, {
      kind: "steering",
      text: "Elsewhere",
      scopeAnchor: "no-such-anchor",
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /No label 'no-such-anchor'/);
    assert.equal(items(f).length, 4);
  });

  describe("file pointers", () => {
    const withDir = async (run: (dir: string, f: Fixture) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), "navigate-tree-pin-"));
      try {
        const f = setup();
        f.ctx.cwd = dir;
        await run(dir, f);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("stores the normalized path with the sha256 of the file", async () => {
      await withDir(async (dir, f) => {
        const content = "# Design\nUse sqlite.\n";
        writeFileSync(join(dir, "notes.md"), content);
        const result = await pin(f, {
          kind: "file",
          path: "./notes.md",
          lines: "3-9",
          why: "design notes",
        });
        assert.equal(result.content[0].text, "[pin] P1 file recorded");
        const [item] = items(f);
        assert.equal(item.kind, "file");
        assert.equal(item.text, "notes.md:3-9");
        assert.equal(item.source.origin, "agent");
        assert.deepEqual(item.file, {
          path: "notes.md",
          lines: "3-9",
          sha256: createHash("sha256").update(content).digest("hex"),
          why: "design notes",
        });
      });
    });

    it("still pins, without a hash, a file that is missing or over 2 MB", async () => {
      await withDir(async (dir, f) => {
        writeFileSync(join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
        await pin(f, { kind: "file", path: "big.bin", why: "too big" });
        await pin(f, {
          kind: "file",
          path: "missing.md",
          why: "not written yet",
        });
        assert.deepEqual(
          items(f).map((i) => [i.text, i.file?.sha256]),
          [
            ["big.bin", undefined],
            ["missing.md", undefined],
          ],
        );
      });
    });
  });

  it("refuses everything and writes nothing when the ledger is disabled by config", async () => {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(
        fixture,
        JSON.stringify({ continuity: { capture: false } }),
      );
      const f = setup();
      anchored(f);
      await runSessionStart(f.pi, f.ctx, fixture);
      const result = await pin(f, { kind: "decision", text: "Use sqlite" });
      assert.equal(result.isError, true);
      assert.equal(result.details.refusal, true);
      assert.equal(
        result.content[0].text,
        "continuity ledger is disabled by config",
      );
      assert.equal(f.pi.appendEntryCalls.length, 0);
      assert.deepEqual(items(f), []);
    } finally {
      cleanupConfigFixture(fixture);
    }
  });

  it("reports the existing item for a repeat and for a user decision with the same words, and writes no second item", async () => {
    const f = setup();
    appendOpsEntry(f.pi.pi, [
      {
        op: { op: "add", kind: "decision", text: "Use postgres for billing" },
        ctx: { origin: "user" },
      },
    ]);
    await pin(f, { kind: "fact", text: "The parser is in src/parse.ts" });
    const before = opsWritten(f).length;

    const again = await pin(f, {
      kind: "fact",
      text: "the parser is  in src/parse.ts",
    });
    assert.equal(again.isError, undefined);
    assert.equal(
      again.content[0].text,
      "[pin] F2 already records this fact; nothing added.",
    );
    assert.equal(again.details.id, "F2");
    assert.equal(again.details.effect, "duplicate");

    const userOwned = await pin(f, {
      kind: "decision",
      text: "Use postgres for billing",
    });
    assert.equal(userOwned.isError, undefined);
    assert.equal(userOwned.details.id, "D1");
    assert.equal(userOwned.details.effect, "duplicate");

    assert.equal(opsWritten(f).length, before, "no second ops entry");
    assert.deepEqual(
      items(f).map((i) => [i.id, i.source.origin]),
      [
        ["D1", "user"],
        ["F2", "agent"],
      ],
    );
  });

  it("`list` appends the ledger briefing once something is in force", async () => {
    const f = setup();
    anchored(f);
    const text = async () =>
      (
        await f.tool.execute(
          "tc-list",
          { action: "list" },
          undefined,
          undefined,
          f.ctx,
        )
      ).content[0].text;
    assert.ok(!(await text()).includes("continuity ledger"));
    await pin(f, { kind: "decision", text: "Use sqlite for the index" });
    await pin(f, { kind: "fact", text: "The parser is in src/parse.ts" });
    const { ledger } = readBranchLedger(f.sm.getBranch());
    const listed = await text();
    assert.ok(
      listed.endsWith(`\n\n${renderBriefing(ledger, { maxTokens: 500 }).text}`),
    );
    assert.match(listed, /D1 \[agent\] Use sqlite for the index/);
    assert.match(listed, /F2 The parser is in src\/parse\.ts/);
  });
});

// =============================================================================
// Session continuity ledger: capture at turn_end
// =============================================================================

describe("continuity capture", () => {
  const RULE = "From now on always answer in German";
  const userMessage = (text: string) =>
    ({ role: "user", content: [{ type: "text", text }] }) as never;

  /**
   * A user message with only `userText` (a heavy `appendTurn` would bury the
   * words in padding) and an assistant reply of `tokens` usage and bulk text.
   */
  function workTurn(sm: SessionManager, userText: string, tokens: number) {
    const userId = sm.appendMessage(userMessage(userText));
    const message = assistantMessage(
      [{ type: "text", text: "Recorded work and evidence.\n".repeat(1200) }],
      "stop",
      tokens,
    );
    return { userId, message, assistantId: sm.appendMessage(message as never) };
  }

  /** A complete user/assistant turn, then the turn's `turn_end` boundary. */
  async function turn(
    f: { sm: SessionManager; pi: FakePi; ctx: FakeCtx },
    userText: string,
    tokens = 100,
  ) {
    const { assistantId } = appendTurn(f.sm, userText, "ok", tokens);
    const message = (f.sm.getEntry(assistantId) as { message: unknown })
      .message;
    return fireTurnEndAll(f.pi, f.ctx, message);
  }

  const opsEntries = (sm: SessionManager) =>
    sm
      .getBranch()
      .filter(
        (e) =>
          e.type === "custom" && e.customType === CONTINUITY_OPS_CUSTOM_TYPE,
      );

  const rulesOf = (sm: SessionManager) =>
    readBranchLedger(sm.getBranch()).ledger.items.filter(
      (item) => item.kind === "rule" && item.status === "active",
    );

  const answerRule = (kind: string) => ({
    answers: {
      kind: { type: "choice", choice: kind, probabilities: {}, confidence: 1 },
    },
  });

  function fakeRegistry(
    classify: (signal?: AbortSignal) => Promise<unknown>,
    known = ["typesafe/jev-latest"],
  ) {
    const calls: string[] = [];
    const registry = {
      getModelOfType: (_type: string, provider: string, id: string) =>
        known.includes(`${provider}/${id}`) ? { provider, id } : undefined,
      classify: async (
        _model: unknown,
        context: { state: { message: string } },
        options?: { signal?: AbortSignal },
      ) => {
        calls.push(context.state.message);
        return {
          api: "test",
          provider: "typesafe",
          model: "jev-latest",
          stopReason: "stop",
          timestamp: 0,
          ...((await classify(options?.signal)) as object),
        };
      },
    };
    return { registry, calls };
  }

  async function withConfig(
    continuity: Record<string, unknown>,
    run: (f: ReturnType<typeof setup>) => Promise<void>,
    ctxOpts: { hasUI?: boolean } = {},
  ) {
    const fixture = makeConfigFixture();
    try {
      writeGlobalConfig(fixture, JSON.stringify({ continuity }));
      const f = setup();
      if (ctxOpts.hasUI !== undefined) f.ctx.hasUI = ctxOpts.hasUI;
      await runSessionStart(f.pi, f.ctx, fixture);
      await run(f);
    } finally {
      cleanupConfigFixture(fixture);
    }
  }

  it("captures nothing while navigate_tree is not in the active tool set", async () => {
    const f = setup();
    await fireBeforeAgentStart(f.pi, f.ctx, ["read", "bash"]);
    await turn(f, RULE);
    assert.equal(opsEntries(f.sm).length, 0);

    await fireBeforeAgentStart(f.pi, f.ctx, ["read", "navigate_tree"]);
    await turn(f, "Always use tabs from now on, going forward.");
    assert.equal(opsEntries(f.sm).length, 1);
  });

  it("records the user's rule verbatim after the turn, and nothing more on a turn without new input", async () => {
    const f = setup();
    const { userId, assistantId } = appendTurn(f.sm, RULE, "ok");
    const message = (f.sm.getEntry(assistantId) as { message: unknown })
      .message;
    await fireTurnEndAll(f.pi, f.ctx, message);

    const branch = f.sm.getBranch();
    assert.deepEqual(
      branch.slice(-3).map((e) => e.id),
      [userId, assistantId, opsEntries(f.sm)[0].id],
      "the entry follows the completed turn",
    );
    assert.equal(opsEntries(f.sm).length, 1);
    const [rule, ...rest] = rulesOf(f.sm);
    assert.equal(rest.length, 0);
    assert.equal(rule.source.origin, "user");
    assert.equal(rule.source.entryId, userId);
    assert.equal(rule.quote, RULE);
    assert.equal(rule.text, RULE);

    await fireTurnEndAll(f.pi, f.ctx, message);
    appendTurn(f.sm, "ok thanks", "sure");
    const next = f.sm.getBranch().at(-1) as { message: unknown };
    await fireTurnEndAll(f.pi, f.ctx, next.message);
    assert.equal(opsEntries(f.sm).length, 1);
    assert.equal(f.pi.appendEntryCalls.length, 1);
  });

  it("writes nothing and never calls the classifier when capture is off", async () => {
    const { registry, calls } = fakeRegistry(async () => answerRule("rule"));
    await withConfig(
      { capture: false, intentClassifier: "typesafe/jev-latest" },
      async (f) => {
        (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
        await turn(f, RULE);
        await turn(f, "Never touch the generated files");
        assert.equal(opsEntries(f.sm).length, 0);
        assert.equal(f.pi.appendEntryCalls.length, 0);
        assert.deepEqual(calls, []);
      },
    );
  });

  it("leaves a tool batch without all its results alone, then records after the last result", async () => {
    const f = setup();
    f.sm.appendMessage(userMessage(RULE));
    const call = appendToolCallAssistant(f.sm, [
      { id: "tc-a", name: "bash", arguments: { command: "true" } },
      { id: "tc-b", name: "bash", arguments: { command: "true" } },
    ]);
    const resultA = appendToolResult(f.sm, "tc-a", "bash", "done");
    await fireTurnEndAll(f.pi, f.ctx, call.message);
    assert.equal(opsEntries(f.sm).length, 0, "a result is still outstanding");
    assert.equal(f.sm.getLeafId(), resultA);

    const resultB = appendToolResult(f.sm, "tc-b", "bash", "done");
    await fireTurnEndAll(f.pi, f.ctx, call.message);
    const [entry] = opsEntries(f.sm);
    assert.deepEqual(
      f.sm
        .getBranch()
        .slice(-3)
        .map((e) => e.id),
      [resultA, resultB, entry.id],
    );
  });

  it("skips an aborted turn and picks the input up on the next one", async () => {
    const f = setup();
    f.sm.appendMessage(userMessage(RULE));
    const aborted = assistantMessage([], "aborted", 0);
    f.sm.appendMessage(aborted as never);
    await fireTurnEndAll(f.pi, f.ctx, aborted);
    assert.equal(opsEntries(f.sm).length, 0);
    await turn(f, "carry on with the parser please");
    assert.equal(rulesOf(f.sm).length, 1);
  });

  describe("fold", () => {
    async function foldFixture(opts: { capturedBefore: boolean }) {
      const f = setup();
      const first = appendTurn(f.sm, "u1 setting the stage", "a1", 6_000);
      f.pi.pi.setLabel(first.assistantId, "anchor:start");
      if (opts.capturedBefore) {
        const rule = workTurn(f.sm, RULE, 12_000);
        await fireTurnEndAll(f.pi, f.ctx, rule.message);
        assert.equal(opsEntries(f.sm).length, 1);
      } else {
        workTurn(f.sm, RULE, 12_000);
      }
      const t3 = workTurn(f.sm, "u3 look at the parser", 24_000);
      await requestRewind(f);
      const done = rewindMessages(f.pi).at(-1);
      assert.ok(done, "a continuation was delivered");
      const entry = f.sm.getEntry(done.message.details.summaryId as string);
      assert.ok(entry && entry.type === "branch_summary");
      return { ...f, entry, t3 };
    }

    for (const capturedBefore of [true, false]) {
      it(`carries the rule into the snapshot and the briefing (captured ${capturedBefore ? "at its turn" : "only at the rewind turn"})`, async () => {
        const f = await foldFixture({ capturedBefore });
        const snapshot = parseLedger(
          (f.entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY],
        );
        const rules = snapshot.items.filter((i) => i.kind === "rule");
        assert.equal(rules.length, 1);
        assert.equal(rules[0].status, "active");
        assert.equal(rules[0].source.origin, "user");
        assert.equal(rules[0].quote, RULE);
        const briefing = renderBriefing(snapshot, { maxTokens: 2500 }).text;
        assert.ok(
          f.entry.summary.endsWith(`## Continuity ledger\n\n${briefing}`),
        );
        assert.ok(briefing.includes(RULE));
        assert.equal(
          f.sm.getBranch().some((e) => e.id === f.t3.userId),
          false,
          "the span left the branch",
        );
      });
    }

    it("puts the span's rule into the summary request when no turn recorded it yet", async () => {
      const f = setup();
      const first = appendTurn(f.sm, "u1 setting the stage", "a1", 6_000);
      f.pi.pi.setLabel(first.assistantId, "anchor:start");
      workTurn(f.sm, RULE, 12_000);
      workTurn(f.sm, "u3 look at the parser", 24_000);
      assert.equal(f.pi.appendEntryCalls.length, 0);
      await requestRewind(f);
      assert.equal(
        f.pi.appendEntryCalls.filter(
          ([type]) => type === CONTINUITY_OPS_CUSTOM_TYPE,
        ).length,
        1,
        "captured at the rewind turn, before the fold",
      );
      const request = JSON.stringify(
        f.ctx.registryCalls.at(-1)?.context.messages.at(-1),
      );
      assert.ok(request.includes(`R1 ${RULE}`));
    });
  });

  describe("classifier", () => {
    it("asks the configured model and records what it calls a rule", async () => {
      const { registry, calls } = fakeRegistry(async () => answerRule("rule"));
      await withConfig(
        { intentClassifier: "typesafe/jev-latest" },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          const quiet = "Please keep the answers short from here";
          await turn(f, quiet);
          assert.deepEqual(calls, [quiet]);
          assert.equal(rulesOf(f.sm)[0]?.quote, quiet);
        },
      );
    });

    it("records a model-classified ephemeral message as seen, so it is not asked again", async () => {
      const { registry, calls } = fakeRegistry(async () =>
        answerRule("ephemeral"),
      );
      await withConfig(
        { intentClassifier: "typesafe/jev-latest" },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          await turn(f, "What does the parser do with tabs?");
          await turn(f, "And what about the lexer, then?");
          assert.equal(calls.length, 2, "each message is asked once");
          assert.equal(opsEntries(f.sm).length, 2);
          assert.deepEqual(rulesOf(f.sm), []);
        },
      );
    });

    it("warns once about an unknown classifier model and falls back to heuristics", async () => {
      const { registry, calls } = fakeRegistry(
        async () => answerRule("rule"),
        [],
      );
      await withConfig(
        { intentClassifier: "typesafe/jev-latest" },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          await turn(f, RULE);
          await turn(f, "Never touch the generated files");
          assert.deepEqual(calls, []);
          assert.equal(rulesOf(f.sm).length, 2, "heuristics still capture");
          assert.equal(f.ctx.notifyCalls.length, 1);
          assert.equal(f.ctx.notifyCalls[0][1], "warning");
          assert.match(f.ctx.notifyCalls[0][0], /typesafe\/jev-latest/);
        },
      );
    });

    it("stays silent headless", async () => {
      const { registry } = fakeRegistry(async () => answerRule("rule"), []);
      await withConfig(
        { intentClassifier: "typesafe/jev-latest" },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          await turn(f, RULE);
          assert.equal(rulesOf(f.sm).length, 1);
          assert.deepEqual(f.ctx.notifyCalls, []);
        },
        { hasUI: false },
      );
    });

    it("discards an old classifier timeout after configuration reload", async () => {
      let first = true;
      const { registry, calls } = fakeRegistry((signal) => {
        if (!first) return Promise.resolve(answerRule("rule"));
        first = false;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      });
      await withConfig(
        { intentClassifier: "typesafe/jev-latest" },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          const fixture = makeConfigFixture();
          writeGlobalConfig(
            fixture,
            JSON.stringify({
              continuity: { intentClassifier: "typesafe/jev-latest" },
            }),
          );
          mock.timers.enable({ apis: ["setTimeout"] });
          try {
            const pending = turn(f, RULE);
            await new Promise((resolve) => setImmediate(resolve));
            await runSessionStart(f.pi, f.ctx, fixture, "reload");
            mock.timers.tick(15_000);
            await pending;
            assert.deepEqual(
              f.ctx.notifyCalls,
              [],
              "stale timeout must not suppress or warn for the new configuration",
            );
            await turn(f, "Keep the output readable");
            assert.ok(
              calls.length > 1,
              "new configuration still uses the classifier",
            );
          } finally {
            mock.timers.reset();
            cleanupConfigFixture(fixture);
          }
        },
      );
    });

    it("does not let a classifier that never answers stall the turn or dump its policy", async () => {
      const { registry, calls } = fakeRegistry(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      );
      Object.assign(registry, {
        getAvailableOfType: async (type: string) =>
          type === "classifier"
            ? [{ provider: "typesafe", id: "jev-latest", api: "decisions" }]
            : [],
        streamSimple: () => {
          throw new Error("No chat calls expected");
        },
      });
      await withConfig(
        { intentClassifier: { kind: { model: "typesafe/jev-latest" } } },
        async (f) => {
          (f.ctx as { modelRegistry?: unknown }).modelRegistry = registry;
          mock.timers.enable({ apis: ["setTimeout"] });
          try {
            const pending = turn(f, RULE);
            await new Promise((resolve) => setImmediate(resolve));
            mock.timers.tick(15_000);
            await pending;
          } finally {
            mock.timers.reset();
          }
          assert.equal(calls.length, 1);
          assert.equal(rulesOf(f.sm).length, 1, "the heuristic pass caught it");
          assert.equal(f.ctx.notifyCalls.length, 1);
          assert.match(
            f.ctx.notifyCalls[0][0],
            /classifier typesafe\/jev-latest did not answer within 15 s/,
          );
          assert.ok(!f.ctx.notifyCalls[0][0].includes("{"));
          await turn(f, "Never touch the generated files");
          assert.equal(calls.length, 1, "the model is not asked again");
          assert.equal(rulesOf(f.sm).length, 2);
        },
      );
    });
  });
});

// =============================================================================
// Independent folds from the extension (engine host)
//
// A fold is summarized by registry side calls, never by a main-agent turn, so
// it works for a session whose next main request the admission guard would
// refuse. Nothing is written before the commit.
// =============================================================================

describe("independent folds through the engine host", () => {
  const WINDOW = 100_000;
  /** The guard refuses a request unless it leaves the minimum output plus the headroom. */
  const GUARD_RESERVE = 1_024 + 4_096;
  const SYSTEM_MESSAGE = {
    role: "system",
    content: "You are the pi agent.",
    timestamp: 0,
  };
  const FOLD = {
    origin: "manual",
    rewindTo: "start",
    newLabel: "folded",
    focus:
      "Continue the parser fix; the user's last instruction was to keep the tests green.",
  } as const;

  /**
   * An anchored session of five heavy turns. `leafTokens` is the usage the
   * newest assistant reports: 99k leaves the next main request over the guard.
   */
  async function foldSetup(leafTokens: number) {
    const fixture = makeConfigFixture();
    writeGlobalConfig(
      fixture,
      JSON.stringify({ rewindHintReserveTokens: 20_000 }),
    );
    const f = setup({ contextWindow: WINDOW });
    (f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
    f.ctx.cwd = fixture.projectDir;
    await runSessionStart(f.pi, f.ctx, fixture);
    const first = appendTurn(f.sm, "u1", "a1", 5_000);
    f.pi.pi.setLabel(first.assistantId, "anchor:start");
    let leafId = first.assistantId;
    for (const [i, tokens] of [
      12_000,
      24_000,
      36_000,
      48_000,
      leafTokens,
    ].entries()) {
      leafId = appendTurn(
        f.sm,
        `u${i + 2}`,
        `a${i + 2}`,
        tokens,
        true,
      ).assistantId;
    }
    // pi persists a message sent while idle, without starting a turn.
    const hooks = f.pi.pi as unknown as Record<string, unknown>;
    hooks.sendMessage = (...args: unknown[]) => {
      f.pi.sendMessageCalls.push(args);
      const [m] = args as [
        {
          customType: string;
          content: string;
          display: boolean;
          details: unknown;
        },
      ];
      f.sm.appendCustomMessageEntry(
        m.customType,
        m.content,
        m.display,
        m.details,
      );
    };
    hooks.getThinkingLevel = () => "medium";
    const api = __testHooks.foldApi(f.pi.pi);
    assert.ok(api, "the factory exposes its fold entry points");
    return { ...f, fixture, api, anchorId: first.assistantId, leafId };
  }
  type FoldFixture = Awaited<ReturnType<typeof foldSetup>>;

  const foldCtx = (f: { ctx: FakeCtx }, registry: object, extra: object = {}) =>
    ({
      ...f.ctx,
      modelRegistry: registry,
      isIdle: () => true,
      ...extra,
    }) as FakeCtx & {
      modelRegistry: object;
      isIdle(): boolean;
    };

  const snapshotOf = (sm: SessionManager) => ({
    entries: sm.getEntries().map((entry) => entry.id),
    leaf: sm.getLeafId(),
  });

  /** Fire the admission guard as the next main request would; true when it aborts the request. */
  async function guardAborts(f: FoldFixture, ctx: FakeCtx): Promise<boolean> {
    const aborter = new AbortController();
    const messages = [SYSTEM_MESSAGE, ...fireContext(f.pi, ctx)];
    for (const handler of f.pi.onCalls.get("context_with_system") ?? []) {
      await handler(
        { type: "context_with_system", messages } as never,
        {
          ...ctx,
          signal: aborter.signal,
          abort: () => aborter.abort(),
        } as never,
      );
    }
    return aborter.signal.aborted;
  }

  /** The summary landed as a new branch from the anchor, and the old leaf is marked. */
  function assertFolded(f: FoldFixture) {
    const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
    assert.ok(summary, "a branch_summary is on the active branch");
    assert.equal(summary.parentId, f.anchorId);
    assert.equal(f.sm.getLabel(f.leafId), "branch:folded");
    assert.equal(f.sm.getLabel(summary.id), "anchor:folded");
    assert.ok(!f.sm.getBranch().some((e) => e.id === f.leafId));
    assert.ok(
      estimateAdmissionTokens(f.sm) + GUARD_RESERVE <= WINDOW,
      "the next main request is admitted",
    );
    return summary;
  }

  /** No in-band machinery ran: no instruction message, no user message, no turn started. */
  function assertNoSummaryTurn(f: FoldFixture, registryCalls: RegistryCall[]) {
    assert.ok(
      f.sm
        .getEntries()
        .every(
          (e) =>
            !(
              e.type === "custom_message" &&
              e.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE
            ),
        ),
    );
    assert.equal(f.pi.sendUserMessageCalls.length, 0);
    for (const args of f.pi.sendMessageCalls) {
      assert.deepEqual(args[1], { triggerTurn: false });
    }
    assert.ok(registryCalls.length > 0);
    for (const call of registryCalls) {
      assert.equal(call.options.toolChoice, "none");
      assert.equal(call.options.sessionId, f.sm.getSessionId());
    }
  }

  const leafMessage = (f: FoldFixture) => {
    const entry = f.sm.getEntry(f.leafId);
    assert.equal(entry?.type, "message");
    return (entry as { message: unknown }).message;
  };

  const receiptsOf = (sm: SessionManager) =>
    sm
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" &&
        entry.customType === REWIND_CUSTOM_TYPE
          ? [entry]
          : [],
      );

  it("folds an idle session whose next main request the guard refuses, with side calls only", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry);
      assert.ok(
        estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW,
        "the next request exceeds the admission guard",
      );
      const before = snapshotOf(f.sm);

      const outcome = await f.api.runFoldNow(ctx as never, FOLD);

      assert.equal(outcome.status, "done", JSON.stringify(outcome));
      if (outcome.status !== "done") return;
      assert.equal(
        outcome.strategy,
        "chunked",
        "the live request cannot be admitted",
      );
      assertFolded(f);
      assertNoSummaryTurn(f, registry.calls);
      assert.equal(
        registry.calls[0].options.reasoning,
        "low",
        "fold summaries cap the session's medium thinking at low",
      );
      const receipt = receiptsOf(f.sm).at(-1);
      assert.equal(
        f.sm.getLeafId(),
        receipt?.id,
        "the continuation ends the new branch",
      );
      assert.equal((receipt?.details as { status?: string }).status, "done");
      assert.deepEqual(
        before.entries,
        snapshotOf(f.sm).entries.slice(0, before.entries.length),
        "the abandoned branch is kept on disk",
      );
      assert.equal(await guardAborts(f, ctx), false, "the next request fits");
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("folds at the next turn_end boundary of a running session and continues the run", async () => {
    const f = await foldSetup(99_000);
    try {
      assert.ok(estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW);
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry);
      assert.deepEqual(f.api.queueFold(f.sm.getSessionId(), FOLD), {
        ok: true,
      });
      assert.equal(
        registry.calls.length,
        0,
        "nothing runs before the boundary",
      );

      const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));

      assert.equal(result.continue, true);
      assertFolded(f);
      assertNoSummaryTurn(f, registry.calls);
      assert.equal(
        f.pi.sendMessageCalls.length,
        0,
        "the receipt is a boundary entry",
      );
      const [done] = result.entries.filter(
        (d) => d.customType === REWIND_CUSTOM_TYPE,
      );
      assert.equal(done.details.status, "done");
      assert.equal(f.sm.getLeafId(), receiptsOf(f.sm).at(-1)?.id);
      assert.equal(await guardAborts(f, ctx), false, "the next request fits");

      const again = await fireTurnEndAll(
        f.pi,
        ctx,
        assistantMessage([], "stop", 0),
      );
      assert.deepEqual(again.entries, [], "the fold ran once");
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("preserves the open user request outside an omitting summary at the queued boundary", async () => {
    const f = await foldSetup(40_000);
    try {
      const text =
        "Rewind now, then reply ACCEPTANCE-CONTINUED-unique-73.\n  Keep these bytes.\n";
      const sourceEntryId = f.sm.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 100,
      });
      f.sm.appendCustomMessageEntry("new-notification", "audit finished", true);
      const registry = fakeRegistry(() => reply(SUMMARY_TEXT));
      assert.ok(!SUMMARY_TEXT.includes("ACCEPTANCE-CONTINUED-unique-73"));
      const ctx = foldCtx(f, registry.registry);
      assert.deepEqual(
        f.api.queueFold(f.sm.getSessionId(), { ...FOLD, origin: "agent" }),
        { ok: true },
      );
      const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
      assert.equal(result.continue, true);
      const done = result.entries.find(
        (d) => d.customType === REWIND_CUSTOM_TYPE,
      );
      assert.ok(done);
      assert.ok(String(done.content).includes(text), JSON.stringify(done));
      assert.ok(String(done.content).includes(sourceEntryId));
      assert.match(
        String(done.content),
        /rewind is completed; do not repeat it/i,
      );
      assert.match(String(done.content), /fulfill the remaining request/i);
      assert.deepEqual(done.details.openUserRequests, [
        { sourceEntryId, text },
      ]);
      const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
      assert.ok(summary?.type === "branch_summary");
      assert.ok(!summary.summary.includes(text));
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("replays the captured system head in context (Strategy A) when the request is admitted", async () => {
    const f = await foldSetup(40_000);
    try {
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry);
      assert.equal(await guardAborts(f, ctx), false);
      const liveMessages = __testHooks.buildContextMessages(f.sm).length;

      const outcome = await f.api.runFoldNow(ctx as never, FOLD);

      assert.equal(outcome.status, "done", JSON.stringify(outcome));
      if (outcome.status !== "done") return;
      assert.equal(outcome.strategy, "in-context");
      assert.equal(registry.calls.length, 1);
      const { messages } = registry.calls[0].context;
      assert.equal(messages[0], SYSTEM_MESSAGE);
      const last = messages.at(-1);
      assert.equal(last?.role, "user");
      assert.match(
        JSON.stringify(last),
        /^\{"role":"user","content":\[\{"type":"text","text":"\[navigate_tree\]/,
      );
      assert.equal(messages.length, 1 + liveMessages + 1);
      assert.match(
        JSON.stringify(last),
        /messages 3 onwards/,
        "the system head is not numbered; the anchor ends message 2",
      );
      assertFolded(f);
      assertNoSummaryTurn(f, registry.calls);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("chunks the evidence (Strategy B) without a captured system head, and after a session start", async () => {
    for (const captured of [false, true]) {
      const f = await foldSetup(40_000);
      try {
        const registry = fakeRegistry();
        const ctx = foldCtx(f, registry.registry);
        if (captured) {
          await guardAborts(f, ctx);
          await runSessionStart(f.pi, f.ctx, f.fixture, "resume");
        }
        const outcome = await f.api.runFoldNow(ctx as never, FOLD);
        assert.equal(outcome.status, "done", JSON.stringify(outcome));
        if (outcome.status !== "done") return;
        assert.equal(outcome.strategy, "chunked");
        assert.ok(outcome.calls >= 2, "a map call and the reduce");
        assertFolded(f);
        assertNoSummaryTurn(f, registry.calls);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
  });

  it("leaves the history exactly as found when the provider fails, on both paths", async () => {
    const failing = () => fakeRegistry(() => reply("", "error", "overloaded"));
    {
      const f = await foldSetup(99_000);
      try {
        const registry = failing();
        const before = snapshotOf(f.sm);
        const outcome = await f.api.runFoldNow(
          foldCtx(f, registry.registry) as never,
          FOLD,
        );
        assert.equal(outcome.status, "failed");
        if (outcome.status !== "failed") return;
        assert.equal(outcome.stage, "summary");
        assert.equal(outcome.reason, "provider-error");
        assert.deepEqual(snapshotOf(f.sm), before);
        assert.equal(f.pi.sendMessageCalls.length, 0);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    const f = await foldSetup(99_000);
    try {
      const registry = failing();
      const ctx = foldCtx(f, registry.registry);
      const before = snapshotOf(f.sm);
      f.api.queueFold(f.sm.getSessionId(), { ...FOLD, origin: "agent" });
      const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
      assert.equal(
        result.continue,
        true,
        "the model that asked hears about it",
      );
      const [receipt] = result.entries;
      assert.equal(receipt.details.status, "failed");
      assert.equal(receipt.details.stage, "summary");
      assert.equal(receipt.details.reason, "provider-error");
      assert.match(receipt.content, /Nothing was collapsed/);
      const after = snapshotOf(f.sm);
      assert.deepEqual(
        after.entries.slice(0, before.entries.length),
        before.entries,
      );
      assert.equal(
        after.entries.length,
        before.entries.length + 1,
        "only the receipt was added",
      );
      assert.equal(
        f.sm.getBranch().some((e) => e.type === "branch_summary"),
        false,
      );
      assert.equal(f.sm.getLabel(f.leafId), undefined);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("cancels before the commit and leaves the history as found", async () => {
    {
      const f = await foldSetup(99_000);
      try {
        const controller = new AbortController();
        const registry = fakeRegistry(() => {
          controller.abort();
          return reply("", "aborted");
        });
        const before = snapshotOf(f.sm);
        const outcome = await f.api.runFoldNow(
          foldCtx(f, registry.registry) as never,
          FOLD,
          { signal: controller.signal },
        );
        assert.equal(outcome.status, "cancelled");
        assert.deepEqual(snapshotOf(f.sm), before);
        assert.equal(f.pi.sendMessageCalls.length, 0);
      } finally {
        cleanupConfigFixture(f.fixture);
      }
    }
    // Esc during the run: the queued fold is cancelled at the boundary, with no side call.
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry();
      const controller = new AbortController();
      controller.abort();
      const ctx = foldCtx(f, registry.registry, { signal: controller.signal });
      const before = snapshotOf(f.sm);
      f.api.queueFold(f.sm.getSessionId(), FOLD);
      const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
      assert.equal(registry.calls.length, 0);
      const [receipt] = result.entries;
      assert.equal(receipt.details.status, "failed");
      assert.equal(receipt.details.reason, "cancelled");
      assert.deepEqual(
        snapshotOf(f.sm).entries.slice(0, before.entries.length),
        before.entries,
      );
      assert.equal(
        f.sm.getBranch().some((e) => e.type === "branch_summary"),
        false,
      );
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("re-appends input that arrives during the summary instead of folding it away", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry((_call, index) => {
        if (index === 0) {
          f.sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: "late steer" }],
            timestamp: Date.now(),
          } as never);
        }
        return reply(SUMMARY_TEXT);
      });
      const outcome = await f.api.runFoldNow(
        foldCtx(f, registry.registry) as never,
        FOLD,
      );
      assert.equal(outcome.status, "done", JSON.stringify(outcome));
      if (outcome.status !== "done") return;
      assert.equal(outcome.commit.reappended, 1);
      const tail = f.sm.getBranch().slice(-4);
      assert.deepEqual(
        tail.map((e) => e.type),
        ["branch_summary", "label", "message", "custom_message"],
      );
      assert.match(JSON.stringify(tail[2]), /late steer/);
      assert.ok(
        JSON.stringify(tail[3]).includes(
          JSON.stringify(buildLateEntriesNote(1)).slice(1, -1),
        ),
        "the continuation names the late message as unanswered",
      );
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("refuses a missing or pre-compaction anchor before any side call", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry);
      const before = snapshotOf(f.sm);
      const outcome = await f.api.runFoldNow(ctx as never, {
        ...FOLD,
        rewindTo: "nowhere",
      });
      assert.equal(outcome.status, "failed");
      if (outcome.status !== "failed") return;
      assert.equal(outcome.stage, "gate");
      assert.match(outcome.detail, /no label 'nowhere' on the active branch/);
      assert.equal(registry.calls.length, 0);
      assert.deepEqual(snapshotOf(f.sm), before);
    } finally {
      cleanupConfigFixture(f.fixture);
    }

    const g = setup({ contextWindow: WINDOW });
    const early = appendTurn(g.sm, "u1", "a1", 0);
    g.pi.pi.setLabel(early.assistantId, "anchor:early");
    for (const n of [2, 3, 4]) appendTurn(g.sm, `u${n}`, `a${n}`, 0, true);
    const cut = appendTurn(g.sm, "u5", "a5", 0, true);
    g.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
    g.sm.appendCompaction("Compacted summary", cut.userId, 0);
    appendTurn(g.sm, "u6", "a6", 0, true);
    const registry = fakeRegistry();
    const before = snapshotOf(g.sm);
    const outcome = await __testHooks
      .foldApi(g.pi.pi)
      ?.runFoldNow(foldCtx(g, registry.registry) as never, {
        ...FOLD,
        rewindTo: "before-cut",
      });
    assert.equal(outcome?.status, "failed");
    if (outcome?.status !== "failed") return;
    assert.match(outcome.detail, /lies before the latest compaction/);
    assert.equal(registry.calls.length, 0);
    assert.deepEqual(snapshotOf(g.sm), before);
  });

  it("serializes folds per session", async () => {
    const f = await foldSetup(99_000);
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const registry = fakeRegistry(async (_call, index) => {
        if (index === 0) await gate;
        return reply(SUMMARY_TEXT);
      });
      const ctx = foldCtx(f, registry.registry);
      const sessionId = f.sm.getSessionId();
      const first = f.api.runFoldNow(ctx as never, FOLD);
      assert.deepEqual(
        await f.api.runFoldNow(ctx as never, { ...FOLD, newLabel: "other" }),
        {
          status: "busy",
        },
      );
      assert.deepEqual(f.api.queueFold(sessionId, FOLD), {
        ok: false,
        reason: "a fold is already queued or running for this session",
      });
      release();
      assert.equal((await first).status, "done");
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("recommends the newest valid anchor inside the hint budget, else the oldest", () => {
    const candidates = [
      { name: "old", valid: true, projectedAfterTokens: 40 },
      { name: "mid", valid: true, projectedAfterTokens: 70 },
      { name: "new", valid: true, projectedAfterTokens: 90 },
    ];
    assert.equal(foldRecommendationBudget(100, null), 75);
    assert.equal(
      recommendFoldIndex(candidates, foldRecommendationBudget(100, 20)),
      1,
    );
    assert.equal(
      recommendFoldIndex(candidates, foldRecommendationBudget(100, null)),
      1,
    );
    assert.equal(
      recommendFoldIndex(candidates, foldRecommendationBudget(100, 50)),
      0,
    );
    assert.equal(
      recommendFoldIndex(candidates, foldRecommendationBudget(100, 70)),
      0,
    );
  });

  const PLAN_WIDTH = 120;
  const planTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  interface PlanScreen {
    handleInput(data: string): void;
    render(width: number): string[];
  }

  async function shown(screen: PlanScreen, includes: string): Promise<string> {
    for (let i = 0; i < 80; i++) {
      const text = screen.render(PLAN_WIDTH).join("\n");
      if (text.includes(includes)) return text;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `screen never showed ${JSON.stringify(includes)}\n${screen.render(PLAN_WIDTH).join("\n")}`,
    );
  }

  async function driveAnchor(
    f: FoldFixture,
    ctx: ReturnType<typeof foldCtx>,
    args: string,
    scripts: Array<(screen: PlanScreen) => Promise<void>>,
  ) {
    const pending = [...scripts];
    const command = f.pi.commands.get("anchor");
    assert.ok(command);
    await command.handler(args, {
      ...ctx,
      hasUI: true,
      ui: {
        ...ctx.ui,
        notify(message: string, type?: "info" | "warning" | "error") {
          ctx.notifyCalls.push([message, type]);
        },
        custom(factory: (...factoryArgs: unknown[]) => PlanScreen) {
          const script = pending.shift();
          assert.ok(script, "unexpected extra screen");
          return new Promise((resolve, reject) => {
            const screen = factory(
              {
                terminal: { rows: 40, columns: PLAN_WIDTH },
                requestRender() {},
              },
              planTheme,
              undefined,
              resolve,
            );
            screen.render(PLAN_WIDTH);
            script(screen).catch(reject);
          });
        },
      },
    } as never);
    assert.equal(pending.length, 0);
  }

  function assertCommandFolded(f: FoldFixture, label = "start-folded") {
    const summary = f.sm.getBranch().find((e) => e.type === "branch_summary");
    assert.ok(summary, "a branch_summary is on the active branch");
    assert.equal(summary.parentId, f.anchorId);
    assert.equal(f.sm.getLabel(f.leafId), `branch:${label}`);
    assert.equal(f.sm.getLabel(summary.id), `anchor:${label}`);
    assert.ok(!f.sm.getBranch().some((e) => e.id === f.leafId));
  }

  it("folds an idle session from /anchor fold without a user message, even when the guard would refuse", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry);
      assert.ok(estimateAdmissionTokens(f.sm) + GUARD_RESERVE > WINDOW);
      await driveAnchor(f, ctx, "fold", [
        async (screen) => {
          assert.match(screen.render(PLAN_WIDTH).join("\n"), /chunked/);
          screen.handleInput("\r");
          await shown(screen, "folded as");
          screen.handleInput("\r");
        },
      ]);
      assertCommandFolded(f);
      assertNoSummaryTurn(f, registry.calls);
      assert.match(
        JSON.stringify(registry.calls.at(-1)?.context.messages.at(-1)),
        /Latest request: u6/,
      );
      assert.equal(await guardAborts(f, ctx), false);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("queues /anchor fold while the agent is working and does not branch before the boundary", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry();
      const ctx = foldCtx(f, registry.registry, { isIdle: () => false });
      const before = snapshotOf(f.sm);
      await driveAnchor(f, ctx, "fold", [
        async (screen) => {
          assert.match(screen.render(PLAN_WIDTH).join("\n"), /agent working/);
          screen.handleInput("\r");
          await shown(screen, "queued");
          screen.handleInput("\r");
        },
      ]);
      assert.equal(registry.calls.length, 0);
      assert.equal(f.pi.sendUserMessageCalls.length, 0);
      assert.deepEqual(snapshotOf(f.sm), before);
      const result = await fireTurnEndAll(f.pi, ctx, leafMessage(f));
      assert.equal(result.continue, true);
      assertCommandFolded(f);
      assertNoSummaryTurn(f, registry.calls);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("cancels /anchor fold before the commit and keeps the branch", async () => {
    const f = await foldSetup(99_000);
    try {
      const registry = fakeRegistry(
        (call) =>
          new Promise((resolve) => {
            const signal = call.options.signal;
            const finish = () => resolve(reply("", "aborted"));
            if (!signal || signal.aborted) finish();
            else signal.addEventListener("abort", finish, { once: true });
          }),
      );
      const ctx = foldCtx(f, registry.registry);
      const before = snapshotOf(f.sm);
      await driveAnchor(f, ctx, "fold", [
        async (screen) => {
          screen.handleInput("\r");
          for (let i = 0; i < 50 && registry.calls.length === 0; i++)
            await new Promise((resolve) => setImmediate(resolve));
          assert.ok(registry.calls.length > 0, "the sidecar call started");
          screen.handleInput("\x1b");
          await shown(screen, "cancelled");
          screen.handleInput("\r");
          await shown(screen, "chunked");
          screen.handleInput("\x1b");
        },
      ]);
      assert.deepEqual(snapshotOf(f.sm), before);
      assert.equal(
        f.sm.getBranch().some((e) => e.type === "branch_summary"),
        false,
      );
      assert.equal(f.pi.sendUserMessageCalls.length, 0);
      assert.equal(f.pi.sendMessageCalls.length, 0);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });

  it("refuses a pre-compaction anchor on the plan with the preview reason", async () => {
    const g = setup({ contextWindow: WINDOW });
    (g.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
    const early = appendTurn(g.sm, "u1", "a1", 0);
    g.pi.pi.setLabel(early.assistantId, "anchor:early");
    for (const n of [2, 3, 4]) appendTurn(g.sm, `u${n}`, `a${n}`, 0, true);
    const cut = appendTurn(g.sm, "u5", "a5", 0, true);
    g.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
    g.sm.appendCompaction("Compacted summary", cut.userId, 0);
    appendTurn(g.sm, "u6", "a6", 0, true);
    const before = snapshotOf(g.sm);
    const ctx = foldCtx(g, fakeRegistry().registry);
    await driveAnchor(g as FoldFixture, ctx, "fold", [
      async (screen) => {
        screen.handleInput("\x1b[A");
        const text = screen.render(PLAN_WIDTH).join("\n");
        assert.match(text, /before-cut/);
        assert.match(text, /not foldable/);
        assert.match(text, /lies before the latest compaction/);
        screen.handleInput("\x1b");
      },
    ]);
    assert.deepEqual(snapshotOf(g.sm), before);
    assert.equal(g.pi.sendUserMessageCalls.length, 0);
  });

  for (const mode of ["full", "digest"] as const) {
    it(`prices a ${mode} child handoff as the commit materializes it`, async () => {
      const f = setup({ contextWindow: 1_000_000 });
      (f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
      const root = appendTurn(f.sm, "u1 keep the parser", "a1", 6_000);
      f.pi.pi.setLabel(root.assistantId, "anchor:start");
      for (const n of [2, 3, 4, 5])
        appendTurn(f.sm, `u${n}`, `a${n}`, 12_000, true);
      const marker = "CHILD-HANDOFF-MARKER";
      const childLeaf = f.sm.getLeafId();
      assert.ok(childLeaf);
      f.sm.branchWithSummary(
        childLeaf,
        `${SUMMARY_TEXT}\n${marker} ${"evidence ".repeat(4_000)}`,
        {},
        true,
      );
      for (const n of [6, 7, 8])
        appendTurn(f.sm, `u${n}`, `a${n}`, 20_000, true);
      const model = {
        provider: "claude",
        id: "claude-sonnet-4-5",
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      };
      const focus =
        "Continue the parser work that is still open on this branch.";
      assert.equal(
        foldPlaceholderSummary(foldSummaryPlaceholderTokens(model.maxTokens))
          .length,
        DEFAULT_REDUCE_OUTPUT_TOKENS * 4,
      );
      assert.equal(foldSummaryPlaceholderTokens(100), 100);
      const prices = priceFoldCandidates(f.sm, {
        model,
        handoffMode: mode,
        focus,
        suggestLabel: (name) =>
          name === "start" ? "parent" : `${name}-folded`,
      });
      const start = prices.find((price) => price.name === "start");
      assert.ok(start?.valid, start?.reason);
      if (!start?.valid) return;
      const leafId = f.sm.getLeafId();
      assert.ok(leafId);
      const preview = previewFoldCommit(f.sm, {
        targetId: start.targetId,
        rewindTo: "start",
        newLabel: start.suggestedLabel,
        summaryText: foldPlaceholderSummary(
          foldSummaryPlaceholderTokens(model.maxTokens),
        ),
        handoffMode: mode,
        contextWindow: model.contextWindow,
        foldPointId: leafId,
        continuationText: (afterTokens) =>
          buildRewindDoneText(
            {
              rewindTo: "start",
              newLabel: start.suggestedLabel,
              beforeTokens: start.beforeTokens,
              contextWindow: model.contextWindow,
            },
            afterTokens,
          ),
      });
      assert.ok(preview.ok, preview.ok ? "" : preview.reason);
      if (!preview.ok) return;
      assert.equal(start.projectedAfterTokens, preview.projectedAfterTokens);
      assert.equal(preview.materialized.includes(marker), mode === "full");
      if (mode === "digest")
        assert.match(preview.materialized, /Earlier handoffs in this span/);
      const anchorOnly =
        estimateRequestTokens(
          buildSessionContext(f.sm.getEntries(), start.targetId).messages,
        ) + Math.ceil(ANCHOR_MANDATE.length / 3.5);
      assert.notEqual(
        start.projectedAfterTokens,
        start.beforeTokens - anchorOnly,
      );
      assert.ok(start.projectedAfterTokens > anchorOnly);
      const outcome = await commitFold(f.sm, {
        targetId: start.targetId,
        rewindTo: "start",
        newLabel: start.suggestedLabel,
        summaryText: foldPlaceholderSummary(
          foldSummaryPlaceholderTokens(model.maxTokens),
        ),
        handoffMode: mode,
        contextWindow: model.contextWindow,
        foldPointId: leafId,
        branchLabelEntryId: leafId,
        continuationText: (afterTokens) =>
          buildRewindDoneText(
            {
              rewindTo: "start",
              newLabel: start.suggestedLabel,
              beforeTokens: start.beforeTokens,
              contextWindow: model.contextWindow,
            },
            afterTokens,
          ),
        writeLabel: (entryId, label) => {
          f.sm.appendLabelChange(entryId, label);
          return true;
        },
      });
      assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
      if (!outcome.ok) return;
      const summary = f.sm.getEntry(outcome.summaryId);
      assert.ok(summary && summary.type === "branch_summary");
      assert.equal(summary.summary, preview.materialized);
      assert.deepEqual(summary.details, preview.details);
    });
  }

  it("preselects the anchor chosen with r in the list", async () => {
    const f = await foldSetup(40_000);
    try {
      const assistants = f.sm
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        );
      f.pi.pi.setLabel(assistants[2].id, "anchor:mid");
      const ctx = foldCtx(f, fakeRegistry().registry);
      await driveAnchor(f, ctx, "list", [
        async (screen) => {
          screen.handleInput("r");
        },
        async (screen) => {
          const text = screen.render(PLAN_WIDTH).join("\n");
          assert.match(text, /rewind to start/);
          assert.doesNotMatch(text, /rewind to mid/);
          screen.handleInput("\x1b");
        },
        async (screen) => {
          screen.handleInput("\x1b");
        },
      ]);
      assert.equal(f.pi.sendUserMessageCalls.length, 0);
    } finally {
      cleanupConfigFixture(f.fixture);
    }
  });
});
