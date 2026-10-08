#!/usr/bin/env bash
# MCP-0: docs/v11/MCP-2026-07-28.md must name each 2026-07-28 requirement, cite sources, and record a Python SDK version.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$ROOT/docs/v11/MCP-2026-07-28.md"
fail=0
check() { # check <label> <fixed string>
    if grep -qF -- "$2" "$DOC"; then echo "PASS: $1"; else echo "FAIL: $1 (missing: $2)"; fail=1; fi
}
[ -f "$DOC" ] || { echo "FAIL: $DOC missing"; exit 1; }
check "server/discover" "server/discover"
check "initialize removal" "initialize removal"
check "MRTR" "Multi Round-Trip Requests (MRTR)"
check "tasks extension id" "io.modelcontextprotocol/tasks"
check "traceparent in _meta" "traceparent in _meta"
for t in Roots Sampling Logging DCR; do check "deprecated $t" "$t"; done
check "changelog URL" "https://modelcontextprotocol.io/specification/2026-07-28/changelog"
check "VERIFIED marker" "VERIFIED"
check "UNVERIFIED marker" "UNVERIFIED"
if grep -qE '^- Python SDK latest version found: mcp [0-9]+\.[0-9]+\.[0-9]+, uploaded [0-9]{4}-[0-9]{2}-[0-9]{2}' "$DOC"; then
    echo "PASS: Python SDK latest version line"
else
    echo "FAIL: Python SDK latest version line"; fail=1
fi
if grep -qE '^\| .*\| 2[0-9]{3}-[0-9]{2}-[0-9]{2} \|$' "$DOC"; then echo "PASS: sources have fetch dates"; else echo "FAIL: sources have fetch dates"; fail=1; fi
if grep -qF -e "$(printf '\342\200\223')" -e "$(printf '\342\200\224')" "$DOC"; then echo "FAIL: dash characters present"; fail=1; else echo "PASS: no en or em dashes"; fi
exit "$fail"
