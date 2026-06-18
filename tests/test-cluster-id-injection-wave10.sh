#!/usr/bin/env bash
#===============================================================================
# Loki Mode - cluster run --cluster-id quote-injection regression (WAVE10)
#
# `loki cluster run <template> --cluster-id <id>` recorded lifecycle state via
# a `python3 -c "..."` heredoc that raw-interpolated the user-supplied
# cluster_id and template_name into the python source:
#
#     cluster_id = '${cluster_id}'
#
# A --cluster-id containing a single quote (e.g. "o'brien") turned the heredoc
# body into a Python SyntaxError. The state-recording block (lifecycle hooks +
# db.record_event) never ran, but the green "Cluster: ..." success lines still
# printed afterward, so the user saw a false success with no state recorded.
#
# The fix passes cluster_id / template_name / template_file / SKILL_DIR via
# os.environ and uses a single-quoted heredoc body, so a quote in the id is
# inert.
#
# This test runs `cluster run` with an apostrophe id and asserts the run
# initializes (state block executed) WITHOUT emitting a Python SyntaxError.
#===============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$SCRIPT_DIR/autonomy/loki"

WORK_DIR=$(mktemp -d /tmp/loki-test-cluster-XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

export NO_COLOR=1
export LOKI_NO_TELEMETRY=1

log_test() { TOTAL=$((TOTAL+1)); echo -e "${BOLD}[$TOTAL] $1${NC}"; }
log_pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}PASS${NC}: $1"; }
log_fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}FAIL${NC}: $1"; }

# A built-in cluster template must exist for the run path to reach the
# state-recording block; skip cleanly if the swarm runtime is unavailable.
TEMPLATE="code-review"
if [ ! -f "$SCRIPT_DIR/templates/clusters/${TEMPLATE}.json" ]; then
    echo -e "${BOLD}[skip] cluster template ${TEMPLATE}.json not found${NC}"
    exit 0
fi
if ! python3 -c "import sys; sys.path.insert(0, '$SCRIPT_DIR'); import swarm.patterns, state.sqlite_backend" 2>/dev/null; then
    echo -e "${BOLD}[skip] swarm runtime not importable; cluster run not exercisable${NC}"
    exit 0
fi

cd "$WORK_DIR" || exit 1

#-------------------------------------------------------------------------------
# 1. --cluster-id with a single quote must NOT yield a Python SyntaxError
#    and must reach the "initialized" state-recording output.
#-------------------------------------------------------------------------------
log_test "cluster run --cluster-id with apostrophe records state (no SyntaxError)"
out=$("$LOKI" cluster run "$TEMPLATE" --cluster-id "o'brien" 2>&1)
if echo "$out" | grep -qi "SyntaxError"; then
    log_fail "Python SyntaxError from injected cluster-id: $out"
elif echo "$out" | grep -q "initialized with"; then
    log_pass "apostrophe cluster-id handled; state block executed"
else
    log_fail "state block did not run (no 'initialized with' line): $out"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total${NC}"
[ "$FAIL" -eq 0 ]
