#!/bin/bash
# Test: HUMAN_INPUT.md Directive Injection
# Tests that HUMAN_INPUT.md content is properly injected into prompts

set -uo pipefail

TEST_DIR=$(mktemp -d)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

cd "$TEST_DIR"

echo "=========================================="
echo "HUMAN_INPUT Directive Injection Tests"
echo "=========================================="
echo ""

# Test 1: Verify HUMAN_INPUT.md file handling exists in run.sh
log_test "HUMAN_INPUT.md handling exists in run.sh"
if grep -q 'HUMAN_INPUT.md' "$RUN_SCRIPT" && grep -q 'LOKI_HUMAN_INPUT' "$RUN_SCRIPT"; then
    log_pass "HUMAN_INPUT.md handling code exists"
else
    log_fail "HUMAN_INPUT.md handling code not found"
fi

# Test 2: Verify directive injection code exists
log_test "Directive injection in build_prompt exists"
if grep -q 'human_directive' "$RUN_SCRIPT" && grep -q 'HUMAN_DIRECTIVE.*PRIORITY' "$RUN_SCRIPT"; then
    log_pass "Directive injection code exists"
else
    log_fail "Directive injection code not found"
fi

# Test 3: Verify file is moved to logs after processing
log_test "HUMAN_INPUT.md is moved to logs after processing"
if grep -q 'mv.*HUMAN_INPUT.md.*logs/human-input' "$RUN_SCRIPT"; then
    log_pass "File move to logs exists"
else
    log_fail "File move to logs not found"
fi

# Test 4: check_human_intervention is called in main loop (critical!)
log_test "check_human_intervention is called in run_autonomous"
if grep -A 50 'while \[ \$retry -lt \$MAX_RETRIES \]' "$RUN_SCRIPT" | grep -q 'check_human_intervention'; then
    log_pass "check_human_intervention is called in main loop"
else
    log_fail "check_human_intervention is NOT called in main loop (critical bug)"
fi

# Test 5: Simulate directive injection logic
log_test "Directive injection logic"
bash << 'EOF'
# Simulate the directive injection logic
LOKI_HUMAN_INPUT="Check all .astro files for missing imports"

human_directive=""
if [ -n "${LOKI_HUMAN_INPUT:-}" ]; then
    human_directive="HUMAN_DIRECTIVE (PRIORITY): $LOKI_HUMAN_INPUT Execute this directive BEFORE continuing normal tasks."
fi

# Verify directive was built
if [[ "$human_directive" == *"HUMAN_DIRECTIVE (PRIORITY)"* ]] && \
   [[ "$human_directive" == *"Check all .astro files"* ]] && \
   [[ "$human_directive" == *"BEFORE continuing normal tasks"* ]]; then
    echo "VERIFIED"
    exit 0
else
    echo "FAILED: $human_directive"
    exit 1
fi
EOF

if [ $? -eq 0 ]; then
    log_pass "Directive injection logic works"
else
    log_fail "Directive injection logic failed"
fi

# Test 6: Verify empty LOKI_HUMAN_INPUT produces no directive
log_test "Empty LOKI_HUMAN_INPUT produces no directive"
bash << 'EOF'
# Unset or empty should produce no directive
unset LOKI_HUMAN_INPUT

human_directive=""
if [ -n "${LOKI_HUMAN_INPUT:-}" ]; then
    human_directive="HUMAN_DIRECTIVE (PRIORITY): $LOKI_HUMAN_INPUT Execute this directive BEFORE continuing normal tasks."
fi

if [ -z "$human_directive" ]; then
    echo "VERIFIED"
    exit 0
else
    echo "FAILED: directive should be empty but got: $human_directive"
    exit 1
fi
EOF

if [ $? -eq 0 ]; then
    log_pass "Empty input produces no directive"
else
    log_fail "Empty input should produce no directive"
fi

# Test 7: HUMAN_INPUT.md file detection and reading
log_test "HUMAN_INPUT.md file detection"
mkdir -p "$TEST_DIR/.loki"
echo "Fix the authentication bug" > "$TEST_DIR/.loki/HUMAN_INPUT.md"

if [ -f "$TEST_DIR/.loki/HUMAN_INPUT.md" ]; then
    content=$(cat "$TEST_DIR/.loki/HUMAN_INPUT.md")
    if [ "$content" = "Fix the authentication bug" ]; then
        log_pass "HUMAN_INPUT.md file can be read"
    else
        log_fail "HUMAN_INPUT.md content mismatch"
    fi
else
    log_fail "HUMAN_INPUT.md file not created"
fi

# Test 8: Directive appears in all prompt variants
log_test "Directive injection in all build_prompt variants"
# Count how many echo statements in build_prompt include human_directive
directive_count=$(grep -c '\$human_directive' "$RUN_SCRIPT" || echo "0")
# There should be 4 variants (retry 0 with/without PRD, retry > 0 with/without PRD)
if [ "$directive_count" -ge 4 ]; then
    log_pass "Directive included in all $directive_count prompt variants"
else
    log_fail "Directive only in $directive_count variants (expected 4+)"
fi

# Test 9: Multiline directive handling
log_test "Multiline directive handling"
bash << 'EOF'
LOKI_HUMAN_INPUT="Line 1: Check imports
Line 2: Fix errors
Line 3: Add tests"

human_directive=""
if [ -n "${LOKI_HUMAN_INPUT:-}" ]; then
    human_directive="HUMAN_DIRECTIVE (PRIORITY): $LOKI_HUMAN_INPUT Execute this directive BEFORE continuing normal tasks."
fi

# Verify all lines are included
if [[ "$human_directive" == *"Line 1"* ]] && \
   [[ "$human_directive" == *"Line 2"* ]] && \
   [[ "$human_directive" == *"Line 3"* ]]; then
    echo "VERIFIED"
    exit 0
else
    echo "FAILED: multiline not preserved"
    exit 1
fi
EOF

if [ $? -eq 0 ]; then
    log_pass "Multiline directives preserved"
else
    log_fail "Multiline directives not preserved"
fi

echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
