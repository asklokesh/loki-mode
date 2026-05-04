#!/usr/bin/env bash
# Tests for council_write_transcript threshold arg (BUG-005)
# Verifies that the 'threshold' field in the written JSON matches the 5th argument,
# not the former hardcoded value of 2.
#
# Strategy: extract council_write_transcript from completion-council.sh via awk
# (depth-counting to handle nested { } in python3 heredocs), write to a temp
# helper file, then source it in isolated sub-shells.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0

pass() { echo "PASS: $*"; PASS=$(( PASS + 1 )); }
fail() { echo "FAIL: $*"; FAIL=$(( FAIL + 1 )); }

# ---------------------------------------------------------------------------
# Extract council_write_transcript using brace-depth counting.
# Simple line-end `/^}/` matching fails because the python3 heredoc body
# contains top-level `}` characters. Depth counting handles this correctly.
# ---------------------------------------------------------------------------
EXTRACTED_FUNC_FILE="$(mktemp /tmp/cwt_func_XXXXXX)"

awk '
/^council_write_transcript\(\)/ { found=1; depth=0 }
found {
    print
    for (i=1; i<=length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") { depth--; if (depth == 0) { exit } }
    }
}
' "$COUNCIL_SH" > "$EXTRACTED_FUNC_FILE"

if [ ! -s "$EXTRACTED_FUNC_FILE" ]; then
    echo "FATAL: could not extract council_write_transcript from $COUNCIL_SH"
    rm -f "$EXTRACTED_FUNC_FILE"
    exit 1
fi

cleanup_all() {
    rm -f "$EXTRACTED_FUNC_FILE"
}
trap cleanup_all EXIT

# ---------------------------------------------------------------------------
# run_transcript <threshold_arg> <tmpdir>
#   Invokes council_write_transcript in a sub-shell with the given threshold.
# ---------------------------------------------------------------------------
run_transcript() {
    local threshold_arg="$1"
    local tmpdir="$2"
    local extracted="$EXTRACTED_FUNC_FILE"

    bash - << RUNNER_HEREDOC 2>/dev/null
set -euo pipefail
COUNCIL_STATE_DIR="${tmpdir}"
COUNCIL_PRD_PATH=""
ITERATION_COUNT=1
log_warn() { true; }
mkdir -p "${tmpdir}/votes"
# shellcheck disable=SC1090
source "${extracted}"
council_write_transcript 1 "APPROVED" "false" "false" "${threshold_arg}"
RUNNER_HEREDOC

    local tdir="${tmpdir}/transcripts"
    if [ ! -d "$tdir" ]; then
        echo ""
        return
    fi
    # shellcheck disable=SC2012
    ls -t "${tdir}"/*.json 2>/dev/null | head -1
}

# ---------------------------------------------------------------------------
# Helper: extract 'threshold' value from a JSON file
# ---------------------------------------------------------------------------
get_threshold_from_json() {
    local jfile="$1"
    python3 - "$jfile" << 'PYEOF'
import json, sys
print(json.load(open(sys.argv[1]))['threshold'])
PYEOF
}

# ---------------------------------------------------------------------------
# Test: specific threshold value is written correctly to the JSON transcript
# ---------------------------------------------------------------------------
run_test() {
    local label="$1"
    local threshold_arg="$2"
    local expected="$3"

    local tmpdir
    tmpdir="$(mktemp -d)"

    local jfile
    jfile="$(run_transcript "$threshold_arg" "$tmpdir")"

    if [ -z "$jfile" ] || [ ! -f "$jfile" ]; then
        fail "$label: transcript file not created"
        rm -rf "$tmpdir"
        return
    fi

    local actual
    actual="$(get_threshold_from_json "$jfile")"

    if [ "$actual" = "$expected" ]; then
        pass "$label: threshold=$actual (expected $expected)"
    else
        fail "$label: threshold=$actual (expected $expected)"
    fi

    rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Test: backward-compat -- omit arg 5, expect default 0
# ---------------------------------------------------------------------------
run_test_no_arg5() {
    local label="backward-compat: omit arg 5 -> threshold defaults to 0"
    local tmpdir
    tmpdir="$(mktemp -d)"
    local extracted="$EXTRACTED_FUNC_FILE"

    bash - << RUNNER_HEREDOC 2>/dev/null
set -euo pipefail
COUNCIL_STATE_DIR="${tmpdir}"
COUNCIL_PRD_PATH=""
ITERATION_COUNT=1
log_warn() { true; }
mkdir -p "${tmpdir}/votes"
# shellcheck disable=SC1090
source "${extracted}"
council_write_transcript 1 "REJECTED" "false" "false"
RUNNER_HEREDOC

    local tdir="${tmpdir}/transcripts"
    if [ ! -d "$tdir" ]; then
        fail "$label: transcript dir not created"
        rm -rf "$tmpdir"
        return
    fi

    # shellcheck disable=SC2012
    local jfile
    jfile="$(ls -t "${tdir}"/*.json 2>/dev/null | head -1)"
    if [ -z "$jfile" ] || [ ! -f "$jfile" ]; then
        fail "$label: transcript file not created"
        rm -rf "$tmpdir"
        return
    fi

    local actual
    actual="$(get_threshold_from_json "$jfile")"
    if [ "$actual" = "0" ]; then
        pass "$label"
    else
        fail "$label: got threshold=$actual (expected 0)"
    fi

    rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
# Run all test cases
# ---------------------------------------------------------------------------

# Threshold 0 (sentinel -- passed when threshold is unknown)
run_test "threshold=0 sentinel" "0" "0"

# Threshold 2 (classic 3-member council: ceiling(2/3 * 3) = 2)
run_test "threshold=2 classic 3-member" "2" "2"

# Threshold 3 (e.g. 4-member council: ceiling(2/3 * 4) = 3)
run_test "threshold=3 larger council" "3" "3"

# Threshold 5 (custom large council)
run_test "threshold=5 large council" "5" "5"

# Backward-compat: 4-arg call omitting arg 5
run_test_no_arg5

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
