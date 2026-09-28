# Metrics

Latest measured value for each metric, with n, cost, date and the command that
produced it. "Not measured" is a real value here: nothing is estimated.

## Adoption

| Metric | Value | n / window | Date | Command |
|---|---|---|---|---|
| npm downloads, last 30 days | 12,194 | 2026-08-25..2026-09-23 | 2026-09-25 | `curl -s https://api.npmjs.org/downloads/point/last-month/loki-mode` |
| npm downloads, last 7 days | 838 (about 120/day) | 2026-09-17..2026-09-23 | 2026-09-25 | `curl -s https://api.npmjs.org/downloads/point/last-week/loki-mode` |
| Organic floor (days with no release) | about 94/day | from strategy doc | 2026-09-25 | `docs/STRATEGY-2026-2028.md:9` (re-measure with the adoption eval) |
| GitHub stars / forks | 1,073 / 206 | - | 2026-09-25 | `gh api repos/asklokesh/loki-mode --jq '{stars:.stargazers_count,forks:.forks_count}'` |
| Time to first sealed PR | not measured | - | - | adoption eval (M0, not built) |
| Decisions asked of the user | not measured | - | - | adoption eval (M0, not built) |

## Factory (M0 baselines, none measured yet)

| Metric | top | floor | routed | raw Claude Code | raw Codex |
|---|---|---|---|---|---|
| Seal rate | - | - | - | n/a | n/a |
| Verified-correct rate (hidden tests) | - | - | - | - | - |
| Cost per sealed change | - | - | - | - | - |
| Time to sealed PR, one item | - | - | - | - | - |
| Human touches per change | - | - | - | - | - |

## Seal accuracy

| Metric | Target | Required n | Current n | Value |
|---|---|---|---|---|
| False-SEALED (wrong pass) | at most 1%, 95% upper bound at most 3% | about 100 seeded defects with 0 wrong passes (rule of three) | 0 | not measured |
| False-NOT-SEALED (wrong fail) | at most 5% | - | 0 | not measured |

## Verification latency

| Metric | Target | Value |
|---|---|---|
| `loki verify --fast` p95, diff scope | under 1s | not measured in v10 terms |
| Full Seal overhead beyond project tests | at most 60s median | not measured |

## Moat suite

| Property | Status | Command |
|---|---|---|
| all 9 | 2 of 9 proven (P6, P7); 58 cases registered, 19 pending, ratchet checked against v9.52.0/v9.53.0/v9.54.0 (2026-09-26, main post-v9.54.2) | `bash tests/moat/run.sh` |
| history | v9.54.2/v9.54.1 (v9.54.1 never published, see PROGRESS.md): 1 of 9 (P6) | - |
| history | v9.54.0: 1 of 9, 55 cases, 32 pass, 23 pending | - |
| history | v9.53.0: 1 of 9, 48 cases, 25 pass, 23 pending | - |
| history | v9.52.0: 0 of 9, 45 cases, 21 pass, 24 pending | - |
| runtime | about 15s locally (9 scripts in parallel), about 1m15s CI job | `time bash tests/moat/run.sh` |

## Swarm (docs/v10/SWARM.md), hourly rollup

Founder-mandated cadence: releases in the last 24h, active builders, ready
slices, slices waiting on review, median ready-to-npm. Real, measured
numbers only; "not measured" stays honest where the swarm hasn't built the
instrumentation for it yet.

| Time (ET) | Releases (24h) | Active builders | Ready slices | Awaiting review | Median ready-to-npm |
|---|---|---|---|---|---|
| 2026-09-26 16:52 | 2 (v9.54.1 unpublished due to a pre-existing gitleaks false positive, D-something; v9.54.2 at 13:43 ET) | 8 (S-04,05,07,08,09,11,13,14) + 5 rework/review-cycle agents (S-03, S-15, PF-2, PF-3 round 6) | 8 (S-17..S-24, cut this hour) | 9 rows on BOARD.md in review/review-blocked/review-pending (PF-1 row stale-approved, PF-2, PF-3, S-03, S-15, plus historical GF rows) | not measured (no per-slice ready timestamp captured yet; first real median once S-04..S-14's merge times are recorded) |

**Why only 2 releases in ~4h, against the 30-60/day target:** v9.54.1's
required-ci failure (a pre-existing test fixture gitleaks flagged,
unrelated to its own diff) cost a full release cycle to diagnose before
v9.54.2 shipped; the bulk of wall-clock since has gone into a 6-round HIGH-
tier review saga on PF-3 (the kill-by-name repo sweep), which found and
fixed FOUR real defects across those rounds (a vacuous identity check, a
verify.sh regression on GNU-timeout daemons, three more unscoped kill sites
in test infrastructure, a setsid orphaning gap, and a port-arithmetic
overflow in the round-5 fix's own test) -- each one a genuine finding worth
the round, but the serial single-reviewer-cycle-at-a-time pattern this
session fell into is not the pipelined, many-slices-in-flight model
SWARM.md describes. Corrected per the founder's 16:35 nudge: 8 builders
dispatched on every ready S-slice at once, 8 more slices cut immediately
behind them, PF-2 and S-15 pulled off the backlog of un-reviewed finished
work. LOW/MEDIUM slices release individually the moment their tier's
reviewers approve, never queued behind PF-3/GF-1.

| 2026-09-26 17:35 | 0 new npm releases this hour (7 merges to main, no VERSION bump cut yet) | 8 (S-10 review, S-19 review x2, S-14 review x2, GF-3 rebase-review, S-21..S-24 build x4 -- corrected count after fixing a quorum bug, see below) | 4 (S-21..S-24, cut and dispatched this hour) | S-05 (review-blocked, sent back), S-07 (review-blocked, sent back), S-13 (rejected, sent back), S-09 (in review), S-10 (in review), GF-3/GF-4 (blocked/in review) | not measured |

**7 merges landed this hour: PF-3, S-11, PF-2 (round 5, ends a 5-round
whack-a-mole), S-08, S-04, GF-2 (rebased past 3 other merges with 4
conflicts resolved), plus a Captain-authored fix to `scripts/local-ci.sh`'s
twin of the S-04 bug.** Moat went from 2 of 9 to 3 of 9 proven (P5 added).
No release cut yet this hour because none of these individually crosses
the release-worthy bar alone and the swarm process batches a VERSION bump
at the Captain's discretion, not per-merge -- worth revisiting per the
founder's explicit "never batch approved LOW/MEDIUM behind other work"
directive; the next action after this rollup is cutting a release.

**A quorum bug was caught and fixed before any harm:** 5 reviews (S-04,
05, 07, 08, 13) were dispatched without a pinned `model` parameter,
silently inheriting the session model instead of being pinned per D13,
and MEDIUM slices got 1 reviewer instead of SWARM.md's required 2. Caught
by the advisor before any verdict was acted on; all 5 stopped via
TaskStop before returning results, re-dispatched correctly. The
re-dispatch then found 2 REJECT (S-13: a self-referential test bug plus
an incomplete PATH-scrub helper) and 2 CONCERN (S-05: a cross-file break
in receipt-attest.py; S-07: a factually wrong D20 decision draft that
would have documented a second copy of the same bug as "already safe"
when it demonstrably isn't) -- both sent back to their builders rather
than merged. This is the review process working as intended: catching
real defects and one bad internal decision-record draft before they
reached main.

**PF-2's 5-round whack-a-mole ended by fixing the review's own scoping
rule, not the code further:** round 5's diff was the same kind of
incremental patch as rounds 1-4, but this round's review classified every
finding as either "introduced by this diff" (blocking) or "pre-existing
gap this diff doesn't worsen" (a new slice, never a veto). Unanimous 4/4
APPROVE resulted, and 10 real follow-up bypass shapes were captured as
BACKLOG 125 instead of blocking a strict improvement. Generalizes: D12's
unanimous-approval bar must be checked against "is this diff a strict
improvement," never "is this artifact perfect" -- the latter is
unsatisfiable for any heuristic scanner and produces an infinite review
loop.

**GF-4 found genuinely BLOCKED, not just rejected:** its reviewer
independently reproduced S-19's claim (a documented model spelling
silently mis-resolves under GF-4's own catalog) and identified a real
ratchet-ordering deadlock: GF-4 cannot promote `P4.three-setups-resolve`
out of pending.txt until S-19's stricter pass bar is also in the tree, or
the merge itself becomes a ratchet regression. S-19 promoted to the
critical path and reviewed immediately.

## Usage (hourly, from scripts/usage-governor.py)

## CI: Tests workflow shell-tests sharding (S-81, supersedes S-70)

S-70 resharded shell-tests 4 -> 8 with a plain `idx % n` split and measured
the real per-suite cost of doing so (see its commit, c6000cb9). S-81 keeps
n=8 but replaces the index split with a deterministic greedy longest-first
(LPT) bin-packing over measured per-suite durations, so the 8 shards are
balanced by real cost instead of by coincidence of registration order.

BEFORE numbers are measured from a real completed GitHub Actions run. AFTER
numbers are **projected from measured per-suite durations**, not measured --
this sandbox cannot trigger a real push, so nothing below claims to be a live
CI wall clock for the new packing until a real run confirms it.

| Metric | Value | Method |
|---|---|---|
| BEFORE: measured per-suite durations, source | real run 36319020918 (2026-09-27), 4 shard job logs, S-44's START/END lines | `gh run view --job <id> --log`, grepped for `END: ` |
| BEFORE: suites with a real measured row | 496 of 496 registered suites (100%; no suite needed the default) | exact-name join against `tests/run-all-tests.sh`'s `run_test` registrations |
| Deliberate override, not a measurement | `test-ci-json-argmax.sh` measured 1186s in that run; a parallel BACKLOG 25 slice is shrinking its fixture, so `tests/shard-durations.tsv` assumes ~60s post-fix and uses 60, not 1186 | documented in the table's own header comment |
| BEFORE (projected from measured per-suite durations): max shard at n=4, plain `idx % 4` (current main, pre-S-70/S-81) | 451s test-time (~7.5min) | `idx % 4` replay against `tests/shard-durations.tsv`'s same measured rows (single source run, n=1) |
| BEFORE (projected from measured per-suite durations): max shard at n=8, plain `idx % 8` (S-70's scheme) | 346s test-time (~5.8min) | same replay, `idx % 8` -- matches S-70's own commit projection (c6000cb9) of "~346s (~5.8min)" once argmax is fixed, cross-checked independently here |
| AFTER (projected from measured per-suite durations): max shard at n=8, LPT-packed (S-81, this change) | 197s test-time (~3.3min) -- every shard lands at exactly 197s, because 1576s total / 8 divides evenly against this suite set | replay of the actual `tests/run-all-tests.sh` LPT logic via `LOKI_TEST_SHARD=i/8 LOKI_TEST_LIST=1`, summed against `tests/shard-durations.tsv` |
| AFTER (projected from measured per-suite durations): max shard including ~29s job setup (checkout/pip/npm/bun, per S-70's measurement) | about 226s (about 3.8min), under the 6-minute target | same table + S-70's measured setup overhead |
| Named suites land in 5 distinct shards (required) | trust-core-detect -> shard 1, review-assurance-tail -> shard 0, e2e-features -> shard 4, shellcheck -> shard 2, no-unreachable -> shard 3 | same LPT replay |
| Partition proof | `tests/test-shard-coverage.sh`: n in [2, 3, 4, 6, 8] each give union=496, 0 duplicates, 0 missing, no empty shard -- driven through the real runtime path (`LOKI_TEST_LIST=1`), not a second copy of the packing algorithm | `bash tests/test-shard-coverage.sh` |

**What still needs real-CI verification** (cannot be done from this sandbox):
an actual GitHub Actions run of the updated `test.yml` at n=8 with the new
packing, to confirm the real wall clock lands near the ~3.8min projection
rather than something job-setup variance or GitHub's own queueing missed, and
that `test-ci-json-argmax.sh` actually lands near 60s once its BACKLOG 25
fixture fix ships (until then this table's 60s row is an assumption, not a
measurement, as stated in `tests/shard-durations.tsv`'s own header).

## Tier A selector: last 10 non-docs commits (S-96, S-91 remainder)

`scripts/select-tests.sh --base <SHA>^ --head <SHA>` (selection only, no
`--run`), against the last 10 non-merge commits on main whose diff touches
something outside `docs/v10` (`git log --no-merges -- . ':!docs/v10'`).
Selector time is real wall clock (`/usr/bin/time -p`) for the selection step
alone, measured in this worktree, one commit at a time. "Selected tests" for
an R0 row is the whole `tests/run-all-tests.sh` suite (R0 means "run
everything"), not a count of individual suites.

| SHA | Rule(s) fired | Selected tests | Selector time |
|---|---|---|---|
| cc105687 | R1, R3 | 7 | 6.62s |
| a4eb09d7 | R1, R3 | 7 | 6.24s |
| a1ca3c7b | R0 | ALL (full suite, matched VERSION) | 0.04s |
| 8009b193 | R3 | 2 | 6.98s |
| 878f79e7 | R1, R3, R6 | 25 | 14.34s |
| a537bb22 | R1, R3 | 7 | 7.24s |
| 298f027e | R1, R6 | 3 | 0.04s |
| 11c302bf | R0 | ALL (full suite, matched loki-ts/dist/loki.js) | 0.05s |
| 03d5b515 | R0 | ALL (full suite, matched loki-ts/package.json) | 0.04s |
| ea8ecf1c | R3 | 2 | 7.02s |

All 10 land under 120s (the 3 R0 rows are the declared exception to the
2-minute Tier A target and are labeled ALL rather than timed against it, per
the green criterion in BOARD.md S-96).

### tier-a.yml install caches (S-96)

Added `pip` (setup-python `cache: pip`) and `npm` (new `setup-node@v4`,
`cache: npm`) install caches to the `select-and-run` job; `oven-sh/setup-bun`
was already caching bun installs by default (no `no-cache: true` set).
`tests/moat/p9-rule-of-two.sh`'s cache-channel rule
(P9.issue-workflows-separate-untrusted-from-push) bans an Actions cache only
on a unit holding write permissions or secrets; `select-and-run` holds
neither (`permissions: contents: read` at the workflow level, no
job-level override, no `secrets.*` reference), so this is a negative-control
case, verified both ways:

| Check | Result |
|---|---|
| P9 green before the change | `bash tests/moat/p9-rule-of-two.sh` -> all 4 cases PASS, exit 0 |
| P9 green after adding the 3 caches | `bash tests/moat/p9-rule-of-two.sh` -> all 4 cases PASS, exit 0; `SITE tier-a.yml:select-and-run ... verdict=ok` |
| Mutation (`contents: read` -> `contents: write`) | `bash tests/moat/p9-rule-of-two.sh` -> `CASE P9.issue-workflows-separate-untrusted-from-push FAIL ... holds write permissions and restores actions/setup-python cache: pip, oven-sh/setup-bun ..., actions/setup-node cache: npm` (the guard names exactly the 3 caches added here) |
| Mutation reverted | `bash tests/moat/p9-rule-of-two.sh` -> all 4 cases PASS, exit 0 again |

Rework (post-review): an earlier draft of this commit added an explicit
`timeout-minutes: 20` on the "Run selected suites" step (where the R0
full-suite path executes). Review found this false-budgeted: this repo's own
measured data (test.yml, scripts/local-ci.sh, CLAUDE.md) converges on
~24-27 minutes for `tests/run-all-tests.sh` run serially, so a 20-minute step
cap was tighter than even the existing 25-minute job-level ceiling, not a
looser purpose-built budget as the commit claimed, and was never checked
against a real R0 `--run`. Removed; the job-level `timeout-minutes: 25`
remains the only cap on this step. Guarded by
`tests/test-tier-a-r0-timeout-budget.sh` (S-96 rework).

## Over-budget stops

- 2026-09-27T21:33Z: batch 8 workflow wf_ff8d537c-40e stopped. Its last two reviewers (S-191, S-195) ran about 55 minutes against the 30-minute reviewer budget with no verdict (pulse AGENT_OVER_BUDGET at 21:31Z: "S-191 building MEDIUM (55.9 min, budget 30 min)"). Re-dispatched as two standalone reviewers with 20 and 25 minute scopes. Load average was 15 to 17 during the stall.

## Loki 10 eval: first real arm numbers (2026-09-27, smoke, not the gate)

Raw `claude -p` arm (EV-4), model claude-opus-5-5, 900s cap, 3 public tasks, harness from the EV-1 branch with EV-3 isolation (auth via keychain access token; no credential in any result file):

| task | completed | time to PR | cost (provider-reported) |
|---|---|---|---|
| pub-more-itertools-1192 | yes | 20s | $0.1266 |
| pub-click-2877 | yes | 34s | $0.1861 |
| pub-humanize-152 | yes | 45s | $0.2704 |

`summarize --markdown`: 3/3 completed, p50 34s, p90 45s, $0.1944 per completed task, 0 capped. This is a 3-task smoke, not the 29-task gate. It sets the bar the v10 fast lane must meet on completion and cost per completed task (D29), which is far tighter than the 5-minute p50 target.

## Loki 10 eval: raw claude -p arm, full 29 tasks (2026-09-27 23:05-23:16Z)

Model claude-opus-5-5, harness 84c22568, 900s cap, --parallel 3, EV-3 isolation. Results: ~/loki-ci-logs/eval-raw-claude-20260927T231653Z/.

| Arm | Completed | Rate | p50 time to PR | p90 time to PR | Cost per completed | Cost measured | Capped |
|---|---|---|---|---|---|---|---|
| raw-claude | 27/29 | 93.1% | 39s | 68s | $0.2363 | 29/29 | 0 |

Misses: pub-click-3059 (hidden tests failed: wrong metavar bracketing), pub-humanize-174 (hidden tests failed: rounding boundary cases). Total provider-reported spend $6.38.

## Loki 10 engine: first real run (E-14 smoke, not the gate)

pub-more-itertools-1192 through the E-14 glue entry, real claude, --no-pr: 30s wall (intake 0s, plan 16s, implement 12s, verify 3s, commit and seal under 1s), hidden test passes, $0.4486 over 2 sessions (plan $0.2264, implement $0.2223), verdict PARTIAL only because ruff is not installed. Raw claude on the same task: 15s, $0.1290. The planner session costs as much as the implement session.

## Loki 10 gate report, small tier (2026-09-28, D30; v10.0.0 decision)

All arms on claude-opus-5-5, 29 small tasks with hidden tests, fresh clone per run, provider-sourced cost only. D30 targets vs raw: completion 96.5% or higher, cost per completed task $0.118 or lower, time to a correct result at most raw.

| arm | completed | cost per completed | p50 / p90 time to PR | source |
|---|---|---|---|---|
| raw `claude -p` | 27/29 (93.1%) | $0.2363 | 39s / 68s | ~/loki-ci-logs/eval-raw-claude-20260927T231653Z/results.jsonl |
| legacy (global loki v9.78.0) | 15/29 (51.7%); hidden tests pass 26/29, no PR opened | not measured (0/29 provider-sourced) | 190s / 441s | ~/loki-ci-logs/ev5-legacy/results.jsonl |
| v10 default knobs (main 8b76fd9a: E-45 cost path, E-65 lean sessions) | 26/29 (89.7%) | $0.3946 (2 runs unmeasured) | 85.5s / 133s | ~/loki-ci-logs/ev9-v10-small/results.jsonl |
| v10 lean configuration, not the default (same build, LOKI_E10_PLAN=0 LOKI_E10_WALL=0) | 27/29 (93.1%) | $0.1616 (1 run unmeasured) | 40s / 67s | ~/loki-ci-logs/ev9-v10-small-lean/results.jsonl |

- v10 misses: aiq-52-searchbar (the feature already exists; the no-change outcome is E-66/EV-13, in rework), pub-click-3059, pub-humanize-174 (raw missed the same two pub tasks).
- Gate: NOT MET on any axis for the default configuration. Default stays legacy; v10 ships opt-in (LOKI_ENGINE=v10).
- Lean configuration misses: aiq-52-searchbar, pub-humanize-174. It matches raw on completion and time and is 32% cheaper; it does not meet the 2x targets and is not the default until E-64 lands and is re-measured.
- Lean-session evidence, 5 tasks (EV-8 D/E, not the full arm): opus lean 4/5 at $0.1571 per completed, p50 28s; sonnet lean 4/5 at $0.1519, p50 27.5s; raw opus on the same 5: 5/5, $0.2161, p50 41s (~/loki-ci-logs/ev8r-{D,E}/results.jsonl). The lean small path is not the default yet (E-64 in rework).
- Medium and large tiers: not built (EV-11 3 of 15 verified, EV-12 in rework). No "2-5x" claim.

## Loki 10 gate report, medium tier (upstream tests, deletion-mutant audited, not shortcut audited) (2026-09-28, D38; EV-14)

Evidence note (Chief of Staff, 18:00Z): the per-run result files (eval/loki10/results/ev14-medium-{raw,v10}-r{1,2}/results.jsonl, gitignored) were lost when the EV-14 worktree was force-removed in the 17:36Z pruning incident (PROGRESS.md, E-96). The table below is the run agent's report from those files before removal (commit 0afef9e4); it cannot be re-audited. EV-15 re-runs the tier with results kept outside any worktree.

D38 permits the flip decision on small plus medium; medium is explicitly "not
shortcut audited" (no requirements map, no independent shortcut-attempt
review, unlike the large tier's D38 criteria). All 7 medium tasks (`pub-*`
with `"tier": "medium"`) carry upstream-verbatim hidden tests with at least
one deletion-mutant check recorded in their `NOTES.md` (see
`eval/loki10/tasks/pub-attrs-1313/NOTES.md` for one worked example). Both
arms on claude-opus-5-5 (same model as the small-tier gate), harness
8f2179cdea1544f855eca0ec4c8a18b525cad152 (origin/main, not dirty), fresh
clone per run, provider-sourced cost only, 2 runs per arm, `--parallel 3`,
900s cap per task. `loki-ts/node_modules` reinstalled from `bun.lock`
(`bun install --frozen-lockfile`) before the v10 runs per E-62.

| arm | completed | rate | cost per completed | p50 / p90 time to PR | arm_unavailable | invalid |
|---|---|---|---|---|---|---|
| raw `claude -p` | 12/14 | 85.7% | $0.5119 | 70s / 239s | 0 | 0 |
| v10 (default knobs, main 8f2179cd) | 10/14 | 71.4% | $0.5395 | 83s / 100s | 0 | 0 |

Per-run breakdown (`eval/loki10/summarize <file> --markdown`, all under
`eval/loki10/results/`, the harness's normal `--out` location; none of these
are committed, see below):

| run | file | completed | cost per completed | p50 / p90 |
|---|---|---|---|---|
| raw r1 | `eval/loki10/results/ev14-medium-raw-r1/results.jsonl` | 5/7 | $0.6194 | 102s / 149s |
| raw r2 | `eval/loki10/results/ev14-medium-raw-r2/results.jsonl` | 7/7 | $0.4352 | 69s / 256s |
| v10 r1 | `eval/loki10/results/ev14-medium-v10-r1/results.jsonl` | 5/7 | $0.5702 | 83s / 121s |
| v10 r2 | `eval/loki10/results/ev14-medium-v10-r2/results.jsonl` | 5/7 | $0.5088 | 98s / 100s |

The pooled row is not something `summarize` can produce directly: it dedupes
to the newest row per `(task, arm)`, which would silently drop one of the two
runs per task. The pooled numbers were computed by hand over the 14
concatenated rows per arm (both runs, un-deduped), reimplementing
`summarize`'s own rules: completion rate over evaluated runs; cost per
completed = total `cost_usd` of every evaluated run in the pool divided by
the number completed (this is "evaluated", not "completed only" -- confirmed
by reproducing raw r1's own $0.6194 figure by hand); p50/p90 by nearest-rank
over completed runs' `time_to_pr_s`. The pooling script reproduced all four
single-run files' own `summarize --markdown` numbers exactly (completed
count, cost per completed, p50 and p90) before its pooled output was
trusted. All 28 task-runs (7 tasks x 2 arms x 2 runs) came back
`status: ok`; none were `arm_unavailable`, `auth_unavailable`,
`harness_error` or `task_invalid`.

Misses: raw-claude missed `pub-faker-1817` and `pub-werkzeug-3271` (both
hidden-test failures, r1 only; r2 was 7/7). v10 missed `pub-werkzeug-3105`
and `pub-werkzeug-3271` in both runs (hidden-test failures both times).

Verdict per axis, v10 vs raw on this tier:
- Completions: v10 is WORSE (71.4% vs 85.7%; 10/14 vs 12/14).
- Cost per completed task: v10 is WORSE (higher; $0.5395 vs $0.5119, about
  5.4% more expensive).
- p50 time to PR: v10 is WORSE (slower; 83s vs 70s, about 19% slower). v10's
  p90 (100s) beats raw's p90 (239s, `pub-werkzeug-3271`); raw's single
  slowest run was `pub-werkzeug-3105` r2 at 256s, rank 12 of 12, past the p90
  cutoff so it does not set the p90 value. Neither changes the p50 verdict.

v10 is not at or better than raw on any of the three axes on this tier. This
does not by itself change the small-tier default decision (D30: default
stays legacy, v10 opt-in); it is additional evidence for whoever rules on the
flip under D38's small-plus-medium scope.

No result file was committed: `eval/loki10/.gitignore` ignores the whole
`results/` directory (the README also warns to treat `--out` as sensitive,
since `arm_stdout.log` can hold env), so there are no harness result files
tracked in git to commit, matching every earlier EV entry in this file. Only
this METRICS.md section is committed. The raw result files above remain on
disk in this worktree at `eval/loki10/results/ev14-medium-{raw,v10}-r{1,2}/`.
