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

