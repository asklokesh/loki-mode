#!/usr/bin/env bash
#===============================================================================
# Loki Mode - Admin command quote/special-char safety regression tests
#
# Several admin commands (projects add/remove/health, enterprise token
# generate/revoke/delete, failover --chain) used to raw-interpolate user
# values into a `python3 -c` heredoc body and swallow errors with
# `2>/dev/null`. A value containing a single quote or backslash made the
# python source a syntax error: the command exited 0, wrote nothing, and
# either printed nothing or (for failover) printed a false "updated"
# success line.
#
# The fix passes user values via environment variables read with
# os.environ and drops the 2>/dev/null swallow (or gates the success echo
# on python exit 0). These tests prove a value with a single quote /
# backslash is stored correctly and does NOT produce a silent no-op or a
# false success.
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

# Isolate HOME so the registry/token files land in a throwaway dir.
TEST_HOME=$(mktemp -d /tmp/loki-test-quote-XXXXXX)
WORK_DIR=$(mktemp -d /tmp/loki-test-quote-work-XXXXXX)

cleanup() {
    rm -rf "$TEST_HOME" "$WORK_DIR"
}
trap cleanup EXIT

log_test() {
    ((TOTAL++))
    echo -e "${BOLD}[$TOTAL] $1${NC}"
}
log_pass() {
    ((PASS++))
    echo -e "  ${GREEN}PASS${NC}: $1"
}
log_fail() {
    ((FAIL++))
    echo -e "  ${RED}FAIL${NC}: $1"
}

export HOME="$TEST_HOME"
export LOKI_ENTERPRISE_AUTH=true
# Keep the CLI quiet/non-interactive.
export LOKI_NO_TELEMETRY=1
export NO_COLOR=1

REGISTRY="$TEST_HOME/.loki/dashboard/projects.json"
TOKEN_FILE="$TEST_HOME/.loki/dashboard/tokens.json"

#-------------------------------------------------------------------------------
# 1. projects add --name with a single quote must STORE the value, not no-op.
#-------------------------------------------------------------------------------
log_test "projects add --name with single quote stores value (no silent no-op)"
mkdir -p "$WORK_DIR/target1"
QUOTE_NAME="a'b"
out=$("$LOKI" projects add "$WORK_DIR/target1" --name "$QUOTE_NAME" 2>&1)
if echo "$out" | grep -q "Registered:"; then
    # Verify the value actually landed in the registry verbatim.
    if [ -f "$REGISTRY" ] && python3 - "$REGISTRY" "$QUOTE_NAME" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2]
names = [p.get('name') for p in data.get('projects', {}).values()]
sys.exit(0 if want in names else 1)
PY
    then
        log_pass "name with single quote registered and stored verbatim"
    else
        log_fail "Registered line printed but value not found in registry"
    fi
else
    log_fail "no Registered line (silent no-op): $out"
fi

#-------------------------------------------------------------------------------
# 2. projects add --name with a backslash must STORE the value, not no-op.
#-------------------------------------------------------------------------------
log_test "projects add --name with backslash stores value"
mkdir -p "$WORK_DIR/target2"
BS_NAME='back\slash'
out=$("$LOKI" projects add "$WORK_DIR/target2" --name "$BS_NAME" 2>&1)
if echo "$out" | grep -q "Registered:" && \
   python3 - "$REGISTRY" "$BS_NAME" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2]
names = [p.get('name') for p in data.get('projects', {}).values()]
sys.exit(0 if want in names else 1)
PY
then
    log_pass "name with backslash registered and stored verbatim"
else
    log_fail "backslash name not stored: $out"
fi

#-------------------------------------------------------------------------------
# 3. enterprise token generate <name> with a single quote must create token.
#-------------------------------------------------------------------------------
log_test "token generate with single quote creates token (no silent no-op)"
out=$("$LOKI" enterprise token generate "tok'quote" 2>&1)
if echo "$out" | grep -q "Token created:" && \
   python3 - "$TOKEN_FILE" "tok'quote" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2]
names = [t.get('name') for t in data.get('tokens', {}).values()]
sys.exit(0 if want in names else 1)
PY
then
    log_pass "token name with single quote created and stored verbatim"
else
    log_fail "token with single quote not created (silent no-op): $out"
fi

#-------------------------------------------------------------------------------
# 4. failover --chain must NOT print a false success when the write fails.
#    With a valid chain it should update; the success line must only appear
#    when the python actually succeeded. We assert the stored chain matches.
#-------------------------------------------------------------------------------
log_test "failover --chain success line only on a real write"
cd "$WORK_DIR" || exit 1
"$LOKI" failover --enable >/dev/null 2>&1
out=$("$LOKI" failover --chain "claude,codex" 2>&1)
FAILOVER_FILE="$WORK_DIR/.loki/state/failover.json"
if echo "$out" | grep -q "Failover chain updated" && \
   [ -f "$FAILOVER_FILE" ] && \
   python3 - "$FAILOVER_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
sys.exit(0 if data.get('chain') == ['claude', 'codex'] else 1)
PY
then
    log_pass "chain updated and stored matches the printed success"
else
    log_fail "chain success/store mismatch: $out"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total${NC}"
[ "$FAIL" -eq 0 ]
