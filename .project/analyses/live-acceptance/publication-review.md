---
"version": 1
"id": "live-acceptance-publication-review"
"title": "Publication review of live navigator acceptance artifacts"
"description": "Read-only privacy check of the live-acceptance evidence tree and its capture scripts for credentials, auth headers, copied global config, private user material and archive completeness; refreshed after final provider runs."
"type": "analysis"
"created": "2026-10-23T11:41:10+02:00"
"updated": "2026-10-23T11:51:43+02:00"
"createdBy": "analyst (pi subagent)"
"updatedBy": "analyst (pi subagent)"
---

# Publication review of live navigator acceptance artifacts

status: "qa-complete"
confidence: "high"

## Final status

**Safe to publish.** The complete tree — 277 files, 156 MB, all 45 gzip archives verified
readable — contains no credential values, no `Authorization`/`Cookie`/`x-api-key` header
values, no copies of `~/.pi/agent/auth.json`, `models.json`, `tree-navigator.json` or
`settings.json`, no private user message text, and no provider secrets in generated prompts
or patch/diff output. Nothing above 50 MB (largest file 5.7 MB,
`parallel-01/agent-1/wire.jsonl.gz`).

## Coverage

- Initial scan 2026-10-23 11:39–11:41 on 206 files / 110 MB: entire tree then present
  (`classifier/`, `parallel-01`, `parallel-02`, `proposal/`, `summary-failure/`, `tui/`,
  `tui-02/`, `remaining-settlement/`) plus `scripts/live-navigator-acceptance.mjs` and
  `scripts/analyze-live-navigator.mjs`. Findings unchanged; those files were not re-read.
- Delta scan 2026-10-23 11:51 on 71 added or rewritten entries: `parallel-03/` (six sessions,
  42 files), `tui-final/` (12), completed `tui-nudge/` (13), `checks/` (6),
  `remaining-settlement/report.md`, the 13 `summary-smoke.txt` files, `tui/`, `tui-02/`
  `analysis.json`.
- Gzip completeness now 45/45 `zcat` clean, including the previously truncated
  `tui-nudge/wire.jsonl.gz` (now 1,000,552 bytes) and `tui-final/wire.jsonl.gz`.
- Not read, per brief: `.project/analyses/stop-after-fold/{auth.json,folds.json,trigger.json,scan.py}`.
  No artifact references stop-after-fold.

## Delta findings

- **Auth headers**: 205 newly captured responses carry only `date`; header filters at
  `scripts/live-navigator-acceptance.mjs:86-90` and `tui/observer.ts:29` are unchanged.
  `classifier/evidence.json` still stores `requestHeaders.authorization` as the
  `<redacted>` placeholder. Parallel-03 and both TUI runs reference
  `/home/furbyhaxx/.pi/agent/auth.json` by path only; no config content materialized.
- **Raw session JSONL**: 8 new sessions (`parallel-03/agent-1..6`, `tui-final`, `tui-nudge`)
  contain 8 user-role messages; all hash-match the authored `prompt.txt` set. Zero
  non-authored user messages, so no private session text.
- **Prompts**: all generated `prompt.txt` files are authored acceptance text over the same
  repository corpus; no secrets.
- **Patch/diff output**: `checks/*.txt` are node test-runner, lint and diagnostics output
  (79 files checked, no fixes applied). No `diff --git`, `--- a/`, `+++ b/` blocks, so no
  patch payloads to review.
- **Pattern sweep** over all new paths (plain and decompressed): zero hits for `sk-or-v1-`,
  `sk-proj-`, `sk-ant-`, `AIza`, `gsk_`, `xai-`, `nvapi-`, `Bearer `, `"api_key"`,
  `"type":"api_key"`, `"key":"…"`, `refresh_token`, `access_token`, `id_token`,
  `client_secret`, `AKIA…`, `ghp_…`, `github_pat_`, `PRIVATE KEY`, `eyJhbGci`, provider env
  var names, `Cookie`, `set-cookie`, `x-api-key`. No incidental `sk-`/`hf_` blob substrings
  appeared in the new archives at all.
- **Provenance**: all six `parallel-03/agent-*/metadata.json` record
  `sourceCommit b13b3775a1ea`, model `openai/gpt-6-luna`, lens and session path. TUI captures
  carry `launch.json` (extension, model, tools, session dir) and `settled.json` (session,
  request count) without a direct commit field; that provenance is reconstructable in the
  final main report and is not a privacy defect.

## Residual notes (non-blocking)

- Absolute developer paths (`/home/furbyhaxx/...`, `/mnt/Projects/...`) appear in scripts,
  `launch.json`, `metadata.json`, `settled.json` and `evidence.json`. Not secrets; publish
  only if the local username is acceptable.
- `tui-final` tmux session was still open but settled when scanned; all its wire output was
  closed and complete, so no further provider traffic is expected to add files.
