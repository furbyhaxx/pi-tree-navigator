import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Text from a tool that a proposal model may receive. */
export type ProposalToolMode = "full" | "calls-only" | "omit";

/** Explicit disclosure and model selection for tree proposals. */
export interface ProposalOptions {
  readonly model?: string;
  readonly tools: Readonly<Record<string, ProposalToolMode>>;
}

/** A provider/model selector with an optional thinking-level override. */
export interface ProposalModelSelection {
  readonly provider: string;
  readonly id: string;
  readonly thinking?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Parse an exact provider/model:thinking selector; current uses the live model. */
export function parseProposalModel(
  value: string,
): ProposalModelSelection | undefined {
  if (value === "current") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value))
    throw new Error(
      "Proposal model must be current or provider/model[:thinking]",
    );
  const provider = value.slice(0, slash);
  const remainder = value.slice(slash + 1);
  const colon = remainder.lastIndexOf(":");
  if (colon < 0) return { provider, id: remainder };
  const id = remainder.slice(0, colon);
  const thinking = remainder.slice(colon + 1);
  const level = THINKING_LEVELS.find((level) => level === thinking);
  if (!id || !level)
    throw new Error(
      `Invalid proposal thinking level: ${thinking}. Expected ${THINKING_LEVELS.join(", ")}`,
    );
  return { provider, id, thinking: level };
}

/** Parse proposal settings strictly; invalid disclosure rules must never be ignored. */
export function parseProposalOptions(raw: unknown): ProposalOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("treeProposal must be an object");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (key !== "model" && key !== "tools")
      throw new Error(`Unknown treeProposal field: ${key}`);
  if (value.model !== undefined) {
    if (typeof value.model !== "string")
      throw new Error(
        "treeProposal.model must be current or provider/model[:thinking]",
      );
    parseProposalModel(value.model);
  }
  const tools: Record<string, ProposalToolMode> = {};
  if (value.tools !== undefined) {
    if (
      typeof value.tools !== "object" ||
      value.tools === null ||
      Array.isArray(value.tools)
    )
      throw new Error(
        "treeProposal.tools must map exact tool names to full, calls-only or omit",
      );
    for (const [name, mode] of Object.entries(value.tools)) {
      if (
        !name.trim() ||
        (mode !== "full" && mode !== "calls-only" && mode !== "omit")
      )
        throw new Error(
          `Invalid treeProposal.tools[${JSON.stringify(name)}]: expected full, calls-only or omit`,
        );
      Object.defineProperty(tools, name, { value: mode, enumerable: true });
    }
  }
  return {
    ...(value.model === undefined ? {} : { model: value.model as string }),
    tools,
  };
}

/** Merge project/command overrides per tool name, preserving undisputed disclosure rules. */
export function mergeProposalOptions(
  base: ProposalOptions,
  override: Partial<ProposalOptions>,
): ProposalOptions {
  return {
    model: override.model ?? base.model,
    tools: { ...base.tools, ...override.tools },
  };
}
