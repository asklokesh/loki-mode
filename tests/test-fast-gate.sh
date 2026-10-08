#!/usr/bin/env bash
# tests/test-fast-gate.sh -- D90 fast gate planner (scripts/ci/fast-gate.sh).
#
# Mutation-style proof that a diff selects the suites that guard it:
#   - loki-ts/src/commands/doctor.ts selects the doctor bun and shell suites;
#   - Dockerfile.control-plane selects tests/test-control-plane.sh (CP-04),
#     which the selector alone sends to "R0 unknown path shape";
#   - a workflow edit selects the workflow guards, not the full set;
#   - an unrelated docs edit selects NO doctor suite (the selection is not
#     "everything");
#   - an uncomputable diff fails safe to FULL;
#   - the planner's R0 path list agrees with scripts/select-tests.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 2
export LOKI_NO_BROWSER=1
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
export -n LOKI_RUN_TMP
T="$LOKI_RUN_TMP"

plan_for() { # plan_for <name> <file>... ; plan lands in $T/<name>/plan.tsv
    local name="$1"; shift
    printf '%s\n' "$@" >"$T/$name.files"
    FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/$name.files" \
        bash scripts/ci/fast-gate.sh plan test "$T/$name" >"$T/$name.log" 2>&1
}
has() { awk -F'\t' -v t="$2" '$2==t {f=1} END{exit f?0:1}' "$T/$1/plan.tsv"; }

plan_for doctor loki-ts/src/commands/doctor.ts
if has doctor loki-ts/tests/commands/doctor.test.ts && has doctor tests/test-doctor-single-impl.sh \
    && ! grep -q '^FULL' "$T/doctor/plan.tsv"; then
    ok "doctor.ts selects the doctor bun test and the doctor shell suites, not the full set"
else bad "doctor.ts did not select the doctor suites ($(cut -f1,2 "$T/doctor/plan.tsv" | head -5 | tr '\n' ' '))"; fi

plan_for cp Dockerfile.control-plane
if has cp tests/test-control-plane.sh && ! grep -q '^FULL' "$T/cp/plan.tsv"; then
    ok "Dockerfile.control-plane selects tests/test-control-plane.sh (CP-04)"
else bad "Dockerfile.control-plane did not select tests/test-control-plane.sh"; fi

plan_for wf .github/workflows/test.yml
if has wf tests/test-ci-cache-scope.sh && has wf tests/test-registration-coverage.sh && ! grep -q '^FULL' "$T/wf/plan.tsv"; then
    ok "a workflow edit selects the workflow guards, not the full set"
else bad "a workflow edit did not select the workflow guards"; fi

plan_for docs docs/v10/DECISIONS.md
if ! has docs tests/test-doctor-single-impl.sh && ! grep -q '^FULL' "$T/docs/plan.tsv"; then
    ok "mutation: an unrelated docs edit selects no doctor suite"
else bad "mutation: a docs edit selected a doctor suite or the full set"; fi

FAST_GATE_TEST_MODE=0 bash scripts/ci/fast-gate.sh plan "refs/does/not/exist" HEAD "$T/bad" >"$T/bad.log" 2>&1
if grep -q '^FULL' "$T/bad/plan.tsv" && grep -q 'full=true' "$T/bad/outputs.txt"; then
    ok "an uncomputable diff fails safe to FULL"
else bad "an uncomputable diff did not fail safe to FULL"; fi

# Parity: every sample the planner calls R0 must be R0 in the selector, and
# every sample it does not must not be.
parity=1
for f in VERSION package.json web-app/package.json loki-ts/dist/loki.js tests/lib/x.sh .github/workflows/test.yml \
         Dockerfile.control-plane loki-ts/src/commands/doctor.ts docs/a.md autonomy/loki; do
    # shellcheck disable=SC1090
    sel_r0=0
    printf '%s\n' "$f" | bash scripts/select-tests.sh --files - 2>/dev/null | grep -q '^R0' && sel_r0=1
    plan_r0=0
    ( . <(sed -n '/^is_r0_path()/,/^}/p' scripts/ci/fast-gate.sh); is_r0_path "$f" ) && plan_r0=1
    [ "$sel_r0" = "$plan_r0" ] || { parity=0; echo "  parity mismatch for $f: selector=$sel_r0 planner=$plan_r0"; }
done
if [ "$parity" = 1 ]; then ok "the planner's R0 path list agrees with scripts/select-tests.sh"
else bad "the planner's R0 path list drifted from scripts/select-tests.sh"; fi

echo "fast-gate tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
