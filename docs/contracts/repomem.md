# REPOMEM: automatic repository setup knowledge

Goal: the user never explains how the repo builds and tests, and a failure that was already there never blocks the run.

## Artifact

`.loki/state/repo-profile.json` (version 1), written by engine10 intake (`loki start`), module `loki-ts/src/util/repo_baseline.ts`.

- `revision`: HEAD the baseline ran on. `manifest_hash`: sha256 over package.json, Makefile, pyproject.toml, tox.ini, pytest.ini, setup.cfg, go.mod, Cargo.toml and .github/workflows/*.yml (name + content).
- `commands[]`: `{kind: test|lint|typecheck|build, cmd, source, validated, exit_code, duration_s, failing_ids}`. `validated` is true only when the command was executed on the untouched tree and ran to completion; false when it could not run (missing, timed out); null when discovered but not executed. Only the first test command is executed; lint, typecheck and build are discovered, never run here.
- `baseline`: `{ran, command, exit_code, duration_s, timed_out, failing_ids, attributable, reason?}`. `attributable` means exit 0, or non-zero with parseable failing ids (`failIds`).

## Lifecycle

1. Intake (after the dirty-tree refusal and the `.loki/` exclude, before any agent edit): same manifest hash and same HEAD reuses the file; same hash and a new HEAD keeps the commands and re-runs only the baseline; a changed hash rediscovers and re-runs.
2. Baseline: `sh -c <test cmd>` in the repo, 60s timeout (SIGKILL), scoped env (`plainTestEnv` token-free, `PYTHONDONTWRITEBYTECODE=1`, `CI=1`). Untracked files the run created are removed so the diff stays the agent's. Disable with `LOKI_REPO_BASELINE=0`.
3. Implementer brief (`briefContext`, e10ext/context.ts): a "Repo commands" block and the known-red test ids. Bytes depend only on the profile content (no timestamps).
4. Verify (`verifyStage`): `attribute()` marks a failing check pre-existing only when the profile revision equals the run base sha, the baseline was attributable, the check is neither a Wall/task-named target nor in a file the diff touched, and every one of its failing ids is in the baseline. Those join `pre_red` and `pre_red_checks` (seal already skips them in the verdict and lists `pre red: <id>`). Everything else that fails is introduced and blocks as before. A check with no parsed ids is introduced. Verify data gains `baseline_line` and `introduced_checks`; seal adds the one line to NOT PROVEN only when a baseline failure was excused.
   Line: `baseline: N pre-existing failing check(s) (not blocking), M introduced (blocking)`.
5. Surface: `loki doctor --repo` (and `--repo --json`) prints the profile, read-only, from the current directory.

## Not duplicated, not touched

`loki-ts/src/runner/repo_profile.ts` (legacy harness, default off via LOKI_REPO_PROFILE, facts without baseline, stored under lokiDir()/profile) and `e10ext/repomemory.ts` (last verified command) are unchanged and independent.
