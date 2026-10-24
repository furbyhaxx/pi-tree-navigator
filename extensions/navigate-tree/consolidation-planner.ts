/**
 * When and where background handoff consolidation cuts the projection.
 *
 * Pure: the host measures the projected handoffs and runs every safety check
 * that needs the session (tool envelopes, unanswered input, engine lock).
 */

/** The tunable trigger and cut; `enabled` is the host's concern. */
export interface ConsolidationLimits {
  /** Consolidate when more handoffs than this are in the projection. */
  maxHandoffs: number;
  /** Consolidate when handoff tokens exceed this share of the window. */
  maxWindowShare: number;
  /** Newest handoffs kept verbatim; the cut is the oldest of them. */
  keepNewest: number;
}

/** One `branch_summary` in the current projection. */
export interface ProjectedHandoff {
  entryId: string;
  /** Estimated tokens of this handoff as projected. */
  tokens: number;
  /** Estimated tokens of the projected conversation before it, system prompt and tools excluded. */
  prefixTokens: number;
}

export interface ConsolidationInput {
  limits: ConsolidationLimits;
  /** Handoffs in projection order, oldest first. A compaction summary is not a handoff. */
  handoffs: readonly ProjectedHandoff[];
  /** 0 when unknown; the share trigger then never fires. */
  contextWindow: number;
  /** Expected size of the consolidated summary. */
  summaryTokens: number;
  /** A consolidation must free at least this much. */
  minSavingTokens: number;
}

export type ConsolidationPlan =
  | {
      kind: "consolidate";
      /** First entry kept verbatim: the compaction's `firstKeptEntryId`. */
      firstKeptEntryId: string;
      /** Handoffs folded into the summary. */
      merged: number;
      trigger: "count" | "share";
      prefixTokens: number;
      savingTokens: number;
    }
  | {
      kind: "skip";
      reason: "below-threshold" | "too-few-handoffs" | "no-saving";
      detail: string;
    };

/** Decide whether to consolidate now and which entry starts the kept range. */
export function planConsolidation(
  input: ConsolidationInput,
): ConsolidationPlan {
  const { limits, handoffs, contextWindow } = input;
  const handoffTokens = handoffs.reduce((sum, h) => sum + h.tokens, 0);
  const byCount = handoffs.length > limits.maxHandoffs;
  const shareLimit = contextWindow * limits.maxWindowShare;
  const byShare = contextWindow > 0 && handoffTokens > shareLimit;
  if (!byCount && !byShare)
    return {
      kind: "skip",
      reason: "below-threshold",
      detail: `${handoffs.length} handoffs, ${handoffTokens} tokens (limits: more than ${limits.maxHandoffs}, or more than ${Math.round(shareLimit)} tokens)`,
    };
  if (handoffs.length <= limits.keepNewest)
    return {
      kind: "skip",
      reason: "too-few-handoffs",
      detail: `only ${handoffs.length} handoffs, all within the newest ${limits.keepNewest} kept verbatim`,
    };
  const merged = handoffs.length - limits.keepNewest;
  const cut = handoffs[merged];
  const savingTokens = cut.prefixTokens - input.summaryTokens;
  if (savingTokens < input.minSavingTokens)
    return {
      kind: "skip",
      reason: "no-saving",
      detail: `the ${cut.prefixTokens}-token prefix would shrink by only ${savingTokens} tokens (minimum ${input.minSavingTokens})`,
    };
  return {
    kind: "consolidate",
    firstKeptEntryId: cut.entryId,
    merged,
    trigger: byCount ? "count" : "share",
    prefixTokens: cut.prefixTokens,
    savingTokens,
  };
}
