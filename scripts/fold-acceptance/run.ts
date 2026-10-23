import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import navigateTree, {
  __testHooks,
  estimateAdmissionTokens,
} from "../../extensions/navigate-tree/index.ts";
import { safeMessage } from "../classifier-eval/adapters.ts";
import {
  createBilling,
  loadRouteTable,
  ROUTE_PRICES_URL,
} from "../classifier-eval/billing.ts";
import { BudgetLedger } from "../classifier-eval/budget.ts";
import { buildCorpus, corpusManifest, FACTS, seedCorpus } from "./fixture.ts";
import { createBudgetedTransport } from "./transport.ts";

/** Acceptance scenarios: independent idle folding and recovery before dispatch. */
export type Scenario = "manual" | "preflight" | "agent";
/** Options contain no credentials; they are safe to persist with the result. */
export interface RunOptions {
  scenario: Scenario;
  model: string;
  window: number;
  blocks: number;
  out: string;
  ledger: string;
  authDir: string;
  dryRun: boolean;
}

const REQUEST =
  "UNANSWERED-ACCEPTANCE-7d9a: Reply with ACCEPTANCE-CONTINUED and the audit's remaining work. Do not deploy or change any files.";
const textOf = (message: { role?: string; content?: unknown }): string =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .flatMap((part: { type?: string; text?: string }) =>
            part.type === "text" ? [part.text ?? ""] : [],
          )
          .join("\n")
      : "";

/** Parse explicit run controls; no request is sent by parsing. */
export function parseOptions(args: string[]): RunOptions {
  const { values } = parseArgs({
    args,
    options: {
      scenario: { type: "string", default: "manual" },
      model: { type: "string", default: "openai/gpt-6-luna" },
      window: { type: "string", default: "96000" },
      blocks: { type: "string" },
      out: { type: "string" },
      ledger: {
        type: "string",
        default: ".project/analyses/classifier-eval/budget-ledger.jsonl",
      },
      "auth-dir": {
        type: "string",
        default:
          process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.out)
    throw new Error("--out is required and must be a new directory");
  if (!["manual", "preflight", "agent"].includes(values.scenario))
    throw new Error("--scenario must be manual, preflight or agent");
  const window = Number(values.window),
    blocks = Number(
      values.blocks ?? (values.scenario === "agent" ? "15" : "24"),
    );
  if (!Number.isInteger(window) || window < 32000)
    throw new Error("--window must be an integer >=32000");
  buildCorpus(blocks);
  return {
    scenario: values.scenario as Scenario,
    model: values.model,
    window,
    blocks,
    out: resolve(values.out),
    ledger: resolve(values.ledger),
    authDir: resolve(values["auth-dir"]),
    dryRun: values["dry-run"],
  };
}

/** Run only synthetic history through the production extension and budgeted real transport. */
export async function runAcceptance(
  options: RunOptions,
  createRuntime: typeof ModelRuntime.create = (opts) =>
    ModelRuntime.create(opts),
): Promise<void> {
  const corpus = buildCorpus(options.blocks);
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(options.out);
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(options.out, name),
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx" },
    );
  save("fixture.json", { facts: FACTS, request: REQUEST, corpus });
  save("manifest.json", corpusManifest(corpus));
  const { authDir: _authDir, ...publicOptions } = options;
  save("invocation.json", {
    ...publicOptions,
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirtyPaths: execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "extensions",
        "scripts",
        "README.md",
        "docs",
        "package.json",
        "tsconfig.json",
      ],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n")
      .filter(Boolean),
  });
  if (options.dryRun) {
    save("result.json", {
      dryRun: true,
      dispatched: 0,
      sourceBytes: corpus.reduce((n, s) => n + Buffer.byteLength(s), 0),
    });
    console.log(
      "Dry run: fixture written; zero provider calls and no ledger changes.",
    );
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "independent-fold-acceptance-"));
  const agentDir = join(scratch, "agent"),
    cwd = join(scratch, "work");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  let ledger: BudgetLedger | undefined;
  let transport: ReturnType<typeof createBudgetedTransport> | undefined;
  let dispose: (() => void) | undefined;
  let failure: unknown;
  try {
    const runtime = await createRuntime({
      authPath: join(options.authDir, "auth.json"),
      modelsPath: join(options.authDir, "models.json"),
      modelsStorePath: join(options.authDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    const catalogModel = registry.find("openrouter", options.model);
    if (!catalogModel || !registry.hasConfiguredAuth(catalogModel))
      throw new Error(
        "Selected OpenRouter model is unavailable or unauthenticated",
      );
    if (options.window > catalogModel.contextWindow)
      throw new Error(
        "Fixture window cannot exceed the catalogued operating window",
      );
    const model: Model<Api> = {
      ...catalogModel,
      contextWindow: options.window,
      maxTokens: Math.min(catalogModel.maxTokens, 8192),
    };
    ledger = BudgetLedger.open(options.ledger, 25);
    const beforeBudget = ledger.snapshot();
    const billing = createBilling({
      getApiKey: () => registry.getApiKeyForProvider("openrouter"),
    });
    transport = createBudgetedTransport({
      fetch: globalThis.fetch,
      ledger,
      models: {
        routes: loadRouteTable(ROUTE_PRICES_URL),
        models: [{ id: model.id, kind: "chat", cost: model.cost }],
      },
      billing,
      record: (record) =>
        appendFileSync(
          join(options.out, "wire.jsonl"),
          `${JSON.stringify(record)}\n`,
        ),
    });
    const budgetedFetch = transport.fetch;
    const originalStream = runtime.streamSimple.bind(runtime);
    const calls: {
      side: boolean;
      model: string;
      messages: number;
      startedAt: string;
    }[] = [];
    runtime.streamSimple = ((selected, context, streamOptions) => {
      calls.push({
        side: streamOptions?.toolChoice === "none",
        model: `${selected.provider}/${selected.id}`,
        messages: context.messages.length,
        startedAt: new Date().toISOString(),
      });
      return originalStream(selected, context, {
        ...streamOptions,
        fetch: budgetedFetch,
        maxRetries: 0,
      });
    }) as typeof runtime.streamSimple;
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      defaultThinkingLevel: "off",
    });
    const sm = SessionManager.create(cwd, join(options.out, "sessions"));
    let pi: ExtensionAPI | undefined;
    let extensionContext: ExtensionContext | undefined;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [
        (api) => {
          pi = api;
          navigateTree(api);
          api.on("session_start", (_event, ctx) => {
            extensionContext = ctx;
          });
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You are evaluating a synthetic service audit. Preserve explicit constraints and remaining work. Follow the latest request without modifying files. When asked to fold, invoke navigate_tree rewind, then answer the remaining request after the handoff.",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      tools: ["navigate_tree"],
      resourceLoader: loader,
      sessionManager: sm,
      settingsManager: settings,
    });
    dispose = () => session.dispose();
    await session.bindExtensions({
      mode: "json",
      abortHandler: () => {
        void session.abort();
      },
    });
    // Seeded sessions represent an existing run whose prompt bootstrap already ran.
    __testHooks.captureSession(session);
    seedCorpus(sm, corpus);
    const initialTokens = estimateAdmissionTokens(sm);
    if (options.scenario === "preflight")
      assert.ok(
        initialTokens + 5120 > model.contextWindow,
        "fixture must exceed admission before any main request",
      );
    if (options.scenario === "agent")
      assert.ok(
        initialTokens + 16384 < model.contextWindow,
        "agent scenario must start with room to call the tool",
      );
    assert.ok(
      pi && extensionContext,
      "production extension did not initialize",
    );
    const api = __testHooks.foldApi(pi);
    assert.ok(api, "independent fold entrypoint is unavailable");
    if (options.scenario === "manual") {
      const outcome = await api.runFoldNow(extensionContext, {
        origin: "manual",
        rewindTo: "audit-start",
        newLabel: "audit-folded",
        focus: `Preserve all five audit facts verbatim, including the no-deployment rule and remaining comparison work. ${FACTS.join(" ")}`,
      });
      save("fold-outcome.json", outcome);
      assert.equal(outcome.status, "done");
      assert.ok(
        calls.length > 0 && calls.every((call) => call.side),
        "manual folding must make only independent summary calls",
      );
      await session.prompt(REQUEST);
    } else if (options.scenario === "agent") {
      await session.prompt(
        `Call navigate_tree with action rewind, rewindTo audit-start, newLabel audit-folded, summaryFocus 'Preserve audit constraints and remaining comparison work, then answer the latest request'. After it completes: ${REQUEST}`,
      );
    } else {
      await session.prompt(REQUEST);
    }
    await session.waitForIdle();
    const branch = sm.getBranch();
    const summaryAt = branch.findIndex(
      (entry) => entry.type === "branch_summary",
    );
    assert.ok(summaryAt >= 0, "production engine must write a branch summary");
    const final = branch.findLast(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    assert.ok(
      final?.type === "message" &&
        textOf(final.message).includes("ACCEPTANCE-CONTINUED"),
      "main model must answer after the fold",
    );
    if (options.scenario === "preflight") {
      assert.ok(
        calls[0]?.side,
        "recovery must precede the first main dispatch",
      );
      assert.ok(
        branch
          .slice(summaryAt + 1)
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              textOf(entry.message) === REQUEST,
          ),
        "unanswered request must survive verbatim after the handoff",
      );
    }
    const afterTokens = estimateAdmissionTokens(sm);
    assert.ok(
      afterTokens < initialTokens,
      "fold must reduce projected context",
    );
    await transport.drain();
    save("result.json", {
      passed: true,
      scenario: options.scenario,
      sessionFile: sm.getSessionFile(),
      initialTokens,
      afterTokens,
      calls,
      beforeBudget,
      afterBudget: ledger.snapshot(),
      completedAt: new Date().toISOString(),
      scratch,
      isolatedAgentDir: getAgentDir(),
    });
    console.log(
      `${options.scenario}: PASS; ${initialTokens} -> ${afterTokens} estimated tokens; ${calls.length} requests.`,
    );
  } catch (error) {
    failure = error;
    save("failure.json", {
      error: safeMessage(error),
      at: new Date().toISOString(),
    });
  } finally {
    try {
      await transport?.drain();
    } catch (error) {
      failure ??= error;
    }
    try {
      dispose?.();
    } finally {
      ledger?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
  if (failure) throw failure;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await runAcceptance(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(safeMessage(error));
    process.exitCode = 1;
  }
}
