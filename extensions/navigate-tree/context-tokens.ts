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

/** Estimate request headroom conservatively against the SDK's denser text heuristic. */
export function estimateRequestTokens(messages: AgentMessage[]): number {
  const converted = convertToLlm(messages);
  const anchor = newestUsageIndex(converted);
  const usage =
    anchor >= 0 ? validAssistantUsage(converted[anchor]) : undefined;
  const tail = converted
    .slice(anchor + 1)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
  const content = converted.reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
  // Host estimates use four chars/token; the SDK's text heuristic uses 3.5.
  return Math.max(
    Math.ceil((content * 8) / 7),
    (usage ? calculateContextTokens(usage) : 0) + Math.ceil((tail * 8) / 7),
  );
}

/** Estimate projected context with Pi's heuristic and the effective system state. */
export function estimateContextTokens(messages: AgentMessage[]): number {
  const { baseline, tail } = splitContextEstimate(messages);
  return baseline + tail;
}
