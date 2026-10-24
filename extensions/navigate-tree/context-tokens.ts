import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  convertToLlm,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";

type Usage = Parameters<typeof calculateContextTokens>[0];

function validAssistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const assistant = message as {
    stopReason?: string;
    usage?: Usage;
  };
  if (
    assistant.stopReason !== "aborted" &&
    assistant.stopReason !== "error" &&
    assistant.usage &&
    calculateContextTokens(assistant.usage) > 0
  ) {
    return assistant.usage;
  }
  return undefined;
}

/** Split a baseline-safe projection into recorded usage and its estimated tail. */
export function splitContextEstimate(messages: AgentMessage[]): {
  baseline: number;
  tail: number;
} {
  const anchor = newestUsageIndex(messages);
  const usage = anchor >= 0 ? validAssistantUsage(messages[anchor]) : undefined;
  const currentSystem =
    anchor < 0 ? getCurrentSystemMessage(messages) : undefined;
  let tail = currentSystem ? estimateTokens(currentSystem) : 0;
  for (let j = anchor + 1; j < messages.length; j++) {
    if (anchor < 0 && messages[j].role === "system") continue;
    tail += estimateTokens(messages[j]);
  }
  return {
    baseline: usage ? calculateContextTokens(usage) : 0,
    tail,
  };
}

/** Find the newest valid usage in messages whose stale baselines have been invalidated. */
export function newestUsageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (validAssistantUsage(messages[i])) return i;
  }
  return -1;
}

/** Compare projected content on one heuristic without historical usage baselines. */
export function estimateContentTokens(messages: AgentMessage[]): number {
  const system = getCurrentSystemMessage(messages);
  return (
    (system ? estimateTokens(system) : 0) +
    messages.reduce(
      (sum, message) =>
        sum + (message.role === "system" ? 0 : estimateTokens(message)),
      0,
    )
  );
}

/**
 * The admission estimate, shaped like the SDK's own pre-request estimate: the
 * newest valid usage plus the estimated messages after it, or all messages when
 * no baseline survives invalidation (a later compaction, context edit, system
 * message or model change). Estimated text is scaled by `factor`: the SDK's
 * 3.5 chars/token over the host's four by default, or what the model measured.
 */
export function estimateRequestTokens(
  messages: AgentMessage[],
  factor = DEFAULT_TOKEN_FACTOR,
): number {
  const converted = convertToLlm(messages);
  const anchor = newestUsageIndex(converted);
  const usage =
    anchor >= 0 ? validAssistantUsage(converted[anchor]) : undefined;
  const tail = converted
    .slice(anchor + 1)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
  return (usage ? calculateContextTokens(usage) : 0) + Math.ceil(tail * factor);
}

/** The SDK's 3.5 chars/token over the host heuristic's four. */
export const DEFAULT_TOKEN_FACTOR = 8 / 7;

/** Pi's four-chars-per-token estimate of a whole request, ignoring usage. */
export function estimateRawRequestTokens(messages: AgentMessage[]): number {
  return convertToLlm(messages).reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
}

/**
 * Tokens per heuristic token a model reported for a request, bounded so a
 * measurement only ever raises estimates, and never absurdly. Dense code and
 * JSON cost far more than four chars per token on some tokenizers.
 */
export function measuredTokenFactor(
  actualInput: number,
  heuristic: number,
): number | undefined {
  if (!(heuristic >= MIN_CALIBRATION_TOKENS) || !(actualInput > 0))
    return undefined;
  return Math.min(
    MAX_TOKEN_FACTOR,
    Math.max(DEFAULT_TOKEN_FACTOR, actualInput / heuristic),
  );
}

const MIN_CALIBRATION_TOKENS = 2_000;
const MAX_TOKEN_FACTOR = 4;

/** Estimate projected context with Pi's heuristic and the effective system state. */
export function estimateContextTokens(messages: AgentMessage[]): number {
  const { baseline, tail } = splitContextEstimate(messages);
  return baseline + tail;
}
