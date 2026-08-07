#!/usr/bin/env bash
#===============================================================================
# Loki Mode - Multi-Channel Notification System
# Version: 1.0.0
#
# Supports: Slack, Discord, Generic Webhooks
# Environment Variables:
#   LOKI_SLACK_WEBHOOK    - Slack incoming webhook URL
#   LOKI_DISCORD_WEBHOOK  - Discord webhook URL
#   LOKI_WEBHOOK_URL          - Generic webhook URL (any endpoint)
#   LOKI_PROJECT              - Project name for notifications (optional)
#   LOKI_NOTIFICATIONS        - Enable/disable all notifications (default: true)
#===============================================================================

# Notification settings - normalize boolean values (POSIX compatible)
_normalize_bool() {
    local lower
    lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
        true|yes|1|on) echo "true" ;;
        *) echo "false" ;;
    esac
}
NOTIFICATIONS_ENABLED=$(_normalize_bool "${LOKI_NOTIFICATIONS:-true}")

#===============================================================================
# Internal Helper Functions
#===============================================================================

# JSON escape a string (handles quotes, newlines, backslashes)
# Uses Python's json module for guaranteed correctness
_json_escape() {
    printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1], end="")'
}

# Get ISO 8601 timestamp
_get_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Get project name from environment or current directory
_get_project_name() {
    if [ -n "$LOKI_PROJECT" ]; then
        echo "$LOKI_PROJECT"
    elif [ -n "$PROJECT_DIR" ]; then
        basename "$PROJECT_DIR"
    else
        basename "$(pwd)"
    fi
}

# Map event types to colors for Slack (hex format)
_get_slack_color() {
    local event="$1"
    case "$event" in
        session_start)  echo "#3498DB" ;;  # Blue
        session_end)    echo "#57F287" ;;  # Green
        task_complete)  echo "#57F287" ;;  # Green
        milestone)      echo "#9b59b6" ;;  # Purple
        error)          echo "#ED4245" ;;  # Red
        warning)        echo "#f39c12" ;;  # Orange
        *)              echo "#808080" ;;  # Gray
    esac
}

# Map event types to colors for Discord (decimal format)
# Per requirements:
#   session_start: blue (3447003)
#   session_end: green (5763719)
#   task_complete: green (5763719)
#   error: red (15548997)
_get_discord_color() {
    local event="$1"
    case "$event" in
        session_start)  echo "3447003" ;;   # Blue
        session_end)    echo "5763719" ;;   # Green
        task_complete)  echo "5763719" ;;   # Green
        milestone)      echo "10181046" ;;  # Purple
        error)          echo "15548997" ;;  # Red
        warning)        echo "15981348" ;;  # Orange
        *)              echo "9807270" ;;   # Gray
    esac
}

#===============================================================================
# Slack Notifications
#===============================================================================

# Verdict fields for a Slack card, from the newest Evidence Receipt.
#
# Roadmap item 9: "put the receipt where review already happens". Slack
# notifications carried the event name and the project name and nothing else --
# grep for receipt/verdict/proof in this file returned 0. A team watching a
# channel saw "build finished" and had to go somewhere else to learn whether it
# was verified, which is the surface problem item 9 names: verification nobody
# sees does not build trust.
#
# Emits Slack `fields` entries (the payload already has that array), so this
# adds to the card rather than restructuring it.
#
# SILENT AND EMPTY ON ANY DOUBT. No receipt, unreadable JSON, no python -- emit
# nothing. A notification is a side channel; it must never fail a build, and it
# must never guess a verdict. An absent receipt yields no verdict field at all
# rather than a reassuring default.
_slack_verdict_fields() {
    local loki_dir="${LOKI_DIR:-.loki}"
    [ -d "$loki_dir/proofs" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    python3 - "$loki_dir" <<'PY' 2>/dev/null || true
import glob, json, os, sys
d = sys.argv[1]
paths = sorted(glob.glob(os.path.join(d, "proofs", "*", "proof.json")))
if not paths:
    sys.exit(0)
try:
    r = json.load(open(paths[-1]))
except (OSError, ValueError):
    sys.exit(0)

def esc(s):
    return json.dumps(str(s))[1:-1]

out = []
qg = r.get("quality_gates") or {}
gates = qg.get("gates") or []
if gates:
    passed = sum(1 for g in gates if str(g.get("status", "")).startswith("pass"))
    out.append(("Gates", f"{passed}/{len(gates)} passed"))

git = (r.get("facts") or {}).get("git") or {}
# base_sha empty means the receipt cannot be anchored, so it cannot be
# verified. Say that plainly rather than showing a diff count that implies it.
if not git.get("base_sha"):
    out.append(("Verified", "no (unanchored receipt)"))
else:
    diff = git.get("diff") or {}
    if diff.get("count") is not None:
        out.append(("Files changed", str(diff["count"])))

run_id = r.get("run_id")
if run_id:
    out.append(("Receipt", esc(run_id)))

print(",".join(
    '{"title": "%s", "value": "%s", "short": true}' % (esc(t), esc(v))
    for t, v in out
))
PY
}

_notify_slack() {
    local event="$1"
    local title="$2"
    local message="$3"

    # Skip if no webhook URL configured
    [ -z "$LOKI_SLACK_WEBHOOK" ] && return 0

    local project
    project="$(_get_project_name)"
    local color
    color="$(_get_slack_color "$event")"

    # Escape strings for JSON
    local escaped_title escaped_message escaped_event escaped_project
    escaped_title="$(_json_escape "$title")"
    escaped_message="$(_json_escape "$message")"
    escaped_event="$(_json_escape "$event")"
    escaped_project="$(_json_escape "$project")"

    # Receipt-derived fields. Empty on any doubt, and the ${var:+,...} expansion
    # below means an empty value adds no trailing comma -- a malformed payload
    # would make Slack reject the whole card, so the failure mode of "no receipt"
    # must be a card without verdict fields, never a card that does not send.
    local verdict_fields
    verdict_fields="$(_slack_verdict_fields 2>/dev/null || true)"

    # Build Slack payload with attachment
    local payload
    payload=$(cat <<PAYLOAD
{
    "attachments": [{
        "color": "$color",
        "title": "Loki Mode: $escaped_title",
        "text": "$escaped_message",
        "fields": [
            {"title": "Event", "value": "$escaped_event", "short": true},
            {"title": "Project", "value": "$escaped_project", "short": true}${verdict_fields:+,$verdict_fields}
        ],
        "footer": "Loki Mode",
        "ts": $(date +%s)
    }]
}
PAYLOAD
)

    # Send in background with timeout, fail silently
    (curl -s --fail --connect-timeout 5 --max-time 10 -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$LOKI_SLACK_WEBHOOK" \
        >/dev/null 2>&1) &
}

#===============================================================================
# Discord Notifications
#===============================================================================

_notify_discord() {
    local event="$1"
    local title="$2"
    local message="$3"

    # Skip if no webhook URL configured
    [ -z "$LOKI_DISCORD_WEBHOOK" ] && return 0

    local project
    project="$(_get_project_name)"
    local timestamp
    timestamp="$(_get_timestamp)"
    local color
    color="$(_get_discord_color "$event")"

    # Escape strings for JSON
    local escaped_title escaped_message escaped_event escaped_project
    escaped_title="$(_json_escape "$title")"
    escaped_message="$(_json_escape "$message")"
    escaped_event="$(_json_escape "$event")"
    escaped_project="$(_json_escape "$project")"

    # Build Discord embed payload
    local payload
    payload=$(cat <<PAYLOAD
{
    "embeds": [{
        "title": "Loki Mode: $escaped_title",
        "description": "$escaped_message",
        "color": $color,
        "fields": [
            {"name": "Event", "value": "$escaped_event", "inline": true},
            {"name": "Project", "value": "$escaped_project", "inline": true}
        ],
        "footer": {"text": "Loki Mode"},
        "timestamp": "$timestamp"
    }]
}
PAYLOAD
)

    # Send in background with timeout, fail silently
    (curl -s --fail --connect-timeout 5 --max-time 10 -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$LOKI_DISCORD_WEBHOOK" \
        >/dev/null 2>&1) &
}

#===============================================================================
# Generic Webhook Notifications
#===============================================================================

_notify_webhook() {
    local event="$1"
    local title="$2"
    local message="$3"
    local metadata="${4:-{}}"

    # Skip if no webhook URL configured
    [ -z "$LOKI_WEBHOOK_URL" ] && return 0

    local project
    project="$(_get_project_name)"
    local timestamp
    timestamp="$(_get_timestamp)"

    # Escape strings for JSON
    local escaped_title escaped_message escaped_event escaped_project
    escaped_title="$(_json_escape "$title")"
    escaped_message="$(_json_escape "$message")"
    escaped_event="$(_json_escape "$event")"
    escaped_project="$(_json_escape "$project")"

    # Ensure metadata is valid JSON, default to empty object
    if [ -z "$metadata" ] || [ "$metadata" = "{}" ]; then
        metadata="{}"
    fi

    # Build standard JSON payload
    local payload
    payload=$(cat <<PAYLOAD
{
    "event": "$escaped_event",
    "project": "$escaped_project",
    "title": "$escaped_title",
    "message": "$escaped_message",
    "timestamp": "$timestamp",
    "metadata": $metadata
}
PAYLOAD
)

    # Send in background with timeout, fail silently
    (curl -s --fail --connect-timeout 5 --max-time 10 -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$LOKI_WEBHOOK_URL" \
        >/dev/null 2>&1) &
}

#===============================================================================
# Unified Notification Function (Main Entry Point)
#===============================================================================

# Send notification to all configured channels
# Usage: notify <event> <title> <message> [metadata_json]
# Events: session_start, session_end, task_complete, error, milestone, warning
notify() {
    local event="$1"
    local title="$2"
    local message="$3"
    local metadata="${4:-}"

    # Skip if notifications disabled
    [ "$NOTIFICATIONS_ENABLED" != "true" ] && return 0

    # Validate required parameters
    if [ -z "$event" ] || [ -z "$title" ]; then
        return 0
    fi

    # Send to all configured channels (background, non-blocking)
    _notify_slack "$event" "$title" "$message" "$metadata"
    _notify_discord "$event" "$title" "$message" "$metadata"
    _notify_webhook "$event" "$title" "$message" "$metadata"

    return 0
}

#===============================================================================
# Convenience Functions
#===============================================================================

notify_session_start() {
    local prd_name="${1:-Unknown PRD}"
    notify "session_start" "Session Started" "Starting Loki Mode session with PRD: $prd_name"
}

notify_session_end() {
    local end_status="${1:-completed}"
    local duration="${2:-}"
    local msg="Loki Mode session ended with status: $end_status"
    [ -n "$duration" ] && msg="$msg (duration: $duration)"
    notify "session_end" "Session Ended" "$msg"
}

notify_task_complete() {
    local task_name="$1"
    notify "task_complete" "Task Completed" "$task_name"
}

notify_milestone() {
    local milestone_name="$1"
    local details="${2:-}"
    notify "milestone" "Milestone Reached" "$milestone_name${details:+: $details}"
}

notify_error() {
    local error_msg="$1"
    local context="${2:-}"
    notify "error" "Error Occurred" "$error_msg${context:+ (Context: $context)}"
}

notify_warning() {
    local warning_msg="$1"
    notify "warning" "Warning" "$warning_msg"
}

#===============================================================================
# Self-test (run directly to test)
#===============================================================================

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Testing Loki Mode Notification System"
    echo "======================================"
    echo ""
    echo "Environment:"
    echo "  LOKI_SLACK_WEBHOOK: ${LOKI_SLACK_WEBHOOK:-(not set)}"
    echo "  LOKI_DISCORD_WEBHOOK: ${LOKI_DISCORD_WEBHOOK:-(not set)}"
    echo "  LOKI_WEBHOOK_URL: ${LOKI_WEBHOOK_URL:-(not set)}"
    echo "  LOKI_PROJECT: ${LOKI_PROJECT:-(auto-detect)}"
    echo "  LOKI_NOTIFICATIONS: ${LOKI_NOTIFICATIONS:-true}"
    echo ""

    if [ -z "$LOKI_SLACK_WEBHOOK" ] && [ -z "$LOKI_DISCORD_WEBHOOK" ] && [ -z "$LOKI_WEBHOOK_URL" ]; then
        echo "No webhook URLs configured. Set at least one of:"
        echo "  export LOKI_SLACK_WEBHOOK='https://hooks.slack.com/...'"
        echo "  export LOKI_DISCORD_WEBHOOK='https://discord.com/api/webhooks/...'"
        echo "  export LOKI_WEBHOOK_URL='https://your-endpoint.com/webhook'"
        exit 1
    fi

    echo "Sending test notification..."
    notify "session_start" "Test Notification" "This is a test from Loki Mode notification system"

    # Wait for background jobs to complete
    sleep 2
    echo "Done. Check your configured channels for the test message."
fi
