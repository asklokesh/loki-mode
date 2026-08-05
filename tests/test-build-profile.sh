#!/usr/bin/env bash
# Tests for the simple-web build profile (loki_apply_build_profile in run.sh).
# Verifies: (1) profile unset -> every PHASE_* stays true (unchanged); (2)
# profile=simple-web -> wasteful phases false, quality-critical phases true and
# COUNCIL untouched; (3) operator LOKI_PHASE_* override always wins.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
check() { # check <desc> <expected> <actual>
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "FAIL: $1 (expected '$2', got '$3')"
    fi
}

# Extract the helper definition + its resolution logic from run.sh so we test the
# REAL code (not a copy). We pull the helper function and the PHASE_* assignment
# block, then evaluate them in a clean subshell with a controlled environment.
extract() {
    awk '/^loki_is_supervised_simple_web\(\)/,/^loki_apply_build_profile$/' "$RUN_SH"
    awk '/^PHASE_UNIT_TESTS=/,/^PHASE_UAT=/' "$RUN_SH"
}
PROFILE_CODE="$(extract)"

# Resolve PHASE_* under a given environment; echoes "VAR=value" lines.
resolve() { # resolve <env assignments...>
    env -i bash -c "$*
$PROFILE_CODE
for v in PHASE_UNIT_TESTS PHASE_API_TESTS PHASE_E2E_TESTS PHASE_SECURITY \
         PHASE_INTEGRATION PHASE_CODE_REVIEW PHASE_WEB_RESEARCH PHASE_PERFORMANCE \
         PHASE_ACCESSIBILITY PHASE_REGRESSION PHASE_UAT; do
    echo \"\$v=\${!v}\"
done"
}
val() { grep "^$2=" <<<"$1" | cut -d= -f2; }

# --- 1. profile unset -> all phases true (byte-identical to today) ------------
R="$(resolve 'true')"
for v in UNIT_TESTS API_TESTS E2E_TESTS SECURITY INTEGRATION CODE_REVIEW \
         WEB_RESEARCH PERFORMANCE ACCESSIBILITY REGRESSION UAT; do
    check "unset: PHASE_$v true" "true" "$(val "$R" "PHASE_$v")"
done

# --- 2. profile=simple-web -> wasteful off, quality-critical on ---------------
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web')"
# Dropped (wasteful for a static frontend):
check "simple-web: API_TESTS off"    "false" "$(val "$R" PHASE_API_TESTS)"
check "simple-web: INTEGRATION off"  "false" "$(val "$R" PHASE_INTEGRATION)"
check "simple-web: PERFORMANCE off"  "false" "$(val "$R" PHASE_PERFORMANCE)"
check "simple-web: REGRESSION off"   "false" "$(val "$R" PHASE_REGRESSION)"
check "simple-web: UAT off"          "false" "$(val "$R" PHASE_UAT)"
check "simple-web: WEB_RESEARCH off" "false" "$(val "$R" PHASE_WEB_RESEARCH)"
# Kept (catch real defects on a landing page):
check "simple-web: E2E kept"           "true" "$(val "$R" PHASE_E2E_TESTS)"
check "simple-web: CODE_REVIEW kept"   "true" "$(val "$R" PHASE_CODE_REVIEW)"
check "simple-web: SECURITY kept"      "true" "$(val "$R" PHASE_SECURITY)"
check "simple-web: ACCESSIBILITY kept" "true" "$(val "$R" PHASE_ACCESSIBILITY)"
# Unit tests are not dropped by the profile (default stays true).
check "simple-web: UNIT_TESTS untouched" "true" "$(val "$R" PHASE_UNIT_TESTS)"

# Ordinary simple-web does not enter the exact supervised policy branch, so it
# must leave an operator council value unchanged.
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_COUNCIL_ENABLED=operator; echo LOKI_COUNCIL_ENABLED=$LOKI_COUNCIL_ENABLED')"
if grep -q '^LOKI_COUNCIL_ENABLED=operator$' <<<"$R"; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1)); echo "FAIL: ordinary simple-web mutated council policy"
fi

# --- 3. operator override wins (pre-set LOKI_PHASE_API_TESTS=true kept) --------
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_PHASE_API_TESTS=true')"
check "override: API_TESTS stays true" "true" "$(val "$R" PHASE_API_TESTS)"
# And an operator can still force-OFF a kept phase.
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_PHASE_E2E_TESTS=false')"
check "override: E2E forced false" "false" "$(val "$R" PHASE_E2E_TESTS)"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
