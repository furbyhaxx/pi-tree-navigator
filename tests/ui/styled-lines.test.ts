/** Identity clipping preserves ANSI, wide characters and the context percentage. */
import { describe, expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { contextBadgeText, middleTruncate } from "../../src/ui/styled-lines.ts";

describe("middleTruncate", () => {
	it("keeps both ends of styled wide labels within budget", () => {
		const text = "\x1b[36m◆ 界界-milestone-folded\x1b[39m";
		const clipped = middleTruncate(text, 16);
		expect(visibleWidth(clipped)).toBeLessThanOrEqual(16);
		expect(stripTerminalSequences(clipped)).toStartWith("◆ 界");
		expect(stripTerminalSequences(clipped)).toEndWith("folded");
		expect(middleTruncate("abc", 3)).toBe("abc");
		expect(stripTerminalSequences(middleTruncate("abc", 1))).toBe("…");
		expect(middleTruncate("abc", 0)).toBe("");
	});
});

describe("contextBadgeText", () => {
	it("drops the window, then counts, then shortens ctx before losing the percentage", () => {
		const badge = "2 anchors · ctx 0.4% of 1.0M";
		expect(contextBadgeText(badge, 80)).toBe(badge);
		expect(contextBadgeText(badge, 20)).toBe("2 anchors · ctx 0.4%");
		expect(contextBadgeText(badge, 8)).toBe("ctx 0.4%");
		expect(contextBadgeText(badge, 6)).toBe("c 0.4%");
		expect(contextBadgeText(badge, 4)).toBe("0.4%");
		expect(stripTerminalSequences(contextBadgeText("other status", 6))).toBe("other…");
	});
});
