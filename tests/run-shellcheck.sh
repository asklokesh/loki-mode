#!/usr/bin/env bash
# Test: ShellCheck Linting
# Runs shellcheck on all .sh files in the project
# Only fails on errors and warnings - info/style issues are reported but don't fail

set -uo pipefail

PASSED=0
FAILED=0
SKIPPED=0
INFO_ONLY=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_info() { echo -e "${CYAN}[INFO]${NC} $1"; ((INFO_ONLY++)); }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; ((SKIPPED++)); }

echo "========================================"
echo "Loki Mode ShellCheck Linter"
echo "========================================"
echo ""

if ! command -v shellcheck &> /dev/null; then
    log_skip "ShellCheck not found. Skipping linting."
    echo "Install with: brew install shellcheck"
    exit 0
fi

# Global exclusions:
# SC1090: Can't follow non-constant source
# SC1091: Not following (source file not found)
GLOBAL_EXCLUDES="SC1090,SC1091"

# Provider config files - these are sourced by other scripts
# Variables are intentionally unused within the file itself
PROVIDER_EXCLUDES="SC2034"

# Test files - variables are set as environment for sourced functions
# SC2034: unused vars are env vars for sourced functions
TEST_EXCLUDES="SC2034"

# Find all .sh files
# Exclude node_modules, .git, .loki, and venv directories
# shellcheck disable=SC2086
FILES=$(find . -name "*.sh" \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*/.claude/worktrees/*" \
    -not -path "*/.loki/*" \
    -not -path "*/venv/*")

for file in $FILES; do
    # Determine exclusions based on file type
    local_excludes="$GLOBAL_EXCLUDES"
    if [[ "$file" == ./providers/*.sh ]]; then
        local_excludes="${GLOBAL_EXCLUDES},${PROVIDER_EXCLUDES}"
    fi
    if [[ "$file" == ./tests/*.sh ]]; then
        local_excludes="${local_excludes},${TEST_EXCLUDES}"
    fi

    # Run shellcheck with severity=warning (ignores info/style)
    # This means only errors and warnings will cause failure
    output=$(shellcheck -S warning -e "$local_excludes" "$file" 2>&1)
    exit_code=$?

    if [ $exit_code -eq 0 ]; then
        # Check if there are any info-level issues (run again without severity filter)
        info_output=$(shellcheck -e "$local_excludes" "$file" 2>&1)
        if [ -n "$info_output" ]; then
            log_info "$file (info-level suggestions exist)"
        else
            log_pass "Checked $file"
        fi
    else
        echo "$output"
        log_fail "Issues found in $file"
    fi
done

echo ""
echo "========================================"
echo "Linting Summary"
echo "========================================"
echo -e "${GREEN}Passed:    $PASSED${NC}"
echo -e "${RED}Failed:    $FAILED${NC}"
echo -e "${CYAN}Info-only: $INFO_ONLY${NC} (suggestions, not blocking)"
echo -e "${YELLOW}Skipped:   $SKIPPED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}All scripts passed linting (errors/warnings)!${NC}"
    if [ "$INFO_ONLY" -gt 0 ]; then
        echo -e "${CYAN}Note: $INFO_ONLY files have info-level suggestions.${NC}"
    fi
    exit 0
else
    echo -e "${RED}Some scripts have errors or warnings!${NC}"
    exit 1
fi
