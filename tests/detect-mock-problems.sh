#!/usr/bin/env bash
# Mock Detector - Quality Gate #8
# Scans test files for problematic mock patterns that mask real failures
#
# Usage: ./tests/detect-mock-problems.sh [--strict]
#   --strict: Exit with error code on any finding (for CI)
#
# Detects:
# 1. Tests that define inline functions and test them instead of importing real code
# 2. Tautological assertions (assert on literal values)
# 3. Conditional assertions that silently pass (if guards around expects)
# 4. Empty test bodies
# 5. Tests with no imports from source code
# 6. Internal mock ratio: mocks of own code vs external service mocks

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find here,
# so `cd TARGET_DIR` alone does not redirect the scan.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STRICT="${1:-}"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

CRITICAL=0
HIGH=0
MEDIUM=0
LOW=0

echo "=========================================="
echo "Mock Detector - Quality Gate #8"
echo "=========================================="
echo ""

report() {
    local severity="$1"
    local file="$2"
    local line="$3"
    local message="$4"

    case "$severity" in
        CRITICAL) echo -e "${RED}[CRITICAL]${NC} $file:$line - $message"; ((CRITICAL++)) ;;
        HIGH)     echo -e "${RED}[HIGH]${NC}     $file:$line - $message"; ((HIGH++)) ;;
        MEDIUM)   echo -e "${YELLOW}[MEDIUM]${NC}   $file:$line - $message"; ((MEDIUM++)) ;;
        LOW)      echo -e "${CYAN}[LOW]${NC}      $file:$line - $message"; ((LOW++)) ;;
    esac
}

# Pattern 1: TypeScript/JavaScript tests that never import from source
# (excludes E2E/spec files which interact via browser, not imports)
echo -e "${CYAN}Scanning for tests that never import real code...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    # Check if any import references source code (not just assert/test libs)
    has_source_import=false
    if grep -qE "^import.*from ['\"]\.\./" "$test_file" 2>/dev/null; then
        has_source_import=true
    fi
    if grep -qE "require\(['\"]\.\./" "$test_file" 2>/dev/null; then
        has_source_import=true
    fi

    if [ "$has_source_import" = false ]; then
        # Count actual test cases
        test_count=$(grep -cE '(it\(|test\(|describe\()' "$test_file" 2>/dev/null || echo "0")
        if [ "$test_count" -gt 0 ]; then
            report "CRITICAL" "$rel_path" "1" "Test file has $test_count test(s) but never imports source code -- tests only test inline mocks"
        fi
    fi
done < <(find "$PROJECT_DIR" \( -name "*.test.ts" -o -name "*.test.js" \) 2>/dev/null | grep -v node_modules | grep -v dist | grep -v e2e)

# Pattern 2: Tautological assertions on literals
echo -e "${CYAN}Scanning for tautological assertions...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    # assert.ok('string'.includes('string')) -- always true
    while IFS=: read -r lineno line; do
        report "HIGH" "$rel_path" "$lineno" "Tautological assertion on literal string"
    done < <(grep -nE "assert\.(ok|strictEqual|equal)\(['\"].*['\"]\.includes\(['\"]" "$test_file" 2>/dev/null)

    # expect(true).toBe(true), expect(false).toBe(false), expect(1).toBe(1)
    while IFS=: read -r lineno line; do
        report "HIGH" "$rel_path" "$lineno" "Tautological assertion: expect(literal).toBe(same literal)"
    done < <(grep -nE "expect\(true\)\.toBe\(true\)|expect\(false\)\.toBe\(false\)|expect\([0-9]+\)\.toBe\([0-9]+\)" "$test_file" 2>/dev/null)

    # assert.ok(true), assert.ok(1)
    while IFS=: read -r lineno line; do
        report "HIGH" "$rel_path" "$lineno" "Tautological assertion: assert.ok(true) always passes"
    done < <(grep -nE "assert\.ok\((true|1)\)" "$test_file" 2>/dev/null)

done < <(find "$PROJECT_DIR" -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" -o -name "test_*.py" 2>/dev/null | grep -v node_modules | grep -v dist)

# Pattern 3: Conditional assertions (if guards that silently skip)
echo -e "${CYAN}Scanning for conditional assertions...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    while IFS=: read -r lineno line; do
        report "MEDIUM" "$rel_path" "$lineno" "Conditional assertion: expect/assert inside if-guard may silently pass"
    done < <(grep -nE "if\s*\(.*\)\s*\{?\s*$" "$test_file" 2>/dev/null | while IFS=: read -r ln _; do
        # Check if next few lines have assert/expect
        next_lines=$(sed -n "$((ln+1)),$((ln+3))p" "$test_file" 2>/dev/null)
        if echo "$next_lines" | grep -qE "(assert\.|expect\()"; then
            echo "$ln:conditional"
        fi
    done)

done < <(find "$PROJECT_DIR" -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" 2>/dev/null | grep -v node_modules | grep -v dist)

# Pattern 4: Empty test bodies
echo -e "${CYAN}Scanning for empty test bodies...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    # it('name', () => {}) or test('name', () => {})
    while IFS=: read -r lineno line; do
        report "MEDIUM" "$rel_path" "$lineno" "Empty test body -- test does nothing"
    done < <(grep -nE "(it|test)\(['\"].*['\"],\s*(\(\)|function\s*\(\))\s*\{?\s*\}?\s*\);" "$test_file" 2>/dev/null)

done < <(find "$PROJECT_DIR" -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" 2>/dev/null | grep -v node_modules | grep -v dist)

# Pattern 5: Skipped tests
echo -e "${CYAN}Scanning for skipped tests...${NC}"
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    while IFS=: read -r lineno line; do
        report "LOW" "$rel_path" "$lineno" "Skipped test: $line"
    done < <(grep -nE "(xit|xtest|xdescribe|\.skip)\(" "$test_file" 2>/dev/null | head -5)

done < <(find "$PROJECT_DIR" -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" -o -name "test_*.py" 2>/dev/null | grep -v node_modules | grep -v dist)

# Pattern 6: Internal vs External mock classification
# Internal mocks (mocking your own code) are problematic -- you're hiding bugs
# External mocks (mocking HTTP, DB, filesystem, APIs) are expected
echo -e "${CYAN}Scanning for internal mock ratio...${NC}"

# Mock patterns for external services (acceptable)
EXTERNAL_MOCK_PATTERN='(fetch|axios|http|request|database|db\.|redis|pg\.|mysql|mongo|s3|aws|gcp|azure|stripe|twilio|sendgrid|smtp|mailer|fs\.|readFile|writeFile|unlink|mkdir|createServer|listen|connect|socket)'
# Mock patterns for internal code (problematic if excessive)
INTERNAL_MOCK_PATTERN='(jest\.fn|sinon\.stub|sinon\.spy|vi\.fn|mock\(\)|spyOn|jest\.spyOn|stub\()'

while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    total_mocks=$(grep -cE "$INTERNAL_MOCK_PATTERN" "$test_file" 2>/dev/null || true)
    total_mocks="${total_mocks:-0}"
    total_mocks=$(echo "$total_mocks" | tr -d '[:space:]')
    external_mocks=$(grep -cE "$EXTERNAL_MOCK_PATTERN" "$test_file" 2>/dev/null || true)
    external_mocks="${external_mocks:-0}"
    external_mocks=$(echo "$external_mocks" | tr -d '[:space:]')

    # Internal mock count = total mocks minus those near external patterns
    # Simple heuristic: if file has many mocks but few external references, it's over-mocking
    if [ "$total_mocks" -gt 5 ] && [ "$external_mocks" -eq 0 ]; then
        report "HIGH" "$rel_path" "1" "High internal mock ratio: $total_mocks mocks with 0 external service references -- likely mocking own code"
    elif [ "$total_mocks" -gt 10 ] && [ "$external_mocks" -lt 3 ]; then
        report "MEDIUM" "$rel_path" "1" "Elevated internal mock ratio: $total_mocks mocks, only $external_mocks external refs -- review mock targets"
    fi
done < <(find "$PROJECT_DIR" \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" \) 2>/dev/null | grep -v node_modules | grep -v dist)

# Summary
echo ""
echo "=========================================="
TOTAL=$((CRITICAL + HIGH + MEDIUM + LOW))
echo "Results: $TOTAL finding(s)"
echo "  CRITICAL: $CRITICAL"
echo "  HIGH:     $HIGH"
echo "  MEDIUM:   $MEDIUM"
echo "  LOW:      $LOW"
echo "=========================================="

if [ "$STRICT" = "--strict" ]; then
    if [ $CRITICAL -gt 0 ] || [ $HIGH -gt 0 ]; then
        echo ""
        echo -e "${RED}GATE FAILED: $CRITICAL critical + $HIGH high findings${NC}"
        exit 1
    fi
fi

if [ $TOTAL -eq 0 ]; then
    echo -e "${GREEN}All tests pass mock quality gate.${NC}"
fi

exit 0
