# Jira and Linear intake

Loki 10 can start a run from a Jira or Linear issue. This is intake only: the issue is fetched once, before any model runs, and normalized into the same `issue.json` GitHub intake writes (with a `source` field of `jira` or `linear`). Loki does not write back to the tracker or sync status.

```bash
loki jira:PROJ-123
loki linear:ENG-42
```

## Credentials (environment only)

- Jira: `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_BASE_URL` (for example `https://acme.atlassian.net`). `JIRA_BASE_URL` may be omitted when you pass an `atlassian.net` browse URL.
- Linear: `LINEAR_API_KEY`.

A missing variable stops the run with an error that names it. A Linear HTTP 401, or a GraphQL response with errors and no data, also names `LINEAR_API_KEY`.

## Self-hosted Jira

`<JIRA_BASE_URL>/browse/KEY` is accepted as a ref only when its origin equals the origin of `JIRA_BASE_URL`. A browse URL on any other host is not treated as a tracker ref.

## Kill switch

`LOKI_TRACKER_INTAKE=0` disables Jira and Linear refs entirely; they are then treated as ordinary text.

## Safety

Issue text is untrusted input. It is passed to the run as data and never grants tool authority.
