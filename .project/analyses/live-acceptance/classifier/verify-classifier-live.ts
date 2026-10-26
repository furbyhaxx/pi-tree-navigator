/**
 * Live acceptance for continuity classification (pi-tree-navigator).
 *
 * Drives the real extension code (`createModelClassifier` + `captureIntent` +
 * ledger reducer) against a real registry classifier model, with a real
 * credential file. Read-only: no product source, config or credential changes.
 *
 * Usage:
 *   node verify-classifier-live.ts --discover          list configured classifier models
 *   node verify-classifier-live.ts                     full acceptance batch
 *   CLASSIFIER_ROUTE=provider/id node verify-classifier-live.ts
 *
 * Writes evidence.json (wire + logical requests/responses, ops, ledger, checks)
 * next to this script. Authorization and cookie header values are redacted.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type CapturedOp,
  captureIntent,
  createModelClassifier,
  type IntentClassifier,
  type IntentVerdict,
} from "../../../../src/continuity/continuity-capture.ts";
import {
  applyOps,
  archiveSteeringForAnchor,
  capText,
  createLedger,
  isProtected,
  type Ledger,
  type LedgerItem,
  MAX_ITEM_TEXT_CHARS,
  MAX_QUOTE_CHARS,
  type OpContext,
  type ReduceResult,
} from "../../../../src/continuity/continuity-ledger.ts";

const AUTH_PATH = "/home/furbyhaxx/.pi/agent/auth.json";
const MODELS_PATH = "/home/furbyhaxx/.pi/agent/models.json";
const OUT_DIR = import.meta.dirname;
const PROVIDER_TIMEOUT_MS = 60_000;
const HISTORICAL_ROUTE = "openrouter/typesafe/jev-1.14";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const base = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const user = (id: string, text: string, parentId: string | null = null) =>
  ({
    type: "message",
    ...base(id, parentId),
    message: { role: "user", content: text, timestamp: 0 },
  }) as unknown as SessionEntry;

const label = (id: string, targetId: string, value: string) =>
  ({
    type: "label",
    ...base(id),
    targetId,
    label: value,
  }) as unknown as SessionEntry;

const OBJECTIVE = `We are moving the telemetry ingest service off the line-by-line JSON reader this quarter.

The thing this whole effort has to deliver is a streaming parser behind the existing ingest endpoint: identical metric names, identical error codes, and it runs behind a flag for two weeks before the cutover on 30 September.

Everything else is negotiable, including batching, the admin UI, and whether we keep the old reader around as a fallback. What is not negotiable is that no shard goes above 128 MiB at peak and that the March replay corpus reproduces byte-identical output.

I want the first slice reviewable on its own, so keep the flag plumbing in a separate change from the parser itself.`;

const RULE = `A few conventions I need you to follow across this repository, because two incidents came from skipping them.

Before any schema change lands, run the migration suite against a scratch database and paste the result. Keep the rollout commit separate from the code commit, so a reviewer can revert one without the other. If a test is flaky, fix or delete it in the same pull request instead of rerunning the pipeline until it goes green.

That last one matters more than it sounds: the rerun habit hid a broken index for six weeks, and I would rather see a red pipeline than a second version of that.`;

const DECISION = `We spent the last two days comparing the two cache options and I want to close that out.

Option A was SQLite on the local volume: one file, trivial backup, but the write contention under the replay test pushed p99 to 480 ms. Option B was PostgreSQL with a small connection pool: one more service to run, p99 at 90 ms on the same corpus.

I am settling on PostgreSQL. We retire the SQLite cache in the same migration instead of running both for a while, and the backup story gets documented in the runbook before the cutover.`;

const STEERING = `While you are working inside this anchor, leave the CHANGELOG entry and the version bump to me and skip both in every commit you make here.

When you touch the parser module, keep the imports in the order they already have instead of re-sorting the whole file; diff noise is the thing I am trying to avoid in this slice.

This applies to this slice only. We go back to the normal release flow once it is folded.`;

const EPHEMERAL = `Thanks, that answers it. The failing shard was the one I expected.

Can you paste the last twenty lines of its build log here when you get a moment? Nothing urgent, I just want to see the warning count.`;

// ~3.5k chars: pasted audit detail around two standing instructions, one early
// (survives the 500-char item cap) and one late (does not).
const MIXED_LONG = `I pulled the whole ingest audit into one message so you have the context before you start. Read it, then work from it.

Standing instruction for the parser work: every schema or config change in this service gets a replay against the March corpus before it merges, with the diff summary in the pull request. That is the rule for all later work here, not just this slice.

The audit itself: over three weeks we saw eleven shard restarts, all of them on the two shards that carry the widest metric cardinality, and all of them within four minutes of a config reload. The reload path re-parses the metric dictionary from disk on every shard, which is where the 90 ms p99 spike in the first graph comes from.

The replay logs (trimmed) look like this:

  shard-07 reload start cardinality=184213
  shard-07 dict parse 71ms
  shard-07 buffer flush deadline missed (queue=1182)
  shard-07 restart reason=healthcheck-timeout

  shard-11 reload start cardinality=180955
  shard-11 dict parse 74ms
  shard-11 buffer flush deadline missed (queue=1204)
  shard-11 restart reason=healthcheck-timeout

Nothing in those logs points at the parser itself. The reader allocates one dictionary per shard per reload, and the allocator keeps the old generation alive until the next flush, so a reload at high cardinality transiently doubles resident memory. On the two wide shards that is enough to push the shard past its 128 MiB ceiling and trip the health check.

Two smaller findings while I was in there: the admin UI lists shards by insertion order rather than by shard id, which makes the restart column hard to read, and the metric names for the dropped-record counter differ between the HTTP and gRPC endpoints ("ingest_dropped_total" versus "ingest.dropped"), which broke the first dashboard I built.

The replay harness itself is fine, for what it is worth: it replays the March corpus in about nine minutes on this laptop and the diff report is readable enough that I trust it more than the staging dashboard. If we end up tuning the allocator I would like the harness to grow a peak-memory column before we start, because resident memory is the number that actually decides when a shard restarts and it is the one number nobody has on a graph today.

Late instruction, and please treat this as binding for the rest of the migration: nobody deletes a metric name from the registry until two release cycles have passed, even when the dashboard no longer references it. We lost a customer-facing graph in March learning that one.

For today, just tell me which of those two naming conventions the current parser emits, and whether the dictionary allocation is per process or per shard. Do not start the reload fix yet, I want to review the plan first.

If it helps, the dashboard import that broke looked like this, which is where the naming mismatch surfaced:

  panel "dropped records" query: sum(rate(ingest.dropped[5m]))
  series returned: 0 (no data)
  rewrite as ingest_dropped_total: 3 series

I mention it because the same mismatch probably sits in the collector config as well, and I would rather fix the emitter once than chase string literals through dashboards for a week. The owner of the collector config is on holiday until Tuesday, so anything in that file waits for their review even if it looks trivial.`;

// ---------------------------------------------------------------------------
// Evidence capture
// ---------------------------------------------------------------------------

const REDACTED = /^(authorization|cookie|set-cookie|x-api-key|api-key|proxy-authorization)$/i;

function redactHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined || headers === null) return out;
  const entries: [string, string][] =
    typeof (headers as Headers).forEach === "function"
      ? (() => {
          const list: [string, string][] = [];
          (headers as Headers).forEach((value, key) => list.push([key, value]));
          return list;
        })()
      : Array.isArray(headers)
        ? (headers as [string, string][])
        : Object.entries(headers as Record<string, string>);
  for (const [key, value] of entries) {
    out[key] = REDACTED.test(key) ? "<redacted>" : String(value);
  }
  return out;
}

interface WireCall {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number;
  responseBody: string | null;
  error?: string;
}

interface LogicalCall {
  model: string;
  api: string;
  context: ClassifierContext;
  result: ClassifierResult;
  durationMs: number;
}

const wire: WireCall[] = [];
const logical: LogicalCall[] = [];

function installFetchRecorder(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const response = await original(input, init);
    let responseBody: string | null = null;
    try {
      responseBody = await response.clone().text();
    } catch (error) {
      responseBody = `<unreadable: ${String(error)}>`;
    }
    wire.push({
      url,
      method: init?.method ?? "GET",
      requestHeaders: redactHeaders(init?.headers),
      requestBody: typeof init?.body === "string" ? init.body : null,
      status: response.status,
      responseBody,
    });
    return response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const checks: Check[] = [];

function check(name: string, expected: unknown, actual: unknown): boolean {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  const pass = e === a;
  checks.push({ name, expected: e, actual: a, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: expected ${e}, got ${a}`);
  return pass;
}

function checkThat(name: string, expected: string, pass: boolean, actual: string): boolean {
  checks.push({ name, expected, actual, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: expected ${expected}; got ${actual}`);
  return pass;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface CaseResult {
  case: string;
  message: string;
  messageChars: number;
  input: { entryId: string; text: string; activeAnchor?: string; activeItems: unknown[] };
  verdict: IntentVerdict | undefined;
  ops: CapturedOp[];
  warnings: string[];
  reduction: { applied: string[]; rejected: string[] } | undefined;
  ledgerItems: unknown[];
}

const cases: CaseResult[] = [];

const entryIndexFor = (branch: readonly SessionEntry[]) => {
  const positions = new Map(
    branch.flatMap((entry, i) =>
      entry.type === "message" && entry.message.role === "user"
        ? [[entry.id, i] as const]
        : [],
    ),
  );
  return (id: string) => positions.get(id);
};

function reduce(ledger: Ledger, ops: readonly CapturedOp[]): ReduceResult {
  let current = ledger;
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const { op, ctx } of ops) {
    const result = applyOps(current, [op], ctx);
    current = result.ledger;
    for (const a of result.applied) applied.push(`${a.effect} ${a.item.id} ${a.item.kind}`);
    for (const r of result.rejected) rejected.push(`${r.reason.code}: ${r.reason.message}`);
  }
  return { ledger: current, applied, rejected, evicted: [] };
}

interface Diagnostic {
  name: string;
  route: string;
  minConfidence: number;
  messageChars: number;
  verdict: IntentVerdict | undefined;
  answers: unknown[];
  ops: string[];
}

const diagnostics: Diagnostic[] = [];

async function probe(
  name: string,
  route: string,
  minConfidence: number,
  classifier: IntentClassifier,
  branch: readonly SessionEntry[],
  ledger: Ledger,
  watermark?: string,
): Promise<void> {
  const before = logical.length;
  let verdict: IntentVerdict | undefined;
  const wrapped: IntentClassifier = async (input, signal) => {
    verdict = await classifier(input, signal);
    return verdict;
  };
  const result = await captureIntent(branch, watermark, ledger, wrapped, {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const record: Diagnostic = {
    name,
    route,
    minConfidence,
    messageChars: String((branch[branch.length - 1] as any).message.content).length,
    verdict,
    answers: logical.slice(before).map((l) => l.result.answers),
    ops: result.ops.map(
      (o) =>
        `${o.op.op}:${(o.op as any).kind ?? ""}:${JSON.stringify((o.op as any).ids ?? [])}`,
    ),
  };
  diagnostics.push(record);
  console.log(
    `[diag ${name}] route=${route} minConfidence=${minConfidence} -> ${verdict?.kind ?? "none"} supersedes=${JSON.stringify(verdict?.supersedes ?? [])} ops=${JSON.stringify(record.ops)}`,
  );
}

async function runTurn(
  name: string,
  branch: readonly SessionEntry[],
  watermark: string | undefined,
  ledger: Ledger,
  base: IntentClassifier,
  expected: { kind?: string },
): Promise<CaseResult> {
  const text = branch[branch.length - 1]?.type === "message"
    ? String((branch[branch.length - 1] as any).message.content)
    : "";
  const seen: { input: CaseResult["input"]; verdict: IntentVerdict }[] = [];
  const wrapped: IntentClassifier = async (input, signal) => {
    const verdict = await base(input, signal);
    seen.push({ input: { ...input, activeItems: [...input.activeItems] }, verdict });
    return verdict;
  };
  const result = await captureIntent(branch, watermark, ledger, wrapped, {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const verdict = seen[0]?.verdict;
  const record: CaseResult = {
    case: name,
    message: text,
    messageChars: text.length,
    input: seen[0]?.input ?? { entryId: "", text, activeItems: [] },
    verdict,
    ops: result.ops,
    warnings: result.warnings,
    reduction: undefined,
    ledgerItems: [],
  };
  console.log(
    `\n[${name}] ${text.length} chars -> kind=${verdict?.kind ?? "<no verdict>"} by=${verdict?.by ?? "-"} supersedes=${JSON.stringify(verdict?.supersedes ?? [])} warning=${verdict?.warning ?? "none"}`,
  );
  checkThat(
    `${name}: classifier used (not heuristic fallback)`,
    "by=classifier, no warning",
    verdict?.by === "classifier" && verdict.warning === undefined,
    `by=${verdict?.by}, warning=${verdict?.warning ?? "none"}`,
  );
  if (expected.kind !== undefined) {
    check(`${name}: verdict kind`, expected.kind, verdict?.kind);
  }
  if (result.ops.length > 0) {
    const reduced = reduce(ledger, result.ops);
    record.reduction = { applied: reduced.applied, rejected: reduced.rejected };
    const newEntryId = branch[branch.length - 1]?.id;
    record.ledgerItems = reduced.ledger.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      origin: item.source.origin,
      entryId: item.source.entryId,
      scopeAnchor: item.scopeAnchor,
      protectedItem: isProtected(item),
      supersedes: item.supersedes,
      supersededBy: item.supersededBy,
      textEqualsVerbatimPrefix: item.text === capText(text, MAX_ITEM_TEXT_CHARS),
      quoteEqualsVerbatimPrefix: item.quote === capText(text, MAX_QUOTE_CHARS),
      textChars: item.text.length,
      quoteChars: item.quote?.length,
    }));
    check(`${name}: reducer rejected no op`, [], reduced.rejected);
    const newItems = (record.ledgerItems as any[]).filter(
      (i) => i.entryId === newEntryId,
    );
    checkThat(`${name}: one new ledger item`, "1", newItems.length === 1, String(newItems.length));
    check(`${name}: stored text is verbatim head`, true, newItems.every((i) => i.textEqualsVerbatimPrefix));
    check(`${name}: stored quote is verbatim head`, true, newItems.every((i) => i.quoteEqualsVerbatimPrefix));
  } else {
    console.log(`[${name}] no ledger ops emitted`);
  }
  cases.push(record);
  return record;
}

function protectionChecks(): void {
  console.log("\n[reducer protection]");
  const seed = applyOps(
    createLedger(),
    [
      { op: "add", kind: "rule", text: "Never force-push a shared branch.", quote: "Never force-push a shared branch." },
      { op: "add", kind: "decision", text: "We are settling on PostgreSQL." },
      { op: "add", kind: "steering", text: "Skip the changelog here.", scopeAnchor: "ingest", quote: "Skip the changelog here." },
    ],
    { origin: "user", entryId: "u-seed" } as OpContext,
  );
  check("[reducer] seed applied", 3, seed.applied.length);
  const rule = seed.ledger.items.find((i) => i.kind === "rule") as LedgerItem;
  const decision = seed.ledger.items.find((i) => i.kind === "decision") as LedgerItem;
  const steering = seed.ledger.items.find((i) => i.kind === "steering") as LedgerItem;
  check("[reducer] user-origin rule is protected", true, isProtected(rule));

  const agentArchive = applyOps(seed.ledger, [{ op: "archive", id: rule.id }], { origin: "agent" });
  check(
    "[reducer] agent archive of user rule rejected",
    "protected_item",
    agentArchive.rejected[0]?.reason.code,
  );
  const classifierRewrite = applyOps(
    seed.ledger,
    [{ op: "update", id: rule.id, text: "Force-push is fine now." }],
    { origin: "classifier" },
  );
  check(
    "[reducer] classifier rewrite of user rule rejected",
    "protected_item",
    classifierRewrite.rejected[0]?.reason.code,
  );
  const agentSupersede = applyOps(
    seed.ledger,
    [{ op: "supersede", ids: [decision.id], with: { kind: "decision", text: "SQLite it is." } }],
    { origin: "agent" },
  );
  check(
    "[reducer] agent supersede of protected decision rejected",
    "invalid_citation",
    agentSupersede.rejected[0]?.reason.code,
  );
  const index = (id: string) => ({ "u-seed": 0, "u-new": 1 })[id];
  const userSupersede = applyOps(
    seed.ledger,
    [{ op: "supersede", ids: [decision.id], with: { kind: "decision", text: "PostgreSQL, then." }, citedEntryId: "u-new" }],
    { origin: "user", entryId: "u-new", userEntryIndex: index },
  );
  const heir = userSupersede.applied[0]?.item;
  check("[reducer] user supersede citing newer entry applied", "superseded", userSupersede.applied[0]?.effect);
  check("[reducer] heir keeps user authority", "user", heir?.source.origin);
  const old = userSupersede.ledger.items.find((i) => i.id === decision.id);
  check("[reducer] superseded decision archived by link", heir?.id, old?.supersededBy);

  const pinned = applyOps(seed.ledger, [{ op: "pin", id: steering.id }], { origin: "pin" });
  check("[reducer] pin applied", "pinned", pinned.applied[0]?.effect);
  const folded = archiveSteeringForAnchor(pinned.ledger, "ingest");
  check("[reducer] fold leaves pinned steering active", "active", folded.ledger.items.find((i) => i.id === steering.id)?.status);
  const unpinned = applyOps(pinned.ledger, [{ op: "unpin", id: steering.id }], { origin: "pin" });
  const foldedAfter = archiveSteeringForAnchor(unpinned.ledger, "ingest");
  check("[reducer] fold archives unpinned steering", "archived", foldedAfter.ledger.items.find((i) => i.id === steering.id)?.status);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function discover(registry: ModelRegistry) {
  const available = await registry.getAvailableOfType("classifier");
  const all = registry.getModelsOfType("classifier");
  console.log(`classifier models known: ${all.length}`);
  for (const model of all) console.log(`  known: ${model.provider}/${model.id} (api=${model.api})`);
  console.log(`classifier models with configured auth: ${available.length}`);
  for (const model of available) console.log(`  available: ${model.provider}/${model.id} (api=${model.api})`);
  return available;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: AUTH_PATH, modelsPath: MODELS_PATH });
  const registry = new ModelRegistry(runtime);
  const available = await discover(registry);
  if (process.argv.includes("--discover")) return;
  if (available.length === 0) {
    console.error("BLOCKER: no classifier model with configured auth");
    process.exitCode = 2;
    return;
  }
  const requested = process.env.CLASSIFIER_ROUTE;
  const routeModel =
    (requested && available.find((m) => `${m.provider}/${m.id}` === requested)) ??
    available.find((m) => `${m.provider}/${m.id}` === HISTORICAL_ROUTE) ??
    available[0];
  const route = `${routeModel.provider}/${routeModel.id}`;
  console.log(`\nroute: ${route} (requested=${requested ?? "none"}, historical present=${available.some((m) => `${m.provider}/${m.id}` === HISTORICAL_ROUTE)})`);

  const warnings: string[] = [];
  const recordingRegistry = {
    getModelOfType: (type: any, provider: string, id: string) =>
      registry.getModelOfType(type, provider, id) as ClassifierModel<any> | undefined,
    classify: async (model: ClassifierModel<any>, context: ClassifierContext, options?: any) => {
      const started = Date.now();
      const result = await registry.classify(model, context, options);
      logical.push({
        model: `${model.provider}/${model.id}`,
        api: model.api,
        context,
        result,
        durationMs: Date.now() - started,
      });
      return result;
    },
  };

  const classifier = await createModelClassifier(recordingRegistry, route, {
    onWarning: (message: string) => warnings.push(message),
  });
  if (!classifier) {
    console.error(`BLOCKER: createModelClassifier rejected route ${route}: ${warnings.join(" | ")}`);
    process.exitCode = 3;
    return;
  }

  const restoreFetch = installFetchRecorder();
  try {
    // Case 1: durable objective, no marker wording.
    const b1 = [user("u1", OBJECTIVE)];
    const r1 = await runTurn("objective-durable", b1, undefined, createLedger(), classifier, { kind: "objective" });
    check("objective-durable: item is protected", true, (r1.ledgerItems[0] as any)?.protectedItem);

    // Case 2: standing rule, multi-paragraph, no marker wording.
    await runTurn("rule-standing", [user("u1", RULE)], undefined, createLedger(), classifier, { kind: "rule" });

    // Case 3: durable decision, no marker wording.
    await runTurn("decision-durable", [user("u1", DECISION)], undefined, createLedger(), classifier, { kind: "decision" });

    // Case 4: steering scoped to the active anchor.
    const b4 = [user("u0", "ok"), label("l1", "u0", "anchor:ingest"), user("u1", STEERING, "l1")];
    const r4 = await runTurn("steering-scoped", b4, undefined, createLedger(), classifier, { kind: "steering" });
    check("steering-scoped: scopeAnchor recorded", "ingest", (r4.ledgerItems[0] as any)?.scopeAnchor);

    // Case 5: ephemeral chatter + question -> no ledger op.
    const b5 = [user("u1", EPHEMERAL)];
    const r5 = await runTurn("ephemeral", b5, undefined, createLedger(), classifier, { kind: "ephemeral" });
    check("ephemeral: no ledger ops", 0, r5.ops.length);

    // Case 6: long mixed instructions inside the 4000-char boundary.
    checkThat("mixed-long: length inside classifier boundary", "3000..3900 chars", MIXED_LONG.length > 3000 && MIXED_LONG.length < 3900, `${MIXED_LONG.length} chars`);
    await runTurn("mixed-long-instructions", [user("u1", MIXED_LONG)], undefined, createLedger(), classifier, { kind: "rule" });

    // Case 7/8: explicit newer-user supersession, SQLite -> PostgreSQL.
    const g1 = [user("u1", DECISION)];
    const first = await runTurn("supersede-step1-decision", g1, undefined, createLedger(), classifier, { kind: "decision" });
    const seedLedger = reduce(createLedger(), first.ops).ledger;
    const seedDecision = seedLedger.items[0];
    if (!seedDecision) throw new Error("step1 produced no ledger item");
    const g2 = [user("u1", DECISION), user("u2", DECISION.replace("We spent the last two days comparing the two cache options and I want to close that out.", "The contention numbers changed the picture, so I am reopening the cache choice."), "u1")];
    const second = await runTurn("supersede-step2-newer-user", g2, "u1", seedLedger, classifier, {
      kind: "decision",
    });
    const supVerdict = second.verdict;
    check(
      "supersede-step2: classifier names the older decision",
      [seedDecision.id],
      [...(supVerdict?.supersedes ?? [])],
    );
    check(
      "supersede-step2: op is supersede citing the newer entry",
      `supersede [${seedDecision.id}] citing u2`,
      second.ops[0]
        ? `${second.ops[0].op.op} ${JSON.stringify((second.ops[0].op as any).ids)} citing ${(second.ops[0].op as any).citedEntryId}`
        : "no op",
    );
    const after = reduce(seedLedger, second.ops);
    check("supersede-step2: reducer rejected nothing", [], after.rejected);
    const itemsAfter = after.ledger.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status, origin: i.source.origin, supersededBy: i.supersededBy }));
    console.log(JSON.stringify(itemsAfter));
    check("supersede-step2: old decision superseded", "superseded", itemsAfter.find((i) => i.id === seedDecision.id)?.status);
    const heirItem = itemsAfter.find((i) => i.id !== seedDecision.id);
    check("supersede-step2: heir active with user authority", "active/user", `${heirItem?.status}/${heirItem?.origin}`);
    check("supersede-step2: old links to heir", heirItem?.id, itemsAfter.find((i) => i.id === seedDecision.id)?.supersededBy);
    second.reduction = { applied: after.applied, rejected: after.rejected };

    // Diagnostics: same inputs, lower gate and a sibling route, to separate the
    // confidence gate from model calibration. Not part of the acceptance verdict.
    const lowGate = await createModelClassifier(recordingRegistry, route, {
      minConfidence: 0.3,
    });
    if (lowGate) {
      await probe("objective-durable", route, 0.3, lowGate, [user("u1", OBJECTIVE)], createLedger());
      await probe("supersede-step2-newer-user", route, 0.3, lowGate, g2, seedLedger, "u1");
    }
    const siblingRoute = "openrouter/~typesafe/jev-latest";
    if (available.some((m) => `${m.provider}/${m.id}` === siblingRoute)) {
      const sibling = await createModelClassifier(recordingRegistry, siblingRoute);
      if (sibling) {
        await probe("objective-durable", siblingRoute, 0.7, sibling, [user("u1", OBJECTIVE)], createLedger());
        await probe("supersede-step2-newer-user", siblingRoute, 0.7, sibling, g2, seedLedger, "u1");
      }
    }

    protectionChecks();
  } finally {
    restoreFetch();
  }

  const failed = checks.filter((c) => !c.pass);
  const configPath = "/home/furbyhaxx/.pi/agent/tree-navigator.json";
  let configuredClassifier: unknown;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    configuredClassifier = {
      path: configPath,
      hasContinuityBlock: parsed.continuity !== undefined,
      continuity: parsed.continuity ?? null,
    };
  } catch (error) {
    configuredClassifier = { path: configPath, error: String(error) };
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    configuredClassifier,
    diagnostics,
    host: { node: process.version, platform: process.platform },
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
    route,
    historicalRoute: HISTORICAL_ROUTE,
    historicalRouteAvailable: available.some((m) => `${m.provider}/${m.id}` === HISTORICAL_ROUTE),
    availableClassifiers: available.map((m) => ({ route: `${m.provider}/${m.id}`, api: m.api })),
    createModelClassifierWarnings: warnings,
    logicalCalls: logical,
    wireCalls: wire,
    cases,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  };
  writeFileSync(join(OUT_DIR, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nchecks: ${evidence.summary.passed}/${evidence.summary.total} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED ${f.name}: expected ${f.expected}, got ${f.actual}`);
  console.log(`logical classify calls: ${logical.length}, wire requests: ${wire.length}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
