#!/usr/bin/env bash
# D35 DEP-01: guards scripts/dep-inventory.py's Latest/Bump self-consistency
# (Tech Lead reject on 2cceecd2, item 1). The heavy lifting is the script's
# own --self-test (fixed fixtures, no network); this wrapper runs it and adds
# a couple of static checks on the current docs/v10/DEPS.md so a stale report
# doesn't silently drift from the generator.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/dep-inventory.py"
DEPS="$REPO_ROOT/docs/v10/DEPS.md"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  [PASS] $1"; }
bad() { fail=$((fail + 1)); echo "  [FAIL] $1"; }

echo "T1 -- script's own offline self-test (Latest/Bump agreement fixtures)"
if python3 "$SCRIPT" --self-test; then
    ok "dep-inventory.py --self-test passed"
else
    bad "dep-inventory.py --self-test failed"
fi

echo
echo "T2 -- DEPS.md exists and is non-empty"
if [ -s "$DEPS" ]; then
    ok "$DEPS exists and is non-empty"
else
    bad "$DEPS is missing or empty"
fi

echo
echo "T3 -- DEPS.md carries no bare 'MAJOR' next-line claim for a 0.x package"
# A row whose Current starts with a 0.x version must never be labeled plain
# "minor"/"patch" in the Bump column -- it must say "0.x breaking".
if grep -qE '\| (fastapi|httpx|uvicorn|aiosqlite|esbuild|python-multipart) \| .0\.[0-9][^|]*\| [^|]*\| (patch|minor) \|' "$DEPS"; then
    bad "a 0.x package is still classified patch/minor instead of 0.x breaking"
else
    ok "no 0.x package left classified plain patch/minor"
fi

echo
echo "T4 -- DEPS.md summary table has a dedicated '0.x breaking' column"
if grep -q '0.x breaking' "$DEPS"; then
    ok "summary/table carries the 0.x breaking column"
else
    bad "0.x breaking column missing from DEPS.md"
fi

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
