import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { constrainSummaryTools } from "./summary-request.ts";

const TOOLS = [{ type: "function", name: "navigate_tree" }];
const INPUT = [{ role: "user", content: "ctx" }];

function frozen<T>(value: T): T {
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return value;
}

describe("summary request tool constraint", () => {
  it("forces tool_choice none on the OpenAI-style APIs, keeping tools and input", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
    ]) {
      for (const existing of [undefined, "auto", "required", { type: "any" }]) {
        const payload = frozen({
          model: "m",
          input: INPUT,
          tools: TOOLS,
          ...(existing === undefined ? {} : { tool_choice: existing }),
        });
        const result = constrainSummaryTools(payload, api);
        assert.ok(result, `${api} ${JSON.stringify(existing)}`);
        assert.equal(result.tool_choice, "none");
        assert.equal(result.tools, TOOLS);
        assert.equal(result.input, INPUT);
        assert.equal(result.model, "m");
        assert.notEqual(result, payload);
        assert.equal(payload.tool_choice, existing);
      }
    }
  });

  it("forces tool_choice {type:none} on anthropic-messages", () => {
    const payload = frozen({
      model: "m",
      messages: INPUT,
      tools: TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    const result = constrainSummaryTools(payload, "anthropic-messages");
    assert.deepEqual(result, { ...payload, tool_choice: { type: "none" } });
    assert.equal(result?.tools, TOOLS);
    assert.equal(result?.messages, INPUT);
    assert.deepEqual(
      constrainSummaryTools(
        { messages: INPUT, tools: TOOLS },
        "anthropic-messages",
      ),
      { messages: INPUT, tools: TOOLS, tool_choice: { type: "none" } },
    );
  });

  it("sets the Google function calling mode NONE and keeps valid siblings", () => {
    for (const api of ["google-generative-ai", "google-vertex"]) {
      const tools = [{ functionDeclarations: [{ name: "navigate_tree" }] }];
      const payload = frozen({
        model: "gemini",
        contents: INPUT,
        config: {
          systemInstruction: "rules",
          tools,
          toolConfig: {
            retrievalConfig: { languageCode: "en" },
            functionCallingConfig: {
              mode: "VALIDATED",
              streamFunctionCallArguments: true,
              allowedFunctionNames: ["navigate_tree"],
            },
          },
        },
      });
      const result = constrainSummaryTools(payload, api);
      assert.deepEqual(result, {
        model: "gemini",
        contents: INPUT,
        config: {
          systemInstruction: "rules",
          tools,
          toolConfig: {
            retrievalConfig: { languageCode: "en" },
            functionCallingConfig: {
              mode: "NONE",
              streamFunctionCallArguments: true,
            },
          },
        },
      });
      assert.equal((result?.config as { tools: unknown }).tools, tools);
      assert.equal(result?.contents, INPUT);
      assert.equal(
        (payload.config.toolConfig.functionCallingConfig as { mode: string })
          .mode,
        "VALIDATED",
      );
    }
    assert.deepEqual(
      constrainSummaryTools(
        { config: { tools: [{ functionDeclarations: [] }] } },
        "google-generative-ai",
      ),
      {
        config: {
          tools: [{ functionDeclarations: [] }],
          toolConfig: { functionCallingConfig: { mode: "NONE" } },
        },
      },
    );
    assert.deepEqual(
      constrainSummaryTools(
        {
          config: {
            tools: [{}],
            toolConfig: { includeServerSideToolInvocations: true },
          },
        },
        "google-vertex",
      ),
      {
        config: {
          tools: [{}],
          toolConfig: {
            includeServerSideToolInvocations: true,
            functionCallingConfig: { mode: "NONE" },
          },
        },
      },
    );
  });

  it("rejects malformed Google tool configuration instead of spreading it", () => {
    const tools = [{ functionDeclarations: [] }];
    for (const toolConfig of [null, [], "AUTO", 1, true]) {
      assert.equal(
        constrainSummaryTools(
          { config: { tools, toolConfig } },
          "google-generative-ai",
        ),
        undefined,
        JSON.stringify(toolConfig),
      );
    }
    for (const functionCallingConfig of [null, [], "NONE", 0, false]) {
      assert.equal(
        constrainSummaryTools(
          { config: { tools, toolConfig: { functionCallingConfig } } },
          "google-vertex",
        ),
        undefined,
        JSON.stringify(functionCallingConfig),
      );
    }
    for (const config of [null, [], "x", undefined]) {
      assert.equal(
        constrainSummaryTools({ config }, "google-generative-ai"),
        undefined,
      );
    }
  });

  it("leaves requests without declared tools unchanged", () => {
    for (const tools of [undefined, null, [], {}, "navigate_tree"]) {
      for (const api of [
        "openai-completions",
        "openai-responses",
        "azure-openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
      ]) {
        assert.equal(
          constrainSummaryTools({ input: INPUT, tools }, api),
          undefined,
          `${api} ${JSON.stringify(tools)}`,
        );
      }
      for (const api of ["google-generative-ai", "google-vertex"]) {
        assert.equal(
          constrainSummaryTools({ config: { tools } }, api),
          undefined,
          `${api} ${JSON.stringify(tools)}`,
        );
      }
    }
    assert.equal(
      constrainSummaryTools({ tools: TOOLS }, "google-vertex"),
      undefined,
      "Google tools live under config",
    );
  });

  it("returns undefined when the request already asks for text only", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
    ]) {
      assert.equal(
        constrainSummaryTools({ tools: TOOLS, tool_choice: "none" }, api),
        undefined,
      );
    }
    assert.equal(
      constrainSummaryTools(
        { tools: TOOLS, tool_choice: { type: "none" } },
        "anthropic-messages",
      ),
      undefined,
    );
    assert.equal(
      constrainSummaryTools(
        {
          config: {
            tools: [{}],
            toolConfig: { functionCallingConfig: { mode: "NONE" } },
          },
        },
        "google-generative-ai",
      ),
      undefined,
    );
  });

  it("leaves unsupported APIs and non-object payloads unchanged", () => {
    for (const api of [
      "bedrock-converse-stream",
      "mistral-conversations",
      "pi-messages",
      "anthropic",
      "",
    ]) {
      assert.equal(
        constrainSummaryTools({ tools: TOOLS, toolConfig: {} }, api),
        undefined,
        api,
      );
    }
    for (const payload of [undefined, null, [], "x", 1, [{ tools: TOOLS }]]) {
      assert.equal(
        constrainSummaryTools(payload, "openai-responses"),
        undefined,
      );
    }
  });
});
