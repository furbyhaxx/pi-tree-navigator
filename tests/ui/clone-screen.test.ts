import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showView } from "../../src/ui/clone-screen.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

interface Screen {
	handleInput(data: string): void;
	render(width: number): string[];
}

/** A context whose first screen is handed to `drive` once built. */
function context(drive: (screen: Screen) => void) {
	return {
		ui: {
			custom(factory: (...args: unknown[]) => Screen) {
				return new Promise((resolve) => {
					const tui = {
						terminal: { rows: 40, columns: 80 },
						requestRender() {},
					};
					drive(factory(tui, theme, undefined, resolve));
				});
			},
		},
	} as unknown as ExtensionCommandContext;
}

describe("text screen", () => {
	it("asks for lines again at the new width, less the cursor column, and keeps the cursor row", async () => {
		const asked: number[] = [];
		const ctx = context((screen) => {
			screen.render(80);
			screen.handleInput("\x1b[B");
			const narrow = screen.render(30);
			assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
			const marked = narrow.filter((line) => line.includes("→"));
			assert.equal(marked.length, 1);
			assert.ok(marked[0].includes("Second"));
			screen.handleInput("\x1b");
		});
		const key = await showView(ctx, {
			breadcrumbs: ["Anchor", "Clone", "Test"],
			enterAction: "close",
			cancelAction: "back",
			lines: (width) => {
				asked.push(width);
				return ["First", "Second"];
			},
		});
		assert.equal(key, undefined);
		assert.deepEqual(asked, [80 - 3, 30 - 3]);
	});

	it("resolves with the key of the shortcut or Enter that closed it", async () => {
		const screen = (keys: string) =>
			showView(
				context((view) => {
					view.render(80);
					view.handleInput(keys);
				}),
				{
					breadcrumbs: ["Test"],
					enterAction: "go",
					cancelAction: "back",
					shortcuts: [{ key: "e", action: "edit" }],
					lines: () => ["one line"],
				},
			);
		assert.equal(await screen("e"), "e");
		assert.equal(await screen("\r"), "enter");
	});
});
