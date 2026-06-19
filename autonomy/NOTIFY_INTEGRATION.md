# Notification Integration Guide

This document describes how to integrate multi-channel notifications (Slack, Discord, Webhook) into run.sh.

> Note (v7.78.0): the convenience wrappers `notify_task_started`,
> `notify_task_completed`, `notify_task_failed`, `notify_phase_complete`, and
> `notify_all_complete` were never wired into the runtime and were removed as dead
> code. The live notification helpers are `notify_intervention_needed` and
> `notify_rate_limit` (plus the `notify_channels` snippets shown below). Snippets
> in this guide that reference the removed wrappers are illustrative of where a
> notification COULD be emitted; use `notify_channels` (or the live helpers) when
> actually wiring one.

## Quick Start

```bash
# Test notifications
loki notify test

# Check status
loki notify status

# Send to specific channel
loki notify slack "Build complete"
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `LOKI_SLACK_WEBHOOK` | Slack incoming webhook URL | `https://hooks.slack.com/services/...` |
| `LOKI_DISCORD_WEBHOOK` | Discord webhook URL | `https://discord.com/api/webhooks/...` |
| `LOKI_WEBHOOK_URL` | Custom webhook URL (POST JSON) | `https://your-server.com/loki-webhook` |
| `LOKI_NOTIFY_CHANNELS` | Channels to use (comma-separated) | `slack,discord` or `all` |

## Integration Points in run.sh

### 1. Source the notification functions

Add at the top of run.sh (after sourcing providers/loader.sh):

```bash
# Source notification functions from loki CLI
LOKI_CLI="$SCRIPT_DIR/loki"
if [ -f "$LOKI_CLI" ]; then
    # Export functions for use
    source "$LOKI_CLI" --source-only 2>/dev/null || true
fi
```

Or add the functions directly (simpler approach - recommended):

```bash
#===============================================================================
# Multi-Channel Notifications (Slack/Discord/Webhook)
#===============================================================================

# Send notification to Slack
notify_slack() {
    local message="$1"
    local event_type="${2:-Notification}"
    local webhook_url="${LOKI_SLACK_WEBHOOK:-}"

    [ -z "$webhook_url" ] && return 0

    local project_name=$(basename "$(pwd)")
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    curl -s -X POST -H 'Content-type: application/json' \
        --data "{\"blocks\":[{\"type\":\"header\",\"text\":{\"type\":\"plain_text\",\"text\":\"Loki Mode: $event_type\"}},{\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"$message\"}},{\"type\":\"context\",\"elements\":[{\"type\":\"mrkdwn\",\"text\":\"*Project:* $project_name | *Time:* $timestamp\"}]}]}" \
        "$webhook_url" > /dev/null 2>&1 || true
}

# Send notification to Discord
notify_discord() {
    local message="$1"
    local event_type="${2:-Notification}"
    local webhook_url="${LOKI_DISCORD_WEBHOOK:-}"

    [ -z "$webhook_url" ] && return 0

    local project_name=$(basename "$(pwd)")
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    curl -s -X POST -H 'Content-type: application/json' \
        --data "{\"embeds\":[{\"title\":\"Loki Mode: $event_type\",\"description\":\"$message\",\"color\":5814783,\"footer\":{\"text\":\"Project: $project_name | $timestamp\"}}]}" \
        "$webhook_url" > /dev/null 2>&1 || true
}

# Send notification to custom webhook
notify_webhook() {
    local message="$1"
    local event_type="${2:-Notification}"
    local webhook_url="${LOKI_WEBHOOK_URL:-}"

    [ -z "$webhook_url" ] && return 0

    local project_name=$(basename "$(pwd)")
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    curl -s -X POST -H 'Content-type: application/json' \
        --data "{\"source\":\"loki-mode\",\"event\":\"$event_type\",\"message\":\"$message\",\"project\":\"$project_name\",\"timestamp\":\"$timestamp\"}" \
        "$webhook_url" > /dev/null 2>&1 || true
}

# Broadcast to all configured channels
notify_channels() {
    local message="$1"
    local event_type="${2:-Notification}"
    local channels="${LOKI_NOTIFY_CHANNELS:-all}"

    [[ "$channels" == "all" || "$channels" == *"slack"* ]] && notify_slack "$message" "$event_type"
    [[ "$channels" == "all" || "$channels" == *"discord"* ]] && notify_discord "$message" "$event_type"
    [[ "$channels" == "all" || "$channels" == *"webhook"* ]] && notify_webhook "$message" "$event_type"
}
```

### 2. Session Start (after initialization in main())

Location: After line ~4826 (after `audit_log "SESSION_START"`)

```bash
    # Log session start for audit
    audit_log "SESSION_START" "prd=$PRD_PATH,dashboard=$ENABLE_DASHBOARD,staged_autonomy=$STAGED_AUTONOMY,parallel=$PARALLEL_MODE"

    # === ADD THIS ===
    # Send multi-channel notification for session start
    notify_channels "Session started for $(basename "$(pwd)")" "Session Start"
```

### 3. Session End (before cleanup in main())

Location: After line ~4881 (after `audit_log "SESSION_END"`)

```bash
    # Log session end for audit
    audit_log "SESSION_END" "result=$result,prd=$PRD_PATH"

    # === ADD THIS ===
    # Send multi-channel notification for session end
    if [ "$result" -eq 0 ]; then
        notify_channels "Session completed successfully ($ITERATION_COUNT iterations)" "Session Complete"
    else
        notify_channels "Session ended with exit code $result after $ITERATION_COUNT iterations" "Session Failed"
    fi
```

### 4. Task Completion (in run_autonomous function)

Location: After successful task completion (~line 4368 where `notify_all_complete` is called)

```bash
                log_header "COMPLETION PROMISE FULFILLED: $COMPLETION_PROMISE"
                log_info "Explicit completion promise detected in output."
                notify_all_complete

                # === ADD THIS ===
                notify_channels "Completion promise fulfilled: $COMPLETION_PROMISE" "Task Complete"

                save_state $retry "completion_promise_fulfilled" 0
                return 0
```

### 5. Error Handlers (in run_autonomous function)

Location: After error detection (~line 4395 where `notify_rate_limit` is called)

```bash
            log_warn "Rate limit detected! Waiting until reset (~$human_time)..."
            log_info "Rate limit resets at approximately $(date -v+${wait_time}S '+%I:%M %p' 2>/dev/null || date -d "+${wait_time} seconds" '+%I:%M %p' 2>/dev/null || echo 'soon')"
            notify_rate_limit "$wait_time"

            # === ADD THIS ===
            notify_channels "Rate limited - waiting $human_time before retry" "Rate Limited"
```

### 6. Pause Handler (in check_signals function)

Location: After pause detection (~line 4443)

```bash
    if [ -f "$loki_dir/PAUSE" ]; then
        log_warn "PAUSE file detected - pausing execution"
        notify_intervention_needed "Execution paused via PAUSE file"

        # === ADD THIS ===
        notify_channels "Execution paused - human intervention needed" "Paused"

        rm -f "$loki_dir/PAUSE"
        handle_pause
        return 1
```

### 7. Cleanup Handler (in cleanup function)

Location: In cleanup() around line 4564

```bash
cleanup() {
    local current_time=$(date +%s)
    local time_diff=$((current_time - INTERRUPT_LAST_TIME))

    # If double Ctrl+C within 2 seconds, exit immediately
    if [ "$time_diff" -lt 2 ] && [ "$INTERRUPT_COUNT" -gt 0 ]; then
        echo ""
        log_warn "Double interrupt - stopping immediately"

        # === ADD THIS ===
        notify_channels "Session interrupted by user" "Interrupted"

        stop_dashboard
        stop_status_monitor
        save_state ${RETRY_COUNT:-0} "interrupted" 130
        log_info "State saved. Run again to resume."
        exit 130
    fi
```

## Configuration via config.yaml

Add to `.loki/config.yaml`:

```yaml
notifications:
  # Desktop notifications (existing)
  enabled: true
  sound: true

  # Multi-channel notifications (new)
  slack_webhook: YOUR_SLACK_WEBHOOK_URL_HERE
  discord_webhook: https://discord.com/api/webhooks/123456789012345678/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  webhook_url: https://your-server.com/loki-webhook
  channels: all  # or: slack,discord,webhook
```

## Webhook Payload Format

Custom webhooks receive POST requests with this JSON structure:

```json
{
  "source": "loki-mode",
  "event": "Session Start|Session Complete|Task Complete|Rate Limited|Paused|Interrupted",
  "message": "Human-readable message",
  "project": "project-name",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

## Testing

```bash
# Set up webhook (example with Slack)
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/services/..."

# Test notification
loki notify test "Hello from Loki Mode!"

# Check status
loki notify status

# Send to specific channel
loki notify slack "Build deployed to production"
```
