#!/usr/bin/env bash
# The Bun CLI source type-checks: `bunx tsc --noEmit` in loki-ts. dist-freshness proves the
# bundle matches the source; this proves the source itself is type-correct.
# Needs `bun install --cwd loki-ts --frozen-lockfile` first.
#
# Planted defect used to prove this test can fail: in loki-ts/src/cli.ts add the line
# `const planted: number = "not a number";`; tsc must report it. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
[ -d "$ROOT/loki-ts/node_modules" ] || { echo "typecheck: run 'bun install --cwd loki-ts --frozen-lockfile' first" >&2; exit 2; }

echo "TEST: loki-ts type check"

out="$(cd "$ROOT/loki-ts" && bunx tsc --noEmit 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "bunx tsc --noEmit is clean" || bad "tsc reported errors: $(printf '%s\n' "$out" | head -5 | tr '\n' ' ')"

finish
