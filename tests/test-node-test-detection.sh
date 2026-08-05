#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-node-test-detection.sh - regression test for task #79 (trust defect):
# the node built-in test runner (`node --test`, stable since Node 18) was not
# detected when a project ships *.test.{js,mjs,cjs} files with NO package.json.
# Such a deliverable (slug.js + slug.test.js, 9/9 passing) fell through to
# runner="none" and recorded verification_gap="source_without_tests" ->
# a FALSE-NEGATIVE (genuinely-correct, fully-tested work read as NOT VERIFIED,
# symmetric to fake-green). The fix adds a node --test fallback branch BELOW
# every explicit-framework path in BOTH detectors:
#
#   1. autonomy/run.sh   enforce_test_coverage  (writes .loki/quality/test-results.json)
#   2. autonomy/verify.sh verify_gate_tests      (`loki verify` -> evidence.json gate)
#
# Cases:
#   A (run.sh RED/GREEN): slug.js + slug.test.js, NO package.json.
#       PRE-fix (extracted body with the node-test branch stripped):
#           runner="none", status="not_run", verification_gap="source_without_tests".
#       POST-fix (real body): runner="node-test", pass:true, verification_gap="none".
#   B (run.sh honesty / non-vacuity): a FAILING *.test.js -> runner="node-test",
#       pass:false (a failing suite is NEVER swallowed into a pass).
#   C (run.sh no-regression): package.json declaring jest still selects jest,
#       NOT node-test (node-test is strictly a fallback).
#   D (run.sh over-fire guard): slug.js only, NO test file -> still records
#       verification_gap="source_without_tests" (the branch does not over-fire).
#   E (verify.sh RED/GREEN): the same slug.js + slug.test.js repo through the
#       whole `loki verify` -> the tests gate reports runner="node-test", pass.
#
# Self-skips cleanly if node / bash / awk / mktemp / a timeout binary are
# unavailable. node IS available in CI and on the dev host.

set -uo pipefail

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"

PASS=0
FAIL=0

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
_skip() { printf '  SKIP: %s\n' "$1"; }

# ---- preflight -------------------------------------------------------------
for tool in bash awk mktemp node python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        _skip "required tool '$tool' not on PATH -- node --test detection test skipped"
        echo "=== results: 0 passed, 0 failed (skipped) ==="
        exit 0
    fi
done
if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
    _skip "no timeout/gtimeout binary -- node --test detection test skipped"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    _skip "run.sh not found at $RUN_SH"
    echo "=== results: 0 passed, 0 failed (skipped) ==="
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-nodetest.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

# ---- extract enforce_test_coverage() verbatim from run.sh ------------------
# The function contains nested python heredocs, so it is pulled by exact
# line-range extraction (its own column-0 closing brace) rather than
# reconstructed (mirrors tests/test-completion-signal-consume.sh).
START="$(grep -n '^enforce_test_coverage() {' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -z "$START" ]; then
    _no "could not locate enforce_test_coverage() in run.sh"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi
# enforce_test_coverage() embeds several python heredocs whose bodies contain
# column-0 `}` lines, so the FIRST `^}$` after START is NOT the function close.
# The true close is the last column-0 `}` before the next top-level function
# definition. Find that next definition, then the last `^}$` strictly above it.
NEXT_FN="$(awk -v s="$START" 'NR>s && /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/ {print NR; exit}' "$RUN_SH")"
if [ -z "$NEXT_FN" ]; then
    _no "could not find the function following enforce_test_coverage()"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi
END="$(awk -v s="$START" -v n="$NEXT_FN" 'NR>s && NR<n && /^}[[:space:]]*$/ {last=NR} END {print last}' "$RUN_SH")"
if [ -z "$END" ]; then
    _no "could not find closing brace of enforce_test_coverage()"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi

FN="$TMP_ROOT/fn.sh"
awk -v s="$START" -v e="$END" 'NR>=s && NR<=e' "$RUN_SH" > "$FN"

# Harness = stubs for the function's only external deps + the extracted body.
# LOKI_COVERAGE_GATE=0 (exported below) short-circuits the coverage double-run,
# but measure_test_coverage is stubbed defensively regardless.
make_harness() {  # $1 = source function file, $2 = output harness
    {
        echo 'log_info()  { :; }'
        echo 'log_warn()  { :; }'
        echo 'log_error() { :; }'
        echo 'measure_test_coverage() { COVERAGE_MEASURED=false; COVERAGE_PCT=""; COVERAGE_TOOL="none"; COVERAGE_REASON="stub"; return 0; }'
        # enforce_test_coverage calls these sibling helpers (defined above it in
        # run.sh, so not pulled by the single-function extraction). Stub them to
        # the SAFE default: _loki_zero_tests_executed returns 1 (normal -- tests
        # ran, no honest-downgrade), so the runner LABEL under test is never
        # altered by the zero-test path. _loki_run_pytest_with_timeout is only
        # reached on a python project (not these node cases) -- stub it inert.
        echo '_loki_zero_tests_executed() { return 1; }'
        echo '_loki_run_pytest_with_timeout() { return 0; }'
        cat "$1"
    } > "$2"
}

HARNESS="$TMP_ROOT/harness.sh"
make_harness "$FN" "$HARNESS"

if bash -n "$HARNESS" 2>/dev/null; then
    _ok "extracted enforce_test_coverage body passes bash -n"
else
    _no "extracted enforce_test_coverage body failed bash -n (extraction boundary wrong?)"
    echo "=== results: $PASS passed, $FAIL failed ==="
    exit 1
fi

# Pre-fix harness: the SAME extracted body with the node --test branch removed
# (everything from the branch's leading comment to its closing `fi`, inclusive).
# This is the code as it stood BEFORE task #79; it MUST report runner=none so
# the RED half of the proof is non-vacuous.
HARNESS_OLD="$TMP_ROOT/harness_old.sh"
FN_OLD="$TMP_ROOT/fn_old.sh"
awk '
    BEGIN { skip=0 }
    /# node --test \(built-in Node test runner\) -- config-less fallback \(task #79\)\./ { skip=1 }
    skip==1 && /^    if \[ "\$test_runner" = "none" \] && command -v node/ { indeleteblock=1 }
    {
        if (skip==1) {
            # Drop lines until we pass the branchs closing `    fi` that follows
            # the node-test detection block, then resume.
            if (indeleteblock==1 && $0 ~ /^    fi$/) { skip=0; indeleteblock=0; next }
            if (indeleteblock==1) next
            # comment/blank lines of the branch before the `if` line
            next
        }
        print
    }' "$FN" > "$FN_OLD"
make_harness "$FN_OLD" "$HARNESS_OLD"

# Sanity: the fixed body MUST contain the no-package.json fallback branch guard;
# the pre-fix body MUST NOT. (The string "node-test" also appears in the UNRELATED
# package.json scripts.test label at run.sh:9029, so we anchor on the branch's
# distinctive guard `command -v node` inside the fallback, not the bare label.)
NT_GUARD='if \[ "\$test_runner" = "none" \] && command -v node'
if grep -qE "$NT_GUARD" "$FN" && ! grep -qE "$NT_GUARD" "$FN_OLD"; then
    _ok "pre-fix extraction strips the node-test fallback branch (RED harness is honest)"
else
    _no "pre-fix extraction did not cleanly strip the node-test fallback branch (RED harness invalid)"
fi
if ! bash -n "$HARNESS_OLD" 2>/dev/null; then
    _no "pre-fix harness failed bash -n"
fi

# ---- helpers to build fixture repos ----------------------------------------
# A real, passing node --test file: 9 assertions over a slug() implementation.
write_passing_repo() {
    local d="$1"
    mkdir -p "$d"
    cat > "$d/slug.js" <<'JS'
function slug(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
module.exports = { slug };
JS
    cat > "$d/slug.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const { slug } = require("./slug.js");

test("lowercases", () => assert.strictEqual(slug("Hello"), "hello"));
test("spaces to dashes", () => assert.strictEqual(slug("a b c"), "a-b-c"));
test("trims", () => assert.strictEqual(slug("  x  "), "x"));
test("collapses", () => assert.strictEqual(slug("a   b"), "a-b"));
test("strips symbols", () => assert.strictEqual(slug("a!@#b"), "a-b"));
test("leading/trailing", () => assert.strictEqual(slug("--a--"), "a"));
test("numbers kept", () => assert.strictEqual(slug("v1 2"), "v1-2"));
test("empty", () => assert.strictEqual(slug(""), ""));
test("mixed", () => assert.strictEqual(slug("Foo Bar 1!"), "foo-bar-1"));
JS
}

# A FAILING node --test file (asserts something false).
write_failing_repo() {
    local d="$1"
    mkdir -p "$d"
    cat > "$d/math.js" <<'JS'
function add(a, b) { return a + b; }
module.exports = { add };
JS
    cat > "$d/math.test.js" <<'JS'
const test = require("node:test");
const assert = require("node:assert");
const { add } = require("./math.js");
test("this WILL fail", () => assert.strictEqual(add(2, 2), 5));
JS
}

# Read a field out of the written test-results.json.
tr_field() {  # $1 = repo dir, $2 = json key
    local d="$1" key="$2"
    python3 -c "import json,sys; print(json.load(open('$d/.loki/quality/test-results.json')).get('$2',''))" 2>/dev/null
}

# ---- Case A: run.sh RED/GREEN (no package.json) ----------------------------
export LOKI_COVERAGE_GATE=0   # skip the coverage double-run in both harnesses

# RED: pre-fix body records runner=none / not_run / source_without_tests.
RED_REPO="$TMP_ROOT/A_red"
write_passing_repo "$RED_REPO"
(
    cd "$RED_REPO" || exit 3
    TARGET_DIR="$RED_REPO" bash -c "source '$HARNESS_OLD'; enforce_test_coverage" >/dev/null 2>&1
)
RED_RUNNER="$(tr_field "$RED_REPO" runner)"
RED_STATUS="$(tr_field "$RED_REPO" status)"
RED_GAP="$(tr_field "$RED_REPO" verification_gap)"
printf '  [A-RED pre-fix] runner=%s status=%s gap=%s\n' "$RED_RUNNER" "$RED_STATUS" "$RED_GAP"
if [ "$RED_RUNNER" = "none" ] && [ "$RED_STATUS" = "not_run" ] && [ "$RED_GAP" = "source_without_tests" ]; then
    _ok "A-RED: pre-fix records runner=none/not_run/source_without_tests (the false-negative)"
else
    _no "A-RED: expected none/not_run/source_without_tests, got $RED_RUNNER/$RED_STATUS/$RED_GAP"
fi

# GREEN: fixed body records runner=node-test / pass true / verified.
GREEN_REPO="$TMP_ROOT/A_green"
write_passing_repo "$GREEN_REPO"
(
    cd "$GREEN_REPO" || exit 3
    TARGET_DIR="$GREEN_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1
)
GREEN_RUNNER="$(tr_field "$GREEN_REPO" runner)"
GREEN_PASS="$(tr_field "$GREEN_REPO" pass)"
GREEN_STATUS="$(tr_field "$GREEN_REPO" status)"
GREEN_GAP="$(tr_field "$GREEN_REPO" verification_gap)"
GREEN_PN="$(tr_field "$GREEN_REPO" passed_count)"
printf '  [A-GREEN fixed] runner=%s pass=%s status=%s gap=%s passed_count=%s\n' \
    "$GREEN_RUNNER" "$GREEN_PASS" "$GREEN_STATUS" "$GREEN_GAP" "$GREEN_PN"
if [ "$GREEN_RUNNER" = "node-test" ] && [ "$GREEN_PASS" = "True" ] \
   && [ "$GREEN_STATUS" = "verified" ] && [ "$GREEN_GAP" = "none" ]; then
    _ok "A-GREEN: fixed records runner=node-test/pass:true/verified/gap:none"
else
    _no "A-GREEN: expected node-test/True/verified/none, got $GREEN_RUNNER/$GREEN_PASS/$GREEN_STATUS/$GREEN_GAP"
fi
# passed_count is best-effort from node's TAP "# pass N"; the 9-test suite -> 9.
if [ "$GREEN_PN" = "9" ]; then
    _ok "A-GREEN: passed_count parsed from node TAP output (9 subtests)"
else
    _no "A-GREEN: expected passed_count=9 from TAP parse, got $GREEN_PN"
fi

# ---- Case B: run.sh honesty -- a FAILING suite is not swallowed ------------
FAIL_REPO="$TMP_ROOT/B_fail"
write_failing_repo "$FAIL_REPO"
(
    cd "$FAIL_REPO" || exit 3
    TARGET_DIR="$FAIL_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1
)
B_RUNNER="$(tr_field "$FAIL_REPO" runner)"
B_PASS="$(tr_field "$FAIL_REPO" pass)"
B_STATUS="$(tr_field "$FAIL_REPO" status)"
printf '  [B fail] runner=%s pass=%s status=%s\n' "$B_RUNNER" "$B_PASS" "$B_STATUS"
if [ "$B_RUNNER" = "node-test" ] && [ "$B_PASS" = "False" ] && [ "$B_STATUS" = "failed" ]; then
    _ok "B: a FAILING node --test suite records node-test/pass:false (never swallowed)"
else
    _no "B: expected node-test/False/failed, got $B_RUNNER/$B_PASS/$B_STATUS"
fi

# ---- Case C: run.sh no-regression -- package.json+jest still picks jest ----
JEST_REPO="$TMP_ROOT/C_jest"
write_passing_repo "$JEST_REPO"
cat > "$JEST_REPO/package.json" <<'JSON'
{ "name": "c", "version": "1.0.0", "devDependencies": { "jest": "^29.0.0" } }
JSON
(
    cd "$JEST_REPO" || exit 3
    # jest is not installed here; the run will error, but the RUNNER LABEL is
    # what matters -- it must be jest (the explicit framework), NEVER node-test.
    TARGET_DIR="$JEST_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1
)
C_RUNNER="$(tr_field "$JEST_REPO" runner)"
printf '  [C jest] runner=%s\n' "$C_RUNNER"
if [ "$C_RUNNER" = "jest" ]; then
    _ok "C: package.json declaring jest still selects jest, not node-test (no regression)"
else
    _no "C: expected runner=jest, got $C_RUNNER (node-test over-fired past the framework path)"
fi

# ---- Case D: run.sh over-fire guard -- source only, no test file -----------
SRC_ONLY_REPO="$TMP_ROOT/D_srconly"
mkdir -p "$SRC_ONLY_REPO"
cat > "$SRC_ONLY_REPO/slug.js" <<'JS'
module.exports = { slug: (s) => s };
JS
(
    cd "$SRC_ONLY_REPO" || exit 3
    TARGET_DIR="$SRC_ONLY_REPO" bash -c "source '$HARNESS'; enforce_test_coverage" >/dev/null 2>&1
)
D_RUNNER="$(tr_field "$SRC_ONLY_REPO" runner)"
D_GAP="$(tr_field "$SRC_ONLY_REPO" verification_gap)"
printf '  [D src-only] runner=%s gap=%s\n' "$D_RUNNER" "$D_GAP"
if [ "$D_RUNNER" = "none" ] && [ "$D_GAP" = "source_without_tests" ]; then
    _ok "D: source without any test file still records source_without_tests (branch does not over-fire)"
else
    _no "D: expected none/source_without_tests, got $D_RUNNER/$D_GAP"
fi

# ---- Case E: verify.sh RED/GREEN through the whole `loki verify` ------------
if [ ! -f "$VERIFY_SH" ]; then
    _skip "E: verify.sh not found -- skipping loki verify gate check"
else
    E_REPO="$TMP_ROOT/E_verify"
    write_passing_repo "$E_REPO"
    (
        cd "$E_REPO"
        git init -q
        git config user.email "test@loki.local"
        git config user.name "loki test"
        git checkout -q -b main
        git add -A
        git commit -q -m "base"
        # A feature commit so the PR diff (merge-base(main,HEAD)..HEAD) is
        # non-empty; verify short-circuits on an empty diff (skips all gates).
        git checkout -q -b feature
        printf '// touch\n' >> slug.js
        git add -A
        git commit -q -m "feature"
    )
    (
        cd "$E_REPO" && bash "$VERIFY_SH" >/dev/null 2>&1
    )
    # Pull the tests gate row out of evidence.json.
    # The tests gate stores the runner label under key "runner" (verify.sh:1574).
    E_GATE_JSON="$(python3 - "$E_REPO/.loki/verify/evidence.json" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
gates = d.get("deterministic_gates") or d.get("gates") or []
for g in gates:
    if isinstance(g, dict) and g.get("gate") == "tests":
        print(json.dumps({"status": g.get("status"), "runner": g.get("runner")}))
        break
PY
)"
    printf '  [E verify tests gate] %s\n' "${E_GATE_JSON:-<none>}"
    E_RUNNER="$(printf '%s' "$E_GATE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('runner',''))" 2>/dev/null || echo "")"
    E_STATUS="$(printf '%s' "$E_GATE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")"
    if [ "$E_RUNNER" = "node-test" ] && [ "$E_STATUS" = "pass" ]; then
        _ok "E: loki verify tests gate reports runner=node-test status=pass (verdict surface fixed)"
    else
        _no "E: expected tests gate runner=node-test/pass, got runner=$E_RUNNER status=$E_STATUS"
    fi
fi

# ---- results ---------------------------------------------------------------
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
