// Real @earendil-works/pi-coding-agent SessionManager only; no navigate-tree code.
// Establishes: append order (memory before disk), branch() durability, label side effects.
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const asst = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic", provider: "claude", model: "m", stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const ids = (sm) => sm.getBranch().map((e) => `${e.type}:${e.id}`);
const diskIds = (file) =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type !== "session").map((e) => `${e.type}:${e.id}<-${e.parentId}`);
const out = (k, v) => console.log(`${k} = ${JSON.stringify(v)}`);

const dir = mkdtempSync(join(tmpdir(), "late-input-sdk-"));
try {
  // E1: in-memory manager cannot fail on append.
  const mem = SessionManager.inMemory("/tmp");
  out("E1.inMemory.isPersisted", mem.isPersisted());

  // E2: persistent EACCES on the late append of a file-backed manager.
  const sm = SessionManager.create("/tmp", dir);
  const u1 = sm.appendMessage(user("u1"));
  const a1 = sm.appendMessage(asst("a1"));
  const file = sm.getSessionFile();
  out("E2.setup.disk", diskIds(file));
  chmodSync(file, 0o444);
  let threw = null;
  let lateId;
  try {
    lateId = sm.appendMessage(user("LATE REQUEST"));
  } catch (e) {
    threw = e.code ?? e.message;
  }
  out("E2.append.threw", threw);
  out("E2.memory.leafIsFailedEntry", sm.getLeafId() !== a1);
  out("E2.memory.branch", ids(sm));
  out("E2.memory.entriesCount", sm.getEntries().length);
  out("E2.disk", diskIds(file));
  chmodSync(file, 0o644);

  // E3: transient failure: the next append succeeds, its parent is the entry that never reached disk.
  const next = sm.appendCustomMessageEntry("note", "after the failed append", true);
  out("E3.disk", diskIds(file));
  const re = SessionManager.open(file);
  out("E3.reload.leaf", re.getLeafId());
  out("E3.reload.branch", ids(re));
  out("E3.reload.contextMessages", re.buildSessionContext().messages.map((m) => m.role));
  out("E3.memory.contextMessages", sm.buildSessionContext().messages.map((m) => m.role));

  // E4: branch() only moves the in-memory leaf; the reloaded leaf is the last entry in the file.
  const sm2 = SessionManager.create("/tmp", dir);
  const b1 = sm2.appendMessage(user("v1"));
  const b2 = sm2.appendMessage(asst("v2"));
  const file2 = sm2.getSessionFile();
  const summary = sm2.branchWithSummary(b1, "summary", {}, true);
  out("E4.afterSummary.leafIsSummary", sm2.getLeafId() === summary);
  sm2.branch(b2);
  out("E4.memory.leafAfterBranch", sm2.getLeafId() === b2);
  out("E4.disk", diskIds(file2));
  out("E4.reload.leafIsSummary", SessionManager.open(file2).getLeafId() === summary);
  const anchor = sm2.appendCustomEntry("rollback-anchor", { why: "test" });
  out("E4.afterAnchor.reload.leafIsAnchor", SessionManager.open(file2).getLeafId() === anchor);
  out("E4.afterAnchor.reload.branch", ids(SessionManager.open(file2)));

  // E5: a failing label append leaves the entry in memory but not in the label map.
  const sm3 = SessionManager.create("/tmp", dir);
  const c1 = sm3.appendMessage(user("c1"));
  sm3.appendMessage(asst("c2"));
  const file3 = sm3.getSessionFile();
  chmodSync(file3, 0o444);
  let labelThrew = null;
  try {
    sm3.appendLabelChange(c1, "anchor:x");
  } catch (e) {
    labelThrew = e.code ?? e.message;
  }
  out("E5.label.threw", labelThrew);
  out("E5.label.getLabel", sm3.getLabel(c1) ?? null);
  out("E5.label.entryInMemory", sm3.getEntries().some((e) => e.type === "label"));
  out("E5.label.leafIsLabel", sm3.getLeafEntry()?.type);
  chmodSync(file3, 0o644);

  // E6: retrying a failed append through the same manager (the host's writeLabel fallback) parents the
  // retry to the entry that never reached disk.
  const sm4 = SessionManager.create("/tmp", dir);
  const d1 = sm4.appendMessage(user("d1"));
  sm4.appendMessage(asst("d2"));
  const file4 = sm4.getSessionFile();
  chmodSync(file4, 0o444);
  try {
    sm4.appendLabelChange(d1, "anchor:x");
  } catch {}
  chmodSync(file4, 0o644);
  sm4.appendLabelChange(d1, "anchor:x");
  out("E6.disk", diskIds(file4));
  out("E6.reload.branch", ids(SessionManager.open(file4)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
