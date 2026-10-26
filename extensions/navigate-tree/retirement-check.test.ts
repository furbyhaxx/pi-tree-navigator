/**
 * Tests for the retirement check request and its two call paths.
 * Node test runner. Run with: pnpm test
 */

import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type {
  Api,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { chatAsk, classifierAsk } from "./intent-policy.ts";
import {
  buildRetirementCheckContext,
  RETIREMENT_QUESTION,
  retirementConfirmed,
} from "./retirement-check.ts";

const ITEM = { id: "R2", kind: "rule", text: "Always use pnpm." };
const OTHER = { id: "D1", kind: "decision", text: "Use Postgres." };
const MESSAGE = "We switch to bun, pnpm is out.";

const choiceQuestion = (context: ClassifierContext) => {
  const question = context.questions[RETIREMENT_QUESTION];
  assert.equal(question?.type, "choice");
  return question as Extract<typeof question, { type: "choice" }>;
};

describe("buildRetirementCheckContext", () => {
  it("sends the message, the one item and the others, with a yes/no question", () => {
    const { context } = buildRetirementCheckContext({
      message: MESSAGE,
      item: ITEM,
      otherItems: [OTHER],
    });
    assert.deepEqual(context.state, {
      message: MESSAGE,
      item: ITEM,
      otherItems: [OTHER],
    });
    assert.deepEqual(Object.keys(context.questions), [RETIREMENT_QUESTION]);
    const question = choiceQuestion(context);
    assert.deepEqual(Object.keys(question.criteria), ["yes", "no"]);
    for (const word of ["replace", "refines", "exception"])
      assert.match(question.instructions, new RegExp(word));
  });

  it("omits otherItems when there are none", () => {
    for (const otherItems of [undefined, []]) {
      const { context } = buildRetirementCheckContext({
        message: MESSAGE,
        item: ITEM,
        ...(otherItems && { otherItems }),
      });
      assert.ok(!("otherItems" in (context.state as object)));
    }
  });

  it("flattens and bounds item text and message like the intent request", () => {
    const long = `${"x ".repeat(400)}\n  tail`;
    const { context } = buildRetirementCheckContext({
      message: "m".repeat(5_000),
      item: { ...ITEM, text: long },
      otherItems: [{ ...OTHER, text: long }],
    });
    const state = context.state as {
      message: string;
      item: { text: string };
      otherItems: { text: string }[];
    };
    assert.equal(state.message.length, 4_000);
    for (const text of [state.item.text, state.otherItems[0]?.text ?? ""]) {
      assert.ok(text.length <= 200);
      assert.doesNotMatch(text, /\s{2}|\n/);
    }
  });
});

describe("retirementConfirmed", () => {
  const answer = (choice: string, confidence: number) => ({
    [RETIREMENT_QUESTION]: { choice, confidence },
  });

  it("confirms only a confident yes", () => {
    assert.equal(retirementConfirmed(answer("yes", 0.7), 0.7), true);
    assert.equal(retirementConfirmed(answer("yes", 0.69), 0.7), false);
    assert.equal(retirementConfirmed(answer("no", 0.99), 0.7), false);
    assert.equal(retirementConfirmed({}, 0.7), false);
    assert.equal(retirementConfirmed(undefined, 0.7), false);
  });
});

describe("call paths of intent-policy.ts", () => {
  const { context } = buildRetirementCheckContext({
    message: MESSAGE,
    item: ITEM,
    otherItems: [OTHER],
  });

  it("classifierAsk returns the yes/no answer of a decision model", async () => {
    const calls: ClassifierContext[] = [];
    const registry = {
      classify: async (_model: unknown, sent: ClassifierContext) => {
        calls.push(sent);
        return {
          stopReason: "stop",
          answers: {
            [RETIREMENT_QUESTION]: {
              type: "choice",
              choice: "yes",
              confidence: 0.93,
            },
          },
        };
      },
    } as unknown as Pick<ModelRegistry, "classify">;
    const ask = classifierAsk(registry, {
      id: "acme/judge",
    } as ClassifierModel<ClassifierApi>);
    const answers = await ask(context);
    assert.deepEqual(calls, [context]);
    assert.equal(retirementConfirmed(answers, 0.7), true);
  });

  it("chatAsk offers only yes and no and reads the chat model's JSON answer", async () => {
    const sent: { prompt: string; payload: unknown }[] = [];
    const registry = {
      streamSimple: (
        _model: unknown,
        chat: { messages: { content: string }[] },
        options: { onPayload: (payload: unknown) => unknown },
      ) => {
        sent.push({
          prompt: chat.messages[0]?.content ?? "",
          payload: options.onPayload({ model: "m", tool_choice: "none" }),
        });
        return {
          result: async () => ({
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  answers: {
                    [RETIREMENT_QUESTION]: { choice: "no", confidence: 0.9 },
                  },
                }),
              },
            ],
          }),
        };
      },
    } as unknown as Pick<ModelRegistry, "streamSimple">;
    const ask = chatAsk(registry, {
      id: "acme/chat",
      api: "openai-completions",
    } as Model<Api>);
    const answers = await ask(context);
    assert.deepEqual(answers, {
      [RETIREMENT_QUESTION]: { choice: "no", confidence: 0.9 },
    });
    assert.equal(retirementConfirmed(answers, 0.7), false);
    assert.match(
      sent[0]?.prompt ?? "",
      /## retires\n.*\nChoices:\n- yes: .*\n- no: /s,
    );
    assert.match(sent[0]?.prompt ?? "", new RegExp(ITEM.text));
    const format = (
      sent[0]?.payload as {
        response_format: {
          json_schema: {
            schema: {
              properties: {
                answers: {
                  properties: {
                    retires: { properties: { choice: { enum: string[] } } };
                  };
                };
              };
            };
          };
        };
      }
    ).response_format;
    assert.deepEqual(
      format.json_schema.schema.properties.answers.properties.retires.properties
        .choice.enum,
      ["yes", "no"],
    );
  });

  it("chatAsk leaves an answer outside yes and no unanswered", async () => {
    const registry = {
      streamSimple: () => ({
        result: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: '{"answers":{"retires":{"choice":"maybe","confidence":0.99}}}',
            },
          ],
        }),
      }),
    } as unknown as Pick<ModelRegistry, "streamSimple">;
    const answers = await chatAsk(registry, {
      id: "acme/chat",
      api: "openai-completions",
    } as Model<Api>)(context);
    assert.deepEqual(answers, {});
    assert.equal(retirementConfirmed(answers, 0.7), false);
  });
});
