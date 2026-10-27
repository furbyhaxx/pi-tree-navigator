/**
 * `/anchor current`: browser and editor for the continuity ledger.
 *
 * The pure row and op builders turn ledger items into `FrameRow`s and `LedgerOp`s;
 * `openCurrentScreen` drives the list. The reducer (`applyOps`) is the only
 * mutator: this module never edits an item itself.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isVisible,
	renderBriefing,
	summarizeLedgerForUi,
} from "../continuity/continuity-briefing.ts";
import {
	type AppliedOp,
	type ItemKind,
	type ItemOrigin,
	isProtected,
	isUserOrigin,
	type Ledger,
	type LedgerItem,
	type LedgerOp,
	MAX_ITEM_TEXT_CHARS,
	type RejectedOp,
} from "../continuity/continuity-ledger-model.ts";
import { applyOps } from "../continuity/continuity-ledger-reducer.ts";
import {
	appendOpsEntry,
	readBranchLedger,
	userEntryIndexOf,
} from "../continuity/continuity-store.ts";
import {
	type FrameRow,
	type FrameScreen,
	frameShortcutKey,
	sanitizeTerminalText,
	selectFrame,
} from "./frame.ts";

/** Origins a user action writes with; both are user origins, so the items are protected. */
export type UserOpOrigin = Extract<ItemOrigin, "user" | "pin">;

export interface UserOpsResult {
	readonly applied: readonly AppliedOp[];
	readonly rejected: readonly RejectedOp[];
	/** One-line reason nothing was attempted; the ledger is read-only right now. */
	readonly refused?: string;
}

export type ApplyUserOps = (
	ctx: ExtensionCommandContext,
	ops: readonly LedgerOp[],
	origin: UserOpOrigin,
) => UserOpsResult;

/** Ledger access the screen needs; supplied by the extension entry point. */
export interface CurrentScreenDeps {
	readLedger(ctx: ExtensionCommandContext): Ledger | undefined;
	applyUserOps: ApplyUserOps;
}

const ADD_KINDS = ["rule", "decision", "sub-goal", "fact"] as const;
type AddKind = (typeof ADD_KINDS)[number];

export const LEDGER_BUSY_NOTICE =
	"The agent is working: the continuity ledger is read-only until it finishes.";
const LEDGER_OFF_NOTICE =
	"Continuity is off (continuity.capture is false in tree-navigator.json): the ledger is read-only. Set it to true to edit.";
const EMPTY_NOTICE = "No continuity items yet.";
const EMPTY_ROW_TEXT = `No continuity items yet. Say "from now on …" or press ${frameShortcutKey("a")} to add one.`;
const HEADLESS_BRIEFING_TOKENS = 8000;
const CONFIRM_TEXT_CHARS = 160;

const KIND_ORDER: readonly ItemKind[] = [
	"objective",
	"rule",
	"decision",
	"sub-goal",
	"steering",
	"fact",
	"file",
];
const LIVE: ReadonlySet<LedgerItem["status"]> = new Set(["active", "stale", "completed"]);

const oneLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;
const idNumber = (item: LedgerItem): number => Number(item.id.slice(1));

const isLive = (item: LedgerItem): boolean => LIVE.has(item.status);
const isGoal = (item: LedgerItem): boolean => item.kind === "objective" || item.kind === "sub-goal";

/** What the user can do with an item; the same predicates enable the keys and guard the ops. */
function itemActions(item: LedgerItem) {
	const live = isLive(item);
	return {
		retract: live,
		pin: live,
		complete: item.status === "active" && isGoal(item),
		edit: item.status === "active" && item.kind !== "file",
	};
}

/** Live items (active, stale, completed) in display order; history appends superseded and archived ones. */
export function currentItems(ledger: Ledger, showHistory: boolean): LedgerItem[] {
	const order = (a: LedgerItem, b: LedgerItem): number =>
		KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || idNumber(a) - idNumber(b);
	const live = ledger.items.filter(isLive).sort(order);
	const history = showHistory ? ledger.items.filter((item) => !isLive(item)).sort(order) : [];
	return [...live, ...history];
}

function markers(item: LedgerItem): string {
	const { origin } = item.source;
	return [
		!isLive(item) && "history",
		!isLive(item) && item.status,
		origin === "pin" ? "user" : origin,
		item.pinned && "pinned",
		item.status === "stale" && "stale",
		item.status === "completed" && "done",
		item.scopeAnchor !== undefined && `@${item.scopeAnchor}`,
	]
		.filter((part): part is string => typeof part === "string")
		.join(" · ");
}

function detailOf(item: LedgerItem): string | undefined {
	if (item.file) return `why: ${oneLine(item.file.why)}`;
	const quote = item.quote === undefined ? "" : oneLine(item.quote);
	return quote && quote !== oneLine(item.text) ? `said “${quote}”` : undefined;
}

function describe(item: LedgerItem): string {
	if (!isLive(item)) {
		return "History: shown for reference and read-only. Enter shows the full item; h hides history.";
	}
	const can = itemActions(item);
	const keys = [
		"x retracts it",
		can.edit && "e edits the text",
		can.complete && "c marks it done",
		`p ${item.pinned ? "unpins" : "pins"} it`,
	].filter((part): part is string => typeof part === "string");
	const authority = isProtected(item)
		? "Protected: the agent cannot change it."
		: "The agent can still change it.";
	return `${keys.join(", ")}. ${authority}`;
}

/** The row of one ledger item; no JSON, no control characters. */
export function currentRow(item: LedgerItem): FrameRow {
	const dead = !isLive(item);
	const done = item.status === "completed";
	const detail = detailOf(item);
	return {
		label: `${item.id} ${oneLine(item.text)}`,
		value: markers(item),
		tone: item.status === "stale" ? "warning" : dead || done ? "muted" : "text",
		...(detail !== undefined && { detail }),
		description: describe(item),
	};
}

const ADD_ROW: FrameRow = {
	label: "+ Add an item…",
	description:
		"Add a rule, decision, sub-goal or fact in your own words. It is pinned: the agent cannot change it.",
};

/** Item rows, or the single muted empty-state row when there are none; the add row is the screen's. */
export function currentRows(items: readonly LedgerItem[]): FrameRow[] {
	if (items.length > 0) return items.map(currentRow);
	return [
		{
			// labelHint is the one dim label text a FrameRow offers.
			label: "",
			labelHint: EMPTY_ROW_TEXT,
			tone: "muted",
			description: `Press ${frameShortcutKey("a")} to add a rule, decision, sub-goal or fact. Items here survive every fold.`,
		},
	];
}

/** `rev N · <counts>`: the revision stays visible when the badge is cut to a narrow rule. */
export function currentBadge(ledger: Ledger, showHistory: boolean): string {
	const { line, rev } = summarizeLedgerForUi(ledger);
	const counts = line.slice(0, line.length - ` · rev ${rev}`.length);
	return `rev ${rev} · ${counts}${showHistory ? " · +history" : ""}`;
}

/** Every field of an item as short lines, for the Enter view. */
function itemDetails(item: LedgerItem): string {
	const lines = [
		`${item.id} ${item.kind} · ${item.status}${item.pinned ? " · pinned" : ""}${isLive(item) && isProtected(item) ? " · protected" : ""}`,
		oneLine(item.text),
	];
	const quote = item.quote === undefined ? "" : oneLine(item.quote);
	if (quote && quote !== oneLine(item.text)) lines.push(`said: “${quote}”`);
	if (item.file) lines.push(`why: ${oneLine(item.file.why)}`);
	if (item.scopeAnchor !== undefined) lines.push(`anchor: ${item.scopeAnchor}`);
	const { entryId, origin } = item.source;
	lines.push(
		`source: ${origin}${entryId === undefined ? "" : ` (entry ${entryId})`}`,
		`created rev ${item.createdRev} · updated rev ${item.updatedRev}`,
	);
	if (item.supersedes?.length) lines.push(`supersedes: ${item.supersedes.join(", ")}`);
	if (item.supersededBy !== undefined) lines.push(`superseded by: ${item.supersededBy}`);
	return lines.join("\n");
}

/** The model-facing briefing for headless use, or a plain sentence when nothing is in force. */
export function briefingText(ledger: Ledger): string {
	return ledger.items.some(isVisible)
		? renderBriefing(ledger, { maxTokens: HEADLESS_BRIEFING_TOKENS }).text
		: EMPTY_NOTICE;
}

export const retractOp = (item: LedgerItem): LedgerOp => ({
	op: "archive",
	id: item.id,
});
export const completeOp = (item: LedgerItem): LedgerOp => ({
	op: "complete",
	id: item.id,
});
export const pinToggleOp = (item: LedgerItem): LedgerOp => ({
	op: item.pinned ? "unpin" : "pin",
	id: item.id,
});
/** The quote is left out, so the user's original words survive an edit. */
export const editOp = (item: LedgerItem, text: string): LedgerOp => ({
	op: "update",
	id: item.id,
	text,
});
export const addOp = (kind: AddKind, text: string): LedgerOp => ({
	op: "add",
	kind,
	text,
});

/**
 * The single write path: apply user-authored ops to the active branch's ledger and
 * persist what changed. Refuses while the agent is working (an entry must not land
 * inside an open tool batch) or when continuity is off.
 */
export function createUserOpsWriter(
	pi: Pick<ExtensionAPI, "appendEntry">,
	captureEnabled: () => boolean,
): ApplyUserOps {
	return (ctx, ops, origin) => {
		const refuse = (refused: string): UserOpsResult => ({
			applied: [],
			rejected: [],
			refused,
		});
		if (!ctx.isIdle()) return refuse(LEDGER_BUSY_NOTICE);
		if (!captureEnabled()) return refuse(LEDGER_OFF_NOTICE);
		const branch = ctx.sessionManager.getBranch();
		const { applied, rejected } = applyOps(readBranchLedger(branch).ledger, ops, {
			origin,
			userEntryIndex: userEntryIndexOf(branch),
		});
		appendOpsEntry(
			pi,
			applied
				.filter(({ effect }) => effect !== "duplicate")
				.map(({ op }) => ({ op, ctx: { origin } })),
		);
		return { applied, rejected };
	};
}

/** Run one op and report refusals and rejections; returns the outcome when the op was accepted. */
function runOp(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
	op: LedgerOp,
	origin: UserOpOrigin,
): AppliedOp | undefined {
	const result = deps.applyUserOps(ctx, [op], origin);
	if (result.refused !== undefined) {
		ctx.ui.notify(result.refused, "warning");
		return undefined;
	}
	for (const { reason } of result.rejected) {
		ctx.ui.notify(reason.message, "warning");
	}
	return result.applied[0];
}

/** False, with a notice, while the ledger is read-only; checked before any dialog. */
function writable(ctx: ExtensionCommandContext, deps: CurrentScreenDeps): boolean {
	if (!ctx.isIdle()) {
		ctx.ui.notify(LEDGER_BUSY_NOTICE, "warning");
		return false;
	}
	// An empty op list runs the writer's guards and persists nothing.
	const { refused } = deps.applyUserOps(ctx, [], "user");
	if (refused === undefined) return true;
	ctx.ui.notify(refused, "warning");
	return false;
}

async function retract(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
	item: LedgerItem,
): Promise<void> {
	if (!writable(ctx, deps)) return;
	const own = isUserOrigin(item.source.origin);
	const confirmed = await ctx.ui.confirm(
		`Retract ${item.id} (${item.kind})?`,
		`${item.id}: “${clip(oneLine(item.text), CONFIRM_TEXT_CHARS)}”\n` +
			`${own ? "Your own words. " : ""}The agent stops following it. It stays in the session history.`,
	);
	if (!confirmed) return;
	if (runOp(ctx, deps, retractOp(item), "user")) {
		ctx.ui.notify(`Retracted ${item.id}. It stays in the session history.`, "info");
	}
}

async function edit(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
	item: LedgerItem,
): Promise<void> {
	if (!writable(ctx, deps)) return;
	const input = await ctx.ui.editor(
		`Edit ${item.id} (${item.kind}); the original quote is kept`,
		item.text,
	);
	const text = input?.trim();
	if (!text || text === item.text) return;
	const applied = runOp(ctx, deps, editOp(item, text), "user");
	if (applied) {
		ctx.ui.notify(`Updated ${item.id}.${cutNote(applied, text)}`, "info");
	}
}

const cutNote = (applied: AppliedOp, text: string): string =>
	applied.item.text === text ? "" : ` Text cut to ${MAX_ITEM_TEXT_CHARS} characters.`;

/** Returns the new item's id so the list can put the cursor on it. */
async function add(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
): Promise<string | undefined> {
	if (!writable(ctx, deps)) return undefined;
	const choice = await ctx.ui.select("Add to the ledger: which kind?", [...ADD_KINDS]);
	const kind = ADD_KINDS.find((candidate) => candidate === choice);
	if (!kind) return undefined;
	const input = await ctx.ui.input(
		`New ${kind} (in your own words)`,
		"e.g. Always answer in German",
	);
	const text = input?.trim();
	if (!text) return undefined;
	const applied = runOp(ctx, deps, addOp(kind, text), "pin");
	if (!applied) return undefined;
	const { id } = applied.item;
	ctx.ui.notify(
		applied.effect === "duplicate"
			? `${id} already holds this ${kind}; nothing added.`
			: `Added ${id} (${kind}).${cutNote(applied, text)}`,
		"info",
	);
	return id;
}

function applyOne(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
	op: LedgerOp,
	message: string,
): void {
	if (!writable(ctx, deps)) return;
	if (runOp(ctx, deps, op, "user")) ctx.ui.notify(message, "info");
}

/** The list screen for a ledger; `focusId` puts the cursor on that item when it is shown. */
export function currentFrame(
	ledger: Ledger,
	view: { showHistory: boolean; cursor: number; focusId?: string },
): { items: LedgerItem[]; screen: FrameScreen } {
	const items = currentItems(ledger, view.showHistory);
	const focused = items.findIndex((item) => item.id === view.focusId);
	const can = (pick: keyof ReturnType<typeof itemActions>) => (_row: FrameRow, index: number) => {
		const item = items[index];
		return item !== undefined && itemActions(item)[pick];
	};
	return {
		items,
		screen: {
			breadcrumbs: ["Anchor", "Current"],
			rightBadge: currentBadge(ledger, view.showHistory),
			placeholder: "Filter by id, text, origin or marker…",
			enterAction: "open",
			rows: [...currentRows(items), ADD_ROW],
			cursor: focused >= 0 ? focused : view.cursor,
			shortcuts: [
				{ key: "x", action: "retract", enabled: can("retract") },
				{ key: "e", action: "edit", enabled: can("edit") },
				{
					key: "p",
					action: (_row, index) => (items[index]?.pinned ? "unpin" : "pin"),
					enabled: can("pin"),
				},
				{ key: "c", action: "done", enabled: can("complete") },
				{ key: "a", action: "add" },
				{ key: "h", action: "history" },
			],
		},
	};
}

/** Browse and edit the active branch's ledger until the user leaves. */
export async function openCurrentScreen(
	ctx: ExtensionCommandContext,
	deps: CurrentScreenDeps,
): Promise<void> {
	let cursor = 0;
	let showHistory = false;
	let focusId: string | undefined;
	while (true) {
		const ledger = deps.readLedger(ctx);
		if (!ledger) {
			ctx.ui.notify("The continuity ledger could not be read.", "warning");
			return;
		}
		const { items, screen } = currentFrame(ledger, {
			showHistory,
			cursor,
			...(focusId === undefined ? {} : { focusId }),
		});
		focusId = undefined;
		const choice = await selectFrame(ctx, screen);
		if (!choice) return;
		cursor = choice.index;
		const item = items[choice.index];
		const key = choice.key;

		if (key === "h") showHistory = !showHistory;
		else if (key === "a" || (!item && choice.index === screen.rows.length - 1)) {
			focusId = await add(ctx, deps);
		} else if (!item) continue;
		else if (key === "x") await retract(ctx, deps, item);
		else if (key === "e") await edit(ctx, deps, item);
		else if (key === "p") {
			applyOne(
				ctx,
				deps,
				pinToggleOp(item),
				item.pinned ? `Unpinned ${item.id}.` : `Pinned ${item.id}: the agent cannot change it.`,
			);
		} else if (key === "c") {
			applyOne(ctx, deps, completeOp(item), `Marked ${item.id} done.`);
		} else {
			ctx.ui.notify(itemDetails(item), "info");
		}
	}
}
