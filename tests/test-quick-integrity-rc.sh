#!/usr/bin/env bash
# A-118 / D47: _loki_quick_integrity_rc maps (inner rc, proof) to the quick exit code.
# Only a 0 with a failed tests_integrity item becomes 3; a non-zero rc is never lowered or
# changed; unproven gates and assertion edits alone keep 0. The function is extracted from
# run.sh so the real code is under test.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

sed -n '/^_loki_quick_integrity_rc() {$/,/^}$/p' "$REPO_ROOT/autonomy/run.sh" > "$T/fn.sh"
[ -s "$T/fn.sh" ] || { bad "function not found in run.sh"; echo "passed=$PASS failed=$FAIL"; exit 1; }
# shellcheck disable=SC1091
. "$T/fn.sh"

mk_proof() { # mk_proof <name> <degraded-json>
    mkdir -p "$T/$1/.loki/state" "$T/$1/.loki/proofs/p1"
    echo p1 > "$T/$1/.loki/state/last-proof-id.txt"
    printf '{"honesty":{"headline":"NOT VERIFIED","degraded":%s}}\n' "$2" > "$T/$1/.loki/proofs/p1/proof.json"
}
mk_proof failed '[{"item":"tests_integrity","status":"failed","reason":"tests weakened: skip added in sum.test.js"}]'
mk_proof unproven '[{"item":"build","status":"not_run"},{"item":"quality_gate:a","status":"not_run"},{"item":"quality_gate:b","status":"not_run"}]'
mk_proof edited '[{"item":"tests_integrity:assertions_edited","status":"inconclusive","post_headline":true}]'
mkdir -p "$T/none"

check() { # check <dir> <inner rc> <want> <label>
    local got
    got="$(TARGET_DIR="$T/$1" _loki_quick_integrity_rc "$2")"
    [ "$got" = "$3" ] && ok "$4" || bad "$4" "got=$got want=$3"
}
check failed 0 3 "inner rc 0 plus a failed tests_integrity item gives 3"
check failed 2 2 "inner rc 2 stays 2 even with a failed item"
check failed 1 1 "inner rc 1 stays 1"
check unproven 0 0 "honest run with 3 unproven gates keeps rc 0"
check edited 0 0 "assertion edits alone keep rc 0"
check none 0 0 "no proof keeps rc 0"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
