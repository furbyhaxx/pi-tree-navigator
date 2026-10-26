/** Extension pin action tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBriefing } from "../../src/continuity/continuity-briefing.ts";
import { LEDGER_DETAILS_KEY } from "../../src/continuity/continuity-ledger-model.ts";
import { parseLedger } from "../../src/continuity/continuity-ledger-parser.ts";
import {
	appendOpsEntry,
	CONTINUITY_OPS_CUSTOM_TYPE,
	readBranchLedger,
} from "../../src/continuity/continuity-store.ts";
import { TOOL_NAME } from "../../src/core/helpers.ts";
import {
	cleanupConfigFixture,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "../support/config-fixtures.ts";
import { setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { requestRewind, rewindMessages } from "../support/rewind-drivers.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
} from "../support/session-messages.ts";

installHarnessHooks();

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
		appendToolResult(f.sm, id, TOOL_NAME, result.content[0].text, result.details);
		return result;
	}

	const opsWritten = (f: Fixture) =>
		f.pi.appendEntryCalls.filter(([type]) => type === CONTINUITY_OPS_CUSTOM_TYPE);
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
		assert.equal(decision.pinned, undefined, "an agent pin is not user-protected");

		appendTurn(f.sm, "u3 keep going", "a3", 24_000, true);
		await requestRewind(f);
		const done = rewindMessages(f.pi).at(-1);
		assert.ok(done, "a continuation was delivered");
		const entry = f.sm.getEntry(done.message.details.summaryId as string);
		assert.ok(entry && entry.type === "branch_summary");
		const snapshot = parseLedger((entry.details as Record<string, unknown>)[LEDGER_DETAILS_KEY]);
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
		assert.match(unknown.content[0].text, /sub-goal, decision, fact, file, steering/);
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
			[{ kind: "file", path: "notes.md", why: "w", lines: "ten" }, /file\.lines must be N or N-M/],
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
			writeGlobalConfig(fixture, JSON.stringify({ continuity: { capture: false } }));
			const f = setup();
			anchored(f);
			await runSessionStart(f.pi, f.ctx, fixture);
			const result = await pin(f, { kind: "decision", text: "Use sqlite" });
			assert.equal(result.isError, true);
			assert.equal(result.details.refusal, true);
			assert.equal(result.content[0].text, "continuity ledger is disabled by config");
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
		assert.equal(again.content[0].text, "[pin] F2 already records this fact; nothing added.");
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
			(await f.tool.execute("tc-list", { action: "list" }, undefined, undefined, f.ctx)).content[0]
				.text;
		assert.ok(!(await text()).includes("continuity ledger"));
		await pin(f, { kind: "decision", text: "Use sqlite for the index" });
		await pin(f, { kind: "fact", text: "The parser is in src/parse.ts" });
		const { ledger } = readBranchLedger(f.sm.getBranch());
		const listed = await text();
		assert.ok(listed.endsWith(`\n\n${renderBriefing(ledger, { maxTokens: 500 }).text}`));
		assert.match(listed, /D1 \[agent\] Use sqlite for the index/);
		assert.match(listed, /F2 The parser is in src\/parse\.ts/);
	});
});

// =============================================================================
// Session continuity ledger: capture at turn_end
// =============================================================================
