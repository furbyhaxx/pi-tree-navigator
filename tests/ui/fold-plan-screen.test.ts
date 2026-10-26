/** Fold outcome mapping and headless confirmation entry points. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	type FoldPlanResult,
	foldPlanResult,
	runFoldWithoutUi,
} from "../../src/ui/fold-plan-screen.ts";
import { done, harness, tick } from "./fold-plan-screen-fixture.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

describe("foldPlanResult", () => {
	it("summarizes every outcome status for the screen", () => {
		const usage: never[] = [];
		const figures = { label: "l", beforeTokens: 9, afterTokens: 3 };
		assert.deepEqual(
			foldPlanResult(
				{
					status: "done",
					text: "s",
					strategy: "chunked",
					calls: 4,
					chunks: 3,
					usage,
					commit: { ok: true },
				},
				figures,
			),
			{ status: "done", ...figures, strategy: "chunked", calls: 4 },
		);
		assert.deepEqual(
			foldPlanResult(
				{
					status: "failed",
					stage: "gate",
					reason: "prepare",
					detail: "d",
					usage,
				},
				figures,
			),
			{ status: "failed", stage: "gate", reason: "prepare", detail: "d" },
		);
		assert.deepEqual(foldPlanResult({ status: "cancelled", usage }, figures), {
			status: "cancelled",
		});
		assert.deepEqual(foldPlanResult({ status: "busy" }, figures), {
			status: "busy",
		});
	});
});

describe("fold without a UI", () => {
	const headless = (options: Parameters<typeof harness>[0] = {}) => {
		const h = harness(options);
		return {
			...h,
			fold: async (args: string, result: FoldPlanResult = done()) => {
				const pending = runFoldWithoutUi(h.ctx, h.deps, args);
				await tick();
				h.release(result);
				await pending;
				return h.notifications.at(-1);
			},
		};
	};

	it("prints the plan newest first, with the recommendation and refusals, and folds nothing", async () => {
		const h = headless();
		await runFoldWithoutUi(h.ctx, h.deps, "");
		const text = required(h.notifications[0]).message;
		assert.match(text, /summary by openai\/gpt-6-luna:low/);
		assert.ok(text.indexOf("recent") < text.indexOf("impl-start"));
		assert.match(text, /◆ impl-start {2}−60\.0k tok · in-context · recommended/);
		assert.match(text, /◆ recent {2}not foldable: Would free only/);
		assert.match(text, /\/anchor fold <anchor\|recommended> \[new-label\]/);
		assert.equal(h.calls.start.length, 0);
		assert.equal(h.calls.queue.length, 0);
	});

	it("folds the recommended or a named anchor with the suggested or a given label", async () => {
		const h = headless();
		const first = await h.fold("recommended");
		assert.deepEqual(required(h.calls.start[0]).plan, {
			anchor: "impl-start",
			label: "impl-start-folded",
		});
		assert.match(first?.message ?? "", /✓ folded as 'impl-start-folded'/);
		assert.equal(first?.type, "info");

		await h.fold("start start-phase", done({ label: "start-phase" }));
		assert.deepEqual(required(h.calls.start[1]).plan, {
			anchor: "start",
			label: "start-phase",
		});
	});

	it("queues while the agent runs instead of folding now", async () => {
		const h = headless({ running: true });
		await runFoldWithoutUi(h.ctx, h.deps, "impl-start");
		assert.deepEqual(h.calls.queue, [{ anchor: "impl-start", label: "impl-start-folded" }]);
		assert.equal(h.calls.start.length, 0);
		assert.match(required(h.notifications[0]).message, /queued; it runs at the next turn boundary/);
	});

	it("refuses unknown, unfoldable and taken targets, bad labels and extra arguments without folding", async () => {
		for (const [args, expected] of [
			["missing", /No anchor 'missing' on the active branch/],
			["recent", /'recent' cannot be folded: Would free only/],
			["impl-start Bad_Label", /'Bad_Label' cannot be a label/],
			["impl-start start", /An anchor named 'start' already exists/],
			["impl-start label extra", /Too many arguments/],
		] as const) {
			const h = headless();
			await runFoldWithoutUi(h.ctx, h.deps, args);
			assert.equal(required(h.notifications[0]).type, "warning", args);
			assert.match(required(h.notifications[0]).message, expected, args);
			assert.equal(h.calls.start.length + h.calls.queue.length, 0, args);
		}
		const none = headless({ recommended: undefined });
		await runFoldWithoutUi(none.ctx, none.deps, "recommended");
		assert.match(
			required(none.notifications[0]).message,
			/No anchor fits the recommendation budget/,
		);
	});

	it("reports a failed fold as a warning", async () => {
		const h = headless();
		const last = await h.fold("impl-start", {
			status: "failed",
			stage: "summary",
			reason: "invalid-summary",
			detail: "map call ended with length",
		});
		assert.equal(last?.type, "warning");
		assert.match(last?.message ?? "", /failed at summary: map call ended with length/);
	});
});
