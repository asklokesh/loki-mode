#!/usr/bin/env bash
# E-169: both Dockerfiles must install a working bun on PATH (the bin/loki
# resolver finds it there), pinned to package.json optionalDependencies.bun.
# Structural only: no docker needed.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
want="$(timeout -k 2 10 node -e 'process.stdout.write(require(process.argv[1]).optionalDependencies.bun||"")' "$ROOT/package.json")"
fail=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
[ -n "$want" ] && ok "package.json optionalDependencies.bun = $want" || bad "package.json has no optionalDependencies.bun"
for f in Dockerfile Dockerfile.sandbox; do
  p="$ROOT/$f"
  got="$(sed -n 's/^ARG BUN_VERSION=//p' "$p" | head -1)"
  [ "$got" = "$want" ] && ok "$f BUN_VERSION=$got matches" || bad "$f BUN_VERSION='$got' != '$want'"
  grep -q 'bun.sh/install | bash -s "bun-v${BUN_VERSION}"' "$p" && ok "$f installs pinned bun" || bad "$f missing pinned bun install"
  grep -q 'mv /root/.bun/bin/bun /usr/local/bin/bun' "$p" && ok "$f puts bun on PATH" || bad "$f bun not in /usr/local/bin"
  if grep -E 'omit=optional|--no-optional' "$p" | grep -v '^ *#' | grep -q .; then
    bad "$f omits optional deps"
  else
    ok "$f does not omit optional deps"
  fi
done
exit "$fail"
