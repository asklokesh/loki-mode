#!/usr/bin/env bash
# -h/--help on scripts/measure-run.sh and scripts/guard-changed.sh must print
# Usage on stdout, exit 0 and have no side effects (PO5-HELP-READONLY).
# Previously --help was read as a workspace path / a git base, and guard-changed
# went on to run suites. Real suites are never run from this test: the default
# base check uses a stubbed git on PATH that reports no changes.
# shellcheck disable=SC2015  # pass/fail helpers always return 0
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-help-readonly-scripts"

TMP="$(mktemp -d)" || exit 1
cleanup() {
    rm -f "$TMP/out" "$TMP/err" "$TMP/git-args" "$TMP/bin/git"
    rmdir "$TMP/bin" 2>/dev/null || true
    rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

for s in measure-run guard-changed; do
    for flag in --help -h; do
        timeout -k 5 20 bash "scripts/$s.sh" "$flag" >"$TMP/out" 2>"$TMP/err"; rc=$?
        [ "$rc" -eq 0 ] && pass "$s $flag exits 0" || fail "$s $flag exit $rc"
        grep -q '^Usage' "$TMP/out" && pass "$s $flag prints Usage on stdout" || fail "$s $flag no Usage on stdout"
        grep -q 'no events at' "$TMP/err" && fail "$s $flag treated as path" || pass "$s $flag not treated as path"
        if [ "$s" = guard-changed ]; then
            if grep -qE 'running|PASS  tests/|base=' "$TMP/out"; then
                fail "$s $flag ran selection or suites"
            else
                pass "$s $flag ran zero suites"
            fi
        fi
    done
done

# No-arg guard-changed still diffs against origin/main (stubbed git, no suites).
mkdir -p "$TMP/bin"
cat >"$TMP/bin/git" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$TMP/git-args"
exit 0
STUB
chmod +x "$TMP/bin/git"
PATH="$TMP/bin:$PATH" timeout -k 5 20 bash scripts/guard-changed.sh >"$TMP/out" 2>"$TMP/err"; rc=$?
[ "$rc" -eq 0 ] && pass "no-arg guard-changed exits 0 with stubbed git" || fail "no-arg exit $rc"
grep -q 'origin/main' "$TMP/out" && pass "no-arg output names origin/main" || fail "no-arg output lacks origin/main"
grep -q 'origin/main\.\.\.HEAD' "$TMP/git-args" 2>/dev/null && pass "no-arg diffs against origin/main...HEAD" || fail "no-arg did not diff against origin/main"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
