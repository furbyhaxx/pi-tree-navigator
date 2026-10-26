/** Fake extension API, context and factory registration for integration tests. */
import * as assert from "node:assert/strict";
import {
	type ContextUsage,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import navigateTree from "../../src/index.ts";
import { fakeRegistry, type RegistryCall } from "./model-registry.ts";
import { usageOf } from "./session-messages.ts";

export interface CapturedTool {
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

export interface FakePi {
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
export interface BoundaryDraft {
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
export interface BoundaryResult {
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
export function makeFakePi(sm: SessionManager): FakePi {
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
		registerMessageRenderer(customType: string, renderer: (...args: never[]) => unknown) {
			messageRenderers.set(customType, renderer);
		},
		registerEntryRenderer(customType: string, renderer: (...args: never[]) => unknown) {
			entryRenderers.set(customType, renderer);
		},
		registerTool(tool: CapturedTool) {
			registered.push(tool);
		},
		registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
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

export interface FakeCtx {
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

export function makeCtx(
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
	const notifyCalls: Array<[string, "info" | "warning" | "error" | undefined]> = [];
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

/**
 * Register the navigate-tree tool against a fresh fake pi + SessionManager
 * and return the captured tool plus the helpers tests need.
 */
export function setup(opts: { contextWindow?: number; noModel?: boolean } = {}): {
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
	assert.ok(tool, "factory must register a tool");
	const ctx = makeCtx(sm, opts);
	return { sm, pi, ctx, tool };
}
