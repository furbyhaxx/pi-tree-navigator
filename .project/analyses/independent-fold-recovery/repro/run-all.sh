#!/usr/bin/env bash
# Runs every scenario RUNS times (one process each, hard timeout), keeps the logs under output/,
# and prints the RESULT digest plus whether all runs agreed.
set -u
cd "$(dirname "$0")"
RUNS="${RUNS:-3}"
IDS="${*:-S0 S1-fold S1-hide S1-followup S1-newrun S1-newrun-custom S2a S2a-on S2b S2c S2d S3a S3b S3c S3d S3e S3f S3g-tui S3g-abort S3h S3h-off S3i S3j S3k S4}"
mkdir -p output
for id in $IDS; do
  for n in $(seq 1 "$RUNS"); do
    timeout 60 node scenarios.mjs "$id" >"output/$id.run$n.log" 2>&1 || echo "FAILED $id run $n (exit $?)"
  done
  base=$(grep '^RESULT ' "output/$id.run1.log")
  agree=yes
  for n in $(seq 2 "$RUNS"); do
    [ "$(grep '^RESULT ' "output/$id.run$n.log")" = "$base" ] || agree=NO
  done
  echo "$base" | sed 's/^RESULT //'
  echo "  runs=$RUNS agree=$agree"
done
