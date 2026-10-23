// Usage: node scenarios.mjs <id>   (see SCENARIOS). One scenario per process.
// Every scenario runs the real createAgentSession against a local faux provider; nothing leaves the machine.
import { abortableSleep, createRig, sigState, sleep } from "./rig.mjs";

const HIST = 4;
const hide = (event) => ({ type: "context_edit", targetId: event.messageEntryId, replacement: null });

/** Control: a plain prompt, no recovery handlers acting. */
async function S0() {
  const rig = await createRig("S0");
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.ok("plain answer")]);
  await rig.prompt("what now?");
  rig.report("S0", "control: plain prompt on a seeded history");
  await rig.dispose();
}

/**
 * Planned E6 flow: context_with_system calls ctx.abort() (as index.ts:5177 does today), the aborted turn's
 * turn_end recovers and returns continue:true.
 * variant: "fold" (branchWithSummary + re-append) | "hide" (context_edit null on the aborted reply) |
 *          "followup" (fold + queued follow-up) | "newrun" (fold, then pi.sendUserMessage from agent_settled) |
 *          "newrun-custom" (fold, then pi.sendMessage({triggerTurn:true}) from agent_settled)
 */
function S1(variant) {
  return async () => {
    let guardAborted = false;
    let recovered = false;
    let resumed = false;
    const rig = await createRig(`S1${variant}`, {
      extension: (pi, rig) => {
        pi.on("context_with_system", (_event, ctx) => {
          if (!rig.armed || guardAborted) return;
          guardAborted = true;
          rig.log("guard_calls_ctx_abort");
          ctx.abort();
        });
        pi.on("turn_end", (event, ctx) => {
          if (!guardAborted || recovered) return;
          recovered = true;
          rig.log("turn_end_sees_guard_abort", { outcome: event.outcome, signal: sigState(ctx) });
          let entries = event.entries;
          if (variant === "hide") entries = [...entries, hide(event)];
          else rig.simFold("recovery_fold_at_turn_end");
          if (variant === "followup") {
            pi.sendUserMessage("continue after fold", { deliverAs: "followUp" });
            rig.log("turn_end_queues_followup");
            return { entries };
          }
          if (variant.startsWith("newrun")) return { entries };
          rig.log("turn_end_returns_continue");
          return { entries, continue: true };
        });
        pi.on("agent_before_settle", (event) => {
          if (!guardAborted || variant.startsWith("newrun") || variant === "followup") return;
          rig.log("before_settle_returns_continue", { outcome: event.outcome });
          return { continue: true };
        });
        pi.on("agent_settled", (event) => {
          if (!variant.startsWith("newrun") || !event.aborted || resumed) return;
          resumed = true;
          rig.log("agent_settled_resumes", { via: variant === "newrun" ? "sendUserMessage" : "sendMessage(triggerTurn)" });
          if (variant === "newrun") pi.sendUserMessage("continue after fold");
          else pi.sendMessage({ customType: "sim-resume", content: "Resume after the fold.", display: true }, { triggerTurn: true });
        });
      },
    });
    await rig.seedHistory(HIST);
    rig.arm();
    rig.respond([rig.ok("answer after recovery"), rig.ok("unexpected extra answer")]);
    await rig.prompt("what now?", { settle: 200 });
    const queuedAfter = rig.session.pendingMessageCount;
    rig.report(`S1-${variant}`, `preflight ctx.abort() + turn_end recovery (${variant})`, { queuedAfter });
    await rig.dispose();
  };
}

/** Alternative: async context_with_system recovery that returns reduced messages; no abort. */
function S2a(compaction) {
  return async () => {
  let fired = false;
  const rig = await createRig(compaction ? "S2a-on" : "S2a", {
    compaction,
    extension: (pi, rig) => {
      pi.on("context_with_system", async (event, ctx) => {
        if (!rig.armed || fired) return;
        fired = true;
        rig.log("recovery_start", { signal: sigState(ctx), messagesIn: event.messages.length });
        if (await abortableSleep(40, ctx.signal)) return rig.log("recovery_cancelled");
        rig.simFold("recovery_fold_in_context_with_system", { refresh: true });
        const reduced = rig.sm.buildSessionProjection().messages;
        rig.log("recovery_returns_reduced", { messagesOut: reduced.length });
        return { messages: reduced };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.ok("answer on folded context"), rig.ok("second answer")]);
  await rig.prompt("what now?");
  const afterFirst = { agentStateMessages: rig.session.agent.state.messages.length, projection: rig.sm.buildSessionProjection().messages.length };
  await rig.prompt("and then?");
  rig.report(compaction ? "S2a-on" : "S2a", `async context_with_system recovery returning reduced messages, no abort${compaction ? " (pi compaction enabled)" : ""}`, { afterFirst });
  await rig.dispose();
  };
}

/** Safe point: every context_with_system call after a tool batch sees complete call/result pairs. */
async function S2b() {
  const rig = await createRig("S2b", {
    tools: true,
    extension: (pi, rig) => {
      pi.on("tool_execution_start", (e) => rig.armed && rig.log("tool_start", { id: e.toolCallId.slice(-6) }));
      pi.on("tool_execution_end", (e) => rig.armed && rig.log("tool_end", { id: e.toolCallId.slice(-6) }));
      pi.on("context_with_system", async () => {
        if (rig.armed) await sleep(20);
      });
    },
  });
  await rig.seedHistory(2);
  rig.arm();
  rig.respond([
    rig.toolCalls(["probe_tool", { ms: 120, tag: "slow" }], ["probe_tool", { ms: 5, tag: "fast" }]),
    rig.toolCalls(["probe_tool", { ms: 10, tag: "second" }]),
    rig.ai.fauxAssistantMessage([rig.ai.fauxToolCall("probe_tool", { ms: 10, tag: "cut" })], { stopReason: "length" }),
    rig.ok("final answer"),
  ]);
  await rig.prompt("use the tools");
  const worstUnpaired = Math.max(...rig.timeline.filter((e) => e.kind === "cws").map((e) => e.unpairedToolCalls));
  rig.report("S2b", "tool-batch safe point at context_with_system (parallel, sequential, truncated)", { worstUnpaired });
  await rig.dispose();
}

/** In-handler fold at the first request, then a tool turn in the same run: later requests are built from the folded branch. */
async function S2d() {
  let fired = false;
  const rig = await createRig("S2d", {
    tools: true,
    extension: (pi, rig) => {
      pi.on("context_with_system", async (_event, ctx) => {
        if (!rig.armed || fired) return;
        fired = true;
        if (await abortableSleep(30, ctx.signal)) return;
        rig.simFold("recovery_fold_in_context_with_system", { refresh: true });
        return { messages: rig.sm.buildSessionProjection().messages };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.toolCalls(["probe_tool", { ms: 10, tag: "t1" }]), rig.ok("final answer")]);
  await rig.prompt("use the tool");
  rig.report("S2d", "in-handler fold at request 1, tool turn, request 2 in the same run");
  await rig.dispose();
}

/** Esc (session.abort(), what the TUI calls) while the async preflight recovery is in flight. */
async function S2c() {
  let fired = false;
  const rig = await createRig("S2c", {
    extension: (pi, rig) => {
      pi.on("context_with_system", async (_event, ctx) => {
        if (!rig.armed || fired) return;
        fired = true;
        rig.log("recovery_start", { signal: sigState(ctx) });
        setTimeout(() => rig.escape("user Esc during preflight recovery"), 60);
        const aborted = await abortableSleep(400, ctx.signal);
        rig.log("recovery_end", { sawAbort: aborted, signal: sigState(ctx) });
        if (aborted) return;
        rig.simFold("recovery_fold_in_context_with_system");
        return { messages: rig.sm.buildSessionProjection().messages };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.ok("answer that must not appear")]);
  await rig.prompt("what now?");
  rig.report("S2c", "Esc during async preflight recovery");
  await rig.dispose();
}

/** Provider overflow error; recovery only through turn_end continue:true. */
async function S3a() {
  const rig = await createRig("S3a", {
    extension: (pi, rig) => {
      pi.on("turn_end", (event) => {
        if (!rig.armed || event.outcome !== "error") return;
        rig.log("turn_end_returns_continue");
        return { entries: [...event.entries, hide(event)], continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("recovered answer")]);
  await rig.prompt("what now?");
  rig.report("S3a", "provider overflow, turn_end returns continue:true (failed reply hidden)");
  await rig.dispose();
}

/** Provider overflow error; fold + continue at agent_before_settle (pi compaction off). */
async function S3b() {
  let done = false;
  const rig = await createRig("S3b", {
    extension: (pi, rig) => {
      pi.on("agent_before_settle", (event) => {
        if (!rig.armed || done || event.outcome !== "error" || rig.lastAssistant()?.stopReason !== "error") return;
        done = true;
        rig.simFold("recovery_fold_at_before_settle");
        rig.log("before_settle_returns_continue");
        return { continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("answer after recovery")]);
  await rig.prompt("what now?");
  rig.report("S3b", "provider overflow, fold + continue at agent_before_settle, pi compaction off");
  await rig.dispose();
}

/** Provider overflow error; fold at turn_end(error) plus a queued follow-up. */
async function S3c() {
  const rig = await createRig("S3c", {
    extension: (pi, rig) => {
      pi.on("turn_end", (event, ctx) => {
        if (!rig.armed || event.outcome !== "error") return;
        rig.log("recovery_signal", { signal: sigState(ctx) });
        rig.simFold("recovery_fold_at_turn_end");
        pi.sendUserMessage("continue after fold", { deliverAs: "followUp" });
        rig.log("turn_end_queues_followup");
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("answer after fold"), rig.ok("answer to the follow-up")]);
  await rig.prompt("what now?");
  rig.report("S3c", "provider overflow, fold at turn_end(error) + queued follow-up");
  await rig.dispose();
}

/** pi native compaction enabled (the default); extension only observes. */
async function S3d() {
  const rig = await createRig("S3d", { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 300 } });
  await rig.seedHistory(HIST);
  rig.arm();
  let agentN = 0;
  const step = rig.routed(() => (agentN++ === 0 ? rig.overflow() : rig.ok("answer after native recovery")));
  rig.respond(Array.from({ length: 8 }, () => step));
  await rig.prompt("what now?");
  rig.report("S3d", "provider overflow with pi compaction enabled, extension only observes");
  await rig.dispose();
}

/** Compaction enabled: take the overflow over at session_before_compact(reason overflow), cancel pi's compaction, continue at agent_before_settle. */
async function S3e() {
  let folded = false;
  const rig = await createRig("S3e", {
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 300 },
    extension: (pi, rig) => {
      pi.on("session_before_compact", async (event) => {
        if (!rig.armed || event.reason !== "overflow") return;
        if (await abortableSleep(40, event.signal)) {
          rig.log("hook_fold_cancelled");
          return { cancel: true };
        }
        rig.simFold("recovery_fold_in_session_before_compact");
        folded = true;
        return { cancel: true };
      });
      pi.on("agent_before_settle", (event) => {
        if (!rig.armed || !folded || event.outcome !== "error") return;
        rig.log("before_settle_returns_continue");
        folded = false;
        return { continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  let agentN = 0;
  const step = rig.routed(() => (agentN++ === 0 ? rig.overflow() : rig.ok("answer after recovery")));
  rig.respond(Array.from({ length: 8 }, () => step));
  await rig.prompt("what now?");
  rig.report("S3e", "compaction enabled: fold inside session_before_compact(overflow) + cancel, continue at agent_before_settle");
  await rig.dispose();
}

/** Esc while a fold runs at agent_before_settle (ctx.signal is undefined there). */
async function S3f() {
  let done = false;
  const rig = await createRig("S3f", {
    extension: (pi, rig) => {
      pi.on("agent_before_settle", async (event, ctx) => {
        if (!rig.armed || done || event.outcome !== "error") return;
        done = true;
        rig.log("recovery_start", { signal: sigState(ctx) });
        setTimeout(() => rig.escape("user Esc during before_settle fold"), 60);
        const sawAbort = await abortableSleep(300, ctx.signal);
        rig.log("recovery_end", { sawAbort, signal: sigState(ctx) });
        rig.simFold("recovery_fold_at_before_settle");
        return { continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("answer after recovery")]);
  await rig.prompt("what now?", { settle: 400 });
  rig.report("S3f", "Esc during fold at agent_before_settle");
  await rig.dispose();
}

/**
 * Esc while a fold runs inside session_before_compact (event.signal).
 * via "tui": session.abortCompaction() (what the TUI binds during compaction); "abort": session.abort() (RPC abort, SDK callers).
 */
function S3g(via) {
  return async () => {
    let folded = false;
    const rig = await createRig(`S3g-${via}`, {
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 300 },
      extension: (pi, rig) => {
        pi.on("session_before_compact", async (event) => {
          if (!rig.armed || event.reason !== "overflow") return;
          setTimeout(() => (via === "tui" ? rig.escapeDuringCompaction("user Esc during compaction") : rig.escape("session.abort() during compaction")), 60);
          const sawAbort = await abortableSleep(300, event.signal);
          rig.log("recovery_end", { sawAbort, signal: sigState(event.signal) });
          if (sawAbort) return { cancel: true };
          rig.simFold("recovery_fold_in_session_before_compact");
          folded = true;
          return { cancel: true };
        });
        pi.on("agent_before_settle", (event) => {
          if (!rig.armed || !folded || event.outcome !== "error") return;
          rig.log("before_settle_returns_continue");
          return { continue: true };
        });
      },
    });
    await rig.seedHistory(HIST);
    rig.arm();
    let agentN = 0;
    const step = rig.routed(() => (agentN++ === 0 ? rig.overflow() : rig.ok("answer after recovery")));
    rig.respond(Array.from({ length: 8 }, () => step));
    await rig.prompt("what now?", { settle: 400 });
    rig.report(`S3g-${via}`, `Esc during fold inside session_before_compact(overflow), via ${via === "tui" ? "abortCompaction()" : "session.abort()"}`);
    await rig.dispose();
  };
}

/** The fold already ran at turn_end(error): what does pi's native overflow recovery do next? (compaction on vs off) */
function S3h(compaction, id) {
  return async () => {
  const rig = await createRig(id, {
    compaction,
    extension: (pi, rig) => {
      pi.on("turn_end", (event) => {
        if (!rig.armed || event.outcome !== "error") return;
        rig.simFold("recovery_fold_at_turn_end");
        rig.log("turn_end_returns_continue");
        return { entries: event.entries, continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  let agentN = 0;
  const step = rig.routed(() => (agentN++ === 0 ? rig.overflow() : rig.ok("answer after recovery")));
  rig.respond(Array.from({ length: 8 }, () => step));
  await rig.prompt("what now?");
  rig.report(id, `fold committed at turn_end(error), continue:true, pi compaction ${compaction.enabled ? "enabled" : "disabled"}`);
  await rig.dispose();
  };
}

/** Recommended provider-error hybrid (pi compaction off): fold at turn_end(error) where ctx.signal is live, continue at agent_before_settle. */
async function S3k() {
  let folded = false;
  const rig = await createRig("S3k", {
    extension: (pi, rig) => {
      pi.on("turn_end", async (event, ctx) => {
        if (!rig.armed || folded || event.outcome !== "error") return;
        rig.log("recovery_start", { signal: sigState(ctx) });
        if (await abortableSleep(40, ctx.signal)) return rig.log("recovery_cancelled");
        rig.simFold("recovery_fold_at_turn_end");
        folded = true;
      });
      pi.on("agent_before_settle", (event) => {
        if (!rig.armed || !folded || event.outcome !== "error") return;
        folded = false;
        rig.log("before_settle_returns_continue");
        return { continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("answer after recovery")]);
  await rig.prompt("what now?");
  rig.report("S3k", "provider overflow: fold at turn_end(error), continue at agent_before_settle (pi compaction off)");
  await rig.dispose();
}

/** Non-error overflow shape: a length stop is a completed turn, so turn_end continue:true is honored. */
async function S3j() {
  let done = false;
  const rig = await createRig("S3j", {
    extension: (pi, rig) => {
      pi.on("turn_end", (event, ctx) => {
        if (!rig.armed || done || event.message?.stopReason !== "length") return;
        done = true;
        rig.log("recovery_signal", { signal: sigState(ctx) });
        rig.simFold("recovery_fold_at_turn_end");
        rig.log("turn_end_returns_continue");
        return { entries: event.entries, continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.ai.fauxAssistantMessage("cut off", { stopReason: "length" }), rig.ok("answer after recovery")]);
  await rig.prompt("what now?");
  rig.report("S3j", "length-stop overflow shape, fold at turn_end + continue:true");
  await rig.dispose();
}

/** Esc while a fold runs at turn_end(error) (ctx.signal is live there). */
async function S3i() {
  const rig = await createRig("S3i", {
    extension: (pi, rig) => {
      pi.on("turn_end", async (event, ctx) => {
        if (!rig.armed || event.outcome !== "error") return;
        rig.log("recovery_start", { signal: sigState(ctx) });
        setTimeout(() => rig.escape("user Esc during turn_end fold"), 60);
        const sawAbort = await abortableSleep(300, ctx.signal);
        rig.log("recovery_end", { sawAbort, signal: sigState(ctx) });
        if (sawAbort) return;
        rig.simFold("recovery_fold_at_turn_end");
        return { entries: event.entries, continue: true };
      });
      pi.on("agent_before_settle", (event) => {
        if (!rig.armed || event.outcome !== "error") return;
        return { continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.overflow(), rig.ok("answer after recovery")]);
  await rig.prompt("what now?", { settle: 400 });
  rig.report("S3i", "Esc during fold at turn_end(error)");
  await rig.dispose();
}

/** Esc during a turn_end fold on a completed turn; the handler ignores the signal, commits and returns continue:true. */
async function S4() {
  const rig = await createRig("S4", {
    extension: (pi, rig) => {
      pi.on("turn_end", async (event, ctx) => {
        if (!rig.armed || event.outcome !== "completed") return;
        setTimeout(() => rig.escape("user Esc during turn_end fold"), 60);
        const sawAbort = await abortableSleep(300, ctx.signal);
        rig.log("handler_end", { sawAbort, signal: sigState(ctx) });
        rig.simFold("recovery_fold_at_turn_end");
        return { entries: event.entries, continue: true };
      });
    },
  });
  await rig.seedHistory(HIST);
  rig.arm();
  rig.respond([rig.ok("completed answer"), rig.ok("must not be requested")]);
  await rig.prompt("what now?", { settle: 400 });
  rig.report("S4", "Esc during turn_end fold on a completed turn; handler returns continue:true anyway");
  await rig.dispose();
}

export const SCENARIOS = {
  S0,
  "S1-fold": S1("fold"),
  "S1-hide": S1("hide"),
  "S1-followup": S1("followup"),
  "S1-newrun": S1("newrun"),
  "S1-newrun-custom": S1("newrun-custom"),
  S2a: S2a(undefined),
  "S2a-on": S2a({ enabled: true, reserveTokens: 100, keepRecentTokens: 300 }),
  S2b,
  S2c,
  S2d,
  S3a,
  S3b,
  S3c,
  S3d,
  S3e,
  S3f,
  "S3g-tui": S3g("tui"),
  "S3g-abort": S3g("abort"),
  S3h: S3h({ enabled: true, reserveTokens: 100, keepRecentTokens: 300 }, "S3h"),
  "S3h-off": S3h({ enabled: false }, "S3h-off"),
  S3j,
  S3k,
  S3i,
  S4,
};

const id = process.argv[2];
if (!SCENARIOS[id]) {
  console.error(`unknown scenario ${id}; known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
setTimeout(() => {
  console.error("watchdog: scenario exceeded 30s");
  process.exit(3);
}, 30_000).unref();
await SCENARIOS[id]();
process.exit(0);
