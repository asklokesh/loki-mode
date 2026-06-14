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
    cat > "$tmp_file" << APPSTATE_EOF
{
    "main_pid": ${_APP_RUNNER_PID:-0},
    "process_group": "-${_APP_RUNNER_PID:-0}",
    "method": "${method_escaped}",
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

    [ -n "$real_port" ] || return 0
    if [ "$real_port" != "$_APP_RUNNER_PORT" ]; then
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
_parse_listen_port() {
    local file="$1"
    [ -f "$file" ] || return 0
    # Strip ANSI SGR sequences (\e[...m) so color-wrapped URLs still match.
    local clean
    clean=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "$file" 2>/dev/null) || clean=$(cat "$file" 2>/dev/null)
    [ -n "$clean" ] || return 0

    local candidate=""
    # 1) Explicit URL with a port: http://host:PORT  (most reliable).
    candidate=$(printf '%s\n' "$clean" \
        | grep -oiE 'https?://[a-z0-9.\-]+:[0-9]{1,5}' \
        | grep -oE ':[0-9]{1,5}' | tr -d ':' | tail -1)
    # 2) A number anchored to the literal word "port": "port 8080", "port=3000",
    #    "port: 5000". This runs BEFORE the bare host:port scan so a clock-style
    #    timestamp on the same line (e.g. "12:30:45 ... port 8080") cannot win.
    if [ -z "$candidate" ]; then
        candidate=$(printf '%s\n' "$clean" \
            | grep -ioE 'port[ =:]+[0-9]{1,5}' \
            | grep -oE '[0-9]{1,5}' | tail -1)
    fi
    # 3) Keyword listen lines with a real host token before the colon:
    #    "localhost:5173", "0.0.0.0:8080", "127.0.0.1:3000". Requiring a letter
    #    or a dot immediately left of the colon excludes "HH:MM" timestamps,
    #    which have a digit there.
    if [ -z "$candidate" ]; then
        candidate=$(printf '%s\n' "$clean" \
            | grep -iE 'listen|running on|ready|started|serving|server' \
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

    # Send SIGTERM to process and children
    if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
        kill -TERM "-$_APP_RUNNER_PID" 2>/dev/null || kill -TERM "$_APP_RUNNER_PID" 2>/dev/null || true
    else
        pkill -TERM -P "$_APP_RUNNER_PID" 2>/dev/null || true
        kill -TERM "$_APP_RUNNER_PID" 2>/dev/null || true
    fi

    # Wait up to 5 seconds for graceful shutdown
    local waited=0
    while [ "$waited" -lt 5 ]; do
        if ! kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
            break
        fi
        sleep 1
        waited=$(( waited + 1 ))
    done

    # Force kill if still running
    if kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
        log_warn "App Runner: process did not stop gracefully, sending SIGKILL"
        if [ "$_APP_RUNNER_HAS_SETSID" = true ]; then
            kill -KILL "-$_APP_RUNNER_PID" 2>/dev/null || kill -KILL "$_APP_RUNNER_PID" 2>/dev/null || true
        else
            pkill -KILL -P "$_APP_RUNNER_PID" 2>/dev/null || true
            kill -KILL "$_APP_RUNNER_PID" 2>/dev/null || true
        fi
    fi

    # Unregister from central PID registry
    if type unregister_pid &>/dev/null && [ -n "$_APP_RUNNER_PID" ]; then
        unregister_pid "$_APP_RUNNER_PID"
    fi

    rm -f "$_APP_RUNNER_DIR/app.pid"
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
    app_runner_start
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

    # For HTTP apps, try an HTTP health check
    if [ -n "$_APP_RUNNER_PORT" ] && [ "$_APP_RUNNER_PORT" -gt 0 ] 2>/dev/null; then
        if curl -sf -o /dev/null -m 5 "http://localhost:${_APP_RUNNER_PORT}/" 2>/dev/null; then
            _write_health "true"
            _write_app_state "running"
            return 0
        else
            # HTTP failed but process alive -- may be a non-HTTP app or still starting
            _write_health "true"
            return 0
        fi
    fi

    # Non-HTTP: PID alive is sufficient
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

    # Process alive, nothing to do
    if kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
        return 0
    fi

    # Process is dead
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
