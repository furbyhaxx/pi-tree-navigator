import {
  buildSessionProjection,
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildAutoMilestoneEvidence } from "./auto-milestone.ts";
import type { AutoNavigateConfig } from "./auto-navigate-config.ts";
import { projectHandoffs } from "./handoff-projection.ts";
import { LABEL_PREFIX } from "./helpers.ts";
import type { PolicyRegistry } from "./intent-policy.ts";
import {
  evaluateMilestone,
  type MilestoneEvaluation,
  resolveMilestonePolicy,
} from "./milestone-policy.ts";

/** Session-local cadence; install returned state even when there is no action. */
export interface AutoFoldState {
  sessionId: string;
  modelKey: string;
  signature: string;
  turnsSinceCheck: number;
  lastCheckTokens: number;
  lastAnchorEntryId?: string;
  aboveRewindThreshold: boolean;
  lastActionTokens?: number;
}

/** A semantic suggestion only; the parent owns labels, fold admission and execution. */
export type AutoFoldAction =
  | { kind: "none" }
  | { kind: "anchor"; entryId: string; suggestedName: string }
  | { kind: "fold"; boundaryEntryId: string };

/** Immutable turn-end inputs; isCurrent must cover session, leaf, model and config. */
export interface AutoFoldOptions {
  state?: AutoFoldState;
  sessionId: string;
  modelKey: string;
  config: AutoNavigateConfig;
  activeTokens: number;
  newestAnchorId?: string;
  anchorTokens: number;
  calledNavigateTree: boolean;
  entries: SessionEntry[];
  leafId: string;
  getLabel: (id: string) => string | undefined;
  registry: PolicyRegistry;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}

/** Cadence changes and operational warnings are independent of semantic action. */
export interface AutoFoldPlan {
  state: AutoFoldState;
  action: AutoFoldAction;
  warnings: string[];
  evaluation?: MilestoneEvaluation;
}

function anchorName(
  text: string,
  entryId: string,
  labels: Set<string>,
): string {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const line = text.split(/\r?\n/).find((value) => value.trim()) ?? "";
  const readable = slug(line.slice(0, 200));
  const base = (
    /[a-z]/.test(readable) ? readable : `milestone-${slug(entryId) || "id"}`
  )
    .slice(0, 40)
    .replace(/-+$/g, "");
  let name = base;
  for (let i = 2; labels.has(LABEL_PREFIX + name); i++) {
    const suffix = `-${i}`;
    name = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
  }
  return name;
}

/** Plan one bounded policy evaluation without mutating the session or previous state. */
export async function planAutomaticFold(
  options: AutoFoldOptions,
): Promise<AutoFoldPlan> {
  const {
    config,
    activeTokens,
    anchorTokens,
    newestAnchorId,
    entries,
    leafId,
    getLabel,
  } = options;
  const policy = config.milestonePolicy
    ? resolveMilestonePolicy(config.milestonePolicy)
    : undefined;
  const signature = JSON.stringify({
    enabled: config.enabled,
    mode: config.mode,
    checkEveryTurns: config.checkEveryTurns,
    minTokensSinceAnchor: config.minTokensSinceAnchor,
    rewindAtTokens: config.rewindAtTokens,
    policy: policy ?? null,
    tools: Object.entries(config.tools).sort(([a], [b]) => a.localeCompare(b)),
  });
  const previous = options.state;
  const state: AutoFoldState =
    previous?.sessionId === options.sessionId &&
    previous.modelKey === options.modelKey &&
    previous.signature === signature
      ? { ...previous }
      : {
          sessionId: options.sessionId,
          modelKey: options.modelKey,
          signature,
          turnsSinceCheck: 0,
          lastCheckTokens: anchorTokens,
          lastAnchorEntryId: newestAnchorId,
          aboveRewindThreshold: false,
        };
  const result: AutoFoldPlan = {
    state,
    action: { kind: "none" },
    warnings: [],
  };
  const current = () => !options.signal?.aborted && options.isCurrent();
  if (!current()) return result;

  if (state.lastAnchorEntryId !== newestAnchorId) {
    state.lastAnchorEntryId = newestAnchorId;
    state.lastCheckTokens = Math.max(
      Math.min(state.lastCheckTokens, activeTokens),
      anchorTokens,
    );
    state.lastActionTokens = undefined;
  }
  // A reduced projection cannot make previously counted tokens fresh again.
  state.lastCheckTokens = Math.min(state.lastCheckTokens, activeTokens);
  if (state.lastActionTokens !== undefined)
    state.lastActionTokens = Math.min(state.lastActionTokens, activeTokens);
  const above =
    config.mode === "anchor-and-rewind" &&
    activeTokens >= config.rewindAtTokens;
  const crossed = above && !state.aboveRewindThreshold;
  state.aboveRewindThreshold = above;
  state.turnsSinceCheck++;
  if (options.calledNavigateTree) {
    state.turnsSinceCheck = 0;
    state.lastCheckTokens = activeTokens;
    return result;
  }
  if (!config.enabled || !policy || policy.classifier === null) return result;
  if (
    state.lastActionTokens !== undefined &&
    activeTokens - state.lastActionTokens < config.minTokensSinceAnchor
  )
    return result;
  if (
    !crossed &&
    state.turnsSinceCheck < config.checkEveryTurns &&
    activeTokens - state.lastCheckTokens < config.minTokensSinceAnchor
  )
    return result;

  state.turnsSinceCheck = 0;
  state.lastCheckTokens = activeTokens;
  try {
    const evidence = buildAutoMilestoneEvidence({
      entries,
      leafId,
      getLabel,
      tools: config.tools,
    });
    result.warnings.push(...evidence.warnings);
    if (evidence.input.records.length === 0 || !current()) return result;
    const evaluation = await evaluateMilestone({
      policy,
      registry: options.registry,
      input: evidence.input,
      signal: options.signal,
    });
    result.evaluation = evaluation;
    result.warnings.push(...evaluation.warnings);
    if (
      !current() ||
      evaluation.status.kind !== "accept" ||
      evaluation.status.status !== "milestone" ||
      evaluation.boundary.kind !== "record"
    )
      return result;
    const recordId = evaluation.boundary.recordId;
    const boundaryEntryId = evidence.recordEntryIds.get(recordId);
    if (
      !boundaryEntryId ||
      !entries.some((entry) => entry.id === boundaryEntryId)
    )
      return result;
    const projected = projectHandoffs(
      buildSessionProjection(entries, leafId),
      entries,
    ).entries;
    const at = projected.findIndex(
      (entry) => entry.sourceEntry.id === boundaryEntryId,
    );
    if (at < 0) return result;
    const completeTail = !projected
      .slice(at + 1)
      .some((entry) => convertToLlm(entry.messages).length > 0);
    if (above && completeTail) {
      result.action = { kind: "fold", boundaryEntryId };
    } else {
      if (getLabel(boundaryEntryId) !== undefined) return result;
      const record = evidence.input.records.find(
        (record) => record.id === recordId,
      );
      if (!record) return result;
      const labels = new Set(
        entries.flatMap((entry) => {
          const label = getLabel(entry.id);
          return label === undefined ? [] : [label];
        }),
      );
      result.action = {
        kind: "anchor",
        entryId: boundaryEntryId,
        suggestedName: anchorName(record.text, boundaryEntryId, labels),
      };
    }
    if (!current()) result.action = { kind: "none" };
    else state.lastActionTokens = activeTokens;
  } catch (error) {
    result.action = { kind: "none" };
    result.warnings.push(
      `navigate_tree: automatic fold check failed (${error instanceof Error ? error.message : String(error)}); no milestone decision.`,
    );
  }
  return result;
}
