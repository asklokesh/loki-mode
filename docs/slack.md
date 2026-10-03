# Two-way Slack

On by default. Set `LOKI_SLACK_INBOUND=0` to disable the inbound handler (`loki slack serve` then exits 2).

Without `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET`, `loki slack serve` prints one line naming both and exits 2 without binding a port.

```bash
export SLACK_BOT_TOKEN=...        # from env only, never stored by Loki
export SLACK_SIGNING_SECRET=...
loki slack serve --port 3000      # binds 127.0.0.1 unless --host is given
```

Point the Slack Events API request URL at this server through a tunnel or reverse proxy you control.

## What it does

- `@loki <issue ref or task text>` in a channel starts a Loki 10 run (it launches `bin/loki "<task>"`; the text must be at least two words and must not start with `-`, otherwise the bot replies asking you to describe the task, so a lone word like `reset` can never reach a legacy subcommand) and replies in the thread with the run id.
- When the run ends BLOCKED, the question is posted in the same thread. A reply in that thread starts a follow-up run with your answer added to the original task (v10 has no in-place resume, BLOCKED is terminal).
- Runs are launched through the repo `bin/loki` with the two Slack secrets removed from the child environment and `LOKI_NO_BROWSER=1` set. A failed Slack post logs one redacted line to stderr.
- Every request is verified with the Slack signature (HMAC sha256 over `v0:timestamp:body`, constant-time compare, timestamps older than 5 minutes are rejected). Retried events are deduplicated.

## App manifest scopes

Bot token scopes: `app_mentions:read`, `chat:write`, `channels:history` (and `groups:history` for private channels, `im:history` for DMs).

Subscribe to bot events: `app_mention`, `message.channels` (plus `message.groups` for private channels).

Outbound notifications (PR opened, BLOCKED, finished) are separate and use `LOKI_SLACK_WEBHOOK_URL`.
