/**
 * Production provider overflow recovery through the real SDK loop and a local provider.
 * The lifecycle stand-in is not this test: the production extension, engine, and
 * registry side-call summarizer run here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import navigateTree, { estimateAdmissionTokens } from "./index.ts";

const WINDOW = 32_000;
const RESERVE = 1_024 + 4_096;
const REQUEST = "preserve-9f3c2a answer this exact request";
const EVIDENCE = "FOLDED-EVIDENCE-";
const TOOL_EVIDENCE = "unmodified-local-tool-result-7b2e";
const SUMMARY = `## Goal
Continue the preserved request.

## Progress
### Done
- [x] Collapsed the seeded branch.
`;

interface RecordedCall {
  side: boolean;
  aborted: boolean;
  tokens: number;
  text: string;
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if ("text" in block && typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

function callTokens(messages: readonly { content?: unknown }[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

function summaryReply(): AssistantMessage {
  return fauxAssistantMessage(SUMMARY);
}

function abortedReply(): AssistantMessage {
  return fauxAssistantMessage([], {
    stopReason: "aborted",
    errorMessage: "aborted",
  });
}

async function withSession(
  mode:
    | "recover"
    | "cancel"
    | "no-anchor"
    | "repeat-error"
    | "unrelated"
    | "side-failure"
    | "aborted"
    | "lost-receipt",
  run: (harness: {
    sm: SessionManager;
    prompt: (text: string) => Promise<string | undefined>;
    calls: RecordedCall[];
    abort: () => Promise<void>;
    sideStarted: Promise<void>;
  }) => Promise<void>,
  stopReason: "error" | "length" | "stop" = "error",
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-recovery-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  const cwd = join(dir, "work");
  const api = `mock-api-${mode}`;
  const faux = createFauxCore({
    api,
    provider: "mock",
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        reasoning: false,
        input: ["text"],
        contextWindow: WINDOW,
        maxTokens: 8_000,
      },
    ],
  });
  const calls: RecordedCall[] = [];
  let markSideStarted = () => {};
  const sideStarted = new Promise<void>((resolve) => {
    markSideStarted = resolve;
  });
  const streamSimple = (
    _model: Parameters<typeof faux.streamSimple>[0],
    context: Parameters<typeof faux.streamSimple>[1],
    options: Parameters<typeof faux.streamSimple>[2],
  ) => {
    const side = options?.toolChoice === "none";
    const text = (context.messages ?? [])
      .map((message) => messageText(message))
      .join("\n");
    calls.push({
      side,
      aborted: options?.signal?.aborted === true,
      tokens: callTokens(context.messages ?? []),
      text,
    });
    if (side && mode === "cancel") {
      markSideStarted();
      const stream = createAssistantMessageEventStream();
      const finish = () => stream.end(abortedReply());
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish, { once: true });
      return stream;
    }
    const stream = createAssistantMessageEventStream();
    const mainCount = calls.filter((call) => !call.side).length;
    let reply = side
      ? summaryReply()
      : fauxAssistantMessage("recovered answer");
    if (side && mode === "side-failure") {
      reply = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "local summary failure",
      });
    } else if (!side && (mainCount === 1 || mode === "repeat-error")) {
      reply =
        mode === "aborted"
          ? abortedReply()
          : fauxAssistantMessage(
              stopReason === "stop" && mode !== "unrelated"
                ? "Successful overflow evidence 8e19"
                : [],
              {
                stopReason: mode === "unrelated" ? "error" : stopReason,
                errorMessage:
                  mode === "unrelated"
                    ? "authentication failed"
                    : "prompt is too long: 40000 tokens > 32000 maximum",
              },
            );
    }
    reply = { ...reply, provider: "mock", model: "mock-1", api };
    if (!side && (mainCount === 1 || mode === "repeat-error")) {
      reply = {
        ...reply,
        usage: { ...reply.usage, input: 40_000, totalTokens: 40_000 },
      };
    }
    queueMicrotask(() => stream.end(reply));
    return stream;
  };
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  runtime.registerProvider("mock", {
    baseUrl: "http://127.0.0.1:0",
    apiKey: "mock-key",
    api,
    streamSimple,
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: WINDOW,
        maxTokens: 8_000,
      },
    ],
  });
  const model = runtime.getModel("mock", "mock-1");
  if (!model) throw new Error("mock model was not registered");
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    defaultThinkingLevel: "off",
  });
  const sm = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      navigateTree,
      (pi) => {
        if (mode === "lost-receipt") {
          pi.on("turn_end", () => ({ entries: [] }));
          pi.on("agent_before_settle", () => ({ entries: [] }));
        }
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a test agent.",
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) {
    throw new Error(JSON.stringify(loadErrors));
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    tools: ["navigate_tree"],
    resourceLoader: loader,
    sessionManager: sm,
    settingsManager: settings,
  });
  await session.bindExtensions({
    mode: "json",
    abortHandler: () => {
      void session.abort();
    },
  });
  try {
    const anchor = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed the anchor" }],
      timestamp: 1,
    } as never);
    const anchored = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "anchor reply" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
    if (mode !== "no-anchor" && mode !== "lost-receipt")
      sm.appendLabelChange(anchored, "anchor:start");
    const filler = `${EVIDENCE}${"lorem ipsum ".repeat(800)}`;
    for (let guard = 0; guard < 3; guard++) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `${filler} user ${guard}` }],
        timestamp: 3 + guard,
      } as never);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `${filler} assistant ${guard}` }],
        stopReason: "stop",
        timestamp: 4 + guard,
      } as never);
    }
    assert.ok(
      estimateAdmissionTokens(sm) + RESERVE < WINDOW,
      "estimated input must fit",
    );
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "local-tool",
          name: "read",
          arguments: { path: "synthetic.txt" },
        },
      ],
      stopReason: "toolUse",
      timestamp: 20,
    } as never);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "local-tool",
      toolName: "read",
      content: [{ type: "text", text: TOOL_EVIDENCE }],
      isError: false,
      timestamp: 21,
    } as never);
    assert.notEqual(sm.getLeafId(), anchor);
    await run({
      sm,
      calls,
      sideStarted,
      abort: () => session.abort(),
      prompt: async (text) => {
        try {
          await session.prompt(text);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    await session.waitForIdle();
  } finally {
    try {
      session.dispose();
    } catch {
      // The temp directory is removed either way.
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(dir, { recursive: true, force: true });
  }
}

function userText(entry: {
  type: string;
  message?: { role?: string; content?: unknown };
}): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user")
    return undefined;
  return messageText(entry.message);
}

for (const stopReason of ["error", "length", "stop"] as const) {
  describe(`production provider overflow recovery (${stopReason})`, () => {
    const withRecoverySession = (...args: Parameters<typeof withSession>) =>
      withSession(args[0], args[1], stopReason);
    it("recovers a genuine overflow in the same SDK prompt with the exact unanswered request", async () => {
      await withRecoverySession("recover", async ({ sm, prompt, calls }) => {
        const archived = structuredClone(sm.getEntries());
        assert.equal(await prompt(REQUEST), undefined);
        const main = calls.filter((call) => !call.side);
        const side = calls.filter((call) => call.side);
        assert.equal(
          main.length,
          2,
          JSON.stringify(calls.map(({ side, tokens }) => ({ side, tokens }))),
        );
        assert.ok(side.length > 0 && side.length <= 16);
        assert.ok(main[0].tokens + RESERVE < WINDOW);
        assert.ok(main[1].tokens < main[0].tokens);
        assert.ok(side.some((call) => call.text.includes(EVIDENCE)));
        assert.ok(side.some((call) => call.text.includes(TOOL_EVIDENCE)));
        assert.ok(main[0].text.includes(TOOL_EVIDENCE));
        assert.equal(main[1].text.includes(TOOL_EVIDENCE), false);
        assert.equal(main[1].text.includes(EVIDENCE), false);
        assert.ok(main.every((call) => call.text.includes(REQUEST)));
        if (stopReason === "stop") {
          assert.ok(main[1].text.includes("Successful overflow evidence 8e19"));
          const evidence = sm
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                messageText(entry.message) ===
                  "Successful overflow evidence 8e19",
            );
          assert.equal(evidence.length, 2);
          assert.deepEqual(
            evidence.map((entry) =>
              entry.type === "message" && entry.message.role === "assistant"
                ? entry.message.usage.input
                : undefined,
            ),
            [40_000, 0],
          );
        }
        assert.equal(
          main.some((call) => /Rewind now|Output withheld/.test(call.text)),
          false,
        );
        const branch = sm.getBranch();
        const summaryAt = branch.findIndex(
          (entry) => entry.type === "branch_summary",
        );
        assert.ok(summaryAt >= 0);
        assert.deepEqual(
          branch
            .slice(summaryAt + 1)
            .map(userText)
            .filter((text) => text !== undefined),
          [REQUEST],
        );
        for (const entry of archived)
          assert.deepEqual(sm.getEntry(entry.id), entry);
        assert.equal(
          sm.getEntries().some((entry) => entry.type === "context_edit"),
          stopReason === "length",
        );
      });
    });

    it("does not loop when the next main request also overflows", async () => {
      await withRecoverySession(
        "repeat-error",
        async ({ sm, prompt, calls }) => {
          await prompt(REQUEST);
          assert.equal(calls.filter((call) => !call.side).length, 2);
          assert.equal(
            sm.getBranch().filter((entry) => entry.type === "branch_summary")
              .length,
            1,
          );
          const failed = sm
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "navigate-tree-rewind" &&
                JSON.stringify(entry.details).includes('"failed"'),
            );
          assert.equal(failed.length, 1);
          assert.match(
            JSON.stringify(failed),
            /already attempted|already.*recovery/,
          );
        },
      );
    });

    for (const mode of ["unrelated", "aborted"] as const) {
      it(`does not recover ${mode} provider results`, async () => {
        await withRecoverySession(mode, async ({ sm, prompt, calls }) => {
          await prompt(REQUEST);
          assert.equal(calls.length, 1);
          assert.equal(
            sm.getBranch().some((entry) => entry.type === "branch_summary"),
            false,
          );
        });
      });
    }

    it("honors Esc while the independent summarizer is running", async () => {
      await withRecoverySession(
        "cancel",
        async ({ sm, prompt, calls, sideStarted, abort }) => {
          const pending = prompt(REQUEST);
          await sideStarted;
          await abort();
          await pending;
          assert.equal(calls.filter((call) => !call.side).length, 1);
          assert.equal(
            sm.getBranch().some((entry) => entry.type === "branch_summary"),
            false,
          );
        },
      );
    });

    for (const mode of ["no-anchor", "side-failure", "lost-receipt"] as const) {
      it(`persists an actionable receipt after ${mode}`, async () => {
        await withRecoverySession(mode, async ({ sm, prompt, calls }) => {
          await prompt(REQUEST);
          assert.equal(calls.filter((call) => !call.side).length, 1);
          assert.equal(
            sm.getBranch().some((entry) => entry.type === "branch_summary"),
            false,
          );
          const receipts = sm
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "navigate-tree-rewind",
            );
          assert.equal(receipts.length, 1);
          assert.ok(calls.every((call) => call.text.includes(REQUEST)));
          assert.equal(
            sm
              .getBranch()
              .some((entry) => sm.getLabel(entry.id) === "anchor:start"),
            mode === "side-failure",
          );
          assert.match(JSON.stringify(receipts), /\/tree|\/compact/);
          assert.match(
            JSON.stringify(receipts),
            /No tool results were withheld/,
          );
        });
      });
    }
  });
}
