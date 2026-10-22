/**
 * Session Continuity Ledger: structured user intent that survives folds.
 *
 * Pure data model, reducer, invariants and (de)serialization. The ledger is
 * stored on `branch_summary.details[LEDGER_DETAILS_KEY]`, so it follows the
 * active branch across /tree and fork. Capture (reading session entries,
 * classifiers) and rendering live elsewhere.
 *
 * No I/O and no pi runtime imports. Every update returns a new ledger.
 */

import { isValidName } from "./helpers.ts";

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
export const ITEM_STATUSES = [
  "active",
  "completed",
  "superseded",
  "archived",
  "stale",
] as const;
export const ITEM_ORIGINS = [
  "user",
  "ask_user",
  "pin",
  "agent",
  "classifier",
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

const ID_PREFIX: Readonly<Record<ItemKind, string>> = {
  objective: "G",
  "sub-goal": "S",
  rule: "R",
  decision: "D",
  steering: "T",
  fact: "F",
  file: "P",
};
const ID_RE = /^[GSRDTFP][1-9]\d*$/;
const LINES_RE = /^\d+(-\d+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const USER_ORIGINS: ReadonlySet<ItemOrigin> = new Set([
  "user",
  "ask_user",
  "pin",
]);
const PROTECTED_KINDS: ReadonlySet<ItemKind> = new Set([
  "objective",
  "rule",
  "decision",
]);

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
  readonly userEntryIndex?: (entryId: string) => number | undefined;
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

export const isUserOrigin = (origin: ItemOrigin): boolean =>
  USER_ORIGINS.has(origin);

/** Protected items cannot be changed by agent/classifier ops. */
export function isProtected(item: LedgerItem): boolean {
  return (
    item.pinned === true ||
    (PROTECTED_KINDS.has(item.kind) && USER_ORIGINS.has(item.source.origin))
  );
}

export function createLedger(): Ledger {
  return { version: LEDGER_VERSION, rev: 0, nextId: 1, items: [] };
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

const locator = (file: FilePointer): string =>
  file.lines ? `${file.path}:${file.lines}` : file.path;

const invalid = (message: string, itemId?: string): ContinuityError =>
  new ContinuityError("invalid_op", message, itemId);

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface Work {
  items: LedgerItem[];
  nextId: number;
  /** Revision stamped on everything this transaction touches. */
  rev: number;
  changed: boolean;
  applied: AppliedOp[];
  rejected: RejectedOp[];
}

// Deterministic operations (fold-time archiving, hash checks) carry no extra authority.
const SYSTEM_CTX: OpContext = { origin: "agent" };

const begin = (ledger: Ledger): Work => ({
  items: [...ledger.items],
  nextId: ledger.nextId,
  rev: ledger.rev + 1,
  changed: false,
  applied: [],
  rejected: [],
});

function finish(base: Ledger, work: Work): ReduceResult {
  const ledger: Ledger = work.changed
    ? {
        version: LEDGER_VERSION,
        rev: work.rev,
        nextId: work.nextId,
        items: work.items,
      }
    : base;
  return { ledger, applied: work.applied, rejected: work.rejected };
}

function find(work: Work, id: string): LedgerItem {
  const item = work.items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new ContinuityError("unknown_item", `unknown ledger item ${id}`, id);
  }
  return item;
}

function replace(work: Work, item: LedgerItem): void {
  work.items = work.items.map((candidate) =>
    candidate.id === item.id ? item : candidate,
  );
}

function requireStatus(
  item: LedgerItem,
  allowed: readonly ItemStatus[],
  verb: string,
): void {
  if (!allowed.includes(item.status)) {
    throw new ContinuityError(
      "not_live",
      `cannot ${verb} ${item.id}: it is ${item.status}`,
      item.id,
    );
  }
}

function guardProtected(item: LedgerItem, ctx: OpContext, verb: string): void {
  if (isProtected(item) && !USER_ORIGINS.has(ctx.origin)) {
    throw new ContinuityError(
      "protected_item",
      `${item.id} (${item.kind}, ${item.source.origin}) is protected: ${ctx.origin} ops cannot ${verb} it`,
      item.id,
    );
  }
}

function checkCitation(
  item: LedgerItem,
  cited: string | undefined,
  ctx: OpContext,
): void {
  const reject = (why: string) =>
    new ContinuityError(
      "invalid_citation",
      `superseding protected item ${item.id} ${why}`,
      item.id,
    );
  if (!cited) throw reject("requires citing a newer user entry");
  const index = ctx.userEntryIndex?.(cited);
  const selfCited = USER_ORIGINS.has(ctx.origin) && cited === ctx.entryId;
  if (index === undefined && !selfCited) {
    throw reject(`cites ${cited}, which is not a known user entry`);
  }
  const own = item.source.entryId;
  if (own === undefined) return;
  if (cited === own) throw reject(`cites its own source entry ${cited}`);
  // An unresolvable own entry was folded off the active branch, so it is older.
  const ownIndex = ctx.userEntryIndex?.(own);
  if (index !== undefined && ownIndex !== undefined && index <= ownIndex) {
    throw reject(`cites ${cited}, which is not newer than ${own}`);
  }
}

interface Normalized {
  readonly kind: ItemKind;
  readonly text: string;
  readonly quote?: string;
  readonly scopeAnchor?: string;
  readonly file?: FilePointer;
}

function capRequired(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return capText(value.trim(), max);
}

function normalizeFile(file: FilePointer): FilePointer {
  if (
    typeof file.path !== "string" ||
    file.path.length === 0 ||
    file.path.length > MAX_PATH_CHARS
  ) {
    throw invalid(`file.path must be 1-${MAX_PATH_CHARS} characters`);
  }
  if (file.lines !== undefined && !LINES_RE.test(file.lines)) {
    throw invalid("file.lines must be N or N-M");
  }
  if (file.sha256 !== undefined && !SHA256_RE.test(file.sha256)) {
    throw invalid("file.sha256 must be 64 lowercase hex characters");
  }
  return {
    path: file.path,
    ...(file.lines !== undefined && { lines: file.lines }),
    ...(file.sha256 !== undefined && { sha256: file.sha256 }),
    why: capRequired(file.why, MAX_ITEM_TEXT_CHARS, "file.why"),
  };
}

function normalizeNewItem(input: NewItem): Normalized {
  const { kind } = input;
  if (!ITEM_KINDS.includes(kind)) throw invalid(`unknown kind ${String(kind)}`);
  const quote =
    input.quote === undefined
      ? undefined
      : capRequired(input.quote, MAX_QUOTE_CHARS, "quote");
  const { scopeAnchor } = input;
  if (kind === "steering" && scopeAnchor === undefined) {
    throw invalid("steering requires a scopeAnchor");
  }
  if (scopeAnchor !== undefined) {
    if (kind !== "steering" && kind !== "sub-goal") {
      throw invalid(`${kind} items cannot have a scopeAnchor`);
    }
    if (!isValidName(scopeAnchor)) {
      throw invalid(`scopeAnchor ${String(scopeAnchor)} is not an anchor name`);
    }
  }
  const common = {
    kind,
    ...(quote !== undefined && { quote }),
    ...(scopeAnchor !== undefined && { scopeAnchor }),
  };
  if (kind === "file") {
    if (input.text !== undefined) throw invalid("file text is derived");
    if (!input.file) throw invalid("file items require a file pointer");
    const file = normalizeFile(input.file);
    return { ...common, text: locator(file), file };
  }
  if (input.file !== undefined)
    throw invalid(`${kind} items cannot have a file`);
  return {
    ...common,
    text: capRequired(input.text, MAX_ITEM_TEXT_CHARS, "text"),
  };
}

function create(
  work: Work,
  fields: Normalized,
  ctx: OpContext,
  supersedes: readonly LedgerItem[],
  source?: ItemSource,
): LedgerItem {
  if (work.items.length >= MAX_LEDGER_ITEMS) {
    throw new ContinuityError(
      "ledger_full",
      `ledger holds ${MAX_LEDGER_ITEMS} items; cannot add another`,
    );
  }
  const pinned = ctx.origin === "pin" || supersedes.some((old) => old.pinned);
  const item: LedgerItem = {
    id: `${ID_PREFIX[fields.kind]}${work.nextId}`,
    kind: fields.kind,
    text: fields.text,
    status: "active",
    source: source ?? {
      ...(ctx.entryId !== undefined && { entryId: ctx.entryId }),
      origin: ctx.origin,
    },
    ...(fields.quote !== undefined && { quote: fields.quote }),
    ...(fields.scopeAnchor !== undefined && {
      scopeAnchor: fields.scopeAnchor,
    }),
    ...(fields.file !== undefined && { file: fields.file }),
    ...(supersedes.length > 0 && { supersedes: supersedes.map((o) => o.id) }),
    ...(pinned && { pinned: true as const }),
    createdRev: work.rev,
    updatedRev: work.rev,
  };
  work.nextId += 1;
  work.items.push(item);
  return item;
}

function applyAdd(work: Work, op: LedgerOp & { op: "add" }, ctx: OpContext) {
  const fields = normalizeNewItem(op);
  const key = normalizeText(fields.text);
  const existing = work.items.find(
    (item) =>
      item.status === "active" &&
      item.kind === fields.kind &&
      normalizeText(item.text) === key,
  );
  if (existing) return applied(op, "duplicate", existing);
  if (
    fields.kind === "objective" &&
    work.items.some((i) => i.kind === "objective" && i.status === "active")
  ) {
    throw invalid("an active objective exists; supersede it instead");
  }
  return applied(op, "added", create(work, fields, ctx, []));
}

function applyUpdate(
  work: Work,
  op: LedgerOp & { op: "update" },
  ctx: OpContext,
) {
  const item = find(work, op.id);
  guardProtected(item, ctx, "rewrite");
  requireStatus(item, ["active", "stale"], "update");
  if (op.text === undefined && op.quote === undefined && !op.file) {
    throw invalid("update needs text, quote or file", item.id);
  }
  let next: LedgerItem = item;
  if (op.text !== undefined) {
    if (item.kind === "file") throw invalid("file text is derived", item.id);
    next = { ...next, text: capRequired(op.text, MAX_ITEM_TEXT_CHARS, "text") };
  }
  if (op.file !== undefined) {
    if (item.kind !== "file")
      throw invalid("only file items take a file", item.id);
    const file = normalizeFile(op.file);
    next = { ...next, text: locator(file), file, status: "active" };
  }
  if (op.quote !== undefined) {
    next = { ...next, quote: capRequired(op.quote, MAX_QUOTE_CHARS, "quote") };
  }
  next = { ...next, updatedRev: work.rev };
  replace(work, next);
  return applied(op, "updated", next);
}

function applySupersede(
  work: Work,
  op: LedgerOp & { op: "supersede" },
  ctx: OpContext,
) {
  if (op.ids.length === 0 || new Set(op.ids).size !== op.ids.length) {
    throw invalid("supersede needs one or more distinct ids");
  }
  const olds = op.ids.map((id) => find(work, id));
  const fields = normalizeNewItem(op.with);
  const cited =
    op.citedEntryId ?? (USER_ORIGINS.has(ctx.origin) ? ctx.entryId : undefined);
  for (const old of olds) {
    requireStatus(old, ["active", "stale"], "supersede");
    if (old.kind !== fields.kind) {
      throw new ContinuityError(
        "wrong_kind",
        `${old.id} is a ${old.kind}; its replacement must be one too, not a ${fields.kind}`,
        old.id,
      );
    }
    if (isProtected(old)) checkCitation(old, cited, ctx);
  }
  // A protected item's replacement keeps its authority: the cited user entry is the source.
  const heir = olds.find(isProtected);
  const source: ItemSource | undefined = heir && {
    ...(cited !== undefined && { entryId: cited }),
    origin: heir.source.origin,
  };
  const created = create(work, fields, ctx, olds, source);
  for (const old of olds) {
    replace(work, {
      ...old,
      status: "superseded",
      supersededBy: created.id,
      updatedRev: work.rev,
    });
  }
  return applied(op, "superseded", created);
}

function applyArchive(
  work: Work,
  op: LedgerOp & { op: "archive" },
  ctx: OpContext,
) {
  const item = find(work, op.id);
  guardProtected(item, ctx, "archive");
  if (op.expectKind !== undefined && item.kind !== op.expectKind) {
    throw new ContinuityError(
      "wrong_kind",
      `${item.id} is a ${item.kind}, not ${op.expectKind}`,
      item.id,
    );
  }
  requireStatus(item, ["active", "stale", "completed"], "archive");
  const next = { ...item, status: "archived" as const, updatedRev: work.rev };
  replace(work, next);
  return applied(op, "archived", next);
}

function applyComplete(
  work: Work,
  op: LedgerOp & { op: "complete" },
  ctx: OpContext,
) {
  const item = find(work, op.id);
  guardProtected(item, ctx, "complete");
  if (item.kind !== "objective" && item.kind !== "sub-goal") {
    throw new ContinuityError(
      "wrong_kind",
      `${item.id} is a ${item.kind}; only goals can be completed`,
      item.id,
    );
  }
  requireStatus(item, ["active"], "complete");
  const next = { ...item, status: "completed" as const, updatedRev: work.rev };
  replace(work, next);
  return applied(op, "completed", next);
}

function applyMarkStale(work: Work, op: LedgerOp & { op: "markStale" }) {
  const item = find(work, op.id);
  if (item.kind !== "file") {
    throw new ContinuityError(
      "wrong_kind",
      `${item.id} is a ${item.kind}; only file pointers go stale`,
      item.id,
    );
  }
  requireStatus(item, ["active"], "mark stale");
  const next = { ...item, status: "stale" as const, updatedRev: work.rev };
  replace(work, next);
  return applied(op, "stale", next);
}

function applyPin(
  work: Work,
  op: LedgerOp & { op: "pin" | "unpin" },
  ctx: OpContext,
) {
  const item = find(work, op.id);
  if (!USER_ORIGINS.has(ctx.origin)) {
    throw new ContinuityError(
      "protected_item",
      `${ctx.origin} ops cannot ${op.op} ${item.id}`,
      item.id,
    );
  }
  requireStatus(item, ["active", "stale", "completed"], op.op);
  if (op.op === "pin") {
    if (item.pinned) throw invalid(`${item.id} is already pinned`, item.id);
    const next = { ...item, pinned: true as const, updatedRev: work.rev };
    replace(work, next);
    return applied(op, "pinned", next);
  }
  if (!item.pinned) throw invalid(`${item.id} is not pinned`, item.id);
  const { pinned: _pinned, ...rest } = item;
  const next: LedgerItem = { ...rest, updatedRev: work.rev };
  replace(work, next);
  return applied(op, "unpinned", next);
}

const applied = (
  op: LedgerOp,
  effect: OpEffect,
  item: LedgerItem,
): AppliedOp => ({ op, effect, item });

function applyOne(work: Work, op: LedgerOp, ctx: OpContext): AppliedOp {
  switch (op.op) {
    case "add":
      return applyAdd(work, op, ctx);
    case "update":
      return applyUpdate(work, op, ctx);
    case "supersede":
      return applySupersede(work, op, ctx);
    case "archive":
      return applyArchive(work, op, ctx);
    case "complete":
      return applyComplete(work, op, ctx);
    case "markStale":
      return applyMarkStale(work, op);
    case "pin":
    case "unpin":
      return applyPin(work, op, ctx);
    default:
      throw invalid(`unknown op ${String((op as { op?: unknown }).op)}`);
  }
}

function runOps(work: Work, ops: readonly LedgerOp[], ctx: OpContext): void {
  for (const op of ops) {
    try {
      const result = applyOne(work, op, ctx);
      work.applied.push(result);
      if (result.effect !== "duplicate") work.changed = true;
    } catch (error) {
      if (!(error instanceof ContinuityError)) throw error;
      work.rejected.push({ op, reason: error });
    }
  }
}

/**
 * Apply ops in order. Each op is atomic: a rejected op leaves the ledger as it was
 * and is reported in `rejected`; later ops still run. One call is one revision.
 */
export function applyOps(
  ledger: Ledger,
  ops: readonly LedgerOp[],
  ctx: OpContext,
): ReduceResult {
  const work = begin(ledger);
  runOps(work, ops, ctx);
  return finish(ledger, work);
}

const steeringArchiveOps = (
  items: readonly LedgerItem[],
  anchorName: string,
): LedgerOp[] =>
  items
    // Pinned steering was explicitly kept by the user, so a fold does not expire it.
    .filter(
      (item) =>
        item.kind === "steering" &&
        item.status === "active" &&
        item.scopeAnchor === anchorName &&
        !item.pinned,
    )
    .map((item) => ({
      op: "archive",
      id: item.id,
      expectKind: "steering",
    }));

/** Archive (never delete) active steering scoped to `anchorName`; each appears in `applied`. */
export function archiveSteeringForAnchor(
  ledger: Ledger,
  anchorName: string,
): ReduceResult {
  const work = begin(ledger);
  runOps(work, steeringArchiveOps(work.items, anchorName), SYSTEM_CTX);
  return finish(ledger, work);
}

function deltaOps(delta: ContinuityDelta): LedgerOp[] {
  return [
    ...(delta.expiredSteering ?? []).map(
      (id): LedgerOp => ({ op: "archive", id, expectKind: "steering" }),
    ),
    ...(delta.completed ?? []).map((id): LedgerOp => ({ op: "complete", id })),
    ...(delta.superseded ?? []).map(
      (entry): LedgerOp => ({
        op: "supersede",
        ids: entry.ids,
        with: entry.with,
        ...(entry.citedEntryId !== undefined && {
          citedEntryId: entry.citedEntryId,
        }),
      }),
    ),
    ...(delta.ratified ?? []).map((item): LedgerOp => ({ op: "add", ...item })),
  ];
}

/**
 * Reconcile a model-proposed delta through the normal invariants, then archive the
 * folded anchor's steering. Rejections are per op; nothing is dropped or accepted silently.
 */
export function reconcileFold(
  ledger: Ledger,
  delta: ContinuityDelta,
  foldCtx: FoldContext,
): ReduceResult {
  const work = begin(ledger);
  runOps(work, deltaOps(delta), foldCtx);
  runOps(work, steeringArchiveOps(work.items, foldCtx.anchorName), SYSTEM_CTX);
  return finish(ledger, work);
}

export function markFilePointerStale(ledger: Ledger, id: string): ReduceResult {
  return applyOps(ledger, [{ op: "markStale", id }], SYSTEM_CTX);
}

/**
 * Mark active file pointers stale when `hashOf(path)` differs from the recorded
 * sha256 (a missing file counts as different). Pointers without a hash are unchecked.
 */
export function checkFilePointers(
  ledger: Ledger,
  hashOf: (path: string) => string | undefined,
): ReduceResult {
  const ops: LedgerOp[] = ledger.items
    .filter(
      (item) =>
        item.kind === "file" &&
        item.status === "active" &&
        item.file?.sha256 !== undefined &&
        hashOf(item.file.path) !== item.file.sha256,
    )
    .map((item) => ({ op: "markStale", id: item.id }));
  return applyOps(ledger, ops, SYSTEM_CTX);
}

/**
 * Replace the active ledger with an earlier snapshot (a rewind) without letting the
 * id counter or revision go backwards past what the abandoned ledger already issued.
 */
export function rewindLedger(snapshot: Ledger, abandoned: Ledger): Ledger {
  return {
    version: LEDGER_VERSION,
    rev: Math.max(snapshot.rev, abandoned.rev) + 1,
    nextId: Math.max(snapshot.nextId, abandoned.nextId),
    items: snapshot.items,
  };
}

// ---------------------------------------------------------------------------
// Parsing and serialization
// ---------------------------------------------------------------------------

export type ParseCode = "invalid_ledger" | "invalid_delta";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readRecord(
  value: unknown,
  path: string,
  code: ParseCode,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ContinuityError(code, `${path}: expected an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new ContinuityError(code, `${path}: unknown field "${key}"`);
    }
  }
  return value;
}

function readString(value: unknown, path: string, code: ParseCode): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContinuityError(code, `${path}: expected a non-empty string`);
  }
  return value;
}

function readStringList(
  value: unknown,
  path: string,
  code: ParseCode,
): string[] {
  if (!Array.isArray(value)) {
    throw new ContinuityError(code, `${path}: expected an array`);
  }
  return value.map((entry, i) => readString(entry, `${path}[${i}]`, code));
}

function readOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  code: ParseCode,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ContinuityError(
      code,
      `${path}: expected one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function readCount(value: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new ContinuityError(
      "invalid_ledger",
      `${path}: expected an integer >= ${min}`,
    );
  }
  return value as number;
}

function readFilePointer(
  value: unknown,
  path: string,
  code: ParseCode,
): FilePointer {
  const raw = readRecord(value, path, code, ["path", "lines", "sha256", "why"]);
  const file: FilePointer = {
    path: readString(raw.path, `${path}.path`, code),
    ...(raw.lines !== undefined && {
      lines: readString(raw.lines, `${path}.lines`, code),
    }),
    ...(raw.sha256 !== undefined && {
      sha256: readString(raw.sha256, `${path}.sha256`, code),
    }),
    why: readString(raw.why, `${path}.why`, code),
  };
  if (file.lines !== undefined && !LINES_RE.test(file.lines)) {
    throw new ContinuityError(code, `${path}.lines: expected N or N-M`);
  }
  if (file.sha256 !== undefined && !SHA256_RE.test(file.sha256)) {
    throw new ContinuityError(code, `${path}.sha256: expected 64 hex digits`);
  }
  return file;
}

function parseNewItem(value: unknown, path: string, code: ParseCode): NewItem {
  const raw = readRecord(value, path, code, [
    "kind",
    "text",
    "quote",
    "scopeAnchor",
    "file",
  ]);
  return {
    kind: readOneOf(raw.kind, ITEM_KINDS, `${path}.kind`, code),
    ...(raw.text !== undefined && {
      text: readString(raw.text, `${path}.text`, code),
    }),
    ...(raw.quote !== undefined && {
      quote: readString(raw.quote, `${path}.quote`, code),
    }),
    ...(raw.scopeAnchor !== undefined && {
      scopeAnchor: readString(raw.scopeAnchor, `${path}.scopeAnchor`, code),
    }),
    ...(raw.file !== undefined && {
      file: readFilePointer(raw.file, `${path}.file`, code),
    }),
  };
}

function parseItem(
  value: unknown,
  path: string,
  ledgerRev: number,
  nextId: number,
): LedgerItem {
  const code = "invalid_ledger";
  const fail = (message: string): never => {
    throw new ContinuityError(code, `${path}: ${message}`);
  };
  const raw = readRecord(value, path, code, [
    "id",
    "kind",
    "text",
    "status",
    "source",
    "quote",
    "scopeAnchor",
    "file",
    "supersedes",
    "supersededBy",
    "pinned",
    "createdRev",
    "updatedRev",
  ]);
  const id = readString(raw.id, `${path}.id`, code);
  const kind = readOneOf(raw.kind, ITEM_KINDS, `${path}.kind`, code);
  if (!ID_RE.test(id) || id[0] !== ID_PREFIX[kind]) {
    fail(`id ${id} does not match kind ${kind}`);
  }
  if (Number(id.slice(1)) >= nextId) fail(`id ${id} is at or beyond nextId`);
  const text = readString(raw.text, `${path}.text`, code);
  const status = readOneOf(raw.status, ITEM_STATUSES, `${path}.status`, code);
  const src = readRecord(raw.source, `${path}.source`, code, [
    "entryId",
    "origin",
  ]);
  const source: ItemSource = {
    ...(src.entryId !== undefined && {
      entryId: readString(src.entryId, `${path}.source.entryId`, code),
    }),
    origin: readOneOf(src.origin, ITEM_ORIGINS, `${path}.source.origin`, code),
  };
  const quote =
    raw.quote === undefined
      ? undefined
      : readString(raw.quote, `${path}.quote`, code);
  if (quote !== undefined && quote.length > MAX_QUOTE_CHARS) {
    fail("quote exceeds the cap");
  }
  const scopeAnchor =
    raw.scopeAnchor === undefined
      ? undefined
      : readString(raw.scopeAnchor, `${path}.scopeAnchor`, code);
  if (kind === "steering" && scopeAnchor === undefined) {
    fail("steering requires scopeAnchor");
  }
  if (scopeAnchor !== undefined) {
    if (kind !== "steering" && kind !== "sub-goal") {
      fail(`${kind} cannot have scopeAnchor`);
    }
    if (!isValidName(scopeAnchor)) fail("scopeAnchor is not an anchor name");
  }
  const file =
    raw.file === undefined
      ? undefined
      : readFilePointer(raw.file, `${path}.file`, code);
  if ((kind === "file") !== (file !== undefined)) {
    fail("file pointer is required for, and only for, file items");
  }
  if (file) {
    if (
      file.path.length > MAX_PATH_CHARS ||
      file.why.length > MAX_ITEM_TEXT_CHARS
    ) {
      fail("file pointer exceeds the caps");
    }
    if (text !== locator(file))
      fail("file text must be its path[:lines] locator");
  } else if (text.length > MAX_ITEM_TEXT_CHARS) {
    fail("text exceeds the cap");
  }
  if (status === "stale" && kind !== "file") fail("only files can be stale");
  if (status === "completed" && kind !== "objective" && kind !== "sub-goal") {
    fail("only goals can be completed");
  }
  const supersedes =
    raw.supersedes === undefined
      ? undefined
      : readStringList(raw.supersedes, `${path}.supersedes`, code);
  const supersededBy =
    raw.supersededBy === undefined
      ? undefined
      : readString(raw.supersededBy, `${path}.supersededBy`, code);
  if ((status === "superseded") !== (supersededBy !== undefined)) {
    fail("supersededBy is required for, and only for, superseded items");
  }
  if (raw.pinned !== undefined && raw.pinned !== true) {
    fail("pinned must be true when present");
  }
  const createdRev = readCount(raw.createdRev, `${path}.createdRev`, 1);
  const updatedRev = readCount(raw.updatedRev, `${path}.updatedRev`, 1);
  if (createdRev > updatedRev || updatedRev > ledgerRev) {
    fail("revisions must satisfy createdRev <= updatedRev <= rev");
  }
  return {
    id,
    kind,
    text,
    status,
    source,
    ...(quote !== undefined && { quote }),
    ...(scopeAnchor !== undefined && { scopeAnchor }),
    ...(file !== undefined && { file }),
    ...(supersedes !== undefined && { supersedes }),
    ...(supersededBy !== undefined && { supersededBy }),
    ...(raw.pinned === true && { pinned: true as const }),
    createdRev,
    updatedRev,
  };
}

function checkLineage(items: readonly LedgerItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) {
    throw new ContinuityError("invalid_ledger", "duplicate item ids");
  }
  const bad = (message: string) =>
    new ContinuityError("invalid_ledger", `lineage: ${message}`);
  for (const item of items) {
    for (const oldId of item.supersedes ?? []) {
      if (byId.get(oldId)?.supersededBy !== item.id) {
        throw bad(`${item.id} supersedes ${oldId}, which does not point back`);
      }
    }
    if (item.supersededBy !== undefined) {
      const heir = byId.get(item.supersededBy);
      if (!heir?.supersedes?.includes(item.id)) {
        throw bad(
          `${item.id} is superseded by ${item.supersededBy}, which does not point back`,
        );
      }
    }
  }
}

const DELTA_KEYS = ["completed", "ratified", "superseded", "expiredSteering"];

/** Strictly parse an untrusted delta object; throws `ContinuityError("invalid_delta")`. */
export function parseDelta(value: unknown): ContinuityDelta {
  const code = "invalid_delta";
  const raw = readRecord(value, "delta", code, DELTA_KEYS);
  const list = (key: string): unknown[] | undefined => {
    const entry = raw[key];
    if (entry === undefined) return undefined;
    if (!Array.isArray(entry)) {
      throw new ContinuityError(code, `delta.${key}: expected an array`);
    }
    return entry;
  };
  const ratified = list("ratified");
  const superseded = list("superseded");
  return {
    ...(raw.completed !== undefined && {
      completed: readStringList(raw.completed, "delta.completed", code),
    }),
    ...(ratified && {
      ratified: ratified.map((entry, i) =>
        parseNewItem(entry, `delta.ratified[${i}]`, code),
      ),
    }),
    ...(superseded && {
      superseded: superseded.map((entry, i): DeltaSupersession => {
        const path = `delta.superseded[${i}]`;
        const item = readRecord(entry, path, code, [
          "ids",
          "with",
          "citedEntryId",
        ]);
        return {
          ids: readStringList(item.ids, `${path}.ids`, code),
          with: parseNewItem(item.with, `${path}.with`, code),
          ...(item.citedEntryId !== undefined && {
            citedEntryId: readString(
              item.citedEntryId,
              `${path}.citedEntryId`,
              code,
            ),
          }),
        };
      }),
    }),
    ...(raw.expiredSteering !== undefined && {
      expiredSteering: readStringList(
        raw.expiredSteering,
        "delta.expiredSteering",
        code,
      ),
    }),
  };
}

/** Strictly parse a stored ledger. Throws `ContinuityError`; never returns an empty ledger for garbage. */
export function parseLedger(value: unknown): Ledger {
  const code = "invalid_ledger";
  if (!isRecord(value)) {
    throw new ContinuityError(code, "ledger: expected an object");
  }
  if (value.version !== LEDGER_VERSION) {
    throw new ContinuityError(
      "unsupported_version",
      `ledger: unsupported version ${JSON.stringify(value.version)}`,
    );
  }
  const raw = readRecord(value, "ledger", code, [
    "version",
    "rev",
    "nextId",
    "items",
  ]);
  const rev = readCount(raw.rev, "ledger.rev", 0);
  const nextId = readCount(raw.nextId, "ledger.nextId", 1);
  if (!Array.isArray(raw.items)) {
    throw new ContinuityError(code, "ledger.items: expected an array");
  }
  if (raw.items.length > MAX_LEDGER_ITEMS) {
    throw new ContinuityError(
      code,
      `ledger.items: ${raw.items.length} exceeds the cap of ${MAX_LEDGER_ITEMS}`,
    );
  }
  const items = raw.items.map((entry, i) =>
    parseItem(entry, `ledger.items[${i}]`, rev, nextId),
  );
  checkLineage(items);
  return { version: LEDGER_VERSION, rev, nextId, items };
}

/** Plain-JSON copy for `branch_summary.details[LEDGER_DETAILS_KEY]`; re-validated so garbage is never persisted. */
export function serializeLedger(ledger: Ledger): Ledger {
  return parseLedger(JSON.parse(JSON.stringify(ledger)));
}
