# Loop harness audit, and one proposed measurement slice

Audit only. No runtime behaviour is changed by this document, and the proposal
at the end is read-only by construction.

Every figure here was measured against the working tree at `4d8625bb`
(v9.12.5) on 2026-08-04. Commands are included so each can be re-run rather
than trusted.

## What already exists

### Structured traces

`.loki/events.jsonl` is the trace surface, written by `emit_event_json`
(`autonomy/run.sh:2435`) with a UTC timestamp and arbitrary `key=value` pairs.
**26 distinct event types** are emitted:

```
agent_prompt              budget_exceeded            budget_warning
capability_degraded       code_review_complete       code_review_council_complete
code_review_*_oversized   code_review_start          dashboard_crash
gate_stuck                iteration_complete         iteration_start
managed_agents_fallback   managed_review_council_ok  phase_change
policy_denied             provider_failover          provider_recovery
review_verification_failed session_end               session_start
stage_complete            task_completion_claim      watchdog_alert
```

```bash
grep -ohE 'emit_event_json "[a-z_]+"' autonomy/run.sh | sort -u
```

### Verifier surface

Gate functions in `autonomy/run.sh`:

```
_evidence_gate_and_surface     _invariant_gate_and_surface
_semantic_gate_and_surface     _loki_supervised_completion_gates_pass
gate_failure_disposition       build_gate_escalation_context
run_doc_quality_gate           run_magic_debate_gate
```

Plus the 3-reviewer blind council, whose completion is traced by
`code_review_complete` and `code_review_council_complete`.

## The gap, stated precisely

**The verifiers run, but they do not record what the directive asks for.**

`code_review_complete` carries exactly three fields:

```
review_id=<id>  source=managed  iteration=<n>
```

`review_verification_failed` carries:

```
reason=<slug>  iteration=<n>  implementation_retry=<bool>
```

Neither carries any of:

| Field the directive asks for | Emitted today |
|---|---|
| eligibility (did this verifier apply?) | no |
| deterministic criterion | no |
| retry cap / timeout cap | no |
| latency | no |
| tokens | no |
| cash cost | no |
| verdict | partial (failure reason only) |
| changed the terminal outcome? | no |
| false-positive review | no |
| rollback switch | no |

The `_evidence_gate_and_surface`, `_invariant_gate_and_surface` and
`_semantic_gate_and_surface` functions emit **nothing structured at all** --
grepping their bodies for `emit|json|cost|latency|duration|verdict` returns no
matches.

So a loop-harness manifest cannot be *derived* from today's traces. It would
have to be *fabricated*, which is the failure mode this codebase treats as
worse than an absent measurement.

### Why that matters more than it sounds

This session produced a concrete example of the cost. A gate false positive
(mock-integrity firing on `require.resolve` + `spawnSync`) made first-pass
completion impossible for every npm user, and it was invisible until someone
ran the real thing. With per-verifier records carrying `verdict`,
`changed_terminal_outcome` and `false_positive_reviewed`, that class shows up
as a measurement rather than a field report.

## Other audit axes, briefly

**Memory / skills / prompts.** The main-loop prompt is assembled in memory and
never persisted (`build_prompt`, `autonomy/run.sh:8987`), so prompt-version
attribution is not currently possible. Review prompts *are* persisted
(`run.sh:14700`). Any prompt-versioning proposal has to start by making the
main prompt observable, and that is a runtime change -- out of scope here.

**Context compression.** The prompt splits at `[CACHE_BREAKPOINT]` into a
cache-stable prefix and a volatile tail. That is a real, already-shipped
compression discipline. It is not currently measured per-run.

**Model routing by quality/latency/cost.** `get_rarv_tier()` maps iteration to
model tier. The mapping is deterministic and readable; what is absent is any
*recorded* per-call association between the tier chosen and the outcome it
produced, which is what a routing evaluation would need.

## Proposal: `loop-harness-v1`, read-only, one slice

**Do not add a loop. Do not change runtime architecture.** The single coherent
reversible slice is a **report over traces that already exist**, plus the
smallest instrumentation that makes the report non-vacuous.

### Phase A -- report only, zero runtime change

`tools/loop-harness-report.py`, a read-only reader in the shape of the existing
`api_*` modules:

- reads `.loki/events.jsonl`
- emits one row per verifier invocation it can actually observe
- **every field it cannot derive reads UNKNOWN, never a default**
- carries the standard envelope: `source`, `freshness_s`, `reason`
- exits 3 (nothing to check) on a workspace with no verifier events

This is honest on day one: most columns read UNKNOWN, and the report says so.
That is the correct starting point -- it makes the gap visible and measurable
rather than asserting a completeness that does not exist.

### Phase B -- instrumentation, only where A proves it is needed

Add the missing fields to the three gate functions and the council completion
event. Each addition is one `emit_event_json` call with named fields, and each
is independently revertable.

Phase B is **not** proposed for adoption yet: it changes runtime behaviour, and
the directive says keep runtime unchanged unless an evidenced deterministic
requirement justifies it. Phase A produces that evidence.

### What would make this worth automating

The directive's bar is the right one: automate only when offline replay and
online outcomes prove quality-adjusted lift exceeds latency and cost. Phase A
cannot clear that bar and does not try -- it is the measurement that would let
a later proposal clear it.

## Rollback

Phase A adds one file under `tools/` and touches no runtime path. Rollback is
deleting it. Nothing in `.loki/` is written, so there is no state to unwind.

## The four surfaces, measured

| Surface | State | Evidence |
|---|---|---|
| Composable core-agent loop | present, modular | `run_autonomous()` + `get_rarv_tier()` + `build_prompt()` are separable functions |
| Bounded verification loop | present, **unmeasured** | 3 gate fns emit 0 structured records; `code_review_complete` carries 3 fields |
| Real-system event-driven loop | present, **partial contract** | `autonomy/trigger-server.py`: auth 7, timeout 12, idempotency 4, retry 2 -- but dedupe 0, dead-letter 0, backpressure 0 |
| Self-improvement / hill-climbing | present, **not wired to traces** | `LOKI_AUTO_LEARNINGS` appears 0 times in `run.sh`; the TS route has it (`counter_evidence.ts`, `episode_bridge.ts`) |

```bash
for p in idempot dedupe dead.letter backpressure retry timeout auth; do
  printf '%-16s %s\n' "$p" "$(grep -ciE "$p" autonomy/trigger-server.py)"
done
```

### The three exact gaps

1. **Verifier records carry no cost, latency, criterion, or effect.** This is
   the blocker for every downstream ask -- a marginal-lift comparison, a
   promotion rule, and a canary decision all need per-verifier cost and
   outcome, and none is emitted.

2. **The trigger contract is three properties short.** Auth, timeout,
   idempotency and bounded retry exist. Dedupe, dead-letter state and
   backpressure do not. An idempotent trigger without dedupe still processes a
   duplicate delivery; without dead-letter state a poisoned message retries to
   its cap and vanishes.

3. **The learnings loop is route-asymmetric.** `LOKI_AUTO_LEARNINGS` is
   documented as default-on in the Bun runner and is absent from `run.sh`, so
   the bash route contributes nothing to hill-climbing. Any trace-driven
   improvement claim measured on one route does not transfer to the other.

## Why architecture stays unchanged

Every downstream ask in the directive -- matched online cohorts, marginal-lift
per verifier, a promotion rule, a canary window -- is **downstream of
measurement that does not exist**. Building a manifest, a cohort comparison or
an automation rule on top of absent instrumentation would produce numbers with
no referent.

The cheapest surface that changes this is Phase A: a read-only reader that
reports what IS recorded and names what is not. It is implemented and tested
(`tools/loop-harness-report.py`, 8 assertions, both fabrication modes
mutation-tested). Against this repo's own trace it reads 776 records, finds no
verifier events, and exits 3 with a reason rather than printing an empty table
that reads as a clean run.

**The smallest reversible next step** is adopting Phase A and running it over
a real build's trace. That yields the first honest per-verifier row set, and
its UNKNOWN columns are the evidenced requirement that would justify Phase B
instrumentation -- which is a runtime change and is deliberately not proposed
until that evidence exists.

## Correction: the six named axes, measured

The first pass treated routing as unmeasured. That was wrong, and the correction
matters because it changes which work is worth doing.

| Axis | State | Evidence |
|---|---|---|
| Memory / retrieval | wired into the loop | 13 references in `run.sh` |
| Tool descriptions | present | 13 in `mcp/server.py` |
| Context compression | shipped, unmeasured per-run | `[CACHE_BREAKPOINT]` prefix split |
| Prompts | **not attributable** | main prompt in memory only (`run.sh:8987`); review prompts persisted (`:14700`) |
| **Quality/latency/cost routing** | **fully recorded** | see below |
| Verifier records | **absent** | unchanged from the first pass |

### Routing is already instrumented

`.loki/metrics/efficiency/` records carry:

```
model  provider  phase  iteration  status  timestamp
cost_usd  duration_ms
input_tokens  output_tokens  cache_read_tokens  cache_creation_tokens
```

`LOKI_CURRENT_MODEL` holds the EXACT dispatched `--model` value, exported after
every mutation (opus-pin, `LOKI_MAX_TIER` clamp, mid-flight override), so the
recorded model is the one actually used. `run.sh:7834` documents the bug that
made this necessary: hardcoding the development-tier default mislabeled every
non-development iteration and "made the model-equivalence bench unfalsifiable."

`record_is_measured()` (`autonomy/lib/efficiency_cost.py:81`) is the single
definition of measured, and its docstring records why a second copy is
forbidden: "the four surfaces that once rendered an unmeasured run as $0.00
each had their own idea of what counted as measured."

`dashboard/api_runs.py` already reads these (22 references).

**So a quality/latency/cost routing evaluation is possible today** -- model,
cost, latency and tokens are all recorded per iteration with an honesty
predicate. What is missing is not instrumentation but a *comparison*: no
baseline pins a model choice to an outcome.

### The caveat, and why it is smaller than it looked

Efficiency records are WIPED at run start (`run.sh:6212`), which is why a
historical run reports `cost_usd: None` and why this workspace holds zero
records.

But receipts survive, and they DO carry the model. `proof-generator.py:627`
resolves it through four sources -- an observed value, `LOKI_CURRENT_MODEL`,
`LOKI_SESSION_MODEL`, `SESSION_MODEL` -- then the execution policy's
`sdk_id`/`alias`, and only then returns the string `"unavailable"`. It never
guesses.

Verified end to end: generating a receipt with `LOKI_CURRENT_MODEL=
claude-sonnet-5` yields `provider: {"name": "claude", "model":
"claude-sonnet-5"}`. The nine archived receipts read `"model": "unavailable"`
with `cost_usd: None` because they predate the efficiency wiring, not because
the mechanism is missing.

**So the cross-run corpus for a routing evaluation is the receipt archive**,
which retains model, provider, cost, tokens and wall clock per run. No new
instrumentation is required.

### What this changes about the proposal

Verifier records remain the real gap, unchanged. But routing does NOT need
Phase B instrumentation -- it needs an evaluation over data that already
exists. That is a cheaper and better-evidenced next step than instrumenting
the gates, and it is squarely inside the directive's "improve routing before
touching architecture."

## The routing evaluation: blocked on corpus, not on code

Having established that receipts retain the model, the obvious next step is the
evaluation itself. It cannot be built yet, and the reason is worth recording
precisely.

Measured across the whole archive:

```
receipts:            9
models:              {"unavailable": 9}
with measured cost:  0
```

Every receipt reads `"model": "unavailable"` and `cost_usd: None`. They were
written Jul 26 and Jul 31; the efficiency wiring that populates both landed
later. The mechanism is proven to work -- generating a receipt with
`LOKI_CURRENT_MODEL` set captures the exact model -- but no archived run
exercised it.

**So a routing evaluation today would have zero rows to compare.** Building it
now produces a reader with nothing to read, and any number it reported would
be derived from a single degenerate cohort.

That is a corpus problem, not a code problem, and the fix is not more code: it
is running builds and letting the archive fill. Each real `loki start` from
here produces a receipt carrying model, provider, cost, tokens and wall clock.
The evaluation becomes worth writing once the archive holds more than one
distinct model.

### What this means for sequencing

The directive asks for verifier lift to exceed latency and cost on baseline
plus ambitious E2E plus online outcomes. That bar cannot be cleared from a
corpus of nine degenerate rows, and no amount of tooling changes it.

The honest ordering is therefore:

1. accumulate receipts from real runs (no code required)
2. write the evaluation once two or more distinct models appear
3. only then consider verifier instrumentation, which is the one gap where
   the data genuinely does not exist at any volume

Steps 1 and 2 need no runtime change. Step 3 remains unproposed.

## Step 1 executed: the corpus has its first real row

Rather than leave "accumulate receipts" as advice, one real `loki start` was
run against a minimal spec. It completed exit 0, built working code (its own
6 tests pass), and wrote a receipt carrying exactly what a routing evaluation
needs:

```
provider     {"name": "claude", "model": "sonnet"}     <- not "unavailable"
cost_usd     1.3828        input/output tokens  48 / 7290
iterations   1 succeeded, 0 failed
duration_ms  128000        wall_clock_sec       576
base_sha     ef1efe909750  head_sha             5a727616da91
```

Contrast with the nine archived receipts, all `"model": "unavailable"` and
`cost_usd: None`. The mechanism was never broken; those runs simply predate
it.

`iterations.attribution` is worth noting for any lift measurement: it splits
cost into `progress` and `rework`, and states its own basis -- "rework counts
FAILED iterations only; a completed iteration forced to repeat by a gate is
counted as progress, so rework is a floor". That is a self-describing lower
bound rather than an unqualified number.

### The verdict reads FAILED, correctly

`receipts_report` returns FAILED with `measured: True` and the real cost. The
reason is diff drift: 11 files / +494 recorded, more now. The cause was
verified by timestamp -- only `run.log` (still being appended) and
`.pytest_cache/` from the verification run itself changed after signing.

That is the verifier working. A receipt signed at time T and inspected at
T+delta, with files touched in between, SHOULD fail. The lesson for a future
evaluation harness: read receipts without running anything inside the
workspace, or the act of measuring invalidates what is measured.

### Where the corpus stands

Two distinct models are needed before a comparison means anything. The archive
now holds one real row (`sonnet`) plus nine degenerate ones. The evaluation
remains unwritten, and that is still the honest position -- but step 1 is no
longer hypothetical.

## Step 2: two models, and the first real comparison

A second real run, pinned with `LOKI_SESSION_MODEL=opus`, gives the corpus its
second distinct model. Both runs used the same shape of task (a small pure
helper plus its test) and both succeeded in one iteration.

| | sonnet | opus |
|---|---|---|
| cost_usd | 1.3828 | **0.6823** |
| output tokens | 7290 | **4446** |
| wall_clock_sec | 576 | **472** |
| progress duration_ms | 128000 | **71000** |
| iterations | 1 succeeded | 1 succeeded |

**This is two data points, not a finding.** Two runs of two different specs
cannot separate model effect from task effect, and the directive's bar --
lift exceeding latency and cost across baseline, ambitious E2E, and online
cohorts -- is nowhere near cleared. Recorded because it is the first
comparison the corpus has ever supported, and because the shape is now
proven: the fields needed for a routing evaluation arrive populated and
measured on every real run.

## A real defect the corpus work surfaced

Both receipts read FAILED on diff drift. The first time, the cause was my own
verification run writing `.pytest_cache/`. The second time I deliberately
touched nothing, and it STILL failed. The only file newer than the receipt:

```
run.log
```

**A run whose stdout is redirected into its own workspace invalidates its own
receipt.** The log keeps growing after the receipt is signed, so the recorded
diff no longer matches the tree. Any user who runs
`loki start ./prd.md > run.log` inside the workspace gets a receipt that
cannot verify, through no fault of their own.

### Scoping that claim honestly

The first write-up called this a usability trap users would hit. Checking
rather than assuming shrinks it:

- the documented invocation is plain `loki start prd.md` (README:333, 342,
  360) with NO redirection, so an interactive user never creates `run.log` in
  the workspace
- the runtime has no concept of its own log path -- grepping `run.sh` and the
  CLI for `LOKI_RUN_LOG`, `RUN_LOG=` or a log-path helper returns nothing
- `> run.log` appears nowhere in the docs; it was MY invocation choice for a
  backgrounded run

So this is not a shipped defect users are hitting. It is a real constraint on
anyone who captures stdout inside the workspace -- CI harnesses, scripted
runs, and future evaluation tooling -- and that includes the routing
evaluation this audit is building toward.

`workspace_diff.py:28` already has an `_excluded()` predicate (currently
`.loki/` only), so excluding a known log path would be a one-line change. It
is NOT proposed, for a specific reason: excluding by the literal name
`run.log` would silently drop a user's own file of that name from the receipt,
which is a worse failure than the one being fixed. A correct fix needs the
runtime to know its own log path, and that is a runtime change with no
evidenced user demand behind it.

The durable output is the constraint, not a patch: **an evaluation harness
must not write inside the workspace it measures**, including redirecting the
run's own stdout there. Recorded so it is not rediscovered a third time.

## Correction: two of the three trigger gaps were my grep, not the code

The audit claimed `autonomy/trigger-server.py` was three properties short:
dedupe 0, dead-letter 0, backpressure 0. Two of those were false negatives from
searching for the wrong words.

**Dedupe exists** and is well built. `Dispatcher.seen_delivery()` keeps recent
GitHub delivery ids in a lock-guarded bounded `OrderedDict`. It deliberately
does NOT refresh recency on a duplicate, and the code says why: "a flood of one
valid (authenticated) duplicate id could keep it pinned and evict up to
dedup_max genuinely-recent ids, letting real redeliveries slip through."

Verified by executing the method directly:

```
first delivery abc   -> False   (new)
repeat delivery abc  -> True    (deduped)
absent header ""     -> False   (never deduplicated, falls through)
after eviction       -> False   (bounded, evicts oldest first)
```

**Backpressure exists.** The dispatcher holds a bounded `queue.Queue`, catches
`queue.Full`, and sheds load with 503 -- the module docstring states it at line
12. My earlier check used a malformed `-E` alternation and returned 0 for terms
plainly present in the file (`queue_size` alone appears 7 times).

**Dead-letter state is the one that is genuinely absent.** No DLQ, no failed-job
retention: a job that exhausts its retries is dropped.

### The lesson, which is the same one twice

`phases` was reported missing from `loki proof --help` by a grep that could not
see it; dedupe was reported absent by a grep looking for the wrong noun. Both
times the code was fine and the measurement was broken.

An absence found by grep is a hypothesis, not a finding. It has to be confirmed
by reading the code or executing it -- exactly the standard this audit applies
to the runtime, now applied to the audit itself.

### Revised trigger contract state

| Property | State |
|---|---|
| authentication | present |
| timeout | present |
| bounded retry | present |
| idempotency | present |
| **dedupe** | **present** (verified by execution) |
| **backpressure** | **present** (bounded queue, 503 shed) |
| dead-letter state | absent |

One property short, not three. A trigger-to-run-to-receipt path is therefore
much closer to complete than the audit claimed, and the remaining gap is
narrow: a job that exhausts retries vanishes without a record.

## Third correction: the last "gap" is smaller still

Applying the new standard to my own remaining claim -- dead-letter state absent
-- turned up a near-miss worth recording, because the mistake is instructive.

Reading `_worker` (trigger-server.py:425) shows `dispatch_event` wrapped in
`try/finally` with NO `except`. That looks like a serious defect: one handler
exception would kill the worker thread, and with `DEFAULT_WORKERS = 4`, four
failures would silently drain all capacity while the server kept returning 200.

I reproduced exactly that behaviour and was ready to report it. **The
reproduction was wrong**: it used a stub that raised, not the real
`dispatch_event`.

The real function catches everything (`trigger-server.py:356`):

```python
except Exception as e:  # defensive: never let a worker die on bad input
    logging.exception("Handler for %s raised: %s", event_type, e)
    summary, status = None, "error"
```

Verified against the actual code: `dispatch_event` returns `(None, "error")`
without raising, logs the traceback, and the daemon thread count is unchanged
(1 before, 1 after). The worker survives, and the guard is placed at the callee
precisely so the bare `try/finally` in the loop is safe.

### What that leaves

A failed job IS recorded -- `logging.exception` plus `log_event(..., status)`.
So "dead-letter state absent" overstates it too. What is genuinely missing is a
*queryable* record: the failure lands in logs, not in a structure something
could retry from or report on.

That is a real but narrow gap, and it is not worth a runtime change on this
evidence.

### Score on my own audit

Of the three trigger gaps originally claimed:

- dedupe -- **present**, found by grepping the wrong noun
- backpressure -- **present**, found by a malformed regex
- dead-letter -- **overstated**; failures are logged, just not queryable

And one defect I nearly reported was an artifact of testing my own mock.

Four measurement errors in one audit section. The corrective standard, now
demonstrated three times: **an absence is a hypothesis until the real code is
read or executed** -- and a reproduction must exercise the real function, not
a stand-in shaped like it.

## Clean checkpoint: 5605deca, all 19 jobs green

Recorded per the gate discipline: the trigger-contract correction reached
`Tests@5605deca: completed / success`, 19 of 19 jobs, zero failures. No run was
superseded to get there.

### Where the four surfaces actually stand, after all corrections

| Surface | State | Confidence |
|---|---|---|
| Composable core-agent | modular, separable functions | read |
| Bounded verification | verifiers run; records carry no cost/latency/criterion/effect | read + grep |
| Event-driven trigger | auth, timeout, retry, idempotency, dedupe, backpressure all present; failures logged but not queryable | **executed** |
| Self-improvement | `LOKI_AUTO_LEARNINGS` on the TS route only, absent from `run.sh` and the CLI | grep, unverified |

The confidence column matters more than the state column. Everything I checked
by execution survived scrutiny; three of the four things I checked by grep did
not.

### The smallest next slice, and why it is not code

The directive's bar for any verifier change is a matched ablation showing lift
above p95 latency and cost, on the same task, across seeds. Nothing in this
repo can currently produce that number:

- verifier records carry no cost or latency at all, so the denominator is
  missing
- the routing corpus holds two real rows from two DIFFERENT specs, which is
  explicitly excluded ("do not infer this from different tasks or one seed")

So the smallest honest next slice is **the same spec run twice under two
models**, which is the minimum a matched ablation admits. That is one command
and no code. Until it exists, any harness or eval built on top would be
measuring a corpus that cannot support the claim.

The one surface still unverified by execution is self-improvement: the
`LOKI_AUTO_LEARNINGS` asymmetry was found by grep, and grep has been wrong
three times in this audit. It should be confirmed by running before it is
treated as a finding.

## The matched pair, executed

The previous entry said the smallest honest next step was the same spec run
twice under two models. That has now been done: identical `prd.md` (byte-for-byte,
`diff -q` verified), identical iteration cap, run SEQUENTIALLY so CPU contention
could not confound latency, logs written OUTSIDE each workspace so the run could
not invalidate its own receipt.

| | sonnet | opus |
|---|---|---|
| cost_usd | 0.7177 | **0.6257** |
| output tokens | 3658 | 3547 |
| wall_clock_sec | 458 | **406** |
| progress duration_ms | 65000 | 67000 |
| iterations | 1 of 1 succeeded | 1 of 1 succeeded |
| produced code | 1 test passing | 1 test passing |

Both arms solved the task. On this pair, opus was 12.8% cheaper and 11% faster
in wall clock, while taking marginally longer in measured progress duration --
the wall/duration split suggests the difference sits in orchestration overhead,
not model latency.

### What this does and does not license

It **does** establish that the corpus can now produce a matched comparison: same
task, same budget, controlled ordering, both outcomes verified by running the
produced tests rather than trusting the receipt.

It **does not** clear the directive's bar. That requires lift above p95 latency
and cost across seeds, and this is n=1 per arm. A single pair cannot separate
model effect from run-to-run variance, and the two prior unmatched runs
(sonnet $1.3828, opus $0.6823) differ from these by more than the arms differ
from each other -- which is itself the evidence that one pair proves nothing
about the population.

The honest reading: the *method* is now demonstrated end to end. The *finding*
needs repetition, and repetition is provider spend, which is a founder call.

### Method notes worth keeping

Three procedural constraints were learned by getting them wrong first:

1. log outside the workspace, or the run invalidates its own receipt
2. run arms sequentially, or contention confounds the latency column
3. verify the produced artifact by executing it -- a receipt records what a run
   claimed to do, not whether the code works
