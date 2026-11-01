#!/usr/bin/env bash
# Shared helpers for tests/min/*.sh. Source it; do not run it.
# Provides: ROOT, T (run-owned temp dir, removed on exit), ok, bad, finish.
# Hermetic by default: throwaway HOME, no telemetry, no update check, no
# inherited git hook/config environment.

set -uo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
    LOKI_LEGACY_BASH LOKI_TS_ENTRY BUN_FROM_SOURCE
export PYTHONDONTWRITEBYTECODE=1
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
    LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false LOKI_CONTROL=0 LOKI_DELEGATE_PR=0

_min_pass=0
_min_fail=0
_min_name="$(basename "${0:-test}" .sh)"

T="$(mktemp -d "${TMPDIR:-/tmp}/loki-min.XXXXXX")" || { echo "cannot create temp dir" >&2; exit 2; }
T="$(cd "$T" && pwd -P)"
_min_cleanup() {
    case "$T" in
        */loki-min.*) [ -d "$T" ] && [ ! -L "$T" ] && rm -rf -- "$T" ;;
    esac
}
trap _min_cleanup EXIT
mkdir -p "$T/home"
export HOME="$T/home"

ok()  { printf '  PASS: %s\n' "$1"; _min_pass=$((_min_pass + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; _min_fail=$((_min_fail + 1)); }

# check "description" <command...>: pass when the command exits 0.
check() {
    local d="$1"; shift
    if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}

# has "description" "text" "needle": pass when text contains the fixed needle.
has() {
    case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac
}

finish() {
    printf '%s: %s passed, %s failed\n' "$_min_name" "$_min_pass" "$_min_fail"
    [ "$_min_fail" -eq 0 ] && [ "$_min_pass" -gt 0 ]
}

need() {
    command -v "$1" >/dev/null 2>&1 || { echo "$_min_name: required tool missing: $1" >&2; exit 2; }
}

VERSION_NOW="$(tr -d '[:space:]' < "$ROOT/VERSION")"
