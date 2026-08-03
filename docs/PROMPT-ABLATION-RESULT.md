# Prompt ablation: measured result

Date: 2026-08-03. Instrument: `benchmarks/run-prompt-ablation.sh`,
reporter `benchmarks/report-prompt-ablation.py`. Raw rows:
`benchmarks/results/prompt-ablation.jsonl`.

## The question

Anthropic deleted roughly 80% of Claude Code's system prompt for Opus 5, on
the finding that instructions written to correct older models had become dead
weight, and that the model measured slightly MORE capable without them.

`LOKI_SIMPLE=1` strips the coaching half of our prompt: the RARV cycle, SDLC
phases, memory habits. Per-iteration state (which gate failed, self-heal
output, checklist status) is never touched, because that is information the
model cannot derive from anywhere else.

Prompt size fell 78% (about 1562 tokens per iteration), reproduced
independently on both the bash and Bun routes. That is a TOKEN measurement.
It says nothing about whether the stripped arm builds the same thing, faster
or slower, more or less reliably. This is that measurement.

## Result

```
trials recorded: full=3 simple=3

metric       full (default)          simple (LOKI_SIMPLE=1)
-----------------------------------------------------------
wall clock   8.2 min [7.3-8.7] n=3   7.6 min [6.2-8.0] n=3
iterations   1.0     [1.0-1.0] n=3   1.0     [1.0-1.0] n=3

full   reliability: 3/3 completed
simple reliability: 3/3 completed

VERDICT: NO DIFFERENCE DEMONSTRATED -- the arms' ranges overlap
         (full 7.3-8.7, simple 6.2-8.0), so the median gap is within
         the run-to-run noise.
```

## What this means, stated carefully

**Speed: no difference demonstrated.** The simple arm's median is 0.6 min
lower, but the ranges overlap heavily. A gap smaller than the variance each
arm shows against itself is not a finding.

**Reliability: no difference demonstrated.** 3/3 completed in both arms, and
every run passed its acceptance check. Both arms finished in a single
iteration.

**Cost: the token saving is real and stands on its own.** 78% less prompt per
iteration is a deterministic, reproducible measurement that does not depend on
these trials at all.

**The honest summary: stripping the coaching prompt cost us nothing
measurable, and saved 78% of the prompt.** That is a weaker claim than "the
model is better without it" and a stronger one than "no effect" -- removing
1562 tokens of instruction per iteration did not degrade speed, completion, or
acceptance across six real builds.

## Why this was nearly reported wrong

After trial 1, the numbers were full 8.2 min against simple 6.2 min. That is a
24% improvement, and it is exactly the shape of result that gets written into
a release note.

Trial 2 reversed it: full 7.3, simple 8.0.

One trial of a stochastic agent is indistinguishable from noise. The reporter
refuses to declare a winner when the ranges overlap, and refuses entirely
below n=3 per arm, which is why the instrument was built before the claim
rather than after it.

## Limits, stated rather than left for a reader to discover

- **n=3 per arm.** Enough to see that the arms overlap; not enough to detect a
  small real effect. A difference under roughly 20% would not be visible here.
- **One spec, one model.** A single small build on sonnet. Coaching may matter
  more on a longer task, a weaker model, or a spec where the RARV structure is
  load-bearing. This says nothing about those.
- **Both arms finished in one iteration**, so this never exercised the
  iterate-and-recover path where per-iteration state matters most. That is the
  case where stripping coaching is most likely to be safe and where the
  remaining prompt does the most work, and it is untested.
- **Degraded providers are unaffected.** Codex and Aider take an earlier
  return path, so the flag never reaches its gate there. Measured as a 0-byte
  delta, not assumed.

## Reproduce

```bash
benchmarks/run-prompt-ablation.sh --trials 3 --model sonnet --max-iters 6
python3 benchmarks/report-prompt-ablation.py benchmarks/results/prompt-ablation.jsonl
```

Both arms run in ONE engine copy; the only difference is the environment
variable read at prompt-assembly time.
