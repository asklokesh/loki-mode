#!/usr/bin/env bash
# Test: pytest quality gate timeout wrap (Triage #14, v7.5.15)
#
# Verifies _loki_run_pytest_with_timeout in autonomy/run.sh:
#   1. With LOKI_PYTEST_TIMEOUT=0.3 and a 1s sleeping pytest fixture,
#      the wrapper terminates promptly AND returns exit 124.
#   2. With LOKI_PYTEST_TIMEOUT=15, the same fixture completes normally (exit 0).
#   3. With both `gtimeout` and `timeout` removed from PATH, the wrapper still
#      runs (degraded), prints the warning, and runs unbounded.
#
# The fixture sleeps 1s so it must sit strictly between the two timeout
# values above. 0.3s is short enough that it fires during the sleep (or, on a
# slow/contended box, even during pytest's own startup before the sleep is
# reached) -- either way exit 124 is the correct outcome. 15 is left as a pure
# ceiling: a passing run only takes ~1-2s regardless of how high the ceiling
# is, so keeping it generous costs nothing and removes any risk of a
# contended box legitimately needing more than a tight ceiling would allow.
#
# Total runtime budget: under 10s.

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
# and on _loki_timeout_prefix (the shared portable timeout probe, also used by the
# unittest / go test / cargo test gates -- see tests/test-go-cargo-gate-timeout.sh).
# It uses no other run.sh state. We extract all three via a sourced subshell wrapper.
SOURCE_HARNESS=$(mktemp -t loki-pytest-gate-source.XXXXXX) || exit 2
trap 'rm -f "$SOURCE_HARNESS"' EXIT

# Extract log_warn and the helper from run.sh into a minimal harness.
# Use grep -A to grab function bodies; bail if not found.
{
    echo '#!/usr/bin/env bash'
    echo 'log_warn() { echo "[WARN] $*" >&2; }'
    # Pull the helper definitions (between each function name and its closing brace).
    awk '
        /^(_loki_timeout_prefix|_loki_run_pytest_with_timeout)\(\) \{/ { in_fn = 1 }
        in_fn { print }
        in_fn && /^}$/ { in_fn = 0 }
    ' "$RUN_SH"
} > "$SOURCE_HARNESS"

if ! grep -q '^_loki_timeout_prefix()' "$SOURCE_HARNESS"; then
    log_fail "extract helper" "_loki_timeout_prefix not found in $RUN_SH"
    echo
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

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
echo "Test 1: LOKI_PYTEST_TIMEOUT=0.3 against 1s sleeping fixture"
start_ts=$(date +%s)
LOKI_PYTEST_TIMEOUT=0.3 _loki_run_pytest_with_timeout "$FIXTURE_DIR" sleeping_test.py >/dev/null 2>&1
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
echo "Test 2: LOKI_PYTEST_TIMEOUT=15 against 1s sleeping fixture"
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
# S3 (cost program): verify-evidence false negatives. Bare `pytest` leaves the
# repo root off sys.path and collects 0 items for non-pytest layouts; the helper
# must use `python3 -m pytest` and fall back to stdlib unittest on exit 5.
# ---------------------------------------------------------------------------
S3_WORK=$(mktemp -d -t loki-pytest-gate-s3.XXXXXX) || exit 2
trap 'rm -rf "$SANDBOX_BIN" "$SOURCE_HARNESS" "$S3_WORK"' EXIT

echo "Test 4: root-level module imported from tests/ (needs cwd on sys.path)"
mkdir -p "$S3_WORK/rootmod/tests"
printf 'def add(a, b):\n    return a + b\n' > "$S3_WORK/rootmod/mod.py"
printf 'import mod\n\ndef test_add():\n    assert mod.add(2, 3) == 5\n' > "$S3_WORK/rootmod/tests/test_mod.py"
out4=$(_loki_run_pytest_with_timeout "$S3_WORK/rootmod" -q -p no:cacheprovider 2>&1)
exit4=$?
if [ "$exit4" -eq 0 ] && grep -q '1 passed' <<<"$out4"; then
    log_pass "root-module import: python3 -m pytest passes (no ModuleNotFoundError)"
else
    log_fail "root-module import" "exit=$exit4 out=$(printf '%s' "$out4" | tail -3 | tr '\n' ' ')"
fi

echo "Test 5: pytest collects 0 (custom python_files) -> unittest fallback verifies"
mkdir -p "$S3_WORK/fallback"
printf '[pytest]\npython_files = nomatch_*.py\n' > "$S3_WORK/fallback/pytest.ini"
printf 'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n' > "$S3_WORK/fallback/test_ok.py"
out5=$(_loki_run_pytest_with_timeout "$S3_WORK/fallback" -q -p no:cacheprovider 2>&1)
exit5=$?
if [ "$exit5" -eq 0 ] && grep -q 'fell back to python3 -m unittest discover' <<<"$out5" \
   && grep -qE '^Ran 1 test' <<<"$out5"; then
    log_pass "fallback: exit 0 and unittest ran 1 test"
else
    log_fail "fallback" "exit=$exit5 out=$(printf '%s' "$out5" | tail -4 | tr '\n' ' ')"
fi

echo "Test 6: zero tests from BOTH runners stays exit 5 (inconclusive, never verified)"
mkdir -p "$S3_WORK/zero"
printf 'assert 1 + 1 == 2\n' > "$S3_WORK/zero/test_modlevel.py"
out6=$(_loki_run_pytest_with_timeout "$S3_WORK/zero" -q -p no:cacheprovider 2>&1)
exit6=$?
if [ "$exit6" -eq 5 ] && grep -qE '^Ran 0 tests' <<<"$out6"; then
    log_pass "zero tests: exit 5 with 'Ran 0 tests' (caller records inconclusive)"
else
    log_fail "zero tests" "exit=$exit6 out=$(printf '%s' "$out6" | tail -4 | tr '\n' ' ')"
fi

echo "Test 7: a failing unittest after fallback is non-zero (never fake-green)"
mkdir -p "$S3_WORK/failfb"
printf '[pytest]\npython_files = nomatch_*.py\n' > "$S3_WORK/failfb/pytest.ini"
printf 'import unittest\n\nclass T(unittest.TestCase):\n    def test_no(self):\n        self.assertEqual(1, 2)\n' > "$S3_WORK/failfb/test_no.py"
_loki_run_pytest_with_timeout "$S3_WORK/failfb" -q -p no:cacheprovider >/dev/null 2>&1
exit7=$?
if [ "$exit7" -ne 0 ] && [ "$exit7" -ne 5 ]; then
    log_pass "failing fallback suite: exit $exit7"
else
    log_fail "failing fallback suite" "exit=$exit7"
fi

echo "Test 8: acceptance seed from benchmarks/attribution/tasks/coord-1-api-web passes"
COORD="$REPO_ROOT/benchmarks/attribution/tasks/coord-1-api-web"
if [ -d "$COORD/reference" ]; then
    mkdir -p "$S3_WORK/coord/tests"
    cp -R "$COORD/reference/." "$S3_WORK/coord/"
    cp "$COORD/acceptance/acceptance_test.py" "$S3_WORK/coord/tests/test_acceptance.py"
    out8=$(_loki_run_pytest_with_timeout "$S3_WORK/coord" -q -p no:cacheprovider 2>&1)
    exit8=$?
    if [ "$exit8" -eq 0 ] && grep -q 'passed' <<<"$out8"; then
        log_pass "coord-1-api-web reference + acceptance: tests passed"
    else
        log_fail "coord-1-api-web" "exit=$exit8 out=$(printf '%s' "$out8" | tail -3 | tr '\n' ' ')"
    fi
fi

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
