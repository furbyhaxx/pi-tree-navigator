/**
 * TUI rows for the `navigate_tree` tool call and result, and for the
 * continuity-ops ledger entry.
 *
 * Collapsed rows are exactly one line, truncated to the width and never
 * wrapped; expanded rows wrap and add detail. Every input comes from the
 * model or the session file, so field access is guarded: a renderer that throws
 * breaks the row it paints.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatPct1, formatWindow, TOOL_NAME } from "../core/helpers.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** One printable line: control characters and whitespace runs become one space. */
const oneLine = (value: unknown): string =>
	typeof value === "string" ? value.replace(/[\p{Cc}\s]+/gu, " ").trim() : "";

/** Printable lines of a block of text; tabs expand to the 3 cells pi-tui measures. */
const textLines = (text: string): string[] =>
	text.split(/\r\n|\r|\n/).map((line) => line.replace(/\t/g, "   ").replace(/\p{Cc}/gu, " "));

/** Plain lines, truncated (collapsed) or wrapped (expanded) to the width. */
class Lines implements Component {
	private readonly lines: readonly string[];
	private readonly wrap: boolean;
	private readonly pad: number;

	constructor(lines: readonly string[], wrap: boolean, pad = 0) {
		this.lines = lines;
		this.wrap = wrap;
		this.pad = pad;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const left = " ".repeat(Math.min(this.pad, width - 1));
		const inner = Math.max(1, width - 2 * this.pad);
		const out: string[] = [];
		for (const line of this.lines) {
			const pieces = this.wrap
				? wrapTextWithAnsi(line, inner)
				: [truncateToWidth(line, inner, "…")];
			for (const piece of pieces) {
				out.push(truncateToWidth(left + piece, width, ""));
			}
		}
		return out;
	}

	invalidate(): void {}
}

const join = (...parts: string[]): string => parts.filter(Boolean).join(" ");

/** `renderCall`: `anchor <name>`, `rewind <from> → <to>`, `list`, `pin <kind>: <text or path>`. */
export function renderToolCall(args: unknown, theme: Theme, expanded: boolean): Component {
	const a = isRecord(args) ? args : {};
	const title = (word: string) => theme.fg("toolTitle", theme.bold(word));
	const arg = (text: string) => (text ? theme.fg("accent", text) : "");
	const field = (key: string) => oneLine(a[key]);
	const extra: string[] = [];
	const note = (label: string, value: string) => {
		if (value) extra.push(theme.fg("muted", `  ${label}: ${value}`));
	};
	let head: string;
	switch (a["action"]) {
		case "anchor":
			head = join(title("anchor"), arg(field("name")));
			break;
		case "rewind": {
			const from = field("rewindTo");
			const to = field("newLabel");
			head =
				from || to
					? join(title("rewind"), arg(from || "…"), to ? `${theme.fg("dim", "→")} ${arg(to)}` : "")
					: title("rewind");
			note("focus", field("summaryFocus"));
			break;
		}
		case "list":
			head = title("list");
			break;
		case "pin": {
			const kind = field("kind");
			const path = field("path");
			const lines = field("lines");
			const file = path ? path + (lines ? `:${lines}` : "") : "";
			const body = kind === "file" ? file || field("text") : field("text") || file;
			head = join(
				title("pin"),
				kind ? arg(kind) + (body ? theme.fg("dim", ":") : "") : "",
				body ? theme.fg("toolOutput", body) : "",
			);
			note("why", field("why"));
			note("scope", field("scopeAnchor"));
			break;
		}
		default:
			head = join(title(TOOL_NAME), arg(field("action")));
	}
	return expanded ? new Lines([head, ...extra], true) : new Lines([head], false);
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) =>
			isRecord(block) && block["type"] === "text" && typeof block["text"] === "string"
				? [block["text"]]
				: [],
		)
		.join("\n");
}

const firstLine = (text: string): string =>
	textLines(text)
		.map((line) => line.trim())
		.find(Boolean) ?? "";

/** The collapsed row of a successful result, or undefined when `details` has no known shape. */
function summarize(details: Record<string, unknown>, text: string): string | undefined {
	if (details["status"] === "queued") return "accepted · folding after this turn";
	if (details["status"] === "summary-requested") return "accepted · summarizing";
	const id = oneLine(details["id"]);
	if (id && typeof details["effect"] === "string") {
		return details["effect"] === "duplicate"
			? `already recorded as ${id}`
			: join(id, oneLine(details["kind"]), "recorded");
	}
	const { count, contextTokens: tokens } = details;
	if (isCount(count)) {
		const window = isCount(details["contextWindow"]) ? details["contextWindow"] : 0;
		const ctx = isCount(tokens)
			? ` · ctx ${formatPct1(tokens, window)}${window > 0 ? ` of ${formatWindow(window)}` : ""}`
			: "";
		return `${count} label${count === 1 ? "" : "s"}${ctx}`;
	}
	if (typeof details["label"] === "string" && isCount(tokens)) {
		// The tool text carries the window-relative position; details only the tokens.
		const set = /\] set at (.+?)(?: \(after:.*)?$/.exec(firstLine(text));
		return `set at ${set?.[1] ?? formatPct1(tokens, 0)}`;
	}
	return undefined;
}

/** `renderResult`: one summary row; expanded, the full text the model received. */
export function renderToolResult(
	result: unknown,
	options: { readonly expanded: boolean },
	theme: Theme,
	isError: boolean,
): Component {
	const r = isRecord(result) ? result : {};
	const details = isRecord(r["details"]) ? r["details"] : {};
	const text = contentText(r["content"]);
	const failed = isError || details["refusal"] === true;
	const paint = (line: string) => theme.fg(failed ? "error" : "toolOutput", line);
	if (options.expanded && text.trim()) {
		return new Lines(textLines(text).map(paint), true);
	}
	const row = failed ? firstLine(text) : (summarize(details, text) ?? firstLine(text));
	return new Lines(row ? [paint(row)] : [], false);
}

interface OpView {
	readonly short: string;
	readonly detail: readonly string[];
}

const filePointer = (value: unknown): string => {
	if (!isRecord(value)) return "";
	const path = oneLine(value["path"]);
	const lines = oneLine(value["lines"]);
	return path && lines ? `${path}:${lines}` : path;
};

/** Marks ops the user did not author; user words carry no marker. */
const originMark = (origin: unknown): string =>
	origin === "agent" || origin === "classifier" ? `(${origin})` : "";

function itemView(
	sign: string,
	item: Record<string, unknown>,
	mark: string,
	replaces: string,
): OpView {
	const kind = oneLine(item["kind"]);
	const file = filePointer(item["file"]);
	const text = oneLine(item["text"]);
	const quote = oneLine(item["quote"]);
	const body = text || file || quote;
	const shown = !text && file ? file : body && `"${body}"`;
	const why = isRecord(item["file"]) ? oneLine(item["file"]["why"]) : "";
	const scope = oneLine(item["scopeAnchor"]);
	const detail: string[] = [];
	if (quote && quote !== body) detail.push(`said "${quote}"`);
	if (why) detail.push(`why: ${why}`);
	if (scope) detail.push(`anchor: ${scope}`);
	if (replaces) detail.push(`replaces ${replaces}`);
	return { short: join(`${sign}${kind}${mark}`, shown), detail };
}

function describeOp(stored: Record<string, unknown>): OpView {
	const op = isRecord(stored["op"]) ? stored["op"] : {};
	const mark = originMark(isRecord(stored["ctx"]) ? stored["ctx"]["origin"] : undefined);
	const id = oneLine(op["id"]);
	switch (op["op"]) {
		case "add":
			return itemView("+", op, mark, "");
		case "supersede": {
			const ids = Array.isArray(op["ids"]) ? op["ids"].map(oneLine).filter(Boolean) : [];
			return itemView("~", isRecord(op["with"]) ? op["with"] : {}, mark, ids.join(", "));
		}
		case "update": {
			const view = itemView("~", op, mark, "");
			return { ...view, short: view.short.replace(/^~/, `~${id}`) };
		}
		case "archive":
			return { short: `-${id}${mark}`, detail: [] };
		case "complete":
			return { short: `done ${id}${mark}`, detail: [] };
		case "markStale":
			return { short: `stale ${id}${mark}`, detail: [] };
		default:
			return { short: join(oneLine(op["op"]), id) + mark, detail: [] };
	}
}

/** Ops of a `navigate-tree-continuity-ops` entry; unusable `data` or items yield none. */
function storedOps(data: unknown): Record<string, unknown>[] {
	if (!isRecord(data) || !Array.isArray(data["ops"])) return [];
	return data["ops"].filter(
		(stored): stored is Record<string, unknown> =>
			isRecord(stored) && isRecord(stored["op"]) && typeof stored["op"]["op"] === "string",
	);
}

const SEPARATOR = " · ";

/** Prefix plus as many items as fit, then `+N more`; the first item is cut when none fits. */
function fitRow(prefix: string, items: readonly string[], width: number): string {
	const more = (n: number) => (n > 0 ? `${SEPARATOR}+${n} more` : "");
	let row = prefix;
	let shown = 0;
	for (const [index, item] of items.entries()) {
		const next = row + SEPARATOR + item;
		if (visibleWidth(next) + visibleWidth(more(items.length - index - 1)) > width) break;
		row = next;
		shown++;
	}
	if (shown === 0) {
		const tail = more(items.length - 1);
		const room = width - visibleWidth(prefix + SEPARATOR) - visibleWidth(tail);
		row =
			room >= 8
				? prefix + SEPARATOR + truncateToWidth(items[0] ?? "", room, "…") + tail
				: prefix + SEPARATOR + (items[0] ?? "");
	} else {
		row += more(items.length - shown);
	}
	return truncateToWidth(row, width, "…");
}

/** The ledger entry row; the host adds no padding around entry rows, so it pads one cell itself. */
class LedgerRow implements Component {
	private readonly views: readonly OpView[];
	private readonly theme: Theme;
	private readonly expanded: boolean;

	constructor(views: readonly OpView[], theme: Theme, expanded: boolean) {
		this.views = views;
		this.theme = theme;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const dim = (line: string) => this.theme.fg("dim", line);
		if (this.expanded) {
			const lines = [
				dim(`ledger${SEPARATOR}${this.views.length} op${this.views.length === 1 ? "" : "s"}`),
				...this.views.flatMap(({ short, detail }) => [
					dim(short),
					...detail.map((line) => dim(`  ${line}`)),
				]),
			];
			return new Lines(lines, true, 1).render(width);
		}
		const inner = Math.max(1, width - 2);
		const row = fitRow(
			"ledger",
			this.views.map(({ short }) => short),
			inner,
		);
		return new Lines([dim(row)], false, 1).render(width);
	}

	invalidate(): void {}
}

/** Entry renderer of the continuity-ops entry; watermark-only or malformed entries render nothing. */
export function renderContinuityOps(
	entry: { readonly data?: unknown },
	options: { readonly expanded: boolean },
	theme: Theme,
): Component | undefined {
	const views = storedOps(entry.data).map(describeOp);
	return views.length === 0 ? undefined : new LedgerRow(views, theme, options.expanded);
}
