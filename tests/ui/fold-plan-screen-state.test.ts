/** Fold plan label and focus dialogs preserve edits across panel instances. */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	DOWN,
	done,
	ENTER,
	ESC,
	harness,
	sampleCandidates,
	tick,
	UP,
} from "./fold-plan-screen-fixture.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

describe("fold plan edits", () => {
	it("edits the label and the focus; the focus stays across anchors, the label does not", async () => {
		const focus = "Latest instruction: finish the parser; remaining: tests";
		const h = harness({
			answers: {
				inputs: ["My New Label!"],
				editors: ["too short", focus],
			},
		});
		const exit = await h.run(
			async (screen) => {
				screen.handleInput("\x1be");
			},
			async (screen) => {
				assert.match(h.view(screen), /label my-new-label/);
				assert.match(h.view(screen), /focus: “Latest instruction/);
				screen.handleInput(DOWN);
				const other = h.view(screen);
				assert.match(other, /rewind to start/);
				assert.match(other, /label start-folded/);
				assert.match(other, /focus: “Latest instruction/);
				screen.handleInput(UP);
				assert.match(h.view(screen), /label my-new-label/);
				screen.handleInput(ENTER);
				h.release(done({ label: "my-new-label" }));
				await tick();
				screen.handleInput(ENTER);
			},
		);
		assert.equal(exit, "done");
		assert.deepEqual(required(h.calls.start[0]).plan, {
			anchor: "impl-start",
			label: "my-new-label",
			focus,
		});
		assert.deepEqual(
			h.dialogs.editor.map(([, prefill]) => prefill),
			["", "too short"],
			"a too short focus reopens the editor with what was typed",
		);
		assert.equal(h.notifications.length, 1);
		assert.match(required(h.notifications[0]).message, /9 characters; it needs at least 20/);
	});

	it("refuses a label that is taken or not kebab-case, and an empty focus uses the default", async () => {
		const h = harness({
			answers: { inputs: ["start", "x".repeat(60), ""], editors: [""] },
		});
		h.deps.candidates = () => sampleCandidates();
		await h.run(
			async (screen) => screen.handleInput("\x1be"),
			async (screen) => {
				assert.match(h.view(screen), /label impl-start-folded/);
				assert.match(h.view(screen), /focus: latest request and open work/);
				screen.handleInput(ESC);
			},
		);
		assert.deepEqual(
			h.notifications.map(({ message }) => message.slice(0, 40)),
			["An anchor named 'start' already exists o", "'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
		);
	});
});
