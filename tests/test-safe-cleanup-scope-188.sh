#!/usr/bin/env bash
# Regression for run-owned cleanup guidance in root CLAUDE.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLAUDE_FILE="${ROOT}/CLAUDE.md"
TEMP_ROOT="$(cd /tmp && pwd -P)"
export TMPDIR="$TEMP_ROOT"
HARNESS_DIR=""
UNRELATED_WORKTREE=""
OWNED_DIR=""

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

cleanup_fixture() {
    set +e
    for target in "$OWNED_DIR" "$UNRELATED_WORKTREE" "$HARNESS_DIR"; do
        [ -n "$target" ] || continue
        case "$target" in
            "${TEMP_ROOT}"/loki-run.* | "${TEMP_ROOT}"/loki-cleanup-scope-188.*)
                rm -rf -- "$target"
                ;;
            *)
                printf 'Refusing fixture cleanup outside exact test namespaces: %s\n' "$target" >&2
                ;;
        esac
    done
}
trap cleanup_fixture EXIT

[ -f "$CLAUDE_FILE" ] || fail "root CLAUDE.md is missing"
if grep -F 'rm -rf /tmp/loki-' "$CLAUDE_FILE" >/dev/null; then
    fail "broad /tmp cleanup guidance remains"
fi
if grep -F 'rm -rf /tmp/test-' "$CLAUDE_FILE" >/dev/null; then
    fail "broad test-temp cleanup guidance remains"
fi

HARNESS_DIR="$(mktemp -d "${TEMP_ROOT}/loki-cleanup-scope-188.XXXXXXXX")"
HELPERS="${HARNESS_DIR}/helpers.sh"
awk '
    /^<!-- BEGIN LOKI_RUN_TMP_HELPERS -->$/ { capture = 1; next }
    /^<!-- END LOKI_RUN_TMP_HELPERS -->$/ { exit }
    capture && $0 !~ /^\`\`\`/ { print }
' "$CLAUDE_FILE" >"$HELPERS"
[ -s "$HELPERS" ] || fail "safe cleanup helper block was not extracted"
bash -n "$HELPERS" || fail "safe cleanup helper block has invalid shell syntax"
# shellcheck source=/dev/null
source "$HELPERS"

# This is an unrelated Git worktree whose name deliberately matches the
# run-owned namespace and whose marker is forged. The .git guard must still
# make cleanup fail closed.
UNRELATED_WORKTREE="$(mktemp -d "${TEMP_ROOT}/loki-run.unrelated-scope-188.XXXXXXXX")"
git init -q "$UNRELATED_WORKTREE"
printf '%s\n' "unrelated-worktree-must-survive" >"${UNRELATED_WORKTREE}/sentinel"
printf '%s\n' "$UNRELATED_WORKTREE" >"${UNRELATED_WORKTREE}/.loki-run-owned"
chmod 600 "${UNRELATED_WORKTREE}/.loki-run-owned"

LOKI_RUN_TMP="$UNRELATED_WORKTREE"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted an unrelated Git worktree"
fi
[ -d "${UNRELATED_WORKTREE}/.git" ] || fail "unrelated Git metadata was removed"
grep -qx 'unrelated-worktree-must-survive' "${UNRELATED_WORKTREE}/sentinel" ||
    fail "unrelated sentinel was changed"
unset LOKI_RUN_TMP

loki_run_tmp_create
OWNED_DIR="$LOKI_RUN_TMP"
printf '%s\n' "owned-payload" >"${OWNED_DIR}/payload"
loki_run_tmp_cleanup

[ ! -e "$OWNED_DIR" ] || fail "explicit run-owned temp directory survived cleanup"
[ -d "${UNRELATED_WORKTREE}/.git" ] || fail "unrelated worktree did not survive owned cleanup"
grep -qx 'unrelated-worktree-must-survive' "${UNRELATED_WORKTREE}/sentinel" ||
    fail "unrelated sentinel did not survive owned cleanup"

printf '%s\n' "PASS: explicit run-owned temp removed; unrelated /tmp/loki-* worktree survived"
