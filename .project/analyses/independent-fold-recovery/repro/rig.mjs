// Disposable SDK rig: real createAgentSession + real ModelRuntime, local faux provider only.
// No network, no ~/.pi state (PI_CODING_AGENT_DIR points at a temp dir that dispose() removes).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true when `signal` aborted before `ms` elapsed (stand-in for an abortable side call). */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const sigState = (ctxOrSignal) => {
  let signal;
  try {
    signal = ctxOrSignal && "aborted" in ctxOrSignal ? ctxOrSignal : ctxOrSignal?.signal;
  } catch {
    return "stale";
  }
  return signal === undefined ? "undefined" : signal.aborted ? "aborted" : "live";
};

const textOf = (message) => {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `<call ${b.name}>` : `<${b.type}>`)).join("");
};
const preview = (message) => `${message.role}${message.stopReason ? `/${message.stopReason}` : ""}:${textOf(message).replace(/\s+/g, " ").slice(0, 28)}`;

export const unpairedToolCalls = (messages) => {
  const results = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  let open = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) if (block.type === "toolCall" && !results.has(block.id)) open++;
  }
  return open;
};

export const OVERFLOW_ERROR = "prompt is too long: 250000 tokens > 200000 maximum";

/**
 * @param {string} name
 * @param {{ compaction?: object, retry?: boolean, tools?: boolean, extension?: (pi: any, rig: any) => void }} spec
 */
export async function createRig(name, spec = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `pi-fr-${name}-`));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  const cwd = path.join(dir, "work");
  await mkdir(cwd, { recursive: true });
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const ai = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");

  const t0 = Date.now();
  const timeline = [];
  const calls = [];
  const rig = {
    name,
    dir,
    armed: false,
    timeline,
    calls,
    ai,
    log(kind, data = {}) {
      timeline.push({ i: timeline.length, ms: Date.now() - t0, kind, ...data });
    },
  };

  const api = `mock-api-${name}`;
  const faux = ai.createFauxCore({
    api,
    provider: "mock",
    models: [{ id: "mock-1", name: "Mock 1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }],
  });
  rig.faux = faux;
  rig.sessionId = undefined;
  const streamSimple = (model, context, options) => {
    const kind = options?.sessionId === rig.sessionId ? "agent" : "side";
    const call = {
      n: calls.length + 1,
      kind,
      preAborted: options?.signal?.aborted === true,
      count: context.messages.length,
      roles: context.messages.map(preview),
    };
    calls.push(call);
    if (rig.armed) rig.log("provider_call", { n: call.n, callKind: kind, preAborted: call.preAborted, messages: call.count });
    return faux.streamSimple(model, context, options);
  };

  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
    allowModelNetwork: false,
  });
  runtime.registerProvider("mock", {
    baseUrl: "http://localhost:0",
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
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  const model = runtime.getModel("mock", "mock-1");
  if (!model) throw new Error("mock model not registered");

  const settings = SettingsManager.inMemory({
    compaction: spec.compaction ?? { enabled: false },
    retry: { enabled: spec.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
    defaultThinkingLevel: "off",
  });
  const sm = SessionManager.inMemory(cwd);
  rig.sm = sm;

  const factory = (pi) => {
    rig.pi = pi;
    pi.on("before_agent_start", () => {
      if (rig.armed) rig.log("before_agent_start");
    });
    pi.on("context_with_system", (event, ctx) => {
      if (!rig.armed) return;
      rig.log("cws", {
        messages: event.messages.length,
        unpairedToolCalls: unpairedToolCalls(event.messages),
        signal: sigState(ctx),
        sameSm: ctx.sessionManager === sm,
      });
    });
    pi.on("turn_end", (event, ctx) => {
      if (!rig.armed) return;
      rig.log("ext_turn_end", {
        outcome: event.outcome,
        stopReason: event.message?.stopReason,
        continueIn: event.continue,
        canContinue: event.context?.canContinue,
        signal: sigState(ctx),
      });
    });
    pi.on("agent_before_settle", (event, ctx) => {
      if (!rig.armed) return;
      rig.log("ext_before_settle", { outcome: event.outcome, continueIn: event.continue, signal: sigState(ctx) });
    });
    pi.on("session_before_compact", (event) => {
      if (!rig.armed) return;
      rig.log("ext_before_compact", { reason: event.reason, willRetry: event.willRetry, signal: sigState(event.signal) });
    });
    if (spec.tools) {
      pi.registerTool({
        name: "probe_tool",
        label: "Probe",
        description: "Waits ms milliseconds and returns its tag.",
        parameters: Type.Object({ ms: Type.Number(), tag: Type.String() }),
        async execute(_id, params) {
          await sleep(params.ms);
          return { content: [{ type: "text", text: `done ${params.tag}` }], details: {} };
        },
      });
    }
    spec.extension?.(pi, rig);
  };

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [factory],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a test agent.",
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length) throw new Error(JSON.stringify(loadErrors));

  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    tools: spec.tools ? ["probe_tool"] : [],
    resourceLoader: loader,
    sessionManager: sm,
    settingsManager: settings,
  });
  rig.session = session;
  rig.sessionId = sm.getSessionId();

  // Read-only probe: record the decision the host hands to agent-core's loop for every finished turn.
  const hostFinishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    const decision = await hostFinishTurn?.(turn, signal);
    if (rig.armed) rig.log("finishTurn_decision", { action: decision?.action ?? "none", stopReason: turn.message?.stopReason });
    return decision;
  };

  const extensionErrors = [];
  rig.extensionErrors = extensionErrors;
  // Same two actions as the TUI's Esc handler (interactive-mode.js restoreQueuedMessagesToEditor({ abort: true })).
  rig.escape = (why) => {
    rig.log("escape", { why });
    session.clearQueue();
    void session.abort().then(() => rig.log("abort_resolved"));
  };
  // While a compaction runs the TUI swaps Esc for session.abortCompaction() (interactive-mode.js compaction_start).
  rig.escapeDuringCompaction = (why) => {
    rig.log("escape_compaction", { why });
    session.abortCompaction();
  };
  await session.bindExtensions({
    mode: "json",
    abortHandler: () => {
      rig.log("ctx_abort");
      rig.escape("ctx.abort()");
    },
    onError: (error) => {
      extensionErrors.push(`${error.event}: ${error.error}`);
      rig.log("extension_error", { event: error.event, error: error.error });
    },
  });
  session.subscribe((event) => {
    if (!rig.armed) return;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        rig.log(event.type);
        break;
      case "turn_end":
        rig.log("turn_end", { stopReason: event.message?.stopReason });
        break;
      case "agent_end":
        rig.log("agent_end", { willRetry: event.willRetry });
        break;
      case "agent_settled":
        rig.log("agent_settled", { aborted: event.aborted });
        break;
      case "compaction_start":
        rig.log("compaction_start", { reason: event.reason });
        break;
      case "compaction_end":
        rig.log("compaction_end", { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, error: event.errorMessage });
        break;
      case "queue_update":
        rig.log("queue_update", { steering: event.steering.length, followUp: event.followUp.length });
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          rig.log("assistant_end", {
            stopReason: event.message.stopReason,
            ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage.slice(0, 60) } : {}),
          });
        }
        break;
      default:
        break;
    }
  });

  const big = (tag, i) => `${tag} ${i} ${"lorem ipsum ".repeat(70)}`;
  rig.big = big;

  /** Build real history (system head + n prompt/answer pairs) before the scenario is armed. */
  rig.seedHistory = async (n) => {
    faux.setResponses(Array.from({ length: n }, (_, i) => ai.fauxAssistantMessage(big("answer", i))));
    for (let i = 0; i < n; i++) await session.prompt(big("question", i));
    await session.waitForIdle();
    calls.length = 0;
  };
  rig.arm = () => {
    rig.armed = true;
    rig.t0 = Date.now();
  };

  rig.respond = (steps) => faux.setResponses(steps);
  rig.ok = (text) => ai.fauxAssistantMessage(text);
  rig.overflow = () => ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: OVERFLOW_ERROR });
  rig.toolCalls = (...specs) =>
    ai.fauxAssistantMessage(
      specs.map(([toolName, args]) => ai.fauxToolCall(toolName, args)),
      { stopReason: "toolUse" },
    );
  /** A step that answers side calls (summaries) with a fixed text and agent requests via `agentStep`. */
  rig.routed = (agentStep) => (context, options, state, requestModel) =>
    options?.sessionId === rig.sessionId
      ? typeof agentStep === "function"
        ? agentStep(context, options, state, requestModel)
        : agentStep
      : ai.fauxAssistantMessage("SIDE-CALL SUMMARY TEXT");

  const lastEntry = (pred) => [...sm.getBranch()].reverse().find(pred);
  rig.lastAssistant = () => lastEntry((e) => e.type === "message" && e.message.role === "assistant")?.message;
  rig.trailingUserText = () => {
    const entry = lastEntry((e) => e.type === "message" && e.message.role === "user");
    return entry ? textOf(entry.message) : undefined;
  };
  /** Stand-in for the engine's commitFold: branch from the system head with a summary, re-append the unanswered user input, add the continuation. */
  rig.simFold = (label = "sim_fold_commit", { refresh = false } = {}) => {
    const branch = sm.getBranch();
    const anchor = branch.find((e) => e.type === "message" && e.message.role === "system") ?? branch[0];
    const lateUser = rig.trailingUserText();
    const leafBefore = sm.getLeafId();
    sm.branchWithSummary(anchor.id, `SIMULATED FOLD SUMMARY of ${branch.length} entries`, { sim: true }, true);
    if (lateUser !== undefined) {
      sm.appendMessage({ role: "user", content: [{ type: "text", text: lateUser }], timestamp: Date.now() });
    }
    sm.appendCustomMessageEntry("sim-fold-continuation", "The fold landed. Continue with the unanswered request.", true);
    if (refresh) {
      // What index.ts refreshAgentMessages()/emitSessionTree() do after a fold (reflection on private fields).
      session.agent.state.messages = sm.buildSessionContext().messages;
      void session._extensionRunner.emit({ type: "session_tree", newLeafId: sm.getLeafId(), oldLeafId: leafBefore, summaryEntry: undefined, fromExtension: true });
    }
    rig.log(label, { branchBefore: branch.length, branchAfter: sm.getBranch().length, leafMoved: leafBefore !== sm.getLeafId(), refresh });
  };

  /** Run a prompt, recording rejection; then let any late continuation surface. */
  rig.prompt = async (text, { settle = 80 } = {}) => {
    rig.log("prompt_start");
    let rejected;
    try {
      await session.prompt(text);
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
      rig.log("prompt_rejected", { error: rejected });
    }
    rig.log("prompt_returned", { isIdle: session.isIdle });
    await session.waitForIdle();
    await sleep(settle);
    return rejected;
  };

  rig.counts = () => {
    const n = (kind, pred = () => true) => timeline.filter((e) => e.kind === kind && pred(e)).length;
    const agentCalls = calls.filter((c) => c.kind === "agent");
    return {
      providerCalls: calls.length,
      agentCalls: agentCalls.length,
      sideCalls: calls.length - agentCalls.length,
      preAborted: calls.filter((c) => c.preAborted).length,
      sentOnWire: calls.filter((c) => !c.preAborted).length,
      agentEnd: n("agent_end"),
      turnEnd: n("turn_end"),
      turnEndByStop: Object.fromEntries(
        ["stop", "toolUse", "error", "aborted"].map((s) => [s, n("turn_end", (e) => e.stopReason === s)]).filter(([, v]) => v > 0),
      ),
      beforeSettle: n("ext_before_settle"),
      settled: n("agent_settled"),
      settledAborted: n("agent_settled", (e) => e.aborted),
      pendingQueued: session.pendingMessageCount,
      isIdleAtEnd: session.isIdle,
      extensionErrors: extensionErrors.length,
      abortFlagReadOnly: session._agentRunAbortRequested,
    };
  };

  rig.branchTrace = () =>
    sm.getBranch().map((e) => {
      if (e.type === "message") return preview(e.message);
      if (e.type === "custom_message") return `custom:${e.customType}`;
      if (e.type === "branch_summary") return "branch_summary";
      return e.type;
    });

  rig.dispose = async () => {
    try {
      session.dispose();
    } catch {
      // best effort
    }
    await rm(dir, { recursive: true, force: true });
  };

  rig.report = (id, description, extra = {}) => {
    const lines = timeline.map((e) => {
      const { i, ms, kind, ...rest } = e;
      const data = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${String(i).padStart(2, "0")} +${String(ms).padStart(4, " ")}ms ${kind}${data}`;
    });
    const counts = rig.counts();
    console.log(`--- ${id}: ${description}`);
    console.log(lines.join("\n"));
    console.log(`branch: ${rig.branchTrace().join(" | ")}`);
    console.log(`provider calls: ${calls.map((c) => `#${c.n}[${c.kind}${c.preAborted ? ",pre-aborted" : ""},${c.count} msgs]`).join(" ")}`);
    if (extensionErrors.length) console.log(`extension errors: ${JSON.stringify(extensionErrors)}`);
    console.log(`RESULT ${JSON.stringify({ id, counts, ...extra })}`);
  };

  return rig;
}
