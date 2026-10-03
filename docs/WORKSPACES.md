# Workspaces: one issue across several repos

Experimental, off by default. Set `LOKI_WORKSPACES=1` to enable. Design: `docs/v10/D51-PHASE-B.md`.

Define a group of repos once in `loki.yaml`:

```yaml
workspaces:
  shop:
    repos:
      - {repo: acme/api, path: ~/src/api, setup: "npm ci"}
      - {repo: acme/web, path: ~/src/web, after: [acme/api]}
    integration: {command: "make e2e", timeout_s: 900}
```

Then:

```bash
LOKI_WORKSPACES=1 loki workspace list
LOKI_WORKSPACES=1 loki workspace run shop acme/api#12
```

- Each repo gets its own git worktree on a `loki/ws-<run-id>-N` branch and its own engine run. Your checkouts are not touched.
- `after` orders repos: a repo starts once its predecessors succeed. If a predecessor fails, its dependents are SKIPPED.
- A failing repo does not stop the others (continue and report). The command exits 0 only when every repo succeeded and the integration step did not fail; otherwise 1.
- The repo that owns the issue ref gets the ref; other repos get a task text naming the ref and the sibling worktree paths as read-only context.
- After all repos finish, the `integration` command runs once from the run directory with `LOKI_WS_DIR_<OWNER>_<REPO>` pointing at each worktree. A timeout counts as failed. With no integration configured the status is `not_configured`.
- Evidence is written to `.loki/workspaces/<name>/<run-id>/integration.json`: head SHA per repo, exit code, log sha256. It is not part of the Seal.
- Without `path`, a repo is cloned to `~/.loki/repos/owner__name`.
