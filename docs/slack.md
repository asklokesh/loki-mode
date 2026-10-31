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
- When the run ends BLOCKED, the question is posted in the same thread. A reply in that thread resumes the BLOCKED run under the same run id with your answer added to its locked task; stages that already settled are not re-run.
- The CLI `loki answer <run-id> "<text>"` has the same semantics: the log records `run.resumed` for the same run id, not a second `run.started`.
- Runs are launched through the repo `bin/loki` with the two Slack secrets removed from the child environment and `LOKI_NO_BROWSER=1` set. A failed Slack post logs one redacted line to stderr.
- Every request is verified with the Slack signature (HMAC sha256 over `v0:timestamp:body`, constant-time compare, timestamps older than 5 minutes are rejected). Retried events are deduplicated.

## Who can start a run

Set `LOKI_SLACK_ALLOWED_USERS` to a comma-separated list of Slack user IDs (for example `U012ABC,U034DEF`). A mention or a BLOCKED-thread answer from any other user is rejected with a short thread reply and nothing is spawned. When it is unset or blank, every mention is rejected (fail closed) and `loki slack serve` prints one startup line saying so. Set it to `*` to explicitly allow anyone in the workspace. The trigger server `/slack` slash command applies the same variable to the form `user_id`.

Limits: task text over 64 KB is rejected with "task too long" and no run starts. If a run cannot be launched, the thread gets a generic message and the detail (which may include local paths) is logged to stderr only. `--port` must be a whole number (an empty value exits 2).

## App manifest scopes

Bot token scopes: `app_mentions:read`, `chat:write`, `channels:history` (and `groups:history` for private channels, `im:history` for DMs).

Subscribe to bot events: `app_mention`, `message.channels` (plus `message.groups` for private channels).

Outbound notifications (PR opened, BLOCKED, finished) are separate and use `LOKI_SLACK_WEBHOOK_URL`.

Stuck-run alert: if a live run writes no event for `LOKI_STUCK_MIN` minutes (default 15), one alert names the last stage, its event time and a suggested action. It always prints to stderr and also goes to Slack when a webhook is set. A new event clears the alert, and a later silence can alert again. Checked on the 15-second supervisor beat. A value of 0, a negative number or a non-number falls back to 15.
