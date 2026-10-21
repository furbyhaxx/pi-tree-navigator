import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capRecoveryOutput } from "./output-budget.ts";

describe("recovery output reservation", () => {
  it("caps only explicit OpenAI-compatible output fields without mutating the request", () => {
    for (const field of [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
    ]) {
      const payload = {
        [field]: 914_703,
        messages: ["unchanged"],
        reasoning: { effort: "medium" },
      };
      const capped = capRecoveryOutput(payload, 32_768);
      assert.deepEqual(capped, { ...payload, [field]: 32_768 });
      assert.equal(payload[field], 914_703);
    }
    assert.equal(capRecoveryOutput({ max_tokens: 1024 }, 32_768), undefined);
    assert.equal(capRecoveryOutput({ messages: [] }, 32_768), undefined);
    assert.equal(capRecoveryOutput(null, 32_768), undefined);
    assert.equal(capRecoveryOutput({ max_tokens: "90000" }, 32_768), undefined);
  });

  it("does not bypass the Responses minimum or change templated numeric budgets", () => {
    assert.equal(
      capRecoveryOutput({ max_output_tokens: 90_000 }, 1),
      undefined,
    );
    assert.equal(
      capRecoveryOutput(
        { max_tokens: 90_000, chat_template_args: { thinking_budget: 40_000 } },
        32_768,
      ),
      undefined,
    );
    const payload = {
      max_tokens: 90_000,
      chat_template_kwargs: { enable_thinking: true },
    };
    assert.deepEqual(capRecoveryOutput(payload, 32_768), {
      ...payload,
      max_tokens: 32_768,
    });
  });

  it("does not invalidate explicit thinking budgets", () => {
    const payload = {
      max_tokens: 90_000,
      thinking: { type: "enabled", budget_tokens: 40_000 },
    };
    assert.equal(capRecoveryOutput(payload, 32_768), undefined);
    assert.equal(
      capRecoveryOutput(
        { max_tokens: 90_000, reasoning: { max_tokens: 40_000 } },
        32_768,
      ),
      undefined,
    );
    assert.equal(
      capRecoveryOutput(
        { max_tokens: 90_000, thinking_token_budget: 40_000 },
        32_768,
      ),
      undefined,
    );
  });
});
