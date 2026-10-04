# C8: Public benchmark

## Problem
No standardized benchmark for Loki Mode. Claimed metrics (30-60 releases/day, 10x10 slice parallelization) lack published data:
- No baseline to compare against other systems
- No proof-of-function for customers
- Benchmark results not auditable or reproducible

## Current state
- Internal metrics in `docs/dev/METRICS.md` (not public)
- Release velocity measured via git log (post hoc)
- No standardized test suite for competitors
- No published SWE-bench score or equivalent

## Proposed v1 scope
- Benchmark suite: 50-100 representative tasks (swebench subset, internal tests)
- Auto-grade output against oracle (code compiles, tests pass, etc.)
- Publish results: tasks completed, time-to-first-try, cost per task
- CI run daily, publish results to website
- Competitor parity: run same suite on Cursor, Cline, Factory
- Result dataset: JSON with timestamps, model, cost, success

## Open questions
- Which benchmark? (swebench, humaneval, internal tasks, or custom?)
- Grade criteria: test pass only, or coverage, latency, cost?
- Frequency: daily, weekly, or per release?
- Competitor data: public (Cursor, Devin) or private agreement?

## Why deferred from 11.0.0
Benchmark design requires domain expertise. Cost per run unclear. Competitor data agreements needed. Scheduled 11.8 when v10.x is production-ready.
