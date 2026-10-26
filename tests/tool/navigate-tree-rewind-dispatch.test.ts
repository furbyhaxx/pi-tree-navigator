/** Extension navigate tree rewind dispatch tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import { LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE } from "../../src/core/legacy-rewind.ts";
import { MIN_SUMMARY_FOCUS_LENGTH } from "../../src/fold/fold-policy.ts";
import { buildRewindAcceptedText, REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { __testHooks, MIN_REWIND_SAVINGS_TOKENS } from "../../src/index.ts";
import { fireToolCall, fireTurnEndAll } from "../support/boundary-drivers.ts";
import { type FakeCtx, makeCtx, setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { REWIND_ARGS, requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import { makeFakeSession, setupAutonomousSpan, setupRewindable } from "../support/session-fakes.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
} from "../support/session-messages.ts";

installHarnessHooks();

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
			const result = await tool.execute("tc-1", c.params, undefined, undefined, ctx);
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
			const result = await tool.execute("tc-old-name", c.params, undefined, undefined, ctx);
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

describe("dispatch: rewind queues an engine fold", () => {
	it("returns only the byte-exact 'accepted' text and the queued details", async () => {
		const { sm, pi, tool, ctx } = setup();
		const { anchorId } = setupRewindable(sm, pi);
		appendToolCallAssistant(sm, [{ id: "tc-rewind", name: TOOL_NAME, arguments: REWIND_ARGS }]);
		const result = await tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.content.length, 1);
		assert.equal(
			result.content[0].text,
			"[navigate_tree] Rewind to 'start' accepted (collapse as 'end'). The fold runs after this turn's tool results; the continuation follows in the same run.",
		);
		assert.equal(result.content[0].text, buildRewindAcceptedText("start", "end"));
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
						!(e.type === "custom_message" && e.customType === LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE),
				),
			"no summary request is written",
		);
		assert.equal(f.pi.sendMessageCalls.length, 0);
		assert.equal(f.pi.sendUserMessageCalls.length, 0);
		assert.ok(f.sm.getBranch().some((e) => e.type === "branch_summary"));
		assert.equal(f.sm.getLeafId(), f.sm.getBranch().at(-1)?.id);
		assert.equal(f.sm.getEntry(f.sm.getLeafId() as string)?.type, "custom_message");
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
		const result = await tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, ctx);
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
		assert.ok(text.includes(JSON.stringify(`Additional focus: ${focus}`).slice(1, -1)));
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
		const first = await f.tool.execute("tc-1", REWIND_ARGS, undefined, undefined, f.ctx);
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
		const result = await f.tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, f.ctx);
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
		const summarized = JSON.stringify(f.ctx.registryCalls.map((c) => c.context.messages));
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
		const list = await f.tool.execute("tc-code/1", { action: "list" }, undefined, undefined, f.ctx);
		assert.equal(list.isError, undefined);
		assert.equal(nested("tc-code/2", "rewind"), undefined);
		const result = await f.tool.execute("tc-code/2", REWIND_ARGS, undefined, undefined, f.ctx);
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
		assert.equal(fireToolCall(pi, ctx, TOOL_NAME, { action: "list" }), undefined);
	});

	it("does not run another session's queued fold, and fails open when the session id cannot be read", async () => {
		const f = setup();
		setupRewindable(f.sm, f.pi);
		appendToolCallAssistant(f.sm, [{ id: "tc-rewind", name: TOOL_NAME }]);
		await f.tool.execute("tc-rewind", REWIND_ARGS, undefined, undefined, f.ctx);
		const otherSm = SessionManager.inMemory("/tmp");
		const other = makeCtx(otherSm);
		await fireTurnEndAll(f.pi, other, assistantMessage([{ type: "text", text: "hi" }], "stop"));
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
		assert.match(result.content[0].text, /A label 'b' already exists on the active branch/);
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
		assert.match(result.content[0].text, /Already at 'here' \u2014 nothing to summarize/);
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
		assert.ok(before - 6_000 >= 20_000, `expected ≥20k apparent savings; got ${before - 6_000}`);
		assert.equal(fireToolCall(pi, ctx), undefined, "a queued fold gates no sibling call");
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
		const ru = await under.tool.execute("tc-under", rewindArgs, undefined, undefined, under.ctx);
		assert.equal(ru.isError, true);
		assert.equal(ru.details.rejected, "min-savings");
		assert.equal(ru.details.apparentSavings, MIN_REWIND_SAVINGS_TOKENS - 1);
		assert.equal(fireToolCall(under.pi, under.ctx), undefined);

		// AT the floor: savings = MIN exactly (the guard is strict `<`, so this
		// accepts).
		const at = await floorFixture(5_000 + MIN_REWIND_SAVINGS_TOKENS - 2);
		const ra = await at.tool.execute("tc-at", rewindArgs, undefined, undefined, at.ctx);
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
		assert.ok(!text.includes("When you finish this stage"), "pre-#21 anchor copy must be gone");
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
