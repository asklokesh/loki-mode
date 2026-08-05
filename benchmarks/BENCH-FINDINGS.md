# A/B benchmark findings: v7.129.5 vs v8.0.0

Measurement run 2026-07-28, model `sonnet` both arms, identical spec, cap 8
iterations, `LOKI_SDK_LOOP` off on both arms so only the engine version varies.

**Arms verified independent, on content not timestamps.** `speed-benchmark.sh:55`
creates a FRESH engine copy per invocation (`mktemp -d`) and rsyncs the current
WORKING TREE, not a git ref -- so a mid-matrix edit to engine code WOULD
contaminate later trials. Verified it did not: `autonomy/run.sh` inside the live
engine copy is byte-identical (`cmp`) to the working tree, and the only files
edited during the matrix were benchmark tooling, `.gitignore`, and
`.claude/settings.json`, none of which the engine executes.

Do not edit `autonomy/run.sh`, `autonomy/loki`, or `loki-ts/` while a matrix is
running. Timestamp-based reasoning about engine copies is NOT valid here
(`mktemp -d` + rsync do not give the copy a fresh mtime); compare content.

## HEADLINE (greet CLI spec, 7 trials total): 7 iterations -> 1

| Arm | n | Iterations | Median | Wall median | Completed | Acceptance |
|---|---|---|---|---|---|---|
| v7.129.5 shipped | 3 | 7, 7, 7 | **7** | 13.2 min | 3/3 | 3/3 |
| v8 post-fix | 4 | 1, 1, 1, 1 | **1** | 8.8 min | 4/4 | 4/4 |

**86% fewer iterations.** Both arms have ZERO variance in iteration count, which
is itself the strongest evidence: this is structural, not sampling luck.

Quality did not regress to buy the speed: completion 3/3 -> 4/4 and acceptance
3/3 -> 4/4. Both perfect on both arms.

### Two claims of very different strength -- do not conflate them

* **Iterations 7 -> 1: SOLID.** v7 range [7,7], v8 range [1,1]. No overlap, zero
  spread on either side. Safe to state without hedging.
* **Wall clock 13.2 -> 8.8 min (34%): WEAK, directional only.** The ranges
  OVERLAP -- v7's fastest run was 10.2 min, v8's slowest was 10.3 min. Model
  latency dominates a 1-iteration run and it is noisy (v7 spread 8.5 min, v8
  spread 3.4 min). Report the iteration count as the result and treat wall clock
  as suggestive until more trials narrow it.

The iteration count is also the better cost proxy: it maps directly to model
calls, which is what a user pays for.


| Trial | Iterations | Wall clock | Completed | Acceptance |
|---|---|---|---|---|
| t1 | 1 | 6.9 min | yes | pass |
| t2 | 1 | 8.6 min | yes | pass |
| t3 | 1 | 8.9 min | yes | pass |

Median 1 iteration with NO variance across trials, against a v7 baseline of 7.
The pre-fix v8 run took 6 iterations and ended `intervention`. A fourth trial on
the final (post-council-REJECT) detector is running for confirmation.


| | v7.129.5 | v8 pre-fix | **v8 post-fix** |
|---|---|---|---|
| Iterations | 7 (of 8 cap) | 6 (of 8 cap) | **1** |
| Engine work | 6.0 min | 12.7 min | **1.2 min** |
| Wall clock | 10.2 min | 20.0 min | **6.9 min** |
| Outcome | completed | intervention | **completed** |
| Acceptance | pass | pass | **pass** |
| Council | -- | blocked `empty_diff` | **never blocked** |
| `mock_integrity` | -- | FAIL x6 | **0 failures** |

Both blockers confirmed resolved IN A LIVE RUN, not just on fixtures: the council
never blocked, and the gate that previously failed on every iteration failed on
none.

Caveats stated plainly:

* **n=1 at the time of writing** (trials 2-3 running). A single run of a
  stochastic agent is not a result; the median over 3 is the number to quote.
* **The v7 baseline predates these fixes.** Both fixes are SHARED code that v7
  would also benefit from, so "1 vs 7" is NOT a v8-vs-v7 claim. It is a
  before/after on the same engine. Do not present it as a version comparison.
* **This is a hello-world CLI spec.** It does NOT demonstrate "a 15-min
  5-iteration PRD in 5 min in 1 iteration". That needs a representative spec.
  What IS demonstrated is the mechanism: remove a false-positive gate and a
  false empty-diff, and the loop converges instead of grinding to the cap.
* Acceptance here is a file-existence check, so this measures time-to-completion,
  not output quality.

## Superseded: the early single-trial snapshot

An earlier revision of this file said the comparison was not yet established,
on the strength of one v7 trial against one crashed v8 trial. The completed
7-trial matrix above supersedes it. Kept only as a note that the conclusion
changed as data arrived: the first v8 trial ended `intervention` and looked
like a regression; it was the false-positive gate (F5), not the engine.

## F1 -- exit 141 (SIGPIPE) is classified nowhere. Pre-existing, BOTH versions.

`autonomy/run.sh` has no `141` or `SIGPIPE` case; the exit falls through to the
`*)` catch-all emitting "cause not classified":

* v8: `autonomy/run.sh:22379`
* v7: `autonomy/run.sh:18849` (identical construct)
* `loki-ts/src/runner/retry_class.ts`: no 141/SIGPIPE handling either

**Not a v8 regression.** v7 shares the gap and its trial simply never tripped it.

Severity is lower than it first appears: iteration 4 logged the 141 and
iterations 5 and 6 then ran normally. SIGPIPE was survivable; the loop recovered.

## F2 -- a recovered-from error still decorates the terminal record

`.loki/state/LAST_ERROR.json` recorded the iteration-4 failure and was never
cleared when iterations 5 and 6 succeeded. `completion.json` therefore carried
`error_class: "unknown"` and the stale iteration-4 brief on a run that went on to
produce committed, tested, working code.

**Scope, verified -- decorative, NOT causal.** The consumer at `run.sh:4093`
populates `error_class` / `error_brief` from that side-record; its own comment
states the intended contract, "None on a clean run", and that contract is
violated. But `outcome` does NOT come from it: `_LOKI_CS_OUTCOME` is a plain
function argument, and both `build_completion_summary intervention` call sites
(`run.sh:22695`, `:22719`) are hardcoded PAUSE / budget-limit halts. No code path
reads LAST_ERROR to CHOOSE the outcome. The `intervention` verdict on this run
came from the pause path, not from the stale error.

So the fix is small: clear LAST_ERROR on a successful iteration.

Why it persists on a stock run -- there are only two clear sites, and neither
covers mid-run recovery:

* `run.sh:23801` clears at run START, i.e. a PRIOR run's record only.
* `run.sh:18292` clears on consumption, but is gated behind `LOKI_SELF_HEAL`,
  which defaults to `0`, so it never fires on a default run.

The comment at 23801 names this exact hazard -- "a stale error shown beside a
fresh success would be a fake-green-adjacent lie" -- but guards only ACROSS runs,
not WITHIN one.

## F3 -- `start_sha` is the literal string "HEAD" -- SECOND convergence blocker

Not cosmetic. This is the other half of F5.

`.loki/state/start-sha` contains the literal text `HEAD`, so every derived diff is
`git diff HEAD..HEAD` -- structurally always empty. Consequences observed in the
benchmark run:

* `completion.json`: `files_changed: 0` despite 3 real commits.
* **`.loki/council/evidence-block.json`: `status: blocked`, `reason: "empty_diff"`,
  `base_sha: "HEAD"`, `files_changed: 0`** -- while `tests.ok: true` and
  `boot.ok: true`. The council could not see any work, so it could never vote
  done, so the loop ran to the cap.

### Root cause (reproduced)

`run.sh:20067` does:

```
(cd "$TARGET_DIR" && git rev-parse HEAD 2>/dev/null) > "$_start_sha_file" 2>/dev/null || true
```

In a repo with **no commits yet** (greenfield `git init`, i.e. every from-scratch
build) `git rev-parse HEAD` exits 128 AND prints the literal string `HEAD` on
stdout. stderr is discarded, `|| true` swallows the failure, and the literal
`HEAD` is captured as the start SHA.

Verified directly:

```
$ git init -q . && git rev-parse HEAD; echo "exit=$?"
fatal: ambiguous argument 'HEAD': unknown revision ...
HEAD
exit=128
```

The correct sentinel for "no commits yet" is the empty tree
(`git hash-object -t tree /dev/null`, i.e. `4b825dc642cb6eb9a060e54bf8d69288fbee4904`)
or an explicit empty marker every consumer understands -- never a literal ref name
that silently diffs against itself. Guard on the exit code, not on output presence.

## F5b -- the false positive had THREE variants, not one

The first fix (require.resolve + explicitly-relative spawn paths) was verified on
fixtures and on the original artifact, then a live post-fix run STILL blocked.
The build had produced a third shape:

```js
const script = path.join(__dirname, 'greet.js');
execFileSync('node', [script, 'Ada']);
```

The source is named as a BARE filename with no `./` prefix, so both patterns
(which required `\.{1,2}/`) missed it. This is idiomatic Node for spawning a
sibling script. Fixed with a third pattern requiring a source-code EXTENSION and
still gated on the file actually importing `child_process`.

Adversarial probes confirm the gate is NOT blinded -- all still CRITICAL:

* mock-only test that merely mentions a relative path in a string
* mock-only test that imports `child_process` but never uses the source
* mock-only test that spawns AND has an unrelated relative string
* spawn + a bare `.js` name that does NOT exist on disk
* spawn + a bare name that is the TEST file itself

Registered test now covers 9 cases: 3 false positives that must pass, 6 mock-only
shapes that must stay blocked.

**Lesson: verifying a gate fix on fixtures is not enough.** The authoritative
check is a live run, because the agent writes shapes the fixture author did not
imagine. Fixtures prove the fix; a live run finds the next variant.

### F5c -- an adversarial council REJECTED my fix, and it was right

The bare-filename pattern was first gated on the file merely IMPORTING
`child_process`. An adversarial verify agent produced an executed
counter-example that this let through:

```js
const { spawnSync } = require('child_process');   // imported, never called
const TARGET_NAME = 'greet.js';                   // real source, named only
function greet(n) { return `Hello, ${n}!`; }      // inline stub
test('greets', () => assert.strictEqual(greet('Ada'), 'Hello, Ada!'));
```

Mock-only, never spawns, and my version scored it **0 CRITICAL** -- a gate
BLINDING introduced by my own fix. Reproduced independently before accepting it.
My five earlier adversarial probes missed it because none combined "imports
child_process" with "bare name of a REAL source file".

Resolution: the council proposed deleting the branch entirely, which does hit the
mandated target (a=0 b=0 c=1). Measured that option and REJECTED it -- removing
the branch re-breaks four legitimate shapes, including the exact `path.join`
form a live build produced and every ESM/TS subprocess test.

The correct fix is neither extreme: gate the bare-name pattern on an actual spawn
INVOCATION (`has_spawn_call`) rather than on the import. Legitimate tests call a
spawn function; the counter-example only imports one.

Final state -- 16 fixtures, all correct: 8 legitimate shapes pass (CJS/ESM/TS/Py
subprocess, require.resolve, path.join), 8 mock-only shapes still blocked
(including the counter-example). Repo-wide CRITICAL 14 -> 13; the single dropped
finding is `tests/policies/check.test.js`, which genuinely spawns
`src/policies/check.js` -- 8 real tests that our own gate was wrongly calling
mocks.

**Process lesson: never accept a self-report as the gate.** The implementer
(including me) reported success against its own fixtures. Only an adversarial
reviewer that RE-READ SOURCE and EXECUTED a new case found the hole. Equally:
do not accept the reviewer's proposed remedy uncritically either -- measure it.
Here the reviewer's diagnosis was right and its fix was too blunt.

## F3b -- the completion council cannot converge before iteration 3

`LOKI_COUNCIL_MIN_ITERATIONS` defaults to **3** and `LOKI_COUNCIL_CHECK_INTERVAL`
to 5 (`completion-council.sh:23-28`).

**CORRECTION -- the floor is already tier-aware, so this is NOT a blocker for
simple specs.** `_council_effective_min_iter()` returns **1** when
`DETECTED_COMPLEXITY == simple`, and `detect_complexity` grades the bench spec
`simple` in the real run (build.log: `Detected complexity: simple (files: 0,
prd: simple, external: false, microservices: false)`). One-iteration completion
is therefore already reachable on a simple spec; no threshold change is needed.

Two traps that nearly produced a wrong fix here, both worth remembering:

1. `events.jsonl` carries a `"complexity":"standard"` field that is STALE and is
   NOT what the council consumes. Reading it led to a false "the classifier is
   broken" hypothesis. The authoritative value is the `Detected complexity:` line
   in `build.log`, which logs the classifier's actual inputs.
2. An isolated repro of `detect_complexity` on an empty dir returns `simple`,
   matching the real run -- so the "the agent's own files inflate the file count"
   theory was DISPROVED before any code was changed.

For standard/complex specs the floor of 3 still applies, and that remains a
deliberate safety floor: any reduction must be EARNED by affirmative evidence
(tests pass AND boot ok AND a non-empty diff), never by lowering the number,
which would trade accuracy for speed -- the opposite of the goal.

## F4 -- benchmark harness does not exit when the engine terminates

The engine wrote `completion.json` at 15:26; the harness wrapper was still alive
at 15:45 in state `S` with no running children, and never wrote a metrics file.
Two consequences:

1. Wall-clock read from the wrapper (39-41 min) is WRONG. Engine-active time
   from `events.jsonl` (20.0 min) is the real figure. Never cite wrapper elapsed.
2. A hung harness produces no metrics file, so the trial silently vanishes --
   which is exactly why `run-ab-trials.sh` records an explicit `missing` row.

## F5 -- THE CONVERGENCE BUG: a false-positive gate IS the iteration loop

The most important finding. Decomposing the v8 run's `events.jsonl` timeline:

* `mock_integrity` reported **fail on all 6 iterations** -- the same gate, never
  satisfied.
* The agent emitted `task_completion_claim` after nearly every iteration. It
  believed it was done each time; the blocked gate sent it round again.
* All nine gate stages together cost **~5s per iteration**. Gates are NOT the
  time sink; the re-work they trigger is.
* One of the agent's own commits reads: *"Fix mock_integrity gate: reference
  source via require.resolve in test"*. The agent spent iterations fighting our
  gate, not building the product.

### The false positive

`tests/detect-mock-problems.sh` raises CRITICAL *"Test file has N test(s) but
never imports source code -- tests only test inline mocks"* against a test that
DOES exercise real source, via `require.resolve('./greet.js')` + `spawnSync` --
a genuine end-to-end subprocess run, the STRONGEST form of test.

Cause: the import detector recognizes only `require('./x')` and ESM
`import ... from './x'`. `cjs_re` (line ~109) matches `require(` but not
`require.resolve(`. Counts of `require.resolve`, `spawnSync`, `execFile`, and
`child_process` in the detector: **zero**. Subprocess-style tests are invisible
to it.

### Shared, not a v8 regression

The two versions' detectors DIFFER (v8 added ~90 lines of `local_import_is_source`
resolution logic), so this had to be tested rather than assumed. Run against the
identical test file, **both fail identically** with the same single CRITICAL. So
both arms pay the same gate-fighting tax, the A/B comparison remains valid, and
the fix is a shared uplift -- NOT a manufactured v8 win.

### Discriminating fixtures (baseline before fix: a=1 b=1 c=1)

* **a** -- `require.resolve('./greet.js')` + `spawnSync` -> must reach 0 CRITICAL
* **b** -- `spawnSync(node, ['./greet.js'])`, source never named -> 0 ideally
* **c** -- greet() defined inline, source never touched -> **MUST STAY 1**

`c` is load-bearing. This is a fail-closed gate: any pattern loosened is a way
for a genuinely mock-only test to pass. A narrow fix covering only `a` beats a
broad one that blinds the gate.

Removing a false positive RAISES accuracy. It must not be described, or
implemented, as weakening a gate.

## F7 -- pattern 1 never scans Python (PRE-EXISTING gap, not a regression)

While checking that the F5 fix generalizes, found that a mock-only Python test
(`test_calc.py` defining `add()` inline and asserting on it) is NOT flagged.

Verified pre-existing: the ORIGINAL pre-fix detector snapshot returns 0 CRITICAL
on the same fixture. Pattern 1's file list includes `test_*.py`, but the
source-import helper only understands JS/TS import syntax, so a Python test can
never satisfy it -- and a test that can never satisfy the check is never
reported. **Not introduced by this work**; filed, not fixed here.

Fix generality that WAS confirmed: TypeScript ESM subprocess tests and Python
subprocess tests (`subprocess.run([sys.executable, SCRIPT])`) both pass cleanly,
so the fix is not JS-specific.

## F6 -- `lsp_diagnostics` never measures anything (dead gate, LOW severity)

Reported `not_run` on all 6 iterations. Reproduced directly:

```
$ python3 -m mcp.lsp_proxy --write-diagnostics --root <bench project>
{"measured": false, "reason": "no-changed-file-with-detected-server",
 "wrote_artifact": false, "detected": ["rust"]}
```

It detected only a **rust** toolchain in a pure JavaScript project, so no
JS/TS language server was available and the gate silently produced nothing.

Severity is LOW relative to F5: this is a gate that never fires (lost signal),
not one that wrongly blocks (lost iterations). It costs ~1s per iteration and
does not drive re-work. Worth fixing so the signal exists, but it is NOT part of
the convergence story, and it should not be conflated with the false-positive
class. Filed, not fixed in this pass.

## PRD RESULT (task-api-prd, v8 post-fix, n=1): built and works, but ESCALATED

The realistic 4-file HTTP service, run to a terminal state.

| | Value |
|---|---|
| Iterations | 3 (of 12 cap) |
| Engine-active time | 42.7 min |
| Files required by the spec | **4 of 4 built** (server.js, store.js, README.md, *.test.js) |
| `node --test` on the artifact | **28 pass, 0 fail** |
| Commits | 2 |
| Terminal outcome | `intervention` |

**The engine built a genuinely working service.** Verified by running its own
test suite against the produced artifact, not by trusting the verdict: 28/28
green. This is NOT the hollow-output failure mode.

### Why it stopped: GATE_ESCALATION, and the gate was RIGHT

`.loki/signals/GATE_ESCALATION.json` -> `{"action":"escalate","gate":"code_review",
"count":3,"threshold":3}`. Not the PAUSE cap (`GATE_PAUSE_LIMIT` is **10**, and
only 3 failures occurred) -- the escalate rung, which deliberately does NOT
convert a blocked gate into a pass.

Review 3 aggregate: `pass_count:3 fail_count:1`, verdicts
`architecture-strategist:PASS maintainer-mergeability:FAIL performance-oracle:PASS
dependency-analyst:PASS`. One reviewer blocked, and its [High] finding is
factually correct -- verified against the artifact:

> `.gitignore` removes the `enriched-tasks.json` ignore line added in prior
> commit e7521a5, and the diff commits the 68-line artifact it was previously
> ignoring [...] unrelated to this commit's stated scope.

Confirmed: `enriched-tasks.json` (8008 bytes) is present in the workspace and
`.gitignore` no longer excludes it. The agent committed a planning artifact as
scope creep, then contradicted its own ARCHITECTURE.md. Every finding carried a
file:line citation.

Corroborating signal: the uncertainty ring shows the iteration-1 and iteration-2
diff hashes IDENTICAL (`d41d8cd9...` = the empty-string hash), i.e. an iteration
that produced no measurable change. The loop was not converging on this finding.

### What this means -- do not overstate either direction

* **A realistic PRD did NOT converge in 1 iteration**, unlike the CLI spec. The
  founder's "5 min / 1 iteration" target is met on a trivial spec and is NOT yet
  demonstrated on a real one. Say so plainly.
* **The stop was correct behavior, not a defect.** Both blocking gates on this
  run (`code_review`, `mutation_integrity`) were TRUE positives on real problems.
  That is the opposite of the F5 false-positive class, and it means the fix did
  not blind the gates.
* **The user-facing gap is the REPORT, not the decision.** `outcome:
  intervention` with `files_changed: 0` tells a user nothing about a build that
  produced 4 working files and 28 passing tests. The verdict is right; the
  summary of it is misleading. That is the thing worth fixing next.

n=1, and the v7 arm never ran (the harness wrapper hung 18 min past engine
completion -- F4 again, because `prd-ab.sh` lacks the `_run_capped` watchdog that
`run-ab-trials.sh` has). No v7-vs-v8 PRD comparison exists yet.

## HARNESS EVIDENCE vs the documented competitor gap (measured 2026-07-29)

`docs/competitive/bolt-new-analysis.md:411` records the competitor gap as
"70% done code, no tests, no review, $5-20K remediation". That is the one
competitive claim in our own analysis that is directly measurable from a real
build artifact, so it was measured rather than repeated.

Measured on the preserved PRD run (4-file HTTP task service, `.loki/` intact):

| Claim about the category | What our artifact shows |
|---|---|
| "no tests" | **2 test files, 28 tests, 0 failures** on `node --test` |
| "no review" | **all 8 numbered gates ran**, plus the non-numbered `lsp_diagnostics` auditor: code_review, doc_coverage, magic_debate, mock_integrity, mutation_integrity, security_scan, static_analysis, test_suite (+ lsp_diagnostics) |
| "70% done" | run produced 10 files / 1479 insertions and a working service |

The review gate was not decorative on this run: `code_review` BLOCKED it, and
the blocking finding was correct (a planning artifact committed as scope creep,
with the `.gitignore` line that had excluded it removed). A gate that stops a
build for a true reason is the difference between a review step and a review
that means something.

Gate-count note: the run emitted NINE `stage_complete` events, but the canonical
count is EIGHT numbered quality gates -- `lsp_diagnostics` is a stage that runs
alongside them and is not one of the eight (CLAUDE.md records the same
distinction for the healing-mode auditor). An earlier draft of this section
counted the stage events instead of the gates, which the P0 verification sweep
correctly flagged as gate-count drift. Counting stage events is not the same as
counting gates.

### What this proves, stated exactly

* **Proven:** on this artifact, the harness produced tests that run green and
  ran nine independent gates over the result, one of which correctly blocked.
  That is evidence in the "no tests, no review" category specifically.
* **NOT proven:** a "10x better across UI, UX, Backend and Harness" claim. Three
  of those four categories are not measurable from this machine at all -- we
  cannot instrument a competitor's UI, UX, or backend, and no amount of local
  benchmarking substitutes for that. One category (harness output) has evidence;
  the other three do not.
* A single artifact is not a distribution. This is one run of one spec.

The honest framing for external use is the category claim -- "tests and review
that actually block, on a real build" -- backed by these numbers, not a
multiplier across dimensions we never measured.

## MODEL-AGNOSTIC PARITY (measured 2026-07-29)

The claim under test is NOT "loki is fast". It is that the HARNESS delivers a
verified outcome regardless of which model drives it -- so a user without
Anthropic's most expensive model still gets a real result.

Same spec, same 8 gates, same acceptance check, same machine. Only the model
differs.

| Model | Iterations | Wall | Engine work | Exit | Completed | Acceptance |
|---|---|---|---|---|---|---|
| haiku  | **1** | 7.7 min | 0.9 min | 0 | yes | PASS |
| sonnet | **1** | 9.3 min | 0.7 min | 0 | yes | PASS |

Identical on every quality axis: same iteration count, both completed, both
exit 0, both passed acceptance. The cheap model reached the same verified
outcome as the expensive one.

### What this does and does not prove

* **Does prove:** the gates, council and evidence path are model-independent on
  this spec. A user on the cheaper tier is not getting a degraded verification
  path -- they get the same one.
* **Does NOT prove** a general "any model works" claim. This is one spec
  (greet CLI), one trial per model, and acceptance here is a file-existence
  assertion. It measures time-to-verified-outcome, not code quality.
* Wall-clock differs by 1.6 min in haiku's favour, which is within the noise
  band established earlier (v7 spread was 8.5 min across three trials). Do not
  quote it as a speed result.

### Why this was worth running rather than asserting

An earlier draft of this session claimed model-agnostic support was
"documented and wired" on the strength of reading `providers/claude.sh` and
`providers.ts`. Wiring is not evidence. Running the matrix is: it converts a
design intention into a measured fact, and it cost one benchmark cycle.

## Decision: benchmark a REALISTIC PRD, not just the hello-world CLI

The 1-iteration result above is on a single-file `greet` CLI. That proves the
MECHANISM (remove a false-positive gate + a false empty-diff, and the loop
converges) but it CANNOT answer the founder's actual question, which is about a
PRD that takes ~15 min / 5 iterations. A one-file build exercises none of the
cross-file reasoning, persistence, or error-path work a real PRD demands.

Added `benchmarks/specs/task-api-prd.md`: a 4-file HTTP task service (server +
separate store module + tests + README), 5 requirement groups, 12+ endpoints and
validation cases, file-backed persistence that must survive a restart. Node
built-ins only -- no npm dependencies -- so the run measures the ENGINE rather
than package-install latency or network flakiness.

Harness change required (measurement code only, NOT engine code): the acceptance
check was hardcoded to `greet.js`, so any custom `--spec` run would have scored a
meaningless permanent failure. It is now keyed off the spec text. The same
measurement-only patch was synced into the v7 worktree so both arms are scored
identically; **v7's engine remains untouched at v7.129.5**.

Both arms get identical caps (12 iterations, 2400s), only the engine differs.
Acceptance remains FILE-EXISTENCE assertions -- it proves the engine produced the
artifacts the spec named, and is still NOT a judgment of code quality.

## Decision: what the v7 arm is allowed to be

Both fixes (F3 start-sha, F5 mock-integrity FP) are SHARED code -- v7 has both
bugs, verified by grep in the v7.129.5 worktree. So there were two defensible
comparisons and they answer different questions:

* **Backport the fixes to v7, then compare.** Isolates "v8 the engine" from "the
  fixes". Academically cleaner, but it measures a v7 that does not exist and that
  no user can install.
* **Compare SHIPPED v7.129.5 against fixed v8.** What a user actually
  experiences when they upgrade.

**Chose shipped-vs-shipped.** The founder's question is whether upgrading gets a
user to done faster, and users install releases, not patched worktrees. The v7
arm is therefore left UNMODIFIED at v7.129.5.

The obligation this creates: state plainly that the gain comes from two shared
bug fixes that happen to ship first in v8, NOT from a v8 architectural advantage.
Anyone backporting them to v7 would see the same improvement. That framing is in
every summary of this result, and must stay there.

## Method notes

* Engine-active time = first to last event in `.loki/events.jsonl`. Do not use
  wrapper process elapsed time (F4).
* Gate stages totalled 28s across the whole v8 run, so gate overhead does NOT
  explain the v7/v8 time difference; the difference is model work inside
  iterations 2 (166s) and 4 (313s).
* Acceptance here is `greet.js_exists`, a file-existence assertion. It shows the
  engine finished the job. It is NOT a judgment of output quality, and must not
  be reported as one.
