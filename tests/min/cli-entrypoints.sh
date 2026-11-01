#!/usr/bin/env bash
# Every shipped entrypoint answers, offline, with the same version as VERSION:
# bin/loki, the committed Bun bundle, the bash CLI, the npm launcher; plus
# `loki --help`, `loki doctor --json` (valid JSON, same version), `loki mcp --help`
# and the bash completion file loading.
#
# Planted defect used to prove this test can fail: in loki-ts/dist/loki.js change
# the embedded version string to the previous release (a stale bundle); the
# `bun loki-ts/dist/loki.js version` case must fail. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need node
need python3
cd "$ROOT" || exit 2

echo "TEST: CLI entrypoints (offline, hermetic HOME)"

# Pin the shipped bundle: a dev checkout would otherwise prefer loki-ts/src when it is newer.
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
want="Loki Mode v$VERSION_NOW"

if command -v timeout >/dev/null 2>&1; then run() { timeout 60 "$@" 2>&1; }; else run() { "$@" 2>&1; }; fi

has "bin/loki --version" "$(run bin/loki --version)" "$want"
has "bun loki-ts/dist/loki.js version" "$(run bun loki-ts/dist/loki.js version)" "$want"
has "bash autonomy/loki --version" "$(run bash autonomy/loki --version)" "$want"
has "node bin/loki-mode.js --version" "$(run node bin/loki-mode.js --version)" "$want"

help_out="$(run bin/loki --help)"
has "loki --help usage line" "$help_out" "Usage: loki <command>"
has "loki --help lists start" "$help_out" "start"

doc_out="$(run bin/loki doctor --json)"
doc_ver="$(printf '%s' "$doc_out" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["loki_mode_version"])' 2>/dev/null)"
[ "$doc_ver" = "$VERSION_NOW" ] && ok "loki doctor --json is valid JSON at $VERSION_NOW" || bad "doctor --json version '$doc_ver' (want $VERSION_NOW)"

has "loki mcp --help" "$(run bin/loki mcp --help)" "Usage: loki mcp"

check "completions/loki.bash loads" bash -c "source '$ROOT/completions/loki.bash'"

finish
