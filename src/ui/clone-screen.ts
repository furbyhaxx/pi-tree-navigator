/**
 * Text screens of the `/anchor clone` flow: a `FrameList` of plain lines that
 * re-wraps to the terminal width, with the raw shortcut opening the raw JSON in the editor.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	Component,
	Focusable,
	KeyId,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { FrameList, type FrameListOptions } from "./frame.ts";

/** Columns the frame spends on the cursor before each row's text. */
const ROW_PREFIX = 3;

/** One screen of text; `lines` is asked again whenever the width changes. */
export interface LinesScreen {
	breadcrumbs: readonly string[];
	rightBadge?: string;
	enterAction: string;
	cancelAction: string;
	shortcuts?: readonly { key: KeyId; action: string }[] | undefined;
	lines(width: number): readonly string[];
}

/** The unabridged data behind a screen, reachable with the raw shortcut. */
export interface RawJson {
	title: string;
	value: unknown;
}

const RAW_KEY: KeyId = "j";

/** Rebuilds the list for the new width on resize; the cursor row is kept. */
class LinesView implements Component, Focusable {
	private list!: FrameList;
	private width = -1;
	private hasFocus = false;
	private readonly screen: LinesScreen;
	private readonly host: Pick<FrameListOptions, "tui" | "theme" | "keyboard">;
	private readonly done: (key: string | undefined) => void;

	constructor(
		screen: LinesScreen,
		host: Pick<FrameListOptions, "tui" | "theme" | "keyboard">,
		done: (key: string | undefined) => void,
	) {
		this.screen = screen;
		this.host = host;
		this.done = done;
		this.open(host.tui.terminal.columns);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.list.focused = value;
	}

	private open(width: number): void {
		this.list = new FrameList({
			...this.host,
			breadcrumbs: this.screen.breadcrumbs,
			rightBadge: this.screen.rightBadge,
			enterAction: this.screen.enterAction,
			cancelAction: this.screen.cancelAction,
			rows: this.screen.lines(Math.max(1, width - ROW_PREFIX)).map((label) => ({ label })),
			cursor: this.width < 0 ? 0 : this.list.cursor,
			query: this.width < 0 ? undefined : this.list.search,
			onSelect: () => this.done("enter"),
			onCancel: () => this.done(undefined),
			shortcuts: this.screen.shortcuts?.map((shortcut) => ({
				...shortcut,
				onPress: () => this.done(shortcut.key),
			})),
		});
		this.list.focused = this.hasFocus;
		this.width = width;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		if (width !== this.width) this.open(width);
		return this.list.render(width);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.list.handleMouse(event);
	}
}

function showLines(ctx: ExtensionCommandContext, screen: LinesScreen): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, keyboard, done) => new LinesView(screen, { tui, theme, keyboard }, done),
	);
}

/**
 * Show a text screen until the user leaves it. Resolves with `"enter"`, the key
 * of a shortcut, or undefined for Escape. With `raw`, the raw shortcut opens the JSON in the
 * editor (read-only use) and returns to the screen.
 */
export async function showView(
	ctx: ExtensionCommandContext,
	screen: LinesScreen,
	raw?: RawJson,
): Promise<string | undefined> {
	const shortcuts = raw
		? [...(screen.shortcuts ?? []), { key: RAW_KEY, action: "raw JSON" }]
		: screen.shortcuts;
	while (true) {
		const key = await showLines(ctx, { ...screen, shortcuts });
		if (!raw || key !== RAW_KEY) return key;
		await ctx.ui.editor(raw.title, JSON.stringify(raw.value, null, 2));
	}
}
