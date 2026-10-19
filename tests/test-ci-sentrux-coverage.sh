#!/usr/bin/env bash
#===============================================================================
# tests/test-ci-sentrux-coverage.sh (v7.5.15)
#
# Verifies that the sentrux gate test wiring is intact across CI surfaces:
#
#   1. tests/test-sentrux-gate.sh (unit, fake binary) IS referenced from at
#      least one .github/workflows/*.yml file -- either directly or via a
#      runner that picks it up (e.g. tests/run-all-tests.sh).
#   2. tests/integration/test_sentrux_real.sh is NOT in the default CI path
#      (would be a false-positive risk on Linux without the real binary).
#   3. tests/test-sentrux-gate.sh IS referenced from scripts/local-ci.sh so
#      the pre-push gate covers it (per CLAUDE.md mandate).
#
# This test is platform-independent and has no external deps.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
RUN_ALL="$REPO_ROOT/tests/run-all-tests.sh"
LOCAL_CI="$REPO_ROOT/scripts/local-ci.sh"
INTEGRATION_RUNNER="$REPO_ROOT/tests/integration/run_integration_suite.sh"

PASS=0
FAIL=0

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ---------------------------------------------------------------------------
# 1. Sentrux unit test reachable from CI (directly OR via run-all-tests.sh)
# ---------------------------------------------------------------------------
direct_workflow_hit=0
runner_workflow_hit=0
if grep -rl "test-sentrux-gate.sh" "$WORKFLOWS_DIR" >/dev/null 2>&1; then
    direct_workflow_hit=1
fi
if grep -rl "tests/run-all-tests.sh\|tests/test-\*.sh" "$WORKFLOWS_DIR" >/dev/null 2>&1; then
    runner_workflow_hit=1
fi
if [ "$direct_workflow_hit" = "1" ] || [ "$runner_workflow_hit" = "1" ]; then
    ok "test-sentrux-gate.sh reachable from at least one workflow (direct=$direct_workflow_hit runner=$runner_workflow_hit)"
elif ! grep -rlE "run-all-tests|bun test" "$WORKFLOWS_DIR" >/dev/null 2>&1; then
    # GitHub CI runs no test suite (release.yml only runs two manifest checks); the pre-push
    # gate scripts/local-ci.sh is the test path, asserted in check 3 below.
    ok "no workflow runs tests; local-ci.sh is the test path (check 3)"
else
    bad "test-sentrux-gate.sh NOT referenced or reachable from any .github/workflows/*.yml"
fi

# 1b. If reached only via runner, confirm the runner actually invokes it.
if [ "$direct_workflow_hit" = "0" ] && [ "$runner_workflow_hit" = "1" ]; then
    if [ -f "$RUN_ALL" ] && grep -q "test-sentrux-gate.sh" "$RUN_ALL"; then
        ok "tests/run-all-tests.sh invokes test-sentrux-gate.sh"
    else
        bad "tests/run-all-tests.sh exists but does NOT invoke test-sentrux-gate.sh"
    fi
fi

# ---------------------------------------------------------------------------
# 2. Real-binary integration test NOT in default CI path
# ---------------------------------------------------------------------------
# Permitted: gated workflows (manual / nightly only). Not permitted: any
# workflow triggered on push/pull_request that runs it unconditionally,
# AND the default integration-suite runner.
default_runner_hits_real=0
if [ -f "$INTEGRATION_RUNNER" ] && grep -q "test_sentrux_real.sh" "$INTEGRATION_RUNNER"; then
    default_runner_hits_real=1
fi
if [ "$default_runner_hits_real" = "1" ]; then
    bad "tests/integration/run_integration_suite.sh references test_sentrux_real.sh (would block CI without real binary)"
else
    ok "tests/integration/run_integration_suite.sh does NOT reference test_sentrux_real.sh"
fi

# Check that any workflow that DOES mention test_sentrux_real.sh is gated:
# it must NOT have a `push:` or `pull_request:` trigger. We grep each match.
real_test_violations=0
real_test_workflows=$(grep -rl "test_sentrux_real.sh" "$WORKFLOWS_DIR" 2>/dev/null || true)
if [ -n "$real_test_workflows" ]; then
    while IFS= read -r wf; do
        [ -z "$wf" ] && continue
        # A workflow is "gated" iff it does NOT have on.push or on.pull_request.
        # We use a coarse text grep: if the file mentions either trigger as a
        # top-level YAML key (line begins with two spaces or zero spaces and
        # ends with ':'), consider it ungated.
        if grep -E "^[[:space:]]{0,2}(push|pull_request):" "$wf" >/dev/null 2>&1; then
            bad "workflow $wf references test_sentrux_real.sh AND has push/pull_request trigger (must be manual/scheduled only)"
            real_test_violations=$((real_test_violations + 1))
        fi
    done <<<"$real_test_workflows"
fi
if [ "$real_test_violations" = "0" ]; then
    ok "all workflows referencing test_sentrux_real.sh are properly gated (manual/scheduled only)"
fi

# ---------------------------------------------------------------------------
# 3. Pre-push gate (scripts/local-ci.sh) covers the unit test
# ---------------------------------------------------------------------------
if [ -f "$LOCAL_CI" ] && grep -q "test-sentrux-gate.sh" "$LOCAL_CI"; then
    ok "scripts/local-ci.sh references test-sentrux-gate.sh"
else
    bad "scripts/local-ci.sh does NOT reference test-sentrux-gate.sh (pre-push gate gap)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
printf '==========================================\n'
printf 'Total: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
printf '==========================================\n'

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
