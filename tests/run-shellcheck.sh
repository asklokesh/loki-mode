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

# PARALLELISM (v8.2.0). shellcheck is CPU-bound and every file is independent,
# so the serial loop below leaves all but one core idle.
#
# MEASURED: the whole suite takes ~114 s, and it is concentrated in two files --
# autonomy/run.sh (24,305 lines) costs 15.9 s and autonomy/loki (33,130 lines)
# costs 17.1 s, while the other ~579 files average ~9 ms each.
#
# Why the work itself is NOT reduced here: an earlier attempt collapsed the pair
# of per-file linter invocations into one and derived the info-level note from
# the same output. It was ~2x faster and it SILENTLY LOST 2 real failures
# (tests/_watch-instr.sh and autonomy/lib/scan-batch.sh), because shellcheck
# prints the severity on the caret line rather than the header, and because a
# file it cannot open reports no SC code at all. That was caught only by running
# the ORIGINAL and diffing the counts. A lint gate that is faster because it
# stopped noticing failures is precisely the false-green this project exists to
# prevent, so that change was reverted rather than shipped.
#
# This keeps the per-file logic byte-identical and only changes SCHEDULING.
# Set LOKI_SHELLCHECK_JOBS to 1 to fall back to serial if a machine misbehaves.
_sc_results="$(mktemp -d "${TMPDIR:-/tmp}/loki-shellcheck-XXXXXX")"
trap 'rm -rf "$_sc_results"' EXIT
_sc_jobs="${LOKI_SHELLCHECK_JOBS:-$( { command -v nproc >/dev/null 2>&1 && nproc; } \
    || sysctl -n hw.ncpu 2>/dev/null || echo 4 )}"
case "$_sc_jobs" in ''|*[!0-9]*) _sc_jobs=4 ;; esac
[ "$_sc_jobs" -lt 1 ] && _sc_jobs=1

for file in $FILES; do
    # Determine exclusions based on file type
    local_excludes="$GLOBAL_EXCLUDES"
    if [[ "$file" == ./providers/*.sh ]]; then
        local_excludes="${GLOBAL_EXCLUDES},${PROVIDER_EXCLUDES}"
    fi
    if [[ "$file" == ./tests/*.sh ]]; then
        local_excludes="${local_excludes},${TEST_EXCLUDES}"
    fi
    # benchmarks/ harness scripts build a command-prefix env list (LOKI_* set
    # immediately before the command they configure), so shellcheck reports
    # SC2034 "appears unused" for every one of them -- it cannot see the vars
    # are passed to the child process. Same rationale as tests/ above: these
    # are environment for something else, not locals that went unread.
    if [[ "$file" == ./benchmarks/*.sh ]]; then
        local_excludes="${local_excludes},${TEST_EXCLUDES}"
    fi

    # Each file is checked in a background job writing a one-line verdict to its
    # own result file. The DECISION LOGIC is byte-identical to the serial
    # version: same two invocations, same exit-code test, same info-level probe.
    # Only the scheduling changed, so a file that failed before still fails.
    (
        output=$(shellcheck -S warning -e "$local_excludes" "$file" 2>&1)
        exit_code=$?
        if [ $exit_code -eq 0 ]; then
            info_output=$(shellcheck -e "$local_excludes" "$file" 2>&1)
            if [ -n "$info_output" ]; then
                printf 'INFO\t%s\n' "$file"
            else
                printf 'PASS\t%s\n' "$file"
            fi
        else
            printf 'FAIL\t%s\n%s\n' "$file" "$output"
        fi
    ) > "$_sc_results/$(printf '%s' "$file" | tr '/.' '__')" 2>&1 &

    # Bound concurrency so 581 shellcheck processes do not stampede the box.
    while [ "$(jobs -rp | wc -l)" -ge "$_sc_jobs" ]; do wait -n 2>/dev/null || break; done
done
wait

# Replay results IN THE ORIGINAL FILE ORDER so output stays deterministic and
# diffable against the serial version -- non-deterministic ordering would make
# any future regression impossible to spot by comparison.
for file in $FILES; do
    _rf="$_sc_results/$(printf '%s' "$file" | tr '/.' '__')"
    [ -f "$_rf" ] || continue
    _verdict=$(head -1 "$_rf" | cut -f1)
    case "$_verdict" in
        PASS) log_pass "Checked $file" ;;
        INFO) log_info "$file (info-level suggestions exist)" ;;
        FAIL) tail -n +2 "$_rf"; log_fail "Issues found in $file" ;;
        *)    tail -n +2 "$_rf"; log_fail "Issues found in $file" ;;
    esac
done
rm -rf "$_sc_results"

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
