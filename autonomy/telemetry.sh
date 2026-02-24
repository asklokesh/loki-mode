#!/usr/bin/env bash
# Anonymous usage telemetry for Loki Mode
# Opt-out: LOKI_TELEMETRY_DISABLED=true or DO_NOT_TRACK=1
# All calls are fire-and-forget, silent on failure, non-blocking

LOKI_POSTHOG_HOST="${LOKI_TELEMETRY_ENDPOINT:-https://us.i.posthog.com}"
LOKI_POSTHOG_KEY="phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87"

_loki_telemetry_enabled() {
    [ "${LOKI_TELEMETRY_DISABLED:-}" = "true" ] && return 1
    [ "${DO_NOT_TRACK:-}" = "1" ] && return 1
    command -v curl >/dev/null 2>&1 || return 1
    return 0
}

_loki_telemetry_id() {
    local id_file="${HOME}/.loki-telemetry-id"
    if [ -f "$id_file" ] 2>/dev/null; then
        cat "$id_file" 2>/dev/null
        return
    fi
    local new_id
    new_id=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) || \
    new_id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]') || \
    new_id="anon-$(date +%s)-$$"
    printf '%s\n' "$new_id" > "$id_file" 2>/dev/null
    printf '%s' "$new_id"
}

_loki_detect_channel() {
    local dir="${PROJECT_DIR:-${SKILL_DIR:-${SCRIPT_DIR:-}}}"
    if [ -f "/.dockerenv" ] 2>/dev/null; then printf 'docker'; return; fi
    case "$dir" in
        */Cellar/*|*/homebrew/*) printf 'homebrew' ;;
        */node_modules/*) printf 'npm' ;;
        */.claude/skills/*) printf 'skill' ;;
        *) printf 'source' ;;
    esac
}

loki_telemetry() {
    _loki_telemetry_enabled || return 0
    local event="$1"; shift
    local distinct_id
    distinct_id=$(_loki_telemetry_id 2>/dev/null) || return 0
    local version
    version=$(cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/VERSION" 2>/dev/null || cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/../VERSION" 2>/dev/null || echo "unknown")
    version=$(echo "$version" | tr -d '[:space:]')
    local channel
    channel=$(_loki_detect_channel 2>/dev/null || echo "unknown")
    local os_name arch
    os_name=$(uname -s 2>/dev/null || echo "unknown")
    arch=$(uname -m 2>/dev/null || echo "unknown")

    # Build properties from remaining args (key=value pairs)
    local extra_props=""
    for arg in "$@"; do
        local key="${arg%%=*}"
        local val="${arg#*=}"
        extra_props="${extra_props},\"${key}\":\"${val}\""
    done

    local payload
    payload=$(printf '{"api_key":"%s","event":"%s","distinct_id":"%s","properties":{"os":"%s","arch":"%s","version":"%s","channel":"%s"%s}}' \
        "$LOKI_POSTHOG_KEY" "$event" "$distinct_id" "$os_name" "$arch" "$version" "$channel" "$extra_props")

    (curl -sS --max-time 3 -X POST "${LOKI_POSTHOG_HOST}/capture/" \
        -H "Content-Type: application/json" \
        -d "$payload" >/dev/null 2>&1 &) 2>/dev/null
    return 0
}
