#!/usr/bin/env bash
#===============================================================================
# Loki Mode - spawn_timeout / spawn_retries deprecation regression (WAVE10)
#
# run.sh removed invoke_with_timeout (WAVE9); nothing in the runtime consumes
# LOKI_SPAWN_TIMEOUT / LOKI_SPAWN_RETRIES anymore. The `loki config set
# spawn_timeout|spawn_retries` knobs used to silently accept the value and
# export a dead env var, implying an effect that no longer exists.
#
# WAVE10 marks both keys deprecated: `config set` still accepts them (no broken
# invocations) but prints a deprecation note and no longer exports the dead
# env var. `config show` / help label them "(deprecated, no effect)".
#
# These tests assert the deprecation note appears, the value is still stored
# (back-compat: not a hard error), and a normal key (maxTier) is unaffected.
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

WORK_DIR=$(mktemp -d /tmp/loki-test-cfgspawn-XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

export NO_COLOR=1
export LOKI_NO_TELEMETRY=1

log_test() { TOTAL=$((TOTAL+1)); echo -e "${BOLD}[$TOTAL] $1${NC}"; }
log_pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}PASS${NC}: $1"; }
log_fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}FAIL${NC}: $1"; }

cd "$WORK_DIR" || exit 1

#-------------------------------------------------------------------------------
# 1. config set spawn_timeout emits a deprecation note (and still accepts it).
#-------------------------------------------------------------------------------
log_test "config set spawn_timeout prints deprecation note + still accepts"
out=$("$LOKI" config set spawn_timeout 99 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
    log_fail "config set spawn_timeout returned non-zero (broke back-compat): $out"
elif echo "$out" | grep -qi "deprecated" && echo "$out" | grep -q "Set spawn_timeout"; then
    log_pass "deprecation note shown and value accepted"
else
    log_fail "missing deprecation note or accept line: $out"
fi

#-------------------------------------------------------------------------------
# 2. config set spawn_retries also deprecated.
#-------------------------------------------------------------------------------
log_test "config set spawn_retries prints deprecation note"
out=$("$LOKI" config set spawn_retries 3 2>&1)
if echo "$out" | grep -qi "deprecated"; then
    log_pass "spawn_retries deprecation note shown"
else
    log_fail "spawn_retries missing deprecation note: $out"
fi

#-------------------------------------------------------------------------------
# 3. config show labels the knobs deprecated (no live value implied).
#-------------------------------------------------------------------------------
log_test "config show labels spawn knobs deprecated"
out=$("$LOKI" config show 2>&1)
if echo "$out" | grep -E "spawn_timeout:.*deprecated" >/dev/null && \
   echo "$out" | grep -E "spawn_retries:.*deprecated" >/dev/null; then
    log_pass "both knobs labelled deprecated in show"
else
    log_fail "show does not label knobs deprecated: $(echo "$out" | grep spawn)"
fi

#-------------------------------------------------------------------------------
# 4. A normal key (maxTier) is unaffected (no deprecation note, succeeds).
#-------------------------------------------------------------------------------
log_test "config set maxTier unaffected by deprecation change"
out=$("$LOKI" config set maxTier sonnet 2>&1)
if [ $? -eq 0 ] && echo "$out" | grep -q "Set maxTier = sonnet" && \
   ! echo "$out" | grep -qi "deprecated"; then
    log_pass "maxTier set works, no spurious deprecation note"
else
    log_fail "maxTier set regressed: $out"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total${NC}"
[ "$FAIL" -eq 0 ]
