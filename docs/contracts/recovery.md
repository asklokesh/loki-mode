# Recovery contract (engine10 runs)

Status: authoritative for slice RECOVERY. Code: `loki-ts/src/util/run_recovery.ts`,
`autonomy/lib/engine10-push.sh`, `loki resume` in `autonomy/loki`.

## What an interrupted run is

An engine10 run with an `events.jsonl` that has neither `run.completed` nor `pr.opened`, and whose
`run.pid` does not name a live process with the recorded start time. A run owned by a live supervisor is
never resumed.

## Phases

The phase is derived from the event log only (`phaseOf`):

| Phase     | Meaning                                                       | Recoverable today |
|-----------|---------------------------------------------------------------|-------------------|
| implement | no `stage.completed` for implement                            | No (reported)     |
| verify    | implement completed, no `receipt.sealed`                      | No (reported)     |
| publish   | `receipt.sealed` present, no `pr.opened` or `run.completed`   | Yes               |
| done      | `pr.opened` or `run.completed` present                        | Nothing to do     |

## What resume does

`loki resume [run-id]` (and `loki start "<same task>"` when the newest interrupted run is in the publish
phase and its recorded intake task equals the new task, without `--no-pr`) resumes the publish phase and
prints `resumed phase: publish (run <id>); receipt reused; PR <url>`.

- The sealed receipt is reused. No second `receipt.json` is written and no second `receipt.sealed` event is
  appended. One receipt per revision holds because resume never reseals.
- Events appended: `run.resumed`, `pr.opened`, `run.completed` (with `resumed: true` and a not-proven note
  "publish phase resumed after an interruption"), then the log seal.
- Push is skipped when the remote branch is already at the local commit (GitHub: `gh api .../git/ref/heads/<branch>`;
  local bare origin: `git ls-remote`). A newer commit is a new revision and is pushed.
- PR creation was already guarded: `gh pr list --head <branch> --state open` runs first and an existing open
  PR is reused. Exactly one PR results from any number of publish attempts for one branch.

For the implement and verify phases `loki resume` prints the phase, whether branch `loki/<run-id>` holds
preserved work, and exits 4. `loki start` prints a one-line note and starts a new run. Set
`LOKI_NO_RESUME=1` to disable the `loki start` check.

## Exit codes of `loki-ts engine10 resume`

0 resumed, 3 no interrupted run, 4 phase reported but not auto-resumable, 5 publish attempted and failed
(the run stays resumable), 2 not in a git repository or no origin.

## Not recoverable (honest limits)

- implement and verify: stage outputs live in the worker's memory; the stage machine has no entry point
  that skips completed stages. Work committed on `loki/<run-id>` is preserved, but the run is not continued.
- A crash between `gh pr create` returning and `pr.opened` being recorded: recovered by the open-PR lookup,
  but only if GitHub lists the PR for the branch by then (eventual consistency can in principle delay it).
- A crash after the commit status call but before `run.completed`: the status is set again (same value).
- GitLab origins (`engine10-push-gitlab.sh`) are not changed by this slice; the push-skip and PR reuse above
  are verified for the GitHub and local-bare paths only.
- The legacy bash loop (`autonomy/run.sh`) keeps its own resume semantics (iteration level); this contract
  does not cover it.
- Deep verify (detached child spawned after `pr.opened`) is not re-spawned on resume.

## Tests

- `loki-ts/tests/engine10/run_recovery.test.ts`: phase detection; interrupt in implement, verify and
  publish; one PR call, one `receipt.sealed`, one `pr.opened`, receipt bytes unchanged; failed publish stays
  resumable; `loki start` resumes only the same task.
- `tests/test-recovery-idempotent-publish.sh`: counting `gh` stub and a bare git remote; resume after push
  (no second push, one PR), rerun after PR creation (no second PR, no second push), new commit pushed once.
