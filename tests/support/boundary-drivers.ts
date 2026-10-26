/** Boundary event dispatch and draft commits matching Pi's extension runner. */
import * as assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BoundaryDraft, BoundaryResult, FakeCtx, FakePi } from "./extension-harness.ts";

/**
 * Commit boundary drafts the way pi's `_commitBoundaryDrafts` does: all or
 * nothing. pi previews the whole list (`runner.emitBoundary` →
 * `buildContext`), and a `context_edit` whose target is off the active
 * branch invalidates it, dropping every draft. Returns false when dropped.
 */
export function commitBoundaryDrafts(
	sm: SessionManager,
	drafts: readonly BoundaryDraft[],
): boolean {
	let onBranch: Set<string>;
	try {
		onBranch = new Set(sm.getBranch().map((e) => e.id));
	} catch {
		return false;
	}
	if (drafts.some((d) => d.type === "context_edit" && !onBranch.has(d.targetId ?? ""))) {
		return false;
	}
	for (const draft of drafts) {
		switch (draft.type) {
			case "custom_message":
				sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
				break;
			case "custom":
				sm.appendCustomEntry(draft.customType, draft.data);
				break;
			case "context_edit":
				sm.appendContextEdit(draft.targetId as string, (draft.replacement ?? null) as never);
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
export function resolveTurnEntries(
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
	const index = branch.findIndex((e) => e.type === "message" && (e.message as unknown) === message);
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
	const messageEntry = branch[index];
	assert.ok(messageEntry, "turn message must exist on the branch");
	return { messageEntryId: messageEntry.id, toolResults, toolResultEntryIds };
}

/**
 * Fold boundary handlers exactly as pi's `ExtensionRunner.emitBoundary`
 * does: every handler sees the running `{ entries, continue }`, and a result
 * carrying `entries` / `continue` replaces it. Then commit the drafts
 * all-or-nothing (pi's `_commitBoundaryDrafts`); an invalid list folds to
 * `{ entries: [], continue: false }` like pi's preview failure.
 */
export async function foldBoundary(
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
export async function fireTurnEndAll(
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
	const stopReason = (message as { stopReason?: string } | undefined)?.stopReason;
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
				stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed",
		},
		opts,
	);
	pi.boundaryResults.push(folded);
	return folded;
}

/** Fire every `agent_before_settle` handler (a boundary, folded + committed). */
export async function fireAgentBeforeSettle(
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
export async function fireAgentSettled(pi: FakePi, ctx: FakeCtx, aborted = false): Promise<void> {
	for (const handler of pi.onCalls.get("agent_settled") ?? []) {
		await handler({ type: "agent_settled", aborted } as never, ctx as never);
	}
}

/** Fire the `context` handler and return the messages it would send. */
export function fireContext(pi: FakePi, ctx: FakeCtx): Array<Record<string, unknown>> {
	const handlers = pi.onCalls.get("context");
	assert.ok(handlers, "factory must register a context handler");
	assert.equal(handlers.length, 1);
	const handler = handlers[0];
	assert.ok(handler, "factory must register a context handler");
	const result = handler({ type: "context", messages: [] } as never, ctx as never) as {
		messages: Array<Record<string, unknown>>;
	};
	return result.messages;
}

/** Fire the `tool_call` gate for a tool call in `ctx`'s session. */
export function fireToolCall(
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
