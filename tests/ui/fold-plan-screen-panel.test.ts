/** Fold panel selection, progress, cancellation and frozen layout. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	candidate,
	DOWN,
	done,
	ENTER,
	ESC,
	harness,
	MODEL,
	mouse,
	searchCandidates,
	tick,
	UP,
	unwrapped,
} from "./fold-plan-screen-fixture.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

describe("fold plan screen", () => {
	it("starts the recommended anchor with its suggested label and shows the progress", async () => {
		const h = harness();
		const exit = await h.run(async (screen) => {
			const plan = h.view(screen);
			assert.match(plan, /Anchor\/Fold/);
			assert.match(plan, /2 of 3 foldable/);
			assert.match(plan, /rewind to impl-start/);
			assert.match(plan, /label impl-start-folded/);
			assert.match(plan, /~90\.0k → ~30\.0k tok of 372k \(8\.1%\)/);
			assert.match(plan, new RegExp(`in-context via ${MODEL}`));
			assert.match(plan, /focus: latest request and open work/);
			const rows = plan.split("\n");
			assert.ok(
				rows.findIndex((line) => line.includes("→ ◆ impl-start")) >
					rows.findIndex((line) => line.includes("◆ recent")),
				"newest anchor first, cursor on the recommended one",
			);
			assert.match(plan, /◆ impl-start\s+−60\.0k tok · recommended/);
			assert.match(plan, /after: “Implement the parser”/);

			screen.handleInput(ENTER);
			assert.deepEqual(
				h.calls.start.map(({ plan }) => plan),
				[{ anchor: "impl-start", label: "impl-start-folded" }],
			);
			assert.match(h.view(screen), /folding · preparing/);
			required(h.calls.start[0]).onProgress({ phase: "map", call: 2, plannedCalls: 5 });
			assert.match(h.view(screen), /folding · map · call 2\/5/);
			screen.handleInput(DOWN);
			assert.match(h.view(screen), /rewind to impl-start/, "no switching while folding");

			h.release(done());
			await tick();
			assert.match(
				unwrapped(h.view(screen)),
				/✓ folded as 'impl-start-folded' · freed ~60\.0k tok \(now ~30\.0k\) · in-context · 1 call/,
			);
			screen.handleInput(ENTER);
		});
		assert.equal(exit, "done");
		assert.equal(new Set(h.heights).size, 1, "the panel never changes height");
	});

	it("aborts the signal on Esc while folding and reports the cancellation", async () => {
		const h = harness({ onAbort: { status: "cancelled" } });
		const exit = await h.run(async (screen) => {
			screen.handleInput(ENTER);
			assert.equal(required(h.calls.start[0]).signal.aborted, false);
			screen.handleInput(ESC);
			assert.equal(required(h.calls.start[0]).signal.aborted, true);
			assert.match(h.view(screen), /cancelling the fold/);
			await tick();
			assert.match(h.view(screen), /cancelled — nothing was changed/);
			screen.handleInput(ESC);
		});
		assert.equal(exit, "back");
	});

	it("shows a failed fold's stage and detail, and a start that throws", async () => {
		const h = harness();
		const exit = await h.run(async (screen) => {
			screen.handleInput(ENTER);
			h.release({
				status: "failed",
				stage: "summary",
				reason: "provider-error",
				detail: "model returned 529",
			});
			await tick();
			const failed = h.view(screen);
			assert.match(failed, /✗ failed at summary: model returned 529/);
			assert.match(failed, /enter back to plan/);
			screen.handleInput(ENTER);
			const plan = h.view(screen);
			assert.match(plan, /✗ failed at summary: model returned 529/);
			assert.match(plan, /rewind to impl-start/);
			screen.handleInput(ENTER);
			assert.equal(h.calls.start.length, 2, "Enter on the plan retries");
			h.release(done());
			await tick();
			assert.match(unwrapped(h.view(screen)), /✓ folded as 'impl-start-folded'/);
			screen.handleInput(ENTER);
		});
		assert.equal(exit, "done");

		const thrown = harness();
		thrown.deps.start = async () => {
			throw new Error("socket closed");
		};
		await thrown.run(async (screen) => {
			screen.handleInput(ENTER);
			await tick();
			assert.match(thrown.view(screen), /✗ failed at gate: socket closed/);
			screen.handleInput(ESC);
		});
	});

	it("queues instead of starting while the agent runs, and says so", async () => {
		const h = harness({ running: true });
		const exit = await h.run(async (screen) => {
			const plan = h.view(screen);
			assert.match(plan, /agent working · folds at the next turn boundary/);
			assert.match(plan, /enter queue fold/);
			screen.handleInput(ENTER);
			assert.deepEqual(h.calls.queue, [{ anchor: "impl-start", label: "impl-start-folded" }]);
			assert.equal(h.calls.start.length, 0);
			assert.match(h.view(screen), /✓ queued — folds at the next turn boundary/);
			assert.doesNotMatch(h.view(screen), /folding/);
			screen.handleInput(ENTER);
		});
		assert.equal(exit, "done");
	});

	it("keeps the screen open with the reason when the queue refuses", async () => {
		const h = harness({
			running: true,
			queue: { ok: false, reason: "A fold is already queued." },
		});
		await h.run(async (screen) => {
			screen.handleInput(ENTER);
			assert.match(h.view(screen), /✗ A fold is already queued\./);
			screen.handleInput(ESC);
		});
	});

	it("does not fold an anchor that is not foldable and explains why", async () => {
		const h = harness();
		const exit = await h.run(async (screen) => {
			screen.handleInput(UP);
			const plan = h.view(screen);
			assert.match(plan, /→ ◆ recent\s+not foldable/);
			assert.match(plan, /✗ cannot fold to recent/);
			assert.match(plan, /Would free only about 0\.9k tok/);
			assert.doesNotMatch(plan, /enter fold/);
			screen.handleInput(ENTER);
			assert.match(h.view(screen), /✗ Would free only about 0\.9k tok/);
			screen.handleInput("\x1bi");
			assert.equal(h.dialogs.input.length, 0);
			screen.handleInput(ESC);
		});
		assert.equal(exit, "back");
		assert.equal(h.calls.start.length + h.calls.queue.length, 0);
	});

	it("falls back to the newest valid anchor without a recommendation", async () => {
		const h = harness({ recommended: undefined });
		await h.run(async (screen) => {
			assert.match(h.view(screen), /→ ◆ impl-start/);
			screen.handleInput(ESC);
		});
	});

	it("explains how to set an anchor when there are none", async () => {
		const h = harness({ candidates: [] });
		const exit = await h.run(async (screen) => {
			const plan = h.view(screen);
			assert.match(plan, /No anchors yet\./);
			assert.match(unwrapped(plan), /\/anchor list and press n/);
			screen.handleInput(ENTER);
			assert.match(h.view(screen), /no anchor to fold to/);
			screen.handleInput(ESC);
		});
		assert.equal(exit, "back");
		assert.equal(h.calls.start.length, 0);
	});

	it("filters anchors and previews; Esc clears the filter and keeps the chosen original anchor", async () => {
		const h = harness({ candidates: searchCandidates(), recommended: 0 });
		const exit = await h.run(async (screen) => {
			assert.match(h.view(screen), /Press \/ to search anchors and previews/);
			screen.handleInput("/");
			assert.match(h.view(screen), /type to filter/);
			assert.doesNotMatch(h.view(screen), /enter fold/);
			screen.handleInput("parser");
			const filtered = h.view(screen);
			const lines = filtered.split("\n");
			assert.ok(
				lines.findIndex((line) => line.includes("◆ parser-fix")) <
					lines.findIndex((line) => line.includes("◆ impl-start")),
				"the better match comes first although it is older",
			);
			assert.doesNotMatch(filtered, /◆ start|◆ recent/);
			assert.match(filtered, /→ ◆ parser-fix/);
			assert.match(filtered, /rewind to parser-fix/);

			screen.handleInput(ENTER);
			assert.equal(h.calls.start.length + h.calls.queue.length, 0);
			assert.match(unwrapped(h.view(screen)), /enter does not fold while searching/);

			screen.handleInput(ESC);
			const cleared = h.view(screen);
			assert.doesNotMatch(cleared, /does not fold while searching/);
			for (const name of ["recent", "impl-start", "parser-fix", "start"])
				assert.match(cleared, new RegExp(`◆ ${name}`));
			assert.match(cleared, /→ ◆ parser-fix/, "not the first row of the full list");
			assert.match(cleared, /enter fold/);

			screen.handleInput(ENTER);
			assert.deepEqual(
				h.calls.start.map(({ plan }) => plan),
				[{ anchor: "parser-fix", label: "parser-fix-folded" }],
			);
			h.release(done({ label: "parser-fix-folded" }));
			await tick();
			screen.handleInput(ENTER);
		});
		assert.equal(exit, "done");
		assert.equal(h.calls.start.length, 1);
	});

	it("leaves on the second Esc after clearing the filter", async () => {
		const h = harness({ candidates: searchCandidates() });
		const exit = await h.run(async (screen) => {
			screen.handleInput("/");
			screen.handleInput("zzz");
			assert.match(h.view(screen), /No matches for “\/zzz”/);
			assert.match(h.view(screen), /No plan: no anchor matches “\/zzz”/);
			screen.handleInput(ENTER);
			screen.handleInput(ESC);
			assert.doesNotMatch(h.view(screen), /No matches/);
			screen.handleInput(ESC);
		});
		assert.equal(exit, "back");
		assert.equal(h.calls.start.length + h.calls.queue.length, 0);
	});

	it("maps hover, the wheel and clicks onto the filtered rows below the plan rows and folds once", async () => {
		const h = harness({
			candidates: searchCandidates(),
			recommended: 0,
			onAbort: { status: "cancelled" },
		});
		const exit = await h.run(async (screen) => {
			const rowY = (text: string): number => {
				const y = h
					.view(screen)
					.split("\n")
					.findIndex((line) => line.includes(text));
				assert.ok(y > 0, `no row ${text}`);
				return y;
			};
			const click = (y: number, claimed = true): void => {
				for (const type of ["press", "release", "click"] as const) {
					const result = screen.handleMouse(mouse({ type, y }));
					if (type === "press") assert.equal(result?.handled ?? false, claimed);
					h.view(screen);
				}
			};
			screen.handleInput("/");
			screen.handleInput("parser");
			assert.ok(rowY("◆ impl-start") > 5, "the plan rows sit above the list");

			assert.equal(
				screen.handleMouse(mouse({ type: "move", button: "none", y: rowY("◆ impl-start") })),
				undefined,
			);
			assert.match(h.view(screen), /→ ◆ parser-fix/, "hover does not select");

			const wheel = (wheelDelta: number) =>
				screen.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta, y: 3 }));
			wheel(1);
			assert.match(h.view(screen), /→ ◆ impl-start/);
			wheel(-1);
			assert.match(h.view(screen), /→ ◆ parser-fix/);

			click(2, false);
			click(h.view(screen).split("\n").length + 4, false);
			assert.match(h.view(screen), /→ ◆ parser-fix/, "plan rows and the outside do nothing");
			assert.equal(h.calls.start.length, 0);

			click(rowY("◆ impl-start"));
			const picked = h.view(screen);
			assert.match(picked, /→ ◆ impl-start/);
			assert.match(picked, /rewind to impl-start/);
			assert.equal(h.calls.start.length, 0, "the first click only selects");

			click(1);
			assert.match(h.view(screen), /type to filter/);
			click(rowY("◆ impl-start"));
			assert.deepEqual(
				h.calls.start.map(({ plan }) => plan),
				[{ anchor: "impl-start", label: "impl-start-folded" }],
			);
			click(rowY("◆ parser-fix"), false);
			click(rowY("◆ impl-start"), false);
			assert.equal(wheel(1), undefined);
			screen.handleInput(ENTER);
			assert.equal(h.calls.start.length, 1, "a running fold is not started twice");

			screen.handleInput(ESC);
			assert.equal(required(h.calls.start[0]).signal.aborted, true);
			await tick();
			assert.match(h.view(screen), /cancelled — nothing was changed/);
			assert.equal(screen.handleMouse(mouse({ y: 5 })), undefined);
			screen.handleInput(ESC);
		});
		assert.equal(exit, "back");
		assert.equal(h.calls.queue.length, 0);
	});

	it("does not queue twice after a click queued the fold", async () => {
		const h = harness({
			candidates: searchCandidates(),
			recommended: 2,
			running: true,
		});
		const exit = await h.run(async (screen) => {
			const lines = h.view(screen).split("\n");
			const y = lines.findIndex((line) => line.includes("→ ◆ impl-start"));
			for (const type of ["press", "release", "click", "click"] as const)
				screen.handleMouse(mouse({ type, y }));
			assert.match(h.view(screen), /✓ queued/);
			for (const type of ["press", "release", "click"] as const)
				screen.handleMouse(mouse({ type, y }));
			screen.handleInput(ENTER);
		});
		assert.equal(exit, "done");
		assert.deepEqual(h.calls.queue, [{ anchor: "impl-start", label: "impl-start-folded" }]);
	});

	it("edits the anchor clicked in a filtered list and drops the filter", async () => {
		const h = harness({
			candidates: searchCandidates(),
			recommended: 0,
			answers: { inputs: ["Tidy Parser"], editors: [""] },
		});
		const exit = await h.run(
			async (screen) => {
				screen.handleInput("/");
				screen.handleInput("parser");
				const y = h
					.view(screen)
					.split("\n")
					.findIndex((line) => line.includes("◆ impl-start"));
				for (const type of ["press", "release", "click"] as const)
					screen.handleMouse(mouse({ type, y }));
				screen.handleInput("\x1bi");
			},
			async (screen) => {
				const view = h.view(screen);
				assert.match(view, /→ ◆ impl-start/);
				assert.match(view, /◆ recent/);
				assert.match(view, /label tidy-parser/);
				screen.handleInput(ENTER);
				h.release(done({ label: "tidy-parser" }));
				await tick();
				screen.handleInput(ENTER);
			},
		);
		assert.equal(exit, "done");
		assert.equal(required(required(h.dialogs.input[0])[1]), "impl-start-folded");
		assert.deepEqual(
			h.calls.start.map(({ plan }) => plan),
			[{ anchor: "impl-start", label: "tidy-parser" }],
		);
	});

	it("keeps the height and the width budget while filtering, clicking and folding", async () => {
		for (const columns of [60, 130]) {
			const h = harness({
				columns,
				candidates: searchCandidates(),
				recommended: 2,
			});
			await h.run(async (screen) => {
				h.view(screen);
				screen.handleInput("/");
				h.view(screen);
				screen.handleInput("parser");
				h.view(screen);
				screen.handleInput("zzz");
				h.view(screen);
				for (let n = 0; n < 3; n++) screen.handleInput("\x7f");
				h.view(screen);
				screen.handleInput(ENTER);
				h.view(screen);
				screen.handleInput(ESC);
				h.view(screen);
				screen.handleInput(ENTER);
				h.view(screen);
				required(h.calls.start[0]).onProgress({ phase: "map", call: 1, plannedCalls: 3 });
				h.view(screen);
				h.release(done());
				await tick();
				h.view(screen);
				screen.handleInput(ENTER);
			});
			assert.equal(new Set(h.heights).size, 1, `frozen height at ${columns}`);
		}
	});

	it("keeps every line within 60 and 130 columns, with long names, in every state", async () => {
		for (const columns of [60, 130]) {
			const long = "a-rather-long-milestone-name-for-a-phone";
			const h = harness({
				columns,
				candidates: [
					candidate(long, {
						afterPreview: "A long instruction that cannot possibly fit in one line",
						suggestedLabel: `${long}-and-a-longer-label`.slice(0, 40),
						strategy: "chunked",
						contextWindow: 1_048_576,
					}),
					candidate("before-the-compaction", {
						valid: false,
						reason: `${"The anchor precedes the latest compaction, so folding would restore compacted history. ".repeat(3)}`,
					}),
				],
				recommended: 0,
			});
			h.deps.summaryModel = () => "openrouter/some-vendor/a-very-long-model-name:high";
			await h.run(async (screen) => {
				h.view(screen);
				screen.handleInput(UP);
				h.view(screen);
				screen.handleInput(DOWN);
				screen.handleInput(ENTER);
				h.view(screen);
				required(h.calls.start[0]).onProgress({
					phase: "reduce",
					call: 12,
					plannedCalls: 12,
				});
				h.view(screen);
				h.release({
					status: "failed",
					stage: "commit",
					reason: "commit-refused",
					detail: "x".repeat(300),
				});
				await tick();
				h.view(screen);
				screen.handleInput(ESC);
			});
			assert.equal(new Set(h.heights).size, 1, `frozen height at ${columns}`);
		}
	});
});
