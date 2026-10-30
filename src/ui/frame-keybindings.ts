/** Focused frame key ownership and labels from the user's bindings. */

import type { Keybinding, KeybindingsConfig, KeybindingsManager } from "@earendil-works/pi-tui";

const claims = new WeakMap<KeybindingsManager, { count: number; restore(): void }>();

/** Temporarily route fullscreen paging, line and edge movement to the open panel. */
export function claimFramePageKeys(keys: KeybindingsManager | undefined): () => void {
	if (!keys) return () => {};
	let claim = claims.get(keys);
	if (!claim) {
		const getUserBindings = keys.getUserBindings;
		const setUserBindings = keys.setUserBindings;
		const getDescriptor = Object.getOwnPropertyDescriptor(keys, "getUserBindings");
		const setDescriptor = Object.getOwnPropertyDescriptor(keys, "setUserBindings");
		let saved = getUserBindings.call(keys);
		// Keep temporary masks out of read-modify-write settings updates.
		keys.getUserBindings = () => ({ ...saved });
		keys.setUserBindings = (bindings: KeybindingsConfig) => {
			saved = bindings;
			setUserBindings.call(keys, {
				...bindings,
				"tui.altScreen.pageUp": [],
				"tui.altScreen.pageDown": [],
				"tui.altScreen.lineUp": [],
				"tui.altScreen.lineDown": [],
				"tui.altScreen.top": [],
				"tui.altScreen.bottom": [],
			});
		};
		claim = {
			count: 0,
			restore() {
				if (getDescriptor) Object.defineProperty(keys, "getUserBindings", getDescriptor);
				else Reflect.deleteProperty(keys, "getUserBindings");
				if (setDescriptor) Object.defineProperty(keys, "setUserBindings", setDescriptor);
				else Reflect.deleteProperty(keys, "setUserBindings");
				setUserBindings.call(keys, saved);
			},
		};
		claims.set(keys, claim);
		keys.setUserBindings(saved);
	}
	claim.count++;
	let released = false;
	return () => {
		if (released || !claim) return;
		released = true;
		if (--claim.count === 0) {
			claims.delete(keys);
			claim.restore();
		}
	};
}

/** First unclaimed bound key in frame notation; no label when none remains. */
export function frameBindingLabel(
	keys: KeybindingsManager | undefined,
	id: Keybinding,
	fallback: string,
	claimed?: ReadonlySet<string>,
): string {
	if (!keys) return fallback;
	const key = keys.getKeys(id).find((candidate) => !claimed?.has(candidate));
	if (key === undefined) return "";
	const glyphs: Readonly<Record<string, string>> = {
		escape: "esc",
		up: "↑",
		down: "↓",
	};
	return glyphs[key] ?? key;
}
