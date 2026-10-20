import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverDescendantSessions,
  planDescendantCopies,
} from "./descendant-sessions.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "descendants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = join(directory, "sessions");
  const a = join(sessions, "--a--");
  const b = join(sessions, "--b--");
  await mkdir(a, { recursive: true });
  await mkdir(b);
  const body = Buffer.from(
    '{"type":"session_info","name":"unchanged"}\r\n\u0000\ufffd\n',
  );
  async function put(
    path: string,
    id: string,
    parentSession?: string,
    extra = {},
  ) {
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(
          `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: "/project", parentSession, custom: "kept", ...extra })}\n`,
        ),
        body,
      ]),
    );
  }
  const root = join(a, "root.jsonl");
  await put(root, "root");
  return { directory, a, b, body, put, root };
}

test("discovers a two-level path-linked family and plans immutable body copies", async (t) => {
  const f = await fixture(t);
  const alias = join(f.a, "alias.jsonl");
  await symlink(f.root, alias);
  const child = join(f.b, "child.jsonl");
  const grandchild = join(f.a, "grandchild.jsonl");
  await f.put(child, "child", alias);
  await f.put(grandchild, "grandchild", "../--b--/child.jsonl");
  await f.put(join(f.a, "orphan.jsonl"), "orphan", "/missing/session.jsonl");
  await f.put(join(f.a, "unrelated.jsonl"), "unrelated");
  await writeFile(join(f.b, "bad.jsonl"), "not json\n");
  const hidden = join(f.a, "nested");
  await mkdir(hidden);
  await f.put(join(hidden, "hidden.jsonl"), "hidden", f.root);
  const snapshots = await discoverDescendantSessions(f.root);
  assert.deepEqual(
    snapshots.map((s) => s.path),
    [child, grandchild],
  );
  const clone = join(f.a, "clone.jsonl");
  const plans = planDescendantCopies(snapshots, f.root, clone);
  for (const [index, plan] of plans.entries()) {
    const end = plan.bytes.indexOf(10);
    const header = JSON.parse(plan.bytes.subarray(0, end).toString());
    assert.deepEqual(plan.bytes.subarray(end + 1), f.body);
    assert.equal(header.parentSession, index === 0 ? clone : plans[0].path);
    assert.notEqual(header.id, plan.source.header.id);
    assert.equal(header.id, plan.sessionId);
    assert.equal(header.custom, "kept");
    assert.equal(
      plan.source.sha256,
      createHash("sha256")
        .update(await readFile(plan.source.path))
        .digest("hex"),
    );
    await assert.rejects(readFile(plan.path), { code: "ENOENT" });
  }
  await f.put(child, "changed", f.root);
  assert.notEqual(
    snapshots[0].sha256,
    createHash("sha256")
      .update(await readFile(child))
      .digest("hex"),
  );
  assert.equal((await discoverDescendantSessions(f.root, f.a)).length, 0);
});

test("rejects selected invalid versions, malformed headers, duplicate IDs and cycles", async (t) => {
  const f = await fixture(t);
  const child = join(f.a, "child.jsonl");
  await f.put(child, "child", f.root, { version: 99 });
  await assert.rejects(discoverDescendantSessions(f.root), /header\/version/);
  await f.put(child, "child", f.root, { cwd: null });
  await assert.rejects(discoverDescendantSessions(f.root), /header\/version/);
  await f.put(child, "root", f.root);
  await assert.rejects(
    discoverDescendantSessions(f.root),
    /Duplicate session ID/,
  );
  await f.put(child, "child", f.root);
  await f.put(f.root, "root", child);
  await assert.rejects(discoverDescendantSessions(f.root), /Cycle/);
});
