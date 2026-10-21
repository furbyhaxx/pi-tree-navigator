const OUTPUT_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Lower explicit output reservations without changing an explicit thinking budget. */
export function capRecoveryOutput(
  payload: unknown,
  cap: number,
): Record<string, unknown> | undefined {
  const body = record(payload);
  if (!body || !Number.isSafeInteger(cap) || cap < 1) return undefined;
  if (body.max_output_tokens !== undefined && cap < 16) return undefined;
  for (const field of ["chat_template_args", "chat_template_kwargs"]) {
    if (body[field] === undefined) continue;
    const template = record(body[field]);
    if (
      !template ||
      Object.values(template).some((value) => typeof value !== "boolean")
    )
      return undefined;
  }
  // Numeric reasoning budgets need adapter-specific answer-room validation.
  if (
    record(body.thinking)?.budget_tokens !== undefined ||
    record(body.reasoning)?.max_tokens !== undefined ||
    body.thinking_token_budget !== undefined
  ) {
    return undefined;
  }
  let result: Record<string, unknown> | undefined;
  for (const field of OUTPUT_FIELDS) {
    const value = body[field];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > cap
    ) {
      result ??= { ...body };
      result[field] = cap;
    }
  }
  return result;
}
