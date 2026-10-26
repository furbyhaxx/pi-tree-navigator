/** Extension index tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import navigateTree from "../src/index.ts";
import { makeCtx, makeFakePi, setup } from "./support/extension-harness.ts";
import { installHarnessHooks } from "./support/harness-hooks.ts";

installHarnessHooks();

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
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
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
