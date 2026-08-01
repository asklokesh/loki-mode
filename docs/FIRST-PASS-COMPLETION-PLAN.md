# Fastest First-Pass Full Completion

Founder ask: **fastest first-pass full completion.** No waiting through a second
iteration. Highest quality output. Grounded in researched competitor data, not
test auditing.

This replaces the speed framing of `SPEED-AND-FIRST-PASS-PLAN.md`. That plan
optimised the *duration* of iterations. This one attacks the *number* of them,
which is what the founder actually asked for and where the evidence points.

---

## 1. The research says the bottleneck is not the model

| finding | number | source |
|---|---|---|
| Agent failures traced to **planning, before the first line of code** | **82%** | loadsys 2026 failure-rate analysis |
| First-iteration aggregate pass rate | **47.8%** | SlopCodeBench (arXiv 2603.24755) |
| Failures where the agent **did not attempt to recover** from an error | **56%** | same |
| Visible resolutions **requiring explicit user correction** | **91.49%** | 20,574-session misalignment study (arXiv 2605.29442) |
| Typical iteration cycles per task | **3-5** | Anthropic SWE-bench internal |
| Cursor Agent Loop default iteration cap | **8** | Cursor 2026 breakdown |

Two conclusions, and they point the same way:

1. **Second iterations are caused upstream of the model.** 82% of failures are
   already determined before code is written. Making the model faster or the
   council shorter cannot fix a task that was mis-specified.
2. **Nobody has solved this.** Cursor ships an 8-iteration cap. Devin resolves
   51.5% of issues. The category *assumes* iteration. First-pass completion is
   an unclaimed position, not a race we are losing.

**Strategic consequence.** We cannot out-model Cursor (custom MoE, ~250 tok/s)
or Cognition (SWE-1.6, ~950 tok/s). We do not have to. The measured
bottleneck -- specification quality and error recovery -- is harness work, and
harness work is the thing we can actually do.

## 2. Our own data says exactly the same thing

Every recorded run on this machine:

| project | iterations | gates that failed |
|---|---:|---|
| FireLater | 3 | static_analysis 2, **mutation_integrity 3**, code_review 2 |
| anonima | 4 | code_review 1 |
| autonomi-engine-runs | 1 | none |
| loki-mode | 1 | none |

**Perfect correlation: every multi-iteration run had a failing gate; every
single-iteration run had none.** Iterations are not the model failing to
finish. They are gates rejecting work and sending it back.

That reframes the goal precisely:

> **First-pass completion = the first iteration passes every gate.**
> Not "the model tries harder". Not "fewer gates".

And it explains the founder's 21-minute FireLater run better than any latency
measurement: `mutation_integrity` failed **3 of 3 iterations in 0-1 seconds
each** -- the detector was never packaged (fixed v8.38.0), so the gate could
never pass. **First-pass completion was arithmetically impossible.** No speed
work would have touched it.

## 3. The plan

Ranked by measured contribution to iteration count.

### F0 -- A gate that cannot pass must abort, not iterate (highest value)

FireLater burned 3 iterations against a gate whose detector did not exist. The
gate correctly fail-closed each time; nothing noticed it was failing for the
same unfixable reason.

- Detect a gate failing with an **identical cause** across iterations and stop
  with a named terminal reason instead of re-running the model.
- This is the 56% "did not attempt to recover" bucket, inverted: when recovery
  is *impossible*, the honest move is to say so in iteration 1.
- **Already half-built:** `#87` does exactly this for spec contradictions
  (fail FAST + HONEST + NAMED rather than grinding to max-iterations). Extend
  that proven pattern to unfixable gate failures.
- Guard rails: only on a byte-identical repeated cause, never a first failure,
  and it must map to a terminal-failure exit -- never a fake green.

### F1 -- Front-load the 82%: make the spec gate the first-pass gate

`LOKI_SPEC_GRILL` already interrogates the spec before the loop and defaults
ON. That is the correct lever for the 82% planning bucket, and it is already
paid for.

- Measure what it actually catches per run (it is unmeasured today).
- Extend interrogation from *contradictions* to the ambiguity classes the
  20,574-session study names: unstated acceptance criteria, unstated scope
  bounds, unstated interaction contracts.
- **Research constraint, load-bearing:** auto-generated context files measured
  **-3% success, +20% cost**; human-written ones **+4%**. So this must produce
  *questions and resolutions*, never a generated context blob.

### F2 -- Findings injection must not be silently optional

`LOKI_INJECT_FINDINGS` defaults on, but the injection is gated on
`command -v bun`. **Without bun, the agent is told it failed and not what to
fix** -- the exact "no error recovery" shape that is 56% of failures.

- Make the fallback explicit: if findings cannot be injected, say so loudly.
- A silent degradation of the feedback loop is worse than a missing feature,
  because the next iteration looks like a model failure.

### F3 -- Verify before the gate, not after

47.8% first-iteration pass rate is the industry number. The cheap deterministic
gates (test_suite, static_analysis, lsp_diagnostics) cost ~6s combined and run
*after* the model has already declared done.

- Have the agent run them **during** iteration 1 and fix what they report,
  before the iteration closes.
- Cursor's Agent Loop is exactly this: "runs the test suite, reads stderr,
  edits the offending files, re-runs" -- their headline architectural change.
  We already have the gates; we just run them too late to help pass 1.

### F4 -- Iteration budget as a measured decision

Research: 1-2 iteration caps fail even when the approach was sound; 5-10 is the
recommended range. We ship `LOKI_MAX_ITERATIONS=1000`.

- The goal is not a small cap. It is **finishing in one** and stopping honestly
  when one is not enough.
- Pairs with F0: a cap is a blunt instrument; a named terminal reason is a
  diagnosis.

## 4. What we do NOT do

- **No model training.** Cursor and Cognition bought speed with custom models.
  Not reachable, and claiming otherwise would be dishonest.
- **No generated context files.** Measured -3% success, +20% cost.
- **No weakening of gates to raise first-pass rate.** A gate that stops
  blocking does not improve completion; it fakes it. Every item above either
  fixes the *cause* of a failure or reports it honestly.

## 5. Acceptance

The measurement is already built (`scripts/measure-run.sh`, v8.37.0):

> a scoped GitHub issue completes in **one iteration**, with every gate
> genuinely passing, and when it cannot, the run stops in iteration 1 with a
> named reason instead of grinding.

Baseline to beat, from our own table: FireLater 3 iterations, anonima 4.

## 6. Why this is a real edge

The category has conceded iteration -- Cursor caps it at 8, Devin checkpoints
through it. Nobody markets first-pass completion because nobody has it.

Our moat is the Evidence Receipt: we can *prove* an iteration passed every
gate. Combining that with genuine first-pass completion is a claim no
competitor can make, and it is reachable with harness work rather than a
frontier lab.

Sources: SlopCodeBench (arXiv 2603.24755), developer-agent misalignment study
(arXiv 2605.29442), loadsys 2026 agent failure-rate analysis, Cursor 2026 agent
loop breakdown, Devin SWE-bench reporting.
