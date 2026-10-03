# R6: 1-Click Rollback + Checkpoint UX (Design Note)

Status: implemented in this worktree (not committed to main). For integrator cherry-pick.
Goal: make Loki's existing checkpoint/rollback infra EXCELLENT and OBVIOUS so users
run autonomous work boldly, knowing a mistake is one action from undone.

## 1. Verified existing code (read, not assumed)

### Checkpoint writers (THREE divergent formats, one shared index.jsonl)

| Writer | ID format | Files captured | Source |
|---|---|---|---|
| `create_checkpoint()` (automatic, per iteration) | `cp-{iter}-{epoch}` | `state/orchestrator.json`, `autonomy-state.json`, `queue/{pending,completed,in-progress,current-task}.json` | `autonomy/run.sh:7373` |
| `cmd_checkpoint create` (manual CLI) | `cp-{ts}` | `session.json`, `dashboard-state.json`, `queue/`, `memory/`, `metrics/`, `council/` (recursive copy) | `autonomy/loki:16122` |
| `POST /api/checkpoints` (dashboard) | `chk-{ts}` | `dashboard-state.json`, `session.json`, `queue/` | `dashboard/server.py:5085` |

All three append to `.loki/state/checkpoints/index.jsonl` (field names differ; the
dashboard `GET /api/checkpoints` normalizes them).

### Restore (rollback) paths

| Path | Restores | Source |
|---|---|---|
| `rollback_to_checkpoint()` (internal, run.sh) | state + queue json (NOT autonomy-state) | `autonomy/run.sh:7473` |
| `loki checkpoint rollback <id>` (bash CLI) | glob-restores whatever is in the cp dir | `autonomy/loki:16263` |
| `loki rollback to|latest <id>` (Bun) | the 5 RESTORE_FILES | `loki-ts/src/commands/rollback.ts` + `loki-ts/src/runner/checkpoint.ts:632` |

### Bun runner checkpoint API (`loki-ts/src/runner/checkpoint.ts`, 700 lines)
- `createCheckpoint`, `listCheckpoints`, `readCheckpoint`, `rollbackToCheckpoint` (planner),
  `executeRollback` (copier). Byte-for-byte parity with bash `create_checkpoint`.
- `metadata.json` keys are pinned by `loki-ts/tests/runner/checkpoint.test.ts:62-91`
  (`Object.keys(m).sort()`) -- they MUST NOT change.

### Dashboard
- `GET /api/checkpoints`, `GET /api/checkpoints/{id}`, `POST /api/checkpoints` exist.
- The UI component `legacy-ui/components/loki-checkpoint-viewer.js` (601 lines) ALREADY
  renders list + create + rollback-with-two-step-confirm and POSTs to
  `POST /api/checkpoints/{id}/rollback` -- but that endpoint **did not exist**. The
  dashboard rollback button was DEAD.

## 2. Three decisions (verified facts, not assumptions)

### Decision A: what "truly undo an iteration" restores
Verified fact: Loki does NOT commit per iteration (`grep "git commit" autonomy/run.sh`
finds only merge-conflict `git add`, no per-iteration commit). Therefore the captured
`git_sha` is HEAD (the last commit), and `git reset --hard <git_sha>` would discard the
iteration's work PLUS anything since the last commit -- it cannot reconstruct a specific
iteration's working tree. The pre-existing printed hint `git reset --hard <git_sha>`
(run.sh:7541, loki:16314) was therefore actively MISLEADING.

Resolution: capture a real working-tree snapshot at checkpoint time via `git stash create`
(captures tracked changes without disturbing the tree), then ANCHOR it with
`git update-ref refs/loki/cp/<id> <sha>` so `git gc` cannot prune the dangling commit.
The snapshot sha is written to a SIDECAR file `worktree-snapshot.txt` in the checkpoint
dir (NOT metadata.json, to preserve byte parity). Restore of code is opt-in
(`loki rollback to <id> --code`) because it overwrites tracked files; by default the
durable, correct recovery command is printed: `git stash apply refs/loki/cp/<id>`.

State + `.loki/CONTINUITY.md` (the iteration/conversation handoff context) are
auto-restored -- this is the always-on "undo the iteration's state + context".

Honest gap: `git stash create` captures tracked changes only; it does NOT capture
untracked or ignored files. Files the iteration newly ADDED and never committed are not in
the snapshot, and an apply will not delete them. Documented, not hidden.

### Decision B: re-undoability invariant
Every restore path FORCES a pre-rollback snapshot of current state before overwriting, so
a rollback is itself trivially undoable. The Bun `executePlan`, the dashboard endpoint, and
bash `cmd_rollback` all create a forced checkpoint first (bash `create_checkpoint`
early-returns on a clean tree, so the new code path forces it). The human dashboard path
ALSO keeps the existing two-step confirm. Autonomous paths never block on a prompt.

### Decision C: do not add a 4th format, do not unify the 3
Unifying would break the byte-for-byte parity test; a 4th compounds the problem. The new
dashboard restore endpoint GLOB-restores whatever the checkpoint dir contains (mirrors bash
`cmd_checkpoint rollback`), so it works for all three writers. New fields go in sidecars.

## 3. Changes (parity-organized)

- **bash `autonomy/loki`**: add top-level `rollback)` dispatch + `cmd_rollback`
  (`list|show|to|latest`, `--code` flag). `to|latest` delegate to the existing
  `cmd_checkpoint rollback` restore body after forcing a pre-rollback snapshot, then
  optionally apply the anchored code snapshot. Prominent "you can undo this" output.
- **bash `autonomy/run.sh`**: `create_checkpoint` also copies `CONTINUITY.md`, creates +
  anchors the worktree snapshot (sidecar), echoes the checkpoint id; `rollback_to_checkpoint`
  also restores `CONTINUITY.md` and forces the pre-rollback snapshot. The per-iteration call
  site emits a prominent "Checkpoint <id> created -- undo with `loki rollback to <id>`".
  The misleading `git reset --hard` hint replaced with `git stash apply refs/loki/cp/<id>`.
- **Bun `loki-ts/src/runner/checkpoint.ts`**: copy `CONTINUITY.md` into the checkpoint
  (additive, parity-safe), add `CONTINUITY.md` to RESTORE_FILES, expose
  `executeRollbackWithSnapshot` that forces a pre-rollback snapshot before restoring.
  metadata.json keys unchanged.
- **Bun `loki-ts/src/commands/rollback.ts`**: `executePlan` forces a pre-rollback snapshot
  before restoring; HELP text made honest about state+context restore and the printed code
  command.
- **dashboard `dashboard/server.py`**: add `POST /api/checkpoints/{id}/rollback`
  (`require_scope("control")`, `_sanitize_checkpoint_id`, forced pre-snapshot, glob-restore).
  Un-deads the existing UI button.

## 4. Tests (extend existing suites, no parallels)
- `loki-ts/tests/runner/checkpoint.test.ts`: CONTINUITY round-trip restore + forced
  pre-rollback snapshot.
- `loki-ts/tests/commands/rollback.test.ts`: `to` forces a pre-rollback snapshot (re-undo).
- `tests/test-checkpoint-cli.sh`: top-level `loki rollback list|to|latest`, restore actually
  reverts, pre-rollback snapshot exists.
- `dashboard/tests/test_rollback_endpoint.py`: POST rollback reverts, scope, 404.
No paid model calls anywhere.
