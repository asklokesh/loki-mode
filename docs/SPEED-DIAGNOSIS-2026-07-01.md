# Loki Build Speed Diagnosis (2026-07-01)

Measured from real build telemetry (anonima `.loki/events.jsonl`, stage_complete +
iteration timeline), NOT from reading run.sh. Method per advisor: measure before optimizing.

## Data hygiene
anonima's events.jsonl contained **9 interleaved builds/sessions** (9 session_starts) plus
session-long manual poking. Naive sums ("5 min/iter x 14") are contaminated. Split on
session_start and analyzed the real ones.

## The pathological build (session 3): the smoking gun
A simple topic-based chat app. 14 ACT iterations, ~97 min of real work (idle gaps excluded).

| iteration | real work |
|---|---|
| 1 | 2.1 min |
| 6 | 9.9 min |
| 10 | 15.3 min |
| 12 | **29.6 min** |
| (others) | 3-6 min each |

**13 completion claims across 14 iterations.** The FIRST claim already stated:
"All PRD requirements implemented and tests passing. Evidence: npm test => 19/19 pass...
PRD checklist (14 items) fully implemented." Yet the loop ran 13 more iterations.

## Root cause: NON-CONVERGENCE, not per-stage slowness
- **Code review / 3-reviewer council is NOT the bottleneck** (0.1-2.8 min per iteration,
  mostly <1 min). Cutting the council would harm accuracy for ~no speed gain. Ruled out.
- **The bottleneck is iteration COUNT + a few pathological iterations.** The app was
  essentially done early (real passing tests, checklist complete) but the RARV loop's
  "there is NEVER a finished state -- always find the next improvement" behavior kept it
  grinding polish iterations. For a user who wants a fullstack app fast, this is THE
  frustration: loki keeps going after done.
- iter 10 (15 min) and iter 12 (30 min) did disproportionate work -- candidate over-scoping
  or re-analysis; needs per-iteration content inspection.

## Buckets (advisor framework)
1. **WASTE (cut freely):** polish iterations after genuine completion; the PRD-reuse
   spurious-update re-reconciliation (already diagnosed, design fix pending). These add
   wall-clock with no trust value.
2. **VERIFICATION COST (keep -- this is the product):** council, gates, completion vote.
   Fast already. The moat. Do NOT cut for speed.
3. **STALE SCAFFOLDING (test per-stage):** machinery built for weaker models may be dead
   weight on Opus 4.8 / Sonnet 5 (cf. Anthropic's "context resets became dead weight on
   Opus 4.5"). Hypothesis -- must be tested against the benchmark, not assumed.

## The fix direction (speed AND accuracy, never speed-by-cutting-verification)
**Convergence:** stop as soon as the completion council genuinely agrees it is done
(honest verified completion), instead of running "next improvement" iterations. This is a
SPEED win that INCREASES trust alignment (stop when verified-done = the moat working), not a
verification cut. The user's mandate is "accuracy AND speed"; convergence delivers both.

## HARD PREREQUISITE (before any council/RARV-C change): the benchmark
Both the speed directive and the "update council/RARV-C to latest research, show before/after
accuracy" directive require a **clean reproducible benchmark on a fixed spec** emitting
wall-clock + iteration count + completion verdict + pass/fail vs known acceptance criteria.
Without it, changing the verification core is unmeasurable churn on the moat (architecture-
level fake-green). Build the benchmark FIRST, capture before-numbers, fix the clearest waste
(convergence), re-run, show real before->after. Then gate any council/RARV-C change on that
benchmark, one named change at a time, kept only if accuracy goes up and wall-clock does not
regress.

## MEASURED before/after (2026-07-01, same greet-CLI spec, isolated, council+gates ON)

| metric | before v7.104.1 (no fix) | after v7.105.0 (convergence fix) |
|---|---|---|
| wall clock | 28.6 min | 7.4 min |
| ACT iterations | 13 | 1 |
| completion claims | 11 | 1 |
| engine_completed | true | true |
| greet.js built correctly | yes | yes |

First after-run: 3.9x faster (-74% wall clock), 13->1 iterations, SAME correct output (accuracy
preserved -- not speed-by-cutting-verification; the council still approved).

HONEST CAVEATS (do not overclaim): (1) n=1 per side; LLM builds are stochastic, so a single
1-iteration after-run could be a low draw. Running 2-3 more after-runs for a real range before
presenting a headline multiplier. (2) before=v7.104.1 vs after=v7.105.0 differ by 7 commits;
convergence is the only one plausibly affecting iteration count, so it is the likely driver, but
the clean claim is "v7.105.0 vs v7.104.1 on this spec", not "convergence alone". (3) this is one
trivial spec; larger specs may show a smaller relative gain.

## UPDATE: after-run consistency (2 of 3 repeats in; n>1)
- after #1: 7.4 min, 1 iteration, correct
- after #2: 7.0 min, 1 iteration, correct
Both after-runs converged at 1 ACT iteration / ~7 min / correct output -- consistent, NOT a
single lucky draw. The convergence fix reliably stops at verified-done. Avg ~7.2 min vs 28.6 min
before = ~4x faster, 13x fewer iterations, accuracy preserved (council still approves). The
residual ~7 min is the single build+verify iteration's real inference cost (the honest floor for
this spec WITH verified-completion). Next speed lever: per-iteration cost on larger specs (the
fat-iteration investigation), measured via this same benchmark.
