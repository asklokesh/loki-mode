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
B_GREEN="$TMP_ROOT/B_green"
write_zero_test_repo "$B_GREEN"
( cd "$B_GREEN"; TARGET_DIR="$B_GREEN" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1 )
BG_RUNNER="$(tr_field "$B_GREEN" runner)"; BG_PASS="$(tr_field "$B_GREEN" pass)"
BG_STATUS="$(tr_field "$B_GREEN" status)"; BG_GAP="$(tr_field "$B_GREEN" verification_gap)"
printf '  [B-GREEN fixed] runner=%s pass=%s status=%s gap=%s\n' "$BG_RUNNER" "$BG_PASS" "$BG_STATUS" "$BG_GAP"
if [ "$BG_RUNNER" = "node-test" ] && [ "$BG_PASS" = "inconclusive" ] \
   && [ "$BG_STATUS" = "no_tests_run" ] && [ "$BG_GAP" = "source_without_runnable_tests" ]; then
    _ok "B-GREEN: fixed records zero-test file as inconclusive/no_tests_run/source_without_runnable_tests"
else
    _no "B-GREEN: expected node-test/inconclusive/no_tests_run/source_without_runnable_tests, got $BG_RUNNER/$BG_PASS/$BG_STATUS/$BG_GAP"
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
if runner == 'none':
    print('PASS')
elif passed is False:
    print('FAIL')
elif status == 'no_tests_run' or passed is not True:
    print('INCONCLUSIVE')
else:
    print('PASS')
" 2>/dev/null
}
# Guard: the verdict logic under test MUST match the shipped council source, so
# this test breaks if the council branch is ever removed/edited out of sync.
if [ -f "$COUNCIL_SH" ] && grep -q "status == 'no_tests_run' or passed is not True" "$COUNCIL_SH"; then
    _ok "F-guard: completion-council.sh contains the #82 no_tests_run/non-True INCONCLUSIVE branch"
else
    _no "F-guard: completion-council.sh missing the #82 INCONCLUSIVE branch (verdict logic drifted)"
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

# ---- results ---------------------------------------------------------------
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
