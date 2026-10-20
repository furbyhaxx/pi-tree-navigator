import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
} from "./retrospective.ts";
import { inspectRetrospectiveSession } from "./retrospective-plan.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const timestamp = "2026-01-01T00:00:00.000Z";
type TestEntry = {
  id: string;
  type: string;
  parentId?: string | null;
  [key: string]: unknown;
};
type TestGroup = {
  name: string;
  firstEntryId: string;
  lastEntryId: string;
  summary: string;
  children: TestGroup[];
};

function group(
  name: string,
  firstEntryId: string,
  lastEntryId: string,
  summary = `${name} complete.`,
  children: TestGroup[] = [],
): TestGroup {
  return { name, firstEntryId, lastEntryId, summary, children };
}

function message(id: string, value: Record<string, unknown>): TestEntry {
  return { type: "message", id, message: value };
}

function user(id: string, content: string): TestEntry {
  return message(id, { role: "user", content, timestamp: 1 });
}

function linear(entries: TestEntry[]): TestEntry[] {
  let parentId: string | null = null;
  return entries.map((entry) => {
    const record = {
      timestamp,
      ...entry,
      parentId: entry.parentId ?? parentId,
    };
    parentId = entry.id;
    return record;
  });
}

function defaultGroups(): TestGroup[] {
  return [
    group("phase", "one", "three", "Completed phase; continue with tail.", [
      group("first", "one", "one", "First task complete."),
      group("second", "two", "three", "Second task complete."),
    ]),
  ];
}

async function fixture(
  options: { entries?: TestEntry[]; groups?: TestGroup[] } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "tree-retrospective-"));
  directories.push(dir);
  const source = join(dir, "source.jsonl");
  const records = [
    { type: "session", version: 3, id: "original", cwd: dir, timestamp },
    ...linear(
      options.entries ?? [
        { type: "session_info", id: "name", name: "Original" },
        ...["one", "two", "three", "tail"].map((id) =>
          user(id, `Question ${id}`),
        ),
      ],
    ),
  ];
  const content = `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(source, content);
  const plan = {
    version: 1,
    source,
    sourceSha256: createHash("sha256").update(content).digest("hex"),
    groups: options.groups ?? defaultGroups(),
  };
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  return { dir, source, plan, planPath };
}

function systemState(context: ReturnType<typeof buildSessionContext>) {
  const system = getCurrentSystemMessage(context.messages);
  return {
    content: system?.content ?? "",
    sections: system?.sections ?? {},
    tools: system?.toolsAdded ?? [],
  };
}

describe("retrospective clone", () => {
  it("preserves source bytes and messages, nests summaries, and resumes on the tail", async () => {
    const f = await fixture();
    const before = await readFile(f.source);
    const preview = await previewRetrospectiveSession(f.planPath);
    assert.equal((await readdir(f.dir)).length, 2);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    assert.deepEqual(await readFile(f.source), before);
    const clone = SessionManager.open(result.path);
    assert.notEqual(clone.getSessionId(), "original");
    assert.equal(clone.getSessionName(), "Original (restructured)");
    assert.equal(clone.getHeader()?.parentSession, f.source);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.equal(
      clone.getEntries().filter((entry) => entry.type === "message").length,
      4,
    );
    const summaries = clone
      .getEntries()
      .filter((entry) => entry.type === "branch_summary");
    assert.equal(summaries.length, 3);
    const active = clone.buildSessionContext().messages;
    assert.deepEqual(
      active.map((message) => message.role),
      ["branchSummary", "user"],
    );
    const tail = active.at(-1);
    assert.equal(tail?.role === "user" && tail.content, "Question tail");
    const phase = summaries.find(
      (entry) => clone.getLabel(entry.id) === "anchor:phase",
    );
    assert.ok(phase);
    const nested = clone.getBranch(phase.fromId);
    assert.equal(
      nested.filter((entry) => entry.type === "branch_summary").length,
      2,
    );
    for (const id of ["one", "two", "three", "tail"])
      assert.ok(clone.getEntry(id));
    const reloaded = SessionManager.open(result.path);
    assert.deepEqual(
      reloaded.buildSessionContext(),
      clone.buildSessionContext(),
    );
  });

  it("refuses a changed source or changed plan after preview without publishing a clone", async () => {
    const f = await fixture();
    const preview = await previewRetrospectiveSession(f.planPath);
    f.plan.groups[0].summary = "Different summary.";
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await assert.rejects(
      cloneRetrospectiveSession(f.planPath, preview.previewToken),
      /preview/i,
    );
    await writeFile(f.source, `${await readFile(f.source, "utf8")} `);
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /changed|hash|snapshot/i,
    );
    assert.equal((await readdir(f.dir)).length, 2);
  });

  it("refuses overlapping siblings and malformed source records", async () => {
    const f = await fixture();
    f.plan.groups[0].children[1].firstEntryId = "one";
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /overlap|ordered/i,
    );
    await writeFile(f.source, `${await readFile(f.source, "utf8")}not json\n`);
    await assert.rejects(inspectRetrospectiveSession(f.source));
  });

  it("rejects a compaction target hidden in an earlier sibling and preserves it when the boundary moves before the target", async () => {
    const f = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        user("before", "Before retained context"),
        user("target", "Retained context"),
        user("work", "Later work"),
        {
          type: "compaction",
          id: "compact",
          firstKeptEntryId: "target",
          summary: "Original compaction summary",
          tokensBefore: 7,
          details: { retainedPayload: "original" },
        },
        user("tail", "Continue"),
      ],
      groups: [
        group("earlier", "before", "target"),
        group("later", "work", "compact"),
      ],
    });
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /Compaction compact retains target/,
    );

    f.plan.groups[0].lastEntryId = "before";
    await writeFile(f.planPath, JSON.stringify(f.plan));
    const preview = await previewRetrospectiveSession(f.planPath);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    const clone = SessionManager.open(result.path);
    const archived = clone
      .getEntries()
      .find((entry) => clone.getLabel(entry.id) === "branch:later");
    assert.ok(archived);
    const branch = clone.getBranch(archived.id);
    assert.ok(branch.some((entry) => entry.id === "target"));
    const compaction = branch.find(
      (entry) => entry.type === "compaction" && entry.id === "compact",
    );
    assert.ok(compaction?.type === "compaction");
    assert.equal(compaction.firstKeptEntryId, "target");
    assert.equal(compaction.summary, "Original compaction summary");
    assert.deepEqual(compaction.details, { retainedPayload: "original" });
  });

  it("refuses context edits crossing either side of a folded range", async () => {
    for (const [name, firstEntryId, lastEntryId] of [
      ["edit included, target excluded", "inside", "edit"],
      ["target included, edit excluded", "target", "inside"],
    ]) {
      const f = await fixture({
        entries: [
          { type: "session_info", id: "name", name: "Original" },
          user("target", "Original target"),
          user("inside", "Range content"),
          {
            type: "context_edit",
            id: "edit",
            targetId: "target",
            replacement: { content: "Edited target" },
          },
          user("tail", "Continue"),
        ],
        groups: [group("range", firstEntryId, lastEntryId)],
      });
      await assert.rejects(
        previewRetrospectiveSession(f.planPath),
        /context edit edit and target target must stay in the same range/i,
        name,
      );
    }
  });

  it("keeps an edit wholly inside a folded range effective on its archived branch", async () => {
    const f = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        user("target", "Original target"),
        {
          type: "context_edit",
          id: "edit",
          targetId: "target",
          replacement: { content: "Edited target" },
        },
        user("tail", "Continue"),
      ],
      groups: [group("phase", "target", "edit")],
    });
    const preview = await previewRetrospectiveSession(f.planPath);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    const clone = SessionManager.open(result.path);
    const archived = clone
      .getEntries()
      .find((entry) => clone.getLabel(entry.id) === "branch:phase");
    assert.ok(archived);
    clone.branch(archived.id);
    const context = clone.buildSessionContext();
    assert.ok(
      context.messages.some(
        (entry) => entry.role === "user" && entry.content === "Edited target",
      ),
    );
    assert.ok(
      !context.messages.some(
        (entry) => entry.role === "user" && entry.content === "Original target",
      ),
    );
  });

  it("refuses tool-call boundaries inside a batch and accepts a complete batch", async () => {
    const entries: TestEntry[] = [
      { type: "session_info", id: "name", name: "Original" },
      user("before", "Look this up"),
      message("call", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: 1,
      }),
      message("result", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: "Found it",
        isError: false,
        timestamp: 1,
      }),
      user("tail", "Continue"),
    ];
    const split = await fixture({
      entries,
      groups: [group("split", "call", "call")],
    });
    await assert.rejects(
      previewRetrospectiveSession(split.planPath),
      /boundary splits a tool call/i,
    );

    const complete = await fixture({
      entries,
      groups: [group("batch", "call", "result")],
    });
    const preview = await previewRetrospectiveSession(complete.planPath);
    const result = await cloneRetrospectiveSession(
      complete.planPath,
      preview.previewToken,
    );
    const source = SessionManager.open(complete.source);
    const clone = SessionManager.open(result.path);
    const archived = clone
      .getEntries()
      .find((entry) => clone.getLabel(entry.id) === "branch:batch");
    assert.ok(archived);
    const branch = clone.getBranch(archived.id);
    assert.deepEqual(clone.getEntry("call"), source.getEntry("call"));
    assert.deepEqual(clone.getEntry("result"), source.getEntry("result"));
    assert.ok(branch.some((entry) => entry.id === "call"));
    assert.ok(branch.some((entry) => entry.id === "result"));
  });

  it("preserves model, thinking, system sections, and tools across folded changes", async () => {
    const oldTool = {
      name: "old_tool",
      description: "Old tool",
      parameters: { type: "object", properties: {} },
    };
    const newTool = {
      name: "new_tool",
      description: "New tool",
      parameters: { type: "object", properties: {} },
    };
    const f = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        message("system-base", {
          role: "system",
          content: "Base system",
          sections: { policy: "Initial policy", temporary: "Remove later" },
          toolsAdded: [oldTool],
          timestamp: 1,
        }),
        {
          type: "model_change",
          id: "model-before",
          provider: "provider-a",
          modelId: "model-a",
        },
        {
          type: "thinking_level_change",
          id: "thinking-before",
          thinkingLevel: "low",
        },
        user("begin", "First folded message"),
        {
          type: "model_change",
          id: "model-after",
          provider: "provider-b",
          modelId: "model-b",
        },
        {
          type: "thinking_level_change",
          id: "thinking-after",
          thinkingLevel: "high",
        },
        message("system-update", {
          role: "system",
          content: "",
          sections: {
            policy: "Updated policy",
            temporary: null,
            added: "Additional section",
          },
          toolsRemoved: [{ name: "old_tool" }],
          toolsAdded: [newTool],
          timestamp: 2,
        }),
        user("finish", "Last folded message"),
        user("tail", "Continue"),
      ],
      groups: [group("phase", "begin", "finish")],
    });
    const preview = await previewRetrospectiveSession(f.planPath);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    const source = SessionManager.open(f.source);
    const clone = SessionManager.open(result.path);
    const activeLeaf = clone.getLeafId();
    assert.ok(activeLeaf);
    for (const id of [
      "begin",
      "model-after",
      "thinking-after",
      "system-update",
      "finish",
    ]) {
      const before = buildSessionContext(source.getEntries(), id);
      const after = buildSessionContext(clone.getEntries(), id);
      assert.deepEqual(after, before, id);
      assert.deepEqual(
        getCurrentSystemMessage(after.messages),
        getCurrentSystemMessage(before.messages),
        id,
      );
    }
    const before = buildSessionContext(source.getEntries(), "tail");
    const after = buildSessionContext(clone.getEntries(), activeLeaf);
    assert.deepEqual(after.model, before.model);
    assert.equal(after.thinkingLevel, before.thinkingLevel);
    assert.deepEqual(systemState(after), systemState(before));
    assert.deepEqual(getCurrentSystemMessage(after.messages)?.sections, {
      policy: "Updated policy",
      added: "Additional section",
    });
    assert.deepEqual(getCurrentSystemMessage(after.messages)?.toolsAdded, [
      newTool,
    ]);
    const anchor = clone
      .getEntries()
      .find((entry) => clone.getLabel(entry.id) === "anchor:phase");
    assert.ok(anchor);
    const selected = buildSessionContext(clone.getEntries(), anchor.id);
    assert.deepEqual(selected.model, before.model);
    assert.equal(selected.thinkingLevel, before.thinkingLevel);
    assert.deepEqual(systemState(selected), systemState(before));
  });

  it("refuses a folded checkpoint that replaces unreplayable plain system text", async () => {
    const f = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        message("system-base", {
          role: "system",
          content: "Base system text",
          timestamp: 1,
        }),
        user("target", "Kept message"),
        {
          type: "compaction",
          id: "checkpoint",
          firstKeptEntryId: "target",
          summary: "Checkpoint summary",
          tokensBefore: 10,
          systemMessage: {
            role: "system",
            content: "Replacement system text",
            timestamp: 2,
          },
        },
        user("tail", "Continue"),
      ],
      groups: [group("checkpoint", "target", "checkpoint")],
    });
    await assert.rejects(
      previewRetrospectiveSession(f.planPath),
      /replaces plain system text/i,
    );
  });

  it("refuses branched sources and duplicate entry IDs", async () => {
    const branched = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        user("one", "First branch"),
        { ...user("two", "Second branch"), parentId: "name" },
      ],
      groups: [group("phase", "one", "two")],
    });
    await assert.rejects(
      previewRetrospectiveSession(branched.planPath),
      /Source must be linear/i,
    );

    const duplicate = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        user("one", "First entry"),
        user("one", "Duplicate entry"),
      ],
      groups: [group("phase", "one", "one")],
    });
    await assert.rejects(
      previewRetrospectiveSession(duplicate.planPath),
      /Duplicate entry id: one/i,
    );
  });

  it("preserves a valid bash execution message without content", async () => {
    const f = await fixture({
      entries: [
        { type: "session_info", id: "name", name: "Original" },
        user("before", "Run a command"),
        message("bash", {
          role: "bashExecution",
          command: "printf safety",
          output: "safety",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        }),
        user("tail", "Continue"),
      ],
      groups: [group("command", "bash", "bash")],
    });
    const preview = await previewRetrospectiveSession(f.planPath);
    const result = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    const sourceEntry = SessionManager.open(f.source).getEntry("bash");
    const cloneEntry = SessionManager.open(result.path).getEntry("bash");
    assert.ok(sourceEntry?.type === "message");
    assert.ok(cloneEntry?.type === "message");
    assert.equal(sourceEntry.message.role, "bashExecution");
    assert.equal(cloneEntry.message.role, "bashExecution");
    assert.deepEqual(cloneEntry.message, sourceEntry.message);
    assert.ok(!("content" in cloneEntry.message));
  });

  it("rejects unsupported roles and orphan tool results", async () => {
    for (const invalid of [
      { role: "invented", content: "invalid", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "missing",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
        timestamp: 1,
      },
    ]) {
      const f = await fixture({
        entries: [user("first", "Question"), message("bad", invalid)],
        groups: [group("phase", "first", "bad")],
      });
      await assert.rejects(
        previewRetrospectiveSession(f.planPath),
        /unsupported|orphan|outstanding/i,
      );
      assert.equal((await readdir(f.dir)).length, 2);
    }
  });

  it("creates independent session IDs without overwriting earlier clones", async () => {
    const f = await fixture();
    const preview = await previewRetrospectiveSession(f.planPath);
    const first = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    const firstBytes = await readFile(first.path);
    const second = await cloneRetrospectiveSession(
      f.planPath,
      preview.previewToken,
    );
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.path, second.path);
    assert.notDeepEqual(firstBytes, await readFile(second.path));
    assert.deepEqual(await readFile(first.path), firstBytes);
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(second.path)).mode & 0o777, 0o600);
    assert.equal(
      SessionManager.open(first.path).getSessionId(),
      first.sessionId,
    );
    assert.equal(
      SessionManager.open(second.path).getSessionId(),
      second.sessionId,
    );
  });
});
