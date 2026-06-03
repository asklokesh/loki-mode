> **SAMPLE / MOCK DEMONSTRATION DATA - NOT A REAL BENCHMARK RUN**
>
> This file was generated to test the report renderer. The numbers (success
> rates, costs, timings) are fabricated. No actual benchmark tasks were run.
> No real tool comparison was performed. Do not cite this as a measured result.
> Real benchmark results will be published at a later date once paid runs are
> authorized.

# Loki Mode benchmark results: swe-bench-verified-subset

**Winner: loki** (highest grader success-rate 3/3 (100%)).

| Tool | Model | Success k/N | Cost USD (median) | Wall-clock (median) | Iterations (median) | Quality (median) | Provenance |
|---|---|---|---|---|---|---|---|
| loki | claude-opus-4 | 3/3 | $0.42 | 10.0s | 3 | 0.90 | automated (verified) |
| aider | claude-opus-4 | 1/3 | not recorded | 10.0s | 3 | 0.10 | automated (verified) |
| cursor | (manual) | 2/3 | not recorded | 10.0s | 3 | 0.90 | manual (unverified) |

> Unverified rows (cursor) are operator-supplied manual entries (provenance verified=false) and are EXCLUDED from the winner computation. Treat them as anecdotes with provenance, not measured results.

## Methodology and disclaimers

This section is MANDATORY in every RESULTS.md. Do not trust the number; trust
the methodology. A vendor benchmarking itself and winning is the most-dismissed
move in this space, so this harness is built to let a stranger refute us in
about ten minutes.

### Reproduce it yourself (one command)

The entire run is reproducible by a third party. Clone the repo at the pinned
commit and run the harness command shown in the results header. You do not have
to trust our numbers: re-run the harness against the same frozen public tasks
with each tool's own official harness and recommended config and compare.

```
# List available task-specs
loki bench list

# Run head-to-head across all configured tools on a task
loki bench vs <task-id> --trials 3

# Verify the result integrity (recomputes task_hash + checks tool versions)
loki bench verify benchmarks/bench/results/<result>.json
```

Results are written to `benchmarks/bench/results/` as JSON. To generate
a human-readable RESULTS.md from a result JSON, run:

```
python3 benchmarks/bench/report.py benchmarks/bench/results/<result>.json --out-dir <output-dir>
```

### Task provenance and pinning

Tasks come from FROZEN PUBLIC task sets (for example SWE-bench Verified,
Terminal-Bench, Aider Polyglot) via their own official harnesses, NOT from a
Loki-authored task set scored by Loki-authored logic. Each task is pinned by a
task_hash (sha256 of spec + acceptance + fixture + model). Where a competitor
self-published a number on the same frozen set, we cite their number rather
than running their tool.

### Tool versions

Every tool is run via its own official harness and recommended config, with the
exact version and date pinned and the full config committed. No config
asymmetry: we do not tune Loki while crippling competitors. See the tool
versions table in the results for the exact pinned versions.

### Environment and the read-only grader

Success is decided by held-out acceptance tests / exit codes run by a GRADER
that lives OUTSIDE the agent container, on a read-only host. Loki NEVER grades
itself: the council, RARV-C closure loop, and any LLM-judge are STRUCTURALLY
EXCLUDED from scoring. Adapters report only what a tool did (version, model,
duration, iterations, tokens, cost); they cannot report success or quality.

### What "success" means

Success is binary per trial: the held-out acceptance check passed when run by
the external grader. It is not "the agent said it was done", not a council
approval, not an LLM judgment. Quality, where reported, is a separate
grader-side signal and never an adapter self-report.

### Runs and variance

We run at least N>=3 trials per tool per benchmark and report mean plus the
min-max spread. We LEAD WITH THE CONSERVATIVE (lower) figure. We never lead
with a best-of-runs cherry-pick or hide variance behind a single number. Task
counts below roughly 100 are noisy; small subsets are labeled as such.

### Cost caveats

Cost is reported RAW: tokens in/out, cache rate, wall-clock, and list price,
plus cost-per-SOLVED-task (denominator = solved tasks). We NEVER collapse
different pricing models into a single blended dollar figure. Subscription
pricing and usage-based pricing are shown as separate columns, never merged.
Where a tool exposes no cost, we render "not recorded" rather than "$0.00".
Token-derived costs use the dated public list prices in prices.json and are an
estimate, not a bill.

### Known limitations

These public task sets are likely present in model training data
(contamination). Absolute scores are therefore an UPPER BOUND; the relative
gaps between tools are the signal, not the headline percentages. Manual entries
for tools with no automatable local CLI (for example Devin, Cursor) are
operator-supplied, stamped verified=false, and rendered "unverified": treat
them as anecdotes with provenance, not as measured results.

### Failures

We publish failures alongside wins. Crashes and timeouts count as failures
(score 0), never silently excluded. Loki's own failing runs for this suite are
preserved under results/<date>/loki-failures/.

### Scope of this release (R2)

R2 ships the reproducible HARNESS, the adapter interface, the read-only
held-out grader, this methodology, and a small pinned PUBLIC subset. It does
NOT yet ship a full paid cross-tool leaderboard: CI runs are fully mocked (zero
paid API calls) and the full paid head-to-head across tools is deferred until a
budget is authorized. The cross-tool numbers in a full leaderboard come later;
what ships now is the credible frame and the means to reproduce it.
