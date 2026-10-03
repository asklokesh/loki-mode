# D51 Phase B: workspaces, cross-repo runs, combined integration evidence

Architect design, 2026-10-01, base ee67eaf16. Flag: `LOKI_WORKSPACES=0` disables (on by default since D63 C8).

Status (D63 C8): `autonomy/lib/workspace.py` runs repos with no pending `after` in parallel (bounded by `concurrency`, default 2), has `list`, `show`, `run` and `status`, exits 3 when the only non-ok outcomes are budget stops, and handles SIGINT like SIGTERM. Still design only: B03 to B07, B09 to B15 (worktree_prep hardening, group.json store, dashboard, `clean`). The bash gate in `autonomy/loki` flips in C3.

## Goal (user-visible)
1. Name a group of repos once in loki.yaml (`workspaces.shop: [acme/api, acme/web]`) and run one issue across all of them: `loki workspace run shop acme/api#12`.
2. Each repo gets its own isolated worktree with working dependencies, its own engine run, its own Seal and its own PR; the user's checkouts are never touched.
3. One integration command runs against all the run branches together; its evidence (head SHAs, exit code, log hash) is attached to every PR and shown in the dashboard.

## What exists today (evidence)
- Two duplicate worktree paths. Headless: `autonomy/lib/backlog.py:232-241` (`worktree add -B loki/backlog-N <top>-backlog/issue-N HEAD`). UI: `dashboard/api_start.py:159-184` (clone to ~/.loki/repos/<slug>, fetch, `worktree add` off origin/HEAD under ~/.loki/worktrees). Neither copies or installs dependencies, and neither locks the shared base repo against concurrent fetch or worktree add.
- Missing dependencies are a live problem. `loki-ts/src/engine10/stages/verify.ts:39` resolves `.venv/bin/<bin>` inside repoDir, and `testmap.ts:45` does the same for the interpreter. A fresh worktree has no node_modules or .venv, and the D50-F1b opus review hit exactly this: its VERIFIED fixture stalled (BOARD.md row D50-F1b).
- Relaunch destroys evidence. `backlog.py:234-235` force-removes an existing issue worktree before relaunching, which is the open D51-A3b follow-up.
- The engine is single-repo and runs in its cwd. Intake refuses a dirty tracked tree (`intake.ts:65-67`); text tasks enter through `LOKI_E10_TASK_TEXT` (`intake.ts:74`), but only when no issue.json exists (`intake.ts:80`). The backstop stages with `git add -A` (`supervisor.ts:95`), so anything in the worktree that is not ignored gets committed.
- Run state in the UI is in memory only (`api_start.py:13`). `knowledge_sources` is parsed but nothing reads it (schema description). `loki.yaml` sets `additionalProperties: false` (`schemas/loki-yaml.schema.json:7`).
- D33 amendment (1): e10ext never runs tests or computes pass or fail. Integration checks therefore cannot live in loki-ts; they belong in autonomy/lib (Python), outside the Seal.
- Precedent for partial failure: `tests/test-multi-repo-orchestrates.sh` uses continue-and-report with a non-zero aggregate exit.

## Design
Principle: engine10 core is untouched. A workspace run calls the existing launcher once per repo, in a prepared worktree, exactly the way backlog.py does today. Phase B therefore adds no TypeScript, has no dist overlap and puts nothing new into the 5,000-line cap.

Config (loki.yaml, the only place workspaces are defined; everything else keeps working without a config file):
```
workspaces:
  shop:
    repos:
      - {repo: acme/api, path: ~/src/api, setup: "npm ci"}   # path optional, else clone; setup optional
      - {repo: acme/web, after: [acme/api]}                   # after: runs once api finishes
    integration: {command: "docker compose up --abort-on-container-exit", timeout_s: 900}
    integration_files: [.env]   # opt-in, integration step only, never the engine worktree
```
The schema accepts the `workspaces` key unconditionally, so a config written for a newer version does not fail validation on an older one; the flag gates only runtime behavior.

Worktree substrate (`autonomy/lib/worktree_prep.py`, one helper used by backlog, the UI and workspaces):
- Start point: fetch, then `origin/HEAD`, falling back to HEAD. Uncommitted user edits are never carried, never stashed and never snapshotted. The base SHA is recorded, and one line reports how many uncommitted changes in the source checkout were left out.
- Concurrency: an fcntl lock per base repo (`~/.loki/repos/<slug>.lock`) held around fetch and worktree add.
- Dependencies, in priority order:
  1. A declared `setup` command, run in the worktree.
  2. A copy-on-write copy (`cp -c` on APFS, `cp --reflink=auto` on Linux) of ignored top-level dependency directories: node_modules, .venv, venv, vendor.
  3. None, recorded as `deps: none`.
- Before a copied directory is accepted, it must pass two checks, or the copy is refused and the run ends FAILED with "deps: copy unsafe, declare setup":
  - `git check-ignore` at the start ref, so `add -A` can never commit it;
  - no escape into the source checkout: no absolute symlink, no editable `.pth` or `__editable__` finder, and no shebang pointing at the source path.
- Never symlink dependencies.
- Secrets: .env and similar files are never placed in an engine worktree, because issue text is untrusted and moat 9 forbids secrets in that step.
- A relaunch never deletes a kept worktree. It creates a new stamped one, and old ones are removed only by `clean`.

Group state lives on disk with one writer: `~/.loki/workspaces/<ws>/<group-id>/group.json`, written atomically by the runner process only. It holds:
- the workspace and the issue ref;
- per repo: base SHA, branch, worktree, run_id, outcome, pr_url, deps mode, and started and ended timestamps;
- integration: status, evidence path.

The CLI and the dashboard both read this file, so state survives a dashboard restart. The timestamps feed the D51 item 3 PRs-per-hour metric.

Cross-repo run (`autonomy/lib/workspace.py`):
- The issue is fetched once.
- Per-repo task text goes to each run through `LOKI_E10_TASK_TEXT` (no issue.json is written into those runs). By default it is the issue's `## repo: owner/name` section when present, otherwise the full issue. The text also carries a fixed preamble naming the sibling worktree paths as read-only context.
- Repos with no `after` run in parallel up to `concurrency`. A repo with `after` starts when its predecessors finish, with their worktrees at their final state.
- A repo that needs nothing ends ALREADY_SATISFIED with no PR, which is existing engine behavior.

Integration (`autonomy/lib/workspace_integration.py`):
- Runs after every repo run has finished, in `<group>/integration/`: worktrees of each repo at its run branch head, or at base if there was no change, plus deps through the same substrate, plus the opt-in integration_files.
- The command runs with a timeout and a killpg on timeout.
- It writes evidence.json: command, exit code, duration, the sha256 of the log, per-repo head SHAs, and the literal statement `"seal": false, "note": "integration evidence is not part of the Seal"`.
- One PR comment per PR links the group and states the result. If any head SHA no longer matches the PR head, the dashboard shows the evidence as stale.

Surface:
- CLI: `loki workspace list | show <ws> | run <ws> <ref> [--repos a,b] [--dry-run] | status [<group>] | clean <group>`.
- Dashboard: endpoints `GET /api/workspaces`, `POST /api/workspaces/{ws}/run`, `GET /api/workspaces/groups/{id}`, and a group card in start.html (per-repo row with outcome and PR link, plus an integration row).
- Exit codes: 0 when all repos are ok and integration passed; 3 for budget stops only; 1 otherwise. This is continue-and-report.

Failure modes:
- Clone or fetch fails: that repo is FAILED, and the others continue.
- Lock contention: wait with a bound of 120s, then FAILED.
- Setup fails: FAILED with the last stderr line.
- Unsafe copy: FAILED, with the reason given.
- A predecessor fails: dependents become SKIPPED (predecessor failed) and are not run.
- SIGTERM: killpg every child, mark the group interrupted, and keep the worktrees.
- Integration timeout: FAILED (timeout), never passed.
- Integration not configured: status `not_configured`, which never reads as passed.
- Dashboard restarts mid-group: the runner is a detached process; the UI re-reads group.json.

## Slices (all behind LOKI_WORKSPACES; test parts register through one runner entry owned by B01)
| ID | Goal | File set | Wall check | Tier |
|---|---|---|---|---|
| B01 | Test harness: register `tests/test-workspace.sh`, which sources `tests/workspace/*.sh` parts (each later slice adds only its own part) | tests/test-workspace.sh, tests/run-all-tests.sh, scripts/local-ci.sh, tests/workspace/00-smoke.sh | runner lists the suite; an empty part dir passes 1/0; shellcheck clean | LOW |
| B02 | Schema plus validator for `workspaces` (repos, path, setup, after, integration, integration_files); `after` cycle and unknown-repo rejection | schemas/loki-yaml.schema.json, autonomy/lib/loki_yaml.py, tests/workspace/10-schema.sh | a valid sample passes; a cycle, an unknown `after` and a non-ignored integration file are each rejected with a named error | MEDIUM |
| B03 | worktree_prep core: start ref, per-base lock, left-out-edits line, stamped dirs, never delete a kept tree | autonomy/lib/worktree_prep.py, tests/workspace/20-prep.sh | a dirty source fixture yields a worktree tree equal to base; 4 parallel preps on one base all succeed; a relaunch keeps the old dir | HIGH |
| B04 | Dependency strategy: setup, CoW copy, ignore check, escape detection | autonomy/lib/worktree_deps.py, tests/workspace/30-deps.sh | editable-install venv fixture: copy refused, setup path imports worktree code; absolute-symlink node_modules refused; a non-ignored dir is never copied | HIGH |
| B05 | Adopt worktree_prep in backlog.py behind the flag (also closes A3b relaunch) | autonomy/lib/backlog.py, tests/test-backlog.sh | flag off: backlog 47/0 unchanged; flag on: a JS fixture issue reaches VERIFIED with node_modules present | MEDIUM |
| B06 | Adopt worktree_prep in api_start._prepare_workdir behind the flag | dashboard/api_start.py, tests/dashboard/test_api_start_prep.py | flag on: the UI path uses the same lock and deps; flag off: byte-identical behavior | MEDIUM |
| B07 | group.json store: atomic write, single writer, reader API | autonomy/lib/workspace_state.py, tests/workspace/40-state.sh | a killed writer never leaves a partial file; a second writer pid is refused | MEDIUM |
| B08 | Runner: fan-out per repo, `after` ordering, SKIPPED on predecessor failure, killpg on SIGTERM, exit codes | autonomy/lib/workspace.py, tests/workspace/50-run.sh | stub launcher: parallel repos overlap, the dependent starts after the predecessor, a failing predecessor marks the dependent SKIPPED, SIGTERM leaves no child alive | HIGH |
| B09 | Per-repo task text: section split, preamble, `LOKI_E10_TASK_TEXT` only (no issue.json in the run) | autonomy/lib/workspace_task.py, tests/workspace/60-task.sh | a 2-section issue gives each repo only its section; no issue.json exists in either run dir; untrusted text is never placed in argv | HIGH |
| B10 | Integration runner plus evidence.json (not a Seal) | autonomy/lib/workspace_integration.py, tests/workspace/70-integration.sh | a passing compose stub gives exit 0 and matching SHAs; a timeout is FAILED, never passed; integration_files absent from every engine worktree | HIGH |
| B11 | PR comment with the integration result, via the existing gh token path (no LLM in the step) | autonomy/lib/workspace_comment.py, tests/workspace/80-comment.sh | stub gh receives one comment per PR; the token appears in no log or argv | MEDIUM |
| B12 | CLI `loki workspace` subcommand (list, show, run, status, clean) | autonomy/loki, tests/workspace/90-cli.sh | flag off: the command says it is disabled; `clean` never removes a worktree whose branch has an open PR | MEDIUM |
| B13 | Dashboard endpoints reading group.json; run launches a detached runner | dashboard/api_workspaces.py, dashboard/server.py, tests/dashboard/test_api_workspaces.py | the group survives an app restart; non-loopback Host gets 403; control scope required for run | HIGH |
| B14 | Dashboard group card (per-repo rows, integration row, stale-evidence badge) | dashboard/static/start.html | Playwright: a fixture group renders 2 repo rows plus integration; a mismatched head SHA shows stale | LOW |
| B15 | 10x metric: PRs per wall-clock hour and per attention minute from group.json timestamps | autonomy/lib/workspace_metrics.py, tests/workspace/95-metrics.sh | a fixture group gives the hand-computed rate; unmeasured runs are reported, not counted as zero | LOW |
| B16 | Docs plus flag flip after the whole-feature Wall: a 2-repo fixture (lib and app) ends with 2 PRs and integration passed | docs/WORKSPACES.md, tests/workspace/99-e2e.sh | the e2e part passes on CI with the stub provider; one real run is recorded in METRICS.md | MEDIUM |

Dependencies:
- B01 comes before every slice that adds a test part.
- Parallel chains:
  - B02 and B03, then B04, then B05 and B06.
  - B07, then B08 (which also needs B03 and B04), then B09 and B10, then B11.
- B12 needs B08. B13 needs B07 and B08, then B14. B15 needs B07.
- B16 needs everything.
- File sets do not overlap. `autonomy/loki` belongs to B12 only, `api_start.py` to B06 only, `start.html` to B14 only, and the runner files to B01 only.

## Open questions (CTO or founder)
1. CTO: should integration evidence ever join the Seal or be signed with the Seal key? The default here is no: it is labelled as not part of the Seal.
2. Founder: may opt-in integration_files such as .env be carried even into the model-free integration step, or is the declared `setup` the only path? The engine worktree is a hard no either way (moat 9).
3. CTO: where does per-repo task text come from? Options: the issue's `## repo:` sections (the default here), user edits in the UI, or a planner model call. A full multi-repo requirement in every repo makes the Wall write checks that no single repo can pass.
4. CTO: can a provider CLI session read sibling worktrees outside its cwd? If sandboxing blocks it, `after` ordering only orders work and gives no context, and `knowledge_sources` (no consumer today) should become that channel.
5. CTO: what size ceiling applies to a non-CoW full copy on Linux without reflink? The proposal is to refuse above 2 GB and require `setup`.
6. Founder: should a failed integration convert the group's PRs to draft? Doing so needs a credentialed write outside engine10-push.sh, which bears on the Rule of Two.
