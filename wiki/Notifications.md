# Notifications

Multi-channel notification system for Slack, Discord, custom webhooks, and dashboard triggers.

---

## Overview

Loki Mode sends real-time notifications for:
- Session start/end
- Task completion
- Errors and warnings
- Milestones

---

## Dashboard Notification Triggers (v5.40.0)

In addition to external webhooks, Loki Mode includes a built-in notification trigger system that monitors autonomous sessions and generates alerts visible in the dashboard.

### Default Triggers

| Trigger ID | Type | Severity | Description |
|------------|------|----------|-------------|
| `budget-80pct` | Budget threshold | Warning | Fires when budget usage exceeds 80% |
| `context-90pct` | Context threshold | Critical | Fires when context window exceeds 90% |
| `sensitive-file` | File access | Critical | Fires when .env, .pem, .key, credentials, or secret files are accessed |
| `quality-gate-fail` | Quality gate | Warning | Fires when a quality gate check fails |
| `stuck-iteration` | Stagnation | Warning | Fires after 3+ consecutive no-progress iterations |
| `compaction-freq` | Compaction frequency | Warning | Fires when 3+ context compactions occur per hour |

### Configuration

Triggers are stored in `.loki/notifications/triggers.json` and can be managed via the dashboard UI or API.

```bash
# View triggers
curl http://localhost:57374/api/notifications/triggers

# Update triggers
curl -X PUT http://localhost:57374/api/notifications/triggers \
  -H "Content-Type: application/json" \
  -d '{"triggers": [{"id": "budget-80pct", "enabled": false}]}'

# View active notifications
curl http://localhost:57374/api/notifications

# Acknowledge a notification
curl -X POST http://localhost:57374/api/notifications/notif-001/acknowledge
```

### Dashboard UI

The Notifications section in the dashboard (keyboard shortcut: Cmd+0) has two tabs:

- **Feed**: Chronological list of notifications with severity indicators (red=critical, yellow=warning, blue=info), timestamps, and acknowledge buttons
- **Triggers**: Enable/disable toggles and threshold configuration for each trigger type

### Provider Support

Notification triggers work with all providers (Claude, Codex, Gemini). The trigger evaluation reads from `.loki/` flat files which are provider-agnostic.

---

## External Channels

All notifications are:
- **Non-blocking** - Run in background
- **Fail-safe** - Won't break sessions if webhook fails
- **Color-coded** - Visual status indication

---

## Quick Setup

### Slack

```bash
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/services/T00/B00/xxx"
loki notify test
```

### Discord

```bash
export LOKI_DISCORD_WEBHOOK="https://discord.com/api/webhooks/xxx/yyy"
loki notify test
```

### Custom Webhook

```bash
export LOKI_WEBHOOK_URL="https://your-server.com/api/events"
loki notify test
```

---

## CLI Commands

### Check Status

```bash
loki notify status
```

**Output:**
```
Notification Channel Status

  [OK] Slack     - Configured
  [OK] Discord   - Configured
  [--] Webhook   - Not configured

Active channels: slack,discord

Test with: loki notify test
```

### Test Notifications

```bash
# Test all channels
loki notify test

# Test with custom message
loki notify test "Hello from Loki!"

# Test specific channel
loki notify slack "Build complete"
loki notify discord "Deployment started"
loki notify webhook "Custom event"
```

---

## Event Types

| Event | Color (Slack) | Color (Discord) | When |
|-------|---------------|-----------------|------|
| `session_start` | Blue | 3447003 | Session begins |
| `session_end` | Green | 5763719 | Session completes |
| `task_complete` | Green | 5763719 | Task finished |
| `milestone` | Purple | 10181046 | Major progress |
| `error` | Red | 15548997 | Error occurred |
| `warning` | Orange | 15981348 | Warning issued |

---

## Slack Integration

### Create Webhook

1. Go to [Slack Apps](https://api.slack.com/apps)
2. Create New App > From scratch
3. Add "Incoming Webhooks" feature
4. Activate and add to channel
5. Copy webhook URL

### Message Format

```json
{
  "attachments": [{
    "color": "#3498DB",
    "title": "Loki Mode: Session Started",
    "text": "Starting Loki Mode session with PRD: my-app.md",
    "fields": [
      {"title": "Event", "value": "session_start", "short": true},
      {"title": "Project", "value": "my-app", "short": true}
    ],
    "footer": "Loki Mode",
    "ts": 1706875200
  }]
}
```

### Configuration

```yaml
# .loki/config.yaml
notifications:
  enabled: true
  slack_webhook: "https://hooks.slack.com/services/T00/B00/xxx"
  channels: slack
```

---

## Discord Integration

### Create Webhook

1. Open Discord server settings
2. Go to Integrations > Webhooks
3. Create New Webhook
4. Select channel and copy URL

### Message Format

```json
{
  "embeds": [{
    "title": "Loki Mode: Task Completed",
    "description": "Implemented user authentication",
    "color": 5763719,
    "fields": [
      {"name": "Event", "value": "task_complete", "inline": true},
      {"name": "Project", "value": "my-app", "inline": true}
    ],
    "footer": {"text": "Loki Mode"},
    "timestamp": "2026-02-02T12:00:00Z"
  }]
}
```

### Configuration

```yaml
# .loki/config.yaml
notifications:
  enabled: true
  discord_webhook: "https://discord.com/api/webhooks/xxx/yyy"
  channels: discord
```

---

## Custom Webhooks

### Payload Format

POST request with JSON body:

```json
{
  "event": "task_complete",
  "project": "my-app",
  "title": "Task Completed",
  "message": "Implemented user authentication",
  "timestamp": "2026-02-02T12:00:00Z",
  "metadata": {}
}
```

### Integration Examples

#### Zapier

1. Create Zap with "Webhooks by Zapier" trigger
2. Choose "Catch Hook"
3. Copy webhook URL
4. Set `LOKI_WEBHOOK_URL`

#### IFTTT

1. Create Applet with Webhooks trigger
2. Copy webhook URL
3. Set `LOKI_WEBHOOK_URL`

#### Custom Server

```javascript
// Express.js example
app.post('/loki-webhook', (req, res) => {
  const { event, project, title, message, timestamp } = req.body;

  console.log(`[${timestamp}] ${project}: ${event} - ${message}`);

  // Forward to monitoring, database, etc.

  res.status(200).send('OK');
});
```

---

## Configuration Options

### Environment Variables

| Variable | Description |
|----------|-------------|
| `LOKI_NOTIFICATIONS` | Enable/disable (default: true) |
| `LOKI_SLACK_WEBHOOK` | Slack webhook URL |
| `LOKI_DISCORD_WEBHOOK` | Discord webhook URL |
| `LOKI_WEBHOOK_URL` | Custom webhook URL |
| `LOKI_PROJECT` | Project name override |
| `LOKI_NOTIFICATION_SOUND` | Desktop sound (default: true) |

### Config File

```yaml
notifications:
  enabled: true
  sound: true
  slack_webhook: "https://hooks.slack.com/..."
  discord_webhook: "https://discord.com/api/webhooks/..."
  webhook_url: "https://your-server.com/webhook"
  channels: all  # or: slack,discord,webhook
```

---

## Channel Selection

### All Channels (Default)

```bash
export LOKI_NOTIFY_CHANNELS=all
```

### Specific Channels

```bash
# Only Slack and Discord
export LOKI_NOTIFY_CHANNELS=slack,discord

# Only webhook
export LOKI_NOTIFY_CHANNELS=webhook
```

---

## Disable Notifications

### Temporarily

```bash
export LOKI_NOTIFICATIONS=false
loki start ./prd.md
```

### In Config

```yaml
notifications:
  enabled: false
```

### For CI/CD

```bash
# Typical CI config
export LOKI_NOTIFICATIONS=false
export LOKI_DASHBOARD=false
```

---

## Troubleshooting

### Notifications Not Sending

1. Check configuration:
   ```bash
   loki notify status
   ```

2. Test connectivity:
   ```bash
   loki notify test "Test message"
   ```

3. Verify webhook URL is correct

4. Check network/firewall

### Wrong Channel

```bash
# Check active channels
loki notify status

# Set specific channels
export LOKI_NOTIFY_CHANNELS=slack
```

### Message Not Appearing

- Slack: Check channel permissions
- Discord: Verify webhook is active
- Webhook: Check server logs

### Rate Limiting

Notifications are rate-limited by the receiving service:
- Slack: ~1 message/second
- Discord: ~5 messages/5 seconds

Loki Mode batches rapid events to avoid limits.
