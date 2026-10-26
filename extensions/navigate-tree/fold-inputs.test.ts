import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  anchorMessageIndex,
  buildFoldProjection,
  buildFoldSegment,
  buildInContextMessages,
} from "./fold-inputs.ts";
import { makeHandoff, materializeHandoff } from "./handoff.ts";
import { projectHandoffs } from "./handoff-projection.ts";

let clock = 0;
const timestamp = () => ++clock;

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: timestamp(),
});

const assistant = (content: Array<Record<string, unknown>>) =>
  ({
    role: "assistant",
    content,
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: timestamp(),
  }) as never;

const said = (text: string) => assistant([{ type: "text", text }]);

const handoff = (name: string) =>
  makeHandoff({
    name,
    report: `## Goal\n${name} goal\n\n### Done\n${name} outcome`,
    mode: "full",
    children: [],
    sourceEntries: [],
  });

/** kickoff, an old handoff, the anchor, then a collapsed segment with every record kind. */
function fixture() {
  const sm = SessionManager.inMemory();
  const kickoff = sm.appendMessage(user("kickoff"));
  const oldHandoff = handoff("old");
  sm.branchWithSummary(kickoff, materializeHandoff(oldHandoff, []), {
    treeNavigator: oldHandoff,
  });
  sm.appendMessage(user("background question"));
  sm.appendMessage(assistant([]));
  const target = sm.appendMessage(said("anchor reached"));
  const ask = sm.appendMessage(user("do the thing"));
  const call = sm.appendMessage(
    assistant([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "reading" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ]),
  );
  const result = sm.appendMessage({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    content: [
      { type: "text", text: "file body" },
      { type: "image", data: "AAAAAAAA", mimeType: "image/png" },
    ],
    isError: false,
    timestamp: timestamp(),
  } as never);
  sm.appendCustomMessageEntry("note", "visible note", true);
  sm.appendCustomMessageEntry("note", "hidden note", false);
  const child = handoff("child");
  sm.branchWithSummary(sm.getLeafId() ?? null, materializeHandoff(child, []), {
    treeNavigator: child,
  });
  sm.branchWithSummary(sm.getLeafId() ?? null, "plain report");
  const last = sm.appendMessage(user("next"));
  return { sm, target, ask, call, result, last, oldHandoff, child };
}

describe("buildFoldSegment", () => {
  it("lists the projected anchor-to-leaf records in order with full text and placeholders", () => {
    const f = fixture();
    const { records, background } = buildFoldSegment(
      f.sm.getEntries(),
      f.last,
      f.target,
    );
    assert.deepEqual(
      records.map((r) => [r.id, r.role]),
      [
        [f.ask, "user"],
        [f.call, "assistant"],
        [f.result, "tool"],
        [records[3].id, "custom"],
        [records[4].id, "summary"],
        [records[5].id, "summary"],
        [f.last, "user"],
      ],
    );
    assert.equal(records[0].text, "do the thing");
    assert.equal(records[1].text, 'reading\n[tool call read] {"path":"a.ts"}');
    assert.equal(
      records[2].text,
      "[result of read]\nfile body\n[image omitted: image/png, 6 bytes]",
    );
    assert.equal(records[3].text, "visible note");
    assert.equal(records[4].text, materializeHandoff(f.child, []));
    assert.match(records[5].text, /summary of a branch[\s\S]*plain report/);
    assert.equal(records[6].text, "next");
    assert.ok(
      records.every((r) => !r.text.includes("private reasoning")),
      "thinking is not evidence",
    );
    assert.equal(background, materializeHandoff(f.oldHandoff, []));
  });

  it("does not truncate a long record and leaves the background empty without an earlier handoff", () => {
    const sm = SessionManager.inMemory();
    const target = sm.appendMessage(said("anchor"));
    const long = "x".repeat(300_000);
    sm.appendMessage(user(long));
    const leaf = sm.appendMessage(said("ok"));
    const segment = buildFoldSegment(sm.getEntries(), leaf, target);
    assert.equal(segment.background, "");
    assert.equal(segment.records[0].text, long);
  });

  it("applies context edits exactly as the model saw them", () => {
    const f = fixture();
    f.sm.appendContextEdit(f.result, {
      content: [{ type: "text", text: "edited result" }],
    });
    f.sm.appendContextEdit(f.ask, null);
    const leaf = f.sm.appendMessage(user("after edits"));
    const { records } = buildFoldSegment(f.sm.getEntries(), leaf, f.target);
    assert.equal(
      records.find((r) => r.id === f.result)?.text,
      "[result of read]\nedited result",
    );
    assert.equal(
      records.some((r) => r.id === f.ask),
      false,
    );
  });

  it("restricts current edited evidence to the fold ancestry for both strategies", () => {
    const sm = SessionManager.inMemory();
    const target = sm.appendMessage(said("anchor"));
    const work = sm.appendMessage(said("obsolete work"));
    sm.appendMessage(user("unanswered exact request"));
    sm.appendCustomMessageEntry("other", "unanswered custom", true);
    sm.appendLabelChange(work, "metadata");
    sm.appendContextEdit(work, {
      content: [{ type: "text", text: "current edited work" }],
    });
    const leaf = sm.getLeafId();
    assert.ok(leaf);
    const projection = buildFoldProjection(sm.getEntries(), leaf, work);
    const inContext = buildInContextMessages(
      [],
      projection.messages,
      anchorMessageIndex(projection, target),
    );
    const segment = buildFoldSegment(sm.getEntries(), leaf, target, work);
    assert.deepEqual(
      segment.records.map((record) => record.text),
      ["current edited work"],
    );
    const text = JSON.stringify(inContext.messages);
    assert.match(text, /current edited work/);
    assert.doesNotMatch(text, /obsolete work|unanswered/);
  });

  it("treats every visible message as collapsed when the anchor predates a compaction", () => {
    const sm = SessionManager.inMemory();
    const target = sm.appendMessage(user("old anchor"));
    sm.appendMessage(said("old work"));
    const kept = sm.appendMessage(user("kept question"));
    sm.appendMessage(said("kept answer"));
    sm.appendCompaction("COMPACTED", kept, 1000);
    const leaf = sm.appendMessage(user("after"));
    const { records, background } = buildFoldSegment(
      sm.getEntries(),
      leaf,
      target,
    );
    assert.equal(background, "");
    assert.deepEqual(
      records.map((r) => [r.role, r.text.slice(0, 16)]),
      [
        ["summary", "The conversation"],
        ["user", "kept question"],
        ["assistant", "kept answer"],
        ["user", "after"],
      ],
    );
    assert.match(records[0].text, /COMPACTED/);
  });
});

describe("buildInContextMessages", () => {
  const system: Message = {
    role: "system",
    content: "SYSTEM PROMPT",
    timestamp: 0,
  };
  const textOf = (message: Message | undefined) =>
    message && "content" in message && typeof message.content !== "string"
      ? message.content.map((b) => ("text" in b ? b.text : "")).join("")
      : "";

  it("puts the captured system messages first and numbers the first collapsed message as the model sees it", () => {
    const f = fixture();
    const entries = f.sm.getEntries();
    const projection = projectHandoffs(
      buildSessionProjection(entries, f.last),
      entries,
    );
    const at = anchorMessageIndex(projection, f.target);
    const { messages, first } = buildInContextMessages(
      [system],
      projection.messages,
      at,
    );
    assert.equal(messages[0], system);
    assert.deepEqual(messages.slice(1), convertToLlm(projection.messages));
    const seen = messages.filter(
      (m) =>
        m.role !== "system" && !(m.role === "assistant" && !m.content.length),
    );
    assert.equal(textOf(seen[first - 1]), "do the thing");
    assert.match(textOf(seen[first - 2]), /anchor reached/);
  });

  it("numbers from 1 when the anchor is not in the projection and ignores projected system messages", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "system", content: "delta", timestamp: 0 });
    const a = sm.appendMessage(user("one"));
    sm.appendMessage(said("two"));
    const leaf = sm.appendMessage(user("three"));
    const entries = sm.getEntries();
    const projection = buildSessionProjection(entries, leaf);
    assert.equal(anchorMessageIndex(projection, "missing"), -1);
    assert.equal(
      buildInContextMessages([system], projection.messages, -1).first,
      1,
    );
    const at = anchorMessageIndex(projection, a);
    assert.equal(
      buildInContextMessages([system], projection.messages, at).first,
      2,
    );
  });
});
