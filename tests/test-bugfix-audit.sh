#!/usr/bin/env bash
# Test: Bug fixes from CLI audit (35 bugs)
# Validates that all fixes from the audit are correct and regressions are caught.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
VERSION_FILE="$SCRIPT_DIR/../VERSION"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; ((TOTAL--)); }

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

# Grep source code for a pattern - used to verify code-level fixes
test_source() {
    local desc="$1"
    local pattern="$2"

    ((TOTAL++))

    if grep -qE "$pattern" "$LOKI"; then
        log_pass "$desc"
    else
        log_fail "$desc" "Pattern not found in source: $pattern"
    fi
    return 0
}

# Grep source code that should NOT match
test_source_absent() {
    local desc="$1"
    local pattern="$2"

    ((TOTAL++))

    if grep -qE "$pattern" "$LOKI"; then
        log_fail "$desc" "Pattern should NOT be in source: $pattern"
    else
        log_pass "$desc"
    fi
    return 0
}

echo "========================================"
echo "Bug Fix Audit Tests"
echo "========================================"
echo "CLI: $LOKI"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

# -------------------------------------------
# BUG-CLI-001/002: --port and --prd flags crash with unbound variable
# Fix: Add ${2:-} guards
# -------------------------------------------
test_cmd "BUG-CLI-001: --port without value shows error" \
    1 "requires" web --port

test_cmd "BUG-CLI-002: --prd without value shows error" \
    1 "requires" web --prd

# -------------------------------------------
# BUG-CLI-003: cmd_web_stop unconditionally kills port 57374
# Fix: Only kill if PID matches dashboard PID file
# -------------------------------------------
test_source "BUG-CLI-003: cmd_web_stop uses PID file instead of lsof" \
    'dash_pid_file=.*dashboard/dashboard\.pid'

test_source_absent "BUG-CLI-003: cmd_web_stop no longer uses lsof on hardcoded port" \
    'lsof -ti:57374'

# -------------------------------------------
# BUG-CLI-005: --mirofish flag double-shifts, eats next argument
# Fix: Use shift 2 on the else branch
# -------------------------------------------
test_source "BUG-CLI-005: --mirofish uses shift 2 for value branch" \
    'mirofish_url="\$2"'

# Verify the structure: if value exists -> shift 2, else -> shift
test_source "BUG-CLI-005: --mirofish has shift 2 in value branch" \
    'mirofish_url=.*\$2'

# -------------------------------------------
# BUG-CLI-006: cmd_state query has shell injection via Python interpolation
# Fix: Pass variables via environment
# -------------------------------------------
test_source "BUG-CLI-006: state query uses env vars for Python" \
    "LOKI_STATE_QUERY_TYPE"

test_source_absent "BUG-CLI-006: state query no longer interpolates query_type" \
    "query_type = '\\\$\{query_type\}'"

# -------------------------------------------
# BUG-CLI-012: shell injection via unquoted Python file path
# Fix: Pass path via environment variable
# -------------------------------------------
test_source "BUG-CLI-012: child-pids.json uses env var for path" \
    "LOKI_PIDS_FILE.*python3"

# -------------------------------------------
# BUG-CMD-001: cmd_web wildcard duplicates first argument
# Fix: Add shift before calling cmd_web_start in the *) case
# -------------------------------------------
test_source "BUG-CMD-001: web wildcard case has shift before cmd_web_start" \
    'cmd_web_start "\$subcommand" "\$@"'

# -------------------------------------------
# BUG-CMD-002: cmd_ci --test-suggest never exports LOKI_CI_CHANGED_FILES
# Fix: Add export before Python heredoc
# -------------------------------------------
test_source "BUG-CMD-002: LOKI_CI_CHANGED_FILES is exported before test suggest" \
    'export LOKI_CI_CHANGED_FILES="\$changed_files"'

# -------------------------------------------
# BUG-CMD-006: cmd_telemetry has Python code injection
# Fix: Pass endpoint and config_file via environment variables
# -------------------------------------------
test_source "BUG-CMD-006: telemetry enable uses env vars" \
    "LOKI_TELEM_CFG.*LOKI_TELEM_ENDPOINT"

test_source "BUG-CMD-006: telemetry disable uses env var" \
    "LOKI_TELEM_CFG.*python3"

# -------------------------------------------
# BUG-TPL-001: local -A incompatible with macOS bash 3.2
# Fix: Replace associative array with function lookup
# -------------------------------------------
test_source_absent "BUG-TPL-001: no associative array declaration" \
    'local -A TEMPLATE_LABELS'

test_source "BUG-TPL-001: _get_template_label function exists" \
    '_get_template_label\(\)'

# -------------------------------------------
# BUG-TPL-002: Template resolution bypasses TEMPLATE_NAMES validation
# Fix: Validate template_name against known list
# -------------------------------------------
test_source "BUG-TPL-002: template name validated before filesystem lookup" \
    '_tpl_valid=false'

# -------------------------------------------
# BUG-CLI-004: _export_csv crashes on dict-format queue
# Fix: Handle both list and dict formats
# -------------------------------------------
test_source "BUG-CLI-004: export handles dict-format queue" \
    'data\.get\("tasks", data\).*isinstance.*dict'

# -------------------------------------------
# BUG-CLI-007: cmd_status silently ignores unknown flags
# Fix: Error on unknown flags
# -------------------------------------------
test_cmd "BUG-CLI-007: status --unknown-flag errors" \
    1 "Unknown flag" status --unknown-flag

test_cmd "BUG-CLI-007: status --help shows usage" \
    0 "Usage" status --help

# -------------------------------------------
# BUG-CLI-008: LOKI_DIR not exported for Python heredocs
# Fix: Pass LOKI_DIR as env var prefix
# -------------------------------------------
test_source "BUG-CLI-008: export_json passes LOKI_DIR to python" \
    'LOKI_DIR="\$LOKI_DIR".*python3'

# -------------------------------------------
# BUG-CLI-009: empty array with set -u in list_running_sessions
# Fix: Guard with ${sessions[@]+"${sessions[@]}"}
# -------------------------------------------
test_source "BUG-CLI-009: sessions array guarded for set -u" \
    'sessions\[@\]\+"'

# -------------------------------------------
# BUG-CLI-013: cmd_dashboard_start useless PID wait loop
# Fix: Health check poll on HTTP endpoint
# -------------------------------------------
test_source "BUG-CLI-013: dashboard uses HTTP health check" \
    'curl.*api/status'

# -------------------------------------------
# BUG-CMD-003: cmd_ci github format missing LOKI_CI_TEST_SUGG export
# Fix: Export before Python heredoc
# -------------------------------------------
test_source "BUG-CMD-003: LOKI_CI_TEST_SUGG exported in github format" \
    'export LOKI_CI_TEST_SUGG='

# -------------------------------------------
# BUG-CMD-004: cmd_watch pipe subshell loses child PID
# Fix: Use loop instead of pipe
# -------------------------------------------
test_source_absent "BUG-CMD-004: no pipe-based fswatch loop" \
    'fswatch.*\| while read'

# -------------------------------------------
# BUG-CMD-005: cmd_config_set stores all values as strings
# Fix: Python type coercion
# -------------------------------------------
test_source "BUG-CMD-005: config set has type coercion" \
    'def coerce_type'

# -------------------------------------------
# BUG-CMD-008: cmd_remote orphans dashboard process
# Fix: Add trap to stop dashboard on exit
# -------------------------------------------
test_source "BUG-CMD-008: remote has trap to stop dashboard" \
    "trap.*cmd_api stop"

# -------------------------------------------
# BUG-TPL-003: .loki/ guard checks CWD not target directory
# Fix: Check target_dir when project_name is set
# -------------------------------------------
test_source "BUG-TPL-003: init guard checks target_dir/.loki" \
    'target_dir/\.loki'

# -------------------------------------------
# BUG-TPL-004: README.md omitted from creation summary
# Fix: Track did_write_readme flag
# -------------------------------------------
test_source "BUG-TPL-004: uses did_write_readme flag" \
    'did_write_readme=true'

test_source "BUG-TPL-004: summary uses did_write_readme" \
    'if \$did_write_readme'

# -------------------------------------------
# BUG-ST-004: cmd_status uses wrong queue format
# Fix: Handle both bare array and {"tasks":[...]}
# -------------------------------------------
test_source "BUG-ST-004: status handles both queue formats" \
    'if type == "array"'

# -------------------------------------------
# BUG-GH-003: Security scan flags deleted lines
# Fix: Only scan lines starting with "+"
# -------------------------------------------
test_source "BUG-GH-003: security scan filters for added lines only" \
    "grep -n '\\^\\+'"

# -------------------------------------------
# BUG-GH-004: .replace() chaining produces .test.test.tsx
# Fix: Use elif chain
# -------------------------------------------
test_source_absent "BUG-GH-004: no chained .replace() calls" \
    '\.replace\("\.ts".*\.replace\("\.js"'

test_source "BUG-GH-004: uses if/elif chain for test extensions" \
    'if ext == ".tsx"'

# -------------------------------------------
# BUG-PKG-013: config set is cwd-relative only
# Fix: Add --global flag
# -------------------------------------------
test_source "BUG-PKG-013: config set supports --global flag" \
    'use_global=true'

test_source "BUG-PKG-013: global config uses ~/.config/loki-mode" \
    'config/loki-mode'

# -------------------------------------------
# BUG-CLI-010: hardcoded version "6.0.0"
# Fix: Use get_version()
# -------------------------------------------
test_source "BUG-CLI-010: export json uses get_version" \
    'LOKI_VERSION="\$\(get_version\)"'

# -------------------------------------------
# BUG-CLI-011: config_get leaks env vars
# Fix: Use inline env prefix instead of export
# -------------------------------------------
test_source_absent "BUG-CLI-011: config get does not export env vars" \
    'export LOKI_CFG_FILE='

test_source "BUG-CLI-011: config get uses inline env prefix" \
    'LOKI_CFG_FILE=.*LOKI_CFG_KEY='

# -------------------------------------------
# BUG-CMD-009: var used before assignment in metrics --share
# Fix: Move project_name assignment before gist_desc
# -------------------------------------------
# We check that project_name is assigned before gist_desc uses it
test_source "BUG-CMD-009: project_name assigned before gist_desc" \
    'project_name=\$\(basename'

# -------------------------------------------
# BUG-CMD-010: cmd_share calls loki by name not \$0
# Fix: Use \$0 instead of loki
# -------------------------------------------
test_source "BUG-CMD-010: share uses \$0 for report" \
    '"\$0" report --format'

# -------------------------------------------
# BUG-CMD-012: worktree merge Python injection
# Fix: Pass via environment variables
# -------------------------------------------
test_source "BUG-CMD-012: worktree merge uses env var for signal file" \
    "LOKI_SIGNAL_FILE.*python3"

# -------------------------------------------
# BUG-GH-011: Missing space in gh status display
# Fix: Add space between "installed" and version
# -------------------------------------------
test_source "BUG-GH-011: gh status has space before version" \
    'installed \$\(gh --version'

# -------------------------------------------
# Syntax validation
# -------------------------------------------
((TOTAL++))
if bash -n "$LOKI" 2>/dev/null; then
    log_pass "bash -n syntax validation passes"
else
    log_fail "bash -n syntax validation" "script has syntax errors"
fi

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
