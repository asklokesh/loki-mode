#!/usr/bin/env bash
# Test: R7 zero-config killer first run (time-to-first-value)
#
# Verifies the additive zero-config first-run path:
#  - detect_arg_type() classifies a one-line brief (whitespace) as "brief"
#  - single-token args still fall back to "unknown" (PRD-path back-compat)
#  - existing inputs (.md PRD, issue refs, empty) are unchanged (no regression)
#  - synthesize_brief_prd() writes a forward-looking PRD with the brief text
#  - set_ttfv_lightweight_profile() exports the lightweight env
#  - `loki start "<brief>"` enters BRIEF mode (lightweight, not PRD-not-found)
#  - `loki start --brief "<one word>"` works (single-word escape hatch)
#  - `loki start <prd.md>` (real PRD) still routes to PRD mode
#  - `loki start --help` documents BRIEF mode and --brief
#
# No paid runs: all CLI invocations are forced to exit before run.sh boots by
# using --provider nonexistent-provider (cmd_start fails the provider pre-flight
# check after mode detection). Helper functions are extracted and tested in
# isolation, mirroring tests/cli/test_start_run_unified.sh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL+1)); }

# Extract a single shell function body from the loki script and source it in a
# subshell, then invoke it. Avoids sourcing the whole CLI (side effects).
extract_func() {
    local fn="$1"
    local start end
    start=$(grep -n "^${fn}()" "$LOKI" | head -1 | cut -d: -f1)
    [ -z "$start" ] && return 1
    end=$(awk -v s="$start" 'NR>s && /^}/{print NR; exit}' "$LOKI")
    sed -n "${start},${end}p" "$LOKI"
}

call_detect() {
    local arg="$1"
    bash -c '
        LOKI="'"$LOKI"'"
        start=$(grep -n "^detect_arg_type()" "$LOKI" | head -1 | cut -d: -f1)
        end=$(awk -v s="$start" "NR>s && /^}/{print NR; exit}" "$LOKI")
        sed -n "${start},${end}p" "$LOKI" > /tmp/_loki_r7_detect.sh
        # shellcheck disable=SC1091
        source /tmp/_loki_r7_detect.sh
        rm -f /tmp/_loki_r7_detect.sh
        detect_arg_type "'"$arg"'"
    '
}

# ============================================================================
# Test 1: detect_arg_type brief classification + no regression
# ============================================================================
echo -e "${YELLOW}=== detect_arg_type() brief classification ===${NC}"

test_detect() {
    local input="$1"
    local expected="$2"
    TOTAL=$((TOTAL+1))
    local got
    got=$(call_detect "$input" 2>/dev/null)
    if [ "$got" = "$expected" ]; then
        log_pass "detect_arg_type('$input') = $expected"
    else
        log_fail "detect_arg_type('$input')" "expected=$expected got=$got"
    fi
}

# NEW: one-line briefs (whitespace, not a file/issue/path) -> brief
test_detect "build a todo app"                "brief"
test_detect "make a snake game in python"     "brief"
test_detect "a CLI that converts CSV to JSON" "brief"

# W1 E2E regression (v7.89.1): a brief that contains a slash (or other path-like
# punctuation) but ALSO whitespace must classify as brief, not prd. Before the
# fix, the "contains /" path-like heuristic ran before the whitespace check, so
# these died with "PRD file not found".
test_detect "a python CLI todo app with add/list/done, json storage" "brief"
test_detect "add a CI/CD pipeline"            "brief"
test_detect "build an input/output parser"    "brief"

# Back-compat: single-token unknown still falls through to unknown (PRD path)
test_detect "snake"                           "unknown"
test_detect "mytool"                          "unknown"

# Back-compat: existing inputs unchanged
test_detect "./prd.md"                        "prd"
test_detect "prd.json"                        "prd"
test_detect "requirements.txt"               "prd"
test_detect "https://github.com/o/r/issues/1" "issue"
test_detect "owner/repo#123"                  "issue"
test_detect "PROJ-456"                        "issue"
test_detect "42"                              "issue"
test_detect ""                                "empty"

# ============================================================================
# Test 2: synthesize_brief_prd writes a PRD with the brief text + markers
# ============================================================================
echo ""
echo -e "${YELLOW}=== synthesize_brief_prd() ===${NC}"

TOTAL=$((TOTAL+1))
BRIEF_OUT="/tmp/_loki_r7_brief_prd.md"
rm -f "$BRIEF_OUT"
{
    extract_func "synthesize_brief_prd"
    echo 'synthesize_brief_prd "/tmp/_loki_r7_brief_prd.md" "build a todo app"'
} > /tmp/_loki_r7_synth.sh
bash /tmp/_loki_r7_synth.sh 2>/dev/null
rm -f /tmp/_loki_r7_synth.sh
if [ -f "$BRIEF_OUT" ] \
   && grep -q "build a todo app" "$BRIEF_OUT" \
   && grep -qi "Project Brief" "$BRIEF_OUT" \
   && grep -qi "zero-config first run" "$BRIEF_OUT"; then
    log_pass "synthesize_brief_prd writes a PRD containing the brief + markers"
else
    log_fail "synthesize_brief_prd" "missing file or expected content in $BRIEF_OUT"
fi
rm -f "$BRIEF_OUT"

# ============================================================================
# Test 3: set_ttfv_lightweight_profile exports the lightweight env
# ============================================================================
echo ""
echo -e "${YELLOW}=== set_ttfv_lightweight_profile() ===${NC}"

TOTAL=$((TOTAL+1))
{
    extract_func "set_ttfv_lightweight_profile"
    echo 'set_ttfv_lightweight_profile 3'
    echo 'echo "ITER=$LOKI_MAX_ITERATIONS COMPLEXITY=$LOKI_COMPLEXITY COUNCIL=$LOKI_COUNCIL_ENABLED UAT=$LOKI_PHASE_UAT"'
} > /tmp/_loki_r7_profile.sh
profile_out=$(bash /tmp/_loki_r7_profile.sh 2>/dev/null)
rm -f /tmp/_loki_r7_profile.sh
if echo "$profile_out" | grep -q "ITER=3" \
   && echo "$profile_out" | grep -q "COMPLEXITY=simple" \
   && echo "$profile_out" | grep -q "COUNCIL=false" \
   && echo "$profile_out" | grep -q "UAT=false"; then
    log_pass "set_ttfv_lightweight_profile exports the lightweight env"
else
    log_fail "set_ttfv_lightweight_profile" "got: $profile_out"
fi

# ============================================================================
# Test 4: loki start "<brief>" enters BRIEF mode (lightweight, not PRD error)
# ============================================================================
echo ""
echo -e "${YELLOW}=== loki start \"<brief>\" enters BRIEF mode ===${NC}"

# Run inside a throwaway dir so the brief PRD lands in an isolated .loki/.
BRIEF_RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-r7-brief-XXXXXX")
TOTAL=$((TOTAL+1))
brief_out=$(cd "$BRIEF_RUN_DIR" && timeout 20 "$LOKI" start "build a todo app" \
    --provider nonexistent-provider 2>&1 || true)
# Must show the zero-config first-run framing, NOT "PRD file not found".
if echo "$brief_out" | grep -qi "Zero-config first run" \
   && ! echo "$brief_out" | grep -qi "PRD file not found"; then
    log_pass "loki start \"<brief>\" enters BRIEF mode (no PRD-not-found error)"
else
    log_fail "loki start \"<brief>\"" "unexpected output: $(echo "$brief_out" | tail -5)"
fi

# Must have written a brief PRD (distinct from generated-prd.md).
TOTAL=$((TOTAL+1))
if ls "$BRIEF_RUN_DIR"/.loki/brief-prd-*.md >/dev/null 2>&1; then
    log_pass "loki start \"<brief>\" writes a brief PRD (.loki/brief-prd-*.md)"
else
    log_fail "loki start \"<brief>\"" "no brief PRD written under .loki/"
fi

# Must NOT pollute the generated-PRD-reuse artifact.
TOTAL=$((TOTAL+1))
if [ ! -f "$BRIEF_RUN_DIR"/.loki/generated-prd.md ]; then
    log_pass "brief path does not write .loki/generated-prd.md (reuse logic safe)"
else
    log_fail "brief path" "unexpectedly wrote .loki/generated-prd.md"
fi
rm -rf "$BRIEF_RUN_DIR"

# ============================================================================
# Test 5: loki start --brief "<one word>" works (escape hatch)
# ============================================================================
echo ""
echo -e "${YELLOW}=== loki start --brief \"<word>\" escape hatch ===${NC}"

BRIEF_RUN_DIR2=$(mktemp -d "${TMPDIR:-/tmp}/loki-r7-brief2-XXXXXX")
TOTAL=$((TOTAL+1))
brief2_out=$(cd "$BRIEF_RUN_DIR2" && timeout 20 "$LOKI" start --brief "snake" \
    --provider nonexistent-provider 2>&1 || true)
if echo "$brief2_out" | grep -qi "Zero-config first run" \
   && echo "$brief2_out" | grep -qi "snake"; then
    log_pass "loki start --brief \"snake\" enters BRIEF mode"
else
    log_fail "loki start --brief" "unexpected output: $(echo "$brief2_out" | tail -5)"
fi
rm -rf "$BRIEF_RUN_DIR2"

# --brief with no value must error
TOTAL=$((TOTAL+1))
brief3_out=$(timeout 10 "$LOKI" start --brief 2>&1 || true)
if echo "$brief3_out" | grep -qi "requires a one-line description"; then
    log_pass "loki start --brief (no value) errors clearly"
else
    log_fail "loki start --brief (no value)" "expected usage error, got: $(echo "$brief3_out" | head -2)"
fi

# ============================================================================
# Test 6: no regression -- real PRD still routes to PRD mode
# ============================================================================
echo ""
echo -e "${YELLOW}=== no regression: loki start <prd.md> ===${NC}"

TEST_PRD="/tmp/loki-r7-regress-prd.md"
cat > "$TEST_PRD" << 'PRD'
# Regression PRD

A trivial PRD to confirm `loki start <.md>` still routes to PRD mode and is
NOT misclassified as a brief.
PRD

TOTAL=$((TOTAL+1))
prd_out=$(timeout 10 "$LOKI" start "$TEST_PRD" --provider nonexistent-provider 2>&1 || true)
# PRD mode must NOT show the brief framing.
if echo "$prd_out" | grep -qi "Zero-config first run"; then
    log_fail "loki start <PRD>" "PRD misclassified as brief"
else
    log_pass "loki start <PRD .md> still routes to PRD mode (not brief)"
fi
rm -f "$TEST_PRD"

# ============================================================================
# Test 7: help text documents BRIEF mode + --brief
# ============================================================================
echo ""
echo -e "${YELLOW}=== loki start --help documents BRIEF mode ===${NC}"

help_out=$("$LOKI" start --help 2>&1)
TOTAL=$((TOTAL+1))
if echo "$help_out" | grep -qi "BRIEF mode"; then
    log_pass "loki start --help describes BRIEF mode"
else
    log_fail "loki start --help" "missing BRIEF mode description"
fi
TOTAL=$((TOTAL+1))
if echo "$help_out" | grep -q -- "--brief"; then
    log_pass "loki start --help documents --brief flag"
else
    log_fail "loki start --help" "missing --brief flag"
fi

# ============================================================================
# Test 8: print_ttfv_next_steps wording matches the mode (honesty check)
# ============================================================================
echo ""
echo -e "${YELLOW}=== print_ttfv_next_steps() wording per mode ===${NC}"

RUN_SH="$REPO_ROOT/autonomy/run.sh"
extract_run_func() {
    local fn="$1"
    local start end
    start=$(grep -n "^${fn}()" "$RUN_SH" | head -1 | cut -d: -f1)
    [ -z "$start" ] && return 1
    end=$(awk -v s="$start" 'NR>s && /^}/{print NR; exit}' "$RUN_SH")
    sed -n "${start},${end}p" "$RUN_SH"
}

# brief mode: must say lightweight/council off, and must NOT advertise verdicts.
TOTAL=$((TOTAL+1))
{
    extract_run_func "print_ttfv_next_steps"
    echo 'print_ttfv_next_steps "brief" 0'
} > /tmp/_loki_r7_msg.sh
brief_msg=$(TARGET_DIR=/tmp/_nonexistent_r7 bash /tmp/_loki_r7_msg.sh 2>/dev/null)
rm -f /tmp/_loki_r7_msg.sh
if echo "$brief_msg" | grep -qi "lightweight first" \
   && echo "$brief_msg" | grep -qi "council off" \
   && ! echo "$brief_msg" | grep -qi "council verdicts"; then
    log_pass "brief message: lightweight + council off, does NOT claim verdicts"
else
    log_fail "print_ttfv_next_steps brief" "wrong wording: $(echo "$brief_msg" | grep -i 'what i did' -A3)"
fi

# repo mode: must say full depth + council on, and MUST NOT claim a brief.
TOTAL=$((TOTAL+1))
{
    extract_run_func "print_ttfv_next_steps"
    echo 'print_ttfv_next_steps "repo" 0'
} > /tmp/_loki_r7_msg.sh
repo_msg=$(TARGET_DIR=/tmp/_nonexistent_r7 bash /tmp/_loki_r7_msg.sh 2>/dev/null)
rm -f /tmp/_loki_r7_msg.sh
if echo "$repo_msg" | grep -qi "full" \
   && echo "$repo_msg" | grep -qi "council on" \
   && ! echo "$repo_msg" | grep -qi "from your one-line brief" \
   && ! echo "$repo_msg" | grep -qi "council off"; then
    log_pass "repo message: full depth + council on, does NOT claim a brief pass"
else
    log_fail "print_ttfv_next_steps repo" "wrong wording: $(echo "$repo_msg" | grep -i 'what i did' -A3)"
fi

# both modes point at the proof artifact.
TOTAL=$((TOTAL+1))
if echo "$brief_msg" | grep -qi "loki proof" && echo "$repo_msg" | grep -qi "loki proof"; then
    log_pass "both messages point at the proof-of-run artifact"
else
    log_fail "print_ttfv_next_steps" "missing 'loki proof' pointer in one mode"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "===================================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (of $TOTAL)"
echo "===================================================="

rm -f /tmp/_loki_r7_*.sh /tmp/_loki_r7_brief_prd.md /tmp/loki-r7-regress-prd.md 2>/dev/null

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
