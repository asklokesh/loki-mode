#!/usr/bin/env bash
# tests/test-coverage-gate-fail-open.sh -- regression for the test-coverage gate
# fail-open bug found in a real E2E (v7.41.x).
#
# Bug: enforce_test_coverage() (autonomy/run.sh) did NOT detect a working
# `node --test` suite invoked via a real package.json "scripts.test"; it reported
# runner:none + pass:true. Two failures collapsed together:
#   1. A real, passing suite was mislabeled runner:none (undetected).
#   2. runner:none DEFAULTED to pass:true, so a project whose tests actually FAIL
#      green-lit identically as long as the runner stayed undetected.
#
# Fix asserted here (three outcomes, read back from the written test-results.json):
#   (a) package.json {"scripts":{"test":"node --test"}} + PASSING test
#       => runner != none AND pass == true.
#   (b) same package.json + FAILING test
#       => pass == false (BLOCK).
#   (c) genuinely no tests
#       => runner == none AND pass == "inconclusive" (NOT true, NOT false).
#
# Strategy mirrors tests/test-completion-summary.sh: source run.sh (its main()
# and self-copy block are gated on BASH_SOURCE==$0 so sourcing runs neither),
# stub the log_* helpers, and call the real enforce_test_coverage in throwaway
# TARGET_DIRs. Cases (a)/(b) require `node` on PATH; if absent we SKIP them
# loudly (a silently-passing skip would be the same fail-open bug we are fixing),
# but case (c) always runs.
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

WORK="$(mktemp -d /tmp/loki-test-covgate-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Source the runner. Self-copy block + main() are inert when sourced.
# shellcheck disable=SC1090
. "$RUN_SH"

# Quiet the log_* helpers run.sh defined during the source.
log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

# Read one field from a project's test-results.json. Prints empty on any error.
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
    # Run enforce_test_coverage against proj as TARGET_DIR in a subshell so we
    # capture its return code without leaking TARGET_DIR / cwd.
    local proj="$1"
    (
        TARGET_DIR="$proj"; export TARGET_DIR
        # Keep timeouts tight so a runaway suite can't hang the test.
        LOKI_GATE_TIMEOUT=60; export LOKI_GATE_TIMEOUT
        enforce_test_coverage
    )
}

# ---------------------------------------------------------------------------
# Cases (a) + (b): real node --test suite. Require node on PATH.
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
    # --- Case (a): passing suite => detected + pass:true -------------------
    PA="$WORK/pass-proj"
    mkdir -p "$PA"
    cat > "$PA/package.json" <<'EOF'
{ "name": "pass-proj", "version": "1.0.0", "scripts": { "test": "node --test" } }
EOF
    cat > "$PA/app.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
test('adds', () => { assert.strictEqual(1 + 1, 2); });
EOF
    if run_gate "$PA"; then a_rc=0; else a_rc=$?; fi
    a_runner="$(read_field "$PA" runner)"
    a_pass="$(read_field "$PA" pass)"
    if [ "$a_runner" != '"none"' ] && [ -n "$a_runner" ] && [ "$a_pass" = "true" ] && [ "$a_rc" -eq 0 ]; then
        ok "(a) passing node --test suite detected (runner=$a_runner) and pass:true"
    else
        bad "(a) passing suite mislabeled" "runner=$a_runner pass=$a_pass rc=$a_rc (expected runner!=none, pass=true, rc=0)"
    fi

    # --- Case (b): failing suite => pass:false (BLOCK) --------------------
    PB="$WORK/fail-proj"
    mkdir -p "$PB"
    cat > "$PB/package.json" <<'EOF'
{ "name": "fail-proj", "version": "1.0.0", "scripts": { "test": "node --test" } }
EOF
    cat > "$PB/app.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
test('this fails', () => { assert.strictEqual(1 + 1, 3); });
EOF
    if run_gate "$PB"; then b_rc=0; else b_rc=$?; fi
    b_runner="$(read_field "$PB" runner)"
    b_pass="$(read_field "$PB" pass)"
    if [ "$b_runner" != '"none"' ] && [ -n "$b_runner" ] && [ "$b_pass" = "false" ] && [ "$b_rc" -ne 0 ]; then
        ok "(b) failing node --test suite detected (runner=$b_runner) and pass:false + nonzero rc (BLOCK)"
    else
        bad "(b) failing suite did not block" "runner=$b_runner pass=$b_pass rc=$b_rc (expected runner!=none, pass=false, rc!=0)"
    fi
else
    echo "SKIP: node not on PATH; cases (a)/(b) require it. Case (c) still runs. (Not a fail.)"
fi

# ---------------------------------------------------------------------------
# Case (c): genuinely no tests => runner:none + pass:"inconclusive" (NOT true).
# This is the core fail-CLOSED-on-evidence fix.
# ---------------------------------------------------------------------------
PC="$WORK/notest-proj"
mkdir -p "$PC"
# No package.json, no go.mod, no Cargo.toml, no python markers, no tests/.
echo "just some text" > "$PC/README.md"
if run_gate "$PC"; then c_rc=0; else c_rc=$?; fi
c_runner="$(read_field "$PC" runner)"
c_pass="$(read_field "$PC" pass)"
if [ "$c_runner" = '"none"' ] && [ "$c_pass" = '"inconclusive"' ]; then
    ok "(c) no-test project records runner:none + pass:inconclusive (not pass:true)"
else
    bad "(c) no-test project mislabeled" "runner=$c_runner pass=$c_pass (expected runner=\"none\", pass=\"inconclusive\")"
fi
# Non-blocking contract: the no-runner path must NOT hard-fail (rc 0) so a legit
# no-test project is never forced into an infinite block.
if [ "$c_rc" -eq 0 ]; then
    ok "(c) no-test project returns 0 (non-blocking pass-through, no hang)"
else
    bad "(c) no-test project blocked" "rc=$c_rc (expected 0 -- must not hard-fail a legit no-test project)"
fi
# Explicit non-vacuity: prove the old fail-open value is gone.
if [ "$c_pass" = "true" ]; then
    bad "(c) regression: no-test project still reads pass:true (fail-open)" "pass=$c_pass"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
