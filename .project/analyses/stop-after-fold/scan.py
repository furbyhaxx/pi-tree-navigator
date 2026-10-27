"""Scan pi session logs for navigate-tree-rewind continuations and classify what follows."""

import json
import os
import re
import sys
import glob

ROOT = os.path.expanduser("~/.pi/agent/sessions")
REWIND = "navigate-tree-rewind"

TEXT_LIMIT = 700


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    out.append(part.get("text", ""))
                elif part.get("type") == "thinking":
                    out.append("[thinking] " + part.get("thinking", "")[:200])
    return "\n".join(out)


def assistant_parts(m):
    content = m.get("content") or []
    texts, tools = [], []
    if isinstance(content, str):
        return [content], []
    for part in content:
        t = part.get("type")
        if t == "text":
            texts.append(part.get("text", ""))
        elif t in ("toolCall", "tool_call", "toolUse"):
            name = part.get("name") or (part.get("toolCall") or {}).get("name")
            tools.append(name or "?")
        elif t == "thinking":
            texts.append("")
    return texts, tools


def scan_file(path):
    entries = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows = []
    for i, e in enumerate(entries):
        if e.get("type") != "custom_message" or e.get("customType") != REWIND:
            continue
        details = e.get("details") or {}
        if isinstance(details, str):
            try:
                details = json.loads(details)
            except Exception:
                details = {}
        if details.get("status") != "done":
            rows.append({"file": path, "index": i, "status": details.get("status"), "skipped": True,
                         "session": entries[0].get("cwd")})
            continue
        row = {
            "file": path,
            "index": i,
            "cwd": entries[0].get("cwd"),
            "session_id": entries[0].get("id"),
            "ts": e.get("timestamp"),
            "continuation": text_of(e.get("content")),
            "details": {k: details.get(k) for k in
                        ("rewindTo", "newLabel", "contextBefore", "contextAfter", "contextWindow",
                         "collapsedEntries", "summaryAttempts", "agentMessagesRefreshed",
                         "reappendedLateMessages")},
            "late_note": "arrived while the rewind was pending" in text_of(e.get("content")),
        }
        # newest branch_summary before this point
        summary = None
        for prev in reversed(entries[:i]):
            if prev.get("type") == "branch_summary":
                summary = prev
                break
        row["summary_ts"] = summary.get("timestamp") if summary else None
        row["summary"] = (summary or {}).get("summary") or (summary or {}).get("content") or ""
        # latest real user message before this point (in append order)
        user_msg = None
        for prev in reversed(entries[:i]):
            if prev.get("type") == "message" and prev.get("message", {}).get("role") == "user":
                user_msg = prev
                break
        row["user_ts"] = user_msg.get("timestamp") if user_msg else None
        row["user"] = text_of((user_msg or {}).get("message", {}).get("content"))[:4000]
        # what follows: walk forward over messages
        nxt = None
        nxt_idx = None
        for j in range(i + 1, len(entries)):
            cand = entries[j]
            if cand.get("type") == "message" and cand["message"].get("role") == "assistant":
                nxt, nxt_idx = cand, j
                break
            if cand.get("type") == "message" and cand["message"].get("role") == "user":
                row["next_is_user_at"] = j
                break
        if nxt is None:
            row["outcome"] = "no-assistant-after"
        else:
            texts, tools = assistant_parts(nxt["message"])
            row["assistant_ts"] = nxt.get("timestamp")
            row["assistant_text"] = "\n".join(t for t in texts if t)[:TEXT_LIMIT]
            row["assistant_tools"] = tools
            row["provider"] = nxt["message"].get("provider")
            row["model"] = nxt["message"].get("model")
            row["stopReason"] = nxt["message"].get("stopReason")
            row["error"] = nxt["message"].get("errorMessage")
            # what happens after that assistant message
            after = []
            for k in range(nxt_idx + 1, len(entries)):
                cand = entries[k]
                if cand.get("type") == "message":
                    role = cand["message"].get("role")
                    if role == "assistant":
                        texts2, tools2 = assistant_parts(cand["message"])
                        after.append({"role": "assistant", "tools": tools2,
                                      "text": "\n".join(t for t in texts2 if t)[:300]})
                        break
                    if role == "user":
                        after.append({"role": "user", "text": text_of(cand["message"].get("content"))[:300]})
                        break
                    if role == "toolResult":
                        after.append({"role": "toolResult", "text": text_of(cand["message"].get("content"))[:200]})
                elif cand.get("type") == "custom_message":
                    after.append({"role": "custom", "customType": cand.get("customType"),
                                  "text": text_of(cand.get("content"))[:300]})
            row["after"] = after
            if tools:
                row["outcome"] = "continued-tools"
            else:
                # text-only: did the user speak next, or did the run end here?
                if after and after[0]["role"] == "user":
                    row["outcome"] = "text-then-user"
                elif after and after[0]["role"] == "assistant":
                    row["outcome"] = "text-then-assistant"
                elif after and after[0]["role"] == "custom":
                    row["outcome"] = "text-then-custom"
                elif not after:
                    row["outcome"] = "text-then-end-of-session"
                else:
                    row["outcome"] = "text-then-" + after[0]["role"]
        rows.append(row)
    return rows


def main():
    files = []
    for path in glob.glob(os.path.join(ROOT, "**", "*.jsonl"), recursive=True):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if REWIND in line:
                        files.append(path)
                        break
        except OSError:
            continue
    rows = []
    for path in sorted(files):
        try:
            rows.extend(scan_file(path))
        except Exception as exc:  # noqa: BLE001
            rows.append({"file": path, "error": repr(exc)})
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "folds.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=1)
    print("files:", len(files), "fold entries:", len(rows), "->", out)


if __name__ == "__main__":
    main()
