/**
 * `/anchor fold`: a four-step wizard that asks the agent to fold the work since an anchor.
 *
 * Pick the anchor, name the summary, optionally steer its focus, confirm. Esc goes
 * back one step; nothing is requested until the last step is confirmed.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AnchorRow } from "./anchor-command.ts";
import { type FrameRow, sanitizeTerminalText, selectFrame } from "./frame.ts";
import { isValidName, MAX_NAME_LENGTH } from "./helpers.ts";

/** What the user chose beyond the anchor itself. */
export interface FoldRequestOptions {
  /** Name of the summary (`newLabel` of the rewind). */
  label: string;
  /** Absent when the agent should write the focus itself. */
  focus?: string;
}

/** Session access the wizard needs; supplied by the extension entry point. */
export interface FoldScreenDeps {
  /** Anchors on the active branch, root to leaf. */
  listAnchors(ctx: ExtensionCommandContext): AnchorRow[];
  setAnchor(
    ctx: ExtensionCommandContext,
    name: string,
  ): { ok: true } | { ok: false; reason: string };
  /** A fresh kebab-case label for the summary of a fold to `anchor`. */
  suggestLabel(ctx: ExtensionCommandContext, anchor: AnchorRow): string;
  requestFold(
    ctx: ExtensionCommandContext,
    anchorName: string,
    opts?: FoldRequestOptions,
  ): void;
  /** A fold frees `savableTokens`; below this the rewind tool refuses it. */
  minSavingsTokens: number;
  /** Shortest `summaryFocus` the rewind tool accepts, after trimming. */
  minFocusLength: number;
}

const STEPS = 4;
const PREVIEW_CHARS = 160;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

const stepTitle = (step: number, title: string): string =>
  `Fold ${step}/${STEPS}: ${title}`;

const foldable = (anchor: AnchorRow, deps: FoldScreenDeps): boolean =>
  anchor.savableTokens >= deps.minSavingsTokens;

export const BEFORE_COMPACTION_NOTE =
  "Before compaction: folding would restore compacted history.";

/** A pre-compaction anchor whose fold cannot free enough, because the compaction would be undone. */
export const blockedByCompaction = (
  anchor: AnchorRow,
  deps: FoldScreenDeps,
): boolean => anchor.beforeCompaction === true && !foldable(anchor, deps);

function tooLittleNotice(anchor: AnchorRow, deps: FoldScreenDeps): string {
  if (blockedByCompaction(anchor, deps))
    return `'${anchor.name}': ${BEFORE_COMPACTION_NOTE} Pick an anchor created after the compaction.`;
  return `'${anchor.name}' would free only about ${formatTokens(anchor.savableTokens)} tok; a fold needs at least ${formatTokens(deps.minSavingsTokens)}. Pick an older anchor, or fold once more work has piled up.`;
}

/** One anchor row; one that would free too little is muted and cannot be picked. */
export function foldRow(anchor: AnchorRow, deps: FoldScreenDeps): FrameRow {
  const ok = foldable(anchor, deps);
  return {
    label: `◆ ${anchor.name}`,
    labelHint: anchor.auto ? "(auto)" : undefined,
    value: ok
      ? `−${formatTokens(anchor.savableTokens)} tok`
      : blockedByCompaction(anchor, deps)
        ? "before compaction"
        : "too little to fold",
    tone: ok ? "text" : "muted",
    detail: anchor.afterPreview ? `after: “${anchor.afterPreview}”` : undefined,
    description: ok
      ? `Fold the work since '${anchor.name}' into a summary; frees about ${formatTokens(anchor.savableTokens)} tok. Enter picks it.`
      : blockedByCompaction(anchor, deps)
        ? `${BEFORE_COMPACTION_NOTE} Pick an anchor created after the compaction.`
        : `Only about ${formatTokens(anchor.savableTokens)} tok would be freed; a fold needs at least ${formatTokens(deps.minSavingsTokens)}. Pick an older anchor.`,
  };
}

const EMPTY_ROW: FrameRow = {
  label: "",
  labelHint: "No anchors yet. Press a to set one at the current leaf.",
  tone: "muted",
  description: `A fold collapses the work since an anchor. Press a to label the current leaf (kebab-case, at most ${MAX_NAME_LENGTH} characters), then fold to it once more work has piled up.`,
};

async function setAnchorHere(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
): Promise<void> {
  const input = await ctx.ui.input(
    `New anchor name (kebab-case, max ${MAX_NAME_LENGTH} characters)`,
    "e.g. impl-start",
  );
  const name = input?.trim();
  if (!name) return;
  const result = deps.setAnchor(ctx, name);
  ctx.ui.notify(
    result.ok ? `Anchor '${name}' set at the current leaf.` : result.reason,
    result.ok ? "info" : "warning",
  );
}

/** Step 1: the anchor to fold to, newest first; undefined when the user leaves. */
async function pickAnchor(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
  start: { cursor?: number },
): Promise<AnchorRow | undefined> {
  while (true) {
    const anchors = [...deps.listAnchors(ctx)].reverse();
    const ready = anchors.filter((anchor) => foldable(anchor, deps)).length;
    const choice = await selectFrame(ctx, {
      breadcrumbs: ["Anchor", "Fold"],
      rightBadge: `step 1/${STEPS} · ${ready} of ${anchors.length} foldable`,
      placeholder: "Filter anchors by name or preview…",
      enterAction: "pick",
      rows: anchors.length
        ? anchors.map((anchor) => foldRow(anchor, deps))
        : [EMPTY_ROW],
      cursor:
        start.cursor ??
        Math.max(
          0,
          anchors.findIndex((a) => foldable(a, deps)),
        ),
      shortcuts: [
        { key: "a", action: "set anchor", enabled: () => !anchors.length },
      ],
    });
    if (!choice) return undefined;
    start.cursor = choice.index;
    const anchor = anchors[choice.index];
    if (!anchor) {
      if (choice.key === "a") await setAnchorHere(ctx, deps);
      else ctx.ui.notify(EMPTY_ROW.labelHint ?? "", "info");
    } else if (foldable(anchor, deps)) {
      return anchor;
    } else {
      ctx.ui.notify(tooLittleNotice(anchor, deps), "warning");
    }
  }
}

/** Lowercase kebab-case from whatever was typed; accents drop, other symbols become hyphens. */
function toKebab(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Step 2: the summary's label; undefined when the user goes back. */
async function askLabel(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
  suggestion: string,
): Promise<string | undefined> {
  while (true) {
    const input = await ctx.ui.input(
      stepTitle(2, `name the summary (Enter keeps '${suggestion}')`),
      suggestion,
    );
    if (input === undefined) return undefined;
    const typed = input.trim();
    const label = typed ? toKebab(typed) : suggestion;
    if (!isValidName(label)) {
      ctx.ui.notify(
        `'${typed}' cannot be a label: use lowercase kebab-case, at most ${MAX_NAME_LENGTH} characters (e.g. '${suggestion}').`,
        "warning",
      );
    } else if (deps.listAnchors(ctx).some(({ name }) => name === label)) {
      ctx.ui.notify(
        `An anchor named '${label}' already exists on this branch; pick a fresh name (e.g. '${suggestion}').`,
        "warning",
      );
    } else {
      return label;
    }
  }
}

const templateLabels = (anchorName: string): string[] => [
  "Latest instruction:",
  `Done since '${anchorName}':`,
  "Remaining:",
];

const focusTemplate = (anchorName: string): string =>
  templateLabels(anchorName).join("\n");

/** What the editor text means: empty or untouched leaves the focus to the agent. */
export type FocusAnswer =
  | { kind: "agent" }
  | { kind: "focus"; text: string }
  | { kind: "short"; length: number };

/**
 * Judge the edited template. Label-only lines are dropped and the length counts the
 * user's own words, so a template with one short answer cannot pass on its labels.
 */
export function parseFocus(
  raw: string,
  anchorName: string,
  minLength: number,
): FocusAnswer {
  const labels = templateLabels(anchorName);
  const lines = sanitizeTerminalText(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const label = labels.find((candidate) => line.startsWith(candidate));
      return { line, words: label ? line.slice(label.length).trim() : line };
    })
    .filter(({ words }) => words);
  if (!lines.length) return { kind: "agent" };
  const length = lines.map(({ words }) => words).join(" ").length;
  if (length < minLength) return { kind: "short", length };
  return { kind: "focus", text: lines.map(({ line }) => line).join("\n") };
}

interface FocusStep {
  /** The editor text as the user left it, so Back can reopen it. */
  raw: string;
  focus?: string;
}

/** Step 3: the summary focus; undefined when the user goes back. */
async function askFocus(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
  anchor: AnchorRow,
  draft: string | undefined,
): Promise<FocusStep | undefined> {
  let text = draft ?? focusTemplate(anchor.name);
  while (true) {
    const raw = await ctx.ui.editor(
      stepTitle(3, "summary focus (leave as is: the agent decides)"),
      text,
    );
    if (raw === undefined) return undefined;
    const answer = parseFocus(raw, anchor.name, deps.minFocusLength);
    if (answer.kind === "agent") return { raw };
    if (answer.kind === "focus") return { raw, focus: answer.text };
    ctx.ui.notify(
      `That focus has ${answer.length} characters of your own words; it needs at least ${deps.minFocusLength} (latest instruction, what is done, what remains). Add detail, or clear the lines to let the agent write it.`,
      "warning",
    );
    text = raw;
  }
}

function confirmMessage(
  ctx: ExtensionCommandContext,
  anchor: AnchorRow,
  label: string,
  focus: string | undefined,
): string {
  const preview =
    focus === undefined
      ? "the agent writes it"
      : `“${clip(focus.replace(/\s+/g, " "), PREVIEW_CHARS)}”`;
  return [
    `Anchor: ${anchor.name}`,
    `Frees: about ${formatTokens(anchor.savableTokens)} tok`,
    `Label: ${label}`,
    `Focus: ${preview}`,
    "",
    ctx.isIdle()
      ? "This asks the agent to fold; the summary is written by the model."
      : "The agent is working: the request is queued as a follow-up and runs when it finishes.",
  ].join("\n");
}

/** Steps 2 to 4 for one anchor; "pick" sends the user back to choose another anchor. */
async function foldTo(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
  anchor: AnchorRow,
): Promise<"done" | "pick"> {
  let label = deps.suggestLabel(ctx, anchor);
  let focus: FocusStep | undefined;
  let step: "label" | "focus" | "confirm" = "label";
  while (true) {
    if (step === "label") {
      const answer = await askLabel(ctx, deps, label);
      if (answer === undefined) return "pick";
      label = answer;
      step = "focus";
    } else if (step === "focus") {
      const answer = await askFocus(ctx, deps, anchor, focus?.raw);
      if (answer === undefined) step = "label";
      else {
        focus = answer;
        step = "confirm";
      }
    } else {
      const fresh = deps
        .listAnchors(ctx)
        .find(({ name }) => name === anchor.name);
      if (!fresh || !foldable(fresh, deps)) {
        ctx.ui.notify(
          fresh
            ? tooLittleNotice(fresh, deps)
            : `Anchor '${anchor.name}' is no longer on the active branch; pick another.`,
          "warning",
        );
        return "pick";
      }
      const confirmed = await ctx.ui.confirm(
        stepTitle(4, `fold to '${fresh.name}'?`),
        confirmMessage(ctx, fresh, label, focus?.focus),
      );
      if (!confirmed) {
        step = "focus";
        continue;
      }
      const anchors = deps.listAnchors(ctx);
      const confirmedAnchor = anchors.find(({ name }) => name === fresh.name);
      if (!confirmedAnchor || !foldable(confirmedAnchor, deps)) {
        ctx.ui.notify(
          "The selected anchor changed while confirming. Pick an anchor again.",
          "warning",
        );
        return "pick";
      }
      if (anchors.some(({ name }) => name === label)) {
        ctx.ui.notify(
          `Label '${label}' was taken while confirming. Pick a fresh label.`,
          "warning",
        );
        step = "label";
        continue;
      }
      deps.requestFold(ctx, confirmedAnchor.name, {
        label,
        ...(focus?.focus !== undefined && { focus: focus.focus }),
      });
      return "done";
    }
  }
}

/**
 * Guide the user through a fold until it is requested ("done") or abandoned ("back").
 * Esc at the first step leaves; at every later step it returns to the one before.
 */
export async function openFoldScreen(
  ctx: ExtensionCommandContext,
  deps: FoldScreenDeps,
): Promise<"back" | "done"> {
  const start: { cursor?: number } = {};
  while (true) {
    const anchor = await pickAnchor(ctx, deps, start);
    if (!anchor) return "back";
    if ((await foldTo(ctx, deps, anchor)) === "done") return "done";
  }
}
