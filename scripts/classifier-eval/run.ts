/**
 * Live benchmark runner: sends production-shaped classifier requests to
 * candidate models under the durable budget ledger.
 *
 *   node scripts/classifier-eval/run.ts --models decisions:typesafe/jev-1.14,chat:google/gemini-2.5-flash-lite,heuristic \
 *     --split development --out .project/analyses/classifier-eval/run-1 [--dry-run]
 *
 * Every paid call reserves its worst case in the ledger before dispatch and
 * settles from OpenRouter billing after it. Exit codes: 0 complete, 1 failure,
 * 2 usage error, 3 budget stop or refused dry run, 130 interrupted.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type AdapterResult,
  answer,
  type Candidate,
  chatCandidate,
  type DraftObservation,
  decisionsCandidate,
  type EvalRegistry,
  HEURISTIC,
  planRequest,
  type RequestPlan,
  safeMessage,
} from "./adapters.ts";
import {
  type Billing,
  createBilling,
  type KeyUsage,
  type Settlement,
  worstCaseUsd,
} from "./billing.ts";
import { BudgetError, BudgetLedger, type BudgetSnapshot } from "./budget.ts";
import { prepareCase } from "./prepare.ts";
import type {
  EvalCase,
  EvalObservation,
  EvalTask,
  PreparedCase,
} from "./types.ts";

const TASKS: readonly EvalTask[] = [
  "intent",
  "supersession",
  "milestone-status",
  "milestone-boundary",
];
const DEFAULT_LEDGER = ".project/analyses/classifier-eval/budget-ledger.jsonl";
const MAX_PENDING_PER_WORKER = 8;

export type RunRegistry = EvalRegistry &
  Pick<
    ModelRegistry,
    "getModelOfType" | "getModelsOfType" | "getApiKeyForProvider"
  >;

/** Everything the runner touches outside its own process; tests replace it. */
export interface Deps {
  loadCases(path: string | undefined): Promise<readonly EvalCase[]>;
  createRegistry(options: {
    storePath: string;
    offline: boolean;
  }): Promise<RunRegistry>;
  fetch: typeof globalThis.fetch;
  git(): { sha: string; dirty: boolean };
  stdout(text: string): void;
  stderr(text: string): void;
  billingDelaysMs?: readonly number[];
  handleSignals: boolean;
  /** Stops the run like Ctrl+C when it aborts. */
  interrupt?: AbortSignal;
}

interface Options {
  models: string[];
  uncatalogued: string[];
  split: "development" | "holdout" | "all";
  tasks: readonly EvalTask[];
  repetitions: number;
  concurrency: number;
  timeoutMs: number;
  dryRun: boolean;
  ledger: string;
  cap: number;
  out?: string;
  resume?: string;
  cases?: string;
}

class UsageError extends Error {}

const USAGE = `usage: node scripts/classifier-eval/run.ts --models <spec,...> (--out <dir> | --resume <dir> | --dry-run) [options]

  --models <a,b>          decisions:<id> | chat:<id> | heuristic (ids are OpenRouter ids)
  --uncatalogued <id:promptUsdPerM:contextTokens>
                          decision model missing from the catalog; repeatable, implies --models entry
  --split <s>             development | holdout | all (default all)
  --tasks <t,...>         ${TASKS.join(" | ")} (default all)
  --repetitions <n>       default 1
  --concurrency <n>       default 4
  --timeout-ms <n>        per request, default 60000
  --ledger <path>         default ${DEFAULT_LEDGER}
  --cap <usd>             ledger cap, default 25
  --out <dir>             new run directory (must not exist)
  --resume <dir>          continue a run directory, skipping finished work
  --dry-run               plan and price only; no network, nothing written
  --cases <file>          module exporting CASES (default ./cases.ts)
`;

function integer(value: string, name: string, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max)
    throw new UsageError(`--${name} must be an integer from 1 to ${max}`);
  return number;
}

function parseOptions(argv: readonly string[]): Options | "help" {
  let parsed: ReturnType<typeof parseArgs>["values"];
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        models: { type: "string" },
        uncatalogued: { type: "string", multiple: true },
        split: { type: "string", default: "all" },
        tasks: { type: "string" },
        repetitions: { type: "string", default: "1" },
        concurrency: { type: "string", default: "4" },
        "timeout-ms": { type: "string", default: "60000" },
        ledger: { type: "string", default: DEFAULT_LEDGER },
        cap: { type: "string", default: "25" },
        out: { type: "string" },
        resume: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        cases: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.help) return "help";
  const split = String(parsed.split);
  if (split !== "development" && split !== "holdout" && split !== "all")
    throw new UsageError("--split must be development, holdout or all");
  const tasks =
    parsed.tasks === undefined
      ? TASKS
      : String(parsed.tasks)
          .split(",")
          .map((task) => {
            if (!TASKS.includes(task as EvalTask))
              throw new UsageError(`unknown task ${task}`);
            return task as EvalTask;
          });
  const cap = Number(parsed.cap);
  if (!Number.isFinite(cap) || cap <= 0)
    throw new UsageError("--cap must be a positive number");
  const uncatalogued = (parsed.uncatalogued as string[] | undefined) ?? [];
  const models = String(parsed.models ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0 && uncatalogued.length === 0)
    throw new UsageError("--models is required");
  const dryRun = parsed["dry-run"] === true;
  const { out, resume } = parsed as { out?: string; resume?: string };
  if (!dryRun && (out === undefined) === (resume === undefined))
    throw new UsageError("a live run needs exactly one of --out and --resume");
  return {
    models,
    uncatalogued,
    split,
    tasks,
    repetitions: integer(String(parsed.repetitions), "repetitions"),
    concurrency: integer(String(parsed.concurrency), "concurrency", 64),
    timeoutMs: integer(String(parsed["timeout-ms"]), "timeout-ms"),
    dryRun,
    ledger: String(parsed.ledger),
    cap,
    ...(out !== undefined && { out }),
    ...(resume !== undefined && { resume }),
    ...(parsed.cases !== undefined && { cases: String(parsed.cases) }),
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const UNCATALOGUED =
  /^(.+\/[^:\s]+(?::[^:\s]+)*):(\d+(?:\.\d+)?(?:e[+-]?\d+)?):(\d+)$/iu;

function uncataloguedModels(
  specs: readonly string[],
  registry: RunRegistry,
): Map<string, ClassifierModel<ClassifierApi>> {
  const template = registry
    .getModelsOfType("classifier", "openrouter")
    .find((model) => model.api === "typesafe-system-one");
  const models = new Map<string, ClassifierModel<ClassifierApi>>();
  for (const spec of specs) {
    const match = UNCATALOGUED.exec(spec);
    if (!match)
      throw new UsageError(
        `bad --uncatalogued ${spec}: expected id:promptUsdPerM:contextTokens`,
      );
    const [, id = "", price = "", context = ""] = match;
    if (!template)
      throw new UsageError("no OpenRouter decision model to use as a template");
    if (registry.getModelOfType("classifier", "openrouter", id))
      throw new UsageError(`${id} is in the catalog; drop --uncatalogued`);
    models.set(id, {
      ...template,
      id,
      name: id,
      cost: { input: Number(price), output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(context),
    });
  }
  return models;
}

function resolveCandidates(
  options: Options,
  registry: RunRegistry,
): Candidate[] {
  const extra = uncataloguedModels(options.uncatalogued, registry);
  const specs = [
    ...options.models,
    ...[...extra.keys()].map((id) => `decisions:${id}`),
  ];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const spec of specs) {
    const match = /^(decisions|chat):(?:openrouter\/)?(.+)$/u.exec(spec);
    let candidate: Candidate | undefined;
    if (spec === "heuristic") candidate = HEURISTIC;
    else if (match?.[1] === "decisions") {
      const id = match[2] ?? "";
      const model =
        extra.get(id) ??
        registry.getModelOfType("classifier", "openrouter", id);
      if (model) candidate = decisionsCandidate(model, extra.has(id));
    } else if (match?.[1] === "chat") {
      const model = registry.getModelOfType(
        "chat",
        "openrouter",
        match[2] ?? "",
      );
      if (model) candidate = chatCandidate(model);
    } else {
      throw new UsageError(
        `model ${spec} must be decisions:<id>, chat:<id> or heuristic`,
      );
    }
    if (!candidate)
      throw new UsageError(`model ${spec} is not in the OpenRouter catalog`);
    if (seen.has(candidate.label)) continue;
    seen.add(candidate.label);
    candidates.push(candidate);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlannedCall {
  prepared: PreparedCase;
  candidate: Candidate;
  repetition: number;
  plan: RequestPlan;
  reservationUsd: number;
}

const workKey = (model: string, caseId: string, repetition: number) =>
  JSON.stringify([model, caseId, repetition]);

/** Calls in repetition-major order, so a partial run covers every model evenly. */
function planCalls(
  cases: readonly PreparedCase[],
  candidates: readonly Candidate[],
  repetitions: number,
  completed: ReadonlySet<string>,
): { calls: PlannedCall[]; skipped: number } {
  const calls: PlannedCall[] = [];
  let skipped = 0;
  for (let repetition = 0; repetition < repetitions; repetition++)
    for (const prepared of cases)
      for (const candidate of candidates) {
        if (completed.has(workKey(candidate.label, prepared.id, repetition))) {
          skipped++;
          continue;
        }
        const plan = planRequest(prepared, candidate);
        calls.push({
          prepared,
          candidate,
          repetition,
          plan,
          reservationUsd:
            plan.kind === "request" && candidate.adapter !== "heuristic"
              ? worstCaseUsd(
                  plan.bodyBytes,
                  plan.maxOutputTokens,
                  candidate.rates,
                )
              : 0,
        });
      }
  return { calls, skipped };
}

function dryRunReport(
  calls: readonly PlannedCall[],
  skipped: number,
  budget: BudgetSnapshot,
  options: Options,
  candidates: readonly Candidate[],
): { text: string; total: number } {
  const rows = candidates.map((candidate) => {
    const own = calls.filter((call) => call.candidate === candidate);
    return {
      label: candidate.label,
      live: own.filter((call) => call.plan.kind === "request").length,
      local: own.filter((call) => call.plan.kind === "local").length,
      unsupported: own.filter((call) => call.plan.kind === "unsupported")
        .length,
      usd: own.reduce((sum, call) => sum + call.reservationUsd, 0),
    };
  });
  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  const lines = [
    `dry run: ${options.repetitions} repetition(s), split ${options.split}, tasks ${options.tasks.join(",")}`,
    ...rows.map(
      (row) =>
        `  ${row.label}: ${row.live} live, ${row.local} local, ${row.unsupported} unsupported, reserve ${row.usd.toFixed(6)} USD`,
    ),
    `planned live calls: ${rows.reduce((sum, row) => sum + row.live, 0)} (already finished: ${skipped})`,
    `summed reservations: ${total.toFixed(6)} USD`,
    `ledger ${options.ledger}: cap ${budget.limitUsd}, spent ${budget.spentUsd}, held ${budget.heldUsd}, remaining ${budget.remainingUsd}`,
    total > budget.remainingUsd
      ? "REFUSED: summed reservations exceed the remaining budget"
      : "OK: summed reservations fit the remaining budget",
  ];
  return { text: `${lines.join("\n")}\n`, total };
}

function ledgerSnapshot(path: string, cap: number): BudgetSnapshot {
  if (!existsSync(path))
    return { limitUsd: cap, spentUsd: 0, heldUsd: 0, remainingUsd: cap };
  const ledger = BudgetLedger.open(path, cap);
  try {
    return ledger.snapshot();
  } finally {
    ledger.close();
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Execution {
  calls: readonly PlannedCall[];
  ledger: BudgetLedger;
  billing: Billing;
  registry: EvalRegistry;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  concurrency: number;
  signal: AbortSignal;
  sessionId: string;
  write(observation: EvalObservation): void;
}

interface Outcome {
  counts: Record<EvalObservation["status"], number>;
  /** Calls cut short by an interrupt: unrecorded, so a resume repeats them. */
  interrupted: number;
  stopped?: string;
  failure?: unknown;
}

async function execute(run: Execution): Promise<Outcome> {
  const outcome: Outcome = {
    counts: { ok: 0, error: 0, unsupported: 0 },
    interrupted: 0,
  };
  const pending = new Set<Promise<void>>();
  let next = 0;

  const halt = (reason: string) => {
    outcome.stopped ??= reason;
  };
  const record = (
    draft: DraftObservation,
    settlement: Settlement,
    bound: number,
  ) => {
    run.write({ ...draft, ...settlement, costBoundUsd: bound });
    outcome.counts[draft.status]++;
  };

  async function settle(
    call: PlannedCall,
    reservationId: string,
    result: AdapterResult,
  ) {
    const settlement = await run.billing.settle(result.evidence, run.signal);
    try {
      run.ledger.settle(reservationId, settlement.costUsd);
    } catch (error) {
      if (error instanceof BudgetError) halt(`${error.code}: ${error.message}`);
      else outcome.failure ??= error;
    }
    if (run.signal.aborted && result.observation.status === "error")
      outcome.interrupted++;
    else record(result.observation, settlement, call.reservationUsd);
  }

  async function worker() {
    while (!outcome.stopped && !outcome.failure && !run.signal.aborted) {
      while (pending.size >= run.concurrency * MAX_PENDING_PER_WORKER)
        await Promise.race(pending);
      const call = run.calls[next++];
      if (!call) return;
      const options = {
        registry: run.registry,
        repetition: call.repetition,
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        fetch: run.fetch,
      };
      if (call.plan.kind !== "request") {
        const local = await answer(call.prepared, call.candidate, options);
        record(local.observation, { costUsd: 0, costSource: "local" }, 0);
        continue;
      }
      const reservationId = `${run.sessionId}/${call.candidate.label}/${call.prepared.id}/${call.repetition}`;
      try {
        run.ledger.reserve(reservationId, call.reservationUsd);
      } catch (error) {
        if (!(error instanceof BudgetError)) throw error;
        halt(`${error.code}: ${error.message}`);
        return;
      }
      const result = await answer(call.prepared, call.candidate, options);
      const settling: Promise<void> = settle(
        call,
        reservationId,
        result,
      ).finally(() => {
        pending.delete(settling);
      });
      pending.add(settling);
    }
  }

  await Promise.all(
    Array.from({ length: run.concurrency }, () =>
      worker().catch((error) => {
        outcome.failure ??= error;
      }),
    ),
  );
  await Promise.all(pending);
  if (run.signal.aborted) halt("interrupted");
  return outcome;
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

interface ModelMeta {
  label: string;
  adapter: Candidate["adapter"];
  uncatalogued?: true;
  promptUsdPerM?: number;
  completionUsdPerM?: number;
  contextWindow?: number;
}

interface SessionMeta {
  id: string;
  startedAt: string;
  endedAt?: string;
  models: ModelMeta[];
  split: Options["split"];
  tasks: readonly EvalTask[];
  repetitions: number;
  concurrency: number;
  keyUsageBefore?: KeyUsage | { error: string };
  keyUsageAfter?: KeyUsage | { error: string };
  counts?: Outcome["counts"];
  interrupted?: number;
  stopped?: string;
  ledgerAfter?: BudgetSnapshot;
}

interface RunMeta {
  runId: string;
  createdAt: string;
  gitSha: string;
  gitDirty: boolean;
  casesSha256: string;
  caseCount: number;
  ledgerPath: string;
  capUsd: number;
  models: ModelMeta[];
  sessions: SessionMeta[];
}

function modelMeta(candidate: Candidate): ModelMeta {
  if (candidate.adapter === "heuristic")
    return { label: candidate.label, adapter: "heuristic" };
  return {
    label: candidate.label,
    adapter: candidate.adapter,
    ...(candidate.adapter === "decisions" &&
      candidate.uncatalogued && { uncatalogued: true as const }),
    promptUsdPerM: candidate.rates.promptUsdPerM,
    completionUsdPerM: candidate.rates.completionUsdPerM,
    contextWindow: candidate.model.contextWindow,
  };
}

function writeJson(path: string, value: unknown) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readObservations(path: string): EvalObservation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalObservation;
      } catch {
        throw new Error(
          `${path} line ${index + 1} is not valid JSON; repair it before resuming`,
        );
      }
    });
}

/** Each recorded observation finishes its unit of work; analysis keeps one per key. */
const finishedKeys = (observations: readonly EvalObservation[]) =>
  new Set(observations.map((o) => workKey(o.model, o.caseId, o.repetition)));

function openLog(path: string) {
  const fd = openSync(path, "a");
  return {
    write(observation: EvalObservation) {
      writeSync(fd, `${JSON.stringify(observation)}\n`);
      fsyncSync(fd);
    },
    close: () => closeSync(fd),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const usageOf = async (billing: Billing, signal?: AbortSignal) =>
  billing.keyUsage(signal).catch((error) => ({ error: safeMessage(error) }));

/** Runs the CLI against `deps` and resolves to the process exit code. */
export async function main(
  argv: readonly string[],
  deps: Deps,
): Promise<number> {
  try {
    const options = parseOptions(argv);
    if (options === "help") {
      deps.stdout(USAGE);
      return 0;
    }
    return await runBenchmark(options, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    deps.stderr(`failed: ${safeMessage(error)}\n`);
    return 1;
  }
}

async function runBenchmark(options: Options, deps: Deps): Promise<number> {
  const allCases = await deps.loadCases(options.cases);
  const prepared = allCases
    .filter(
      (fixture) =>
        (options.split === "all" || fixture.split === options.split) &&
        options.tasks.includes(fixture.task),
    )
    .map(prepareCase);
  if (prepared.length === 0)
    throw new UsageError("no cases match --split and --tasks");

  const outDir = resolve(options.resume ?? options.out ?? ".");
  const scratch = mkdtempSync(join(tmpdir(), "classifier-eval-"));
  try {
    const registry = await deps.createRegistry({
      storePath: join(scratch, "models-store.json"),
      offline: options.dryRun,
    });
    const candidates = resolveCandidates(options, registry);
    const completed = finishedKeys(
      options.resume || (options.dryRun && options.out)
        ? readObservations(join(outDir, "observations.jsonl"))
        : [],
    );
    const { calls, skipped } = planCalls(
      prepared,
      candidates,
      options.repetitions,
      completed,
    );
    if (options.dryRun) {
      const budget = ledgerSnapshot(options.ledger, options.cap);
      const report = dryRunReport(calls, skipped, budget, options, candidates);
      deps.stdout(report.text);
      return report.total > budget.remainingUsd ? 3 : 0;
    }
    if (options.resume) {
      if (!existsSync(join(outDir, "run.json")))
        throw new UsageError(`${outDir} has no run.json to resume`);
    } else {
      if (existsSync(outDir))
        throw new UsageError(
          `${outDir} already exists; use --resume or a new --out`,
        );
      mkdirSync(dirname(outDir), { recursive: true });
      mkdirSync(outDir);
    }
    return await runLive({
      options,
      deps,
      registry,
      candidates,
      calls,
      outDir,
      casesSha256: createHash("sha256")
        .update(JSON.stringify(allCases))
        .digest("hex"),
      caseCount: allCases.length,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface LiveRun {
  options: Options;
  deps: Deps;
  registry: RunRegistry;
  candidates: readonly Candidate[];
  calls: readonly PlannedCall[];
  outDir: string;
  casesSha256: string;
  caseCount: number;
}

function newRunMeta(
  live: LiveRun,
  git: { sha: string; dirty: boolean },
): RunMeta {
  const stamp = new Date().toISOString();
  return {
    runId: `run-${stamp.replaceAll(":", "-")}-${randomBytes(2).toString("hex")}`,
    createdAt: stamp,
    gitSha: git.sha,
    gitDirty: git.dirty,
    casesSha256: live.casesSha256,
    caseCount: live.caseCount,
    ledgerPath: live.options.ledger,
    capUsd: live.options.cap,
    models: [],
    sessions: [],
  };
}

async function runLive(live: LiveRun): Promise<number> {
  const { options, deps, registry, candidates, calls, outDir } = live;
  const runMetaPath = join(outDir, "run.json");
  const billing = createBilling({
    getApiKey: () => registry.getApiKeyForProvider("openrouter"),
    fetch: deps.fetch,
    ...(deps.billingDelaysMs && { delaysMs: deps.billingDelaysMs }),
  });
  if (
    calls.some((call) => call.plan.kind === "request") &&
    !(await registry.getApiKeyForProvider("openrouter"))
  )
    throw new Error("no OpenRouter API key is configured");

  const meta: RunMeta = options.resume
    ? (JSON.parse(readFileSync(runMetaPath, "utf8")) as RunMeta)
    : newRunMeta(live, deps.git());
  if (meta.casesSha256 !== live.casesSha256)
    throw new UsageError(
      "the cases changed since this run started; start a new --out",
    );
  const session: SessionMeta = {
    id: `${meta.runId}.s${meta.sessions.length + 1}`,
    startedAt: new Date().toISOString(),
    models: candidates.map(modelMeta),
    split: options.split,
    tasks: options.tasks,
    repetitions: options.repetitions,
    concurrency: options.concurrency,
  };
  for (const model of session.models)
    if (!meta.models.some((known) => known.label === model.label))
      meta.models.push(model);
  meta.sessions.push(session);

  const ledger = BudgetLedger.open(options.ledger, options.cap);
  const log = openLog(join(outDir, "observations.jsonl"));
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    if (++interrupts > 1) {
      ledger.close();
      process.exit(130);
    }
    deps.stderr(
      "interrupted: no new requests; in-flight calls settle as unknown\n",
    );
    controller.abort();
  };
  if (deps.handleSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  deps.interrupt?.addEventListener("abort", onSignal, { once: true });
  try {
    writeJson(runMetaPath, meta);
    session.keyUsageBefore = await usageOf(billing, controller.signal);
    writeJson(runMetaPath, meta);
    const outcome = await execute({
      calls,
      ledger,
      billing,
      registry,
      fetch: deps.fetch,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      signal: controller.signal,
      sessionId: session.id,
      write: log.write,
    });
    session.keyUsageAfter = await usageOf(billing);
    session.endedAt = new Date().toISOString();
    session.counts = outcome.counts;
    session.interrupted = outcome.interrupted;
    if (outcome.stopped) session.stopped = outcome.stopped;
    session.ledgerAfter = ledger.snapshot();
    writeJson(runMetaPath, meta);
    deps.stdout(summary(outDir, session, outcome));
    if (outcome.failure) throw outcome.failure;
    if (outcome.stopped === "interrupted") return 130;
    return outcome.stopped ? 3 : 0;
  } finally {
    if (deps.handleSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    deps.interrupt?.removeEventListener("abort", onSignal);
    log.close();
    ledger.close();
  }
}

function summary(
  outDir: string,
  session: SessionMeta,
  outcome: Outcome,
): string {
  const { ok, error, unsupported } = outcome.counts;
  const before = session.keyUsageBefore;
  const after = session.keyUsageAfter;
  const usage =
    before &&
    after &&
    "usage" in before &&
    "usage" in after &&
    before.usage !== null &&
    after.usage !== null
      ? `key usage ${before.usage} -> ${after.usage} (delta ${(after.usage - before.usage).toFixed(9)} USD)`
      : "key usage unavailable";
  const ledger = session.ledgerAfter;
  const lines = [
    `${outDir}: ${ok + error + unsupported} observations (ok ${ok}, error ${error}, unsupported ${unsupported})`,
    ...(ledger
      ? [
          `ledger: cap ${ledger.limitUsd}, spent ${ledger.spentUsd}, held ${ledger.heldUsd}, remaining ${ledger.remainingUsd}`,
        ]
      : []),
    ...(outcome.interrupted > 0
      ? [
          `${outcome.interrupted} interrupted call(s) unrecorded; a resume repeats them`,
        ]
      : []),
    usage,
    outcome.stopped ? `STOPPED: ${outcome.stopped}` : "complete",
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** Loads the pi registry from the user's agent directory without writing there. */
async function createRegistry(options: {
  storePath: string;
  offline: boolean;
}): Promise<RunRegistry> {
  const { ModelRegistry, ModelRuntime } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: options.storePath,
    signal: AbortSignal.timeout(60_000),
    ...(options.offline && { refreshOnCreate: false }),
  });
  return new ModelRegistry(runtime);
}

const gitOutput = (...args: string[]) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

const defaultDeps: Deps = {
  async loadCases(path) {
    const specifier = path
      ? pathToFileURL(resolve(path)).href
      : new URL("./cases.ts", import.meta.url).href;
    const { CASES } = (await import(specifier)) as {
      CASES?: readonly EvalCase[];
    };
    if (!Array.isArray(CASES))
      throw new Error(`${specifier} does not export CASES`);
    return CASES;
  },
  createRegistry,
  fetch: (...args) => globalThis.fetch(...args),
  git: () => ({
    sha: gitOutput("rev-parse", "HEAD"),
    dirty: gitOutput("status", "--porcelain") !== "",
  }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  handleSignals: true,
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps);
}
