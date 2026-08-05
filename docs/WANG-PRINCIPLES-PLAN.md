# Wang's Five Principles: measured audit and plan

Founder ask: make Wang's five agentic-system principles the heart of the Loki
engine, grounded in researched speed / quality / cost data.

**This was asked for and not delivered.** A day was spent on gates, packaging
and test-detection instead. This is the plan, written against measurement
rather than intention.

The five principles, as Wang states them:

1. **Systems Thinking** -- never goes out of style
2. **Speed** -- "one of the most critical things"
3. **Reliability** -- "extremely important"
4. **Extensibility** -- scale to complex multi-agent setups
5. **Feedback Loops + Evals/Metrics** -- *"if you can develop the right agentic
   loop and have the right eval or metric for the agents to optimize, a swarm of
   agents can accomplish more than a team of a hundred engineers"*

---

## 0. The research finding that reframes everything

> **"The same model in a different harness routinely drops 10-15 points --
> pick the harness, not just the model."** (2026 SWE-bench harness comparisons)

That is our entire thesis, stated by the market. We cannot train a frontier
model. **We do not have to.** The harness is worth 10-15 points, and the harness
is the thing we build.

Supporting 2026 data:

| finding | number |
|---|---|
| Harness delta on an identical model | **10-15 points** |
| Top of SWE-bench leaderboard | 75-80% (GPT-5.6 Sol 96.2%, Claude Fable 5 95.0% claimed) |
| Cost per SWE-bench pass, Sonnet 4.5 | **~$14** |
| Open harness + open weights vs Devin | **~1/20th the cost** |
| Agent failures traced to planning | 82% |
| First-iteration pass rate | 47.8% |
| Resolutions needing user correction | 91.49% |

The cost line matters commercially: **a 20x cost spread exists between harnesses
running comparable models.** Cost-per-resolved-issue is a competitive axis we
have never measured.

## 1. Honest audit: where we actually stand

Measured on this machine, not asserted.

| principle | state | evidence |
|---|---|---|
| **1 Systems Thinking** | STRONG | 8 quality gates, RARV-C loop, council, Evidence Receipt, dual-route parity enforced by test |
| **2 Speed** | MEASURED, UNOPTIMISED | agent call = **980s = 96%** of iteration; all gates together = 44s |
| **3 Reliability** | STRONG, newly so | 73 mutation-proven trust invariants; four gates were shipping broken until v8.38.0 |
| **4 Extensibility** | STRONG | 4 providers, 41 agent types, MCP (34 tools), plugin marketplace |
| **5 Feedback Loops / Evals** | **BROKEN** | `cost_usd == 0` on **3 of 5** efficiency records; no eval score for our own harness |

**Principle 5 is the gap, and it is the one Wang weights highest.** He states the
whole thesis conditionally: *"if you can develop the right agentic loop AND have
the right eval or metric for the agents to optimize."* We have the loop. We do
not have the metric.

## 2. What "broken" means concretely

**Cost is not measured.** The efficiency schema has every field --
`cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `model`, `duration_ms` -- and `cost_usd` is **0** on 3
of 5 records. We cannot answer "what did this issue cost?", which is:

- the axis with a measured **20x industry spread**
- the thing a buyer compares first
- unmeasurable *after* the fact, because token counts are per-call

**Our harness has no eval score.** `benchmarks/` contains a SWE-bench-lite
dataset and a results directory. There is no recorded score for the current
harness. So when the research says a harness is worth 10-15 points, **we cannot
say which side of that we are on.**

This is not a small omission. It is the difference between "we believe our
harness is good" and "our harness scores X, and here is the receipt."

## 3. The plan

Ordered by Wang's own weighting: the eval/metric loop first, because he makes
everything else conditional on it.

### W1 -- Make cost real (unblocks principle 5)

`cost_usd == 0` on most records while every input field is present. Fix the
computation, not the schema.

- Compute from `input/output/cache_read/cache_creation` x the model's price.
  All four token counts are already recorded; the pricing table already exists
  (`loki-ts/data/model-pricing.json`, cache tiers included).
- Emit **cost per iteration** and **cost per resolved issue** -- the second is
  the one with the 20x spread.
- Guard direction: a missing price must record **unknown**, never 0. A zero is a
  claim that the iteration was free, and it is the claim currently being made.

### W2 -- Score our own harness (completes principle 5)

`benchmarks/datasets/swebench-lite.json` exists and is unused for this.

- Run the harness against SWE-bench-lite and record the score with the
  Evidence Receipt attached.
- Report **score AND cost-per-resolved-issue** together. Score alone is what
  everyone publishes; the pair is what nobody does, and it is exactly our
  Evidence Receipt moat applied to ourselves.
- Re-run per release: this becomes the regression signal for harness quality,
  which today has none.

### W3 -- Attack the 980s (principle 2, speed)

Measured: the agent call is **96%** of an iteration. Gates are 44s. Every speed
knob shipped so far (v8.33.0-v8.35.0) targets the 4%.

- The lever is prompt size and cache discipline, not gate ordering. The
  `[CACHE_BREAKPOINT]` split exists; cache reads price at 0.1x input.
- W1 is the precondition: without real cost numbers we cannot tell whether a
  prompt change helped or hurt.
- **Do not ship more gate-latency work until this is measured.** It is
  optimising 4% while 96% is unexamined.

### W4 -- Close the loop the metrics feed (principle 5, second half)

Wang's phrasing is *"the right agentic loop AND the right metric."* We have
`LOKI_INJECT_FINDINGS` (findings to next iteration) and `LOKI_AUTO_LEARNINGS`.
What we lack is the metric flowing back:

- Feed cost and iteration count into the run's own decisions, not just the
  receipt. An agent that knows it is on iteration 3 of a budget behaves
  differently from one that does not.
- This is the piece that turns telemetry into a *feedback loop* rather than a
  report.

### W5 -- Systems thinking: stop shipping half-wired features (principle 1)

Not new work; a standing rule earned the hard way. This session found the same
shape repeatedly: a fact recorded but never rendered, a gate that never ran, a
detector never packaged, a valve that fired one iteration too late.

- Every new capability ships **recorded, rendered, acted on, and
  mutation-proven** -- or it is not shipped.
- Already enforced by the 73-invariant detector. The rule is written down so it
  survives.

## 4. What we do NOT do

- **No model training.** Cursor (custom MoE, ~250 tok/s) and Cognition
  (SWE-1.6, ~950 tok/s) bought speed that way. Not reachable. The 10-15 point
  harness delta is, and it is ours.
- **No more gate-latency work before W3 is measured.** 44s of gates against a
  980s agent call.
- **No published score without its cost.** Score alone is the industry norm and
  it is the half that flatters.

## 5. Acceptance

- `cost_usd` is non-zero and correct on **every** efficiency record, or
  explicitly `unknown`
- a recorded SWE-bench-lite score for our harness, **with cost per resolved
  issue**, regenerated per release
- a measured before/after on the 980s agent call

## 6. Why this is the edge

Wang's claim is conditional on the metric. The market's finding is that the
harness is worth 10-15 points. Our moat is the Evidence Receipt -- proof that a
result is real.

**Turn the receipt on ourselves**: publish a harness score *and* its cost, both
provable. Nobody in the category does this. It is the same trust argument that
sells the product, applied to the product's own claims.

Sources: 2026 SWE-bench harness comparisons (morphllm, codesota, awesomeagents),
agent-evaluation framework surveys 2026, Wang interviews (YC Startup Library,
CSIS), SlopCodeBench (arXiv 2603.24755), developer-agent misalignment study
(arXiv 2605.29442).
