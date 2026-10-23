#!/usr/bin/env bash
# Loki Mode -- the single guarded browser opener.
#
# Every place Loki opens a browser MUST go through loki_open_url. Tests and
# agent sessions must never pop a browser tab on a developer's machine (a
# test run once opened dozens of "Loki Mode" tabs at an offline dashboard).
# tests/test-browser-open-guard.sh fails if a raw opener call appears anywhere
# else.
#
# Public API:
#   loki_browser_allowed      -> 0 when a browser may be opened, 1 otherwise
#   loki_open_url <target>    -> 0 when an opener ran, 1 when suppressed or no
#                                opener exists (caller prints the URL instead)
#
# Suppressed when any of these hold:
#   LOKI_NO_BROWSER=1 or LOKI_NO_AUTO_OPEN=1 (explicit opt-out)
#   CI is set
#   LOKI_TEST, BATS_VERSION, BATS_TEST_FILENAME or PYTEST_CURRENT_TEST is set
#   stdout is not a TTY
#
# Call loki_open_url WITHOUT redirecting its stdout: the TTY check reads fd 1.
# The helper silences the opener itself.

if [ "${__LOKI_BROWSER_OPEN_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_BROWSER_OPEN_SH_LOADED=1

loki_browser_allowed() {
    [ "${LOKI_NO_BROWSER:-0}" = "1" ] && return 1
    [ "${LOKI_NO_AUTO_OPEN:-0}" = "1" ] && return 1
    [ -n "${CI:-}" ] && return 1
    [ -n "${LOKI_TEST:-}${BATS_VERSION:-}${BATS_TEST_FILENAME:-}${PYTEST_CURRENT_TEST:-}" ] && return 1
    [ -t 1 ] || return 1
    return 0
}

loki_open_url() {
    local target="$1"
    loki_browser_allowed || return 1
    if command -v open >/dev/null 2>&1; then
        open "$target" >/dev/null 2>&1
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$target" >/dev/null 2>&1
    elif command -v cmd.exe >/dev/null 2>&1; then
        # Windows (Git Bash/WSL): `start` is a cmd builtin; "" is its title arg.
        cmd.exe /c start "" "$target" >/dev/null 2>&1
    else
        return 1
    fi
}
