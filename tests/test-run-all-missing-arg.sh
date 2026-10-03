#!/usr/bin/env bash
# S-174: a bad run_test registration must count as ONE failure and let every
# later suite run, with the summary printed.
#
# Before the fix: `run_test "X"` died on "$2: unbound variable" (no summary,
# every later suite skipped), `run_test "X" ""` passed as `bash -c ""`, and a
# missing script returned 1, which set -e turned into the end of the run.
#
# No copy of run_test lives here: sed pulls the real runner's prelude (which
# defines run_test) and its real summary block out of tests/run-all-tests.sh,
# and each leg splices one bad line plus a passing stub between them.
# LOKI_RUN_ALL_RUNNER points it at another runner (the mutation proof).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="${LOKI_RUN_ALL_RUNNER:-$SCRIPT_DIR/run-all-tests.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-missing-arg-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# Runner copies resolve REPO_ROOT to $WORK: give them the hermetic-HOME lib and lib-tmp
# the real runner requires (FC-07). Fixtures keep the guard intact instead of bypassing it.
mkdir -p "$WORK/tests" "$WORK/eval/loki10"
cp -R "$SCRIPT_DIR/lib" "$WORK/tests/lib"
cp "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh" "$WORK/eval/loki10/"

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: run_test with a missing or empty argument does not stop the runner"

prelude="$(sed -n '1,/^# Run all tests$/p' "$RUNNER")"
summary="$(sed -n '/^# Summary$/,$p' "$RUNNER")"
case "$prelude" in *'run_test() {'*) ;; *) bad "prelude extraction found no run_test"; exit 1 ;; esac
case "$summary" in *'Failed:'*) ;; *) bad "summary extraction found no Failed: line"; exit 1 ;; esac

printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/stub.sh"

run_leg() {
    local leg="$1" bad_line="$2" dir out rc
    dir="$WORK/$leg"
    mkdir -p "$dir"
    cp "$WORK/stub.sh" "$dir/stub.sh"
    printf '%s\n%s\n%s\n%s\n' "$prelude" "$bad_line" \
        'run_test "Stub After" "$SCRIPT_DIR/stub.sh"' "$summary" > "$dir/run-all-tests.sh"
    rc=0
    out="$(cd "$dir" && env -u LOKI_TEST_SHARD -u LOKI_TEST_LIST LOKI_TEST_SUITE_TIMEOUT=30 \
        bash "$dir/run-all-tests.sh" 2>&1)" || rc=$?
    out="$(printf '%s\n' "$out" | sed $'s/\033\\[[0-9;]*m//g')"

    [ "$rc" -eq 1 ] && ok "$leg: runner exits 1" || bad "$leg: runner exit $rc (want 1)"
    if printf '%s\n' "$out" | grep -qE '^Failed: +1$'; then
        ok "$leg: summary prints Failed: 1"
    else
        bad "$leg: no 'Failed: 1' in summary"
        printf '%s\n' "$out" | tail -15 | sed 's/^/    | /'
    fi
    local bad_at stub_at
    bad_at="$(printf '%s\n' "$out" | grep -n 'Bad Leg' | head -1 | cut -d: -f1)"
    stub_at="$(printf '%s\n' "$out" | grep -n 'Stub After PASSED' | head -1 | cut -d: -f1)"
    if [ -n "$bad_at" ] && [ -n "$stub_at" ] && [ "$stub_at" -gt "$bad_at" ]; then
        ok "$leg: stub PASSED line follows the bad line"
    else
        bad "$leg: stub PASSED line missing or not after the bad line (bad=${bad_at:-none} stub=${stub_at:-none})"
    fi
}

# shellcheck disable=SC2016  # $SCRIPT_DIR expands inside the generated runner
run_leg one-arg 'run_test "Bad Leg one-arg"'
run_leg empty-arg 'run_test "Bad Leg empty-arg" ""'
# shellcheck disable=SC2016
run_leg missing-script 'run_test "Bad Leg missing-script" "$SCRIPT_DIR/does-not-exist.sh"'

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
