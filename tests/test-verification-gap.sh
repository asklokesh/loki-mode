#!/usr/bin/env bash
# tests/test-verification-gap.sh -- regression for F56/F53: a generated project
# that shipped source (and sometimes a TESTING.md describing tests) but had NO
# runnable tests previously recorded a bare runner:none/not_run and the gate
# passed through SILENTLY. So a real logic bug reached the receipt unverified
# (F53), and test DOCS shipped without test EXECUTION (F56).
#
# Fix asserted here (read back from the written test-results.json):
#   (1) source present, NO tests, NO TESTING.md
#       => runner=="none", pass=="inconclusive", status=="not_run",
#          verification_gap=="source_without_tests".
#   (2) source present AND a TESTING.md that documents tests, NO runnable tests
#       => verification_gap=="test_docs_without_execution" (the stronger
#          docs-without-execution mismatch).
#   (3) truly empty project (no source, no tests, no docs)
#       => verification_gap=="none" (a legitimate no-code state, no false gap).
#   (4) a DETECTED, PASSING runner
#       => verification_gap=="none" (a real suite ran; no gap) and pass==true.
#
# Honesty invariants across all cases:
#   - runner:none NEVER reads as pass:true (no false green on the receipt).
#   - the no-runner path stays non-blocking (rc 0) so a legit no-test project is
#     never forced into an infinite block.
#
# Strategy mirrors tests/test-coverage-gate-fail-open.sh: source run.sh (main()
# and the self-copy block are gated on BASH_SOURCE==$0, so sourcing runs
# neither), stub the log_* helpers, and call the real enforce_test_coverage in
# throwaway TARGET_DIRs.
#
# IMPORTANT: do NOT set LOKI_RUNNING_FROM_TEMP=1 (would arm an EXIT trap that
# deletes BASH_SOURCE[0], i.e. this test file).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: autonomy/run.sh not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d /tmp/loki-test-vgap-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# shellcheck disable=SC1090
. "$RUN_SH"

# Quiet the log_* helpers run.sh defined during the source.
log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

read_field() {
    local proj="$1" field="$2"
    _F="$proj/.loki/quality/test-results.json" _K="$field" python3 -c "
import json, os, sys
try:
    with open(os.environ['_F']) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
v = d.get(os.environ['_K'])
sys.stdout.write(json.dumps(v))
" 2>/dev/null || echo ""
}

run_gate() {
    local proj="$1"
    (
        TARGET_DIR="$proj"; export TARGET_DIR
        LOKI_GATE_TIMEOUT=60; export LOKI_GATE_TIMEOUT
        enforce_test_coverage
    )
}

# ---------------------------------------------------------------------------
# Case (1): source present, no tests, no TESTING.md => source_without_tests.
# ---------------------------------------------------------------------------
P1="$WORK/src-no-tests"
mkdir -p "$P1"
cat > "$P1/app.py" <<'EOF'
def add(a, b):
    return a + b
EOF
if run_gate "$P1"; then r1=0; else r1=$?; fi
g1="$(read_field "$P1" verification_gap)"
p1="$(read_field "$P1" pass)"
s1="$(read_field "$P1" status)"
if [ "$g1" = '"source_without_tests"' ]; then
    ok "(1) source present, no tests => verification_gap=source_without_tests"
else
    bad "(1) gap not recorded" "verification_gap=$g1 (expected \"source_without_tests\")"
fi
if [ "$p1" = '"inconclusive"' ] && [ "$s1" = '"not_run"' ] && [ "$r1" -eq 0 ]; then
    ok "(1) stays honest+non-blocking (pass=inconclusive, status=not_run, rc=0)"
else
    bad "(1) honesty/non-block contract broke" "pass=$p1 status=$s1 rc=$r1"
fi
[ "$p1" = "true" ] && bad "(1) regression: no-test source reads pass:true (false green)" "pass=$p1"

# ---------------------------------------------------------------------------
# Case (2): source + TESTING.md describing tests, no runnable tests
#           => test_docs_without_execution (the F56 mismatch).
# ---------------------------------------------------------------------------
P2="$WORK/docs-no-exec"
mkdir -p "$P2"
cat > "$P2/app.py" <<'EOF'
def mul(a, b):
    return a * b
EOF
cat > "$P2/TESTING.md" <<'EOF'
# Testing

Run the unit tests with pytest. Coverage target is 80%.
EOF
if run_gate "$P2"; then r2=0; else r2=$?; fi
g2="$(read_field "$P2" verification_gap)"
p2="$(read_field "$P2" pass)"
if [ "$g2" = '"test_docs_without_execution"' ]; then
    ok "(2) TESTING.md but no execution => verification_gap=test_docs_without_execution"
else
    bad "(2) docs-without-execution gap not recorded" "verification_gap=$g2 (expected \"test_docs_without_execution\")"
fi
if [ "$p2" = '"inconclusive"' ] && [ "$r2" -eq 0 ]; then
    ok "(2) docs-without-execution stays honest+non-blocking (pass=inconclusive, rc=0)"
else
    bad "(2) honesty/non-block contract broke" "pass=$p2 rc=$r2"
fi
[ "$p2" = "true" ] && bad "(2) regression: test-doc-without-execution reads pass:true (false green)" "pass=$p2"

# ---------------------------------------------------------------------------
# Case (3): truly empty project => no false gap (verification_gap=none).
# ---------------------------------------------------------------------------
P3="$WORK/empty-proj"
mkdir -p "$P3"
echo "just some prose" > "$P3/README.md"
if run_gate "$P3"; then r3=0; else r3=$?; fi
g3="$(read_field "$P3" verification_gap)"
if [ "$g3" = '"none"' ]; then
    ok "(3) empty project (no source) => verification_gap=none (no false gap)"
else
    bad "(3) false gap on empty project" "verification_gap=$g3 (expected \"none\")"
fi
[ "$r3" -eq 0 ] || bad "(3) empty project blocked" "rc=$r3 (expected 0)"

# ---------------------------------------------------------------------------
# Case (4): a DETECTED PASSING runner => verification_gap=none, pass:true.
# Requires node on PATH; SKIP loudly if absent (cases 1-3 still cover the fix).
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
    P4="$WORK/real-suite"
    mkdir -p "$P4"
    cat > "$P4/package.json" <<'EOF'
{ "name": "real-suite", "version": "1.0.0", "scripts": { "test": "node --test" } }
EOF
    cat > "$P4/app.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
test('adds', () => { assert.strictEqual(1 + 1, 2); });
EOF
    if run_gate "$P4"; then r4=0; else r4=$?; fi
    g4="$(read_field "$P4" verification_gap)"
    p4="$(read_field "$P4" pass)"
    runner4="$(read_field "$P4" runner)"
    if [ "$g4" = '"none"' ] && [ "$p4" = "true" ] && [ "$runner4" != '"none"' ] && [ "$r4" -eq 0 ]; then
        ok "(4) detected passing runner => verification_gap=none, pass:true (runner=$runner4)"
    else
        bad "(4) detected-runner schema/honesty broke" "verification_gap=$g4 pass=$p4 runner=$runner4 rc=$r4"
    fi
else
    echo "SKIP: node not on PATH; case (4) requires it. Cases (1)-(3) still cover the fix. (Not a fail.)"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
