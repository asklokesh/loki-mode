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
| `test-model-override` | **BASELINE**, 1 of 66, still open | identical failure at `dda8beec` and at HEAD: `Results: 65 passed, 1 failed (of 66)`, `EXIT=1` |
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

## Correction: I called test-model-override a non-failure before it finished

An earlier revision of THIS FILE classified `test-model-override` as "NOT A
FAILURE -- slow suite, mis-measured". That was wrong, and it was wrong in the
worst available way: I wrote the classification while the run was still
executing, from a partial log that showed 50 PASS and no failures yet.

The completed run:

```
FAIL: architect no-cap mismatch: estimator='Opus' runner-dispatch='opus'
      runner-tier='fable' (expected Opus,Sonnet / opus / fable)
Results: 65 passed, 1 failed (of 66)
EXIT=1
```

The slowness was real -- a 224-cell parity matrix, each cell spawning a
`python3` that imports the FastAPI dashboard at ~0.46s -- and it was NOT the
explanation for the failure. Both things were true and I reported only the
convenient one.

The rule this violates is one already written down in this repo: an absent
measurement is not a measurement. A log with no FAIL line yet is not a log with
no failures; it is an unfinished log. I should have blocked on the EXIT marker
before classifying, exactly as I did for the onboard suite.

### The actual failure

`tests/test-model-override.sh:827`. A three-way coherence assertion; two of the
three legs are correct:

| Leg | Expected | Actual |
|---|---|---|
| runner dispatch | `opus` | `opus` -- correct |
| runner tier (pre-collapse) | `fable` | `fable` -- correct |
| estimator quote | `Opus,Sonnet` | `Opus` -- **mismatch** |

So the runtime routing is right and only the cost QUOTE disagrees: the
estimator names one model where the run actually uses two. Per the test's own
comment (line 800), this is the known "estimator needs the sonnet5-default
update" case -- iter-1 collapses fable to opus, later iterations run the
development tier which defaults to sonnet since v7.104.0, so an honest quote
must name both.

It under-quotes cost. It does not mis-route a model.

### Root cause: the fixture stopped producing enough iterations

The estimator is CORRECT. The expectation is only reachable when the estimate
spans more than one iteration, and the suite's fixture no longer does.

`autonomy/loki:18342` prices iteration 0 as Opus (the fable architect pass
collapsing to opus), and every LATER iteration through
`_priced_model_for(_dispatched_model)`, which defaults to Sonnet since
v7.104.0. So `Opus,Sonnet` requires **iterations >= 2**.

Measured on the suite's own fixture (`# PRD\nBuild a small todo API with one
endpoint.`, byte-identical to v7.104.0):

| Binary | tier | estimated iterations | nonzero models |
|---|---|---|---|
| `766219ac` (v7.104.0, where this was written and passed 66/0) | simple | **4** | `Opus,Sonnet` |
| HEAD | simple | **1** | `Opus` |

The complexity TIER is unchanged (`simple` in both). Only the iteration count
for that tier fell, 4 -> 1, and with a single iteration the loop never reaches
the branch where Sonnet appears.

Confirmed causal by holding the binary fixed and enlarging the input: a 24-
feature PRD at HEAD estimates 4 iterations and returns exactly `Opus,Sonnet`
(`{"Fable":0,"Opus":1,"Sonnet":3,"Haiku":0}`). Same code, more iterations,
expected answer.

So the assertion is a **stale coupling**: it encodes "a simple PRD takes
several iterations", which stopped being true. The v7.104.0 commit message
claims "locked by tests/test-model-override.sh (66/0)" -- that lock silently
came undone when the iteration estimate for simple PRDs changed.

### Classification: BASELINE

Run against `dda8beec`'s `autonomy/loki` (my onboard fix reverted), the failure
is **identical**:

```
FAIL: architect no-cap mismatch: estimator='Opus' ...
Results: 65 passed, 1 failed (of 66)
EXIT=1
```

Not caused by any held commit. My `autonomy/loki` diff touches only three
tree-building sites and no pricing or routing code.

### Not fixed here, deliberately

Two candidate fixes, and choosing between them is a product call I should not
make unilaterally:

1. **Enlarge the fixture** so a multi-iteration estimate is exercised. Restores
   the assertion's original intent (verify the architect collapse across a
   real multi-iteration run) and keeps its coverage.
2. **Weaken the assertion** to accept `Opus`. Cheaper, and wrong: it would
   stop testing the later-iteration Sonnet attribution entirely.

(1) is almost certainly right, but it changes what the test measures, and the
prior instruction excluded runtime changes without an evidenced deterministic
requirement. The evidence is now here; the decision is not mine.

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
- `test-model-override`: **1 of 66 still failing, BASELINE** -- a stale test
  coupling, not an estimator defect. Root-caused (fixture no longer produces a
  multi-iteration estimate); two candidate fixes named, neither applied.
- `bun run typecheck`: **unchanged**, `tsc` still absent

Two items remain, not one. Both are pre-existing at `dda8beec`; neither was
introduced by a held commit.

| Item | Needs |
|---|---|
| `bun run typecheck` | install the TS toolchain -- the environment fix already named |
| `test-model-override` | a decision between enlarging the fixture and weakening the assertion |

Neither is unblocked by the other, so "install tsc" was never sufficient on its
own. That was an error in the earlier proposal, which named a single
gate-closing action while a second real failure sat unclassified behind a
measurement I had cut short.
