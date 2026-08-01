#!/usr/bin/env bash
# tests/test-go-cargo-gate-timeout.sh - regression test: the Go and Rust
# branches of enforce_test_coverage had NO wall-clock bound.
#
# The defect: every other runner in enforce_test_coverage (vitest, jest, mocha,
# pytest, unittest) is wrapped in a timeout. `go test ./...` and `cargo test`
# were not. `cargo test` has no default timeout at all; `go test` self-imposes
# -timeout 10m PER TEST BINARY but `./...` runs one binary per package, so the
# aggregate is unbounded. A test that blocks on a socket, a lock, or `loop {}`
# hangs the gate forever -- the iteration never returns a verdict and the run is
# stuck with no error, which is the "Ferrari broken down on the roadside" mode.
#
# Note the coverage-measurement pass at run.sh:10581 ALREADY wraps `go test` in
# a timeout. Only the pass/fail gate was unwrapped, which is why this reads as
# an oversight rather than a deliberate exemption.
#
# The fix also had to be portable: stock macOS ships neither `timeout` nor
# `gtimeout`, so a bare `timeout` would be "command not found" (exit 127) and
# flip test_passed=false on EVERY macOS run -- a universal false RED, strictly
# worse than the hang. Hence the shared _loki_timeout_prefix helper, which emits
# an empty prefix (unbounded, pre-existing behaviour) when neither binary exists.
#
# Cases:
#   A (RED/GREEN): a hanging `cargo test` under LOKI_GATE_TIMEOUT=2.
#       RED  (pre-fix body): gate never returns; the OUTER bound kills it (124).
#       GREEN (real body):   gate returns in ~2s, test_passed=false, and details
#                            say TIMED OUT (not a generic red-test failure).
#   B (no false RED): a FAST passing `cargo test` still records pass:true --
#       proves the timeout wrapper did not break the normal path.
#   C (portability): _loki_timeout_prefix with NO timeout binary on PATH emits an
#       EMPTY prefix, so the command still runs (never exit 127 / false RED).
#
# Case A asserts BOTH the fast return AND the TIMED OUT marker. Asserting only
# the return would also pass against a naive `|| test_passed=false` fix that
# cannot tell a timeout from genuinely red tests -- the silently-wrong half.
#
# Self-skips if no timeout binary is available (the harness itself needs one).

set -uo pipefail

PASS=0; FAIL=0
_ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
_no() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"
[ -f "$RUN_SH" ] || { echo "SKIP: run.sh not found"; exit 0; }

# The harness needs a timeout binary to bound the RED case.
OUTER=""
if command -v gtimeout >/dev/null 2>&1; then OUTER="gtimeout"
elif command -v timeout >/dev/null 2>&1; then OUTER="timeout"
else echo "SKIP: no timeout binary available for the harness"; exit 0; fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ---- extract the helper + enforce_test_coverage from run.sh -----------------
# enforce_test_coverage embeds python heredocs containing column-0 `}` lines, so
# the true close is the LAST column-0 `}` before the next top-level function
# (same boundary logic as tests/test-zero-test-inconclusive.sh).
extract_fn() {  # $1 = function name -> stdout
    local start end next
    start="$(grep -n "^$1() {" "$RUN_SH" | head -1 | cut -d: -f1)"
    [ -n "$start" ] || return 1
    next="$(awk -v s="$start" 'NR>s && /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/ {print NR; exit}' "$RUN_SH")"
    [ -n "$next" ] || return 1
    end="$(awk -v s="$start" -v n="$next" 'NR>s && NR<n && /^}[[:space:]]*$/ {last=NR} END {print last}' "$RUN_SH")"
    [ -n "$end" ] || return 1
    awk -v s="$start" -v e="$end" 'NR>=s && NR<=e' "$RUN_SH"
}

FN="$TMP_ROOT/fn.sh"
{
    extract_fn _loki_timeout_prefix || { echo "EXTRACT_FAIL"; exit 1; }
    extract_fn _loki_zero_tests_executed || true
    extract_fn enforce_test_coverage || { echo "EXTRACT_FAIL"; exit 1; }
} > "$FN" 2>/dev/null
if grep -q EXTRACT_FAIL "$FN" 2>/dev/null || [ ! -s "$FN" ]; then
    _no "could not extract functions from run.sh"
    echo "=== results: $PASS passed, $FAIL failed ==="; exit 1
fi

make_harness() {  # $1 = fn file, $2 = out
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
    _ok "extracted _loki_timeout_prefix + enforce_test_coverage pass bash -n"
else
    _no "extracted bodies failed bash -n (extraction boundary wrong?)"
    echo "=== results: $PASS passed, $FAIL failed ==="; exit 1
fi

# Pre-fix (RED) harness: restore the ORIGINAL unwrapped cargo invocation.
RED_FN="$TMP_ROOT/fn_red.sh"
sed -e 's|^        output=$(cd "${TARGET_DIR:-.}" && "${_cargo_cmd\[@\]}" cargo test 2>&1)$|        output=$(cd "${TARGET_DIR:-.}" \&\& cargo test 2>\&1) \|\| test_passed=false|' \
    -e 's|^        cargo_exit=$?$||' "$FN" > "$RED_FN"
HARNESS_RED="$TMP_ROOT/harness_red.sh"
make_harness "$RED_FN" "$HARNESS_RED"
if ! grep -q 'cargo test 2>&1) || test_passed=false' "$HARNESS_RED"; then
    _no "RED harness construction failed (pre-fix cargo line not restored)"
    echo "=== results: $PASS passed, $FAIL failed ==="; exit 1
fi

# ---- shim dir: a runner that hangs, and one that passes fast ---------------
# $3 selects the ecosystem so the SAME harness drives both branches. cargo and
# go are separate branches in enforce_test_coverage AND go has its own arm in
# _loki_zero_tests_executed, so a go timeout must be checked independently: it
# must record pass=false, NOT pass="inconclusive" (a timeout misfiled as
# inconclusive is the silently-wrong variant of this same defect).
mk_repo() {  # $1 = repo dir, $2 = shim body, $3 = cargo|go (default cargo)
    local tool="${3:-cargo}"
    mkdir -p "$1/bin"
    if [ "$tool" = "go" ]; then
        printf 'module t\n\ngo 1.21\n' > "$1/go.mod"
    else
        printf '[package]\nname = "t"\n' > "$1/Cargo.toml"
    fi
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$1/bin/$tool"
    chmod +x "$1/bin/$tool"
}

run_gate() {  # $1 = repo, $2 = harness -> prints elapsed; writes test-results.json
    local repo="$1" h="$2"
    ( cd "$repo"; PATH="$repo/bin:$PATH" TARGET_DIR="$repo" LOKI_GATE_TIMEOUT=2 \
        $OUTER 20s bash -c "source '$h'; enforce_test_coverage" >/dev/null 2>&1 )
    echo $?
}

read_json() {  # $1 = repo, $2 = key
    python3 -c "
import json,sys
try:
    d=json.load(open('$1/.loki/quality/test-results.json'))
    v=d.get('$2','')
    print(json.dumps(v) if not isinstance(v,str) else v)
except Exception:
    print('MISSING')
" 2>/dev/null
}

# ---- Case A: hanging cargo test -------------------------------------------
A_RED="$TMP_ROOT/a_red"; mk_repo "$A_RED" 'sleep 60'
START=$(date +%s)
RED_RC=$(run_gate "$A_RED" "$HARNESS_RED")
RED_ELAPSED=$(( $(date +%s) - START ))

if [ "$RED_RC" -eq 124 ]; then
    _ok "A-RED: pre-fix body HANGS -- outer 20s bound fired (rc=124, ${RED_ELAPSED}s), gate never returned"
else
    _no "A-RED: expected outer timeout (124), got rc=$RED_RC after ${RED_ELAPSED}s -- defect not reproduced"
fi

A_GREEN="$TMP_ROOT/a_green"; mk_repo "$A_GREEN" 'sleep 60'
START=$(date +%s)
GREEN_RC=$(run_gate "$A_GREEN" "$HARNESS")
GREEN_ELAPSED=$(( $(date +%s) - START ))
G_PASS="$(read_json "$A_GREEN" pass)"
G_DET="$(read_json "$A_GREEN" summary)"

if [ "$GREEN_RC" -ne 124 ] && [ "$GREEN_ELAPSED" -lt 15 ]; then
    _ok "A-GREEN: fixed body RETURNS in ${GREEN_ELAPSED}s (bounded by LOKI_GATE_TIMEOUT=2)"
else
    _no "A-GREEN: gate did not return promptly (rc=$GREEN_RC, ${GREEN_ELAPSED}s)"
fi

if [ "$G_PASS" = "false" ]; then
    _ok "A-GREEN: timeout recorded as pass=false (not a fake green)"
else
    _no "A-GREEN: expected pass=false, got '$G_PASS'"
fi

case "$G_DET" in
    *"TIMED OUT"*) _ok "A-GREEN: summary distinguishes TIMED OUT from a red suite ($G_DET)" ;;
    *) _no "A-GREEN: summary lacks the TIMED OUT marker, got '$G_DET'" ;;
esac

# ---- Case B: fast passing cargo must still pass (no false RED) -------------
B_REPO="$TMP_ROOT/b"; mk_repo "$B_REPO" 'echo "test result: ok. 3 passed; 0 failed"; exit 0'
run_gate "$B_REPO" "$HARNESS" >/dev/null
B_PASS="$(read_json "$B_REPO" pass)"
if [ "$B_PASS" = "true" ]; then
    _ok "B: fast passing cargo test still records pass=true (timeout wrapper is transparent)"
else
    _no "B: timeout wrapper broke the passing path, pass='$B_PASS'"
fi

# ---- Case C: no timeout binary on PATH -> empty prefix, never exit 127 -----
mkdir -p "$TMP_ROOT/empty_bin"
# Absolute bash path: PATH is emptied for this probe, so `bash` itself would not
# resolve. `command -v` is a builtin, so it still consults the emptied PATH.
BASH_ABS="$(command -v bash)"
# log_warn is redefined here to write to STDOUT, matching production
# (run.sh:1684 `log_warn() { ... echo -e ... }` -- stdout, NOT stderr). The
# helper's stdout becomes the command-prefix array, so if the warning is not
# redirected to stderr inside the helper it lands in that array and the gate
# executes "[WARN]" -> exit 127 -> false RED on every box without a timeout
# binary. Stubbing log_warn as a no-op (or onto stderr) would make this case a
# tautology that passes either way, so it deliberately uses the worst case.
C_OUT="$(PATH="$TMP_ROOT/empty_bin" "$BASH_ABS" -c "
    source '$HARNESS'
    log_warn() { echo \"[WARN] \$*\"; }
    _cmd=()
    read -r -a _cmd <<< \"\$(_loki_timeout_prefix 5 'probe')\"
    echo \"count=\${#_cmd[@]}\"
" 2>/dev/null)"
if [ "$C_OUT" = "count=0" ]; then
    _ok "C: no timeout binary on PATH -> EMPTY prefix (runs unbounded, never a 127 false RED)"
else
    _no "C: expected empty prefix with no timeout binary, got '$C_OUT'"
fi

# ---- Case D: hanging `go test` -- separate branch, separate classification --
# go routes through its own arm of _loki_zero_tests_executed. A timed-out go run
# emits no `[no test files]` marker, so it must land as pass=false rather than
# being swept into pass="inconclusive".
D_REPO="$TMP_ROOT/d"; mk_repo "$D_REPO" 'sleep 60' go
START=$(date +%s)
D_RC=$(run_gate "$D_REPO" "$HARNESS")
D_ELAPSED=$(( $(date +%s) - START ))
D_PASS="$(read_json "$D_REPO" pass)"
D_DET="$(read_json "$D_REPO" summary)"
D_RUNNER="$(read_json "$D_REPO" runner)"

if [ "$D_RC" -ne 124 ] && [ "$D_ELAPSED" -lt 15 ]; then
    _ok "D: hanging go test RETURNS in ${D_ELAPSED}s (runner=$D_RUNNER)"
else
    _no "D: go gate did not return promptly (rc=$D_RC, ${D_ELAPSED}s)"
fi

if [ "$D_PASS" = "false" ]; then
    _ok "D: go timeout recorded pass=false (not 'inconclusive', not fake-green)"
else
    _no "D: expected go pass=false, got '$D_PASS'"
fi

case "$D_DET" in
    *"TIMED OUT"*) _ok "D: go summary distinguishes TIMED OUT ($D_DET)" ;;
    *) _no "D: go summary lacks the TIMED OUT marker, got '$D_DET'" ;;
esac

# --- WIRING: the real gates must actually CALL the helper --------------------
# Everything above extracts _loki_timeout_prefix into a scratch harness and
# tests it in isolation. That proves the HELPER works and says nothing about
# whether the gates use it. Renaming the helper in run.sh left this entire file
# green while every language gate reverted to running unbounded.
#
# Found by mutation probe, which reported the test PASSED with the invariant
# broken. An isolation test cannot catch a disconnected wire; only an assertion
# on the call site can.
if grep -qF "_loki_timeout_prefix()" "$RUN_SH"; then
    _ok "WIRING: the timeout helper is defined under the name the gates call"
else
    _no "WIRING: the helper name and its call sites have diverged"
fi

for _gate in "go test gate" "cargo test gate"; do
    if grep -F "_loki_timeout_prefix" "$RUN_SH" | grep -qF "$_gate"; then
        _ok "WIRING: the $_gate invokes the timeout helper"
    else
        _no "WIRING: the $_gate does NOT invoke the helper -- it would run unbounded"
    fi
done

echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
