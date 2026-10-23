import type { Api } from "@earendil-works/pi-ai";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function declaresTools(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function constrainGoogle(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const config = record(body.config);
  if (!config || !declaresTools(config.tools)) return undefined;
  const toolConfig =
    config.toolConfig === undefined ? {} : record(config.toolConfig);
  if (!toolConfig) return undefined;
  const calling =
    toolConfig.functionCallingConfig === undefined
      ? {}
      : record(toolConfig.functionCallingConfig);
  if (!calling || calling.mode === "NONE") return undefined;
  // Gemini accepts allowedFunctionNames only together with mode ANY.
  const { allowedFunctionNames, ...siblings } = calling;
  return {
    ...body,
    config: {
      ...config,
      toolConfig: {
        ...toolConfig,
        functionCallingConfig: { ...siblings, mode: "NONE" },
      },
    },
  };
}

/**
 * A copy of the provider `payload` that asks `api` for a text-only reply while
 * the declared tools and the transcript stay as they are, or `undefined` when
 * the request must go out unchanged: unsupported API, no declared tools,
 * malformed tool configuration, or already text-only.
 */
export function constrainSummaryTools(
  payload: unknown,
  api: Api,
): Record<string, unknown> | undefined {
  const body = record(payload);
  if (!body) return undefined;
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      if (!declaresTools(body.tools) || body.tool_choice === "none") {
        return undefined;
      }
      return { ...body, tool_choice: "none" };
    case "anthropic-messages":
      if (
        !declaresTools(body.tools) ||
        record(body.tool_choice)?.type === "none"
      ) {
        return undefined;
      }
      return { ...body, tool_choice: { type: "none" } };
    case "google-generative-ai":
    case "google-vertex":
      return constrainGoogle(body);
    default:
      return undefined;
  }
}
