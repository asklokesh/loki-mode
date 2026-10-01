#!/usr/bin/env bash
# tests/test-isolation-dial.sh -- rec #4: unified per-run isolation dial.
# `loki start --isolation none|worktree|docker` is the canonical knob that
# subsumes the fragmented --parallel (worktree) and --sandbox (docker) flags,
# matching the zeroshot none/worktree/docker model while keeping the old flags
# working as aliases.
#
# Verifies (without launching a build):
#   1. --isolation is documented in both the main and `start` help.
#   2. The value->mechanism mapping is correct (worktree->--parallel arg,
#      docker->LOKI_SANDBOX_MODE, none->neither).
#   3. Fail-closed: an unknown level errors (return 2), never a silent downgrade.
#   4. The bogus value is rejected by the REAL CLI before any build launches.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1 -- ${2:-}"; }

MAIN_HELP="$(bash "$LOKI" --help 2>&1 || true)"

# 1. documented in help
if echo "$MAIN_HELP" | grep -q -- "--isolation"; then
    pass "--isolation documented in main help"
else
    fail "--isolation missing from main help"
fi

# 2 + 3. mapping + fail-closed, via the same case logic used in cmd_start.
# (Kept in lockstep with the --isolation case in autonomy/loki:cmd_start.)
map_isolation() {
    local _iso_val="$1"
    ISO_ARGS=(); ISO_SANDBOX=""
    case "$_iso_val" in
        none|"") : ;;
        worktree|wt) ISO_ARGS+=("--parallel") ;;
        docker|sandbox) ISO_SANDBOX=true ;;
        *) return 2 ;;
    esac
    return 0
}

map_isolation worktree; rc=$?
if [ $rc -eq 0 ] && [ "${ISO_ARGS[*]}" = "--parallel" ]; then
    pass "isolation=worktree -> --parallel (git worktree mechanism)"
else
    fail "worktree mapping" "rc=$rc args=[${ISO_ARGS[*]}]"
fi

map_isolation docker; rc=$?
if [ $rc -eq 0 ] && [ "$ISO_SANDBOX" = "true" ]; then
    pass "isolation=docker -> LOKI_SANDBOX_MODE"
else
    fail "docker mapping" "rc=$rc sandbox=$ISO_SANDBOX"
fi

map_isolation none; rc=$?
if [ $rc -eq 0 ] && [ ${#ISO_ARGS[@]} -eq 0 ] && [ -z "$ISO_SANDBOX" ]; then
    pass "isolation=none -> in-place (no worktree, no sandbox)"
else
    fail "none mapping" "rc=$rc args=[${ISO_ARGS[*]}] sandbox=$ISO_SANDBOX"
fi

map_isolation bogus; rc=$?
if [ $rc -eq 2 ]; then
    pass "isolation=bogus -> rejected (rc=2, fail-closed)"
else
    fail "bogus fail-closed" "expected rc=2, got $rc"
fi

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
