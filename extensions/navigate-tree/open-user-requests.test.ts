import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectOpenUserRequests } from "./open-user-requests.ts";

type Projected = { sourceEntry: SessionEntry; messages: AgentMessage[] };

const compaction = (requests: unknown): Projected => ({
  sourceEntry: {
    type: "compaction",
    id: "c",
    parentId: "x",
    timestamp: "",
    summary: "older work",
    firstKeptEntryId: "a1",
    tokensBefore: 1,
    details: { navigateTree: { pressure: { openUserRequests: requests } } },
  } as SessionEntry,
  messages: [
    {
      role: "compactionSummary",
      summary: "older work",
      tokensBefore: 1,
      timestamp: 0,
    } as never,
  ],
});
const assistant = (id: string, toolCall: boolean): Projected => ({
  sourceEntry: { type: "message", id, parentId: null, timestamp: "" } as never,
  messages: [
    {
      role: "assistant",
      content: toolCall
        ? [{ type: "toolCall", id: `${id}-call`, name: "read", arguments: {} }]
        : [{ type: "text", text: "done" }],
      stopReason: toolCall ? "toolUse" : "stop",
    } as never,
  ],
});

describe("collectOpenUserRequests across a pressure compaction", () => {
  const request = { sourceEntryId: "u1", text: "migrate every crate" };

  it("keeps a request a pressure compaction quoted open while the agent keeps working", () => {
    const entries = [
      compaction([request]),
      assistant("a1", true),
      assistant("a2", true),
    ];
    assert.deepEqual(
      collectOpenUserRequests(entries, "a2", new Set(["a1", "a2"]), "rewind"),
      [request],
    );
  });

  it("closes it on a final text reply and ignores malformed details", () => {
    assert.deepEqual(
      collectOpenUserRequests(
        [compaction([request]), assistant("a1", false)],
        "a1",
        new Set(["a1"]),
        "rewind",
      ),
      [],
    );
    assert.deepEqual(
      collectOpenUserRequests(
        [compaction("nope"), assistant("a1", true)],
        "a1",
        new Set(["a1"]),
        "rewind",
      ),
      [],
    );
  });
});
