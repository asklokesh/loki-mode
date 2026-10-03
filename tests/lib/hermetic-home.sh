# shellcheck shell=bash
# FC-07 / D86: tests never touch real user state. Source this from a test entry
# point (tests/run-all-tests.sh, scripts/local-ci.sh) BEFORE any suite runs:
#
#   . "$REPO_ROOT/tests/lib/hermetic-home.sh" && loki_hermetic_home_enter
#   trap 'loki_hermetic_home_leave' EXIT   # chain with the caller's own cleanup
#
# loki_hermetic_home_enter points HOME at a run-owned temp dir (same create and
# validated-cleanup pattern as the repo CLAUDE.md loki_run_tmp_*), seeds a git
# identity there (extends tests/lib/isolated-git-home.sh semantics), keeps the
# toolchain homes (bun, cargo, rustup, go, npm) pointed at their real
# locations, and exports:
#   LOKI_REAL_HOME       the HOME captured BEFORE isolation (read-only use only)
#   LOKI_HERMETIC_HOME   the run-owned dir (a nested entry point reuses it)
#
# It never exports LOKI_RUN_TMP: that name is reserved for each suite's own
# loki_run_tmp_create, and an exported value makes every child refuse (E-154).
# Requires eval/loki10/lib-tmp.sh to be sourced already.

loki_hermetic_home_enter() {
    # Nested entry point (local-ci -> runner -> suite): reuse, never own.
    if [ -n "${LOKI_HERMETIC_HOME:-}" ] && [ -d "$LOKI_HERMETIC_HOME" ] && [ "${HOME:-}" = "$LOKI_HERMETIC_HOME" ]; then
        return 0
    fi

    # The real home is always the CURRENT HOME here (not hermetic, checked above). An
    # inherited LOKI_REAL_HOME is never trusted: a nested sandbox whose HOME was reset
    # would otherwise aim "real" at the founder's home (FC-07 round 2).
    unset LOKI_REAL_HOME
    local real_home="${HOME:-}" saved_tmp="${LOKI_RUN_TMP:-}" had_tmp=0 dir rc=0
    [ -n "${LOKI_RUN_TMP+x}" ] && had_tmp=1
    [ -n "$real_home" ] || return 1

    # Keep toolchains on their real homes so isolation never forces a re-download.
    export BUN_INSTALL="${BUN_INSTALL:-$real_home/.bun}"
    export CARGO_HOME="${CARGO_HOME:-$real_home/.cargo}"
    export RUSTUP_HOME="${RUSTUP_HOME:-$real_home/.rustup}"
    export GOPATH="${GOPATH:-$real_home/go}"
    export npm_config_cache="${npm_config_cache:-$real_home/.npm}"
    # Provider CLI logins (doctor and auth preflights read them, read-only in practice).
    if [ -z "${CODEX_HOME:-}" ] && [ -d "$real_home/.codex" ]; then export CODEX_HOME="$real_home/.codex"; fi
    export DOCKER_CONFIG="${DOCKER_CONFIG:-$real_home/.docker}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$real_home/.cache}"
    export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$real_home/.cache/pip}"
    if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
        if [ -d "$real_home/Library/Caches/ms-playwright" ]; then
            export PLAYWRIGHT_BROWSERS_PATH="$real_home/Library/Caches/ms-playwright"
        elif [ -d "$real_home/.cache/ms-playwright" ]; then
            export PLAYWRIGHT_BROWSERS_PATH="$real_home/.cache/ms-playwright"
        fi
    fi

    unset LOKI_RUN_TMP
    loki_run_tmp_create || rc=$?
    dir="${LOKI_RUN_TMP:-}"
    unset LOKI_RUN_TMP
    if [ "$had_tmp" = "1" ]; then LOKI_RUN_TMP="$saved_tmp"; fi
    [ "$rc" -eq 0 ] && [ -n "$dir" ] || return 1

    mkdir -p "$dir/home" || return 1
    printf '%s\n' "$dir" >"$dir/home/.loki-hermetic-root"
    export LOKI_REAL_HOME="$real_home"
    export LOKI_HERMETIC_HOME="$dir/home"
    _LOKI_HERMETIC_ROOT="$dir"
    export HOME="$LOKI_HERMETIC_HOME"
    export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
    # The python user site (fastapi, pydantic) is HOME-relative and version-specific
    # (macOS ~/Library/Python/3.x, Linux ~/.local/lib/python3.x): link just those library
    # trees so every interpreter still finds its packages. Never ~/.loki.
    if [ -d "$real_home/Library/Python" ]; then
        mkdir -p "$HOME/Library" && ln -s "$real_home/Library/Python" "$HOME/Library/Python"
    fi
    if [ -d "$real_home/.local/lib" ]; then
        mkdir -p "$HOME/.local" && ln -s "$real_home/.local/lib" "$HOME/.local/lib"
    fi
    # The Claude CLI login (doctor and auth preflights call `claude auth status`) is keyed by
    # the real HOME; under a temp HOME an installed CLI reads as logged out and every
    # doctor-driven suite changes verdict. A shim runs the real binary with the real HOME, so
    # only the CLI itself (never loki code, never ~/.loki) sees it.
    local real_claude
    real_claude="$(command -v claude 2>/dev/null || true)"
    if [ -n "$real_claude" ]; then
        mkdir -p "$dir/shims" || return 1
        printf '#!/bin/sh\nHOME=%s exec %s "$@"\n' "'$real_home'" "'$real_claude'" >"$dir/shims/claude" || return 1
        chmod 700 "$dir/shims/claude" || return 1
        export PATH="$dir/shims:$PATH"
    fi
    printf '[user]\n\tname = loki-test\n\temail = loki-test@example.invalid\n' >"$GIT_CONFIG_GLOBAL" || return 1
}

# Removes only the dir this shell created, through the validated cleanup helper.
# Safe to call when nothing was entered or when the dir belongs to a parent.
loki_hermetic_home_leave() {
    [ -n "${_LOKI_HERMETIC_ROOT:-}" ] || return 0
    local root="$_LOKI_HERMETIC_ROOT" saved_tmp="${LOKI_RUN_TMP:-}" had_tmp=0
    [ -n "${LOKI_RUN_TMP+x}" ] && had_tmp=1
    LOKI_RUN_TMP="$root"
    loki_run_tmp_cleanup || true
    unset LOKI_RUN_TMP
    if [ "$had_tmp" = "1" ]; then LOKI_RUN_TMP="$saved_tmp"; fi
    unset _LOKI_HERMETIC_ROOT
}
