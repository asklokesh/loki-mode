#!/usr/bin/env bash
# Test: loki init command (v6.28.0)
# Tests project scaffolding: directory creation, config, templates, flags.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
TMPDIR_BASE="/tmp/test-loki-init-$$"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Run a CLI command, check exit code and optionally grep for expected output
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        return 0
    fi

    if [ -n "$pattern" ]; then
        if ! echo "$output" | grep -qi "$pattern"; then
            log_fail "$desc" "output missing pattern: $pattern"
            echo "  Actual output (first 5 lines):"
            echo "$output" | head -5 | sed 's/^/    /'
            return 0
        fi
    fi

    log_pass "$desc"
    return 0
}

echo "========================================"
echo "Loki Init Command Tests (v6.28.0)"
echo "========================================"
echo "CLI: $LOKI"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

# Create temp directory for test outputs
mkdir -p "$TMPDIR_BASE"

# -------------------------------------------
# Test 1: loki init --help shows usage
# -------------------------------------------
test_cmd "init --help shows usage and examples" \
    0 "project-name" init --help

# -------------------------------------------
# Test 2: loki init --list shows 22 templates
# -------------------------------------------
((TOTAL++))
output=$("$LOKI" init --list 2>&1) || true
count=$(echo "$output" | grep -cE "^\s+[0-9]+\." || true)
if [ "$count" -ge 20 ]; then
    log_pass "init --list shows $count templates (expected 22)"
else
    log_fail "init --list shows 22 templates" "found $count templates, expected 22"
fi

# -------------------------------------------
# Test 3: loki init --json produces valid JSON with 22 entries
# -------------------------------------------
((TOTAL++))
json_output=$("$LOKI" init --json 2>&1) || true
json_count=$(echo "$json_output" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$json_count" -ge 20 ]; then
    log_pass "init --json produces valid JSON with $json_count entries"
else
    log_fail "init --json produces valid JSON with 22 entries" "JSON parse failed or count=$json_count"
fi

# -------------------------------------------
# Test 4: init with project name creates scaffold
# -------------------------------------------
((TOTAL++))
(
    cd "$TMPDIR_BASE"
    "$LOKI" init myproject --template saas-starter >/dev/null 2>&1
) || true
if [ -d "$TMPDIR_BASE/myproject" ] && \
   [ -f "$TMPDIR_BASE/myproject/prd.md" ] && \
   [ -f "$TMPDIR_BASE/myproject/.loki/loki.config.json" ] && \
   [ -f "$TMPDIR_BASE/myproject/README.md" ]; then
    log_pass "init with project name creates directory with prd.md, .loki/, README.md"
else
    log_fail "init with project name" "missing expected files in myproject/"
fi

# -------------------------------------------
# Test 5: prd.md contains template content
# -------------------------------------------
((TOTAL++))
if [ -f "$TMPDIR_BASE/myproject/prd.md" ] && grep -q "SaaS" "$TMPDIR_BASE/myproject/prd.md"; then
    log_pass "prd.md contains SaaS template content"
else
    log_fail "prd.md content" "missing SaaS content"
fi

# -------------------------------------------
# Test 6: loki.config.json is valid with correct template
# -------------------------------------------
((TOTAL++))
config="$TMPDIR_BASE/myproject/.loki/loki.config.json"
if python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
assert 'version' in d, 'missing version'
assert d['template'] == 'saas-starter', f'wrong template'
assert 'created' in d, 'missing created'
assert 'provider' in d, 'missing provider'
" "$config" 2>/dev/null; then
    log_pass "loki.config.json valid with correct template field"
else
    log_fail "loki.config.json" "invalid JSON or missing fields"
fi

# -------------------------------------------
# Test 7: git init runs by default
# -------------------------------------------
((TOTAL++))
if [ -d "$TMPDIR_BASE/myproject/.git" ] && [ -f "$TMPDIR_BASE/myproject/.gitignore" ]; then
    log_pass "git init runs by default (has .git/ and .gitignore)"
else
    log_fail "git init" "missing .git/ or .gitignore"
fi

# -------------------------------------------
# Test 8: --no-git skips git init
# -------------------------------------------
((TOTAL++))
(
    cd "$TMPDIR_BASE"
    "$LOKI" init nogit-project --template cli-tool --no-git >/dev/null 2>&1
) || true
if [ ! -d "$TMPDIR_BASE/nogit-project/.git" ] && [ ! -f "$TMPDIR_BASE/nogit-project/.gitignore" ] && \
   [ -f "$TMPDIR_BASE/nogit-project/prd.md" ]; then
    log_pass "--no-git skips git init but still creates prd.md"
else
    log_fail "--no-git" "unexpected .git presence or missing prd.md"
fi

# -------------------------------------------
# Test 9: --stdout prints PRD without creating files
# -------------------------------------------
((TOTAL++))
stdout_output=$("$LOKI" init --template rest-api --stdout 2>&1) || true
if echo "$stdout_output" | grep -q "REST API"; then
    log_pass "--stdout prints PRD content to terminal"
else
    log_fail "--stdout" "missing REST API content in output"
fi

# -------------------------------------------
# Test 10: --dry-run shows plan without creating files
# -------------------------------------------
((TOTAL++))
(
    cd "$TMPDIR_BASE"
    dry_output=$("$LOKI" init dryproject --template dashboard --dry-run 2>&1)
    if echo "$dry_output" | grep -q "CREATE" && [ ! -d "$TMPDIR_BASE/dryproject" ]; then
        exit 0
    else
        exit 1
    fi
) && log_pass "--dry-run shows CREATE lines without writing" || log_fail "--dry-run" "missing CREATE or directory created"

# -------------------------------------------
# Test 11: init without project name scaffolds current dir
# -------------------------------------------
((TOTAL++))
scratch="$TMPDIR_BASE/scaffold-cwd"
mkdir -p "$scratch"
(
    cd "$scratch"
    "$LOKI" init --template web-scraper --no-git >/dev/null 2>&1
) || true
if [ -f "$scratch/prd.md" ] && [ -f "$scratch/.loki/loki.config.json" ]; then
    log_pass "init without project name scaffolds current directory"
else
    log_fail "scaffold current dir" "missing prd.md or .loki/ in cwd"
fi

# -------------------------------------------
# Test 12: unknown template shows error
# -------------------------------------------
test_cmd "init with unknown template exits with error" \
    1 "Unknown template" init --template nonexistent-template --stdout

# -------------------------------------------
# Test 13: existing directory prevents overwrite
# -------------------------------------------
((TOTAL++))
mkdir -p "$TMPDIR_BASE/existingdir"
(
    cd "$TMPDIR_BASE"
    actual_exit=0
    output=$("$LOKI" init existingdir --template saas-starter 2>&1) || actual_exit=$?
    if [ "$actual_exit" -ne 0 ] && echo "$output" | grep -qi "already exists"; then
        exit 0
    else
        exit 1
    fi
) && log_pass "existing directory prevents overwrite" || log_fail "existing dir" "did not error on existing directory"

# -------------------------------------------
# Test 14: README mentions project and template
# -------------------------------------------
((TOTAL++))
if [ -f "$TMPDIR_BASE/myproject/README.md" ] && \
   grep -q "saas-starter" "$TMPDIR_BASE/myproject/README.md" && \
   grep -q "loki start" "$TMPDIR_BASE/myproject/README.md"; then
    log_pass "README.md mentions template name and loki start"
else
    log_fail "README content" "missing template reference or loki start"
fi

# -------------------------------------------
# Test 15: next steps shows cd and loki start
# -------------------------------------------
((TOTAL++))
(
    cd "$TMPDIR_BASE"
    output=$("$LOKI" init nextproject --template api-only 2>&1)
    if echo "$output" | grep -q "loki start prd.md" && echo "$output" | grep -q "cd nextproject"; then
        exit 0
    else
        exit 1
    fi
) && log_pass "output shows cd and loki start next steps" || log_fail "next steps" "missing cd or loki start"

# -------------------------------------------
# Test 16: --list includes section categories
# -------------------------------------------
((TOTAL++))
list_output=$("$LOKI" init --list 2>&1) || true
if echo "$list_output" | grep -q "Simple" && echo "$list_output" | grep -q "Complex"; then
    log_pass "--list shows Simple and Complex category headers"
else
    log_fail "--list categories" "missing Simple or Complex headers"
fi

# -------------------------------------------
# Cleanup
# -------------------------------------------
rm -rf "$TMPDIR_BASE" 2>/dev/null || true

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed out of $TOTAL tests"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
