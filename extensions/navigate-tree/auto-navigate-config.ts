import {
  parseMilestonePolicyObject,
  RECOMMENDED_MILESTONE_CLASSIFIER,
} from "./milestone-policy.ts";
import {
  mergeProposalOptions,
  type ProposalOptions,
  type ProposalToolMode,
} from "./proposal-options.ts";

/** Actions the sidecar auto-navigation controller may perform. */
export type AutoNavigateMode = "anchor-only" | "anchor-and-rewind";

export const AUTO_NAVIGATE_MIN_TURNS = 1;
export const AUTO_NAVIGATE_MAX_TURNS = 100;
export const AUTO_NAVIGATE_DEFAULT_TURNS = 6;
export const AUTO_NAVIGATE_MIN_TOKENS = 1_000;
export const AUTO_NAVIGATE_MAX_TOKENS = 1_000_000;
export const AUTO_NAVIGATE_DEFAULT_MIN_TOKENS = 25_000;
export const AUTO_NAVIGATE_DEFAULT_REWIND_TOKENS = 120_000;
export const AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE = 0.05;
export const AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE = 0.45;
export const AUTO_NAVIGATE_DEFAULT_KEEP_RECENT_SHARE = 0.25;

/** Resolved sidecar auto-navigation policy for an active model. */
export interface AutoNavigateConfig {
  readonly enabled: boolean;
  readonly mode: AutoNavigateMode;
  readonly pressure: "compact" | "fold";
  readonly keepRecentShare: number;
  readonly checkEveryTurns: number;
  readonly minTokensSinceAnchor: number;
  readonly rewindAtTokens: number;
  readonly milestonePolicy: string | null;
  readonly tools: Readonly<Record<string, ProposalToolMode>>;
}

/** Partial override layer for `auto_navigate` at root or inside `model_overrides`. */
export interface AutoNavigatePartial {
  readonly enabled?: boolean;
  readonly mode?: AutoNavigateMode;
  readonly pressure?: "compact" | "fold";
  readonly keepRecentShare?: number;
  readonly checkEveryTurns?: number;
  readonly minTokensSinceAnchor?: number;
  readonly rewindAtTokens?: number;
  readonly milestonePolicy?: string | null;
  readonly tools?: Readonly<Record<string, ProposalToolMode>>;
}

export const DEFAULT_AUTO_NAVIGATE_CONFIG: AutoNavigateConfig = {
  enabled: false,
  mode: "anchor-and-rewind",
  pressure: "compact",
  keepRecentShare: AUTO_NAVIGATE_DEFAULT_KEEP_RECENT_SHARE,
  checkEveryTurns: AUTO_NAVIGATE_DEFAULT_TURNS,
  minTokensSinceAnchor: AUTO_NAVIGATE_DEFAULT_MIN_TOKENS,
  rewindAtTokens: AUTO_NAVIGATE_DEFAULT_REWIND_TOKENS,
  milestonePolicy: RECOMMENDED_MILESTONE_CLASSIFIER,
  tools: {},
};

const KNOWN_KEYS = new Set([
  "enabled",
  "mode",
  "pressure",
  "keep_recent_share",
  "check_every_turns",
  "min_tokens_since_anchor",
  "rewind_at_tokens",
  "milestone",
  "tools",
]);

function parseShare(value: unknown, where: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE ||
    value > AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE
  ) {
    throw new Error(
      `${where} must be a number ${AUTO_NAVIGATE_MIN_KEEP_RECENT_SHARE}-${AUTO_NAVIGATE_MAX_KEEP_RECENT_SHARE}`,
    );
  }
  return value;
}

function parsePositiveInt(
  value: unknown,
  min: number,
  max: number,
  where: string,
): number {
  const num =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (
    typeof num !== "number" ||
    !Number.isInteger(num) ||
    num < min ||
    num > max
  ) {
    throw new Error(`${where} must be an integer ${min}-${max}`);
  }
  return num;
}

/** Parse an `auto_navigate` object strictly (`snake_case` keys, or boolean shorthand). */
export function parseAutoNavigatePartial(
  raw: unknown,
  where = "auto_navigate",
): AutoNavigatePartial {
  if (typeof raw === "boolean") {
    return { enabled: raw };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object or boolean`);
  }
  const record = raw as Record<string, unknown>;
  // Removed in favour of `milestone`; ignored here so the rest of the layer survives.
  // The config loader reports it once with its replacement.
  const LEGACY_KEYS = new Set(["controller_model"]);
  for (const key of Object.keys(record)) {
    if (LEGACY_KEYS.has(key)) continue;
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`Unknown ${where} field: ${key}`);
    }
  }
  let enabled: boolean | undefined;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      throw new Error(`${where}.enabled must be a boolean`);
    }
    enabled = record.enabled;
  }
  let mode: AutoNavigateMode | undefined;
  if (record.mode !== undefined) {
    if (record.mode !== "anchor-only" && record.mode !== "anchor-and-rewind") {
      throw new Error(
        `${where}.mode must be "anchor-only" or "anchor-and-rewind"`,
      );
    }
    mode = record.mode;
  }
  let pressure: "compact" | "fold" | undefined;
  if (record.pressure !== undefined) {
    if (record.pressure !== "compact" && record.pressure !== "fold") {
      throw new Error(`${where}.pressure must be "compact" or "fold"`);
    }
    pressure = record.pressure;
  }
  const keepRecentShare =
    record.keep_recent_share !== undefined
      ? parseShare(record.keep_recent_share, `${where}.keep_recent_share`)
      : undefined;
  const checkEveryTurns =
    record.check_every_turns !== undefined
      ? parsePositiveInt(
          record.check_every_turns,
          AUTO_NAVIGATE_MIN_TURNS,
          AUTO_NAVIGATE_MAX_TURNS,
          `${where}.check_every_turns`,
        )
      : undefined;
  const minTokensSinceAnchor =
    record.min_tokens_since_anchor !== undefined
      ? parsePositiveInt(
          record.min_tokens_since_anchor,
          AUTO_NAVIGATE_MIN_TOKENS,
          AUTO_NAVIGATE_MAX_TOKENS,
          `${where}.min_tokens_since_anchor`,
        )
      : undefined;
  const rewindAtTokens =
    record.rewind_at_tokens !== undefined
      ? parsePositiveInt(
          record.rewind_at_tokens,
          AUTO_NAVIGATE_MIN_TOKENS,
          AUTO_NAVIGATE_MAX_TOKENS,
          `${where}.rewind_at_tokens`,
        )
      : undefined;
  let milestonePolicy: string | null | undefined;
  if ("milestone" in record) {
    const value = record.milestone;
    if (value === null) {
      milestonePolicy = null;
    } else if (value === RECOMMENDED_MILESTONE_CLASSIFIER) {
      milestonePolicy = RECOMMENDED_MILESTONE_CLASSIFIER;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const parsed = parseMilestonePolicyObject(value);
      if (!parsed.ok) throw new Error(parsed.problems.join("; "));
      milestonePolicy = parsed.canonical;
    } else {
      throw new Error(
        `${where}.milestone must be null, "${RECOMMENDED_MILESTONE_CLASSIFIER}", or a policy object`,
      );
    }
  }
  let tools: Readonly<Record<string, ProposalToolMode>> | undefined;
  if (record.tools !== undefined) {
    if (
      typeof record.tools !== "object" ||
      record.tools === null ||
      Array.isArray(record.tools)
    ) {
      throw new Error(
        `${where}.tools must map exact tool names to full, calls-only or omit`,
      );
    }
    const parsedTools: Record<string, ProposalToolMode> = {};
    for (const [name, toolMode] of Object.entries(record.tools)) {
      if (
        !name.trim() ||
        (toolMode !== "full" &&
          toolMode !== "calls-only" &&
          toolMode !== "omit")
      ) {
        throw new Error(
          `Invalid ${where}.tools[${JSON.stringify(name)}]: expected full, calls-only or omit`,
        );
      }
      Object.defineProperty(parsedTools, name, {
        value: toolMode,
        enumerable: true,
      });
    }
    tools = parsedTools;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(pressure !== undefined ? { pressure } : {}),
    ...(keepRecentShare !== undefined ? { keepRecentShare } : {}),
    ...(checkEveryTurns !== undefined ? { checkEveryTurns } : {}),
    ...(minTokensSinceAnchor !== undefined ? { minTokensSinceAnchor } : {}),
    ...(rewindAtTokens !== undefined ? { rewindAtTokens } : {}),
    ...(milestonePolicy !== undefined ? { milestonePolicy } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

/** Merge two `auto_navigate` partial layers (`override` wins per field and tool). */
export function mergeAutoNavigatePartial(
  base: AutoNavigatePartial | undefined,
  override: AutoNavigatePartial | undefined,
): AutoNavigatePartial | undefined {
  if (!base && !override) return undefined;
  const b = base ?? {};
  const o = override ?? {};
  const mergedTools =
    b.tools || o.tools ? { ...(b.tools ?? {}), ...(o.tools ?? {}) } : undefined;
  const enabled = o.enabled ?? b.enabled;
  const mode = o.mode ?? b.mode;
  const pressure = o.pressure ?? b.pressure;
  const keepRecentShare = o.keepRecentShare ?? b.keepRecentShare;
  const checkEveryTurns = o.checkEveryTurns ?? b.checkEveryTurns;
  const minTokensSinceAnchor = o.minTokensSinceAnchor ?? b.minTokensSinceAnchor;
  const rewindAtTokens = o.rewindAtTokens ?? b.rewindAtTokens;
  const milestonePolicy =
    o.milestonePolicy !== undefined ? o.milestonePolicy : b.milestonePolicy;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(pressure !== undefined ? { pressure } : {}),
    ...(keepRecentShare !== undefined ? { keepRecentShare } : {}),
    ...(checkEveryTurns !== undefined ? { checkEveryTurns } : {}),
    ...(minTokensSinceAnchor !== undefined ? { minTokensSinceAnchor } : {}),
    ...(rewindAtTokens !== undefined ? { rewindAtTokens } : {}),
    ...(milestonePolicy !== undefined ? { milestonePolicy } : {}),
    ...(mergedTools !== undefined ? { tools: mergedTools } : {}),
  };
}

/** Materialize a partial `auto_navigate` config against defaults and proposal disclosure rules. */
export function materializeAutoNavigateConfig(
  partial: AutoNavigatePartial | undefined,
  fallbackProposal?: ProposalOptions,
): AutoNavigateConfig {
  const mergedTools = mergeProposalOptions(fallbackProposal ?? { tools: {} }, {
    tools: partial?.tools ?? {},
  }).tools;
  return {
    enabled: partial?.enabled ?? DEFAULT_AUTO_NAVIGATE_CONFIG.enabled,
    mode: partial?.mode ?? DEFAULT_AUTO_NAVIGATE_CONFIG.mode,
    pressure: partial?.pressure ?? DEFAULT_AUTO_NAVIGATE_CONFIG.pressure,
    keepRecentShare:
      partial?.keepRecentShare ?? DEFAULT_AUTO_NAVIGATE_CONFIG.keepRecentShare,
    checkEveryTurns:
      partial?.checkEveryTurns ?? DEFAULT_AUTO_NAVIGATE_CONFIG.checkEveryTurns,
    minTokensSinceAnchor:
      partial?.minTokensSinceAnchor ??
      DEFAULT_AUTO_NAVIGATE_CONFIG.minTokensSinceAnchor,
    rewindAtTokens:
      partial?.rewindAtTokens ?? DEFAULT_AUTO_NAVIGATE_CONFIG.rewindAtTokens,
    milestonePolicy:
      partial?.milestonePolicy !== undefined
        ? partial.milestonePolicy
        : DEFAULT_AUTO_NAVIGATE_CONFIG.milestonePolicy,
    tools: mergedTools,
  };
}

/**
 * True when `pattern` is a wildcard model selector (`*` or `?`), or a bare
 * model slug without `/` (which matches any provider serving that model id,
 * or any model id containing that bare slug when wildcarded).
 */
export function isWildcardModelPattern(pattern: string): boolean {
  return (
    pattern.includes("*") || pattern.includes("?") || !pattern.includes("/")
  );
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Match a `model_overrides` key against `modelKey` (`provider/modelId`).
 *
 * - Exact `provider/modelId` keys match identically.
 * - A bare key without `/` and without `*`/`?` (e.g. `"gemini-4-argon"`)
 *   matches when the bare `modelId` or last `/` segment equals the key.
 * - A glob key with `*` or `?`:
 *   - If it contains `/`, it is matched against the full `provider/modelId`.
 *   - If it has no `/`, it is matched against both the full `provider/modelId`
 *     and the bare `modelId` (and if it neither starts nor ends with `*`,
 *     `*pattern*` is also matched so `"gemini-4-argon"` or `"*gemini-4-argon*"`
 *     matches `openrouter/google/gemini-4-argon` and `google/gemini-4-argon`).
 */
export function matchesModelPattern(
  pattern: string,
  modelKey: string,
): boolean {
  if (pattern === modelKey) return true;
  const slash = modelKey.indexOf("/");
  const modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
  const lastSegment = modelKey.slice(modelKey.lastIndexOf("/") + 1);
  if (!pattern.includes("*") && !pattern.includes("?")) {
    if (!pattern.includes("/")) {
      return modelId === pattern || lastSegment === pattern;
    }
    return false;
  }
  const re = globToRegExp(pattern);
  if (pattern.includes("/")) {
    return re.test(modelKey) || re.test(modelId);
  }
  return re.test(modelKey) || re.test(modelId) || re.test(lastSegment);
}

/** Specificity score for deterministic wildcard ranking (higher wins). */
export function modelPatternSpecificity(
  pattern: string,
  modelKey: string,
): number {
  if (pattern === modelKey) return 1_000_000 + pattern.length;
  const slash = modelKey.indexOf("/");
  const modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
  const lastSegment = modelKey.slice(modelKey.lastIndexOf("/") + 1);
  if (!pattern.includes("*") && !pattern.includes("?")) {
    if (modelId === pattern) return 500_000 + pattern.length;
    if (lastSegment === pattern) return 400_000 + pattern.length;
  }
  const literalLen = pattern.replace(/[*?]/g, "").length;
  const hasSlash = pattern.includes("/") ? 10_000 : 0;
  return hasSlash + literalLen * 100 - (pattern.split("*").length - 1);
}
