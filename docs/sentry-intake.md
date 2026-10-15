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


## Slack and Linear delegation

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

Reply targets are stored server side keyed by job id, captured only after verification. Notifier errors are logged and never fail the job. Poll status with `GET /jobs/<id>`.
