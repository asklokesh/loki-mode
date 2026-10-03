# Two-way Slack (preview)

Off by default. Set `LOKI_SLACK_INBOUND=1` to enable the inbound handler.

```bash
export LOKI_SLACK_INBOUND=1
export SLACK_BOT_TOKEN=...        # from env only, never stored by Loki
export SLACK_SIGNING_SECRET=...
loki slack serve --port 3000      # binds 127.0.0.1 unless --host is given
```

Point the Slack Events API request URL at this server through a tunnel or reverse proxy you control.

## What it does

- `@loki <issue ref or task text>` in a channel starts a Loki 10 run (the same entry as `loki "<task>"`) and replies in the thread with the run id.
- When the run ends BLOCKED, the question is posted in the same thread. A reply in that thread starts a follow-up run with your answer added to the original task (v10 has no in-place resume, BLOCKED is terminal).
- Every request is verified with the Slack signature (HMAC sha256 over `v0:timestamp:body`, constant-time compare, timestamps older than 5 minutes are rejected). Retried events are deduplicated.

## App manifest scopes

Bot token scopes: `app_mentions:read`, `chat:write`, `channels:history` (and `groups:history` for private channels, `im:history` for DMs).

Subscribe to bot events: `app_mention`, `message.channels` (plus `message.groups` for private channels).

Outbound notifications (PR opened, BLOCKED, finished) are separate and use `LOKI_SLACK_WEBHOOK_URL`.
