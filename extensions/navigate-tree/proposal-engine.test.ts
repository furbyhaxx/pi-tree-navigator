import * as assert from "node:assert/strict";
import { it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type ProposalModelRunner,
  ProposalRequestError,
  proposeTree,
} from "./proposal-engine.ts";
import { buildHeuristicPlan } from "./proposal-source.ts";
import type { SessionSnapshot } from "./retrospective-plan.ts";

function snapshot(count = 3, size = 20): SessionSnapshot {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries: SessionEntry[] = Array.from({ length: count }, (_, i) => ({
    type: "message",
    id: `id-${i}`,
    parentId: i ? `id-${i - 1}` : null,
    timestamp,
    message: {
      role: "user",
      content: `RECORD_${i}_${"x".repeat(size)}`,
      timestamp: 0,
    },
  }));
  return {
    path: "/history.jsonl",
    sha256: "a".repeat(64),
    name: "Work",
    header: { type: "session", id: "s", version: 3, cwd: "/", timestamp },
    entries,
    safeCuts: new Set(entries.map((_, i) => i)),
    pendingToolCalls: [],
  };
}
const observed: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function runner(
  source: SessionSnapshot,
  requests: string[],
  final?: string,
): ProposalModelRunner {
  return {
    name: "fake",
    contextWindow: 14000,
    maxOutputTokens: 1000,
    async complete(request) {
      assert.ok(
        Buffer.byteLength(request.text) +
          Buffer.byteLength(request.systemPrompt) +
          512 +
          1000 <=
          14000,
      );
      assert.match(request.systemPrompt, /UNTRUSTED/);
      requests.push(request.text);
      return {
        text: request.text.startsWith("Refine")
          ? (final ??
            JSON.stringify({ groups: buildHeuristicPlan(source).groups }))
          : JSON.stringify({ evidence: "Historical work remains open." }),
        usage: observed,
      };
    },
  };
}

it("returns a deterministic no-model proposal with zero calls", async () => {
  const source = snapshot();
  const result = await proposeTree(source);
  assert.deepEqual(result.plan, buildHeuristicPlan(source));
  assert.equal(result.method, "heuristic");
  assert.equal(result.calls, 0);
});

it("covers every large record across bounded extraction calls before refinement", async () => {
  const source = snapshot(12, 5000);
  const requests: string[] = [];
  const result = await proposeTree(source, { model: runner(source, requests) });
  assert.equal(result.method, "model");
  assert.ok(result.calls > 4);
  assert.equal(result.usage.length, result.calls);
  for (let i = 0; i < 12; i++)
    assert.ok(requests.some((text) => text.includes(`RECORD_${i}_`)));
  assert.match(requests.at(-1) ?? "", /safeCutAfterIds/);
  assert.match(requests.at(-1) ?? "", /boundaries/);
});

it("splits one huge record without losing textual fragments", async () => {
  const source = snapshot(1, 0);
  const original = Array.from({ length: 800 }, (_, i) => `UNIQUE_${i};`).join(
    "",
  );
  const entry = source.entries[0];
  if (entry.type === "message" && entry.message.role === "user")
    entry.message.content = original;
  const requests: string[] = [];
  const model = runner(source, requests);
  const result = await proposeTree(source, {
    model: {
      ...model,
      contextWindow: 5000,
      maxOutputTokens: 1000,
      async complete(request) {
        requests.push(request.text);
        assert.ok(
          Buffer.byteLength(request.text) +
            Buffer.byteLength(request.systemPrompt) +
            1512 <=
            5000,
        );
        return {
          text: request.text.startsWith("Refine")
            ? JSON.stringify({ groups: buildHeuristicPlan(source).groups })
            : JSON.stringify({ evidence: "Open task" }),
        };
      },
    },
  });
  assert.equal(result.method, "model");
  const extracted = requests
    .filter((text) => text.startsWith("Extract"))
    .map((text) =>
      text
        .replace(/^.*\n/, "")
        .replace(/Record "id-0" fragment: /g, "")
        .replace(/\n/g, ""),
    )
    .join("");
  assert.ok(extracted.includes(original));
});

it("tool secrets never enter any request, while calls-only preserves arguments alone", async () => {
  const source = snapshot();
  source.entries.push(
    ...(JSON.parse(
      JSON.stringify([
        {
          type: "message",
          id: "call",
          parentId: "id-2",
          timestamp: "now",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-id",
                name: "secret-tool",
                arguments: { value: "SECRET_ARGUMENT" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "call",
          timestamp: "now",
          message: {
            role: "toolResult",
            toolCallId: "tool-id",
            toolName: "secret-tool",
            content: [{ type: "text", text: "SECRET_RESULT" }],
            details: { text: "SECRET_DETAILS" },
          },
        },
      ]),
    ) as SessionEntry[]),
  );
  for (const mode of ["omit", "calls-only"] as const) {
    const requests: string[] = [];
    const result = await proposeTree(source, {
      input: { tools: { "secret-tool": mode } },
      model: runner(source, requests),
    });
    assert.equal(result.method, "model");
    const sent = requests.join("\n");
    assert.doesNotMatch(sent, /SECRET_RESULT|SECRET_DETAILS/);
    if (mode === "omit") assert.doesNotMatch(sent, /SECRET_ARGUMENT/);
    else assert.match(sent, /SECRET_ARGUMENT/);
  }
});

it("falls back for malformed, unknown-key, hallucinated, crossing and missing-tail output", async () => {
  const source = snapshot();
  const groups = buildHeuristicPlan(source).groups;
  for (const final of [
    "not JSON",
    JSON.stringify({ groups, source: "replacement" }),
    JSON.stringify({ groups: [{ ...groups[0], firstEntryId: "invented" }] }),
    JSON.stringify({
      groups: [{ ...groups[0], firstEntryId: "id-2", lastEntryId: "id-0" }],
    }),
    JSON.stringify({
      groups: [{ ...groups[0], lastEntryId: "id-1", children: [] }],
    }),
  ]) {
    const result = await proposeTree(source, {
      model: runner(source, [], final),
    });
    assert.equal(result.method, "heuristic");
    assert.equal(result.calls, 2);
    assert.equal(result.usage.length, 2);
    assert.match(result.warnings.join(" "), /using deterministic/);
  }
});

it("retains failed provider usage and never exposes echoed provider text", async () => {
  const source = snapshot();
  const result = await proposeTree(source, {
    model: {
      ...runner(source, []),
      async complete() {
        throw new ProposalRequestError("SECRET echoed input", observed);
      },
    },
  });
  assert.equal(result.method, "heuristic");
  assert.equal(result.calls, 1);
  assert.deepEqual(result.usage, [observed]);
  assert.doesNotMatch(result.warnings.join(" "), /SECRET/);
});

it("propagates caller and provider aborts rather than successful fallback", async () => {
  const source = snapshot();
  const controller = new AbortController();
  await assert.rejects(
    proposeTree(source, {
      signal: controller.signal,
      model: {
        ...runner(source, []),
        async complete(request) {
          assert.equal(request.signal, controller.signal);
          controller.abort();
          return { text: "{}" };
        },
      },
    }),
    { name: "AbortError" },
  );
  await assert.rejects(
    proposeTree(source, {
      model: {
        ...runner(source, []),
        async complete() {
          throw new DOMException("aborted", "AbortError");
        },
      },
    }),
    { name: "AbortError" },
  );
  await assert.rejects(proposeTree(source, { signal: controller.signal }), {
    name: "AbortError",
  });
});

it("consolidates extracted evidence hierarchically without dropping the ID inventory", async () => {
  const source = snapshot(6, 10000);
  const requests: string[] = [];
  const result = await proposeTree(source, {
    model: {
      name: "hierarchical-fake",
      contextWindow: 8000,
      maxOutputTokens: 1000,
      async complete(request) {
        requests.push(request.text);
        assert.ok(
          Buffer.byteLength(request.text) +
            Buffer.byteLength(request.systemPrompt) +
            1512 <=
            8000,
        );
        return {
          text: request.text.startsWith("Refine")
            ? JSON.stringify({ groups: buildHeuristicPlan(source).groups })
            : JSON.stringify({
                evidence: request.text.startsWith("Consolidate")
                  ? "Consolidated open historical phases."
                  : "e".repeat(900),
              }),
        };
      },
    },
  });
  assert.equal(result.method, "model");
  assert.ok(requests.some((text) => text.startsWith("Consolidate")));
  for (const entry of source.entries)
    assert.ok(requests.at(-1)?.includes(entry.id));
});

it("reports budget and non-progress consolidation fallback explicitly", async () => {
  const source = snapshot();
  const tiny = await proposeTree(source, {
    model: { ...runner(source, []), contextWindow: 500 },
  });
  assert.equal(tiny.calls, 0);
  assert.match(tiny.warnings.join(" "), /budget/);
  const large = snapshot(3, 3000);
  const result = await proposeTree(large, {
    model: {
      ...runner(large, []),
      contextWindow: 5000,
      maxOutputTokens: 1000,
      async complete() {
        return { text: JSON.stringify({ evidence: "z".repeat(1700) }) };
      },
    },
  });
  assert.equal(result.method, "heuristic");
  assert.match(result.warnings.join(" "), /consolidation|budget/);
});
