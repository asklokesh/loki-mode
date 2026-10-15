#!/usr/bin/env bash
# Exit-code contract (LM-006): the "Contract cases" table in docs/exit-codes.md is
# parsed and every row is executed against the real CLI. A row whose documented
# exit code differs from the observed one fails, as does a table row with no
# executor here and an executor with no table row.
#
# Cases cover empty diff, not a git repository, unknown flag and missing input for
# verify, run, quick, edit and start. All cases stop before any provider spend.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/bin/loki"
DOC="$REPO_ROOT/docs/exit-codes.md"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

loki_run_tmp_create() {
    local temp_root marker
    [ -z "${LOKI_RUN_TMP:-}" ] || return 64
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"
    chmod 700 "$LOKI_RUN_TMP" || return 1
    printf '%s\n' "$LOKI_RUN_TMP" >"$marker" && chmod 600 "$marker" || return 1
    export LOKI_RUN_TMP
}
loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
cleanup() {
    case "${LOKI_RUN_TMP:-}" in
        */loki-run.*) [ -f "$LOKI_RUN_TMP/.loki-run-owned" ] && rm -rf -- "$LOKI_RUN_TMP" ;;
    esac
}
trap cleanup EXIT

NOGIT="$LOKI_RUN_TMP/nogit"
REPO="$LOKI_RUN_TMP/repo"
mkdir -p "$NOGIT" "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
printf 'a\n' >"$REPO/a.txt"
git -C "$REPO" add a.txt
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q -m a

# Run the CLI in DIR with a scoped env and a hard timeout; echo the exit code.
rc_of() {
    local dir="$1"; shift
    ( cd "$dir" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_DURABLE_STATE -u LOKI_LEGACY_BASH \
        LOKI_NO_BROWSER=1 HOME="$LOKI_RUN_TMP" PATH="$PATH" timeout -k 5 60 "$LOKI" "$@" </dev/null >/dev/null 2>&1 )
    echo $?
}

run_case() {
    case "$1" in
        verify-empty-diff)    rc_of "$REPO" verify ;;
        verify-not-git)       rc_of "$NOGIT" verify ;;
        verify-unknown-flag)  rc_of "$REPO" verify --no-such-flag ;;
        run-unknown-flag)     rc_of "$REPO" run --no-such-flag ;;
        run-no-issue-ref)     rc_of "$NOGIT" run ;;
        quick-unknown-flag)   rc_of "$REPO" quick --no-such-flag ;;
        quick-no-task)        rc_of "$REPO" quick ;;
        quick-not-git)        rc_of "$NOGIT" quick fix the bug now ;;
        edit-unknown-flag)    rc_of "$REPO" edit --no-such-flag ;;
        edit-no-change)       rc_of "$REPO" edit ;;
        edit-not-git)         rc_of "$NOGIT" edit "change x" ;;
        start-unknown-flag)   rc_of "$REPO" start --no-such-flag ;;
        start-missing-prd)    rc_of "$REPO" start missing-prd.md ;;
        start-not-git)        rc_of "$NOGIT" start fix the bug now ;;
        *) echo "none" ;;
    esac
}

[ -f "$DOC" ] || { echo "FAIL: docs/exit-codes.md missing"; exit 1; }

# Rows look like: | `case-id` | `loki ...` | 64 | note |
documented="$(awk '/^## Contract cases/{on=1;next} /^## /{on=0} on && /^\| `/{
    id=$2; ex=$4; gsub(/[ `]/,"",id); gsub(/ /,"",ex); print id, ex }' FS='|' "$DOC")"

if [ -z "$documented" ]; then
    bad "docs/exit-codes.md has no parsable Contract cases table"
fi

seen=" "
while read -r id want; do
    [ -n "$id" ] || continue
    seen="$seen$id "
    got="$(run_case "$id")"
    if [ "$got" = "none" ]; then
        bad "$id: documented but has no executor in this test"
    elif [ "$got" = "$want" ]; then
        ok "$id: exit $got"
    else
        bad "$id: documented exit $want, observed $got"
    fi
done <<<"$documented"

for id in verify-empty-diff verify-not-git verify-unknown-flag run-unknown-flag run-no-issue-ref \
          quick-unknown-flag quick-no-task quick-not-git edit-unknown-flag edit-no-change edit-not-git \
          start-unknown-flag start-missing-prd start-not-git; do
    case "$seen" in
        *" $id "*) ;;
        *) bad "$id: executor exists but the doc table has no row" ;;
    esac
done

echo "exit-code contract: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
