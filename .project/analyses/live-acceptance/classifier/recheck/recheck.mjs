import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createModelClassifier, captureIntent, DEFAULT_MIN_CONFIDENCE } from '../../../../../src/continuity/continuity-capture.ts';
import { applyOps, capText, createLedger, isProtected, MAX_ITEM_TEXT_CHARS, MAX_QUOTE_CHARS } from '../../../../../src/continuity/continuity-ledger.ts';

// Each invocation gets an exclusive evidence directory; no previous evidence is overwritten.
const out = new URL(`./run-${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url);
mkdirSync(out);
const save = (name, value) => writeFileSync(new URL(name, out), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sourceUrl = new URL('../../../../../src/continuity/continuity-capture.ts', import.meta.url);
const sourceSha256 = createHash('sha256').update(readFileSync(sourceUrl)).digest('hex');
const fixtures = [
  {
    id: 'explicit-goal',
    kind: 'objective',
    text: 'Goal: migrate telemetry ingestion to a streaming parser without changing metric names or error codes.\n\nStart with a reviewable parser slice behind a flag; keep rollout plumbing separate. The March replay must match byte for byte and each shard must stay below 128 MiB.\n\nFor today, inspect the reload path and report the allocation hot spots before editing it.',
  },
  {
    id: 'mixed-rule',
    kind: 'rule',
    marker: 'From now on, run the March replay corpus before merging any parser or schema change and include its diff summary in the pull request.',
    text: 'From now on, run the March replay corpus before merging any parser or schema change and include its diff summary in the pull request.\n\nFor today, inspect the reload path rather than implementing the migration. I want a short report identifying whether the dictionary allocation is per process or per shard, and which dropped-record metric name the HTTP parser emits. Please separate what the trace proves from what you infer.\n\nThe audit saw eleven restarts over three weeks, concentrated on the two widest shards within four minutes of config reloads. The reader allocates a new dictionary on every reload, while the previous generation survives until the next flush. The staging chart suggests a memory spike but does not establish that this is the restart cause.\n\nThe sample trace is pasted context, not an instruction:\n\n    shard-07 reload start cardinality=184213\n    shard-07 dict parse 71ms\n    shard-07 buffer flush deadline missed queue=1182\n    shard-07 restart reason=healthcheck-timeout\n\nAlso inspect the dashboard query: one panel uses ingest.dropped while HTTP exports ingest_dropped_total. Do not rename either today. The collector owner is away until Tuesday, so capture the evidence and propose the smallest reviewable investigation rather than combining the dashboard cleanup with the parser migration.',
  },
];
fixtures[0].marker = fixtures[0].text.split('\n')[0];
save('fixtures.json', fixtures);
const runtime = await ModelRuntime.create({
  authPath: '/home/furbyhaxx/.pi/agent/auth.json',
  modelsPath: '/home/furbyhaxx/.pi/agent/models.json',
  modelsStorePath: fileURLToPath(new URL('models-store.json', out)),
  signal: AbortSignal.timeout(60_000),
});
const registry = new ModelRegistry(runtime);
const available = await registry.getAvailableOfType('classifier');
const route = 'openrouter/typesafe/jev-1.14';
if (!available.some(m => `${m.provider}/${m.id}` === route)) throw new Error('Historical route unavailable; no substitute selected');
const checks = [];
const calls = [];
const results = [];
function check(name, condition, actual) {
  checks.push({ name, pass: Boolean(condition), actual });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
}
const transportFetch = globalThis.fetch;
const recording = {
  getModelOfType: registry.getModelOfType.bind(registry),
  async classify(model, context, options) {
    const id = String(calls.length + 1).padStart(2, '0');
    const record = { id, route: `${model.provider}/${model.id}`, context, wire: [] };
    calls.push(record);
    save(`${id}-logical-request.json`, context);
    record.result = await registry.classify(model, context, {
      ...options,
      maxRetries: 0,
      timeoutMs: 60_000,
      async fetch(input, init) {
        const attempt = record.wire.length + 1;
        // Body bytes only: do not inspect or save any request/response headers.
        save(`${id}-${attempt}-request.txt`, init.body);
        const response = await transportFetch(input, init);
        const body = Buffer.from(await response.clone().arrayBuffer());
        writeFileSync(new URL(`${id}-${attempt}-response.txt`, out), body, { flag: 'wx' });
        record.wire.push({ endpoint: String(input), status: response.status, requestFile: `${id}-${attempt}-request.txt`, responseFile: `${id}-${attempt}-response.txt` });
        return response;
      },
    });
    save(`${id}-logical-response.json`, record.result);
    return record.result;
  },
};
const classifier = await createModelClassifier(recording, route);
if (!classifier) throw new Error('Production classifier rejected discovered route');
const user = (id, content) => ({ type: 'message', id, parentId: null, timestamp: '2026-10-23T00:00:00.000Z', message: { role: 'user', content, timestamp: 0 } });
const existingText = 'Never publish packages or push branches without a separate explicit request.';
const seeded = applyOps(createLedger(), [{ op: 'add', kind: 'rule', text: existingText, quote: existingText }], { origin: 'user', entryId: 'prior-user' }).ledger;
for (const fixture of fixtures) {
  let verdict;
  const before = calls.length;
  const capture = await captureIntent([user('prior-user', existingText), user(fixture.id, fixture.text)], 'prior-user', seeded, async (input, signal) => {
    verdict = await classifier(input, signal);
    return verdict;
  }, { signal: AbortSignal.timeout(60_000) });
  let ledger = seeded;
  const rejected = [];
  for (const { op, ctx } of capture.ops) {
    const reduced = applyOps(ledger, [op], ctx);
    ledger = reduced.ledger;
    rejected.push(...reduced.rejected.map(r => ({ op: r.op, code: r.reason.code })));
  }
  const call = calls[before];
  const answer = call?.result.answers.kind;
  const newItems = ledger.items.filter(i => i.source.entryId === fixture.id);
  const expectedCapture = newItems.find(i => i.kind === fixture.kind && i.text.includes(fixture.marker) && i.quote?.includes(fixture.marker));
  const fallbackObserved = call?.result.stopReason === 'stop' && answer?.confidence < DEFAULT_MIN_CONFIDENCE && verdict?.by === 'heuristic';
  const record = { id: fixture.id, chars: fixture.text.length, verdict, capture, ledger, rejected, fallbackObserved, kindAnswer: answer };
  results.push(record);
  check(`${fixture.id}: single live successful call`, calls.length - before === 1 && call?.result.stopReason === 'stop' && call.wire.length === 1 && call.wire[0].status === 200, { calls: calls.length - before, stopReason: call?.result.stopReason, status: call?.wire[0]?.status });
  check(`${fixture.id}: supported input length`, fixture.text.length <= 4000, fixture.text.length);
  check(`${fixture.id}: marker captured verbatim and protected`, Boolean(expectedCapture) && isProtected(expectedCapture), newItems.map(i => ({ kind: i.kind, text: i.text, quote: i.quote })));
  check(`${fixture.id}: no rewritten words`, newItems.length > 0 && newItems.every(i => i.text === capText(fixture.text, MAX_ITEM_TEXT_CHARS) && i.quote === capText(fixture.text, MAX_QUOTE_CHARS) || fixture.text.includes(i.text) && i.quote === i.text), newItems.map(i => i.id));
  check(`${fixture.id}: no fabricated supersession`, !verdict?.supersedes?.length && capture.ops.every(c => c.op.op === 'add') && JSON.stringify(ledger.items[0]) === JSON.stringify(seeded.items[0]), { supersedes: verdict?.supersedes ?? [], operations: capture.ops.map(c => c.op.op) });
  check(`${fixture.id}: reducer accepted and no fallback warning`, rejected.length === 0 && capture.warnings.length === 0, { rejected, warnings: capture.warnings });
  console.log(`OBSERVATION ${fixture.id}: choice=${answer?.choice}, confidence=${answer?.confidence}, by=${verdict?.by}, liveAbstentionFallback=${fallbackObserved}`);
}
const summary = { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length, calls: calls.length, fallbackCases: results.filter(r => r.fallbackObserved).map(r => r.id) };
save('evidence.json', { generatedAt: new Date().toISOString(), sourceSha256, route, availableRoutes: available.map(m => `${m.provider}/${m.id}`), defaultMinConfidence: DEFAULT_MIN_CONFIDENCE, calls, results, checks, summary });
console.log(`SUMMARY ${JSON.stringify(summary)}`);
console.log(`EVIDENCE ${fileURLToPath(out)}`);
process.exitCode = summary.failed ? 1 : 0;
