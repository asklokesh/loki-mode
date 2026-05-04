#!/usr/bin/env bash
# Test: pytest quality gate timeout wrap (Triage #14, v7.5.15)
#
# Verifies _loki_run_pytest_with_timeout in autonomy/run.sh:
#   1. With LOKI_PYTEST_TIMEOUT=2 and a 10s sleeping pytest fixture,
#      the wrapper terminates within ~3 seconds AND returns exit 124.
#   2. With LOKI_PYTEST_TIMEOUT=15, the same fixture completes normally (exit 0).
#   3. With both `gtimeout` and `timeout` removed from PATH, the wrapper still
#      runs (degraded), prints the warning, and runs unbounded.
#
# Total runtime budget: under 30s.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
FIXTURE_DIR="$SCRIPT_DIR/fixtures"
SLEEPING_TEST="$FIXTURE_DIR/sleeping_test.py"

PASS=0
FAIL=0

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
NC=$'\033[0m'

log_pass() { printf '%s[PASS]%s %s\n' "$GREEN" "$NC" "$1"; PASS=$((PASS + 1)); }
log_fail() { printf '%s[FAIL]%s %s -- %s\n' "$RED" "$NC" "$1" "$2"; FAIL=$((FAIL + 1)); }

if [ ! -f "$SLEEPING_TEST" ]; then
    echo "FATAL: sleeping fixture not found at $SLEEPING_TEST"
    exit 2
fi

if ! command -v pytest >/dev/null 2>&1; then
    echo "SKIP: pytest not installed; cannot exercise the gate. (Not a fail.)"
    exit 0
fi

# Source only what we need from run.sh without executing it as a script.
# The helper _loki_run_pytest_with_timeout depends on log_warn (defined in run.sh)
# and uses no other run.sh state. We extract both via a sourced subshell wrapper.
SOURCE_HARNESS=$(mktemp -t loki-pytest-gate-source.XXXXXX) || exit 2
trap 'rm -f "$SOURCE_HARNESS"' EXIT

# Extract log_warn and the helper from run.sh into a minimal harness.
# Use grep -A to grab function bodies; bail if not found.
{
    echo '#!/usr/bin/env bash'
    echo 'log_warn() { echo "[WARN] $*" >&2; }'
    # Pull the helper definition (between the function name and its closing brace).
    awk '
        /^_loki_run_pytest_with_timeout\(\) \{/ { in_fn = 1 }
        in_fn { print }
        in_fn && /^}$/ { in_fn = 0 }
    ' "$RUN_SH"
} > "$SOURCE_HARNESS"

if ! grep -q '^_loki_run_pytest_with_timeout()' "$SOURCE_HARNESS"; then
    log_fail "extract helper" "_loki_run_pytest_with_timeout not found in $RUN_SH"
    echo
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

# shellcheck source=/dev/null
source "$SOURCE_HARNESS"

# ---------------------------------------------------------------------------
# Test 1: short timeout fires within ~3s and returns exit 124
# ---------------------------------------------------------------------------
echo "Test 1: LOKI_PYTEST_TIMEOUT=2 against 10s sleeping fixture"
start_ts=$(date +%s)
LOKI_PYTEST_TIMEOUT=2 _loki_run_pytest_with_timeout "$FIXTURE_DIR" sleeping_test.py >/dev/null 2>&1
exit1=$?
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

if [ "$exit1" -eq 124 ]; then
    log_pass "short-timeout: exit code 124 (timeout fired)"
else
    log_fail "short-timeout: exit code 124" "got exit=$exit1"
fi

if [ "$elapsed" -le 4 ]; then
    log_pass "short-timeout: terminated within 4s (actual=${elapsed}s)"
else
    log_fail "short-timeout: terminated within 4s" "took ${elapsed}s"
fi

# ---------------------------------------------------------------------------
# Test 2: long timeout allows test to complete normally
# ---------------------------------------------------------------------------
echo "Test 2: LOKI_PYTEST_TIMEOUT=15 against 10s sleeping fixture"
start_ts=$(date +%s)
LOKI_PYTEST_TIMEOUT=15 _loki_run_pytest_with_timeout "$FIXTURE_DIR" sleeping_test.py >/dev/null 2>&1
exit2=$?
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

if [ "$exit2" -eq 0 ]; then
    log_pass "long-timeout: exit 0 (test passed)"
else
    log_fail "long-timeout: exit 0" "got exit=$exit2 (elapsed=${elapsed}s)"
fi

# ---------------------------------------------------------------------------
# Test 3: graceful degradation when neither gtimeout nor timeout exist.
# Run the helper in a subshell with a sanitized PATH. We still need pytest
# on PATH, so we build a sandbox dir that contains only pytest (symlinked).
# ---------------------------------------------------------------------------
echo "Test 3: graceful degradation with no timeout binaries on PATH"
SANDBOX_BIN=$(mktemp -d -t loki-pytest-gate-bin.XXXXXX) || exit 2
trap 'rm -rf "$SANDBOX_BIN" "$SOURCE_HARNESS"' EXIT

# Symlink pytest and python3 (pytest dispatches to python).
for tool in pytest python3 python sh bash sed grep awk env mktemp date dirname cd cat tail tr head; do
    src=$(command -v "$tool" 2>/dev/null || true)
    [ -n "$src" ] && ln -sf "$src" "$SANDBOX_BIN/$tool"
done

# Sanity-check: gtimeout and timeout must be absent from sandbox.
if [ -e "$SANDBOX_BIN/gtimeout" ] || [ -e "$SANDBOX_BIN/timeout" ]; then
    log_fail "test3-setup" "sandbox accidentally contains gtimeout/timeout"
fi

# Re-source helper inside sandboxed PATH and capture stderr for the warning.
warning_out=$(PATH="$SANDBOX_BIN" bash -c "
    set -uo pipefail
    source '$SOURCE_HARNESS'
    # Use a passing test that returns quickly so we don't actually wait 10s.
    cat > '$SANDBOX_BIN/quick_test.py' << 'PYEOF'
def test_quick():
    assert True
PYEOF
    LOKI_PYTEST_TIMEOUT=5 _loki_run_pytest_with_timeout '$SANDBOX_BIN' quick_test.py >/dev/null
" 2>&1)
exit3=$?

if echo "$warning_out" | grep -q "Neither gtimeout nor timeout available"; then
    log_pass "no-timeout-binaries: warning logged"
else
    log_fail "no-timeout-binaries: warning logged" "warning text not found in: $warning_out"
fi

if [ "$exit3" -eq 0 ]; then
    log_pass "no-timeout-binaries: pytest still runs (exit 0)"
else
    log_fail "no-timeout-binaries: pytest still runs" "got exit=$exit3 stderr=$warning_out"
fi

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
