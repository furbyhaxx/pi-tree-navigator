/** Scripted fold plan context, dialogs and engine calls shared by UI tests. */
import * as assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import type { FoldSummaryProgress } from "../../src/fold/fold-summarizer.ts";
import {
	type FoldPlan,
	type FoldPlanCandidate,
	type FoldPlanDeps,
	type FoldPlanResult,
	openFoldPlanScreen,
} from "../../src/ui/fold-plan-screen.ts";

export const ENTER = "\r";
export const ESC = "\x1b";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
const MIN_FOCUS = 20;
export const MODEL = "openai/gpt-6-luna:low";

export const candidate = (
	name: string,
	extra: Partial<FoldPlanCandidate> = {},
): FoldPlanCandidate => ({
	name,
	valid: true,
	beforeTokens: 90_000,
	projectedAfterTokens: 30_000,
	contextWindow: 372_000,
	strategy: "in-context",
	suggestedLabel: `${name}-folded`,
	...extra,
});

/** Root to leaf: the middle anchor is recommended, the leaf one frees too little. */
export const sampleCandidates = (): FoldPlanCandidate[] => [
	candidate("start", { auto: true, strategy: "chunked" }),
	candidate("impl-start", { afterPreview: "Implement the parser" }),
	candidate("recent", {
		valid: false,
		reason: "Would free only about 0.9k tok; a fold needs at least 4.0k.",
		projectedAfterTokens: 89_000,
	}),
];

/** Root to leaf: searching "parser" finds two anchors and ranks the older one first. */
export const searchCandidates = (): FoldPlanCandidate[] => [
	candidate("start", { auto: true }),
	candidate("parser-fix", { afterPreview: "Fix the parser" }),
	candidate("impl-start", { afterPreview: "Implement the parser" }),
	candidate("recent", {
		valid: false,
		reason: "Would free only about 0.9k tok.",
	}),
];

export const mouse = (overrides: Partial<TuiMouseEvent>): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 5,
	y: 3,
	screenX: 5,
	screenY: 3,
	width: 60,
	height: 20,
	shift: false,
	alt: false,
	ctrl: false,
	...overrides,
});

interface Screen {
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	render(width: number): string[];
}
type Script = (screen: Screen) => Promise<void>;

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const unwrapped = (text: string): string => text.replace(/\n\s+/g, " ");

export function harness(
	options: {
		candidates?: FoldPlanCandidate[];
		running?: boolean;
		recommended?: number | undefined;
		columns?: number;
		answers?: {
			inputs?: (string | undefined)[];
			editors?: (string | undefined)[];
		};
		onAbort?: FoldPlanResult;
		queue?: ReturnType<FoldPlanDeps["queue"]>;
	} = {},
) {
	const columns = options.columns ?? 60;
	const candidates = options.candidates ?? sampleCandidates();
	const notifications: { message: string; type: string | undefined }[] = [];
	const dialogs = {
		input: [] as [string, string | undefined][],
		editor: [] as [string, string | undefined][],
	};
	const inputs = [...(options.answers?.inputs ?? [])];
	const editors = [...(options.answers?.editors ?? [])];
	const scripts: Script[] = [];
	const heights: number[] = [];
	const calls = {
		start: [] as {
			plan: FoldPlan;
			signal: AbortSignal;
			onProgress(progress: FoldSummaryProgress): void;
		}[],
		queue: [] as FoldPlan[],
	};
	let release: (result: FoldPlanResult) => void = () => {};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => void notifications.push({ message, type }),
			async input(title: string, placeholder?: string) {
				dialogs.input.push([title, placeholder]);
				return inputs.shift();
			},
			async editor(title: string, prefill?: string) {
				dialogs.editor.push([title, prefill]);
				return editors.shift();
			},
			custom(factory: (...args: unknown[]) => Screen) {
				const script = scripts.shift();
				assert.ok(script, "unexpected extra screen");
				return new Promise((resolve, reject) => {
					let closed = false;
					const tui = {
						terminal: { rows: 40, columns },
						requestRender() {},
					};
					const screen = factory(tui, theme, undefined, (value: unknown) => {
						closed = true;
						resolve(value);
					});
					script(screen)
						.then(() => {
							if (!closed) reject(new Error("the script left the screen open"));
						})
						.catch(reject);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const deps: FoldPlanDeps = {
		candidates: () => [...candidates],
		recommend: () => ("recommended" in options ? options.recommended : 1),
		isAgentRunning: () => options.running ?? false,
		summaryModel: () => MODEL,
		minFocusLength: MIN_FOCUS,
		start(_ctx, plan, { signal, onProgress }) {
			calls.start.push({ plan, signal, onProgress });
			return new Promise((resolve) => {
				release = resolve;
				const aborted = options.onAbort;
				if (aborted) signal.addEventListener("abort", () => resolve(aborted));
			});
		},
		queue(_ctx, plan) {
			calls.queue.push(plan);
			return options.queue ?? { ok: true };
		},
	};
	/** Render, check the width budget and the frozen height, and return the text. */
	const view = (screen: Screen): string => {
		const lines = screen.render(columns);
		for (const line of lines) assert.ok(visibleWidth(line) <= columns, line);
		heights.push(lines.length);
		return lines.join("\n");
	};
	return {
		ctx,
		deps,
		calls,
		dialogs,
		notifications,
		heights,
		view,
		release: (result: FoldPlanResult) => release(result),
		run: (...screens: Script[]) => {
			scripts.push(...screens);
			return openFoldPlanScreen(ctx, deps);
		},
	};
}

export const done = (
	extra: Partial<Extract<FoldPlanResult, { status: "done" }>> = {},
): FoldPlanResult => ({
	status: "done",
	label: "impl-start-folded",
	beforeTokens: 90_000,
	afterTokens: 30_000,
	strategy: "in-context",
	calls: 1,
	...extra,
});
