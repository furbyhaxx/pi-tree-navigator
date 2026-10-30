#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
evidence="${ROUTING_EVIDENCE_DIR:-$root/.project/analyses/usability-sweep/evidence}"
mkdir -p "$evidence"
scratch=$(mktemp -d /tmp/alt-window.XXXXXX)
socket="pi-tree-alt-window-$$"
cleanup() {
  tmux -L "$socket" kill-server 2>/dev/null || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

for mode in default extended; do
  trace="$evidence/split-$mode.jsonl"
  capture="$evidence/split-$mode.txt"
  if [[ -e "$trace" || -e "$capture" ]]; then
    printf 'Refusing to overwrite evidence: %s\n' "$mode" >&2
    exit 1
  fi
  base="$scratch/$mode"
  mkdir -p "$base"/{home,agent,config,cache,data,state}
  printf '%s\n' '{"tuiMode":"fullscreen"}' > "$base/agent/settings.json"
  extra=""
  if [[ "$mode" == extended ]]; then extra="PI_TUI_ESC_TIMEOUT=250"; fi
  tmux -L "$socket" new-session -d -s "$mode" -x 140 -y 32 \
    "cd '$root' && exec env -i HOME='$base/home' PATH='/home/furbyhaxx/.local/bin:/usr/local/bin:/usr/bin:/bin' TERM=xterm-256color LANG=C.UTF-8 PI_CODING_AGENT_DIR='$base/agent' XDG_CONFIG_HOME='$base/config' XDG_CACHE_HOME='$base/cache' XDG_DATA_HOME='$base/data' XDG_STATE_HOME='$base/state' PI_OFFLINE=1 PI_TELEMETRY=0 $extra ROUTING_TRACE='$trace' timeout 120 pi-bolt --offline -ne -nc -ns -np --no-mcp -na --no-session -e ./src/index.ts -e ./.project/analyses/usability-sweep/evidence/trace-keys.ts"
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
  tmux -L "$socket" send-keys -t "$mode" Down Down Down Space
  sleep 0.5
  tmux -L "$socket" send-keys -t "$mode" Escape
  sleep 0.12
  tmux -L "$socket" send-keys -t "$mode" -l s
  sleep 0.6
  tmux -L "$socket" capture-pane -pt "$mode" > "$capture"
  if [[ "$mode" == default ]]; then
    grep -Fq 'Discard staged changes?' "$capture"
    printf 'default (10 ms): split ESC/s opened Discard\n'
  else
    grep -Fq 'Anchor/Settings/Save' "$capture"
    printf 'extended (250 ms): split ESC/s opened Save\n'
  fi
  tmux -L "$socket" kill-session -t "$mode"
done
