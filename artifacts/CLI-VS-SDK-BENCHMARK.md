# CLI (legacy) vs SDK: benchmark results

Measured this session on `feature/v8-agent-sdk`. Two instruments, because they
answer two different questions. Nothing here is estimated; every number is from a
real run.

## 1. Efficiency (the isolated judge-path number)

A direct judge-call micro-benchmark: the SAME prompt through the CLI path
(`claude -p --output-format json`) vs the SDK path (`judgeText` via the raw
Anthropic SDK, OAuth-authenticated), 8 trials each, haiku, 1 warmup excluded.

| Metric | CLI (`claude -p`) | SDK (`judgeText`) |
|---|---|---|
| latency min / median / max (ms) | 2416 / **2971** / 7130 | 713 / **874** / 1189 |
| failures | 0/8 | 0/8 |

**SDK judge call is 3.4x faster (median).** The ranges do not overlap at all
(SDK max 1189ms < CLI min 2416ms) -> a real signal, not variance. Mechanism:
`claude -p` spawns a full CLI subprocess per call (Node startup + config + MCP
init); the SDK is a direct in-process HTTPS request, and it avoids the CLI's fat
latency tail (one CLI call hit 7130ms). This is exactly the path v8's SDK route
replaces, so it is the number that matters for the v8 thesis.

## 2. End-to-end parity (the full build corpus)

The discriminator corpus (simple + hard + multi-failure + token-heavy), 3 trials
per task per arm = 24 real `loki start` builds, graded by a HELD-OUT acceptance
command (exit 0), never self-judged.

| Task | cost (CLI vs SDK) | duration | correctness | verdict |
|---|---|---|---|---|
| fizzbuzz | overlap | overlap | 3/3 = 3/3 | within noise, parity |
| multifail | overlap | overlap | 2/3 = 2/3 | within noise, parity |
| hard | overlap | overlap | 3/3 vs 2/3 | within noise, parity |
| tokenheavy | overlap | overlap | 3/3 = 3/3 | within noise, parity |

**On every task, every cost/duration/iteration metric OVERLAPS between the CLI
and SDK arms** -- the delta is within build-output run-to-run variance, NOT a
CLI-vs-SDK effect. Correctness is at parity (the pass-rate differences are build
non-determinism, identical in kind for both arms). So turning on SDK judges does
NOT regress end-to-end build cost, speed, or quality.

## Why two instruments

The full-build corpus CANNOT isolate the judge-path efficiency: build-output
token variance (2x run-to-run) swamps any judge-call difference, so it reads as
"within noise". It is the right tool for the PARITY question ("does SDK regress
the build?"), not the EFFICIENCY question ("is an SDK judge faster?"). The
micro-bench isolates the latter directly.

## Honest bottom line

- SDK judge calls are measurably faster (3.4x on the judge path).
- Turning SDK judges on does not change end-to-end build cost/speed/quality
  (within noise, parity).
- These are `judges`-mode numbers (judge sites on the SDK, build loop still on the
  CLI). `full` mode (loop on the SDK too) is a heavier, separate measurement not
  run here.

## A real bug this benchmark surfaced (fixed, committed b5fa4eda)

Across the 24 builds, the SAME spec was judged "internally contradictory" ~1/3 of
runs -- a flaky single-LLM-sample verdict that tripped a no-retry terminal exit
(exit 20) before any build. Fixed with a confidence gate (require the
contradiction to reproduce across N samples before terminal-failing), a
learn-forward failure-history, and failure observability. See the commit.

Method notes: results in `scratchpad/bench-full/`; grader is held-out `exit==0`;
trials each run in a fresh mktemp fixture copy (independent samples). ~$20 spend.
