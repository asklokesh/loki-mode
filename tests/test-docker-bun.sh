#!/usr/bin/env bash
# E-169: both Dockerfiles must install a working bun on PATH (the bin/loki
# resolver finds it there), pinned to the package.json @oven/bun-* optionalDependencies.
# Structural only: no docker needed.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
want="$(timeout -k 2 10 node -e 'process.stdout.write(require(process.argv[1]).optionalDependencies["@oven/bun-darwin-aarch64"]||"")' "$ROOT/package.json")"
fail=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
[ -n "$want" ] && ok "package.json @oven/bun-darwin-aarch64 = $want" || bad "package.json has no @oven/bun-darwin-aarch64 pin"
# the meta-package must stay out: its postinstall trips the npm 11 allow-scripts warning
node -e 'process.exit(require(process.argv[1]).optionalDependencies.bun?1:0)' "$ROOT/package.json" && ok "no bun meta-package dependency" || bad "bun meta-package is back in optionalDependencies"
# every per-platform pin must equal the Dockerfile version
nbad="$(node -e 'const o=require(process.argv[1]).optionalDependencies;process.stdout.write(Object.keys(o).filter(k=>k.startsWith("@oven/bun-")&&o[k]!==process.argv[2]).join(","))' "$ROOT/package.json" "$want")"
[ -z "$nbad" ] && ok "all @oven/bun-* pins equal $want" || bad "mismatched @oven/bun-* pins: $nbad"
for f in docker/Dockerfile docker/Dockerfile.sandbox; do
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
