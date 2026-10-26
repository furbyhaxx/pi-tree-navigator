/**
 * Ledger data contracts, authority predicates, limits and text normalization.
 * Stored on `branch_summary.details[LEDGER_DETAILS_KEY]`, the ledger follows the
 * active branch across /tree and fork. Capture and rendering live elsewhere.
 * No I/O and no pi runtime imports. Every update returns a new ledger.
 */

export const LEDGER_DETAILS_KEY = "continuity";
export const LEDGER_VERSION = 1;

// Caps are explicit: oversize text is truncated with a visible marker, and a
// full ledger rejects further additions instead of dropping anything.
export const MAX_ITEM_TEXT_CHARS = 500;
export const MAX_QUOTE_CHARS = 400;
export const MAX_PATH_CHARS = 512;
export const MAX_LEDGER_ITEMS = 200;
export const TRUNCATION_MARKER = "…[truncated]";

export const ITEM_KINDS = [
	"objective",
	"sub-goal",
	"rule",
	"decision",
	"steering",
	"fact",
	"file",
] as const;
export const ITEM_STATUSES = ["active", "completed", "superseded", "archived", "stale"] as const;
export const ITEM_ORIGINS = ["user", "ask_user", "pin", "agent", "classifier"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

export const ID_PREFIX: Readonly<Record<ItemKind, string>> = {
	objective: "G",
	"sub-goal": "S",
	rule: "R",
	decision: "D",
	steering: "T",
	fact: "F",
	file: "P",
};
export const ID_RE = /^[GSRDTFP][1-9]\d*$/;
export const LINES_RE = /^\d+(-\d+)?$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export const USER_ORIGINS: ReadonlySet<ItemOrigin> = new Set(["user", "ask_user", "pin"]);
const PROTECTED_KINDS: ReadonlySet<ItemKind> = new Set(["objective", "rule", "decision"]);

export type ContinuityErrorCode =
	| "invalid_ledger"
	| "unsupported_version"
	| "invalid_op"
	| "invalid_delta"
	| "unknown_item"
	| "protected_item"
	| "invalid_citation"
	| "wrong_kind"
	| "not_live"
	| "ledger_full";

/** Typed failure for parsing, validation and rejected ledger operations. */
export class ContinuityError extends Error {
	readonly code: ContinuityErrorCode;
	readonly itemId?: string;
	constructor(code: ContinuityErrorCode, message: string, itemId?: string) {
		super(message);
		this.name = "ContinuityError";
		this.code = code;
		if (itemId !== undefined) this.itemId = itemId;
	}
}

/** Pointer to a file the user or agent cares about; `sha256` enables staleness checks. */
export interface FilePointer {
	readonly path: string;
	/** `N` or `N-M`. */
	readonly lines?: string;
	readonly sha256?: string;
	readonly why: string;
}

export interface ItemSource {
	readonly entryId?: string;
	readonly origin: ItemOrigin;
}

export interface LedgerItem {
	readonly id: string;
	readonly kind: ItemKind;
	/** For `file` items this is derived: `path[:lines]`. */
	readonly text: string;
	readonly status: ItemStatus;
	readonly source: ItemSource;
	/** The user's exact words, capped. */
	readonly quote?: string;
	/** Anchor name; required for `steering`, optional for `sub-goal`. */
	readonly scopeAnchor?: string;
	readonly file?: FilePointer;
	readonly supersedes?: readonly string[];
	readonly supersededBy?: string;
	/** Set by a user-origin pin; protects any kind from agent/classifier ops. */
	readonly pinned?: true;
	readonly createdRev: number;
	readonly updatedRev: number;
}

export interface Ledger {
	readonly version: typeof LEDGER_VERSION;
	readonly rev: number;
	/** Monotonic id counter. Ids are never reused within a lineage. */
	readonly nextId: number;
	readonly items: readonly LedgerItem[];
}

/** Fields of an item to create. `text` is required except for `file` items, where it is derived. */
export interface NewItem {
	readonly kind: ItemKind;
	readonly text?: string;
	readonly quote?: string;
	readonly scopeAnchor?: string;
	readonly file?: FilePointer;
}

export type LedgerOp =
	| ({ readonly op: "add" } & NewItem)
	| {
			readonly op: "update";
			readonly id: string;
			readonly text?: string;
			readonly quote?: string;
			readonly file?: FilePointer;
	  }
	| {
			readonly op: "supersede";
			readonly ids: readonly string[];
			readonly with: NewItem;
			readonly citedEntryId?: string;
	  }
	| {
			readonly op: "archive";
			readonly id: string;
			readonly expectKind?: ItemKind;
	  }
	| { readonly op: "complete"; readonly id: string }
	| { readonly op: "markStale"; readonly id: string }
	| { readonly op: "pin"; readonly id: string }
	| { readonly op: "unpin"; readonly id: string };

/** Who performs an op. Authority depends on `origin`; the ledger cannot verify entries itself. */
export interface OpContext {
	readonly origin: ItemOrigin;
	/** Session entry that caused this op; recorded as the new item's source. */
	readonly entryId?: string;
	/**
	 * Position of a user-authored entry on the active branch, or undefined when the
	 * entry is not a user message. Used to verify supersession citations.
	 */
	readonly userEntryIndex?: ((entryId: string) => number | undefined) | undefined;
}

export type OpEffect =
	| "added"
	| "updated"
	| "superseded"
	| "archived"
	| "completed"
	| "stale"
	| "pinned"
	| "unpinned"
	| "duplicate";

export interface AppliedOp {
	readonly op: LedgerOp;
	readonly effect: OpEffect;
	/** Item after the op: the new item for `added`/`superseded`, the existing one for `duplicate`. */
	readonly item: LedgerItem;
}

export interface RejectedOp {
	readonly op: LedgerOp;
	readonly reason: ContinuityError;
}

export interface ReduceResult {
	readonly ledger: Ledger;
	readonly applied: readonly AppliedOp[];
	readonly rejected: readonly RejectedOp[];
	/** Dead items dropped to stay under the item cap, oldest first. */
	readonly evicted: readonly string[];
}

export interface DeltaSupersession {
	readonly ids: readonly string[];
	readonly with: NewItem;
	readonly citedEntryId?: string;
}

/** Model-proposed ledger changes emitted at fold time. */
export interface ContinuityDelta {
	readonly completed?: readonly string[];
	readonly ratified?: readonly NewItem[];
	readonly superseded?: readonly DeltaSupersession[];
	readonly expiredSteering?: readonly string[];
}

export interface FoldContext {
	/** The anchor being folded; its active steering is archived. */
	readonly anchorName: string;
	readonly origin: "agent" | "classifier";
	readonly entryId?: string;
	readonly userEntryIndex?: (entryId: string) => number | undefined;
}

export const isUserOrigin = (origin: ItemOrigin): boolean => USER_ORIGINS.has(origin);

/** Protected items cannot be changed by agent/classifier ops. */
export function isProtected(item: LedgerItem): boolean {
	return (
		item.pinned === true || (PROTECTED_KINDS.has(item.kind) && USER_ORIGINS.has(item.source.origin))
	);
}

export function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = text.slice(0, max - TRUNCATION_MARKER.length);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut + TRUNCATION_MARKER;
}

export function normalizeText(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export const locator = (file: FilePointer): string =>
	file.lines ? `${file.path}:${file.lines}` : file.path;
