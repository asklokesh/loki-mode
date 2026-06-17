#!/usr/bin/env bash
#===============================================================================
# App Runner Module (v5.45.0)
#
# Detects, starts, restarts, and monitors user applications during autonomous
# Loki Mode sessions. Auto-restarts on code changes, provides health checks,
# and integrates with the dashboard and completion council.
#
# Functions:
#   app_runner_init()            - Detect app type and prerequisites
#   app_runner_start()           - Start the detected application
#   app_runner_stop()            - Stop the running application
#   app_runner_restart()         - Restart (stop + start)
#   app_runner_health_check()    - Check if app is healthy (HTTP or PID)
#   app_runner_should_restart()  - Check if code changes warrant restart
#   app_runner_cleanup()         - Full cleanup on session exit
#   app_runner_status()          - One-line status for prompt injection
#   app_runner_watchdog()        - Auto-restart on crash (with circuit breaker)
#
# Environment Variables:
#   LOKI_APP_RUNNER              - Enable/disable (default: true)
#   LOKI_APP_RUNNER_ENABLED      - Alias for LOKI_APP_RUNNER
#   LOKI_APP_PORT                - Override detected port
#   LOKI_APP_COMMAND             - Override app start command
#
# Data:
#   .loki/app-runner/state.json       - App state
#   .loki/app-runner/app.pid          - Process ID
#   .loki/app-runner/app.log          - Application stdout/stderr
#   .loki/app-runner/health.json      - Last health check
#   .loki/app-runner/detection.json   - Detection results
#
#===============================================================================

# Configuration
APP_RUNNER_ENABLED="${LOKI_APP_RUNNER:-${LOKI_APP_RUNNER_ENABLED:-true}}"

# Internal state
_APP_RUNNER_DIR=""
_APP_RUNNER_METHOD=""
_APP_RUNNER_PORT=""
_APP_RUNNER_PID=""
_APP_RUNNER_URL=""
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_DOCKER_CONTAINER=""
# v7.26.0 (Phase 4): the identified primary web service of a compose project,
# used for service-aware health checks and the preview URL. Empty for
# non-compose runs or when identification falls back to legacy port parsing.
_APP_RUNNER_WEB_SERVICE=""
_APP_RUNNER_HAS_SETSID=false
_APP_RUNNER_CRASH_COUNT=0
_APP_RUNNER_RESTART_COUNT=0
_GIT_DIFF_HASH=""
_APP_LOG_MAX_LINES=10000

#===============================================================================
# Internal Helpers
#===============================================================================

_app_runner_dir() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    _APP_RUNNER_DIR="$loki_dir/app-runner"
    mkdir -p "$_APP_RUNNER_DIR"
}

# Escape a string for safe JSON embedding (handles quotes, backslashes, newlines)
_json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr -d '\n'
}

# Validate a command string: reject shell metacharacters that enable injection.
#
# Trust contract:
#   - $_APP_RUNNER_METHOD is either (a) auto-detected by app_runner_init from a
#     fixed set of internal templates (npm run dev, docker compose up -d, etc.)
#     or (b) supplied verbatim by the operator via the LOKI_APP_COMMAND env
#     variable. Auto-detected strings are trusted; LOKI_APP_COMMAND is an
#     external operator-controlled input that may be set in CI, .envrc, or by
#     a hostile parent process.
#   - This validator is the only line of defense for the LOKI_APP_COMMAND path.
#     It runs BEFORE the value is assigned to _APP_RUNNER_METHOD and BEFORE
#     it is interpolated into `bash -lc -- "$_APP_RUNNER_METHOD"` at startup.
#   - Allow only a strict whitelist: A-Z a-z 0-9 _ . / - = and a single ASCII
#     space (0x20). Tabs, newlines, glob, redirects, command separators, and
#     command substitution are all rejected.
_validate_app_command() {
    local cmd="$1"
    # Strict whitelist: alphanumerics, underscore, dot, slash, hyphen, equals,
    # and ASCII space. Anything else (including tabs, newlines, ;, |, &, <, >,
    # $, `, (, ), {, }, [, ], *, ?, ~, ", ', \) is rejected.
    if [[ ! "$cmd" =~ ^[A-Za-z0-9_./=\ -]+$ ]]; then
        log_error "App Runner: command rejected (only [A-Za-z0-9_./= -] allowed): $cmd"
        return 1
    fi
    # Belt-and-braces: also explicitly reject the legacy injection set so a
    # future regex regression cannot silently re-allow these.
    if echo "$cmd" | grep -qE '[;|`$]|&&|\|\||>>|<<'; then
        log_error "App Runner: command rejected (unsafe characters): $cmd"
        return 1
    fi
    return 0
}

# Atomic JSON write: write to temp then mv
_write_app_state() {
    local tmp_file
    tmp_file="$_APP_RUNNER_DIR/state.json.tmp.$$"
    local method_escaped
    method_escaped=$(_json_escape "${_APP_RUNNER_METHOD}")
    local url_escaped
    url_escaped=$(_json_escape "${_APP_RUNNER_URL}")
    # v7.51.x: persist the identified primary web service so app-runner-managed
    # compose runs expose the SAME field the dashboard's compose-stack discovery
    # synthesizes (primary_service). Empty for non-compose runs (the global is
    # only set for compose), which is additive and harmless: the field is present
    # but blank, never absent, so consumers can read it uniformly.
    local primary_service_escaped
    primary_service_escaped=$(_json_escape "${_APP_RUNNER_WEB_SERVICE}")
    cat > "$tmp_file" << APPSTATE_EOF
{
    "main_pid": ${_APP_RUNNER_PID:-0},
    "process_group": "-${_APP_RUNNER_PID:-0}",
    "method": "${method_escaped}",
    "primary_service": "${primary_service_escaped}",
    "port": $(echo "${_APP_RUNNER_PORT:-0}" | grep -oE '^[0-9]+$' || echo 0),
    "url": "${url_escaped}",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "restart_count": ${_APP_RUNNER_RESTART_COUNT},
    "status": "$(_json_escape "${1:-unknown}")",
    "last_health": $(cat "$_APP_RUNNER_DIR/health.json" 2>/dev/null | grep -E '^\s*\{.*\}\s*$' || echo '{"ok": false}'),
    "crash_count": ${_APP_RUNNER_CRASH_COUNT}
}
APPSTATE_EOF
    mv "$tmp_file" "$_APP_RUNNER_DIR/state.json"
}

_write_health() {
    local ok="$1"
    local tmp_file
    tmp_file="$_APP_RUNNER_DIR/health.json.tmp.$$"
    cat > "$tmp_file" << HEALTH_EOF
{"ok": ${ok}, "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
HEALTH_EOF
    mv "$tmp_file" "$_APP_RUNNER_DIR/health.json"
}

# L5 fix (PID-file reuse race): capture a disambiguating identity token for a
# live PID, so a later liveness check can tell "our app is still running" apart
# from "the OS reassigned the crashed app's PID to an unrelated process". A raw
# `kill -0 $pid` cannot make that distinction: a reused PID reports a foreign
# process as a healthy app.
#
# Token = the process start time (`lstart`) plus its command name (`comm`), one
# line, read from `ps`. `lstart` is the strong disambiguator: it is constant for
# a process lifetime and a reused PID is, by definition, a different (later)
# process with a different start time. `comm` is a weaker secondary signal kept
# for human readability. We compare the whole line by plain string equality.
#
# Portability: the `ps -o lstart=,comm=` field set works on both BSD (macOS) and
# GNU/Linux. We never parse the format -- we only ever compare two reads taken on
# the SAME host (capture at start vs read at check), so the BSD-vs-Linux format
# difference is irrelevant: the two strings either match or they do not. Returns
# empty on any `ps` miss (dead/foreign pid) so callers can fall back safely.
_app_runner_pid_token() {
    local pid="$1"
    case "$pid" in
        ''|0|1) return 0 ;;
    esac
    [[ "$pid" =~ ^[0-9]+$ ]] || return 0
    # Collapse internal whitespace runs to single spaces so a benign formatting
    # quirk (e.g. extra padding) never causes a spurious mismatch.
    ps -o lstart=,comm= -p "$pid" 2>/dev/null | tr -s ' ' ' ' | sed 's/^ *//; s/ *$//'
}

# Write the captured identity token for the current app PID. Best-effort: if the
# token cannot be read (no ps output) we remove any stale token file rather than
# leave a wrong one, which makes the later check fall back to trusting kill -0
# (no false-DEAD regression).
_write_app_token() {
    local pid="$1"
    local tok
    tok=$(_app_runner_pid_token "$pid")
    if [ -n "$tok" ]; then
        local tmp_file="$_APP_RUNNER_DIR/app.token.tmp.$$"
        printf '%s\n' "$tok" > "$tmp_file" 2>/dev/null && \
            mv "$tmp_file" "$_APP_RUNNER_DIR/app.token" 2>/dev/null || \
            rm -f "$tmp_file" 2>/dev/null
    else
        rm -f "$_APP_RUNNER_DIR/app.token" 2>/dev/null
    fi
}

# Decide whether the live PID is still OUR app, using the captured token.
# Returns 0 (yes, ours) when:
#   - no token file exists (app launched by a pre-fix version, or ps was
#     unavailable at start) -- fall back to trusting kill -0, OR
#   - the live PID's token matches the stored token.
# Returns 1 (NOT ours) ONLY when a token file exists AND the live token differs
# (the strong "PID was reused by a foreign process" signal). This asymmetry is
# deliberate: we never declare DEAD on a missing/unreadable token, so a
# legitimate still-running app is never falsely killed (no false-DEAD
# regression). The residual: if `ps` is entirely unavailable on the host, the
# token file is never written and we always fall back to bare kill -0 -- i.e. no
# worse than the pre-fix behavior, never worse.
_app_runner_pid_is_ours() {
    local pid="$1"
    local token_file="$_APP_RUNNER_DIR/app.token"
    [ -f "$token_file" ] || return 0
    local stored live
    stored=$(cat "$token_file" 2>/dev/null)
    [ -n "$stored" ] || return 0
    live=$(_app_runner_pid_token "$pid")
    [ -n "$live" ] || return 0
    [ "$live" = "$stored" ]
}

# Re-derive a detection.json field (type/command) so we can rewrite it after a
# port reconcile without threading those values through globals. Echoes the raw
# string value (empty on miss). Mirrors the grep-based read style used by
# app_runner_status.
_read_detection_field() {
    local field="$1"
    [ -f "$_APP_RUNNER_DIR/detection.json" ] || return 0
    grep -o "\"${field}\": *\"[^\"]*\"" "$_APP_RUNNER_DIR/detection.json" 2>/dev/null \
        | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Rewrite detection.json with the reconciled port, preserving type/command.
_rewrite_detection_port() {
    local d_type d_command
    d_type=$(_read_detection_field "type")
    d_command=$(_read_detection_field "command")
    [ -n "$d_type" ] || return 0
    _write_detection "$d_type" "$d_command"
}

# Collect the transitive descendant tree of a PID (children, grandchildren, ...).
#
# Echoes one PID per line, deepest-LAST is NOT guaranteed; order is breadth-first
# from the root. The root PID itself is NOT included. Used by the non-setsid stop
# fallback (BUG 1): the app is started as `( ... ) &` WITHOUT setsid, so on stock
# macOS the whole tree (subshell -> bash -lc -> npm -> sh -> node -> workers)
# inherits the ORCHESTRATOR's process group. A `kill -- -PGID` would therefore
# signal run.sh and the Claude agent driving it (self-termination), so we MUST
# walk parent->child links from OUR pid only. This guarantees we never signal a
# process outside our own subtree: every returned pid has our root as an ancestor.
#
# Snapshot semantics: the caller MUST collect the full tree BEFORE sending any
# signal. If we TERM top-down while walking, grandchildren reparent to init and
# `pgrep -P <dead-parent>` returns nothing, re-creating the orphaned-worker bug
# this fix exists to close.
_app_runner_collect_descendants() {
    local root="$1"
    # Guard against empty / init / kernel pids: walking from 0/1 would sweep
    # unrelated processes. A valid app pid is always > 1.
    case "$root" in
        ''|0|1) return 0 ;;
    esac
    if ! [[ "$root" =~ ^[0-9]+$ ]]; then
        return 0
    fi

    local -a frontier=("$root")
    local -a found=()
    local pid child
    local -a kids
    # Bound iterations defensively against a pathological/looping tree.
    local guard=0
    while [ "${#frontier[@]}" -gt 0 ] && [ "$guard" -lt 10000 ]; do
        guard=$(( guard + 1 ))
        pid="${frontier[0]}"
        frontier=("${frontier[@]:1}")
        # Direct children of pid.
        kids=()
        while IFS= read -r child; do
            [ -n "$child" ] && kids+=("$child")
        done < <(pgrep -P "$pid" 2>/dev/null)
        local k
        for k in "${kids[@]:-}"; do
            [ -n "$k" ] || continue
            found+=("$k")
            frontier+=("$k")
        done
    done

    local f
    for f in "${found[@]:-}"; do
        [ -n "$f" ] && printf '%s\n' "$f"
    done
}

# Signal an EXPLICIT, pre-captured set of PIDs with a given signal.
#
# Usage: _app_runner_signal_pids <SIGNAL> <pid> [pid ...]
#
# Why an explicit list and not "(re-)walk from root": a worker that traps
# SIGTERM (a Node server doing graceful shutdown is the textbook case) survives
# the TERM phase while its intermediate ancestors (npm, sh) die. Once the
# ancestors die, the surviving worker reparents to init, so re-deriving the tree
# from the now-dead root via `pgrep -P` would return NOTHING -- the KILL phase
# would be skipped and the orphaned, port-holding worker would live on. That is
# exactly the orphaned-worker bug (BUG 1) resurfacing at the force-kill phase.
# The fix: the caller snapshots root + all descendants ONCE before any signal,
# and every phase (TERM, aliveness, KILL) operates over that frozen list.
#
# Safety: the caller builds the list from _app_runner_collect_descendants, which
# only ever follows parent->child links from OUR pid, so the list can never
# contain a process outside our own subtree. We signal pids individually (never
# a process group) because in the non-setsid path the app inherits the
# orchestrator's process group; a group signal would kill run.sh and the agent.
# Pids are signaled in REVERSE capture order so descendants (captured after the
# root) are signaled before the root.
_app_runner_signal_pids() {
    local sig="$1"; shift
    local -a pids=("$@")
    local i p
    for (( i=${#pids[@]}-1; i>=0; i-- )); do
        p="${pids[$i]}"
        case "$p" in
            ''|0|1) continue ;;
        esac
        kill "-${sig}" "$p" 2>/dev/null || true
    done
}

# True (0) if ANY pid in the EXPLICIT pre-captured list is still alive.
# Used by the non-setsid stop grace-wait so a deep worker that outlived the main
# subshell does not let us fall through to "stopped" prematurely. Operates over
# the frozen snapshot for the same reason _app_runner_signal_pids does.
_app_runner_any_alive() {
    local p
    for p in "$@"; do
        case "$p" in
            ''|0|1) continue ;;
        esac
        if kill -0 "$p" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

# Fix #2 (finding #597): reconcile the recorded port with the port the app
# ACTUALLY bound, using the listen line in app.log as the source of truth. This
# corrects the dashboard Live Preview even when the app ignores PORT and picks
# its own port. Bounded poll: returns as soon as a listen line is found, and
# never runs for docker (compose URLs come from published-port mapping) or when
# no port was recorded. Default window LOKI_APP_PORT_RECONCILE_SECS (default 12)
# at 0.5s intervals. On no match within the window the recorded port is kept (no
# regression). Stdout: nothing; mutates _APP_RUNNER_PORT / _APP_RUNNER_URL and
# rewrites state.json + detection.json only when the real port differs.
_app_runner_reconcile_port() {
    [ "$_APP_RUNNER_IS_DOCKER" != true ] || return 0
    [ -n "$_APP_RUNNER_PORT" ] && [ "$_APP_RUNNER_PORT" -gt 0 ] 2>/dev/null || return 0
    local log_file="$_APP_RUNNER_DIR/app.log"

    # Fast path: if the recorded port already serves HTTP, the app honored our
    # chosen port (fix #1 worked) or otherwise bound it -- nothing to reconcile,
    # and we avoid the poll latency entirely. Covers quiet-but-serving apps that
    # never log a recognizable listen line.
    if command -v curl >/dev/null 2>&1 && \
       curl -sf -o /dev/null -m 2 "http://localhost:${_APP_RUNNER_PORT}/" 2>/dev/null; then
        return 0
    fi

    local max_secs="${LOKI_APP_PORT_RECONCILE_SECS:-12}"
    [[ "$max_secs" =~ ^[0-9]+$ ]] || max_secs=12
    local max_iter=$(( max_secs * 2 ))
    [ "$max_iter" -gt 0 ] || max_iter=1

    local real_port="" iter=0
    while [ "$iter" -lt "$max_iter" ]; do
        if [ -f "$log_file" ]; then
            real_port=$(_parse_listen_port "$log_file")
            [ -n "$real_port" ] && break
        fi
        # Stop early if the process already died (failed start): nothing to wait for.
        if [ -n "$_APP_RUNNER_PID" ] && ! kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
            break
        fi
        sleep 0.5
        iter=$(( iter + 1 ))
    done

    # No serving keyword line in the log: the app may sit behind a reverse proxy
    # or bind quietly on a port we did not choose. Probe app-scoped candidate
    # ports for a real listener and surface only a port that ACTUALLY responds
    # (never fabricate a URL for a dead port). Conservative: app-scoped candidates
    # only, no blind well-known-port scan. See _probe_app_url.
    if [ -z "$real_port" ]; then
        local probed
        probed=$(_probe_app_url "$_APP_RUNNER_PORT")
        if [ -n "$probed" ]; then
            local probed_port="${probed##*:}"
            if [ "$probed_port" != "$_APP_RUNNER_PORT" ]; then
                log_info "App Runner: surfaced live port $probed_port via probe (reverse-proxy/quiet-bind); recorded was $_APP_RUNNER_PORT"
                _APP_RUNNER_PORT="$probed_port"
                _APP_RUNNER_URL="$probed"
                _rewrite_detection_port
            fi
        fi
        return 0
    fi

    [ -n "$real_port" ] || return 0
    if [ "$real_port" != "$_APP_RUNNER_PORT" ]; then
        # Liveness guard: only overwrite the recorded port when the reconciled
        # port ACTUALLY serves HTTP. A log line can name a non-serving port (a
        # metrics endpoint like ":9464" or a DB connection like ":5432") emitted
        # after the real serving URL; committing that would clobber a correct
        # recorded port and point the preview at a dead port. We deliberately do
        # NOT use curl -f: any HTTP response (including 404/401/500) proves a
        # server is bound and serving on that port (Spring Boot whitelabel 404,
        # REST-only roots, and auth-gated "/" all return non-2xx but ARE live).
        # A dead/unbound port produces a connection error, which curl reports as
        # a non-zero exit even without -f. If curl is unavailable we cannot
        # verify, so fall back to the prior behavior and commit the parsed port
        # (no regression on curl-less hosts).
        if command -v curl >/dev/null 2>&1; then
            if ! curl -s -o /dev/null -m 2 "http://localhost:${real_port}/" 2>/dev/null; then
                log_info "App Runner: skipped reconcile to port $real_port (no HTTP response); keeping recorded port $_APP_RUNNER_PORT"
                return 0
            fi
        fi
        log_info "App Runner: reconciled port $_APP_RUNNER_PORT -> $real_port (from app.log listen line)"
        _APP_RUNNER_PORT="$real_port"
        _APP_RUNNER_URL="http://localhost:${real_port}"
        _rewrite_detection_port
    fi
    return 0
}

# Parse the actual bound port from an app log file. Scans known listen-line
# shapes in priority order and returns the LAST (most recent) plausible port,
# tolerating ANSI color codes that dev servers emit. Validates 1-65535. Echoes
# the port or nothing.
#
# Tiers 1 and 2 are restricted to lines that ALSO carry a serving keyword
# (listen|running|ready|started|serving|server|local) so that non-serving noise
# such as a DB connection string ("Connecting to database on port 5432") or an
# outbound URL does not win. Note: a metrics endpoint line like
# "Prometheus metrics server listening on http://0.0.0.0:9464" DOES carry
# serving keywords ("server"/"listening") and so can still be returned here; the
# reconcile caller liveness-verifies the parsed port before committing it, which
# is the layer that rejects a non-serving metrics/DB port.
_SERVING_KEYWORDS='listen|running|ready|started|serving|server|local'
_parse_listen_port() {
    local file="$1"
    [ -f "$file" ] || return 0
    # Strip ANSI SGR sequences (\e[...m) so color-wrapped URLs still match.
    local clean
    clean=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "$file" 2>/dev/null) || clean=$(cat "$file" 2>/dev/null)
    [ -n "$clean" ] || return 0

    # Restrict candidate lines to those carrying a serving keyword. This drops
    # DB-connection and outbound-URL noise before any port extraction.
    local serving
    serving=$(printf '%s\n' "$clean" | grep -iE "$_SERVING_KEYWORDS")

    local candidate=""
    # 1) Explicit URL with a port: http://host:PORT  (most reliable).
    candidate=$(printf '%s\n' "$serving" \
        | grep -oiE 'https?://[a-z0-9.\-]+:[0-9]{1,5}' \
        | grep -oE ':[0-9]{1,5}' | tr -d ':' | tail -1)
    # 2a) Spring Boot form: "Tomcat started on port(s): 8081". The literal
    #     "(s):" breaks the generic port[ =:]+ scan below, so match it first.
    if [ -z "$candidate" ]; then
        candidate=$(printf '%s\n' "$serving" \
            | grep -ioE 'port\(s\):[ ]*[0-9]{1,5}' \
            | grep -oE '[0-9]{1,5}' | tail -1)
    fi
    # 2b) A number anchored to the literal word "port": "port 8080", "port=3000",
    #    "port: 5000". This runs BEFORE the bare host:port scan so a clock-style
    #    timestamp on the same line (e.g. "12:30:45 ... port 8080") cannot win.
    if [ -z "$candidate" ]; then
        candidate=$(printf '%s\n' "$serving" \
            | grep -ioE 'port[ =:]+[0-9]{1,5}' \
            | grep -oE '[0-9]{1,5}' | tail -1)
    fi
    # 3) Keyword listen lines with a real host token before the colon:
    #    "localhost:5173", "0.0.0.0:8080", "127.0.0.1:3000". Requiring a letter
    #    or a dot immediately left of the colon excludes "HH:MM" timestamps,
    #    which have a digit there.
    if [ -z "$candidate" ]; then
        candidate=$(printf '%s\n' "$serving" \
            | grep -oiE '[a-z.][a-z0-9.\-]*:[0-9]{1,5}' \
            | grep -oE ':[0-9]{1,5}' | tr -d ':' | tail -1)
    fi

    [ -n "$candidate" ] || return 0
    # Validate range 1-65535.
    if [ "$candidate" -ge 1 ] 2>/dev/null && [ "$candidate" -le 65535 ] 2>/dev/null; then
        printf '%s\n' "$candidate"
    fi
}

# Rotate app.log if it exceeds max lines
_rotate_app_log() {
    local log_file="$_APP_RUNNER_DIR/app.log"
    if [ -f "$log_file" ]; then
        local line_count
        line_count=$(wc -l < "$log_file" 2>/dev/null || echo 0)
        if [ "$line_count" -gt "$_APP_LOG_MAX_LINES" ]; then
            local keep=$(( _APP_LOG_MAX_LINES / 2 ))
            tail -n "$keep" "$log_file" > "$log_file.tmp.$$"
            mv "$log_file.tmp.$$" "$log_file"
        fi
    fi
}

# Identify the primary web service of a docker compose project and its
# published host port. Uses `docker compose config --format json` (fully
# resolved: env-interpolated, overrides merged) parsed with python3, so we do
# NOT hand-parse YAML. Precedence MATCHES the contract in COMPOSE_INSTRUCTION
# (run.sh build_prompt): (1) label loki.primary=true, (2) service named
# web/app, (3) service publishing a common web port, (4) first service with any
# published port. Echoes "service_name|published_port" on success, nothing on
# failure (caller falls back to legacy behavior). Never hard-fails.
# v7.26.0 (Phase 4): fixes the multi-service URL/health gaps (GAP #1-4).
_identify_compose_web_service() {
    local base="${1:-${TARGET_DIR:-.}}"
    local compose_dir
    compose_dir=$(_app_runner_compose_dir "$base")
    command -v docker >/dev/null 2>&1 || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    local cfg
    cfg=$(cd "$compose_dir" && docker compose config --format json 2>/dev/null) || return 0
    [ -n "$cfg" ] || return 0
    printf '%s' "$cfg" | python3 -c '
import json, sys
COMMON = ["3000", "8000", "8080", "5000", "4200", "5173", "80"]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
services = d.get("services", {})
if not isinstance(services, dict) or not services:
    sys.exit(0)

def published_ports(svc):
    out = []
    for p in (svc.get("ports") or []):
        if isinstance(p, dict):
            pub = p.get("published")
        else:
            pub = None
        if pub is not None and str(pub).strip():
            out.append(str(pub).strip())
    return out

# (1) label loki.primary=true
for name, svc in services.items():
    labels = svc.get("labels") or {}
    if isinstance(labels, list):
        labels = dict(x.split("=", 1) for x in labels if "=" in x)
    if str(labels.get("loki.primary", "")).lower() == "true":
        pp = published_ports(svc)
        if pp:
            print(name + "|" + pp[0]); sys.exit(0)
# (2) service named web/app
for cand in ("web", "app"):
    svc = services.get(cand)
    if svc:
        pp = published_ports(svc)
        if pp:
            print(cand + "|" + pp[0]); sys.exit(0)
# (3) service publishing a common web port
for name, svc in services.items():
    pp = published_ports(svc)
    for cp in COMMON:
        if cp in pp:
            print(name + "|" + cp); sys.exit(0)
# (4) first service with any published port
for name, svc in services.items():
    pp = published_ports(svc)
    if pp:
        print(name + "|" + pp[0]); sys.exit(0)
sys.exit(0)
' 2>/dev/null || return 0
}

# Detect a Next.js standalone build (next.config output: 'standalone'). A
# standalone build emits a self-contained `.next/standalone/server.js` that is
# launched with `node server.js` (NOT `next start`) and listens on PORT (default
# 3000). The presence of `.next/standalone/server.js` is a specific, safe signal:
# a normal `.next/` build does NOT create that path, so this never false-positives
# on an ordinary Next.js project. Echoes the run method (relative to TARGET_DIR,
# which the launcher cd's into) on success, nothing otherwise. The run method is
# `node .next/standalone/server.js`; modern Next standalone resolves its asset
# paths from the server.js __dirname, not cwd, so a TARGET_DIR-relative launch is
# correct without an extra chdir. The `output: 'standalone'` next.config grep is
# a weaker secondary signal (the build may not have run yet); the built artifact
# path is authoritative, which is why we key on the file existing.
_detect_nextjs_standalone() {
    local dir="${1:-${TARGET_DIR:-.}}"
    if [ -f "$dir/.next/standalone/server.js" ]; then
        printf 'node .next/standalone/server.js\n'
        return 0
    fi
    return 0
}

# Probe app-scoped candidate ports for a live HTTP listener and echo the first
# port that actually responds, nothing if none do. This handles the case where
# the app sits behind a reverse proxy or otherwise binds a port we did not
# choose: rather than fabricate a URL for a port nothing is listening on, we
# verify liveness with a real HTTP probe before surfacing anything.
#
# Conservatism, in order of importance:
#   - Candidates are APP-SCOPED only (PORT env, the recorded port, and the
#     framework default passed by the caller). We deliberately do NOT blind-scan
#     well-known ports like 80/443/8080, because some unrelated local service
#     answering there is its own form of fabrication.
#   - Liveness uses the same contract as _app_runner_reconcile_port (curl -s
#     -o /dev/null -m 2, no -f): any HTTP response (incl. 404/401/500) proves a
#     server is bound; a connection error (dead/unbound port) is a non-zero exit.
#   - curl-less hosts cannot verify, so we surface NOTHING (we never guess a URL
#     we could not probe). This is the conservative direction for this helper:
#     its whole job is "probe before surfacing", so no curl == no claim.
# Args: $1 = framework default port (may be empty). Reads $LOKI_APP_PORT and
# $_APP_RUNNER_PORT from the environment as additional candidates.
_probe_app_url() {
    local default_port="$1"
    command -v curl >/dev/null 2>&1 || return 0
    local cand seen=" "
    for cand in "${LOKI_APP_PORT:-}" "${_APP_RUNNER_PORT:-}" "$default_port"; do
        [ -n "$cand" ] || continue
        [[ "$cand" =~ ^[0-9]+$ ]] || continue
        [ "$cand" -ge 1 ] 2>/dev/null && [ "$cand" -le 65535 ] 2>/dev/null || continue
        case "$seen" in *" $cand "*) continue ;; esac
        seen="$seen$cand "
        if curl -s -o /dev/null -m 2 "http://localhost:${cand}/" 2>/dev/null; then
            printf 'http://localhost:%s\n' "$cand"
            return 0
        fi
    done
    return 0
}

# Detect port from project files
_detect_port() {
    local method="$1"

    # User override takes priority
    if [ -n "${LOKI_APP_PORT:-}" ]; then
        _APP_RUNNER_PORT="$LOKI_APP_PORT"
        return
    fi

    case "$method" in
        *docker\ compose*)
            # v7.26.0: identify the PRIMARY WEB service and ITS published port
            # via docker compose config (resolved JSON), so the preview URL and
            # health check target the web service, not whichever port (e.g. a
            # db/cache) appears first in the file. Falls back to the legacy
            # first-port grep when docker/python is unavailable or no web
            # service is found.
            local web_info web_port
            web_info=$(_identify_compose_web_service "${TARGET_DIR:-.}")
            if [ -n "$web_info" ]; then
                _APP_RUNNER_WEB_SERVICE="${web_info%%|*}"
                web_port="${web_info##*|}"
            fi
            if [ -n "${web_port:-}" ] && [[ "$web_port" =~ ^[0-9]+$ ]]; then
                _APP_RUNNER_PORT="$web_port"
            else
                # Legacy fallback: first published port from the compose file.
                local compose_file
                if [ -f "${TARGET_DIR:-.}/docker-compose.yml" ]; then
                    compose_file="${TARGET_DIR:-.}/docker-compose.yml"
                else
                    compose_file="${TARGET_DIR:-.}/compose.yml"
                fi
                local port
                # Handle both simple (HOST:CONTAINER) and IP-bound (IP:HOST:CONTAINER) port formats
                # Also handle port ranges like "8080-8090:8080-8090" by taking the first port
                port=$(grep -E '^\s*-\s*"?[0-9]' "$compose_file" 2>/dev/null | head -1 | sed 's/.*- *"*//;s/".*//;' | awk -F: '{print $(NF-1)}' | awk -F- '{print $1}')
                _APP_RUNNER_PORT="${port:-8080}"
            fi
            ;;
        *docker\ build*)
            local port
            port=$(grep -i '^EXPOSE' "${TARGET_DIR:-.}/Dockerfile" 2>/dev/null | head -1 | awk '{print $2}')
            _APP_RUNNER_PORT="${port:-8080}"
            ;;
        *npm*)
            # Check .env for PORT, then common defaults
            if [ -f "${TARGET_DIR:-.}/.env" ]; then
                local port
                port=$(grep -E '^PORT=' "${TARGET_DIR:-.}/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'")
                if [ -n "$port" ]; then
                    _APP_RUNNER_PORT="$port"
                    return
                fi
            fi
            # Check for Vite (5173), Astro (4321), or default Node (3000)
            if grep -q '"vite"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
                _APP_RUNNER_PORT=5173
            elif grep -q '"astro"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
                _APP_RUNNER_PORT=4321
            else
                _APP_RUNNER_PORT=3000
            fi
            ;;
        *manage.py*)
            _APP_RUNNER_PORT=8000
            ;;
        *flask*|*app.py*)
            _APP_RUNNER_PORT=5000
            ;;
        *uvicorn*|*fastapi*|*main.py*)
            _APP_RUNNER_PORT=8000
            ;;
        *cargo*)
            _APP_RUNNER_PORT=8080
            ;;
        *go\ run*)
            _APP_RUNNER_PORT=8080
            ;;
        *make*)
            _APP_RUNNER_PORT=8080
            ;;
        *)
            _APP_RUNNER_PORT=8080
            ;;
    esac
}

#===============================================================================
# Detection
#===============================================================================

app_runner_init() {
    if [ "$APP_RUNNER_ENABLED" != "true" ]; then
        return 1
    fi

    _app_runner_dir
    local dir="${TARGET_DIR:-.}"
    _APP_RUNNER_METHOD=""
    _APP_RUNNER_IS_DOCKER=false

    # User command override (validated for safety)
    if [ -n "${LOKI_APP_COMMAND:-}" ]; then
        if ! _validate_app_command "$LOKI_APP_COMMAND"; then
            log_error "App Runner: LOKI_APP_COMMAND rejected due to unsafe characters"
            return 1
        fi
        _APP_RUNNER_METHOD="$LOKI_APP_COMMAND"
        _detect_port "$_APP_RUNNER_METHOD"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        log_info "App Runner: using override command: $_APP_RUNNER_METHOD"
        _write_detection "override" "$_APP_RUNNER_METHOD"
        return 0
    fi

    # Detection cascade
    # 1. docker-compose.yml / compose.yml
    if [ -f "$dir/docker-compose.yml" ] || [ -f "$dir/compose.yml" ]; then
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
            _APP_RUNNER_METHOD="docker compose up -d"
            _APP_RUNNER_IS_DOCKER=true
            _detect_port "$_APP_RUNNER_METHOD"
            _write_detection "docker-compose" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected Docker Compose project"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        else
            log_warn "App Runner: docker-compose.yml found but Docker is not running"
        fi
    fi

    # 2. Dockerfile
    if [ -f "$dir/Dockerfile" ]; then
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
            _detect_port "docker build"
            # Include project hash in container name to avoid collisions across projects
            local _project_hash
            _project_hash=$(echo "$dir" | (md5sum 2>/dev/null || md5 -r 2>/dev/null || echo "$$") | cut -c1-8)
            _APP_RUNNER_DOCKER_CONTAINER="loki-app-${_project_hash}"
            _APP_RUNNER_METHOD="docker build -t loki-app . && docker run -d -p ${_APP_RUNNER_PORT}:${_APP_RUNNER_PORT} --name ${_APP_RUNNER_DOCKER_CONTAINER} loki-app"
            _APP_RUNNER_IS_DOCKER=true
            _write_detection "dockerfile" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected Dockerfile"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        else
            log_warn "App Runner: Dockerfile found but Docker is not running"
        fi
    fi

    # 3-4. package.json (dev or start)
    if [ -f "$dir/package.json" ]; then
        _install_node_deps "$dir"
        # 3a. Next.js standalone build (output: 'standalone'). The built artifact
        #     `.next/standalone/server.js` is a stronger signal than the dev/start
        #     scripts: when present, the app is launched with `node server.js`
        #     (listens on PORT, default 3000) rather than `next dev`/`next start`.
        local njs_method
        njs_method=$(_detect_nextjs_standalone "$dir")
        if [ -n "$njs_method" ]; then
            _APP_RUNNER_METHOD="$njs_method"
            _detect_port "npm"
            _write_detection "nextjs-standalone" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected Next.js standalone server"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        fi
        if grep -q '"dev"' "$dir/package.json" 2>/dev/null; then
            _APP_RUNNER_METHOD="npm run dev"
            _detect_port "$_APP_RUNNER_METHOD"
            _write_detection "npm-dev" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected npm run dev"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        elif grep -q '"start"' "$dir/package.json" 2>/dev/null; then
            _APP_RUNNER_METHOD="npm start"
            _detect_port "$_APP_RUNNER_METHOD"
            _write_detection "npm-start" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected npm start"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        fi
    fi

    # 5. Makefile with run or serve target
    if [ -f "$dir/Makefile" ]; then
        if grep -qE '^(run|serve):' "$dir/Makefile" 2>/dev/null; then
            local target
            if grep -qE '^run:' "$dir/Makefile" 2>/dev/null; then
                target="run"
            else
                target="serve"
            fi
            _APP_RUNNER_METHOD="make $target"
            _detect_port "$_APP_RUNNER_METHOD"
            _write_detection "makefile" "$_APP_RUNNER_METHOD"
            log_info "App Runner: detected Makefile target '$target'"
            _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
            return 0
        fi
    fi

    # 6. Django manage.py
    if [ -f "$dir/manage.py" ]; then
        _install_python_deps "$dir"
        _APP_RUNNER_METHOD="python manage.py runserver"
        _detect_port "$_APP_RUNNER_METHOD"
        _write_detection "django" "$_APP_RUNNER_METHOD"
        log_info "App Runner: detected Django project"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        return 0
    fi

    # 7. Flask/FastAPI (app.py or main.py)
    if [ -f "$dir/app.py" ]; then
        _install_python_deps "$dir"
        if grep -qE 'from\s+fastapi|import\s+FastAPI' "$dir/app.py" 2>/dev/null; then
            _APP_RUNNER_METHOD="uvicorn app:app --host 0.0.0.0 --port 8000 --reload"
            _detect_port "fastapi"
        elif grep -qE 'from\s+flask|import\s+Flask' "$dir/app.py" 2>/dev/null; then
            _APP_RUNNER_METHOD="flask run --host 0.0.0.0 --port 5000"
            _detect_port "flask"
        else
            _APP_RUNNER_METHOD="python app.py"
            _detect_port "app.py"
        fi
        _write_detection "python-app" "$_APP_RUNNER_METHOD"
        log_info "App Runner: detected app.py"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        return 0
    fi

    if [ -f "$dir/main.py" ]; then
        _install_python_deps "$dir"
        if grep -qE 'from\s+fastapi|import\s+FastAPI' "$dir/main.py" 2>/dev/null; then
            _APP_RUNNER_METHOD="uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
            _detect_port "fastapi"
        else
            _APP_RUNNER_METHOD="python main.py"
            _detect_port "main.py"
        fi
        _write_detection "python-main" "$_APP_RUNNER_METHOD"
        log_info "App Runner: detected main.py"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        return 0
    fi

    # 8. Rust Cargo.toml
    if [ -f "$dir/Cargo.toml" ]; then
        _APP_RUNNER_METHOD="cargo run"
        _detect_port "$_APP_RUNNER_METHOD"
        _write_detection "cargo" "$_APP_RUNNER_METHOD"
        log_info "App Runner: detected Cargo.toml"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        return 0
    fi

    # 9. Go module with main.go
    if [ -f "$dir/go.mod" ] && [ -f "$dir/main.go" ]; then
        _APP_RUNNER_METHOD="go run ."
        _detect_port "$_APP_RUNNER_METHOD"
        _write_detection "go" "$_APP_RUNNER_METHOD"
        log_info "App Runner: detected Go project"
        _APP_RUNNER_URL="http://localhost:${_APP_RUNNER_PORT}"
        return 0
    fi

    # 10. Fallback: nothing detected
    log_warn "App Runner: no application detected, continuing without app runner"
    _write_detection "none" ""
    return 1
}

_write_detection() {
    local type="$1"
    local command="$2"
    local tmp_file="$_APP_RUNNER_DIR/detection.json.tmp.$$"
    local type_escaped
    type_escaped=$(_json_escape "$type")
    local command_escaped
    command_escaped=$(_json_escape "$command")
    cat > "$tmp_file" << DETECT_EOF
{
    "type": "${type_escaped}",
    "command": "${command_escaped}",
    "port": $(echo "${_APP_RUNNER_PORT:-0}" | grep -oE '^[0-9]+$' || echo 0),
    "is_docker": ${_APP_RUNNER_IS_DOCKER},
    "detected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
DETECT_EOF
    mv "$tmp_file" "$_APP_RUNNER_DIR/detection.json"
}

# Install node dependencies if missing
_install_node_deps() {
    local dir="$1"
    if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
        log_step "App Runner: installing node dependencies..."
        (cd "$dir" && npm install >> "$_APP_RUNNER_DIR/app.log" 2>&1) || \
            log_warn "App Runner: npm install failed, app may not start"
    fi
}

# Install Python dependencies in background
_install_python_deps() {
    local dir="$1"
    if [ -f "$dir/requirements.txt" ]; then
        log_step "App Runner: installing Python dependencies..."
        (cd "$dir" && pip install -r requirements.txt >> "$_APP_RUNNER_DIR/app.log" 2>&1) || \
            log_warn "App Runner: pip install failed, app may not start"
    fi
}

# Resolve the directory containing the compose file. Falls back to the passed
# directory when no compose file is found (callers should already have verified
# detection). Honors LOKI_COMPOSE_FILE override.
_app_runner_compose_dir() {
    local base="${1:-${TARGET_DIR:-.}}"
    if [ -n "${LOKI_COMPOSE_FILE:-}" ] && [ -f "${LOKI_COMPOSE_FILE}" ]; then
        dirname "${LOKI_COMPOSE_FILE}"
        return
    fi
    for candidate in \
        "$base/docker-compose.yml" \
        "$base/docker-compose.yaml" \
        "$base/compose.yml" \
        "$base/compose.yaml"; do
        if [ -f "$candidate" ]; then
            dirname "$candidate"
            return
        fi
    done
    printf '%s\n' "$base"
}

# Count containers currently in the "running" state for the compose project.
# Polls up to LOKI_COMPOSE_HEALTH_TIMEOUT seconds (default 30) at 1s intervals
# so containers transitioning from Created -> Running are not falsely reported
# as failed. Echoes the final running-container count (0 on failure).
_app_runner_compose_running_count() {
    local base="${1:-${TARGET_DIR:-.}}"
    local compose_dir
    compose_dir=$(_app_runner_compose_dir "$base")
    local timeout="${LOKI_COMPOSE_HEALTH_TIMEOUT:-30}"
    if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
        timeout=30
    fi
    local elapsed=0
    local count=0
    while [ "$elapsed" -lt "$timeout" ]; do
        # Prefer the structured --format '{{.State}}' which lists one state per
        # container (one per line) and is stable across docker-compose v2.x.
        local states
        states=$(cd "$compose_dir" && docker compose ps --format '{{.State}}' 2>/dev/null || true)
        if [ -n "$states" ]; then
            # Match exact "running" lines only (case-insensitive). Avoid grep -c
            # on empty input which can return 0 with success even when nothing
            # ran. Also strip CR for safety on weird terminals.
            count=$(printf '%s\n' "$states" | tr -d '\r' | grep -ciE '^running$' || true)
        else
            count=0
        fi
        if [ "${count:-0}" -gt 0 ]; then
            printf '%s\n' "$count"
            return 0
        fi
        sleep 1
        elapsed=$(( elapsed + 1 ))
    done
    printf '%s\n' "${count:-0}"
    return 0
}

# Read the RUNTIME published host port of the identified primary web service from
# `docker compose ps` (the live mapping), as opposed to the config-declared port
# from `docker compose config`. The config port is correct for fixed mappings
# (e.g. ports: ["8080:80"]) but wrong when the host side is ephemeral/random
# (ports: ["80"], published: 0, or a range), where Docker assigns the host port
# only at run time. Parses `docker compose ps --format json` with python3 (we
# already depend on python3 and on reading `docker compose ps` for health), and
# echoes the published host port of the web service, or nothing on any failure
# (caller keeps the recorded port -- no regression). Never hard-fails. Docker's
# own published mapping is authoritative, so no curl liveness guard is needed
# here (unlike the non-docker _app_runner_reconcile_port path).
_app_runner_compose_published_port() {
    local base="${1:-${TARGET_DIR:-.}}"
    local service="${2:-}"
    [ -n "$service" ] || return 0
    command -v docker >/dev/null 2>&1 || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    local compose_dir
    compose_dir=$(_app_runner_compose_dir "$base")
    local ps_json
    # `docker compose ps --format json` emits either a JSON array or one JSON
    # object per line (NDJSON) depending on the compose version; the parser below
    # handles both shapes.
    ps_json=$(cd "$compose_dir" && docker compose ps --format json 2>/dev/null) || return 0
    [ -n "$ps_json" ] || return 0
    printf '%s' "$ps_json" | LOKI_WEB_SERVICE="$service" python3 -c '
import json, os, sys
svc = os.environ.get("LOKI_WEB_SERVICE", "")
raw = sys.stdin.read().strip()
if not raw or not svc:
    sys.exit(0)

# Accept a JSON array OR newline-delimited JSON objects.
entries = []
try:
    parsed = json.loads(raw)
    entries = parsed if isinstance(parsed, list) else [parsed]
except Exception:
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            pass

def published_for(entry):
    # docker compose ps json exposes published ports under "Publishers", each a
    # dict with "PublishedPort" (host port, 0 when not published to the host).
    ports = []
    for pub in (entry.get("Publishers") or []):
        if not isinstance(pub, dict):
            continue
        pp = pub.get("PublishedPort")
        try:
            pp = int(pp)
        except (TypeError, ValueError):
            continue
        if 1 <= pp <= 65535:
            ports.append(pp)
    return ports

for entry in entries:
    if not isinstance(entry, dict):
        continue
    if entry.get("Service") != svc:
        continue
    ports = published_for(entry)
    if ports:
        print(ports[0])
        sys.exit(0)
sys.exit(0)
' 2>/dev/null || return 0
}

#===============================================================================
# Lifecycle
#===============================================================================

app_runner_start() {
    if [ -z "$_APP_RUNNER_METHOD" ]; then
        log_warn "App Runner: no method detected, call app_runner_init first"
        return 1
    fi

    _app_runner_dir
    local dir="${TARGET_DIR:-.}"

    # Port conflict check
    if [ -n "$_APP_RUNNER_PORT" ] && [ "$_APP_RUNNER_PORT" -gt 0 ] 2>/dev/null; then
        if lsof -ti:"$_APP_RUNNER_PORT" >/dev/null 2>&1; then
            log_warn "App Runner: port $_APP_RUNNER_PORT already in use, skipping app start"
            return 1
        fi
    fi

    log_step "App Runner: starting application ($_APP_RUNNER_METHOD on port $_APP_RUNNER_PORT)..."
    _rotate_app_log

    # Fix #1 (finding #597): pass Loki's chosen port to the app via the env so the
    # app honors it instead of binding its own default (e.g. a Node app reading
    # `process.env.PORT || 4000` would otherwise bind 4000 while Loki recorded the
    # guessed 3000, leaving the dashboard Live Preview pointed at a dead port).
    # We export PORT plus the common ecosystem aliases. An app that ignores these
    # vars is unaffected; an ignored env var is harmless by definition. We do NOT
    # set HOST/BIND -- changing the bind address can break apps. For docker (which
    # gets its port via published-port mapping, not the child env) this is a no-op
    # at the binary boundary, so we only export for the direct-exec path.
    local _port_env_prefix=""
    if [ "$_APP_RUNNER_IS_DOCKER" != true ] && \
       [ -n "$_APP_RUNNER_PORT" ] && [ "$_APP_RUNNER_PORT" -gt 0 ] 2>/dev/null; then
        _port_env_prefix="export PORT=$_APP_RUNNER_PORT HTTP_PORT=$_APP_RUNNER_PORT SERVER_PORT=$_APP_RUNNER_PORT APP_PORT=$_APP_RUNNER_PORT; "
    fi

    # Start the process in a new process group
    if command -v setsid >/dev/null 2>&1; then
        _APP_RUNNER_HAS_SETSID=true
        # Use setsid with a PID file so we capture the actual child PID (the process
        # group leader) rather than the subshell PID, which would orphan the app.
        local _pgid_file="$_APP_RUNNER_DIR/app.pgid.$$"
        # Note: $_APP_RUNNER_METHOD has passed _validate_app_command (whitelist).
        # The `--` after `bash -lc` prevents flag injection if the assembled
        # script string ever begins with a `-`.
        (cd "$dir" && setsid bash -lc -- "$_port_env_prefix"'echo $$ > "'"$_pgid_file"'"; exec '"$_APP_RUNNER_METHOD" >> "$_APP_RUNNER_DIR/app.log" 2>&1) &
        local _subshell_pid=$!
        # Wait briefly for the pgid file to appear, then read the real PGID
        local _pgid_wait=0
        while [ ! -s "$_pgid_file" ] && [ "$_pgid_wait" -lt 10 ]; do
            sleep 0.1
            _pgid_wait=$(( _pgid_wait + 1 ))
        done
        if [ -s "$_pgid_file" ]; then
            _APP_RUNNER_PID=$(cat "$_pgid_file")
        else
            _APP_RUNNER_PID=$_subshell_pid
        fi
        rm -f "$_pgid_file"
    else
        _APP_RUNNER_HAS_SETSID=false
        # Note: $_APP_RUNNER_METHOD has passed _validate_app_command (whitelist).
        # The `--` after `bash -lc` prevents flag injection.
        (cd "$dir" && bash -lc -- "${_port_env_prefix}exec $_APP_RUNNER_METHOD" >> "$_APP_RUNNER_DIR/app.log" 2>&1) &
        _APP_RUNNER_PID=$!
    fi
    # Register with central PID registry if available
    if type register_pid &>/dev/null; then
        register_pid "$_APP_RUNNER_PID" "app-runner" "method=$_APP_RUNNER_METHOD"
    fi

    # Write PID file
    echo "$_APP_RUNNER_PID" > "$_APP_RUNNER_DIR/app.pid"

    # Capture initial git diff hash for change detection
    _GIT_DIFF_HASH=$(cd "$dir" && git diff --stat 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | awk '{print $1}' || echo "none")

    # Brief pause for process to initialize
    sleep 2

    # Verify process started
    if [ "$_APP_RUNNER_IS_DOCKER" = true ] && echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
        # Docker compose -d exits immediately; poll for containers in "running"
        # state. Containers may report "Created" briefly before transitioning to
        # "Running", so retry up to ~30 seconds before declaring failure.
        local running_containers
        running_containers=$(_app_runner_compose_running_count "$dir")
        if [ "${running_containers:-0}" -gt 0 ]; then
            # Reconcile the recorded port with the RUNTIME published host port of
            # the primary web service (from `docker compose ps`), so the preview
            # URL and state.json point at the real host port even when the host
            # side was ephemeral/random in the compose file. The config-declared
            # port from _detect_port is kept when no valid runtime port is found
            # (no regression). Docker's published mapping is authoritative, so no
            # curl liveness guard is needed (cf. _app_runner_reconcile_port).
            if [ -n "${_APP_RUNNER_WEB_SERVICE:-}" ]; then
                local _rt_port
                _rt_port=$(_app_runner_compose_published_port "$dir" "$_APP_RUNNER_WEB_SERVICE")
                if [ -n "$_rt_port" ] && [[ "$_rt_port" =~ ^[0-9]+$ ]] && \
                   [ "$_rt_port" != "${_APP_RUNNER_PORT:-}" ]; then
                    log_info "App Runner: reconciled compose port ${_APP_RUNNER_PORT:-?} -> $_rt_port (runtime published mapping for service $_APP_RUNNER_WEB_SERVICE)"
                    _APP_RUNNER_PORT="$_rt_port"
                    _APP_RUNNER_URL="http://localhost:${_rt_port}"
                fi
            fi
            _write_app_state "running"
            log_info "App Runner: docker compose started ($running_containers container(s) running)"
            return 0
        else
            # Capture diagnostic output for postmortem
            local compose_dir
            compose_dir=$(_app_runner_compose_dir "$dir")
            local diag
            diag=$(cd "$compose_dir" && docker compose ps 2>&1 || true)
            log_error "App Runner: docker compose containers failed to start (no containers in running state after retries)"
            log_error "App Runner: docker compose ps output:"
            printf '%s\n' "$diag" | while IFS= read -r line; do log_error "  $line"; done
            _APP_RUNNER_CRASH_COUNT=$(( _APP_RUNNER_CRASH_COUNT + 1 ))
            _write_app_state "failed"
            return 1
        fi
    elif kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
        # Reconcile recorded port with the port the app actually bound (finding
        # #597), so state.json / detection.json / the preview URL point at the
        # live port even when the app ignored PORT. Mutates globals before the
        # state write below. Bounded; no-op when the app honored the chosen port.
        _app_runner_reconcile_port
        # L5 fix: capture the identity token now that the child has exec'd into
        # the real app process, so a later health-check/watchdog can detect a
        # reused PID (foreign process) instead of trusting it blindly.
        _write_app_token "$_APP_RUNNER_PID"
        _write_app_state "running"
        log_info "App Runner: application started (PID: $_APP_RUNNER_PID) on port $_APP_RUNNER_PORT"
        return 0
    else
        log_error "App Runner: application failed to start"
        _APP_RUNNER_CRASH_COUNT=$(( _APP_RUNNER_CRASH_COUNT + 1 ))
        _write_app_state "failed"
        return 1
    fi
}

app_runner_stop() {
    _app_runner_dir

    if [ -z "$_APP_RUNNER_PID" ] && [ -f "$_APP_RUNNER_DIR/app.pid" ]; then
        _APP_RUNNER_PID=$(cat "$_APP_RUNNER_DIR/app.pid" 2>/dev/null)
    fi

    if [ -z "$_APP_RUNNER_PID" ]; then
        log_info "App Runner: no running process to stop"
        return 0
    fi

    log_step "App Runner: stopping application (PID: $_APP_RUNNER_PID)..."

    # Docker cleanup
    if [ "$_APP_RUNNER_IS_DOCKER" = true ]; then
        if [ -n "$_APP_RUNNER_DOCKER_CONTAINER" ]; then
            docker stop "$_APP_RUNNER_DOCKER_CONTAINER" 2>/dev/null || true
            docker rm "$_APP_RUNNER_DOCKER_CONTAINER" 2>/dev/null || true
        fi
        if echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
            local _stop_compose_dir
            _stop_compose_dir=$(_app_runner_compose_dir "${TARGET_DIR:-.}")
            (cd "$_stop_compose_dir" && docker compose down 2>/dev/null) || true
        fi
    fi

    # BUG 1 fix: on the non-setsid fallback (the DEFAULT path on stock macOS,
    # which has no setsid) capture the FULL process subtree -- root + every
    # transitive descendant -- ONCE, BEFORE sending any signal. The old
    # `pkill -TERM -P <pid>` reached only ONE level of children, so deep workers
    # (npm -> sh -> node -> workers) holding the listening socket survived as
    # orphans and kept the port bound, blocking the next start.
    #
    # Capturing once is load-bearing: a worker that traps SIGTERM survives the
    # TERM phase while its intermediate ancestors die, then reparents to init.
    # Re-deriving the tree from the now-dead root would return nothing and skip
    # the KILL phase, leaving the port-holder alive. Every phase below (TERM,
    # grace-wait, KILL) operates over this one frozen snapshot instead.
    local -a _stop_snapshot=()
    if [ "$_APP_RUNNER_HAS_SETSID" != true ]; then
        _stop_snapshot=("$_APP_RUNNER_PID")
        local _snap_d
        while IFS= read -r _snap_d; do
            [ -n "$_snap_d" ] && _stop_snapshot+=("$_snap_d")
        done < <(_app_runner_collect_descendants "$_APP_RUNNER_PID")
    fi

    # Send SIGTERM to process and children
    if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
        # setsid path: the app is its own process group leader, so a group
        # signal reaches the whole tree safely. Unchanged.
        kill -TERM "-$_APP_RUNNER_PID" 2>/dev/null || kill -TERM "$_APP_RUNNER_PID" 2>/dev/null || true
    else
        # Group-kill is NOT used here: in this path the app inherits the
        # orchestrator's process group, so a group signal would kill run.sh and
        # the agent driving it. Signal the frozen snapshot, descendants first.
        _app_runner_signal_pids TERM "${_stop_snapshot[@]}"
    fi

    # Wait up to 5 seconds for graceful shutdown. Key the wait on the WHOLE
    # snapshot being alive (not just the main pid): a deep worker can outlive the
    # main subshell, and treating the main pid's exit as "done" is exactly what
    # let workers leak before. setsid path keeps the simpler main-pid check.
    local waited=0
    while [ "$waited" -lt 5 ]; do
        if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
            kill -0 "$_APP_RUNNER_PID" 2>/dev/null || break
        else
            _app_runner_any_alive "${_stop_snapshot[@]}" || break
        fi
        sleep 1
        waited=$(( waited + 1 ))
    done

    # Force kill if still running
    local _still_alive=false
    if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
        kill -0 "$_APP_RUNNER_PID" 2>/dev/null && _still_alive=true
    else
        _app_runner_any_alive "${_stop_snapshot[@]}" && _still_alive=true
    fi
    if [ "$_still_alive" = true ]; then
        log_warn "App Runner: process did not stop gracefully, sending SIGKILL"
        if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
            kill -KILL "-$_APP_RUNNER_PID" 2>/dev/null || kill -KILL "$_APP_RUNNER_PID" 2>/dev/null || true
        else
            # BUG 1 fix (KILL phase): SIGKILL the SAME frozen snapshot (root +
            # all descendants captured pre-signal), so a TERM-trapping worker
            # that reparented to init is still force-killed. SIGKILL cannot be
            # trapped, so this is the terminal guarantee that no port-holder
            # survives. The snapshot does the real work. The fresh walk below only
            # adds anything while the root is still alive (a worker spawned during
            # shutdown); once the root is dead it is empty and the snapshot covers.
            _app_runner_signal_pids KILL "${_stop_snapshot[@]}"
            local -a _kill_fresh=()
            local _kf
            while IFS= read -r _kf; do
                [ -n "$_kf" ] && _kill_fresh+=("$_kf")
            done < <(_app_runner_collect_descendants "$_APP_RUNNER_PID")
            if [ "${#_kill_fresh[@]}" -gt 0 ]; then
                _app_runner_signal_pids KILL "${_kill_fresh[@]}"
            fi
        fi
    fi

    # Unregister from central PID registry
    if type unregister_pid &>/dev/null && [ -n "$_APP_RUNNER_PID" ]; then
        unregister_pid "$_APP_RUNNER_PID"
    fi

    rm -f "$_APP_RUNNER_DIR/app.pid"
    rm -f "$_APP_RUNNER_DIR/app.token"
    _write_app_state "stopped"
    log_info "App Runner: application stopped"
    _APP_RUNNER_PID=""
    return 0
}

app_runner_restart() {
    _APP_RUNNER_RESTART_COUNT=$(( _APP_RUNNER_RESTART_COUNT + 1 ))
    log_step "App Runner: restarting (restart #$_APP_RUNNER_RESTART_COUNT)..."
    app_runner_stop
    sleep 1
    # L6 fix (non-atomic restart): the old code returned app_runner_start's status
    # unhandled, so a failed start (e.g. the old port still in TIME_WAIT after the
    # 1s wait, tripping the port-conflict guard) left the app stopped with only an
    # internal log_warn -- silent to the caller, which saw the restart "succeed".
    # Surface the failure loudly via log_error and return the failure status
    # explicitly so the restart's failure is visible and actionable. The
    # happy-path behavior (start succeeds -> return 0) is unchanged.
    app_runner_start
    local _start_rc=$?
    if [ "$_start_rc" -ne 0 ]; then
        log_error "App Runner: restart failed -- app stopped but could not be started again (start exit $_start_rc). Check $_APP_RUNNER_DIR/app.log; the previous port may still be held (TIME_WAIT) or the start command may be failing."
        return "$_start_rc"
    fi
    return 0
}

#===============================================================================
# Health Check
#===============================================================================

app_runner_health_check() {
    _app_runner_dir

    # Read PID from file if not in memory
    if [ -z "$_APP_RUNNER_PID" ] && [ -f "$_APP_RUNNER_DIR/app.pid" ]; then
        _APP_RUNNER_PID=$(cat "$_APP_RUNNER_DIR/app.pid" 2>/dev/null)
    fi

    if [ -z "$_APP_RUNNER_PID" ]; then
        _write_health "false"
        return 1
    fi

    # Docker compose: check containers instead of PID (docker compose up -d exits immediately)
    if [ "$_APP_RUNNER_IS_DOCKER" = true ] && echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
        # Use a 1-second timeout for health checks (no long retry); start-time
        # retries are handled in app_runner_start.
        local running_containers
        running_containers=$(LOKI_COMPOSE_HEALTH_TIMEOUT=1 _app_runner_compose_running_count "${TARGET_DIR:-.}")
        if [ "${running_containers:-0}" -le 0 ]; then
            # Nothing running at all.
            _write_health "false"
            _write_app_state "crashed"
            return 1
        fi
        # v7.26.0 (Phase 4) GAP #4 fix: "some container is up" is NOT health for
        # a multi-service stack. If we identified a primary web service, health
        # keys on THAT service, not on whether any container (e.g. a db/cache) is
        # up. Two signals, in order: (1) the web service's docker HEALTHCHECK
        # result when one is declared (COMPOSE_INSTRUCTION mandates an HTTP
        # healthcheck on the web service) -- "healthy" means actually serving,
        # "unhealthy"/"starting" do not; (2) when no healthcheck is declared,
        # fall back to the container lifecycle State (running), matching the
        # codebase convention. Reads both fields from one `docker compose ps`.
        if [ -n "${_APP_RUNNER_WEB_SERVICE:-}" ]; then
            local _web_line _web_state _web_health
            _web_line=$(cd "$(_app_runner_compose_dir "${TARGET_DIR:-.}")" \
                && docker compose ps --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null \
                | tr -d '\r' | awk -F'|' -v s="$_APP_RUNNER_WEB_SERVICE" '$1==s {print; exit}')
            _web_state=$(printf '%s' "$_web_line" | awk -F'|' '{print $2}')
            _web_health=$(printf '%s' "$_web_line" | awk -F'|' '{print $3}')
            if [ "$_web_state" != "running" ]; then
                # Container not running -> definitively down.
                _write_health "false"
                _write_app_state "crashed"
                return 1
            fi
            if [ -n "$_web_health" ]; then
                # A healthcheck is declared: it is authoritative.
                if [ "$_web_health" = "healthy" ]; then
                    _write_health "true"
                    _write_app_state "running"
                    return 0
                fi
                if [ "$_web_health" = "unhealthy" ]; then
                    # Container up but failing its own healthcheck (not serving).
                    _write_health "false"
                    _write_app_state "crashed"
                    return 1
                fi
                # "starting" (within start_period): up, not yet healthy. Report
                # running so the watchdog gives it time instead of restarting,
                # but do not yet claim a passing health.
                _write_health "false"
                _write_app_state "running"
                return 0
            fi
            # No healthcheck declared: container running is the signal.
            _write_health "true"
            _write_app_state "running"
            return 0
        fi
        # No web service identified (legacy/degraded): fall back to the
        # original "any container running" signal.
        _write_health "true"
        _write_app_state "running"
        return 0
    fi

    # Check PID is alive (non-docker-compose methods)
    if ! kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
        _write_health "false"
        return 1
    fi

    # L5 fix (PID-file reuse race): kill -0 only proves SOME process owns this
    # PID, not that it is OUR app. The OS may have reassigned the crashed app's
    # PID to an unrelated process. Verify the captured identity token; on a
    # mismatch the live PID is a foreign process, so the app is DEAD. (When no
    # token was captured we fall back to trusting kill -0 -- see
    # _app_runner_pid_is_ours -- so a still-running legitimate app is never
    # falsely marked dead.)
    if ! _app_runner_pid_is_ours "$_APP_RUNNER_PID"; then
        _write_health "false"
        return 1
    fi

    # For HTTP apps, try an HTTP health check.
    if [ -n "$_APP_RUNNER_PORT" ] && [ "$_APP_RUNNER_PORT" -gt 0 ] 2>/dev/null; then
        # The health signal is "is the server answering HTTP at all", NOT "does /
        # return 2xx". Loki generates plenty of apps that legitimately serve a
        # non-2xx on the root path (an API-only FastAPI/Express backend 404s on
        # `/`, anything behind auth 401s). Those are serving correctly, so a
        # status-strict probe (curl -f, which fails on >=400) would mark a healthy
        # backend unhealthy and trigger a needless restart -> a restart storm /
        # false crash. What genuinely means "no longer serving" -- a hung event
        # loop, a deadlock, a wedged dev server -- is a connection that times out
        # or is refused, i.e. NO HTTP response at all. So we read the HTTP status
        # code: any code returned (2xx/3xx/4xx/5xx) means the server answered and
        # is alive; "000" is curl's sentinel for connect-failure/timeout/reset
        # and is the only thing we treat as a crash.
        # If curl is unavailable we cannot probe HTTP at all; fall back to the
        # old, more tolerant signal (PID alive == healthy) rather than declaring
        # every HTTP app wedged and triggering a restart storm. curl is the only
        # HTTP client this function uses.
        if ! command -v curl >/dev/null 2>&1; then
            _write_health "true"
            _write_app_state "running"
            return 0
        fi
        # On connect-failure/timeout curl already prints "000" via %{http_code}
        # and exits non-zero; do NOT append our own "000" (a `|| echo 000` would
        # concatenate to "000000"). The trailing `|| true` swallows the non-zero
        # exit (matching this file's guarded command-substitution convention, e.g.
        # the _GIT_DIFF_HASH / port reads) so the watchdog never aborts under a
        # future `set -e`; the empty fallback then maps to "000".
        local _http_code
        _http_code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
            "http://localhost:${_APP_RUNNER_PORT}/" 2>/dev/null || true)
        _http_code="${_http_code:-000}"
        if [ "$_http_code" != "000" ]; then
            _write_health "true"
            _write_app_state "running"
            return 0
        else
            # No HTTP response: the process is alive (kill -0 passed above) but is
            # not serving on its declared port -- a wedged/hung/deadlocked server.
            # Previously this branch wrote ok:true unconditionally, so the HTTP
            # signal could never report a failure and a wedged server stayed
            # "healthy" forever. Report the failure honestly so the watchdog can
            # act on it. We deliberately do NOT flip state.json to "crashed" here
            # (mirroring the dead-PID precedent above at the kill -0 check); the
            # watchdog owns the crashed transition after its circuit breaker, so a
            # single transient blip does not prematurely mark the app crashed.
            _write_health "false"
            return 1
        fi
    fi

    # Non-HTTP: PID alive is sufficient (no URL/port to probe)
    _write_health "true"
    return 0
}

#===============================================================================
# Change Detection
#===============================================================================

app_runner_should_restart() {
    local dir="${TARGET_DIR:-.}"

    # Get current git diff hash
    local current_hash
    current_hash=$(cd "$dir" && git diff --stat 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | awk '{print $1}' || echo "none")

    # No change
    if [ "$current_hash" = "$_GIT_DIFF_HASH" ]; then
        return 1
    fi

    # Check if changes are docs-only (.md, .txt, .rst)
    local changed_files
    changed_files=$(cd "$dir" && git diff --name-only 2>/dev/null || echo "")
    if [ -n "$changed_files" ]; then
        local non_doc_changes
        non_doc_changes=$(echo "$changed_files" | grep -vE '\.(md|txt|rst)$' || true)
        if [ -z "$non_doc_changes" ]; then
            # Only documentation changes, skip restart
            _GIT_DIFF_HASH="$current_hash"
            return 1
        fi
    fi

    # Source files changed, update hash
    _GIT_DIFF_HASH="$current_hash"
    return 0
}

#===============================================================================
# Watchdog
#===============================================================================

app_runner_watchdog() {
    _app_runner_dir

    # v7.26.0 (Phase 4): docker compose runs detached (`up -d` exits immediately),
    # so the captured PID is a short-lived subshell and `kill -0` is the wrong
    # liveness signal for a compose stack. For compose, delegate to
    # app_runner_health_check, whose compose branch keys on the primary web
    # SERVICE container running (GAP #4) and writes health.json + state.json.
    # This is what makes the service-aware health logic actually fire in the
    # live monitoring loop (not just in isolation). On an unhealthy web service
    # it restarts the stack under the same crash-count circuit breaker.
    if [ "$_APP_RUNNER_IS_DOCKER" = true ] && echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
        if app_runner_health_check; then
            # BUG 3 fix: the breaker is meant to fire on 5 CONSECUTIVE failures.
            # A confirmed-healthy observation clears any accumulated count so a
            # long-lived stack that recovered from a few transient blips is not
            # tripped permanently on cumulative (non-consecutive) crashes.
            _APP_RUNNER_CRASH_COUNT=0
            return 0
        fi
        _APP_RUNNER_CRASH_COUNT=$(( _APP_RUNNER_CRASH_COUNT + 1 ))
        log_warn "App Runner: compose web service unhealthy (crash #$_APP_RUNNER_CRASH_COUNT)"
        if [ "$_APP_RUNNER_CRASH_COUNT" -ge 5 ]; then
            log_error "App Runner: crash limit reached (5), marking as crashed"
            tail -20 "$_APP_RUNNER_DIR/app.log" 2>/dev/null | while IFS= read -r line; do
                log_error "  $line"
            done
            _write_app_state "crashed"
            return 1
        fi
        local _c_backoff=$(( 1 << _APP_RUNNER_CRASH_COUNT ))
        [ "$_c_backoff" -gt 30 ] && _c_backoff=30
        log_info "App Runner: restarting compose stack in ${_c_backoff}s..."
        sleep "$_c_backoff"
        app_runner_start || log_warn "App Runner: compose auto-restart failed"
        return 0
    fi

    if [ -z "$_APP_RUNNER_PID" ] && [ -f "$_APP_RUNNER_DIR/app.pid" ]; then
        _APP_RUNNER_PID=$(cat "$_APP_RUNNER_DIR/app.pid" 2>/dev/null)
    fi

    # No process to watch
    if [ -z "$_APP_RUNNER_PID" ]; then
        return 0
    fi

    # Process alive: kill -0 only proves the PID exists, not that the app is
    # actually serving. A hung event loop, a deadlock, or a wedged dev server
    # all pass kill -0 forever while never answering a request, so the old
    # "alive == healthy" shortcut let a wedged HTTP app run un-restarted and
    # left health.json stale. Mirror the compose branch: defer to
    # app_runner_health_check (HTTP-aware for apps that declared a port), and
    # treat an unhealthy-but-alive process as a crash so the same circuit
    # breaker + backoff + restart path handles it.
    # L5 fix: gate on BOTH liveness AND identity. If kill -0 succeeds but the
    # PID is a foreign process the OS reassigned our crashed app's PID to
    # (_app_runner_pid_is_ours false), we must NOT enter this branch: the
    # alive-but-unhealthy path below calls app_runner_stop, which would send
    # TERM/KILL to an innocent stranger. Instead let a reused PID fall through to
    # the dead path, which only increments the crash count and restarts -- it
    # never signals the PID. (No token captured -> is_ours returns true ->
    # behaves exactly as before, so no regression for legitimately-running apps.)
    if kill -0 "$_APP_RUNNER_PID" 2>/dev/null && _app_runner_pid_is_ours "$_APP_RUNNER_PID"; then
        if app_runner_health_check; then
            # BUG 3 fix: a confirmed-healthy observation clears the accumulated
            # crash count so the breaker fires only on 5 CONSECUTIVE failures,
            # not on 5 cumulative crashes that were each successfully recovered
            # over a long session (which would trip the breaker on a HEALTHY app).
            _APP_RUNNER_CRASH_COUNT=0
            return 0
        fi
        # Alive but not healthy (e.g. HTTP probe failed for an app that declared
        # a port). Fall through to the crash path below, but first terminate the
        # wedged process: it is still bound to the port, so app_runner_start's
        # port-conflict guard would otherwise refuse to start and the breaker
        # would trip while the orphan keeps serving hung responses (a restart
        # storm). app_runner_stop performs a full process-tree teardown and
        # clears _APP_RUNNER_PID / app.pid, leaving a clean slate for restart.
        log_warn "App Runner: process alive but unhealthy (not serving) -- treating as crash"
        app_runner_stop
    fi

    # Process is dead (or was just torn down because it was alive-but-wedged)
    _APP_RUNNER_CRASH_COUNT=$(( _APP_RUNNER_CRASH_COUNT + 1 ))
    log_warn "App Runner: process died (crash #$_APP_RUNNER_CRASH_COUNT)"

    # Circuit breaker: stop retrying after 5 crashes
    if [ "$_APP_RUNNER_CRASH_COUNT" -ge 5 ]; then
        log_error "App Runner: crash limit reached (5), marking as crashed"
        log_error "App Runner: last 20 lines of app.log:"
        tail -20 "$_APP_RUNNER_DIR/app.log" 2>/dev/null | while IFS= read -r line; do
            log_error "  $line"
        done
        _write_app_state "crashed"
        rm -f "$_APP_RUNNER_DIR/app.pid"
        rm -f "$_APP_RUNNER_DIR/app.token"
        _APP_RUNNER_PID=""
        return 1
    fi

    # Exponential backoff: 2^crash_count seconds, max 30
    local backoff=$(( 1 << _APP_RUNNER_CRASH_COUNT ))
    if [ "$backoff" -gt 30 ]; then
        backoff=30
    fi
    log_info "App Runner: auto-restarting in ${backoff}s..."
    sleep "$backoff"

    # Clear PID and restart
    rm -f "$_APP_RUNNER_DIR/app.pid"
    _APP_RUNNER_PID=""
    app_runner_start || log_warn "App Runner: auto-restart failed"
}

#===============================================================================
# Cleanup
#===============================================================================

app_runner_cleanup() {
    _app_runner_dir
    log_step "App Runner: cleaning up..."

    # Stop running process
    app_runner_stop

    # Docker-specific cleanup
    if [ "$_APP_RUNNER_IS_DOCKER" = true ]; then
        if [ -n "$_APP_RUNNER_DOCKER_CONTAINER" ]; then
            docker stop "$_APP_RUNNER_DOCKER_CONTAINER" 2>/dev/null || true
            docker rm "$_APP_RUNNER_DOCKER_CONTAINER" 2>/dev/null || true
        fi
        if echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
            local _stop_compose_dir
            _stop_compose_dir=$(_app_runner_compose_dir "${TARGET_DIR:-.}")
            (cd "$_stop_compose_dir" && docker compose down 2>/dev/null) || true
        fi
    fi

    # Remove PID file
    rm -f "$_APP_RUNNER_DIR/app.pid"

    # Update state
    _write_app_state "stopped"
    log_info "App Runner: cleanup complete"
}

#===============================================================================
# Status
#===============================================================================

app_runner_status() {
    _app_runner_dir

    if [ -z "$_APP_RUNNER_METHOD" ]; then
        echo "App Runner: not initialized"
        return
    fi

    local status="unknown"
    if [ -f "$_APP_RUNNER_DIR/state.json" ]; then
        # Extract status from state file (simple grep, no jq dependency)
        status=$(grep -o '"status": *"[^"]*"' "$_APP_RUNNER_DIR/state.json" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"/\1/')
    fi

    echo "App Runner: ${status} | ${_APP_RUNNER_METHOD} | port ${_APP_RUNNER_PORT:-none} | crashes ${_APP_RUNNER_CRASH_COUNT} | restarts ${_APP_RUNNER_RESTART_COUNT}"
}
