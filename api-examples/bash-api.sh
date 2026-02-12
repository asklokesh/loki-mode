#!/usr/bin/env bash
# Minimal HTTP API for loki-mode using netcat
# Zero dependencies, works on macOS and Linux

set -euo pipefail

PORT="${LOKI_DASHBOARD_PORT:-57374}"
LOKI_DIR="${LOKI_DIR:-$HOME/.loki}"
FIFO="/tmp/loki-api-$$"

cleanup() {
    rm -f "$FIFO"
    exit 0
}
trap cleanup EXIT INT TERM

# Detect netcat variant
if nc -h 2>&1 | grep -q 'GNU'; then
    NC_CMD="nc -l -p"
elif nc -h 2>&1 | grep -q '\-l.*\-p'; then
    NC_CMD="nc -l -p"
else
    NC_CMD="nc -l"  # BSD/macOS
fi

send_response() {
    local status="$1"
    local content_type="${2:-application/json}"
    local body="$3"
    local length=${#body}

    printf "HTTP/1.1 %s\r\n" "$status"
    printf "Content-Type: %s\r\n" "$content_type"
    printf "Content-Length: %d\r\n" "$length"
    printf "Connection: close\r\n"
    printf "Access-Control-Allow-Origin: *\r\n"
    printf "\r\n"
    printf "%s" "$body"
}

get_status() {
    local state="stopped"
    local project=""
    local task=""

    if [[ -f "$LOKI_DIR/state/session.pid" ]]; then
        local pid
        pid=$(cat "$LOKI_DIR/state/session.pid" 2>/dev/null || echo "")
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            state="running"
            [[ -f "$LOKI_DIR/state/paused" ]] && state="paused"
        fi
    fi

    [[ -f "$LOKI_DIR/state/current_project" ]] && project=$(cat "$LOKI_DIR/state/current_project")
    [[ -f "$LOKI_DIR/state/current_task" ]] && task=$(cat "$LOKI_DIR/state/current_task")

    cat <<EOF
{"state":"$state","project":"$project","task":"$task","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
}

handle_request() {
    local method=""
    local path=""
    local line

    # Read request line
    read -r line
    method=$(echo "$line" | awk '{print $1}')
    path=$(echo "$line" | awk '{print $2}')

    # Consume headers
    while read -r line; do
        [[ "$line" == $'\r' || -z "$line" ]] && break
    done

    # Route requests
    case "$method $path" in
        "GET /health")
            send_response "200 OK" "application/json" '{"status":"ok"}'
            ;;
        "GET /status")
            send_response "200 OK" "application/json" "$(get_status)"
            ;;
        "POST /start")
            if [[ -x "./autonomy/run.sh" ]]; then
                nohup ./autonomy/run.sh > /dev/null 2>&1 &
                send_response "200 OK" "application/json" '{"started":true}'
            else
                send_response "500 Internal Server Error" "application/json" '{"error":"run.sh not found"}'
            fi
            ;;
        "POST /stop")
            if [[ -f "$LOKI_DIR/state/session.pid" ]]; then
                kill "$(cat "$LOKI_DIR/state/session.pid")" 2>/dev/null || true
                send_response "200 OK" "application/json" '{"stopped":true}'
            else
                send_response "404 Not Found" "application/json" '{"error":"no session"}'
            fi
            ;;
        "POST /pause")
            touch "$LOKI_DIR/state/paused"
            send_response "200 OK" "application/json" '{"paused":true}'
            ;;
        "POST /resume")
            rm -f "$LOKI_DIR/state/paused"
            send_response "200 OK" "application/json" '{"resumed":true}'
            ;;
        *)
            send_response "404 Not Found" "application/json" '{"error":"not found"}'
            ;;
    esac
}

echo "Loki API listening on port $PORT (bash/netcat)"
mkdir -p "$LOKI_DIR/state"

while true; do
    mkfifo "$FIFO" 2>/dev/null || true
    handle_request < <($NC_CMD $PORT < "$FIFO") > "$FIFO"
    rm -f "$FIFO"
done
