# Sentry intake

`loki start` turns a Sentry issue into a task spec (error, stack trace, breadcrumbs, acceptance criteria).

Offline, from an exported JSON file (issue export, event, or `{issue, event}`):

    loki start ./sentry-issue.json

From a URL (needs `SENTRY_AUTH_TOKEN`; without it nothing is fetched):

    SENTRY_AUTH_TOKEN=... loki start https://sentry.io/organizations/acme/issues/4001/

The token is sent only to the Sentry host through a curl config on stdin, never on argv, and is never printed. Implementation: `autonomy/issue-providers.sh` (`normalize_sentry_json`).
