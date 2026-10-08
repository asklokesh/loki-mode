#!/usr/bin/env bash
# tests/test-b9-fixture.sh -- scripts/b9-fixtures/trivial-sum.sh builds the B9 trivial fixture:
# node --test fails before the fix, exactly 3 tracked files, refuses a non-empty dir.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GEN="$SCRIPT_DIR/../scripts/b9-fixtures/trivial-sum.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1
FAILS=0
check() { # check name rc detail
    if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi
}
# expect_fail NAME RC DETAIL: passes when RC is nonzero.
expect_fail() {
    if [ "$2" -ne 0 ]; then check "$1" 0 ""; else check "$1" 1 "$3"; fi
}

D="$T/fx"
rc=0; bash "$GEN" "$D" > "$T/gen.log" 2>&1 || rc=$?
check "generator exits 0" "$rc" "$(cat "$T/gen.log")"

N=$(git -C "$D" ls-files | wc -l | tr -d ' ')
rc=0; [ "$N" = 3 ] || rc=1
check "exactly 3 tracked files" "$rc" "got $N"

rc=0; ( cd "$D" && timeout -k 10 120 node --test ) > "$T/before.log" 2>&1 || rc=$?
expect_fail "node --test fails before the fix" "$rc" "passed unexpectedly"

sed -i.bak 's/let i=1/let i=0/' "$D/sum.js" && rm -f "$D/sum.js.bak"
rc=0; ( cd "$D" && timeout -k 10 120 node --test ) > "$T/after.log" 2>&1 || rc=$?
check "node --test passes after the fix" "$rc" "$(tail -5 "$T/after.log")"

rc=0; bash "$GEN" "$D" > "$T/again.log" 2>&1 || rc=$?
expect_fail "refuses a non-empty existing dir" "$rc" "second run succeeded"

rc=0; bash "$GEN" > "$T/noarg.log" 2>&1 || rc=$?
expect_fail "requires an argument" "$rc" "no-arg run succeeded"

[ "$FAILS" -eq 0 ]
