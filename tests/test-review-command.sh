#!/usr/bin/env bash
# tests/test-review-command.sh - Tests for loki review command
# Part of Loki Mode v6.20.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_DIR/autonomy/loki"
PASS=0
FAIL=0
TOTAL=0

# Temp directory for test fixtures
TEST_DIR=$(mktemp -d /tmp/loki-test-review-XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT

run_test() {
    local name="$1"
    TOTAL=$((TOTAL + 1))
    echo -n "  TEST $TOTAL: $name ... "
}

pass() {
    PASS=$((PASS + 1))
    echo "PASS"
}

fail() {
    FAIL=$((FAIL + 1))
    echo "FAIL: $1"
}

echo "=== loki review command tests ==="
echo ""

# --- Test 1: Review with no changes returns clean ---
run_test "review with no changes returns clean"
(
    cd "$TEST_DIR"
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "clean file" > clean.txt
    git add clean.txt
    git commit -q -m "init"
    # No uncommitted changes, should exit 0
    output=$("$LOKI" review 2>&1) || true
    if echo "$output" | grep -q "No changes to review"; then
        exit 0
    else
        echo "OUTPUT: $output" >&2
        exit 1
    fi
) && pass || fail "expected clean output for no changes"

# --- Test 2: Review detects hardcoded secrets ---
run_test "review detects hardcoded secrets"
(
    cd "$TEST_DIR"
    # Create a file with a hardcoded secret
    mkdir -p src
    cat > src/config.py << 'PYEOF'
# Bad practice
API_KEY = "sk-1234567890abcdefghijklmnopqrstuv"
DATABASE_URL = "postgres://localhost/db"
PYEOF
    output=$("$LOKI" review src/ 2>&1) || true
    if echo "$output" | grep -qi "secret\|hardcoded"; then
        exit 0
    else
        echo "OUTPUT: $output" >&2
        exit 1
    fi
) && pass || fail "expected secret detection"

# --- Test 3: Review detects common anti-patterns ---
run_test "review detects common anti-patterns"
(
    cd "$TEST_DIR"
    mkdir -p src
    cat > src/bad.py << 'PYEOF'
import pickle
import yaml

def load_data(raw):
    data = pickle.loads(raw)
    config = yaml.load(open("config.yml"))
    try:
        process(data)
    except:
        pass
    return data
PYEOF
    output=$("$LOKI" review src/bad.py 2>&1) || true
    found=0
    echo "$output" | grep -qi "deserialization\|pickle\|yaml" && found=$((found + 1))
    echo "$output" | grep -qi "bare except\|except" && found=$((found + 1))
    if [ "$found" -ge 1 ]; then
        exit 0
    else
        echo "OUTPUT: $output" >&2
        exit 1
    fi
) && pass || fail "expected anti-pattern detection"

# --- Test 4: --format json produces valid JSON ---
run_test "--format json produces valid JSON"
(
    cd "$TEST_DIR"
    output=$("$LOKI" review --format json src/config.py 2>&1) || true
    # Validate JSON with python
    echo "$output" | python3 -c "import json, sys; d=json.load(sys.stdin); assert 'findings' in d; assert 'summary' in d" 2>/dev/null
    if [ $? -eq 0 ]; then
        exit 0
    else
        echo "OUTPUT: $output" >&2
        exit 1
    fi
) && pass || fail "expected valid JSON output"

# --- Test 5: --severity filter works ---
run_test "--severity filter works"
(
    cd "$TEST_DIR"
    # Get all findings count
    all_json=$("$LOKI" review --format json src/ 2>&1) || true
    all_total=$(echo "$all_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])" 2>/dev/null)
    # Get high+ findings only
    high_json=$("$LOKI" review --format json --severity high src/ 2>&1) || true
    high_total=$(echo "$high_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['summary']['total'])" 2>/dev/null)
    # High-filtered should have fewer or equal findings
    if [ "$high_total" -le "$all_total" ] 2>/dev/null; then
        exit 0
    else
        echo "all=$all_total high=$high_total" >&2
        exit 1
    fi
) && pass || fail "expected severity filtering to reduce findings"

# --- Test 6: Exit codes are correct ---
run_test "exit codes are correct"
(
    cd "$TEST_DIR"
    # Clean review should exit 0
    echo "clean" > "$TEST_DIR/clean_only.txt"
    "$LOKI" review "$TEST_DIR/clean_only.txt" >/dev/null 2>&1
    clean_code=$?
    # File with critical finding (hardcoded secret) should exit 2
    cat > "$TEST_DIR/secret_file.py" << 'PYEOF'
API_KEY = "sk-1234567890abcdefghijklmnopqrstuv"
SECRET_KEY = "mysupersecretkey12345678"
PYEOF
    "$LOKI" review "$TEST_DIR/secret_file.py" >/dev/null 2>&1
    secret_code=$?
    if [ "$clean_code" -eq 0 ] && [ "$secret_code" -eq 2 ]; then
        exit 0
    else
        echo "clean_code=$clean_code secret_code=$secret_code" >&2
        exit 1
    fi
) && pass || fail "expected exit code 0 for clean, 2 for critical"

# =====================================================================
# --ultra (cloud multi-agent review, issue #168) tests
# =====================================================================
# These use a STUBBED `claude` on PATH so no real (paid) cloud call is made.
# The stub records its argv to $STUB_LOG and prints a marker so we can assert
# (a) the exact argv emitted, (b) that it was NOT called when it must not be.

# Stub dir prepended to PATH. The stub supports two help shapes so we can test
# both the capability-present and capability-absent code paths.
STUB_DIR="$TEST_DIR/stub-bin"
mkdir -p "$STUB_DIR"
STUB_LOG="$TEST_DIR/claude-argv.log"

# Capability-PRESENT stub: `claude --help` lists ultrareview; `claude
# ultrareview ...` logs argv + prints a marker.
cat > "$STUB_DIR/claude" << 'STUBEOF'
#!/usr/bin/env bash
if [ "$1" = "--help" ]; then
    echo "Usage: claude [options] [command]"
    echo "Commands:"
    echo "  ultrareview [options] [target]  Run a cloud-hosted multi-agent code review"
    exit 0
fi
if [ "$1" = "ultrareview" ]; then
    # Log the full argv (one token per line) for exact assertions.
    printf '%s\n' "$@" > "${STUB_CLAUDE_LOG:?}"
    echo "STUB_ULTRAREVIEW_RAN"
    exit 0
fi
exit 0
STUBEOF
chmod +x "$STUB_DIR/claude"

# --- Test: --ultra with --yes emits exact argv `ultrareview --json` ---
run_test "--ultra --yes --format json emits 'ultrareview --json'"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" \
        "$LOKI" review --ultra --yes --format json </dev/null 2>/dev/null) || true
    # Stub must have run.
    echo "$out" | grep -q "STUB_ULTRAREVIEW_RAN" || { echo "stub did not run: $out" >&2; exit 1; }
    # Exact argv: line1=ultrareview, line2=--json, nothing else.
    [ -f "$STUB_LOG" ] || { echo "no argv log" >&2; exit 1; }
    mapfile -t argv < "$STUB_LOG"
    [ "${argv[0]}" = "ultrareview" ] || { echo "argv[0]=${argv[0]}" >&2; exit 1; }
    [ "${argv[1]}" = "--json" ] || { echo "argv[1]=${argv[1]}" >&2; exit 1; }
    [ "${#argv[@]}" -eq 2 ] || { echo "argv count=${#argv[@]}: ${argv[*]}" >&2; exit 1; }
    exit 0
) && pass || fail "expected exact 'ultrareview --json' argv"

# --- Test: --ultra --yes with target + timeout emits target + --timeout ---
run_test "--ultra passes target and --timeout through"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" \
        "$LOKI" review --ultra --yes --timeout 12 42 </dev/null >/dev/null 2>&1 || true
    [ -f "$STUB_LOG" ] || { echo "no argv log" >&2; exit 1; }
    mapfile -t argv < "$STUB_LOG"
    # Expect: ultrareview --timeout 12 42  (text format -> no --json)
    [ "${argv[0]}" = "ultrareview" ] || { echo "argv: ${argv[*]}" >&2; exit 1; }
    printf '%s\n' "${argv[@]}" | grep -qx -- "--timeout" || { echo "no --timeout: ${argv[*]}" >&2; exit 1; }
    printf '%s\n' "${argv[@]}" | grep -qx -- "12" || { echo "no 12: ${argv[*]}" >&2; exit 1; }
    printf '%s\n' "${argv[@]}" | grep -qx -- "42" || { echo "no target 42: ${argv[*]}" >&2; exit 1; }
    printf '%s\n' "${argv[@]}" | grep -qx -- "--json" && { echo "unexpected --json: ${argv[*]}" >&2; exit 1; }
    exit 0
) && pass || fail "expected target + --timeout in argv, no --json"

# --- Test: non-TTY without --yes refuses (exit 2) and makes ZERO calls ---
run_test "non-TTY without --yes exits 2 and never calls ultrareview"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    # stdin is /dev/null (not a TTY); LOKI_ULTRAREVIEW unset; no --yes.
    code=0
    PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_ULTRAREVIEW="" CI="" \
        "$LOKI" review --ultra </dev/null >/dev/null 2>&1 || code=$?
    [ "$code" -eq 2 ] || { echo "exit code=$code (expected 2)" >&2; exit 1; }
    # No-silent-bill guard: the stub must NOT have been invoked.
    [ -f "$STUB_LOG" ] && { echo "ultrareview WAS called (silent bill!)" >&2; exit 1; }
    exit 0
) && pass || fail "expected exit 2 and zero ultrareview calls"

# --- Test: LOKI_ULTRAREVIEW=1 proceeds non-interactively (no --yes, no TTY) ---
run_test "LOKI_ULTRAREVIEW=1 proceeds non-interactively"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_ULTRAREVIEW=1 CI="" \
        "$LOKI" review --ultra </dev/null 2>/dev/null) || true
    echo "$out" | grep -q "STUB_ULTRAREVIEW_RAN" || { echo "stub did not run: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] || { echo "no argv log" >&2; exit 1; }
    mapfile -t argv < "$STUB_LOG"
    [ "${argv[0]}" = "ultrareview" ] || { echo "argv: ${argv[*]}" >&2; exit 1; }
    exit 0
) && pass || fail "expected LOKI_ULTRAREVIEW=1 to proceed"

# --- Test: capability-absent claude degrades to honest error, not a crash ---
run_test "capability-absent claude -> honest error, no crash, zero calls"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    # A claude stub whose --help does NOT list ultrareview.
    noup_dir="$TEST_DIR/stub-noup"
    mkdir -p "$noup_dir"
    cat > "$noup_dir/claude" << 'NOUP'
#!/usr/bin/env bash
if [ "$1" = "--help" ]; then
    echo "Usage: claude [options] [command]"
    echo "Commands:"
    echo "  config   Manage configuration"
    exit 0
fi
# Should never reach here in this test; if it does, log it so the test fails.
printf '%s\n' "$@" > "${STUB_CLAUDE_LOG:?}"
exit 0
NOUP
    chmod +x "$noup_dir/claude"
    code=0
    out=$(PATH="$noup_dir:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" \
        "$LOKI" review --ultra --yes </dev/null 2>&1) || code=$?
    # Honest error mentions ultrareview/upgrade, non-zero exit, and zero calls.
    echo "$out" | grep -qi "ultrareview" || { echo "no honest msg: $out" >&2; exit 1; }
    [ "$code" -ne 0 ] || { echo "expected non-zero exit, got 0" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "ultrareview WAS called despite no capability" >&2; exit 1; }
    exit 0
) && pass || fail "expected honest degrade with no ultrareview call"

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
