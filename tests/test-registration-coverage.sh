#!/usr/bin/env bash
# Test: every test suite is actually wired into a runner.
#
# An unregistered test is indistinguishable from no test. This is not a
# hypothetical tidiness concern -- it is the root cause of a class of bug that
# has shipped to users from this repo:
#
#   tests/test-provider-invocation.sh guards provider_invoke() argv construction
#   across all four providers. It existed, it passed, and it was wired into NO
#   runner. A hardcoded Codex model that ChatGPT accounts reject shipped through
#   exactly that surface. The guard was there the whole time; nothing ever
#   called it.
#
# At the time this gate was written, 179 of 353 test-*.sh files (roughly half
# the guard surface) ran nowhere. Registering them once is a cleanup; without a
# gate the surface silently re-rots, because nothing about adding a test file
# forces you to also register it.
#
# WHAT THIS ASSERTS: every tests/test-*.sh is referenced by at least one of the
# three runners (tests/run-all-tests.sh, scripts/local-ci.sh,
# .github/workflows/test.yml), or is explicitly listed in IGNORE below.
#
# ADDING A TEST: register it in a runner (usually run-all-tests.sh, which both
# local-ci.sh and test.yml execute). If a file is genuinely not a standalone
# suite -- a helper other tests source, or a fixture -- add it to IGNORE with a
# reason. IGNORE is the honest escape hatch; weakening the glob is not.
#
# This gate is itself registered in local-ci.sh and test.yml. A coverage gate
# that is not covered would be self-refuting.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNNERS=(
    "$REPO_ROOT/tests/run-all-tests.sh"
    "$REPO_ROOT/scripts/local-ci.sh"
    "$REPO_ROOT/.github/workflows/test.yml"
)

# Files that are deliberately not registered, each with a reason. Keep this
# SHORT and justified: every entry is a guard nobody runs.
IGNORE=(
    # This gate runs the others; it is registered separately by name.
    "test-registration-coverage.sh"
)

PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# Non-vacuity guard: if the runners cannot be read, every file would look
# unregistered (or nothing would be checked at all). Fail loudly instead.
for r in "${RUNNERS[@]}"; do
    if [ ! -f "$r" ]; then
        bad "runner not found: $r (cannot verify registration)"
        echo ""
        echo "Results: $PASS passed, $FAIL failed"
        exit 1
    fi
done

is_ignored() {
    local name="$1" ig
    for ig in "${IGNORE[@]}"; do
        [ "$name" = "$ig" ] && return 0
    done
    return 1
}

registered() {
    local name="$1" r
    for r in "${RUNNERS[@]}"; do
        grep -q -- "$name" "$r" 2>/dev/null && return 0
    done
    return 1
}

total=0
orphans=()
for f in "$REPO_ROOT"/tests/test-*.sh; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    is_ignored "$name" && continue
    total=$((total + 1))
    registered "$name" || orphans+=("$name")
done

# Sanity: the scan must have found a meaningful number of suites. A glob that
# silently matched nothing would make this gate pass vacuously forever.
if [ "$total" -lt 50 ]; then
    bad "only $total test files scanned; the glob is probably wrong (expected 100+)"
else
    ok "scanned $total test suites"
fi

if [ "${#orphans[@]}" -eq 0 ]; then
    ok "every test suite is registered in a runner"
else
    bad "${#orphans[@]} test suite(s) are registered in NO runner (they never execute):"
    for o in "${orphans[@]}"; do
        echo "         - tests/$o"
    done
    echo ""
    echo "         Fix: add a run_test line to tests/run-all-tests.sh, e.g."
    echo '           run_test "Descriptive Name" "$SCRIPT_DIR/'"${orphans[0]}"'"'
    echo "         Or, if it is a helper rather than a standalone suite, add it"
    echo "         to IGNORE in tests/test-registration-coverage.sh with a reason."
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
