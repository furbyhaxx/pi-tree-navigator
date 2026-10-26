/** Extension navigate tree tool tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MAX_ITEM_TEXT_CHARS } from "../../src/continuity/continuity-ledger-model.ts";
import { MAX_NAME_LENGTH } from "../../src/core/helpers.ts";
import { MIN_SUMMARY_FOCUS_LENGTH } from "../../src/fold/fold-policy.ts";
import { __testHooks } from "../../src/index.ts";
import { setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { rewindFixture } from "../support/rewind-fixtures.ts";
import { makeFakeSession } from "../support/session-fakes.ts";
import { appendTurn } from "../support/session-messages.ts";

function defined<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "Expected a defined test value");
	return value;
}

installHarnessHooks();

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
		const literals = (key: string) => defined(props[key]).anyOf?.map((l) => l.const);
		assert.deepEqual(literals("action"), ["anchor", "rewind", "list", "pin"]);
		assert.deepEqual(literals("kind"), ["sub-goal", "decision", "fact", "file", "steering"]);
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
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.ok("rewindTo" in props, "rewindTo must be a schema property");
		assert.ok("newLabel" in props, "newLabel must be a schema property");
		assert.ok(!(legacyRewindTo in props), `no legacy ${legacyRewindTo} alias in the schema`);
		assert.ok(!(legacyNewLabel in props), `no legacy ${legacyNewLabel} alias in the schema`);
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
		assert.match(defined(props["name"]).description ?? "", /Required when action='anchor'/);
		assert.match(defined(props["rewindTo"]).description ?? "", /Required when action='rewind'/);
		assert.match(defined(props["newLabel"]).description ?? "", /Required when action='rewind'/);
		assert.match(defined(props["summaryFocus"]).description ?? "", /Required when action='rewind'/);
		for (const key of ["kind", "text", "path", "why"]) {
			assert.match(
				defined(props[key]).description ?? "",
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
		assert.match(defined(props["name"]).description ?? "", new RegExp(`max ${MAX_NAME_LENGTH}`));
		assert.match(
			defined(props["summaryFocus"]).description ?? "",
			new RegExp(`\u2265${MIN_SUMMARY_FOCUS_LENGTH}`),
		);
		assert.match(
			defined(props["text"]).description ?? "",
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
		assert.equal(defined(props["action"]).description, "Which operation to perform.");
		assert.equal(
			defined(props["name"]).description,
			`Required when action='anchor'. Kebab-case milestone label, max ${MAX_NAME_LENGTH} chars.`,
		);
		assert.equal(
			defined(props["rewindTo"]).description,
			`Required when action='rewind'. Kebab-case name of an existing anchor on the active branch to rewind to.`,
		);
		assert.equal(
			defined(props["newLabel"]).description,
			`Required when action='rewind'. Kebab-case label for the resulting branch_summary entry; reusable as a future rewindTo.`,
		);
		assert.equal(
			defined(props["summaryFocus"]).description,
			`Required when action='rewind'; ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim. Encode: (1) the user's most recent instruction verbatim, (2) what's done in the collapsed segment, (3) what's left to do as a next action; if the user authorized continuing, name the next work item, not a report or wrap-up.`,
		);
		assert.equal(
			defined(props["kind"]).description,
			`Required when action='pin'. Your sub-goal, a decision you made, a key fact, a file pointer, or steering that lapses when its anchor is folded.`,
		);
		assert.equal(
			defined(props["text"]).description,
			`Required when action='pin' unless kind='file'. What to remember, max ${MAX_ITEM_TEXT_CHARS} chars.`,
		);
		assert.equal(
			defined(props["path"]).description,
			`Required when action='pin' and kind='file'. File path.`,
		);
		assert.equal(defined(props["lines"]).description, `Optional with kind='file': N or N-M.`);
		assert.equal(
			defined(props["why"]).description,
			`Required when action='pin' and kind='file'. Why the file matters.`,
		);
		assert.equal(
			defined(props["scopeAnchor"]).description,
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
			defined(props["action"]).description ?? "",
			defined(props["name"]).description ?? "",
			defined(props["rewindTo"]).description ?? "",
			defined(props["newLabel"]).description ?? "",
			defined(props["summaryFocus"]).description ?? "",
			defined(props["kind"]).description ?? "",
			defined(props["text"]).description ?? "",
			defined(props["path"]).description ?? "",
			defined(props["lines"]).description ?? "",
			defined(props["why"]).description ?? "",
			defined(props["scopeAnchor"]).description ?? "",
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

describe("dispatch: list action", () => {
	it("returns 'No labels' on an empty session", async () => {
		const { tool, ctx } = setup();
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.match(defined(result.content[0]).text, /No labels on the active branch\./);
		assert.equal(result.details["count"], 0);
	});

	it("renders anchored labels in chronological order", async () => {
		const { sm, pi, tool, ctx } = setup();
		const t1 = appendTurn(sm, "u1", "a1", 100);
		pi.pi.setLabel(t1.assistantId, "anchor:first");
		const t2 = appendTurn(sm, "u2", "a2", 200);
		pi.pi.setLabel(t2.assistantId, "anchor:second");

		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.details["count"], 2);
		const text = defined(result.content[0]).text;
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
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		const text = defined(result.content[0]).text;
		assert.match(text, /^\s+\d+\.\d+%\s+\S+/m);
	});

	it("renders the shared anchor table with an aligned (after:) column for a 40-char name (#101 D19)", async () => {
		const { sm, pi, tool, ctx } = setup();
		const long = "a".repeat(MAX_NAME_LENGTH);
		const t1 = appendTurn(sm, "u1", "first reply", 100);
		pi.pi.setLabel(t1.assistantId, "anchor:start");
		const t2 = appendTurn(sm, "u2", "second reply", 200);
		pi.pi.setLabel(t2.assistantId, `anchor:${long}`);
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		const body = defined(result.content[0]).text.split("\n\n")[1];
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
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		// Header includes context as 'Nk' fallback but no ' of 1.0M' tail.
		const header = defined(result.content[0]).text.split("\n")[0];
		assert.ok(header !== undefined);
		assert.ok(!header.includes(" of "), `header had ' of ': ${header}`);
	});

	it("includes the reflection-bootstrap warning when no captured session", async () => {
		// No __testHooks.captureSession() called \u2014 reflection finds nothing.
		const { tool, ctx } = setup();
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		assert.match(defined(result.content[0]).text, /reflection bootstrap missing/);
		assert.equal(result.details["reflectionOk"], false);
	});

	it("clears the reflection warning when the owning session is captured", async () => {
		const { sm, tool, ctx } = setup();
		const fake = makeFakeSession(sm);
		__testHooks.captureSession(fake as unknown as AgentSession);
		const result = await tool.execute("tc-1", { action: "list" }, undefined, undefined, ctx);
		assert.doesNotMatch(defined(result.content[0]).text, /reflection bootstrap missing/);
		assert.equal(result.details["reflectionOk"], true);
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
			const result = await tool.execute("tc-list", { action: "list" }, undefined, undefined, ctx);
			assert.ok(
				defined(result.content[0]).text.includes(listSentinel),
				"list output must include REFLECTION_BOOTSTRAP_WARNING_LIST verbatim",
			);
			assert.ok(
				!defined(result.content[0]).text.includes(rewindSentinel),
				"list output must NOT include the rewind-specific phrasing",
			);
		}

		// Rewind site: same conditions — the bootstrap-missing footer on the
		// continuation message (written once the fold lands) must
		// contain the rewind-specific constant verbatim, NOT the list one.
		{
			const { done } = await rewindFixture({ capture: false });
			assert.ok(done);
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
			assert.match(defined(result.content[0]).text, /kebab-case/);
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
		assert.match(defined(result.content[0]).text, /No session entries yet/);
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
		const labelCall = pi.setLabelCalls.find(([, lbl]) => lbl === "anchor:impl-start");
		assert.ok(labelCall, "setLabel was not called with anchor:impl-start");
		assert.equal(labelCall?.[0], t.assistantId);
		assert.equal(result.details["label"], "impl-start");
		assert.equal(result.details["entryId"], t.assistantId);
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
		(sm as { buildSessionContext: typeof sm.buildSessionContext }).buildSessionContext = (() => {
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
			(sm as { buildSessionContext: typeof sm.buildSessionContext }).buildSessionContext =
				origBuild;
		}

		assert.ok(thrown, "the estimate throw must propagate");
		assert.match(thrown instanceof Error ? thrown.message : String(thrown), /anchor estimate boom/);
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
		assert.match(defined(result.content[0]).text, /already exists on the active branch/);
		assert.match(defined(result.content[0]).text, /labels are unique/);
		assert.match(defined(result.content[0]).text, /action='list'/);
		assert.match(defined(result.content[0]).text, /fresh name/);
		assert.equal(result.details["refusal"], true);
		// No write at all: no set, no clear, and the prior label and the new
		// leaf are untouched.
		assert.equal(
			pi.setLabelCalls.length,
			setLabelCountBefore,
			"a refused anchor must not call setLabel",
		);
		assert.equal(sm.getLabel(t1.assistantId), "anchor:iter-start");
		assert.equal(sm.getLabel(t2.assistantId), undefined);
		assert.equal(result.details["movedFromPriorEntry"], undefined);
	});

	it("refusal copy names the colliding name and points at list + a fresh name", async () => {
		const { sm, pi, tool, ctx } = setup();
		appendTurn(sm, "u1", "a1");
		await tool.execute("tc-1", { action: "anchor", name: "phase1" }, undefined, undefined, ctx);
		appendTurn(sm, "u2", "a2");
		const result = await tool.execute(
			"tc-2",
			{ action: "anchor", name: "phase1" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.isError, true);
		const text = defined(result.content[0]).text;
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
		assert.match((result.content[0] as { text: string }).text, /rewindTo.*kebab-case/);
	});
});

// =============================================================================
// dispatch: rewind validation guards
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
			content: [{ type: "text", text: "Rewinding to 'start' would free only…" }],
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
		assert.equal(result.details["refusal"], true);
		assert.match(defined(result.content[0]).text, /summaryFocus/);
	});
});

// =============================================================================
// dispatch: rewind queues an independent fold
//
// The rewind tool call neither summarizes nor mutates anything: it validates,
// queues the fold and answers "accepted". The fold runs at the turn's
// `turn_end`, after every tool result of the turn is on the branch.
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
		assert.match(defined(result.content[0]).text, /No label 'missing'/);
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
		assert.match(defined(result.content[0]).text, /No label 'same'/);
	});
});

// =============================================================================
// rewind error branches
// =============================================================================
