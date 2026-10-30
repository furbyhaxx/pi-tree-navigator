import { describe, expect, it } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { claimFramePageKeys } from "../../src/ui/frame-keybindings.ts";

describe("frame keyboard ownership", () => {
	it("routes page and line keys to the panel without exposing or persisting the temporary mask", () => {
		const keyboard = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.pageDown": "ctrl+d",
		});
		const original = keyboard.getUserBindings();
		const release = claimFramePageKeys(keyboard);
		const releaseNested = claimFramePageKeys(keyboard);
		expect(keyboard.getKeys("tui.altScreen.pageDown")).toEqual([]);
		expect(keyboard.getKeys("tui.altScreen.pageUp")).toEqual([]);
		expect(keyboard.getKeys("tui.altScreen.lineDown")).toEqual([]);
		expect(keyboard.getKeys("tui.altScreen.top")).toEqual([]);
		expect(keyboard.getKeys("tui.altScreen.bottom")).toEqual([]);
		expect(keyboard.getUserBindings()).toEqual(original);
		keyboard.setUserBindings({ ...keyboard.getUserBindings(), "tui.select.confirm": "ctrl+j" });
		release();
		release();
		expect(keyboard.getKeys("tui.altScreen.pageDown")).toEqual([]);
		releaseNested();
		expect(keyboard.getKeys("tui.altScreen.pageDown")).toEqual(["ctrl+d"]);
		expect(keyboard.getKeys("tui.altScreen.pageUp")).toEqual(["pageUp"]);
		expect(keyboard.getKeys("tui.select.confirm")).toEqual(["ctrl+j"]);
		keyboard.setUserBindings({ "tui.select.confirm": "enter" });
		expect(keyboard.getKeys("tui.altScreen.pageDown")).toEqual(["pageDown"]);
	});
});
