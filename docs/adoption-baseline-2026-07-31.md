# Adoption baseline, 2026-07-31

The first numbers in this project taken from the registry rather than from
intuition. Recorded so the next measurement has something to compare against.

## What we actually have

**4,456 npm downloads in the last 7 days.** Daily:

| Day | Downloads |
|---|---|
| 07-24 | 863 |
| 07-25 | 1,160 |
| 07-26 | 196 |
| 07-27 | 94 |
| 07-28 | 386 |
| 07-29 | 494 |
| 07-30 | 1,263 |

Two things follow, and the second matters more than the first.

**1. We have users.** Roughly 4.5k downloads a week is not a project nobody
has heard of. Every strategy discussion in this repo has proceeded as though
adoption were hypothetical. It is not.

**2. The shape is release-driven, not organic.** The 13x swing between 07-27
(94) and 07-30 (1,263) tracks publishing activity -- eight releases landed on
07-30 alone. A curve that rises when we publish and falls when we stop is
mirrors and CI, not word of mouth. Organic growth would show a floor that
rises over time; this shows a floor near 94.

**Do not read 4,456 as 4,456 humans.** npm counts mirrors, CI, and Docker
layer pulls. The honest statement is that the ceiling is real and the floor is
what needs to move.

## Why the floor is the metric

The founder's goal is word-of-mouth growth over two years. The number that
measures it is the **trough**, not the peak: how many installs happen on a day
we publish nothing. Today that is ~94.

Peaks are bought with releases. Floors are earned by people telling other
people. Every adoption item should be judged against whether it moves the
floor.

## What we still cannot see, and what changed today

Until v8.6.0 shipped this morning, we could see that a first run was ATTEMPTED
and nothing about whether it succeeded. `first_run_blocked` (v8.6.0) now names
the class of dependency that stops a first run -- enum-clamped, once per
install, strict opt-in.

That data does not exist yet: the release is hours old and the telemetry is
off by default behind a second opt-in. It will accumulate slowly and from a
minority of users, which is the correct trade for not exfiltrating anyone's
environment.

So the sequence is: floor today ~94/day -> ship things that plausibly move it
-> watch the floor, not the peak.

## The three things measured this session that plausibly move it

Ranked by how directly they affect someone's first ten minutes:

1. **43 of 112 commands were unreachable from `loki help`**, including
   `loki proof` -- the Evidence Receipt, the thing the product argues on. Fixed
   and gated. A user who cannot find the differentiator does not repeat it to
   anyone.
2. **A first-run dead end on hosts with no provider CLI.** One route named the
   blockers and pointed at `loki tour` (no provider, no key, no spend); the
   other said "some required prerequisites are missing" and stopped. That is
   the exact moment an evaluator decides whether to continue.
3. **`loki proof md`** puts the receipt in a form a person can paste into a PR
   or a Slack message. Competitors' verification output lives in their
   dashboard; a file is the only artifact that travels.

None of these is proven to move the floor. They are the candidates with a
plausible mechanism, and the floor is now being watched.

## Reproduce

```sh
curl -s "https://api.npmjs.org/downloads/range/last-week/loki-mode"
```
