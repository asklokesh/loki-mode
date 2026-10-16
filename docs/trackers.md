# Jira and Linear intake

Loki 10 can start a run from a Jira or Linear issue. The issue is fetched once, before any model runs, and normalized into the same `issue.json` GitHub intake writes (with a `source` field of `jira` or `linear`). Loki can also write the outcome back to the ticket (see Writeback below); it never syncs status beyond that.

```bash
loki jira:PROJ-123
loki linear:ENG-42
```

## Credentials (environment only)

- Jira: `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_BASE_URL` (for example `https://acme.atlassian.net`). `JIRA_BASE_URL` may be omitted when you pass an `atlassian.net` browse URL.
- Linear: `LINEAR_API_KEY`.

A missing variable stops the run with an error that names it. A Linear HTTP 401, or a GraphQL response with errors and no data, also names `LINEAR_API_KEY`.

## Writeback

When the run starts from a `jira:` or `linear:` ref, `loki start` exports `LOKI_WRITEBACK_ISSUE` with the issue key, and the same credentials used for intake enable writeback. With no ref, writeback stays off unless the legacy `LOKI_JIRA_URL`, `LOKI_JIRA_TOKEN`, `LOKI_JIRA_EMAIL` or `LOKI_LINEAR_TOKEN` variables are set. With nothing configured, no network call is made.

- done: a comment with the verdict, the PR URL and the receipt sha256.
- blocked: a comment that the run needs input, with the reason.
- failed: a comment that the run ended without a PR, with the reason.
- started: supported by the contract, with its own comment text; the engine does not emit it today.

Optional status moves happen only on done: `LOKI_JIRA_DONE_TRANSITION` (a Jira transition id) and `LOKI_LINEAR_DONE_STATE` (a Linear workflow state id). Failures warn on stderr and never change a verdict or exit code. Tokens are never logged.

## Self-hosted Jira

`<JIRA_BASE_URL>/browse/KEY` is accepted as a ref only when its origin equals the origin of `JIRA_BASE_URL`. A browse URL on any other host is not treated as a tracker ref.

## Kill switch

`LOKI_TRACKER_INTAKE=0` disables Jira and Linear refs entirely; they are then treated as ordinary text.

## Safety

Issue text is untrusted input. It is passed to the run as data and never grants tool authority.

## Inbound comments and transitions

Transitions: LOKI_JIRA_{STARTED,BLOCKED,DONE}_TRANSITION (transition ids) and LOKI_LINEAR_{STARTED,BLOCKED,DONE}_STATE (state ids) move the ticket when the run starts, blocks or finishes.

Steer from comments: the trigger server turns a Jira `comment_created` (POST /jira) or Linear `Comment` create (POST /linear) into `loki steer` (source=jira|linear, actor recorded) when the author is listed in LOKI_JIRA_STEER_ACTORS (accountIds) or LOKI_LINEAR_STEER_ACTORS (user ids) and a run this server dispatched for that issue is in flight. Unset lists reject everyone.
