#!/usr/bin/env bash
# LOKI_LOG_LEVEL / --quiet must reduce output WITHOUT ever hiding a failure.
#
# WHY THIS EXISTS. `--quiet` was parsed by exactly two subcommands (github, wiki
# ask) and meant nothing to `loki start`, the command that actually produces the
# volume. There was no LOKI_LOG_LEVEL at all. A CI pipeline had no supported way
# to turn the noise down.
#
# MEASURED FIRST, because the survey correctly noted the TTY guards already do
# a lot: the HUD, completion card and start headline are `[ -t 1 ]`-gated and
# vanish off a TTY. What remained was 527 unguarded log_info/log_step calls,
# and only log_debug honored any variable. So the fix is a threshold at the five
# log functions -- not a logging framework, and not 527 edits.
#
# THE ASSERTION THAT MATTERS MOST IS THE LAST ONE. A verbosity control that can
# suppress the reason a build failed is a footgun. `error` is the floor: even
# the quietest setting prints errors.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Exercise the REAL functions by sourcing their definitions out of run.sh.
# Sourcing the whole file would execute the runner, so only the logging block
# is extracted -- a slice small enough to stay balanced (this repo's quoted
# heredocs make larger slices unparseable).
probe() {
    local level="$1" quiet="$2"
    env LOKI_LOG_LEVEL="$level" LOKI_QUIET="$quiet" bash -c '
        GREEN=""; YELLOW=""; RED=""; CYAN=""; NC=""
        eval "$(sed -n "/^_loki_log_threshold()/,/^log_step()/p" "$0")"
        log_info "INFO_MARKER"
        log_warn "WARN_MARKER"
        log_error "ERROR_MARKER"
        log_step "STEP_MARKER"
    ' "$RUN_SH" 2>&1
}

# Default: everything prints, so nothing regresses for an interactive user.
out="$(probe "" "")"
if printf '%s' "$out" | grep -q INFO_MARKER && printf '%s' "$out" | grep -q STEP_MARKER; then
    ok "default level prints [INFO] and [STEP] (no regression for interactive use)"
else
    bad "default level suppressed output it should not have"
fi

# warn: info and step go away, warnings stay.
out="$(probe warn "")"
if ! printf '%s' "$out" | grep -q INFO_MARKER && ! printf '%s' "$out" | grep -q STEP_MARKER; then
    ok "LOKI_LOG_LEVEL=warn suppresses [INFO] and [STEP]"
else
    bad "LOKI_LOG_LEVEL=warn did not suppress info/step output"
fi
if printf '%s' "$out" | grep -q WARN_MARKER; then
    ok "LOKI_LOG_LEVEL=warn still prints warnings"
else
    bad "LOKI_LOG_LEVEL=warn swallowed warnings"
fi

# LOKI_QUIET=1 is shorthand for warn.
out="$(probe "" 1)"
if ! printf '%s' "$out" | grep -q INFO_MARKER && printf '%s' "$out" | grep -q WARN_MARKER; then
    ok "LOKI_QUIET=1 behaves as warn"
else
    bad "LOKI_QUIET=1 did not behave as warn"
fi

# An unrecognized value must fall back to the default, never silence the run.
# A typo in a pipeline config should not blind the operator.
out="$(probe bogus "")"
if printf '%s' "$out" | grep -q INFO_MARKER; then
    ok "an unrecognized level falls back to the default rather than silencing"
else
    bad "an unrecognized level suppressed output -- a typo would blind an operator"
fi

# THE FLOOR. Errors print at every level, including the quietest.
for lvl in info warn error; do
    out="$(probe "$lvl" "")"
    if printf '%s' "$out" | grep -q ERROR_MARKER; then
        ok "errors still print at level '${lvl}'"
    else
        bad "level '${lvl}' suppressed an ERROR -- a quiet run could not say why it failed"
    fi
done

# The CLI surface: flags exist, are documented, and reject a bad value rather
# than silently ignoring it.
help_out="$("$LOKI" start --help </dev/null 2>&1 || true)"
case "$help_out" in
    *"--quiet"*) ok "start --help documents --quiet" ;;
    *) bad "--quiet is undocumented in start --help" ;;
esac
case "$help_out" in
    *"--log-level"*) ok "start --help documents --log-level" ;;
    *) bad "--log-level is undocumented in start --help" ;;
esac

bad_out="$("$LOKI" start --log-level nonsense </dev/null 2>&1 || true)"
case "$bad_out" in
    *"must be debug, info, warn, or error"*)
        ok "an invalid --log-level is rejected with a message naming the valid values" ;;
    *)
        bad "an invalid --log-level was accepted or failed without saying why" ;;
esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
