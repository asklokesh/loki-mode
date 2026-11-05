# Workspaces: one issue across several repos

On by default. Set `LOKI_WORKSPACES=0` to disable.

Define a group of repos once in `loki.yaml`:

```yaml
workspaces:
  shop:
    repos:
      - {repo: acme/api, path: ~/src/api, setup: "npm ci"}
      - {repo: acme/web, path: ~/src/web, after: [acme/api]}
    integration: {command: "make e2e", timeout_s: 900, per_stage: false}
    concurrency: 2
    plan: false
    affected: false
```

The `workspaces:` block is validated and fails closed: a misspelled key (for example `afer`) or a wrong type exits 2 and names the key.

Repos with no pending `after` run in parallel, at most `concurrency` at a time (default 2; set `LOKI_WORKSPACE_CONCURRENCY` to change it).

Then:

```bash
loki workspace list
loki workspace show shop
loki workspace run shop acme/api#12
loki start --workspace shop "<brief>"   # same runner, from the primary command
loki workspace infer shop        # print suggested after: edges
loki workspace affected shop "rename customer id"   # print which repos the goal touches
loki workspace status            # every recorded run, one row per repo
loki workspace status <run-id>
```

- Each repo gets its own git worktree on a `loki/ws-<run-id>-N` branch and its own engine run. Your checkouts are not touched.
- `after` orders repos: a repo starts once its predecessors succeed. If a predecessor fails, its dependents are SKIPPED.
- A failing repo does not stop the others (continue and report). The command exits 0 only when every repo succeeded and the integration step did not fail. It exits 3 when the only non-ok outcomes are budget stops (a child exited 3, or a dependent was skipped behind one), and 1 for any other failure. Ctrl-C (SIGINT) stops the recorded child process groups like SIGTERM.
- The repo that owns the issue ref gets the ref; other repos get a task text naming the ref and the sibling worktree paths as read-only context.
- After all repos finish, the `integration` command runs once from the run directory with `LOKI_WS_DIR_<OWNER>_<REPO>` pointing at each worktree. A timeout counts as failed. With no integration configured the status is `not_configured`.
- Evidence is written to `.loki/workspaces/<name>/<run-id>/integration.json`: head SHA per repo, exit code, log sha256. When every repo succeeded, integration did not fail and every child sealed a receipt, the run also seals a signed `composite.json` that binds integration.json (its status, exit code and log hash), `integration.log`, every repo head SHA and every child receipt (see "Verify a workspace run"). Sealing refuses a failed or interrupted integration run, a nonzero exit code, a missing integrated head and a log that does not match its recorded hash.
- `loki workspace infer <name>` prints suggested `after:` edges read from package.json, go.mod and pyproject.toml dependencies on other listed repos. It also suggests an edge from (1) a source import (TS/JS import or require, Python import, Go import path) of a sibling's package or module name even when the manifest does not declare it, scanning at most 400 source files per repo, and (2) a client generator config (openapitools.json, openapi-generator*.yaml, orval.config.*) whose input spec path lies inside a sibling checkout. Each inferred edge prints its evidence as `file:line`. It is print-only and cycle-checked; it never edits loki.yaml.
- `plan: true` (or `LOKI_WORKSPACE_PLAN=1`) makes one provider call that decomposes the brief per repo into `<run-dir>/plan.json`. A valid plan gives each listed repo its own task; an invalid one falls back to the generic text and prints the reason.
- `integration: {per_stage: true}` also runs the integration command after each topological layer. A failing stage SKIPs every later layer, so a broken contract stops before downstream repos build on it.
- Without `path`, a repo is cloned to `~/.loki/repos/owner__name`.
- After the integration step, a PR comment is posted on each repo PR that exists for its run branch, showing the integration status (PASSED, FAILED, TIMEOUT or NOT CONFIGURED) and every head SHA. It uses your own `gh` login or GH_TOKEN, skips silently when there is no PR, never fails the run, and is disabled with `LOKI_WORKSPACE_COMMENT=0`.
- Metrics: each run records `timing` (per repo `started_at` and `finished_at`, epoch seconds) in integration.json. `python3 autonomy/lib/workspace_metrics.py <run-dir> --attention-min 30` prints `prs` (repos with outcome ok), `wall_clock_seconds` (earliest start to latest finish), `prs_per_hour` and `prs_per_attention_minute`. Runs recorded before timing existed, and any run where `--attention-min` is not given, print `unmeasured` for the affected rate, never zero.
- Verify a run: see "Verify a workspace run" below.
- Backlog (`loki backlog`) and dashboard starts now share the workspace worktree prep: a per-repo lock, a clean start point and copied dependencies. `LOKI_WORKSPACES=0` restores the previous worktree creation (D51-B05, D51-B06).

## Let the goal pick the repos

```bash
loki workspace affected shop "rename customer id everywhere"      # print-only, no model call, writes nothing
LOKI_WORKSPACE_AFFECTED=1 loki workspace run shop "rename customer id everywhere"
loki start --workspace shop "<goal>"                              # with LOKI_WORKSPACE_AFFECTED=1 or `affected: true`
```

`affected` searches each repo's tracked files (`git grep`, skipping node_modules, dist, build, vendor and .loki) for terms taken from the goal and prints one row per repo: `selected` with the first `file:line (term)` hit, or `not selected (no match)`, then the run order. Add `--json` for the full selection (`terms`, `selected`, `not_selected`, `evidence`, `fallback`, `order`).

Terms are lexical and limited:
- Explicit identifiers are taken verbatim: backticked or quoted text, words containing `_`, camelCase words, and capitalised words that do not start the goal.
- Every run of 2 or 3 consecutive plain words (stopwords such as rename, all, the break a run) becomes spelling variants: `customer_id`, `customer-id`, `customerId`, `CustomerId`, `CUSTOMER_ID`, `customerid`, and `customerID` and `CustomerID` when the last word is 3 letters or fewer. A single plain word is never a term.
- A hit must sit on word boundaries: `customerId` matches `customerIdentity` no more than `id` matches `idle`.
- A synonym or abbreviation (`custId` for "customer id") is missed, and a mention in docs or a comment counts as a hit.
- With an `owner/repo#N` goal the issue owner is always selected and the issue title and body supply the terms (a `gh` failure prints `issue text unavailable` and uses no terms).

Fail-open cases, so a repo is never silently dropped on an error: a repo with no local checkout is included unscanned, a repo whose scan errors or exceeds 60 seconds is included, and when no repo matches at all every repo runs (`no repo matched the goal; running every repo`).

With `affected: true` or `LOKI_WORKSPACE_AFFECTED=1`, `run` runs only the selected repos. Their order is the declared `after` edges plus the edges `infer` computes (manifest, import and OpenAPI generator evidence), limited to the selected repos; an inferred cycle falls back to the declared edges and prints why. Unselected repos are not changed, but the integration command still sees their checkouts through `LOKI_WS_DIR_<OWNER>_<REPO>`. The selection (with evidence) is written to integration.json, so the signed composite.json also attests which repos were chosen and why.

Every repo PR comment now ends with a "Linked PRs" section naming each sibling PR (with `(this PR)` and `(draft)` markers), and the run summary prints each PR URL plus `linked PRs: K of N repos have an open PR (R ready, D draft)`. These need `gh`; without it the line reads 0 of N.

Pruning is off by default, because a lexical miss would leave a repo out of the linked set while the run exits 0. Turn it on per workspace with `affected: true`, or per run (including `loki start --workspace`) with `LOKI_WORKSPACE_AFFECTED=1`.

## Verify a workspace run

After `loki workspace run <name> <ref>` finishes, check the evidence rather than trusting the exit code alone:

1. Exit code: 0 means every repo succeeded and integration did not fail; 3 means only budget stops; 1 is any other failure.
2. `loki workspace status` prints one row per repo and the integration status for each recorded run.
3. `.loki/workspaces/<name>/<run-id>/integration.json` holds `status`, the head SHA per repo and `timing`.
4. `python3 autonomy/lib/workspace_metrics.py <run-dir> --attention-min <minutes>` prints `prs`, `prs_per_hour` and `prs_per_attention_minute`; any value it cannot measure prints `unmeasured`.
5. Each repo PR for the run branch carries exactly one integration comment.
6. `loki verify <run-dir>/composite.json` re-checks the composite offline (add `--pubkey FILE` on another machine). It recomputes the composite hash, re-verifies every child receipt from disk and checks the signature. It prints the integration result and every repo head SHA it attests. It is TAMPERED for a tampered or swapped child, a child head that is not the integrated head, a failed or interrupted integration status or nonzero exit code, an edited integration section, or an `integration.log` that no longer matches its recorded hash. It is UNCHECKED for an unsigned child under a signed composite, and for a legacy composite that predates the integration section and has no integrated head to compare. Deployed-SHA binding is partial: `loki deploy --execute` ships a signed `.well-known/loki-provenance.json` (head_sha, tree_sha, receipt_sha256, run_id, built_at) in the static root of a single-repo nextjs, Vite or built-static project (public/, dist/ or build/) and, when the provider prints a URL, fetches it back through `loki verify --url --expect-sha`. The deploy record's `live_binding` is VERIFIED only when the served doc is signed and names the anchor SHA; a stale or forged doc is FAILED (FAILED_HEALTH, exit 4), an unreachable one is `unchecked`, and docker, python and node projects (no static root) are `unsupported`. A mismatch is retried inside the health attempts and interval budget before it is FAILED, so a URL still serving the previous build for a few seconds is not rolled back at once. A live doc that is unsigned or signed with an unknown key is `unchecked`, not FAILED, so a stale non-loki build serving such a doc passes silently. Under `--allow-unanchored` the anchor is UNPROVEN, so no doc is published and `live_binding` is `unanchored`. The deploy appends `**/.well-known/loki-provenance.json` to `.git/info/exclude` and leaves the file in the working tree. Every `loki deploy --execute` first removes that file from public/, dist/ and build/, so only a doc written by the current deploy ships; an unanchored, unsupported or unsigned deploy ships none. A provider run by hand outside `loki deploy --execute` uploads whatever doc the last loki deploy left, which names that deploy's SHA, not the new build. If the provider rebuilds remotely from a gitignored root, the doc is lost and the result is `unchecked`. None of this binds a composite: the composite attests what was integrated and tested, not what is running anywhere, and no workspace deploy writes or probes a provenance doc. Exit codes are the single-receipt ones: 0 VERIFIED, 1 TAMPERED, 2 UNCHECKED, 3 UNSIGNED. The composite never reads higher than its weakest child: one PARTIAL child caps it at PARTIAL.
7. A run that could not seal prints `composite not sealed: <reason>` (for example a repo with no receipt). Seal by hand with `loki verify --seal-composite <run-dir>`; it refuses unless every child has a receipt.

Not measured: no scale test exists for large repo counts. Claim only what you have run.

