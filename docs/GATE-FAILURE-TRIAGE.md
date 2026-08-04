# Gate failure triage: exact-SHA classification

Ordered by the steer: reproduce locally against exact HEAD, classify each
failure as environment / baseline / candidate regression, evidence every claim
with a command and its output. Nothing here was pushed.

| Field | Value |
|---|---|
| HEAD at triage | `d230a3b2` (the steer named `09138e26`; that SHA is not in this worktree) |
| baseline compared | `dda8beec` = origin/main |
| held commits | `22199024`, `94315f35`, `d230a3b2`, plus `94f7639a` from this triage |
| pushed | **nothing** |

## Classification

| Failure | Class | Evidence |
|---|---|---|
| `test-onboard-command` (6 of 9) | **BASELINE**, now FIXED | `autonomy/loki` byte-identical to origin/main; `git diff --name-only dda8beec..HEAD` returns zero matches for that path |
| `test-model-override` | **NOT A FAILURE** -- slow suite, mis-measured | 48/48 PASS then a ~100s section; my 120s foreground cap killed it mid-run and I read the truncation as a failure |
| `bun run typecheck` | **ENVIRONMENT** | `tsc` not installed locally; unchanged |

## The onboard defect

`loki onboard --stdout` exited **141** and wrote **0 bytes** on this repo,
while passing on small fixtures.

```
EXIT=141
STDOUT bytes: 0
STDERR bytes: 242
```

141 = 128+13 = SIGPIPE. `cmd_onboard`'s find fallback ends
`| sed | sort | head -200`. Under the file's `set -euo pipefail` (line 22),
`head` exits after 200 lines; `sort` -- which must consume ALL input before it
emits anything -- then takes SIGPIPE, the pipeline returns 141, and `-e` aborts
before a byte is written. The sibling `git ls-files` branch two lines above was
already guarded with `|| true`. The find branch never was.

`sort`, not `find`, is the process that dies. That distinction sets the test
size: see below.

### Why no existing test caught it

**1. Every fixture was too small.** The residual output has to exceed the 64KB
pipe buffer before the signal lands. Measured:

| Fixture | Result vs unfixed code |
|---|---|
| 250 files | **passes** -- ~50 lines left after the cut, fits the buffer |
| 3000 files | **exit 141**, deterministic |

A 250-file regression test would have been worthless. I wrote one first,
confirmed it passed against the pre-fix binary, and resized it.

**2. This worktree never reached the guarded branch.** The check was
`[ -d "$target_path/.git" ]`, and in a git **worktree** `.git` is a pointer
**file**, not a directory:

```
-rw-r--r--  1 lokesh  staff  83 Jul 31 19:25 .git
gitdir: /Users/lokesh/git/lokimode-anthropic/.git/worktrees/pre-push-scoped-pytest
```

So every worktree silently fell through to the find path. Proven by trace:

```
PRE-FIX   ++ find ... -maxdepth 4
FIXED     ++ git ls-files
```

### The fix

`-e` instead of `-d`, and `|| true` matching the sibling branch. Two lines.

### Two sibling sites, quieter symptom

`cmd_explain` and `_docs_scan_project` carry the same pipeline at `head -500`.
Fixed alongside -- patching only the path the failure named would leave the
siblings broken.

They fail *differently*, which is why nothing ever caught them: both assign via
`local x=$(...)`, and `local` resets `$?`, swallowing the 141. Demonstrated:

```
$ f() { local x=$(false | head -1); echo "rc=$?"; }
rc=0
```

So they **silently truncate** their file tree instead of aborting. Same root
cause, no visible symptom.

### Sweep

Three unguarded `sort | head -N` sites existed; zero remain. The sweep pattern
is not vacuous -- it matches 3 in the pre-fix file and 0 now.

The other two `-d .../.git` checks in the file (`loki:11113`, `loki:13473`) are
CORRECT as `-d`: one detects a clone (a worktree is not one), the other guards
`git init` on a fresh demo dir. Left alone.

## Verification

| Check | Before | After |
|---|---|---|
| `test-onboard-command.sh` | 3/9 | **10/10** |
| new Test 10 vs pre-fix binary | **FAIL** (exit 141) | PASS |
| `test-onboard-json-injection-wave10.sh` | 2/2 | 2/2 |
| `test-contradiction-detection.sh` | 19/19 | 19/19 |
| `bash -n autonomy/loki` | OK | OK |

Test 10 was mutation-tested against `dda8beec`: it fails with the exact
diagnostic `exit 141 (SIGPIPE)` on the old code and passes on the new. It also
carries a vacuity guard rejecting exit 0 with under 100 bytes of output -- the
precise shape of the bug, since the abort produced exit 141 *and* silence.

## Correction to the earlier proposal

`docs/LOOP-CANDIDATE-PROPOSAL-v1.md` states the onboard defect "cannot be
addressed by any of [the six cheaper surfaces]" because it is a bash command
that never calls a model. That reasoning was right, and the conclusion drawn
from it was too weak: it is not a model-loop problem, it is a **two-line shell
bug**, and the correct action was to fix it rather than to route around it.

It also claimed the failure needed "a runtime fix to `autonomy/loki`" of
unknown size. Measured: 28 lines changed across three sites, all mechanical.

## Gate status

Still not green, and this triage does not make it so.

- `test-onboard-command`: **RESOLVED** (3/9 -> 10/10)
- `test-model-override`: **was never failing** -- my measurement was wrong
- `bun run typecheck`: **unchanged**, `tsc` still absent

The remaining item is the environment gap already named as the single
gate-closing action.
