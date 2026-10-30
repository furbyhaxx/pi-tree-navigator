#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
evidence="${ROUTING_EVIDENCE_DIR:-$root/.project/analyses/usability-sweep/evidence}"
mkdir -p "$evidence"
scratch=$(mktemp -d /tmp/page-routing.XXXXXX)
socket="pi-tree-page-routing-$$"
cleanup() {
  tmux -L "$socket" kill-server 2>/dev/null || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

for mode in default masked; do
  trace="$evidence/page-$mode.jsonl"
  before="$evidence/page-$mode-before.txt"
  after="$evidence/page-$mode-after.txt"
  if [[ -e "$trace" || -e "$before" || -e "$after" ]]; then
    printf 'Refusing to overwrite evidence: %s\n' "$mode" >&2
    exit 1
  fi
  base="$scratch/$mode"
  mkdir -p "$base"/{home,agent,config,cache,data,state}
  printf '%s\n' '{"tuiMode":"fullscreen"}' > "$base/agent/settings.json"
  if [[ "$mode" == masked ]]; then
    printf '%s\n' '{"tui.altScreen.pageUp":[],"tui.altScreen.pageDown":[]}' > "$base/agent/keybindings.json"
  fi
  tmux -L "$socket" new-session -d -s "$mode" -x 140 -y 32 \
    "cd '$root' && exec env -i HOME='$base/home' PATH='/home/furbyhaxx/.local/bin:/usr/local/bin:/usr/bin:/bin' TERM=xterm-256color LANG=C.UTF-8 PI_CODING_AGENT_DIR='$base/agent' XDG_CONFIG_HOME='$base/config' XDG_CACHE_HOME='$base/cache' XDG_DATA_HOME='$base/data' XDG_STATE_HOME='$base/state' PI_OFFLINE=1 PI_TELEMETRY=0 ROUTING_TRACE='$trace' timeout 120 pi-bolt --offline -ne -nc -ns -np --no-mcp -na --no-session -e ./src/index.ts -e ./.project/analyses/usability-sweep/evidence/trace-keys.ts"
  sleep 2
  tmux -L "$socket" send-keys -t "$mode" -l '/route-probe'
  sleep 0.2
  tmux -L "$socket" send-keys -t "$mode" Enter
  sleep 0.4
  tmux -L "$socket" send-keys -t "$mode" -l '/anchor settings'
  sleep 0.2
  tmux -L "$socket" send-keys -t "$mode" Enter
  sleep 0.3
  tmux -L "$socket" send-keys -t "$mode" Enter
  sleep 0.4
  tmux -L "$socket" send-keys -t "$mode" Down Down Down
  sleep 0.4
  tmux -L "$socket" capture-pane -pt "$mode" > "$before"
  tmux -L "$socket" send-keys -t "$mode" PPage
  sleep 0.3
  tmux -L "$socket" send-keys -t "$mode" NPage
  sleep 0.4
  tmux -L "$socket" capture-pane -pt "$mode" > "$after"
  if [[ "$mode" == default ]]; then
    grep -Fq '→ continuity.capture' "$before"
    grep -Fq '→ continuity.capture' "$after"
    if grep -F '"stage":"frame"' "$trace" | grep -Eq '\\u001b\[[56]~'; then exit 1; fi
    printf 'default: PageUp and PageDown never reached FrameList; selection unchanged\n'
  else
    grep -F '"stage":"frame"' "$trace" | grep -Fq '\u001b[5~'
    grep -F '"stage":"frame"' "$trace" | grep -Fq '\u001b[6~'
    if grep -Fq '→ continuity.capture' "$after"; then exit 1; fi
    printf 'masked: PageUp and PageDown reached FrameList; selection moved\n'
  fi
  tmux -L "$socket" kill-session -t "$mode"
done
