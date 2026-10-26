/** Extension fold preview tests. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { buildSessionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { appendOpsEntry } from "../../src/continuity/continuity-store.ts";
import { estimateContentTokens, estimateRequestTokens } from "../../src/core/context-tokens.ts";
import { ANCHOR_MANDATE } from "../../src/core/request-accounting.ts";
import { commitFold, type FoldCommitInput } from "../../src/fold/fold-commit.ts";
import { type FoldPreviewInput, previewFoldCommit } from "../../src/fold/fold-preview.ts";
import { setup } from "../support/extension-harness.ts";
import { installHarnessHooks } from "../support/harness-hooks.ts";
import { SUMMARY_TEXT } from "../support/model-registry.ts";
import { appendTurn } from "../support/session-messages.ts";

installHarnessHooks();

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
		const steer = appendTurn(f.sm, "u2 look at the parser first", "a2", 0, true);
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
			estimateRequestTokens(buildSessionContext(f.sm.getEntries(), f.root.assistantId).messages) +
			Math.ceil(ANCHOR_MANDATE.length / 3.5);
		assert.ok(
			preview.projectedAfterTokens - anchorOnly >
				estimateContentTokens([userMessage(CHILD_EVIDENCE.repeat(3_200)) as never]),
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
		(f.sm as unknown as { buildSessionProjection: () => never }).buildSessionProjection = () => {
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
			for (const n of [2, 3, 4]) appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
			const cut = appendTurn(f.sm, "u5", "a5", usageOf(5), true);
			f.pi.pi.setLabel(cut.assistantId, "anchor:before-cut");
			const kept = appendTurn(f.sm, "u5k", "a5k", usageOf(5), true);
			f.sm.appendCompaction("Compacted summary", kept.userId, 0);
			for (const n of [6, 7]) appendTurn(f.sm, `u${n}`, `a${n}`, usageOf(n), true);
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
						buildSessionContext(f.sm.getEntries(), f.early.assistantId).messages,
					),
			);
		});

		it("refuses a target whose restored history the recorded usage prices low, naming the compaction", () => {
			const f = compacted((turn) => (turn <= 5 ? 6_000 : turn === 6 ? 20_000 : 30_000));
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
