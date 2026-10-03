#!/usr/bin/env bash
# D51 Phase B workspace test harness
#
# Sources every tests/workspace/*.sh part in sorted order and reports pass/fail.
# Each slice adds only its own part; B01 establishes the runner and a smoke test.
# The suite fails with "no assertions ran" when the parts directory is missing
# or yields zero assertions. LOKI_WORKSPACE_PARTS_DIR overrides the parts dir
# (used to self-check this guard with fixture directories).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARTS_DIR="${LOKI_WORKSPACE_PARTS_DIR:-$REPO_ROOT/tests/workspace}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Source and run every part in sorted order
if [ -d "$PARTS_DIR" ]; then
    for part in "$PARTS_DIR"/*.sh; do
        # Skip if no parts exist (glob expansion returns the pattern itself)
        if [ ! -f "$part" ]; then
            continue
        fi
        # Source the part; it must define its own assertions using ok() and bad()
        # shellcheck source=/dev/null
        . "$part"
    done
fi

if [ ! -d "$PARTS_DIR" ]; then
    printf 'FAIL: no assertions ran (parts dir missing: %s)\n' "$PARTS_DIR"
    exit 1
fi
if [ $((PASS + FAIL)) -eq 0 ]; then
    printf 'FAIL: no assertions ran (parts dir: %s)\n' "$PARTS_DIR"
    exit 1
fi

# Report results
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
