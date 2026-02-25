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

# Validate a command string: reject shell metacharacters that enable injection
_validate_app_command() {
    local cmd="$1"
    # Allow alphanumeric, spaces, hyphens, underscores, dots, slashes, colons, equals
    # Reject semicolons, pipes, backticks, $(), &&, ||, redirects used for injection
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
            # Parse port from compose file
            local compose_file
            if [ -f "${TARGET_DIR:-.}/docker-compose.yml" ]; then
                compose_file="${TARGET_DIR:-.}/docker-compose.yml"
            else
                compose_file="${TARGET_DIR:-.}/compose.yml"
            fi
            local port
            # Handle both simple (HOST:CONTAINER) and IP-bound (IP:HOST:CONTAINER) port formats
            port=$(grep -E '^\s*-\s*"?[0-9]' "$compose_file" 2>/dev/null | head -1 | sed 's/.*- *"*//;s/".*//;' | awk -F: '{print $(NF-1)}')
            _APP_RUNNER_PORT="${port:-8080}"
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
            _APP_RUNNER_METHOD="docker build -t loki-app . && docker run -d -p ${_APP_RUNNER_PORT}:${_APP_RUNNER_PORT} --name loki-app-container loki-app"
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

    # Start the process in a new process group
    if command -v setsid >/dev/null 2>&1; then
        _APP_RUNNER_HAS_SETSID=true
        (cd "$dir" && setsid bash -c "$_APP_RUNNER_METHOD" >> "$_APP_RUNNER_DIR/app.log" 2>&1) &
    else
        _APP_RUNNER_HAS_SETSID=false
        (cd "$dir" && bash -c "$_APP_RUNNER_METHOD" >> "$_APP_RUNNER_DIR/app.log" 2>&1) &
    fi
    _APP_RUNNER_PID=$!
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
        # Docker compose -d exits immediately; check containers instead of PID
        local running_containers
        running_containers=$(cd "${TARGET_DIR:-.}" && { docker compose ps --status running -q 2>/dev/null || docker compose ps 2>/dev/null | grep -ciE 'running|up'; } | wc -l | tr -d ' ')
        if [ "${running_containers:-0}" -gt 0 ]; then
            _write_app_state "running"
            log_info "App Runner: docker compose started ($running_containers container(s) running)"
            return 0
        else
            log_error "App Runner: docker compose containers failed to start"
            _APP_RUNNER_CRASH_COUNT=$(( _APP_RUNNER_CRASH_COUNT + 1 ))
            _write_app_state "failed"
            return 1
        fi
    elif kill -0 "$_APP_RUNNER_PID" 2>/dev/null; then
        _write_app_state "running"
        log_info "App Runner: application started (PID: $_APP_RUNNER_PID)"
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
        docker stop loki-app-container 2>/dev/null || true
        docker rm loki-app-container 2>/dev/null || true
        if echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
            (cd "${TARGET_DIR:-.}" && docker compose down 2>/dev/null) || true
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
        local running_containers
        running_containers=$(cd "${TARGET_DIR:-.}" && { docker compose ps --status running -q 2>/dev/null || docker compose ps 2>/dev/null | grep -ciE 'running|up'; } | wc -l | tr -d ' ')
        if [ "${running_containers:-0}" -gt 0 ]; then
            _write_health "true"
            _write_app_state "running"
            return 0
        else
            _write_health "false"
            return 1
        fi
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
        docker stop loki-app-container 2>/dev/null || true
        docker rm loki-app-container 2>/dev/null || true
        if echo "$_APP_RUNNER_METHOD" | grep -q "docker compose"; then
            (cd "${TARGET_DIR:-.}" && docker compose down 2>/dev/null) || true
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
