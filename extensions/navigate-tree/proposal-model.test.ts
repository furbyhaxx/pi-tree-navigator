import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createProposalModelRunner,
  resolveProposalModel,
} from "./proposal-model.ts";

const model: Model<Api> = {
  provider: "test",
  id: "proposal",
  name: "Proposal",
  api: "openai-completions",
  baseUrl: "http://localhost",
  reasoning: true,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 4000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function response(
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: '{"groups":[]}' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: 1,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...(stopReason === "error"
      ? { errorMessage: "test provider failure" }
      : {}),
  };
}

describe("proposal model adapter", () => {
  it("defaults to current model and thinking, with exact overrides and authentication checks", () => {
    const registry = {
      find: (provider: string, id: string) =>
        provider === "test" && id === "proposal" ? model : undefined,
      hasConfiguredAuth: () => true,
    };
    assert.deepEqual(
      resolveProposalModel({
        registry,
        currentModel: model,
        currentThinking: "medium",
      }),
      { model, thinking: "medium" },
    );
    assert.deepEqual(
      resolveProposalModel({
        registry,
        currentModel: undefined,
        currentThinking: "low",
        selector: "test/proposal:high",
      }),
      { model, thinking: "high" },
    );
    assert.throws(
      () =>
        resolveProposalModel({
          registry,
          currentModel: model,
          currentThinking: "low",
          selector: "test/missing:high",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        resolveProposalModel({
          registry: { ...registry, hasConfiguredAuth: () => false },
          currentModel: model,
          currentThinking: "low",
        }),
      /credentials/,
    );
  });

  it("uses provider-neutral thinking and no tools, session mutation or credential extraction", async () => {
    let observed: SimpleStreamOptions | undefined;
    const registry: Pick<ModelRegistry, "streamSimple"> = {
      streamSimple(actualModel, context, options) {
        assert.equal(actualModel, model);
        assert.equal(context.systemPrompt, "JSON proposal only");
        observed = options;
        const stream = createAssistantMessageEventStream();
        stream.end(response());
        return stream;
      },
    };
    const runner = createProposalModelRunner({
      registry,
      model,
      thinking: "high",
    });
    const reply = await runner.complete({
      systemPrompt: "JSON proposal only",
      text: "synthetic fixture",
    });
    assert.equal(reply.text, '{"groups":[]}');
    assert.equal(observed?.reasoning, "high");
    assert.equal(observed?.toolChoice, "none");
    assert.equal(observed?.maxTokens, 4000);
    assert.equal(reply.usage.input, 10);
  });

  it("does not accept provider errors, truncated plans or aborted replies as success", async () => {
    for (const stopReason of ["error", "length", "aborted"] as const) {
      const registry: Pick<ModelRegistry, "streamSimple"> = {
        streamSimple() {
          const stream = createAssistantMessageEventStream();
          stream.end(response(stopReason));
          return stream;
        },
      };
      await assert.rejects(
        createProposalModelRunner({
          registry,
          model,
          thinking: "off",
        }).complete({ systemPrompt: "JSON", text: "fixture" }),
      );
    }
    const controller = new AbortController();
    controller.abort();
    const registry: Pick<ModelRegistry, "streamSimple"> = {
      streamSimple() {
        throw new Error("must not call");
      },
    };
    await assert.rejects(
      createProposalModelRunner({ registry, model, thinking: "off" }).complete({
        systemPrompt: "JSON",
        text: "fixture",
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
  });
});
