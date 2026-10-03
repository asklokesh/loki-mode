#!/usr/bin/env bash
# PO5-ORPHAN-SUITES: suites that are not named tests/test-*.sh are invisible to
# the test-*.sh registration guard, so they can run nowhere in CI. This guard
# covers the three non-standard families:
#   1. tests/cli/test_*.sh            must appear in run-all-tests.sh,
#                                     scripts/local-ci.sh or a workflow, or be
#                                     listed in KNOWN_RED below with a reason.
#   2. tests/dashboard/run_*_tests.sh wrappers must be registered the same way.
#   3. tests/integration/test_*.sh    must be in run_integration_suite.sh TESTS,
#                                     or registered the same way.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# name (relative to tests/) | reason it is intentionally unregistered
KNOWN_RED=(
    "cli/test_zero_config_first_run.sh|fails 3 of 29 assertions today; fix tracked separately, register once green"
)

CORPUS_FILES=("$SCRIPT_DIR/run-all-tests.sh" "$REPO_ROOT/scripts/local-ci.sh")
for wf in "$REPO_ROOT"/.github/workflows/*.yml; do
    [ -f "$wf" ] && CORPUS_FILES+=("$wf")
done
INTEG_RUNNER="$SCRIPT_DIR/integration/run_integration_suite.sh"

FAIL=0
ORPHANS=()

registered_anywhere() { grep -qF -- "$1" "${CORPUS_FILES[@]}"; }

known_red_reason() {
    local entry
    for entry in "${KNOWN_RED[@]}"; do
        if [ "${entry%%|*}" = "$1" ]; then
            printf '%s' "${entry#*|}"
            return 0
        fi
    done
    return 1
}

check() {
    local rel="$1" in_runner="${2:-}"
    if registered_anywhere "$rel"; then return 0; fi
    if [ -n "$in_runner" ] && grep -qF -- "\"${rel##*/}\"" "$in_runner"; then return 0; fi
    if known_red_reason "$rel" >/dev/null; then return 0; fi
    ORPHANS+=("tests/$rel")
}

for f in "$SCRIPT_DIR"/cli/test_*.sh; do
    [ -f "$f" ] && check "cli/${f##*/}"
done
for f in "$SCRIPT_DIR"/dashboard/run_*_tests.sh; do
    [ -f "$f" ] && check "dashboard/${f##*/}"
done
for f in "$SCRIPT_DIR"/integration/test_*.sh; do
    [ -f "$f" ] && check "integration/${f##*/}" "$INTEG_RUNNER"
done

echo "T1 -- every non-standard suite is registered or KNOWN_RED"
if [ "${#ORPHANS[@]}" -eq 0 ]; then
    echo "  [PASS] no orphan suites"
else
    for o in "${ORPHANS[@]}"; do echo "  [FAIL] orphan suite not registered in any runner: $o"; done
    FAIL=$((FAIL+1))
fi

echo "T2 -- KNOWN_RED entries are not stale"
stale=0
for entry in "${KNOWN_RED[@]}"; do
    rel="${entry%%|*}"
    if [ ! -f "$SCRIPT_DIR/$rel" ]; then
        echo "  [FAIL] KNOWN_RED names a missing file: tests/$rel"; stale=1
    elif registered_anywhere "$rel"; then
        echo "  [FAIL] KNOWN_RED entry is now registered, remove it: tests/$rel"; stale=1
    fi
done
if [ "$stale" -eq 0 ]; then echo "  [PASS] KNOWN_RED entries are current"; else FAIL=$((FAIL+1)); fi

if [ "$FAIL" -eq 0 ]; then echo "Results: all passed"; exit 0; fi
echo "Results: $FAIL check(s) failed"
exit 1
