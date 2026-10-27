/** ANSI-aware identity truncation and context badge degradation for panel chrome. */
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Preserve both ends of an identity, including suffixes that distinguish anchor names. */
export function middleTruncate(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return truncateToWidth(text, Math.max(0, width), "…");
	const head = Math.ceil((width - 1) / 3);
	const tail = width - head - 1;
	return `${truncateToWidth(text, head, "")}…${sliceByColumn(text, visibleWidth(text) - tail, tail)}`;
}

/** Drop secondary metrics before shortening the context meter's word or percentage. */
export function contextBadgeText(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const context = /\bctx (\d+(?:\.\d+)?%)/.exec(text);
	const percent = context?.[1];
	if (percent === undefined) return truncateToWidth(text, width, "…");
	const candidates = [text.replace(/ of [^ ·]+/, ""), `ctx ${percent}`, `c ${percent}`, percent];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? percent;
}
