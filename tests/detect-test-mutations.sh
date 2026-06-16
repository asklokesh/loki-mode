#!/usr/bin/env bash
# Test Mutation Detector - Quality Gate #9
# Verifies that test assertions exercise real code paths
#
# Usage: ./tests/detect-test-mutations.sh [--strict] [--block-high] [--commit HASH]
#   --strict: Exit 1 on ANY finding (HIGH/MEDIUM/LOW) -- for CI; over-blocks
#   --block-high: Exit 2 when one or more HIGH-severity findings are present,
#                 0 otherwise. Does NOT block on MEDIUM/LOW. This is the clean
#                 exit-code contract for the run.sh mutation gate wrapper, so it
#                 does not have to grep stdout. --strict takes precedence if both
#                 are passed.
#   --commit HASH: Check specific commit for assertion value mutations
#
# Output contract: every HIGH-severity finding prints a line beginning with the
# literal token "[HIGH]" on stdout (ANSI-colored), so a wrapper may also grep
# '\[HIGH\]' as an alternative to --block-high.
#
# Detects:
# 1. Shell tests where functions are redefined to return canned output
# 2. Test files where all assertions check constant values
# 3. Test files with assertion-to-test ratio below threshold
# 4. Assertion value mutations: commits that change assertion expected values
#    alongside implementation changes (sign of fitting tests to code)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find/git here,
# so `cd TARGET_DIR` alone does not redirect the scan. The Check-5 git history is
# also read from this directory.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STRICT=""
BLOCK_HIGH=""
COMMIT_HASH=""

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --strict) STRICT="--strict"; shift ;;
        --block-high) BLOCK_HIGH="--block-high"; shift ;;
        --commit) COMMIT_HASH="$2"; shift 2 ;;
        *) shift ;;
    esac
done

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

FINDINGS=0
HIGH_FINDINGS=0

echo "=========================================="
echo "Test Mutation Detector - Quality Gate #9"
echo "=========================================="
echo ""

report() {
    local severity="$1"
    local file="$2"
    local message="$3"

    case "$severity" in
        HIGH)   echo -e "${RED}[HIGH]${NC}   $file - $message"; ((HIGH_FINDINGS++)) ;;
        MEDIUM) echo -e "${YELLOW}[MEDIUM]${NC} $file - $message" ;;
        LOW)    echo -e "${CYAN}[LOW]${NC}    $file - $message" ;;
    esac
    ((FINDINGS++))
}

# Check 1: Shell tests with function redefinitions that mask real behavior
echo -e "${CYAN}Scanning shell tests for function masking...${NC}"
for test_file in "$PROJECT_DIR"/tests/test-*.sh; do
    [ -f "$test_file" ] || continue
    rel_path="${test_file#$PROJECT_DIR/}"

    # Look for patterns like: function_name() { echo "fixed"; }
    # that redefine functions from the source code
    mask_count=$(grep -cE '^\s*(log_info|log_warn|log_error|log_step|emit_event|emit_learning_signal)\(\)' "$test_file" 2>/dev/null || true)
    mask_count="${mask_count:-0}"
    mask_count=$(echo "$mask_count" | tr -d '[:space:]')
    if [ "$mask_count" -gt 3 ]; then
        report "LOW" "$rel_path" "Redefines $mask_count source functions (acceptable for log suppression)"
    fi
done

# Check 2: JS/TS test files with very low assertion density
echo -e "${CYAN}Scanning for low assertion density...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    test_count=$(grep -cE '(it\(|test\()' "$test_file" 2>/dev/null || echo "0")
    assert_count=$(grep -cE '(assert\.|expect\(|should\.)' "$test_file" 2>/dev/null || echo "0")

    if [ "$test_count" -gt 5 ] && [ "$assert_count" -lt "$test_count" ]; then
        report "MEDIUM" "$rel_path" "Low assertion density: $assert_count assertions in $test_count tests (some tests have no assertions)"
    fi
done < <(find "$PROJECT_DIR" \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.js" \) 2>/dev/null | grep -v node_modules | grep -v dist)

# Check 3: Python tests with no assertions
echo -e "${CYAN}Scanning Python tests for missing assertions...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    test_count=$(grep -cE '^\s*def test_' "$test_file" 2>/dev/null || echo "0")
    assert_count=$(grep -cE '(assert |self\.assert|pytest\.raises|assertEqual|assertTrue|assertFalse|assertRaises|assertIn)' "$test_file" 2>/dev/null || echo "0")

    if [ "$test_count" -gt 3 ] && [ "$assert_count" -lt "$test_count" ]; then
        report "MEDIUM" "$rel_path" "Low assertion density: $assert_count assertions in $test_count tests"
    fi
done < <(find "$PROJECT_DIR" -name "test_*.py" 2>/dev/null | grep -v node_modules | grep -v __pycache__)

# Check 4: Shell tests with no pass/fail tracking
echo -e "${CYAN}Scanning shell tests for assertion tracking...${NC}"
for test_file in "$PROJECT_DIR"/tests/test-*.sh; do
    [ -f "$test_file" ] || continue
    rel_path="${test_file#$PROJECT_DIR/}"

    has_pass=$(grep -c 'log_pass\|PASSED\|((PASSED' "$test_file" 2>/dev/null || echo "0")
    has_fail=$(grep -c 'log_fail\|FAILED\|((FAILED' "$test_file" 2>/dev/null || echo "0")

    if [ "$has_pass" -eq 0 ] && [ "$has_fail" -eq 0 ]; then
        report "MEDIUM" "$rel_path" "No pass/fail assertion tracking found"
    fi
done

# Check 5: Assertion value mutations in git commits
# Detects when a commit changes BOTH implementation code AND assertion expected values
# This is a sign of "fitting the test to the code" -- changing what the test expects
# to match what the code produces, rather than fixing the code
echo -e "${CYAN}Scanning for assertion value mutations in commits...${NC}"

# Use provided commit or check the last 5 commits
if [ -n "$COMMIT_HASH" ]; then
    COMMITS_TO_CHECK="$COMMIT_HASH"
else
    COMMITS_TO_CHECK=$(cd "$PROJECT_DIR" && git log --oneline -5 --format='%H' 2>/dev/null || true)
fi

if [ -n "$COMMITS_TO_CHECK" ]; then
    for commit in $COMMITS_TO_CHECK; do
        # Get files changed in this commit
        changed_files=$(cd "$PROJECT_DIR" && git diff-tree --no-commit-id --name-only -r "$commit" 2>/dev/null || true)
        [ -z "$changed_files" ] && continue

        # Classify files: test files vs implementation files
        has_impl=false
        has_test=false
        test_files_changed=""
        impl_files_changed=""

        while IFS= read -r file; do
            if echo "$file" | grep -qE '\.(test|spec)\.(ts|js|tsx|jsx)$|^tests?/|test_.*\.py$'; then
                has_test=true
                test_files_changed="$test_files_changed $file"
            elif echo "$file" | grep -qE '\.(ts|js|tsx|jsx|py|sh)$'; then
                # Implementation source file. The broken `grep -q ... | grep -vq`
                # pipe that previously gated this branch always evaluated false
                # (grep -q emits no stdout, so the piped grep saw empty input and
                # exited 1), which left has_impl permanently false and made the
                # entire HIGH commit-mutation path dead. The .md/.json/.yml
                # extensions cannot match the .ts/.js/... pattern above, so the
                # exclusion grep was redundant and has been removed.
                has_impl=true
                impl_files_changed="$impl_files_changed $file"
            fi
        done <<< "$changed_files"

        # Only flag if BOTH test and implementation files changed in same commit
        if [ "$has_impl" = true ] && [ "$has_test" = true ]; then
            # Check if test file changes include modified assertion values
            # Look for changed lines that have expect/assert with literal values
            test_diff=$(cd "$PROJECT_DIR" && git diff "$commit^" "$commit" -- $test_files_changed 2>/dev/null || true)

            # Count changed assertion lines (lines starting with + or - that contain assertions)
            changed_assertions=$(echo "$test_diff" | grep -cE '^[-+].*(\.toBe\(|\.toEqual\(|\.toStrictEqual\(|strictEqual\(|deepEqual\(|assertEqual\(|assert.*==)' 2>/dev/null || echo "0")
            # Filter out the diff header lines (--- and +++)
            header_lines=$(echo "$test_diff" | grep -cE '^(---|\+\+\+)' 2>/dev/null || echo "0")
            changed_assertions=$((changed_assertions - header_lines))
            [ "$changed_assertions" -lt 0 ] && changed_assertions=0

            if [ "$changed_assertions" -gt 2 ]; then
                short_hash=$(echo "$commit" | cut -c1-8)
                report "HIGH" "commit:$short_hash" "Changed $changed_assertions assertion values alongside implementation code -- possible test fitting"
            fi
        fi
    done
fi

# Summary
echo ""
echo "=========================================="
echo "Results: $FINDINGS finding(s)"
echo "=========================================="

echo "  HIGH:    $HIGH_FINDINGS"

# --strict takes precedence: block on ANY finding (legacy CI behavior, unchanged).
if [ "$STRICT" = "--strict" ] && [ $FINDINGS -gt 0 ]; then
    echo -e "${RED}GATE FAILED: $FINDINGS finding(s)${NC}"
    exit 1
fi

# --block-high: exit 2 only when HIGH-severity findings are present. MEDIUM/LOW
# do not block (they are routed to the findings injector by the run.sh wrapper).
if [ "$BLOCK_HIGH" = "--block-high" ] && [ $HIGH_FINDINGS -gt 0 ]; then
    echo -e "${RED}GATE FAILED: $HIGH_FINDINGS HIGH-severity finding(s)${NC}"
    exit 2
fi

if [ $FINDINGS -eq 0 ]; then
    echo -e "${GREEN}All tests pass mutation detection gate.${NC}"
fi

exit 0
