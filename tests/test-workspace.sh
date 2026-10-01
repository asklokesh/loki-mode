#!/usr/bin/env bash
# D51 Phase B workspace test harness
#
# Sources every tests/workspace/*.sh part in sorted order and reports pass/fail.
# Each slice adds only its own part; B01 establishes the runner and a smoke test.
# If the parts directory is empty, the suite passes 1/0 (its own self-check).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARTS_DIR="$REPO_ROOT/tests/workspace"

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

# Report results
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
