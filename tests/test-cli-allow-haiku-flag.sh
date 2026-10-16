#!/usr/bin/env bash
# Test: cmd_start --allow-haiku flag parsing
#
# Regression for a real E2E bug: `loki start ./prd.md --allow-haiku` aborted with
# "Unknown option: --allow-haiku" even though loki --help and run.sh document the
# flag. Only LOKI_ALLOW_HAIKU=true worked. cmd_start now parses --allow-haiku,
# exports LOKI_ALLOW_HAIKU=true, and forwards the arg to run.sh (run.sh:15015).
#
# This test exercises the CLI interface only. It does not invoke the claude CLI:
# the start chain is bounded by `timeout` and we assert on the prereq-phase output
# (which run.sh reaches before any provider call) plus the help text.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TEST_DIR=$(mktemp -d)
cleanup() {
    # No process cleanup needed: this test never launches a real build (the
    # runtime check below aborts at provider validation, before any orchestrator
    # or provider CLI is spawned). A global `pkill -f loki-run-` here would be
    # unsafe -- it would kill unrelated loki runs on a shared/CI machine.
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "========================================"
echo "CLI --allow-haiku Flag Tests"
echo "========================================"
echo "loki binary: $LOKI_BIN"
echo ""

# ===========================================
# Test 1: loki binary has valid bash syntax
# ===========================================
log_test "autonomy/loki has valid bash syntax"
if bash -n "$LOKI_BIN" 2>/dev/null; then
    log_pass "autonomy/loki parses"
else
    log_fail "autonomy/loki has a syntax error"
    exit 1
fi

# ===========================================
# Test 2: cmd_start has an --allow-haiku case (not the catch-all -*)
# ===========================================
log_test "cmd_start defines an --allow-haiku case"
if grep -qE '^[[:space:]]*--allow-haiku\)' "$LOKI_BIN"; then
    log_pass "--allow-haiku case present in autonomy/loki"
else
    log_fail "--allow-haiku case missing from autonomy/loki"
fi

# ===========================================
# Test 3: the --allow-haiku case exports LOKI_ALLOW_HAIKU=true
# ===========================================
log_test "--allow-haiku exports LOKI_ALLOW_HAIKU=true"
if awk '/^[[:space:]]*--allow-haiku\)/{f=1} f&&/export LOKI_ALLOW_HAIKU=true/{print;exit}' "$LOKI_BIN" | grep -q 'LOKI_ALLOW_HAIKU=true'; then
    log_pass "--allow-haiku exports LOKI_ALLOW_HAIKU=true"
else
    log_fail "--allow-haiku does not export LOKI_ALLOW_HAIKU=true"
fi

# ===========================================
# Test 4: cmd_start help documents --allow-haiku (flag and help agree)
# ===========================================
log_test "loki start --help documents --allow-haiku"
# Capture first, then grep the variable. Piping `loki start --help` directly into
# `grep -q` is unreliable under `set -o pipefail`: grep closes the pipe on first
# match, loki dies with SIGPIPE (141), and pipefail propagates that non-zero status
# even though the match succeeded.
help_out=$("$LOKI_BIN" start --help 2>&1)
if printf '%s' "$help_out" | grep -q -- '--allow-haiku'; then
    log_pass "help text documents --allow-haiku"
else
    log_fail "help text does not document --allow-haiku"
fi

# ===========================================
# Test 5: runtime parse proof -- the flag is ACCEPTED (no "Unknown option").
#
# This deliberately pairs --allow-haiku with an invalid --provider so cmd_start
# parses ALL flags (including --allow-haiku) and then aborts at provider
# validation with exit 1, BEFORE launching any orchestrator or provider CLI.
# That makes the assertion deterministic and side-effect-free: no real build,
# no paid model calls, no detached processes, no claude auth dependency.
# Before the fix this path printed "Unknown option: --allow-haiku" and aborted
# during arg parsing instead.
# ===========================================
log_test "loki start ./prd.md --allow-haiku is accepted (no Unknown option)"
printf '# Test PRD\nBuild a tiny thing.\n' > "$TEST_DIR/prd.md"
out=$(
    cd "$TEST_DIR" &&
    LOKI_AUTO_CONFIRM=true LOKI_DASHBOARD=false \
        "$LOKI_BIN" start ./prd.md --allow-haiku --provider loki_invalid_provider_xyz --no-dashboard --no-plan 2>&1
)

if printf '%s' "$out" | grep -q 'Unknown option'; then
    log_fail "start aborted with 'Unknown option' (flag rejected)"
    printf '%s\n' "$out" | grep 'Unknown option'
else
    log_pass "start did not reject --allow-haiku (parsed past the flag, aborted at provider validation)"
fi

# ===========================================
# Test 6: no real build was spawned by Test 5 (safety regression).
# The orchestrator stages its run script at /tmp/loki-run-*.sh and writes a
# build .loki tree; neither should exist for OUR invocation. We assert no
# orchestrator process is running against TEST_DIR.
# ===========================================
log_test "no orchestrator/provider process spawned for the test invocation"
if pgrep -f "loki-run-.*$TEST_DIR" >/dev/null 2>&1 || pgrep -f "start ./prd.md --allow-haiku --provider loki_invalid_provider_xyz" >/dev/null 2>&1; then
    log_fail "an orchestrator/provider process was spawned (should have aborted at provider validation)"
else
    log_pass "no build process spawned (aborted before orchestrator launch)"
fi

# ===========================================
# P12-07k: ONE allowlist (_loki_start_flag_kind) feeds the cmd_start parser check,
# the --workspace brief scan and the --resume scan. An unknown flag in a scan
# exits 64 "Unknown option: <flag>" (the parser's message), and every known flag
# keeps its value-or-boolean shape.
# ===========================================
export LOKI_NO_BROWSER=1
run_start() { (cd "$TEST_DIR" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start "$@" 2>&1); }

# The allowlist, read straight from the function body: "kind<TAB>flag" rows.
allow_rows=$(sed -n '/^_loki_start_flag_kind()/,/^}/p' "$LOKI_BIN" | awk '
    /_LOKI_START_FLAG_KIND=(value|optional|bool) ;;/ {
        kind = $0; sub(/.*_LOKI_START_FLAG_KIND=/, "", kind); sub(/ ;;.*/, "", kind)
        pats = $0; sub(/\) *_LOKI_START_FLAG_KIND.*/, "", pats); gsub(/^[ \t]+/, "", pats)
        n = split(pats, a, "|"); for (i = 1; i <= n; i++) print kind "\t" a[i]
    }')

log_test "allowlist has value, optional and boolean rows"
if printf '%s\n' "$allow_rows" | grep -q '^value'$'\t''--provider$' &&
   printf '%s\n' "$allow_rows" | grep -q '^optional'$'\t''--mirofish$' &&
   printf '%s\n' "$allow_rows" | grep -q '^bool'$'\t''--fast$'; then
    log_pass "allowlist rows parsed"
else
    log_fail "could not read the allowlist rows from _loki_start_flag_kind"
fi

log_test "allowlist agrees with the cmd_start parser case arms (both directions)"
parser_flags=$(sed -n '/local issue_run_detached=false/,/Unknown option: \$1/p' "$LOKI_BIN" |
    grep -E '^            -[^ ]*\)$' | sed -e 's/^ *//' -e 's/)$//' | tr '|' '\n' |
    sed -e 's/=.*$//' | grep -v '^-\*$' | sort -u)
table_flags=$(printf '%s\n' "$allow_rows" | cut -f2 | grep -vx -e '--resume' | sort -u)
if [ "$parser_flags" = "$table_flags" ]; then
    log_pass "parser arms and allowlist name the same flags"
else
    log_fail "parser and allowlist differ: $(diff <(printf '%s\n' "$parser_flags") <(printf '%s\n' "$table_flags") | tr '\n' ' ')"
fi

log_test "unknown valued flag before a --workspace brief exits 64"
out=$(run_start --workspace nows --max-wait 30 "my brief"); rc=$?
if [ "$rc" -eq 64 ] && printf '%s' "$out" | grep -q 'Unknown option: --max-wait'; then
    log_pass "--workspace scan: unknown flag exits 64"
else
    log_fail "--workspace scan rc=$rc: $out"
fi

log_test "plain unknown valued flag before the brief exits 64"
out=$(run_start --max-wait 30 brief.md); rc=$?
if [ "$rc" -eq 64 ] && printf '%s' "$out" | grep -q 'Unknown option: --max-wait'; then
    log_pass "parser: unknown flag exits 64"
else
    log_fail "parser rc=$rc: $out"
fi

log_test "unknown flag after --resume exits 64"
for pair in "--foo bar" "--model sonnet" "--max-wait 30" "--max-cost 5"; do
    # shellcheck disable=SC2086 # intentional split: flag plus value
    out=$(run_start --resume $pair); rc=$?
    if [ "$rc" -eq 64 ] && printf '%s' "$out" | grep -q "Unknown option: ${pair%% *}"; then
        log_pass "start --resume $pair exits 64"
    else
        log_fail "start --resume $pair rc=$rc: $out"
    fi
done
out=$(run_start --foo bar --resume); rc=$?
if [ "$rc" -eq 64 ]; then log_pass "unknown flag before --resume exits 64"; else log_fail "flag before --resume rc=$rc: $out"; fi

# Scan shape per allowlisted flag. --config/--vars/--env-file/--attempts are
# consumed by main() before cmd_start, and --brief IS the brief, so the scans skip them here.
skip_scan=" --config --vars --env-file --attempts --brief -- --help -h --resume "
ws_bad=""; resume_bad=""
if command -v bun >/dev/null 2>&1; then
    stub="$TEST_DIR/stub-entry.js"
    printf 'console.log("STUB-ARGV:" + process.argv.slice(2).join(" ")); process.exit(0);\n' > "$stub"
else
    stub=""
fi
while IFS=$'\t' read -r kind flag; do
    [ -n "$flag" ] || continue
    case "$skip_scan" in *" $flag "*) continue ;; esac
    case "$kind" in
        value)    set -- "$flag" notarunid ;;
        optional) set -- "$flag" http://u ;;
        *)        set -- "$flag" ;;
    esac
    # --workspace scan: with no real brief it must reach "needs a brief"; a leaked
    # value would reach cmd_workspace instead ("unknown workspace").
    out=$(run_start --workspace nows "$@")
    printf '%s' "$out" | grep -q 'needs a brief or an issue ref' || ws_bad="$ws_bad $flag($kind)"
    # --resume scan: a consumed value is never a run id, so the stub delegate runs.
    if [ -n "$stub" ]; then
        out=$(cd "$TEST_DIR" && LOKI_TS_ENTRY="$stub" LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" start --resume "$@" 2>&1)
        case "$out" in
            *"STUB-ARGV:engine10 resume"*) case "$out" in *notarunid*|*http://u*) resume_bad="$resume_bad $flag(leaked)" ;; esac ;;
            *) resume_bad="$resume_bad $flag($kind)" ;;
        esac
    fi
done <<EOF
$allow_rows
EOF
log_test "every allowlisted flag keeps its shape in the --workspace scan"
if [ -z "$ws_bad" ]; then log_pass "valued, optional and boolean flags all handled"; else log_fail "scan misread:$ws_bad"; fi
log_test "every allowlisted flag keeps its shape in the --resume scan"
if [ -z "$stub" ]; then
    log_fail "bun unavailable: the --resume scan was NOT measured (unmeasured, not clean)"
elif [ -z "$resume_bad" ]; then
    log_pass "valued, optional and boolean flags all reach the resume delegate"
else
    log_fail "resume scan misread:$resume_bad"
fi

log_test "a boolean flag does not swallow the next token in the --workspace scan"
out=$(run_start --workspace nows --simple "my brief")
if printf '%s' "$out" | grep -q 'unknown workspace'; then
    log_pass "--simple left the brief intact"
else
    log_fail "boolean flag swallowed the brief: $out"
fi

log_test "--model is gone from start help and completions"
if printf '%s' "$help_out" | grep -qE '^  --model'; then log_fail "start --help still lists --model"; else log_pass "start --help has no --model flag line"; fi
if sed -n '/start|quick)/,/;;/p' "$PROJECT_DIR/completions/loki.bash" | grep -q -- '--model'; then
    log_fail "completions/loki.bash start flags still list --model"
else
    log_pass "completions/loki.bash start flags have no --model"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
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
