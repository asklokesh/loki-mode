#!/usr/bin/env bash
# PO5-HELP-INSTALL-HOOKS: scripts/install-hooks.sh must not mutate git config
# for --help or an unknown argument. The script is copied into a throwaway
# fixture repo; it is never run against the real repo.
# shellcheck disable=SC2015
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../scripts/install-hooks.sh"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-install-hooks.XXXXXX")" || exit 1
cleanup() {
    find "$WORK" -depth -delete 2>/dev/null || true
    find "$ISOLATED_GIT_HOME" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

# make_fixture <name>: fresh git repo holding a copy of the script and .githooks/
make_fixture() {
    local repo="$WORK/$1"
    mkdir -p "$repo/scripts" "$repo/.githooks" || return 1
    git -C "$repo" init -q || return 1
    cp "$SRC" "$repo/scripts/install-hooks.sh" || return 1
    : > "$repo/.githooks/pre-push"
    echo "$repo"
}

hooks_path() { git -C "$1" config --get core.hooksPath; }

# --help and -h
R="$(make_fixture help)" || exit 1
out="$(bash "$R/scripts/install-hooks.sh" --help 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "--help exits 0" || fail "--help exits 0 (rc=$rc)"
case "$out" in *Usage*) pass "--help prints Usage" ;; *) fail "--help prints Usage" ;; esac
hooks_path "$R" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && pass "--help leaves core.hooksPath unset" || fail "--help leaves core.hooksPath unset (rc=$rc)"
bash "$R/scripts/install-hooks.sh" -h >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && pass "-h exits 0" || fail "-h exits 0 (rc=$rc)"
hooks_path "$R" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && pass "-h leaves core.hooksPath unset" || fail "-h leaves core.hooksPath unset (rc=$rc)"

# unknown arg
R="$(make_fixture bad)" || exit 1
bash "$R/scripts/install-hooks.sh" --frobnicate >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && pass "unknown arg exits 2" || fail "unknown arg exits 2 (rc=$rc)"
hooks_path "$R" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && pass "unknown arg leaves core.hooksPath unset" || fail "unknown arg leaves core.hooksPath unset (rc=$rc)"

# no args: unchanged behaviour, idempotent
R="$(make_fixture plain)" || exit 1
bash "$R/scripts/install-hooks.sh" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && pass "no args exits 0" || fail "no args exits 0 (rc=$rc)"
[ "$(hooks_path "$R")" = ".githooks" ] && pass "no args sets core.hooksPath to .githooks" || fail "no args sets core.hooksPath to .githooks"
bash "$R/scripts/install-hooks.sh" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(hooks_path "$R")" = ".githooks" ]; then pass "second run is idempotent"; else fail "second run is idempotent"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
