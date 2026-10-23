#!/usr/bin/env bash
# Usage: run.sh [baseline|candidate|candidate+label] [late|existing|followup]
#   baseline|candidate  candidate first applies candidate-fix.patch to the scratch copy of index.ts;
#                       candidate+label also applies candidate-writelabel.patch (retry fix for the follow-up)
#   late                run the late-input scenarios (default); followup = the label-retry scenario;
#                       existing = the repo's index.test.ts unchanged
# Everything runs against a scratch copy; nothing under extensions/ is modified.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
MODE=${1:-baseline}
WHAT=${2:-late}
SCRATCH=$(mktemp -d "$HERE/.scratch.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
cp -r "$REPO/extensions" "$SCRATCH/extensions"
cp "$REPO/package.json" "$REPO/README.md" "$SCRATCH/"
case "$MODE" in
  candidate|candidate+label) patch -s -p1 -d "$SCRATCH" < "$HERE/candidate-fix.patch" ;;
esac
if [ "$MODE" = candidate+label ]; then patch -s -p1 -d "$SCRATCH" < "$HERE/candidate-writelabel.patch"; fi
cd "$SCRATCH"
if [ "$WHAT" = existing ]; then
  node --test extensions/navigate-tree/index.test.ts
else
  { cat "$REPO/extensions/navigate-tree/index.test.ts"; echo; cat "$HERE/late-input.block.ts"; } \
    > extensions/navigate-tree/late-input.test.ts
  PATTERN="late-input persistence"
  if [ "$WHAT" = followup ]; then PATTERN="FOLLOW-UP label retry"; fi
  node --test --test-name-pattern="$PATTERN" extensions/navigate-tree/late-input.test.ts
fi
