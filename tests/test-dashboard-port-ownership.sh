#!/usr/bin/env bash
# Regression: dashboard teardown signals only a positively identified PID-file owner.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-dashboard-owner.XXXXXXXX")"
ORIGINAL_HOME="${HOME:-}"
trap 'rm -rf -- "$WORK"' EXIT

mkdir -p "$WORK/home/.loki/dashboard" "$WORK/target"
export HOME="$WORK/home"
export TARGET_DIR="$WORK/target"
export SCRIPT_DIR="$ROOT/autonomy"
export PROJECT_DIR="$ROOT"
export LOKI_SKIP_PROJECT_REGISTRY=1
export DASHBOARD_PORT=59999

# Source only the two production functions under test. This avoids executing
# run.sh's top-level runner while keeping the test bound to the shipped bytes.
# shellcheck source=/dev/null
source <(sed -n '/^_loki_pid_looks_like_dashboard() {$/,/^}$/p' "$ROOT/autonomy/run.sh")
# shellcheck source=/dev/null
source <(sed -n '/^loki_mark_project_stopped_and_maybe_kill_shared_dashboard() {$/,/^}$/p' "$ROOT/autonomy/run.sh")
# shellcheck source=/dev/null
source <(sed -n '/^start_dashboard() {$/,/^}$/p' "$ROOT/autonomy/run.sh")

CALL_LOG="$WORK/signals.log"
PROBE_LOG="$WORK/probes.log"
PS_COMMAND=""

kill() {
    printf '%s\n' "$*" >>"$CALL_LOG"
}

sleep() { :; }

ps() {
    [ -n "$PS_COMMAND" ] && printf '%s\n' "$PS_COMMAND"
}

curl() {
    printf 'curl %s\n' "$*" >>"$PROBE_LOG"
    printf '404'
}

lsof() {
    printf 'lsof %s\n' "$*" >>"$PROBE_LOG"
    printf '7777\n'
}

reset_case() {
    : >"$CALL_LOG"
    : >"$PROBE_LOG"
    rm -f "$HOME/.loki/dashboard/dashboard.pid"
    PS_COMMAND=""
}

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

# No PID-file ownership: even a configured-port listener returning 404 is not
# probed or signalled by teardown.
reset_case
loki_mark_project_stopped_and_maybe_kill_shared_dashboard
[ ! -s "$CALL_LOG" ] || fail "absent ownership signalled a port listener"
[ ! -s "$PROBE_LOG" ] || fail "teardown treated a port probe as ownership"

# Forged PID ownership: a non-dashboard command cannot authorize a signal.
# The command is chosen to contain the loose tokens the guard used to accept
# ("loki", "uvicorn", and the exact "dashboard.server" module string), so this
# case goes red if identity is ever widened back to a substring match.
reset_case
printf '7777\n' >"$HOME/.loki/dashboard/dashboard.pid"
PS_COMMAND="uvicorn otherapp:app --port 59999 --note loki-dashboard.server-note"
loki_mark_project_stopped_and_maybe_kill_shared_dashboard
[ ! -s "$CALL_LOG" ] || fail "forged non-dashboard PID ownership was signalled"

# Missing process identity must fail closed rather than trusting the PID number.
reset_case
printf '8888\n' >"$HOME/.loki/dashboard/dashboard.pid"
loki_mark_project_stopped_and_maybe_kill_shared_dashboard
[ ! -s "$CALL_LOG" ] || fail "absent process identity was signalled"

# Positive PID-file plus exact dashboard command identity may be cleaned.
reset_case
printf '9999\n' >"$HOME/.loki/dashboard/dashboard.pid"
PS_COMMAND="/usr/bin/python3 -m dashboard.server"
loki_mark_project_stopped_and_maybe_kill_shared_dashboard
[ "$(wc -l <"$CALL_LOG" | tr -d ' ')" -eq 2 ] || fail "owned dashboard signal count changed"
sed -n '1p' "$CALL_LOG" | grep -qx '9999' || fail "owned dashboard did not receive TERM"
sed -n '2p' "$CALL_LOG" | grep -qx -- '-9 9999' || fail "owned dashboard did not receive KILL fallback"
[ ! -s "$PROBE_LOG" ] || fail "owned cleanup fell back to port authority"

export HOME="$ORIGINAL_HOME"

# Startup-path parity. The teardown path is not the only place that reclaimed
# the dashboard port: the port-selection loop killed any *python*/*uvicorn*
# holder that failed an HTTP probe, so an unrelated http.server answering 404
# was signalled as a "stuck dashboard". Both sites must route through the same
# identity guard. Assert on source with comments stripped, so the prose
# explaining the rule cannot satisfy the check.
# First exercise the production loop with a deterministic unrelated Python
# listener. It must exhaust its bounded port search without signalling the
# listener or probing it as though it were a Loki dashboard.
loki_background_services_enabled() { return 0; }
log_header() { :; }
log_info() { :; }
log_error() { :; }

reset_case
DASHBOARD_PORT=59999
PS_COMMAND="/usr/bin/python3 -m http.server 59999 --directory /tmp/dashboard.server"
if start_dashboard; then
    fail "startup unexpectedly found a free port in the occupied-port sentinel"
fi
[ ! -s "$CALL_LOG" ] || fail "startup signalled an unrelated Python listener"
! grep -q '^curl ' "$PROBE_LOG" || fail "startup probed an unrelated listener as Loki"

# Written to a file, not piped: `grep -q` closes the pipe on its first match,
# and under `pipefail` the dead writer's SIGPIPE (141) would invert the result
# of a grep that actually MATCHED.
STARTUP_SRC="$WORK/run-nocomments.sh"
sed "s/#.*//" "$ROOT/autonomy/run.sh" >"$STARTUP_SRC"
[ -s "$STARTUP_SRC" ] || fail "stripped run.sh source is empty (vacuous assertions)"

# shellcheck disable=SC2016  # matching the literal source text, not expanding it
grep -qF '_loki_pid_looks_like_dashboard "$existing_pid"' "$STARTUP_SRC" \
    || fail "startup port reclaim is not gated on the identity guard"

# shellcheck disable=SC2016  # matching the literal source text, not expanding it
! grep -qF '"$proc_cmd" == *python*' "$STARTUP_SRC" \
    || fail "startup reclaim still authorizes on a bare python/uvicorn comm match"

# No unguarded dashboard-port kill may remain on either path. Scoped to the
# dashboard port variables so the USAGE.md authoring instruction -- which tells
# a GENERATED project how to stop its own server -- is not mistaken for one.
! grep -qE 'lsof -ti:?"?\$\{?(_dash_port|DASHBOARD_PORT)' "$STARTUP_SRC" \
    || fail "an unguarded lsof-to-kill dashboard port reclaim is back"

printf 'PASS: absent/forged ownership preserved; proven dashboard PID cleaned; port probes unused; startup reclaim guarded\n'
