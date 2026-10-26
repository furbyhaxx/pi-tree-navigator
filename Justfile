set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

install:
	bun install

test:
	bun test

typecheck:
	bunx tsc --noEmit

lint:
	bunx biome check .

format:
	bunx biome check --write .

rpc-verify:
	{ echo '{"type":"get_commands","id":"1"}'; sleep 2; } | timeout 30 ${PI_BIN:-pi-bolt} --mode rpc --no-session -ne --offline -e ./extensions/navigate-tree/index.ts

probe:
	node scripts/pi-upstream-probe.mjs

check: typecheck lint test
