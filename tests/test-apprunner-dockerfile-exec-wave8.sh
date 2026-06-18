#!/usr/bin/env bash
#
# test-apprunner-dockerfile-exec-wave8.sh
#
# Regression test for the WAVE8 app-runner HIGH-1 bug: the Dockerfile detection
# path builds an image with a COMPOUND method string
#   "docker build -t <img> . && docker run -d ... <img>"
# but the launcher prepended `exec` unconditionally:
#   bash -lc -- "<port-prefix>exec docker build ... && docker run ..."
# `exec docker build` replaces the shell, so `&& docker run` is NEVER reached.
# Image builds, no container starts, captured PID is the build process (dies),
# watchdog reports failed and rebuilds forever -> dead preview URL.
#
# The fix makes the `exec` prefix CONDITIONAL on the method being a SINGLE
# command (no &&/||/;). A compound method is launched WITHOUT exec so bash runs
# the full build+run sequence as a child.
#
# Why this test is NON-VACUOUS:
#   - It asserts the EXACT property that was broken: a compound method's launch
#     line must NOT start with `exec` (so both halves run), while a single
#     command's launch line MUST keep `exec` (so PID identity still works).
#   - Detection must run on the METHOD STRING ONLY, never the assembled line
#     (which always contains `;` from the PORT prefix + pgid echo). The
#     "single command WITH a port prefix" case guards exactly that regression:
#     against a naive assembled-string check it would FAIL (the `;` would mark
#     it compound and drop the exec), and against the original unconditional-exec
#     bug the compound case would FAIL (it would start with `exec`).
#
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_RUNNER_SH="$REPO_ROOT/autonomy/app-runner.sh"

PASS=0
FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Stub sibling-file log helpers before sourcing.
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_step()    { :; }
log_success() { :; }

# shellcheck disable=SC1090
source "$APP_RUNNER_SH"

#------------------------------------------------------------------------------
# 1. Unit: the conditional-exec helper, on the method string in isolation.
#------------------------------------------------------------------------------
single_npm=$(_app_runner_exec_prefix "npm start")
single_py=$(_app_runner_exec_prefix "python app.py")
compound_dockerfile=$(_app_runner_exec_prefix "docker build -t loki-app-abcd1234 . && docker run -d -p 3000:3000 --name loki-app-abcd1234 loki-app-abcd1234")
compound_or=$(_app_runner_exec_prefix "a || b")
compound_semi=$(_app_runner_exec_prefix "a ; b")
single_compose=$(_app_runner_exec_prefix "docker compose up -d")

if [ "$single_npm" = "exec " ]; then ok "single 'npm start' keeps exec"; else bad "single 'npm start' should keep exec, got [$single_npm]"; fi
if [ "$single_py" = "exec " ]; then ok "single 'python app.py' keeps exec"; else bad "single 'python app.py' should keep exec, got [$single_py]"; fi
if [ "$single_compose" = "exec " ]; then ok "single 'docker compose up -d' keeps exec"; else bad "compose up -d should keep exec, got [$single_compose]"; fi
if [ -z "$compound_dockerfile" ]; then ok "compound docker build && run drops exec"; else bad "compound dockerfile should drop exec, got [$compound_dockerfile]"; fi
if [ -z "$compound_or" ]; then ok "compound 'a || b' drops exec"; else bad "compound || should drop exec, got [$compound_or]"; fi
if [ -z "$compound_semi" ]; then ok "compound 'a ; b' drops exec"; else bad "compound ; should drop exec, got [$compound_semi]"; fi

#------------------------------------------------------------------------------
# 2. Assembly seam: build the SAME launch string the launcher builds and assert
#    the compound method does NOT start with exec while a single command does --
#    including a single command WITH a port prefix (the assembled-string trap).
#------------------------------------------------------------------------------
# Mirror the non-setsid launch-line assembly:
#   "${_port_env_prefix}${_exec_prefix}${method}"
build_launch_line() {
    local method="$1" port_prefix="$2" exec_prefix
    exec_prefix=$(_app_runner_exec_prefix "$method")
    printf '%s' "${port_prefix}${exec_prefix}${method}"
}

PORT_PREFIX="export PORT=3000 HTTP_PORT=3000 SERVER_PORT=3000 APP_PORT=3000; "
DOCKER_METHOD="docker build -t loki-app-abcd1234 . && docker run -d -p 3000:3000 --name loki-app-abcd1234 loki-app-abcd1234"

# Dockerfile is a docker method: no port prefix is exported for docker (the real
# launcher skips it for IS_DOCKER), so the launch line is just the method.
docker_line=$(build_launch_line "$DOCKER_METHOD" "")
case "$docker_line" in
    "exec "*) bad "compound Dockerfile launch line STARTS WITH exec (the bug): $docker_line" ;;
    *) ok "compound Dockerfile launch line does NOT start with exec" ;;
esac
# Prove the && run half is present and not short-circuited away in the string.
case "$docker_line" in
    *"&& docker run -d"*) ok "compound launch line still contains '&& docker run -d'" ;;
    *) bad "compound launch line lost the '&& docker run -d' half: $docker_line" ;;
esac

# Single command WITH a port prefix must STILL be exec'd. Against a buggy
# assembled-string detector (checking the whole line for ';') this fails, because
# the port prefix contributes a ';'.
npm_line=$(build_launch_line "npm start" "$PORT_PREFIX")
case "$npm_line" in
    "${PORT_PREFIX}exec "*) ok "single 'npm start' WITH port prefix stays exec'd" ;;
    *) bad "single 'npm start' with port prefix lost exec (assembled-string trap): $npm_line" ;;
esac

#------------------------------------------------------------------------------
# 3. The Dockerfile container liveness helper exists and is build-window aware:
#    when the container is not (yet) running but the wrapper PID is alive, it
#    must report alive (build in progress); when both are gone, dead.
#------------------------------------------------------------------------------
# No docker container running + a live PID (this test process via $$): alive.
_APP_RUNNER_DOCKER_CONTAINER="loki-app-doesnotexist-zzzz9999"
_APP_RUNNER_PID="$$"
if _app_runner_dockerfile_container_running; then
    ok "liveness: build-in-progress (no container yet, wrapper PID alive) -> alive"
else
    bad "liveness: live wrapper PID should count as build-in-progress alive"
fi

# No container + a dead PID: dead.
_APP_RUNNER_PID="999999"  # almost-certainly-unused PID
# Make sure it really is dead before asserting.
if ! kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
    if _app_runner_dockerfile_container_running; then
        bad "liveness: no container + dead wrapper PID should be dead, reported alive"
    else
        ok "liveness: no container + dead wrapper PID -> dead"
    fi
else
    echo "SKIP: PID 999999 unexpectedly in use; cannot assert dead case"
fi

#------------------------------------------------------------------------------
# 4. End-to-end (stubbed docker): app_runner_health_check's NEW Dockerfile branch
#    must report healthy when the container is running, and crashed when it is
#    not running AND the wrapper PID is dead. This is the path that previously
#    caused "watchdog rebuilds forever": the dead wrapper PID was read as crashed
#    even though the container was up.
#------------------------------------------------------------------------------
WORK4="$(mktemp -d "${TMPDIR:-/tmp}/loki-apprunner-df.XXXXXX")"
cleanup4() { rm -rf "$WORK4" 2>/dev/null || true; }
trap cleanup4 EXIT

# Point the health writers at an isolated dir.
_APP_RUNNER_DIR="$WORK4/.loki/app-runner"
mkdir -p "$_APP_RUNNER_DIR"
# Neutralize the dir-resolver so it does not clobber our isolated _APP_RUNNER_DIR.
_app_runner_dir() { mkdir -p "$_APP_RUNNER_DIR"; }

_APP_RUNNER_IS_DOCKER=true
_APP_RUNNER_DOCKER_CONTAINER="loki-app-stubbed-1234abcd"
_APP_RUNNER_METHOD="docker build -t loki-app-stubbed-1234abcd . && docker run -d -p 3000:3000 --name loki-app-stubbed-1234abcd loki-app-stubbed-1234abcd"
_APP_RUNNER_PORT=3000
_APP_RUNNER_PID="$$"   # alive but irrelevant; container stub decides

# Stub docker: report the container as running.
DOCKER_RUNNING=true
docker() {
    case "$1 $2" in
        "inspect -f")
            # docker inspect -f '{{.State.Running}}' <name>
            if [ "$DOCKER_RUNNING" = true ]; then echo "true"; else echo "false"; fi
            return 0
            ;;
    esac
    return 0
}

if app_runner_health_check; then
    health_val=$(grep -o '"ok"[^,}]*' "$_APP_RUNNER_DIR/health.json" 2>/dev/null || cat "$_APP_RUNNER_DIR/health.json" 2>/dev/null)
    ok "health_check: running container -> healthy (health.json: ${health_val})"
else
    bad "health_check: running container should be healthy"
fi

# Now: container NOT running and the wrapper PID dead -> crashed.
DOCKER_RUNNING=false
_APP_RUNNER_PID="999999"
if kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
    echo "SKIP: PID 999999 in use; cannot assert crashed case"
else
    if app_runner_health_check; then
        bad "health_check: stopped container + dead PID should be crashed, reported healthy"
    else
        ok "health_check: stopped container + dead wrapper PID -> crashed"
    fi
fi

#------------------------------------------------------------------------------
echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
