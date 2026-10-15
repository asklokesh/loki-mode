# Sentry intake

`loki start` turns a Sentry issue into a task spec (error, stack trace, breadcrumbs, acceptance criteria).

Offline, from an exported JSON file (issue export, event, or `{issue, event}`):

    loki start ./sentry-issue.json

From a URL (needs `SENTRY_AUTH_TOKEN`; without it nothing is fetched):

    SENTRY_AUTH_TOKEN=... loki start https://sentry.io/organizations/acme/issues/4001/

The token is sent only to the Sentry host through a curl config on stdin, never on argv, and is never printed. Implementation: `autonomy/issue-providers.sh` (`normalize_sentry_json`).

## Webhook: self-healing entry point

`autonomy/trigger-server.py` accepts `POST /sentry`, a Sentry integration webhook authenticated by Sentry's own HMAC (`sentry-hook-signature`, hex HMAC-SHA256 of the body).

1. Set the client secret: `LOKI_SENTRY_WEBHOOK_SECRET` (or `SENTRY_CLIENT_SECRET`). It must differ from the GitHub webhook secret and the API token. With no secret the route answers 503 and nothing is enqueued.
2. Start the server: `python3 autonomy/trigger-server.py --port 8080` and point the Sentry alert webhook at `/sentry`.
3. A valid alert is normalized with `normalize_sentry_json` and enqueues `loki start "<brief>" --pr --detach`. A bad signature gets 401.

The output is a receipt-gated PR only, never a deploy. Whether the PR opens is still decided by the policy file (`autonomy`).


## Slack, Linear, Jira and Teams delegation

`loki trigger` server setup for delegating a job from chat or a tracker. Both routes enqueue through the same job queue and runner as `POST /jobs`; a completion summary goes back to the origin. Nothing unauthenticated can start a job or choose a reply URL.

Secrets are env only and must differ from each other, the GitHub webhook secret, the API token and the Sentry secret (an equal secret disables its route at startup). A missing secret answers 503 naming the variable, and the server logs a startup warning. None of them reach the `loki start` child environment.

Slack (`POST /slack`):

1. Set `SLACK_SIGNING_SECRET`. Point a `/loki` slash command (and Events URL verification) at `/slack`.
2. The signature is `v0=` + hex HMAC-SHA256 over `v0:<X-Slack-Request-Timestamp>:<raw body>`, window 300s, the same contract as `loki-ts/src/contrib/slack_inbound.ts`. Bad, stale or missing signature: 401, nothing queued.
3. The command text is the spec (one line, not starting with `-`) and runs as `loki start <text> --detach`. Slack gets an ephemeral reply carrying the job id.
4. On completion the summary is posted to the request's `response_url`, only if it starts with `https://hooks.slack.com/`. Any other host is never contacted.

Linear (`POST /linear`):

1. Set `LINEAR_WEBHOOK_SECRET`. Point a Linear issue webhook at `/linear`.
2. `Linear-Signature` is the hex HMAC-SHA256 of the raw body, and the signed `webhookTimestamp` must be within 300s. Otherwise 401.
3. A created issue enqueues `loki start linear:<identifier> --detach` and answers 202 with the job id. Other events are skipped.
4. If `LINEAR_API_KEY` is set, a comment with the result is posted on the issue through `https://api.linear.app/graphql`. Without it nothing is posted.

Jira (`POST /jira`):

1. Set `JIRA_WEBHOOK_SECRET` (the secret on a Jira Cloud webhook) and point the webhook at `/jira`. Set `JIRA_ASSIGNEES` (comma-separated accountId, email or display name) and/or `JIRA_LABELS`. With neither set, every event is skipped.
2. `X-Hub-Signature` is `sha256=` + hex HMAC-SHA256 of the raw body. Bad or missing signature: 401. Jira signs no timestamp, so replay is bounded by `X-Atlassian-Webhook-Identifier`: a repeated delivery id answers `duplicate` and queues nothing.
3. `jira:issue_created`, or `jira:issue_updated` whose changelog touches assignee or labels, runs only when the issue is assigned to a configured user or has a configured label. The key, summary and description are folded into a one-line brief (1500 bytes max) and run as `loki start "<brief>" --pr --detach`. Answers 202 with the job id.

Teams (`POST /teams`):

1. Set `TEAMS_SECURITY_TOKEN` (the base64 token Teams shows when you create the outgoing webhook) and point the webhook at `/teams`.
2. `Authorization: HMAC <base64>` is the base64 HMAC-SHA256 of the raw body keyed by the base64-decoded token. Bad signature: 401. The activity `timestamp` must be within 300s; a stale or missing one is refused with 401.
3. The message text (with `<at>` mentions and tags removed) is the brief and runs as `loki start "<brief>" --pr --detach`. Teams gets a synchronous reply `Queued loki job <id>`. A repeated activity id is not queued twice.

Jira and Teams runs are receipt-gated PR runs only: the server always passes `--pr` and never a deploy argument, so shipping stays a separate gated step. Neither secret reaches the `loki start` child environment, and both must differ from every other credential. A missing secret answers 503 naming the variable.

Reply targets are stored server side keyed by job id, captured only after verification. Notifier errors are logged and never fail the job. Poll status with `GET /jobs/<id>`.
