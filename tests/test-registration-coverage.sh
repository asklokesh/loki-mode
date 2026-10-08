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
# SCOPE: this scan also covers one level of subdirectories (tests/*/test-*.sh),
# not only tests/test-*.sh. Subdir suites are matched by their path relative to
# tests/ (for example cli/test-wiki-command.sh), so a same-named file elsewhere
# cannot mask an orphan. Today only tests/cli holds such suites.
#
# WHAT THIS ASSERTS: every tests/test-*.sh and tests/*/test-*.sh is referenced by at least one of the
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
    "$REPO_ROOT/.github/workflows/full-suite.yml"
)

# Files that are deliberately not registered, each with a reason. Keep this
# SHORT and justified: every entry is a guard nobody runs.
IGNORE=(
    # This gate runs the others; it is registered separately by name.
    "test-registration-coverage.sh"
    # D44-C: slow (over 60s), not failing; register once sharded.
    "test-magic-injection.sh"
    "test-magic-rarv.sh"
    "test-mirofish-integration.sh"
    "test-watch-command.sh"
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

# Whole-token match: the name must not be glued to a longer path component or
# file name on either side (so xcli/test-x.sh does not register cli/test-x.sh,
# and test-x.sh.bak / mytest-x.sh do not register test-x.sh). A leading "/" is
# allowed, so "$SCRIPT_DIR/test-x.sh" and "tests/test-x.sh" still match.
registered_in() {
    local runner="$1" name="$2" esc
    esc="$(printf '%s' "$name" | sed 's/[][\.*^$+?(){}|\/]/\\&/g')"
    grep -qE -- "(^|[^A-Za-z0-9_.-])${esc}(\$|[^A-Za-z0-9_.-]|\.([^A-Za-z0-9_]|\$))" "$runner" 2>/dev/null
}

registered() {
    local name="$1" r
    for r in "${RUNNERS[@]}"; do
        registered_in "$r" "$name" && return 0
    done
    return 1
}

# Self-tests: registered_in must match whole path tokens only.
_st_dir="$(mktemp -d)"
_st_run() { printf '%s\n' "$1" > "$_st_dir/r.sh"; registered_in "$_st_dir/r.sh" "$2"; }
if _st_run "run_test \"X\" \"\$SCRIPT_DIR/xcli/test-x.sh\"" "cli/test-x.sh"; then
    bad "self-test: xcli/test-x.sh wrongly registers cli/test-x.sh"; else ok "self-test: prefixed dir does not register"; fi
if _st_run "run_test \"X\" \"\$SCRIPT_DIR/cli/test-x.sh\"" "cli/test-x.sh"; then
    ok "self-test: exact path registers"; else bad "self-test: exact path not accepted"; fi
if _st_run "run_test \"X\" \"\$SCRIPT_DIR/test-x.sh\"" "test-x.sh" \
   && _st_run "bash tests/test-x.sh" "test-x.sh" \
   && _st_run "test-x.sh" "test-x.sh" \
   && _st_run "  - run: bash tests/test-x.sh && echo" "test-x.sh" \
   && _st_run "run_test \"X\" \"\$SCRIPT_DIR/test-x.sh\" 60" "test-x.sh"; then
    ok "self-test: real registration forms accepted"; else bad "self-test: a real registration form was rejected"; fi
if _st_run "run_test \"X\" \"\$SCRIPT_DIR/test-x.sh.bak\"" "test-x.sh" \
   || _st_run "run_test \"X\" \"\$SCRIPT_DIR/mytest-x.sh\"" "test-x.sh" \
   || _st_run "run_test \"X\" \"\$SCRIPT_DIR/test-x.shx\"" "test-x.sh"; then
    bad "self-test: near-miss name wrongly registered"; else ok "self-test: .bak/mytest-/.shx rejected"; fi
rm -f "$_st_dir/r.sh"; rmdir "$_st_dir"

total=0
orphans=()
for f in "$REPO_ROOT"/tests/test-*.sh "$REPO_ROOT"/tests/*/test-*.sh; do
    [ -f "$f" ] || continue
    name="${f#"$REPO_ROOT"/tests/}"
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
