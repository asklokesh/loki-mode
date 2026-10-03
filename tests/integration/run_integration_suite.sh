#!/usr/bin/env bash
# tests/integration/run_integration_suite.sh
# v7.0.0 integration suite orchestrator (Team T7).
#
# Runs every tests/integration/test_*.sh in a fixed order, tallies
# PASS/FAIL/SKIP, and prints a final summary line. Exits non-zero only if
# one or more tests FAIL. Skipped tests (e.g. dashboard port busy) are
# treated as clean exits.
#
# Per-test contract:
#   exit 0  -> PASS (or SKIP with a "^SKIP" line on stdout)
#   exit 2  -> SKIP (environment not suitable)
#   other   -> FAIL
#
# Individual tests print grep-friendly "^PASS", "^FAIL", "^SKIP" lines so
# callers can filter output cheaply.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Ordered test list. Default behavior runs first (cheapest, establishes baseline),
# then invariant tests, then RARV-C flow, then unify/dashboard smoke.
TESTS=(
    "test_default_behavior.sh"
    "test_sdk_isolation.sh"
    "test_flag_matrix_full.sh"
    "test_kill_switches.sh"
    "test_rarv_c_memory_flow.sh"
    "test_failure_memory_loop.sh"
    "test_start_run_unified.sh"
    "test_dashboard_api_smoke.sh"
    "test_sigint_propagation.sh"
)

passed=0
failed=0
skipped=0
failed_names=()

print_header() {
    echo ""
    echo "================================================================"
    echo "  v7.0.0 Integration Suite"
    echo "  Repo: $REPO_ROOT"
    echo "  Version: $(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo unknown)"
    echo "================================================================"
    echo ""
}

run_one() {
    local name="$1"
    local path="$SCRIPT_DIR/$name"

    if [ ! -x "$path" ]; then
        # Allow shebang-invocable scripts that aren't marked +x in case git
        # did not preserve the bit locally.
        if [ -f "$path" ]; then
            chmod +x "$path" 2>/dev/null || true
        fi
    fi

    if [ ! -f "$path" ]; then
        echo "FAIL [$name] test file missing at $path"
        failed=$((failed + 1))
        failed_names+=("$name")
        return
    fi

    echo "----------------------------------------------------------------"
    echo "RUN: $name"
    echo "----------------------------------------------------------------"

    set +e
    bash "$path"
    local rc=$?
    set -e

    case "$rc" in
        0)
            echo "RESULT [$name] exit=0 PASS"
            passed=$((passed + 1))
            ;;
        2)
            echo "RESULT [$name] exit=2 SKIP"
            skipped=$((skipped + 1))
            ;;
        *)
            echo "RESULT [$name] exit=$rc FAIL"
            failed=$((failed + 1))
            failed_names+=("$name")
            ;;
    esac
    echo ""
}

print_header
for t in "${TESTS[@]}"; do
    run_one "$t"
done

echo "================================================================"
echo "Integration: $passed passed, $failed failed, $skipped skipped"
echo "================================================================"
if [ "$failed" -gt 0 ]; then
    echo "Failed tests:"
    for n in "${failed_names[@]}"; do
        echo "  - $n"
    done
    exit 1
fi
exit 0
