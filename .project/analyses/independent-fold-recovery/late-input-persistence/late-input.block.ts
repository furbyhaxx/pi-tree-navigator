// Appended by run.sh to a scratch copy of extensions/navigate-tree/index.test.ts, so it can use that
// file's fixtures (setup, setupRewindable, makeFakePi, makeCtx, SUMMARY_TEXT, ...) unchanged.
// Each scenario prints one `OBS {json}` line and then asserts the invariant below.
//
// Invariant: commitFold may answer ok:true only if every late entry reached the active branch and
// the session file. Otherwise it must refuse and leave the original active branch in place.
import { chmodSync, existsSync } from "node:fs";

describe("late-input persistence (analysis repro)", () => {
  const LATE_TEXT = "LATE REQUEST: also bump the version";
  type Mode = "pre-push" | "disk-persistent" | "disk-transient";

  /** Same input as the "commitFold: engine shape" fixture; the label writer is best-effort like the host's. */
  function engineFold(
    f: { sm: SessionManager; pi: FakePi },
    anchorId: string,
    overrides: Partial<FoldCommitInput> = {},
  ) {
    const leaf = f.sm.getLeafId() as string;
    const input: FoldCommitInput = {
      targetId: anchorId,
      rewindTo: "start",
      newLabel: "end",
      summaryText: SUMMARY_TEXT,
      handoffMode: "full",
      contextWindow: 200_000,
      foldPointId: leaf,
      branchLabelEntryId: leaf,
      continuationText: (afterTokens) => `folded to ${afterTokens}`,
      writeLabel: (entryId, label) => {
        try {
          f.pi.pi.setLabel(entryId, label);
          return true;
        } catch {
          try {
            f.sm.appendLabelChange(entryId, label);
            return true;
          } catch {
            return false;
          }
        }
      },
      ...overrides,
    };
    return { leaf, input };
  }

  function fileBacked() {
    const dir = mkdtempSync(join(tmpdir(), "late-input-"));
    const sm = SessionManager.create("/tmp", dir);
    const pi = makeFakePi(sm);
    navigateTree(pi.pi);
    return { dir, sm, pi };
  }

  /**
   * Arm one append failure that begins only after `branchWithSummary` succeeded.
   * `pre-push` throws before the SDK touches memory (the existing test's injection);
   * the disk modes make the real SDK `appendFileSync` fail with EACCES after its memory push.
   */
  function failLateAppend(
    sm: SessionManager,
    mode: Mode,
    kind: "user" | "custom",
  ) {
    const raw = sm as unknown as Record<string, (...a: unknown[]) => unknown>;
    const file = sm.getSessionFile() as string;
    let armed = false;
    let fired = false;
    const origBranch = raw.branchWithSummary.bind(sm);
    raw.branchWithSummary = (...a) => {
      const id = origBranch(...a);
      armed = true;
      return id;
    };
    const wrap = (name: string, matches: (a: unknown[]) => boolean) => {
      const orig = raw[name].bind(sm);
      raw[name] = (...a) => {
        if (!armed || fired || !matches(a)) return orig(...a);
        fired = true;
        if (mode === "pre-push") throw new Error("append boom");
        chmodSync(file, 0o444);
        try {
          return orig(...a);
        } finally {
          if (mode === "disk-transient") chmodSync(file, 0o644);
        }
      };
    };
    if (kind === "user") wrap("appendMessage", () => true);
    else wrap("appendCustomMessageEntry", (a) => a[0] === "subagent-result");
  }

  type Entry = ReturnType<SessionManager["getBranch"]>[number];
  const isUserText = (e: Entry, text: string) =>
    e.type === "message" &&
    e.message.role === "user" &&
    JSON.stringify(e.message.content).includes(text);

  /** Entries after the new branch_summary on the active branch, as compact tags. */
  function tail(sm: SessionManager): string[] {
    const branch = sm.getBranch();
    const at = branch.findIndex((e) => e.type === "branch_summary");
    if (at < 0) return ["<no branch_summary on the active branch>"];
    return branch.slice(at).map((e) => {
      if (isUserText(e, LATE_TEXT)) return `user:LATE(${e.id})`;
      if (e.type === "custom_message") return `custom:${e.customType}`;
      return e.type;
    });
  }

  interface Late {
    originalIds: string[];
  }

  /** Build the fixture, add late input after the fold point, arm the failure, commit, simulate the receipt. */
  async function run(opts: {
    fileBacked: boolean;
    mode?: Mode;
    kind?: "user" | "custom";
    late: Array<"user" | "custom">;
  }) {
    const f = opts.fileBacked ? fileBacked() : setup();
    const { fake, anchorId } = setupRewindable(f.sm, f.pi, { capture: true });
    const run = engineFold(f, anchorId);
    const late: Late = { originalIds: [] };
    for (const kind of opts.late) {
      late.originalIds.push(
        kind === "user"
          ? f.sm.appendMessage({
              role: "user",
              content: [{ type: "text", text: LATE_TEXT }],
              timestamp: 1,
            } as never)
          : f.sm.appendCustomMessageEntry(
              "subagent-result",
              "subagent finished",
              true,
              {},
            ),
      );
    }
    const preFoldBranch = f.sm.getBranch().map((e) => e.id);
    if (opts.mode) failLateAppend(f.sm, opts.mode, opts.kind ?? "user");
    const outcome = await commitFold(f.sm, run.input);
    // The host appends the continuation as the fold's receipt right after a landed commit.
    let receipt: string | null = null;
    if (outcome.ok) {
      try {
        receipt = f.sm.appendCustomMessageEntry(
          REWIND_CUSTOM_TYPE,
          outcome.continuation,
          true,
          { status: "done", reappendedLateMessages: outcome.reappended },
        );
      } catch {
        receipt = null;
      }
    }
    const file = f.sm.getSessionFile();
    const reloaded =
      opts.fileBacked && file && existsSync(file)
        ? SessionManager.open(file)
        : undefined;
    const agentTail = (
      (fake?.agent.state.messages ?? []) as Array<{
        role: string;
        content: unknown;
      }>
    )
      .slice(-3)
      .map((m) => `${m.role}:${JSON.stringify(m.content).slice(0, 48)}`);
    const obs = {
      ok: outcome.ok,
      reappended: outcome.ok ? outcome.reappended : null,
      lateExpected: opts.late.length,
      reason: outcome.ok ? null : outcome.reason,
      noteInContinuation: outcome.ok
        ? outcome.continuation.includes("still unanswered")
        : null,
      receiptAppended: outcome.ok ? receipt !== null : null,
      memoryTail: tail(f.sm),
      originalLateOnActiveBranch: late.originalIds.map((id) =>
        f.sm.getBranch().some((e) => e.id === id),
      ),
      agentMessagesTail: agentTail,
      reload: reloaded && {
        branchLength: reloaded.getBranch().length,
        reachesSummary: reloaded
          .getBranch()
          .some((e) => e.type === "branch_summary"),
        reachesAnchor: reloaded.getBranch().some((e) => e.id === anchorId),
        lateOnActiveBranch: late.originalIds.map((id) =>
          reloaded.getBranch().some((e) => e.id === id),
        ),
        lateCopyOnActiveBranch: reloaded
          .getBranch()
          .some(
            (e) => isUserText(e, LATE_TEXT) && !late.originalIds.includes(e.id),
          ),
        contextRoles: reloaded
          .buildSessionContext()
          .messages.map((m) => m.role),
      },
    };
    console.log(`OBS ${JSON.stringify({ scenario: opts, ...obs })}`);
    return {
      f,
      outcome,
      late,
      preFoldBranch,
      reloaded,
      anchorId,
      leaf: run.leaf,
      obs,
    };
  }

  /** The invariant, in memory and (when file-backed) after reopening the file. */
  function assertNoSilentLoss(
    r: Awaited<ReturnType<typeof run>>,
    userLate: boolean,
  ) {
    const { f, outcome, late, reloaded } = r;
    const memCopy = f.sm
      .getBranch()
      .some(
        (e) => isUserText(e, LATE_TEXT) && !late.originalIds.includes(e.id),
      );
    const memOriginal = f.sm
      .getBranch()
      .some((e) => late.originalIds.includes(e.id));
    if (outcome.ok) {
      assert.equal(
        outcome.reappended,
        late.originalIds.length,
        `ok:true but reappended=${outcome.reappended} of ${late.originalIds.length} late entries`,
      );
      if (userLate)
        assert.ok(
          memCopy,
          "ok:true but the late user request is not on the active branch",
        );
      if (reloaded && userLate) {
        assert.ok(
          reloaded
            .getBranch()
            .some(
              (e) =>
                isUserText(e, LATE_TEXT) && !late.originalIds.includes(e.id),
            ),
          "ok:true but the late user request is not on the active branch after reopening the file",
        );
        assert.ok(
          reloaded.getBranch().some((e) => e.type === "branch_summary"),
          "ok:true but the reopened active branch no longer reaches the branch_summary",
        );
      }
    } else {
      assert.ok(
        memOriginal,
        "refused, but the original late entries are off the active branch",
      );
      assert.ok(
        !f.sm.getBranch().some((e) => e.type === "branch_summary"),
        "refused, but the active branch still carries the new branch_summary",
      );
      // A refusal must be durable, or say that it may not be.
      const discloses = /rollback was not written/.test(outcome.reason);
      if (!discloses) {
        assert.equal(
          f.sm.getLabel(r.leaf),
          undefined,
          "refused, but the completion marker was left behind",
        );
      }
      if (reloaded) {
        const durable =
          !reloaded.getBranch().some((e) => e.type === "branch_summary") &&
          late.originalIds.every((id) =>
            reloaded.getBranch().some((e) => e.id === id),
          );
        assert.ok(
          durable || discloses,
          "refused, but the reopened session is on the folded branch and the reason does not say so",
        );
      }
    }
  }

  it("S0 control: no failure lands the fold and re-appends the request", async () => {
    const r = await run({ fileBacked: false, late: ["user"] });
    assert.ok(r.outcome.ok);
    assertNoSilentLoss(r, true);
  });

  it("S1 DECISIVE: one late user append throws before any memory change (existing test's injection)", async () => {
    const r = await run({
      fileBacked: false,
      mode: "pre-push",
      kind: "user",
      late: ["user"],
    });
    assertNoSilentLoss(r, true);
  });

  it("S1b: the throw hits the user request, a later custom entry still lands", async () => {
    const r = await run({
      fileBacked: false,
      mode: "pre-push",
      kind: "user",
      late: ["user", "custom"],
    });
    assertNoSilentLoss(r, true);
  });

  it("S5 host path: queued fold at turn_end; the late user steer append throws after the branch landed", async () => {
    const f = setup();
    setupRewindable(f.sm, f.pi, { capture: true });
    const raw = f.sm as unknown as Record<string, (...a: unknown[]) => unknown>;
    const origBranch = raw.branchWithSummary.bind(f.sm);
    raw.branchWithSummary = (...a) => {
      const id = origBranch(...a);
      raw.appendMessage = () => {
        throw new Error("append boom");
      };
      return id;
    };
    f.ctx.modelRegistry = fakeRegistry((_call, index) => {
      if (index === 0) {
        f.sm.appendMessage({
          role: "user",
          content: [{ type: "text", text: LATE_TEXT }],
          timestamp: 1,
        } as never);
        f.sm.appendCustomMessageEntry("subagent-result", "kept", true, {});
      }
      return reply(SUMMARY_TEXT);
    }).registry;
    await requestRewind(f);
    const receipt = rewindMessages(f.pi).at(-1);
    assert.ok(receipt, "the host delivered a receipt");
    const content = receipt.message.content;
    console.log(
      `OBS ${JSON.stringify({
        scenario: "S5 host path",
        status: receipt.message.details.status,
        reappendedLateMessages:
          receipt.message.details.reappendedLateMessages ?? null,
        continueFlag: receipt.continue,
        receiptSaysRetainedAreHistorical: /do not re-answer them/.test(content),
        receiptTail: content.slice(-170),
        activeBranchUserRequestPresent: f.sm
          .getBranch()
          .some((e) => isUserText(e, LATE_TEXT)),
        memoryTail: tail(f.sm),
      })}`,
    );
    assert.notEqual(
      receipt.message.details.status,
      "done",
      "receipt says done while the late user request is off the active branch",
    );
  });

  it("S2: real SDK, disk fails (EACCES) on the late user append and stays failed", async () => {
    const r = await run({
      fileBacked: true,
      mode: "disk-persistent",
      kind: "user",
      late: ["user"],
    });
    try {
      assertNoSilentLoss(r, true);
    } finally {
      rmSync(r.f.sm.getSessionDir(), { recursive: true, force: true });
    }
  });

  it("S3: real SDK, one late append fails (EACCES), later appends succeed", async () => {
    const r = await run({
      fileBacked: true,
      mode: "disk-transient",
      kind: "user",
      late: ["user", "custom"],
    });
    try {
      assertNoSilentLoss(r, true);
    } finally {
      rmSync(r.f.sm.getSessionDir(), { recursive: true, force: true });
    }
  });

  it("S4: real SDK, late custom entry append fails (EACCES) and stays failed", async () => {
    const r = await run({
      fileBacked: true,
      mode: "disk-persistent",
      kind: "custom",
      late: ["user", "custom"],
    });
    try {
      assertNoSilentLoss(r, false);
    } finally {
      rmSync(r.f.sm.getSessionDir(), { recursive: true, force: true });
    }
  });
});

// Related hazard found on the way, not the briefed defect: the host's best-effort label writer retries
// through the same manager after a failed append (index.ts writeLabel). Run via `run.sh <mode> followup`.
describe("FOLLOW-UP label retry (analysis repro)", () => {
  it("S6: the anchor label append fails once after its memory push, the host's retry succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "late-input-"));
    try {
      const sm = SessionManager.create("/tmp", dir);
      const pi = makeFakePi(sm);
      navigateTree(pi.pi);
      const f = { sm, pi, ctx: makeCtx(sm), tool: pi.registered[0] };
      setupRewindable(sm, pi, { capture: true });
      const file = sm.getSessionFile() as string;
      const raw = sm as unknown as Record<string, (...a: unknown[]) => unknown>;
      const origBranch = raw.branchWithSummary.bind(sm);
      const origLabel = raw.appendLabelChange.bind(sm);
      let armed = false;
      let fired = false;
      raw.branchWithSummary = (...a) => {
        const id = origBranch(...a);
        armed = true;
        return id;
      };
      raw.appendLabelChange = (...a) => {
        if (!armed || fired) return origLabel(...a);
        fired = true;
        chmodSync(file, 0o444);
        try {
          return origLabel(...a);
        } finally {
          chmodSync(file, 0o644);
        }
      };
      await requestRewind(f);
      const receipt = rewindMessages(f.pi).at(-1);
      const reloaded = SessionManager.open(file);
      console.log(
        `OBS ${JSON.stringify({
          scenario: "S6 label retry",
          fired,
          receiptStatus: receipt?.message.details.status,
          memoryBranchTypes: sm
            .getBranch()
            .map((e) => e.type)
            .slice(-5),
          reload: {
            branchLength: reloaded.getBranch().length,
            reachesSummary: reloaded
              .getBranch()
              .some((e) => e.type === "branch_summary"),
            contextRoles: reloaded
              .buildSessionContext()
              .messages.map((m) => m.role),
          },
        })}`,
      );
      assert.ok(fired, "the injected failure must have fired");
      assert.ok(
        reloaded.getBranch().some((e) => e.type === "branch_summary"),
        "the reopened active branch no longer reaches the branch_summary",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
