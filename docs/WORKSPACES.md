# Workspaces: one issue across several repos

On by default. Set `LOKI_WORKSPACES=0` to disable. Design: `docs/v10/D51-PHASE-B.md`.

Define a group of repos once in `loki.yaml`:

```yaml
workspaces:
  shop:
    repos:
      - {repo: acme/api, path: ~/src/api, setup: "npm ci"}
      - {repo: acme/web, path: ~/src/web, after: [acme/api]}
    integration: {command: "make e2e", timeout_s: 900}
```

Repos with no pending `after` run in parallel, at most `concurrency` at a time (default 2; set `LOKI_WORKSPACE_CONCURRENCY` to change it).

Then:

```bash
loki workspace list
loki workspace show shop
loki workspace run shop acme/api#12
loki workspace status            # every recorded run, one row per repo
loki workspace status <run-id>
```

- Each repo gets its own git worktree on a `loki/ws-<run-id>-N` branch and its own engine run. Your checkouts are not touched.
- `after` orders repos: a repo starts once its predecessors succeed. If a predecessor fails, its dependents are SKIPPED.
- A failing repo does not stop the others (continue and report). The command exits 0 only when every repo succeeded and the integration step did not fail. It exits 3 when the only non-ok outcomes are budget stops (a child exited 3, or a dependent was skipped behind one), and 1 for any other failure. Ctrl-C (SIGINT) stops the recorded child process groups like SIGTERM.
- The repo that owns the issue ref gets the ref; other repos get a task text naming the ref and the sibling worktree paths as read-only context.
- After all repos finish, the `integration` command runs once from the run directory with `LOKI_WS_DIR_<OWNER>_<REPO>` pointing at each worktree. A timeout counts as failed. With no integration configured the status is `not_configured`.
- Evidence is written to `.loki/workspaces/<name>/<run-id>/integration.json`: head SHA per repo, exit code, log sha256. It is not part of the Seal.
- Without `path`, a repo is cloned to `~/.loki/repos/owner__name`.
- After the integration step, a PR comment is posted on each repo PR that exists for its run branch, showing the integration status (PASSED, FAILED, TIMEOUT or NOT CONFIGURED) and every head SHA. It uses your own `gh` login or GH_TOKEN, skips silently when there is no PR, never fails the run, and is disabled with `LOKI_WORKSPACE_COMMENT=0`.
- Backlog (`loki backlog`) and dashboard starts now share the workspace worktree prep: a per-repo lock, a clean start point and copied dependencies. `LOKI_WORKSPACES=0` restores the previous worktree creation (D51-B05, D51-B06).
