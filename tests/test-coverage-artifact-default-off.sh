#!/usr/bin/env bash
# tests/test-coverage-artifact-default-off.sh -- regression guard for v7.51.0
# "coverage artifact honesty".
#
# WHAT THIS GUARDS
#   Before v7.51.0, at the DEFAULT (coverage measurement OFF, i.e.
#   LOKI_COVERAGE_GATE unset and LOKI_ENFORCE_COVERAGE unset) the coverage
#   block was skipped entirely, so no `.loki/quality/coverage.json` was ever
#   written -- a missing-artifact hole in the reproducibility manifest. v7.51.0
#   made the gate ALWAYS write coverage.json, recording measured:false at the
#   default (zero added runtime, no instrumented re-run, never blocking).
#
#   This is a DISTINCT code path from test-coverage-measurement.sh case (3):
#   that case reaches measured:false on the measurement-ON branch
#   (LOKI_ENFORCE_COVERAGE=1, tool absent). Here we exercise the DEFAULT-OFF
#   else-branch (autonomy/run.sh ~7793-7834), which nothing else covers.
#
# CONTRACT ASSERTED (LOKI_COVERAGE_GATE + LOKI_ENFORCE_COVERAGE both unset):
#   - coverage.json EXISTS after enforce_test_coverage runs.
#   - measured == false       (honest: nothing was measured)
#   - pct     == null         (no fabricated number)
#   - blocked == false        (default path never blocks)
#   - enforced == false
#   - reason mentions LOKI_COVERAGE_GATE (actionable: how to enable)
#   - enforce_test_coverage returns 0 (rc 0) -- the gate did not block.
#
# Strategy mirrors tests/test-coverage-gate-fail-open.sh: source the real
# run.sh (main()/self-copy block are gated on BASH_SOURCE==$0, so sourcing runs
# neither), stub log_*, and call the real enforce_test_coverage against a
# throwaway TARGET_DIR with a DETECTED, passing test runner (a node --test
# project). A detected runner is required because enforce_test_coverage returns
# early for runner=="none" BEFORE the coverage block; with both coverage knobs
# unset the detected-runner path falls into the default-off else-branch that
# writes coverage.json with measured:false. Requires `node` on PATH; SKIPs
# loudly otherwise (a silent skip would hide the very regression we guard).
#
# IMPORTANT: do NOT set LOKI_RUNNING_FROM_TEMP=1 (it arms an EXIT trap that
# deletes BASH_SOURCE[0], i.e. this test file).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# RUN_SH overridable so the non-vacuity self-check can point at a mutated copy.
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-test-covdefoff-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Source the runner (inert top-level when sourced), then quiet its log_* helpers.
# shellcheck disable=SC1090
. "$RUN_SH"
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_step()    { :; }
log_header()  { :; }
log_success() { :; }
log_debug()   { :; }

if ! type enforce_test_coverage >/dev/null 2>&1; then
    echo "SKIP: enforce_test_coverage not defined. (Not a fail.)"; exit 0
fi

# Read one field from a project's coverage.json. Prints empty on any error.
read_cov() {
    local proj="$1" field="$2"
    _F="$proj/.loki/quality/coverage.json" _K="$field" python3 -c "
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

# ---------------------------------------------------------------------------
# Case 1: default-off (no coverage knobs) -> coverage.json written, measured:false
# ---------------------------------------------------------------------------
echo "Case 1: LOKI_COVERAGE_GATE + LOKI_ENFORCE_COVERAGE unset -> coverage.json measured:false"
if ! command -v node >/dev/null 2>&1; then
    echo "SKIP: node not installed; the default-off path needs a detected runner (node --test). (Not a fail.)"
    echo
    echo "coverage-artifact-default-off: $PASS passed, $FAIL failed"
    exit 0
fi
PROJ="$WORK/defoff-proj"
mkdir -p "$PROJ"
# A node --test project: 'node-test' runner is DETECTED and PASSES, but has no
# coverage path in measure_test_coverage, so with both coverage knobs unset we
# reach the default-off else-branch that must still write coverage.json.
cat > "$PROJ/package.json" <<'EOF'
{ "name": "defoff-proj", "version": "1.0.0", "scripts": { "test": "node --test" } }
EOF
cat > "$PROJ/app.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
test('adds', () => { assert.strictEqual(1 + 1, 2); });
EOF

cov_rc=0
(
    TARGET_DIR="$PROJ"; export TARGET_DIR
    LOKI_GATE_TIMEOUT=30; export LOKI_GATE_TIMEOUT
    # Explicitly clear both knobs to prove the DEFAULT path.
    unset LOKI_COVERAGE_GATE LOKI_ENFORCE_COVERAGE 2>/dev/null || true
    enforce_test_coverage
) || cov_rc=$?

COV_JSON="$PROJ/.loki/quality/coverage.json"
if [ -f "$COV_JSON" ]; then
    ok "case1 coverage.json exists at default-off"
else
    bad "case1 coverage.json missing at default-off" "expected $COV_JSON"
fi

m="$(read_cov "$PROJ" measured)"
p="$(read_cov "$PROJ" pct)"
b="$(read_cov "$PROJ" blocked)"
e="$(read_cov "$PROJ" enforced)"
r="$(read_cov "$PROJ" reason)"

[ "$m" = "false" ] && ok "case1 measured:false" || bad "case1 measured!=false" "got [$m]"
[ "$p" = "null" ]  && ok "case1 pct:null (no fabricated number)" || bad "case1 pct!=null" "got [$p]"
[ "$b" = "false" ] && ok "case1 blocked:false" || bad "case1 blocked!=false" "got [$b]"
[ "$e" = "false" ] && ok "case1 enforced:false" || bad "case1 enforced!=false" "got [$e]"
case "$r" in
    *LOKI_COVERAGE_GATE*) ok "case1 reason is actionable (mentions LOKI_COVERAGE_GATE)" ;;
    *) bad "case1 reason not actionable" "got [$r]" ;;
esac
[ "$cov_rc" -eq 0 ] && ok "case1 enforce_test_coverage rc 0 (did not block)" \
    || bad "case1 gate blocked at default-off" "rc=$cov_rc"

# ---------------------------------------------------------------------------
echo
echo "coverage-artifact-default-off: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
