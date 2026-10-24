#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-zero-test-inconclusive.sh - regression test for task #82 (trust
# hardening, shipping-contract change): a runner that EXITS 0 but executes ZERO
# real tests is a mini fake-green -- it records pass:true / "verified" while
# proving nothing.
#
# Two zero-test fake-greens exist:
#   1. `node --test empty.test.js` -- a *.test.js with NO test() calls STILL
#      exits 0 and emits `# tests 1 # pass 1`, because node counts the FILE
#      ITSELF as one passing pseudo-test (printed `ok 1 - empty.test.js`). So a
#      naive `# tests 0` check NEVER fires. The true executed count = ok/not-ok
#      lines whose label is NOT a passed test-file basename.
#   2. `jest --passWithNoTests` -- prints "No tests found, exiting with code 0"
#      and NO "Tests:" summary line.
#
# The fix records these as HONEST inconclusive (NOT pass, NOT fail) in BOTH:
#   - autonomy/run.sh    enforce_test_coverage (test-results.json:
#       pass:"inconclusive", status:"no_tests_run", gap:source_without_runnable_tests)
#   - autonomy/verify.sh verify_gate_tests (tests gate: status="inconclusive")
#   - autonomy/completion-council.sh evidence gate consumes the record as
#       INCONCLUSIVE (pass-through, not affirmative, not a block).
#
# Cases:
#   A (run.sh unchanged-pass): a real passing *.test.js -> pass:true (UNCHANGED).
#   B (run.sh RED/GREEN): zero-test *.test.js.
#       RED  (detection stripped): runner=node-test, pass:true, status:verified.
#       GREEN (real body):         runner=node-test, pass:"inconclusive",
#                                  status:no_tests_run, gap:source_without_runnable_tests.
#   C (run.sh unchanged-fail): a FAILING *.test.js -> pass:false (UNCHANGED).
#   D (run.sh over-fire guard): MIXED repo (empty + real together) -> pass:true
#       (the discriminator must NOT over-fire when >=1 real test ran).
#   E (verify.sh): zero-test repo through verify_gate_tests -> tests gate
#       status="inconclusive" (not pass).
#   F (council): the zero-test test-results.json -> evidence gate INCONCLUSIVE.
#
# Self-skips cleanly if node / bash / awk / mktemp / a timeout binary are
# unavailable. node IS available in CI and on the dev host.

set -uo pipefail

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"
COUNCIL_SH="$SCRIPT_DIR/../autonomy/completion-council.sh"

PASS=0
FAIL=0

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
_skip() { printf '  SKIP: %s\n' "$1"; }

# ---- preflight -------------------------------------------------------------
for tool in bash awk mktemp node python3 grep; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        _skip "required tool '$tool' not on PATH -- zero-test-inconclusive test skipped"
        echo "=== results: 0 passed, 0 failed (skipped) ==="
        exit 0
    fi
done
if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
    _skip "no timeout/gtimeout binary -- zero-test-inconclusive test skipped"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    _skip "run.sh not found at $RUN_SH"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-zerotest.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

# ---- extract _loki_zero_tests_executed + enforce_test_coverage from run.sh --
# Both functions are needed (enforce_test_coverage CALLS _loki_zero_tests_executed).
# enforce_test_coverage embeds python heredocs whose bodies contain column-0 `}`
# lines, so the true close is the last column-0 `}` before the NEXT top-level
# function definition (mirrors tests/test-node-test-detection.sh).
START="$(grep -n '^_loki_zero_tests_executed() {' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -z "$START" ]; then
    _no "could not locate _loki_zero_tests_executed() in run.sh"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi
ETC_START="$(grep -n '^enforce_test_coverage() {' "$RUN_SH" | head -1 | cut -d: -f1)"
NEXT_FN="$(awk -v s="$ETC_START" 'NR>s && /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/ {print NR; exit}' "$RUN_SH")"
if [ -z "$ETC_START" ] || [ -z "$NEXT_FN" ]; then
    _no "could not bound enforce_test_coverage() in run.sh"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi
END="$(awk -v s="$ETC_START" -v n="$NEXT_FN" 'NR>s && NR<n && /^}[[:space:]]*$/ {last=NR} END {print last}' "$RUN_SH")"
if [ -z "$END" ]; then
    _no "could not find closing brace of enforce_test_coverage()"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi

FN="$TMP_ROOT/fn.sh"
awk -v s="$START" -v e="$END" 'NR>=s && NR<=e' "$RUN_SH" > "$FN"

# Harness = stubs for external deps + the extracted bodies.
make_harness() {  # $1 = source function file, $2 = output harness
    {
        echo 'log_info()  { :; }'
        echo 'log_warn()  { :; }'
        echo 'log_error() { :; }'
        echo 'measure_test_coverage() { COVERAGE_MEASURED=false; COVERAGE_PCT=""; COVERAGE_TOOL="none"; COVERAGE_REASON="stub"; return 0; }'
        cat "$1"
    } > "$2"
}

HARNESS="$TMP_ROOT/harness.sh"
make_harness "$FN" "$HARNESS"

if bash -n "$HARNESS" 2>/dev/null; then
    _ok "extracted _loki_zero_tests_executed + enforce_test_coverage pass bash -n"
else
    _no "extracted bodies failed bash -n (extraction boundary wrong?)"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi

# Pre-fix (RED) harness: same bodies with the #82 zero-test detection block
# removed (from its leading `# #82 (zero-test-file hardening):` comment up to
# and including the closing `fi` of the detection `if`). This reproduces the
# code as it stood BEFORE #82, so a zero-test file records pass:true (the
# mini-fake-green) -- making the RED half non-vacuous.
FN_OLD="$TMP_ROOT/fn_old.sh"
awk '
    /^    # #82 \(zero-test-file hardening\): a runner that EXITED 0 but/ { skip=1 }
    skip==1 && /^       && _loki_zero_tests_executed / { in_if=1 }
    {
        if (skip==1) {
            if (in_if==1 && $0 ~ /^    fi$/) { skip=0; in_if=0; next }
            next
        }
        print
    }' "$FN" > "$FN_OLD"
HARNESS_OLD="$TMP_ROOT/harness_old.sh"
make_harness "$FN_OLD" "$HARNESS_OLD"

# Sanity: fixed body has the detection call; pre-fix body does NOT.
if grep -q '_loki_zero_tests_executed "\$test_runner"' "$FN" \
   && ! grep -q '_loki_zero_tests_executed "\$test_runner"' "$FN_OLD"; then
    _ok "pre-fix extraction strips the #82 zero-test detection (RED harness honest)"
else
    _no "pre-fix extraction did not cleanly strip the #82 detection (RED harness invalid)"
fi
if ! bash -n "$HARNESS_OLD" 2>/dev/null; then
    _no "pre-fix harness failed bash -n"
fi

# ---- fixture builders ------------------------------------------------------
write_real_test_repo() {  # a real, passing node --test file
    local d="$1"; mkdir -p "$d"
    cat > "$d/slug.js" <<'JS'
module.exports = { slug: (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") };
JS
    cat > "$d/slug.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const { slug } = require("./slug.js");
test("lowercases", () => assert.strictEqual(slug("Hello"), "hello"));
test("spaces", () => assert.strictEqual(slug("a b"), "a-b"));
JS
}

write_zero_test_repo() {  # a *.test.js with ZERO test() calls + source present
    local d="$1"; mkdir -p "$d"
    cat > "$d/util.js" <<'JS'
module.exports = { add: (a, b) => a + b };
JS
    # A file that node --test discovers but which contains NO test() calls.
    cat > "$d/util.test.js" <<'JS'
// This file imports the module but never calls test() -- a fake test file.
const { add } = require("./util.js");
const _unused = add;
JS
}

write_failing_repo() {  # a FAILING node --test file
    local d="$1"; mkdir -p "$d"
    cat > "$d/math.js" <<'JS'
module.exports = { add: (a, b) => a + b };
JS
    cat > "$d/math.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const { add } = require("./math.js");
test("WILL fail", () => assert.strictEqual(add(2, 2), 5));
JS
}

write_mixed_repo() {  # one zero-test file + one REAL test file together
    local d="$1"; mkdir -p "$d"
    cat > "$d/a.js" <<'JS'
module.exports = { id: (x) => x };
JS
    cat > "$d/empty.test.js" <<'JS'
// no test() calls
const { id } = require("./a.js");
const _u = id;
JS
    cat > "$d/real.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const { id } = require("./a.js");
test("identity", () => assert.strictEqual(id(7), 7));
JS
}

tr_field() {  # $1 = repo dir, $2 = json key
    python3 -c "import json; print(json.load(open('$1/.loki/quality/test-results.json')).get('$2',''))" 2>/dev/null
}

export LOKI_COVERAGE_GATE=0

# ---- Case A: run.sh unchanged-pass (real test) -----------------------------
A_REPO="$TMP_ROOT/A_realpass"
write_real_test_repo "$A_REPO"
( cd "$A_REPO"; TARGET_DIR="$A_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
A_RUNNER="$(tr_field "$A_REPO" runner)"; A_PASS="$(tr_field "$A_REPO" pass)"; A_STATUS="$(tr_field "$A_REPO" status)"
printf '  [A real-pass] runner=%s pass=%s status=%s\n' "$A_RUNNER" "$A_PASS" "$A_STATUS"
if [ "$A_RUNNER" = "node-test" ] && [ "$A_PASS" = "True" ] && [ "$A_STATUS" = "verified" ]; then
    _ok "A: a real passing suite still records pass:true/verified (UNCHANGED)"
else
    _no "A: expected node-test/True/verified, got $A_RUNNER/$A_PASS/$A_STATUS"
fi

# ---- Case B: run.sh RED/GREEN (zero-test file) -----------------------------
# RED: pre-fix body records the mini fake-green (pass:true / verified).
B_RED="$TMP_ROOT/B_red"
write_zero_test_repo "$B_RED"
( cd "$B_RED"; TARGET_DIR="$B_RED" bash -c "source '$HARNESS_OLD'; enforce_test_coverage" >/dev/null 2>&1 )
BR_RUNNER="$(tr_field "$B_RED" runner)"; BR_PASS="$(tr_field "$B_RED" pass)"; BR_STATUS="$(tr_field "$B_RED" status)"
printf '  [B-RED pre-fix] runner=%s pass=%s status=%s\n' "$BR_RUNNER" "$BR_PASS" "$BR_STATUS"
if [ "$BR_RUNNER" = "node-test" ] && [ "$BR_PASS" = "True" ] && [ "$BR_STATUS" = "verified" ]; then
    _ok "B-RED: pre-fix records zero-test file as pass:true/verified (the mini fake-green)"
else
    _no "B-RED: expected node-test/True/verified (fake-green), got $BR_RUNNER/$BR_PASS/$BR_STATUS"
fi

# GREEN: fixed body records INCONCLUSIVE (pass:"inconclusive"/no_tests_run/gap).
# A pass marker left by an earlier iteration is seeded first: the zero-test run
# must remove it, not keep or re-create it (BACKLOG 55).
B_GREEN="$TMP_ROOT/B_green"
write_zero_test_repo "$B_GREEN"
mkdir -p "$B_GREEN/.loki/quality"
: > "$B_GREEN/.loki/quality/unit-tests.pass"
BG_RC=0
( cd "$B_GREEN"; TARGET_DIR="$B_GREEN" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 ) || BG_RC=$?
BG_RUNNER="$(tr_field "$B_GREEN" runner)"; BG_PASS="$(tr_field "$B_GREEN" pass)"
BG_STATUS="$(tr_field "$B_GREEN" status)"; BG_GAP="$(tr_field "$B_GREEN" verification_gap)"
printf '  [B-GREEN fixed] runner=%s pass=%s status=%s gap=%s\n' "$BG_RUNNER" "$BG_PASS" "$BG_STATUS" "$BG_GAP"
if [ "$BG_RUNNER" = "node-test" ] && [ "$BG_PASS" = "inconclusive" ] \
   && [ "$BG_STATUS" = "no_tests_run" ] && [ "$BG_GAP" = "source_without_runnable_tests" ]; then
    _ok "B-GREEN: fixed records zero-test file as inconclusive/no_tests_run/source_without_runnable_tests"
else
    _no "B-GREEN: expected node-test/inconclusive/no_tests_run/source_without_runnable_tests, got $BG_RUNNER/$BG_PASS/$BG_STATUS/$BG_GAP"
fi
# BACKLOG 55: the JSON record alone was downgraded; the tail still touched
# unit-tests.pass (which the receipt reads as "unit_tests passed"). Case A is
# the positive control: a real pass still writes the marker.
if [ ! -e "$B_GREEN/.loki/quality/unit-tests.pass" ]; then
    _ok "B-GREEN: a zero-test run leaves no unit-tests.pass marker (inconclusive is not a pass)"
else
    _no "B-GREEN: a zero-test run left unit-tests.pass behind; the receipt reads it as a passing unit_tests gate"
fi
if [ "$BG_RC" -eq 0 ] && [ ! -e "$B_GREEN/.loki/signals/TESTS_FAILED" ]; then
    _ok "B-GREEN: the zero-test run is not a failure (rc=0, no TESTS_FAILED), so it still reaches the council"
else
    _no "B-GREEN: the zero-test run was turned into a failure (rc=$BG_RC, TESTS_FAILED present: $([ -e "$B_GREEN/.loki/signals/TESTS_FAILED" ] && echo yes || echo no))"
fi
if [ -e "$A_REPO/.loki/quality/unit-tests.pass" ]; then
    _ok "A: control: a real passing suite still writes unit-tests.pass"
else
    _no "A: control broken: a real passing suite wrote no unit-tests.pass"
fi

# ---- Case C: run.sh unchanged-fail (failing test) --------------------------
C_REPO="$TMP_ROOT/C_fail"
write_failing_repo "$C_REPO"
( cd "$C_REPO"; TARGET_DIR="$C_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
C_RUNNER="$(tr_field "$C_REPO" runner)"; C_PASS="$(tr_field "$C_REPO" pass)"; C_STATUS="$(tr_field "$C_REPO" status)"
printf '  [C fail] runner=%s pass=%s status=%s\n' "$C_RUNNER" "$C_PASS" "$C_STATUS"
if [ "$C_RUNNER" = "node-test" ] && [ "$C_PASS" = "False" ] && [ "$C_STATUS" = "failed" ]; then
    _ok "C: a FAILING suite still records pass:false/failed (UNCHANGED, never swallowed to inconclusive)"
else
    _no "C: expected node-test/False/failed, got $C_RUNNER/$C_PASS/$C_STATUS"
fi

# ---- Case D: run.sh over-fire guard (mixed empty + real) -------------------
D_REPO="$TMP_ROOT/D_mixed"
write_mixed_repo "$D_REPO"
( cd "$D_REPO"; TARGET_DIR="$D_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
D_RUNNER="$(tr_field "$D_REPO" runner)"; D_PASS="$(tr_field "$D_REPO" pass)"; D_STATUS="$(tr_field "$D_REPO" status)"
printf '  [D mixed] runner=%s pass=%s status=%s\n' "$D_RUNNER" "$D_PASS" "$D_STATUS"
if [ "$D_RUNNER" = "node-test" ] && [ "$D_PASS" = "True" ] && [ "$D_STATUS" = "verified" ]; then
    _ok "D: a MIXED repo (>=1 real test) stays pass:true (detection does NOT over-fire)"
else
    _no "D: expected node-test/True/verified, got $D_RUNNER/$D_PASS/$D_STATUS (over-fired on a real test)"
fi

# ---- Case E: verify.sh zero-test -> tests gate inconclusive ----------------
if [ ! -f "$VERIFY_SH" ]; then
    _skip "E: verify.sh not found -- skipping"
else
    E_REPO="$TMP_ROOT/E_verify"
    write_zero_test_repo "$E_REPO"
    (
        cd "$E_REPO"
        git init -q
        git config user.email "test@loki.local"; git config user.name "loki test"
        git checkout -q -b main
        git add -A; git commit -q -m "base"
        git checkout -q -b feature
        printf '// touch\n' >> util.js
        git add -A; git commit -q -m "feature"
    )
    ( cd "$E_REPO" && bash "$VERIFY_SH" >/dev/null 2>&1 )
    E_STATUS="$(python3 - "$E_REPO/.loki/verify/evidence.json" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
for g in (d.get("deterministic_gates") or d.get("gates") or []):
    if isinstance(g, dict) and g.get("gate") == "tests":
        print("%s|%s" % (g.get("status"), g.get("runner"))); break
PY
)"
    printf '  [E verify tests gate] %s\n' "${E_STATUS:-<none>}"
    if [ "${E_STATUS%%|*}" = "inconclusive" ] && [ "${E_STATUS##*|}" = "node-test" ]; then
        _ok "E: verify.sh records zero-test node-test run as tests gate inconclusive (not pass)"
    else
        _no "E: expected tests gate inconclusive/node-test, got $E_STATUS"
    fi
fi

# ---- Case F: completion-council evidence gate consumes it as INCONCLUSIVE ---
# Replicate the gate's python verdict logic verbatim against both a zero-test
# record and a real-pass record, asserting the zero-test one is INCONCLUSIVE
# and the real-pass one stays PASS.
# BACKLOG 33 rework (S-07, take 2): status=='no_tests_run' is now checked
# BEFORE runner=='none' (a zero-test record can carry runner=='none' too, and
# the old order let that short-circuit into an affirmative PASS -- the same
# ordering bug already fixed here for council_evaluate_member). runner=='none'
# is UNCONDITIONAL pass (no pass:true narrowing): the only real writer of
# runner:"none" (run.sh's enforce_test_coverage no-runner branch) always
# writes pass:"inconclusive" (a string), never a boolean true.
council_verdict() {  # $1 = test-results.json path -> prints VERDICT
    _TR_FILE="$1" python3 -c "
import json, os, sys
tr_file = os.environ['_TR_FILE']
try:
    with open(tr_file) as f:
        d = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('INCONCLUSIVE'); sys.exit(0)
runner = d.get('runner', 'none')
passed = d.get('pass', True)
status = d.get('status', '')
if status == 'no_tests_run':
    print('INCONCLUSIVE')
elif runner == 'none':
    print('PASS')
elif passed is False:
    print('FAIL')
elif passed is not True:
    print('INCONCLUSIVE')
else:
    print('PASS')
" 2>/dev/null
}
# Guard: the verdict logic under test MUST match the shipped council source, so
# this test breaks if the council branch is ever removed/edited out of sync.
# Pinned sequence (specific enough that a comment mentioning the same words
# cannot satisfy it): the ZEROTESTS print, followed by the now-unconditional
# runner=='none' branch printing PASS:none:true.
if [ -f "$COUNCIL_SH" ] \
    && grep -q "print('ZEROTESTS:%s:true' % runner)" "$COUNCIL_SH" \
    && grep -q "elif runner == 'none':" "$COUNCIL_SH" \
    && grep -A1 "elif runner == 'none':" "$COUNCIL_SH" | grep -q "print('PASS:none:true')"; then
    _ok "F-guard: completion-council.sh checks status=='no_tests_run' (ZEROTESTS) before the unconditional runner=='none' PASS"
else
    _no "F-guard: completion-council.sh missing the BACKLOG 33 take-2 ZEROTESTS-before-runner==none order (verdict logic drifted)"
fi
F_ZERO="$(council_verdict "$B_GREEN/.loki/quality/test-results.json")"
F_REAL="$(council_verdict "$A_REPO/.loki/quality/test-results.json")"
F_FAIL="$(council_verdict "$C_REPO/.loki/quality/test-results.json")"
printf '  [F council] zero-test=%s real-pass=%s fail=%s\n' "$F_ZERO" "$F_REAL" "$F_FAIL"
if [ "$F_ZERO" = "INCONCLUSIVE" ]; then
    _ok "F: council evidence gate reads the zero-test record as INCONCLUSIVE (not affirmative green)"
else
    _no "F: expected zero-test record -> INCONCLUSIVE, got $F_ZERO"
fi
if [ "$F_REAL" = "PASS" ] && [ "$F_FAIL" = "FAIL" ]; then
    _ok "F: council still reads real-pass->PASS and fail->FAIL (unchanged)"
else
    _no "F: expected real-pass->PASS/fail->FAIL, got real=$F_REAL fail=$F_FAIL"
fi

# F2 (BACKLOG 33 REWORK #2): the REAL no-test-tooling shape, generated by
# ACTUALLY RUNNING run.sh's own enforce_test_coverage via $HARNESS on a
# directory with source but no test tooling (same pattern as Case J's J_NONE
# below) -- not a hand-typed literal. A hand-typed fixture is exactly what let
# the D20 belief ("the no-runner writer records pass:true") go unchecked and
# hid the prior rework's regression. This ties the fixture to the real writer
# so it cannot silently drift from it.
F2_DIR="$TMP_ROOT/f2-real-notest"
mkdir -p "$F2_DIR"
printf 'print(1)\n' > "$F2_DIR/app.py"
( cd "$F2_DIR"; TARGET_DIR="$F2_DIR" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
F2_RUNNER="$(tr_field "$F2_DIR" runner)"; F2_PASS="$(tr_field "$F2_DIR" pass)"; F2_STATUS="$(tr_field "$F2_DIR" status)"
printf '  [F2 real no-tooling] runner=%s pass=%s status=%s\n' "$F2_RUNNER" "$F2_PASS" "$F2_STATUS"
if [ "$F2_RUNNER" = "none" ] && [ "$F2_PASS" = "inconclusive" ] && [ "$F2_STATUS" = "not_run" ]; then
    _ok "F2 control: enforce_test_coverage's real no-tooling write is runner:none/pass:\"inconclusive\"/status:not_run (never a boolean pass:true)"
else
    _no "F2 control: expected runner=none/pass=inconclusive/status=not_run, got $F2_RUNNER/$F2_PASS/$F2_STATUS (F2 below would be vacuous)"
fi
F2_REAL="$(council_verdict "$F2_DIR/.loki/quality/test-results.json")"
if [ "$F2_REAL" = "PASS" ]; then
    _ok "F2: council evidence-gate replica reads the REAL no-test-tooling record as PASS (no-tooling sentinel, not narrowed to boolean pass:true)"
else
    _no "F2: expected the real no-test-tooling record -> PASS, got $F2_REAL"
fi
# F3: the real council_evaluate_member (sourced from $COUNCIL_SH, not a
# replica) must vote the SAME way on this actually-generated record as it does
# today on origin/main: 2-of-3 COMPLETE (requirements_verifier + devils_advocate
# COMPLETE, test_auditor CONTINUE). This is the exact regression the reviewer
# found in the prior (unmerged) rework.
if [ -f "$COUNCIL_SH" ] && command -v python3 >/dev/null 2>&1; then
    mkdir -p "$F2_DIR/.loki/logs" "$F2_DIR/.loki/queue"
    # shellcheck disable=SC2329  # invoked indirectly: sourced by council_evaluate_member's callers
    F3_VOTE() {  # <role> -> first token of council_evaluate_member's vote
        (
            log_info()  { :; }; log_warn()  { :; }; log_error() { :; }; log_debug() { :; }
            # shellcheck source=/dev/null
            source "$COUNCIL_SH" >/dev/null 2>&1 || true
            # shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
            ITERATION_COUNT=5 COUNCIL_CONSECUTIVE_NO_CHANGE=0 COUNCIL_MIN_ITERATIONS=3
            # shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
            TARGET_DIR="$F2_DIR"
            cd "$F2_DIR" || exit 3
            council_evaluate_member "$1" "test" | cut -d' ' -f1
        )
    }
    F3_RV="$(F3_VOTE requirements_verifier)"
    F3_TA="$(F3_VOTE test_auditor)"
    F3_DA="$(F3_VOTE devils_advocate)"
    printf '  [F3 member votes] requirements_verifier=%s test_auditor=%s devils_advocate=%s\n' "$F3_RV" "$F3_TA" "$F3_DA"
    if [ "$F3_RV" = "COMPLETE" ] && [ "$F3_TA" = "CONTINUE" ] && [ "$F3_DA" = "COMPLETE" ]; then
        _ok "F3: council_evaluate_member votes 2-of-3 COMPLETE on the REAL no-test-tooling record (unchanged from origin/main)"
    else
        _no "F3: expected requirements_verifier=COMPLETE test_auditor=CONTINUE devils_advocate=COMPLETE, got $F3_RV/$F3_TA/$F3_DA"
    fi
else
    _skip "F3: council_evaluate_member not available (missing completion-council.sh or python3)"
fi

# ---- Case G: _loki_zero_tests_executed jest branch (durable, no jest install) --
# jest is half of #82 but every case above uses node-test. Give the JEST branch
# a DURABLE regression net by unit-testing the shared helper against CANNED jest
# output (the exact strings jest emits), so a refactor of the jest branch is
# caught even on a CI box with no jest installed. Also re-covers node-test at the
# helper level (canned) for symmetry. Sourced from the extracted $HARNESS which
# already contains _loki_zero_tests_executed.
(
    # shellcheck source=/dev/null
    source "$HARNESS"
    # jest --passWithNoTests on an empty suite: "No tests found, exiting with code 0".
    if _loki_zero_tests_executed jest "No tests found, exiting with code 0"; then
        echo "GJ-EMPTY:zero"
    else
        echo "GJ-EMPTY:has"
    fi
    # jest with a real suite: prints a "Tests:" summary line.
    if _loki_zero_tests_executed jest "Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total"; then
        echo "GJ-REAL:zero"
    else
        echo "GJ-REAL:has"
    fi
    # node-test canned: file-wrapper-only (zero real) vs a named subtest (real).
    if _loki_zero_tests_executed node-test "TAP version 13
# Subtest: /abs/util.test.js
ok 1 - /abs/util.test.js
1..1
# tests 1
# pass 1" "/abs/util.test.js"; then
        echo "GN-EMPTY:zero"
    else
        echo "GN-EMPTY:has"
    fi
    if _loki_zero_tests_executed node-test "TAP version 13
# Subtest: adds
ok 1 - adds
1..1
# tests 1
# pass 1" "/abs/math.test.js"; then
        echo "GN-REAL:zero"
    else
        echo "GN-REAL:has"
    fi
) > "$TMP_ROOT/G.out" 2>/dev/null
G_JE="$(grep '^GJ-EMPTY:' "$TMP_ROOT/G.out" | cut -d: -f2)"
G_JR="$(grep '^GJ-REAL:'  "$TMP_ROOT/G.out" | cut -d: -f2)"
G_NE="$(grep '^GN-EMPTY:' "$TMP_ROOT/G.out" | cut -d: -f2)"
G_NR="$(grep '^GN-REAL:'  "$TMP_ROOT/G.out" | cut -d: -f2)"
printf '  [G helper] jest-empty=%s jest-real=%s node-empty=%s node-real=%s\n' "$G_JE" "$G_JR" "$G_NE" "$G_NR"
if [ "$G_JE" = "zero" ] && [ "$G_JR" = "has" ]; then
    _ok "G: helper jest branch: 'No tests found' -> zero; a 'Tests:' summary -> has tests"
else
    _no "G: jest branch wrong: empty=$G_JE (want zero), real=$G_JR (want has)"
fi
if [ "$G_NE" = "zero" ] && [ "$G_NR" = "has" ]; then
    _ok "G: helper node-test branch: file-wrapper-only -> zero; a named subtest -> has tests"
else
    _no "G: node-test branch wrong: empty=$G_NE (want zero), real=$G_NR (want has)"
fi

# verify.sh owns a separate copy of the detector. Node 26's default spec
# reporter has no TAP ok-lines; absence of those lines must not be interpreted
# as positive evidence that zero tests ran.
VERIFY_HELPER="$TMP_ROOT/verify-zero-helper.sh"
sed -n '/^_verify_zero_tests_executed() {/,/^}/p' "$VERIFY_SH" > "$VERIFY_HELPER"
(
    # shellcheck source=/dev/null
    source "$VERIFY_HELPER"
    if _verify_zero_tests_executed node-test "✔ adds (0.3ms)
ℹ tests 1
ℹ pass 1"; then
        echo "GV-SPEC:zero"
    else
        echo "GV-SPEC:has"
    fi
    if _verify_zero_tests_executed node-test "TAP version 13
# Subtest: /abs/empty.test.js
ok 1 - /abs/empty.test.js
1..1
# tests 1
# pass 1" "/abs/empty.test.js"; then
        echo "GV-TAP-EMPTY:zero"
    else
        echo "GV-TAP-EMPTY:has"
    fi
) > "$TMP_ROOT/GV.out" 2>/dev/null
G_VS="$(grep '^GV-SPEC:' "$TMP_ROOT/GV.out" | cut -d: -f2)"
G_VE="$(grep '^GV-TAP-EMPTY:' "$TMP_ROOT/GV.out" | cut -d: -f2)"
if [ "$G_VS" = "has" ] && [ "$G_VE" = "zero" ]; then
    _ok "G: verify helper keeps Node spec output passing and TAP wrapper-only output inconclusive"
else
    _no "G: verify helper reporter discrimination wrong: spec=$G_VS (want has), tap-empty=$G_VE (want zero)"
fi

# ---- Case H: _loki_zero_tests_executed go-test branch (#89, durable) --------
# go test ./... on a package with no *_test.go EXITS 0 (unlike vitest/pytest/
# mocha, which exit non-zero on zero tests -> already not-pass), so it is the one
# runner in this class that would fake-green. CANNED against the REAL strings
# captured from `go test` (verified live): zero = `[no test files]` only; a real
# pass = `ok  <pkg>  0.2s`; a MIXED run (some pkgs tested) has `ok` so it must NOT
# be downgraded -- that false-downgrade direction is the load-bearing guard.
(
    # shellcheck source=/dev/null
    source "$HARNESS"
    # zero tests: only "[no test files]" lines, no ran-package result.
    if _loki_zero_tests_executed go-test "?   	zt	[no test files]"; then
        echo "GG-EMPTY:zero"; else echo "GG-EMPTY:has"; fi
    # real passing run: an "ok  <pkg>  <dur>" package result.
    if _loki_zero_tests_executed go-test "ok  	zt	0.233s"; then
        echo "GG-REAL:zero"; else echo "GG-REAL:has"; fi
    # MIXED run: one pkg tested (ok), one bare ([no test files]) -> has tests.
    if _loki_zero_tests_executed go-test "ok  	zt	(cached)
?   	zt/sub	[no test files]"; then
        echo "GG-MIXED:zero"; else echo "GG-MIXED:has"; fi
    # a FAILING go run must not read as zero-tests either (FAIL line present).
    if _loki_zero_tests_executed go-test "--- FAIL: TestAdd (0.00s)
FAIL	zt	0.1s"; then
        echo "GG-FAIL:zero"; else echo "GG-FAIL:has"; fi
) > "$TMP_ROOT/H.out" 2>/dev/null
H_E="$(grep '^GG-EMPTY:' "$TMP_ROOT/H.out" | cut -d: -f2)"
H_R="$(grep '^GG-REAL:'  "$TMP_ROOT/H.out" | cut -d: -f2)"
H_M="$(grep '^GG-MIXED:' "$TMP_ROOT/H.out" | cut -d: -f2)"
H_F="$(grep '^GG-FAIL:'  "$TMP_ROOT/H.out" | cut -d: -f2)"
printf '  [H helper] go-empty=%s go-real=%s go-mixed=%s go-fail=%s\n' "$H_E" "$H_R" "$H_M" "$H_F"
if [ "$H_E" = "zero" ] && [ "$H_R" = "has" ] && [ "$H_M" = "has" ] && [ "$H_F" = "has" ]; then
    _ok "H: helper go-test branch (#89): '[no test files]' only -> zero; ok/mixed/FAIL -> has (no false-downgrade)"
else
    _no "H: go-test branch wrong: empty=$H_E(want zero) real=$H_R mixed=$H_M fail=$H_F (want has)"
fi

# ---- Case H2: cargo ("running 0 tests") and mocha ("0 passing") zero-test output -
# Both runners exit 0 on an empty suite, so without a positive arm the gate reads
# a pass. Checked against BOTH detector copies (run.sh and verify.sh). A real
# cargo/mocha run, a mixed cargo run (one binary with tests) and a failing mocha
# run must NOT be downgraded.
CARGO_ZERO=$'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'
CARGO_REAL=$'running 2 tests\ntest a ... ok\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'
CARGO_MIXED=$'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nrunning 1 test\ntest a ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'
MOCHA_ZERO=$'\n\n  0 passing (2ms)\n'
MOCHA_REAL=$'\n\n  3 passing (5ms)\n'
MOCHA_FAILING=$'\n\n  1 passing (5ms)\n  1 failing\n'
(
    # shellcheck source=/dev/null
    source "$HARNESS"
    # shellcheck source=/dev/null
    source "$VERIFY_HELPER"
    for _fn in _loki_zero_tests_executed _verify_zero_tests_executed; do
        _z() { if "$_fn" "$1" "$2"; then echo "H2-$_fn-$3:zero"; else echo "H2-$_fn-$3:has"; fi; }
        _z cargo-test "$CARGO_ZERO" cargo-zero
        _z cargo-test "$CARGO_REAL" cargo-real
        _z cargo-test "$CARGO_MIXED" cargo-mixed
        _z mocha "$MOCHA_ZERO" mocha-zero
        _z mocha "$MOCHA_REAL" mocha-real
        _z mocha "$MOCHA_FAILING" mocha-failing
    done
) > "$TMP_ROOT/H2.out" 2>/dev/null
H2_BAD=""
for _fn in _loki_zero_tests_executed _verify_zero_tests_executed; do
    for _c in cargo-zero mocha-zero; do
        grep -qx "H2-$_fn-$_c:zero" "$TMP_ROOT/H2.out" || H2_BAD="$H2_BAD $_fn/$_c(want zero)"
    done
    for _c in cargo-real cargo-mixed mocha-real mocha-failing; do
        grep -qx "H2-$_fn-$_c:has" "$TMP_ROOT/H2.out" || H2_BAD="$H2_BAD $_fn/$_c(want has)"
    done
done
if [ -z "$H2_BAD" ]; then
    _ok "H2: cargo-test and mocha zero-test output is zero in both detectors; real, mixed and failing runs are not downgraded"
else
    _no "H2: cargo/mocha zero-test detection wrong:$H2_BAD"
fi

# ---- Case I: exit 0 with failures in the runner's own summary (BACKLOG 73) --
# `npm test` runs `sh ./t.sh`, which prints a canned runner output and exits 0
# (a script that swallows the runner's status, e.g. `jest || true`). The gate
# must read the failure count from the summary line and record a failure. Each
# runner has a green control whose summary reports no failures; the node TAP
# and jest controls also carry a test's own log line naming failures ("# fail 2"
# is how node TAP echoes a test's stdout), which must not count.
export npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false
if ! command -v npm >/dev/null 2>&1; then
    _skip "I: npm not on PATH -- exit-0-with-failures cases skipped"
else
    ef_run() { # <name> <canned output> -> "pass|failed_count|status|exit_code|marker"
        local d="$TMP_ROOT/I_$1"
        mkdir -p "$d"
        printf '%s\n' '{"name":"ef","version":"1.0.0","private":true,"scripts":{"test":"sh ./t.sh"}}' > "$d/package.json"
        printf '%s\n' "$2" > "$d/out.txt"
        printf '#!/bin/sh\ncat ./out.txt\nexit 0\n' > "$d/t.sh"
        ( cd "$d"; TARGET_DIR="$d" LOKI_GATE_TIMEOUT=60 bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
        printf '%s|%s|%s|%s|%s\n' "$(tr_field "$d" pass)" "$(tr_field "$d" failed_count)" \
            "$(tr_field "$d" status)" "$(tr_field "$d" exit_code)" \
            "$([ -e "$d/.loki/quality/unit-tests.pass" ] && echo marker || echo nomarker)"
    }
    ef_expect() { # <name> <want> <canned output>
        local got
        got="$(ef_run "$1" "$3")"
        if [ "$got" = "$2" ]; then _ok "I: $1 -> $got"; else _no "I: $1: want $2, got $got"; fi
    }
    RED_WANT="False|1|failed|0|nomarker"
    ef_expect jest-red "$RED_WANT" "  console.log
    all green here

Tests:       1 failed, 2 passed, 3 total
Snapshots:   0 total
Time:        0.4 s
Ran all test suites."
    ef_expect jest-green "True|0|verified|0|marker" "  console.log
    retried 2 failed uploads

Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        0.4 s
Ran all test suites."
    # Two runs in one output (npm test --workspaces, `jest; jest`): a later
    # green summary must not hide the earlier failed one.
    ef_expect jest-concat-red "$RED_WANT" "Tests:       1 failed, 2 passed, 3 total
Snapshots:   0 total
Ran all test suites.
Tests:       3 passed, 3 total
Snapshots:   0 total
Ran all test suites."
    ef_expect vitest-red "$RED_WANT" " Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  0.31s"
    ef_expect vitest-green "True|0|verified|0|marker" " Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  0.31s"
    ef_expect pytest-red "$RED_WANT" "FAILED test_x.py::test_a - assert 1 == 2
========================= 1 failed, 2 passed in 0.03s ========================="
    ef_expect pytest-green "True|0|verified|0|marker" "========================= 3 passed in 0.02s ========================="
    # BACKLOG 111: a genuine fixture/collection/setup error is pytest's own
    # distinct outcome, neither "passed" nor "failed" text. Confirmed live
    # against real pytest: a broken fixture prints "1 passed, 1 error in Xs",
    # and a bad import at collection time prints "1 error in Xs" alone (no
    # "passed" at all). Both must gate the same as a "failed" count.
    ef_expect pytest-error-red "$RED_WANT" "ERROR test_x.py::test_a - RuntimeError: fixture setup failed
========================= 1 passed, 1 error in 0.02s ========================="
    ef_expect pytest-error-only-red "False|1|failed|0|nomarker" "ERROR test_x.py
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
=============================== 1 error in 0.05s ==============================="
    # failed and error are independent outcomes within one summary line (a
    # regular assertion failure plus a separate fixture error): the recorded
    # count is their sum, not either alone.
    ef_expect pytest-error-sum-red "False|4|failed|0|nomarker" "FAILED test_x.py::test_a - assert 1 == 2
========================= 1 failed, 3 errors in 0.1s ========================="
    ef_expect node-tap-red "$RED_WANT" "TAP version 13
not ok 1 - adds
ok 2 - subs
ok 3 - muls
1..3
# tests 3
# pass 2
# fail 1
# cancelled 0"
    ef_expect node-tap-green "True|0|verified|0|marker" "TAP version 13
# Subtest: logs
# fail 2
ok 1 - logs
1..1
# tests 1
# pass 1
# fail 0
# cancelled 0"
    ef_expect node-spec-red "$RED_WANT" "✖ adds (0.4ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1"
    ef_expect mocha-red "$RED_WANT" "  2 passing (5ms)
  1 failing

  1) adds:
     AssertionError: expected 1 to equal 2"
    ef_expect mocha-green "True|0|verified|0|marker" "  3 passing (5ms)"
    ef_expect go-red "$RED_WANT" "--- FAIL: TestAdd (0.00s)
    add_test.go:9: got 1 want 2
FAIL
FAIL	ex	0.1s"
    # BACKLOG 103: jest's "Test Suites:" line and vitest's "Test Files"
    # line can carry the ONLY failed count on a run where a whole suite/file
    # crashed (so none of its individual tests appear), while the "Tests:"
    # line that the parser already read reports only the tests that DID run
    # elsewhere ("Tests: 2 passed"). Before this fix neither summary line
    # matched the awk's Test-Suites/Test-Files branch, so failed_count read 0
    # and pass stayed true over a run with a genuinely failed suite/file.
    ef_expect jest-suites-red "$RED_WANT" "Test Suites: 1 failed, 1 total
Tests:       2 passed, 2 total
Time:        0.4 s
Ran all test suites."
    ef_expect vitest-files-red "$RED_WANT" " Test Files  1 failed | 2 passed (3)
      Tests  2 passed (2)
   Duration  0.31s"
    # Pure-green controls: a "Test Suites:"/"Test Files" line with no failures
    # must still leave the count a MEASURED 0 (seen=1, f=0), not fall back to
    # unmeasured null.
    ef_expect jest-suites-green "True|0|verified|0|marker" "Test Suites: 2 passed, 2 total
Tests:       3 passed, 3 total
Time:        0.4 s
Ran all test suites."
    ef_expect vitest-files-green "True|0|verified|0|marker" " Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  0.31s"
    # No recognised summary: the old best-effort tail count still applies, and
    # a count it records above zero is a failure too (never pass:true beside
    # failed_count > 0, which both readers read as a failure).
    ef_expect unknown-red "$RED_WANT" "custom runner
RESULT: 1 failed, 4 passed"
    # No summary and no count at all: unmeasured (null), unchanged pass.
    ef_expect unknown-green "True|None|verified|0|marker" "custom runner: all good"
fi

# ---- Case J: the test_suite stage event (BACKLOG 91) ------------------------
# The PHASE_UNIT_TESTS block of the loop, cut out of run.sh verbatim, with the
# gate-failure bookkeeping stubbed and emit_stage_complete capturing its status.
# A zero-test run and a no-runner run return 0 (non-blocking, inconclusive):
# their stage status must be the documented not_run, never pass. A real pass is
# pass and a failure is fail.
STAGE="$TMP_ROOT/stage.sh"
{
    cat "$HARNESS"
    echo '_loki_with_app_sandbox() { "$@"; }'
    echo 'clear_gate_failure() { :; }'
    echo 'track_gate_failure() { echo 1; }'
    echo 'gate_failure_disposition() { echo block; }'
    echo 'write_gate_escalation_guidance() { :; }'
    echo 'emit_stage_complete() { printf "%s %s\n" "$1" "$2" >> "$STAGE_LOG"; }'
    echo '_stage_block() {'
    echo '    local gate_failures=""'
    awk '/^            # Test coverage gate$/ {s=1} s {print} s && /emit_stage_complete "test_suite"/ {e=1} e && /^            fi$/ {exit}' "$RUN_SH"
    echo '}'
} > "$STAGE"
if grep -q 'emit_stage_complete "test_suite"' "$STAGE" && bash -n "$STAGE" 2>/dev/null; then
    stage_status() { # <repo> -> the status the block emitted for test_suite
        local log="$1.stage.log"
        rm -f "$log"
        ( cd "$1"; TARGET_DIR="$1" STAGE_LOG="$log" LOKI_GATE_TIMEOUT=60 bash -c "source '$STAGE'; _stage_block" >/dev/null 2>&1 )
        awk '$1 == "test_suite" {print $2}' "$log" 2>/dev/null
    }
    J_ZERO="$TMP_ROOT/J_zero"; write_zero_test_repo "$J_ZERO"
    J_NONE="$TMP_ROOT/J_none"; mkdir -p "$J_NONE"; printf 'print(1)\n' > "$J_NONE/app.py"
    J_REAL="$TMP_ROOT/J_real"; write_real_test_repo "$J_REAL"
    J_FAIL="$TMP_ROOT/J_fail"; write_failing_repo "$J_FAIL"
    JZ="$(stage_status "$J_ZERO")"; JN="$(stage_status "$J_NONE")"
    JR="$(stage_status "$J_REAL")"; JF="$(stage_status "$J_FAIL")"
    printf '  [J stage] zero-test=%s no-runner=%s real-pass=%s fail=%s\n' "$JZ" "$JN" "$JR" "$JF"
    if [ "$JR" = "pass" ] && [ "$JF" = "fail" ]; then
        _ok "J: control: a real pass emits test_suite pass and a failure emits fail"
    else
        _no "J: control broken: real-pass=$JR (want pass), fail=$JF (want fail)"
    fi
    if [ "$JZ" = "not_run" ]; then
        _ok "J: a zero-test run emits stage_complete test_suite not_run (inconclusive), not pass"
    else
        _no "J: a zero-test run emitted test_suite '$JZ', want not_run"
    fi
    if [ "$JN" = "not_run" ]; then
        _ok "J: a no-test-runner run emits stage_complete test_suite not_run, not pass"
    else
        _no "J: a no-test-runner run emitted test_suite '$JN', want not_run"
    fi
else
    _no "J: could not cut the PHASE_UNIT_TESTS stage block out of run.sh"
fi

# ---- Case K: the package.json readers run python3 -E (BACKLOG 81, D7) -------
# enforce_test_coverage reads the root and workspace package.json with inline
# python3 from inside the agent's repo. A committed json.py (answers every read
# with a mocha test script) or sitecustomize.py (loaded through an empty
# PYTHONPATH component) must not steer the runner label. The fixture reaches
# both readers in one call: a root with workspaces and no test script, and a
# workspace that declares jest. Clean reads label it monorepo-jest; a shadowed
# root read gives mocha; a shadowed workspace read gives monorepo-mocha.
K_REPO="$TMP_ROOT/K_shadow"
mkdir -p "$K_REPO/packages/a"
printf '%s\n' '{"name":"ws","version":"1.0.0","private":true,"workspaces":["packages/*"]}' > "$K_REPO/package.json"
printf '%s\n' '{"name":"a","version":"1.0.0","scripts":{"test":"jest"}}' > "$K_REPO/packages/a/package.json"
cat > "$K_REPO/json.py" <<'EOF'
import os
open(os.environ.get("K_MARK", os.devnull), "a").write("json.py\n")
class JSONDecodeError(ValueError): pass
def load(*a, **k): return {"scripts": {"test": "mocha"}}
def loads(*a, **k): return load()
def dump(*a, **k): pass
def dumps(*a, **k): return "{}"
EOF
printf '%s\n' 'import os' 'open(os.environ.get("K_MARK", os.devnull), "a").write("sitecustomize.py\n")' > "$K_REPO/sitecustomize.py"
# Control: an unguarded python3 in this fixture loads both shadows, so an empty
# marker below is a measurement, not an absence.
( cd "$K_REPO"; PYTHONPATH=":/nonexistent" K_MARK="$TMP_ROOT/K_ctl.mark" python3 -c 'import json' ) >/dev/null 2>&1
if grep -q '^json.py$' "$TMP_ROOT/K_ctl.mark" 2>/dev/null && grep -q '^sitecustomize.py$' "$TMP_ROOT/K_ctl.mark" 2>/dev/null; then
    _ok "K: control: an unguarded python3 in the fixture loads both shadow modules"
    ( cd "$K_REPO"; PYTHONPATH=":/nonexistent" K_MARK="$TMP_ROOT/K.mark" TARGET_DIR="$K_REPO" LOKI_GATE_TIMEOUT=60 \
        bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
    K_RUNNER="$(tr_field "$K_REPO" runner)"
    if [ "$K_RUNNER" = "monorepo-jest" ] && [ ! -s "$TMP_ROOT/K.mark" ]; then
        _ok "K: both package.json readers ignore the repo's json.py/sitecustomize.py (runner=monorepo-jest)"
    else
        _no "K: a repo module steered the package.json readers: runner=$K_RUNNER (want monorepo-jest), loaded: $(sort -u "$TMP_ROOT/K.mark" 2>/dev/null | tr '\n' ' ')"
    fi
else
    _no "K: control broken: an unguarded python3 in the fixture did not load both shadows"
fi

# ---- results ---------------------------------------------------------------
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
