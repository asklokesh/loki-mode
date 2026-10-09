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

### 2026-09-28T22:19Z
- 5h window: uncalibrated, 5,229,182 output tokens since 2026-09-28T17:19Z (uncalibrated)
- Weekly: uncalibrated, 48,901,928 output tokens, 42.7h to reset (uncalibrated)
- Last hour: 1,436,250 output tokens; 45 active engineers; 29,189 per engineer; Chief of Staff 124,829
- Max engineers next hour: uncalibrated (no plan reading on file)
- Output tokens by model (all scanned transcripts): claude-sonnet-5 31,903,763 (43.0%), claude-opus-5-5 16,991,251 (22.9%), claude-opus-4-8 14,720,953 (19.8%), claude-opus-4-7 4,678,300 (6.3%), claude-opus-5 4,489,139 (6.0%), claude-fable-5 1,254,167 (1.7%), claude-opus-4-6 203,492 (0.3%), claude-haiku-4-5-20251001 6,565 (0.0%)
- Output tokens by role (all scanned transcripts): workflow-agent 44,503,521, chief-of-staff 29,712,444, subagent 31,665

### 2026-09-28T21:15Z
- 5h window: uncalibrated, 5,183,443 output tokens since 2026-09-28T16:15Z (uncalibrated)
- Weekly: uncalibrated, 47,364,676 output tokens, 43.7h to reset (uncalibrated)
- Last hour: 477,429 output tokens; 17 active engineers; 24,479 per engineer; Chief of Staff 61,285
- Max engineers next hour: uncalibrated (no plan reading on file)
- Output tokens by model (all scanned transcripts): claude-sonnet-5 30,642,455 (42.1%), claude-opus-5-5 16,713,247 (23.0%), claude-opus-4-8 14,720,953 (20.2%), claude-opus-4-7 4,678,300 (6.4%), claude-opus-5 4,489,139 (6.2%), claude-fable-5 1,254,167 (1.7%), claude-opus-4-6 203,492 (0.3%), claude-haiku-4-5-20251001 6,565 (0.0%)
- Output tokens by role (all scanned transcripts): workflow-agent 43,102,887, chief-of-staff 29,573,766, subagent 31,665

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

## Loki 10 report on the gates, small tier (2026-09-28, D30; v10.0.0 decision)

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

## Loki 10 report on the gates, medium tier (upstream tests, deletion-mutant audited, not shortcut audited) (2026-09-28, D38; EV-14)

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

## Medium tier A/B (E-98f)

E-98f (2026-09-28, branch `slice-E-98f`, harness_sha
`3abb3ac6b5cdcb84467f247c56f15eba964b5b77-dirty`, v10.4.1, `claude-opus-5-5`,
the same 7 `pub-*` medium tasks, 900s cap, `--parallel 3`, fresh clone per
run) measured three knob arms at n=3 (21 task-runs each) against E-98a..e
merged: default knobs, `LOKI_E10_WALL=0` (nowall) and `LOKI_E10_CASCADE=0`
(nocascade, via a `LOKI_EVAL_LOKI_BIN` shim since that var is not in
`harness.py`'s `V10_ENGINE_ENV_ALLOWLIST`; see `docs/v10/MEDIUM-ANALYSIS.md`
"After (E-98f)" for the full method and the auth-lifecycle incident that
lost and required re-running every arm's r2). Raw was not re-run; both
prior raw measurements are carried forward. Dedupe rule: one row per (arm,
run-file, task), the latest `status: ok` attempt if one exists else the
latest attempt overall, never collapsing across the 3 reps (full rule and
per-arm rationale in MEDIUM-ANALYSIS.md). Rows dropped by this rule: 22
(default), 15 (nowall), 15 (nocascade), all superseded `auth_unavailable`/
`interrupted` attempts from the auth incident; each arm's pooled table below
has exactly 21 rows (7 tasks times 3 runs).

| source | arm | completed | rate | cost per completed | p50 / p90 |
|---|---|---|---|---|---|
| EV-14 | raw `claude -p` | 12/14 | 85.7% | $0.5119 | 70s / 239s |
| EV-15 | raw `claude -p` | 10/14 | 71.4% | $0.5085 | 56s / 104s |
| EV-15 | v10 default knobs | 9/14 | 64.3% | >= $0.788 (corrected lower bound) | 128s / 330s |
| E-98f | v10 default knobs | 15/21 | 71.4% | n/a (10/21 null-cost rows; lower bound $0.6958) | 209s / 457s |
| E-98f | v10 `LOKI_E10_WALL=0` | 16/21 | 76.2% | n/a (2/21 null-cost rows; lower bound $0.786) | 214s / 500s |
| E-98f | v10 `LOKI_E10_CASCADE=0` | 15/21 | 71.4% | n/a (11/21 null-cost rows; lower bound $0.3233, unreliable) | 138s / 218s |

Decision rule (founder, 2026-09-28): the chosen arm must complete at or
above EV-14's 85.7% and cost at or below EV-15's $0.5085 per completed. No
E-98f arm reaches 85.7% (nowall highest at 76.2%), and no arm's cost per
completed is a clean number (`n/a` in all three, see the null-cost note in
MEDIUM-ANALYSIS.md). No arm meets the rule; `sizing.ts` is unchanged.

## S41-04 Per-stage token table (before-measurement)

Reference for S41-09/S41-10/S41-11 to be judged against. Source: every
`result-cost-*.json` in `~/loki-ci-logs/eval/e98f-engine/{default,nocascade,nowall}-r{1,2,3}/*/.loki/metrics/`
(all 9 preserved E-98f run copies, no new eval spend). One row per task
instance (result-cost files with the same stage suffix inside one task's
`.loki` dir are summed first, e.g. two `fix1` rounds); mean/p50 taken across
those task instances. `verify` and `seal` are deterministic (no SDK call,
no result-cost file) so they have no token row.

| stage | n (task instances) | mean input | p50 input | mean cache_read | p50 cache_read | mean cache_write | p50 cache_write | mean output | p50 output |
|---|---|---|---|---|---|---|---|---|---|
| intake (`already-done`) | 18 | 6 | 4 | 46,305 | 29,937 | 8,742 | 8,399 | 590 | 495 |
| plan | 36 | 10 | 10 | 44,547 | 44,290 | 8,784 | 8,896 | 2,038 | 2,044 |
| wall | 16 | 7 | 6 | 67,611 | 55,318 | 14,512 | 15,098 | 5,530 | 5,735 |
| implement | 58 | 51 | 42 | 982,144 | 654,959 | 33,750 | 28,301 | 10,893 | 8,354 |
| fix (round 1) | 10 | 13 | 10 | 116,340 | 69,232 | 10,765 | 10,668 | 2,256 | 2,004 |
| fix (round 2) | 4 | 10 | 7 | 78,512 | 47,776 | 6,691 | 5,748 | 2,463 | 2,196 |
| verify | n/a | - | - | - | - | - | - | - | - |
| seal | n/a | - | - | - | - | - | - | - | - |

Cache-read share of every token summed across all rows above: 94.5%
(61,960,744 of 65,568,766 total tokens). This is a raw token-count share,
not the dollar-weighted "76% of spend" in D41 item 2 (`docs/v10/DECISIONS.md:326`);
cache reads price far below input/output tokens, so a lower spend share at a
higher token share is expected, not a contradiction.

First-turn prefix size (`first_turn_prompt_tokens`, added by S41-04's
`consumeSdkStream` change): **not measurable from these preserved runs** --
the field did not exist when E-98f ran, and only the final aggregated
`result-cost-*.json` and cumulative `partial-usage-*.json` files were kept
(no raw per-message stream-json), so it cannot be backfilled. It will start
populating in the next run made with this slice merged (e.g. S41-06's
baseline eval); no new eval was run here per the standing E-98f-only
instruction for this slice.

Command: `python3` one-off aggregation of the `result-cost-*.json` files
under `~/loki-ci-logs/eval/e98f-engine/*/*/.loki/metrics/`, grouped by the
stage suffix after `result-cost-e10-<ts>-<hash>-`.

## Stage wall-clock profile (S41-19)

Source: `docs/v10/DECISIONS.md` D43 item 3. `eval/loki10/stage-profile.py`
run over all 9 preserved E-98f engine copies
(`~/loki-ci-logs/eval/e98f-engine/{default,nocascade,nowall}-r{1,2,3}/*/.loki/
runs/*/events.jsonl`), 21 runs per arm, all 63 preserved runs counted (no
filter for completed/graded, unlike the pooled table above), no new eval
spend. Per-run total is `time_to_pr_s` from the matching harness row (the
`results.jsonl` next to each source `e98f-<arm>-r<n>` dir, deduped one row
per task with the rule in `docs/v10/MEDIUM-ANALYSIS.md` "After (E-98f)");
one nowall row has a null `time_to_pr_s` and falls back to the journal's own
run.completed-minus-run.started span. Per-stage seconds are self-time
(top-of-stack) attribution over each run's `stage.started`/`.completed`/
`.failed`/`.skipped` events, which nests correctly through cascade's plan/
wall overlap (wall opens before plan closes) and repeated fix/verify
rounds; mechanism, a worked synthetic example, and the same regression
covered by `--self-test` are in the script's module docstring and tests.

Journals have what the profile needs: every run has a run.started/
run.completed pair, every stage transition is covered by a start plus a
completed/failed/skipped event, and unattributed time (a run's own launch/
push-confirm overhead plus untracked gaps such as the post-seal
pr.opened/deep.started handoff) is only 0.2-1.0s p50 (0.1-0.5% of total) in
every arm. No missing event field is needed.

Share is aggregate: sum of a stage's seconds over sum of every run's total,
across the arm's 21 runs (`stage-profile.py`'s own column). It sums to
100% by construction, unlike a p50-over-p50 ratio (p50s of different
stages do not fall on the same run, so those ratios can tie or overshoot
100%; an earlier draft of this section used that ratio and wrongly read
wall and implement as tied in nocascade at p50 90.0s/88.2s -- the aggregate
share below, 29.0%/62.9%, does not tie).

| stage | default p50/p90 (s) | default share | nocascade p50/p90 (s) | nocascade share | nowall p50/p90 (s) | nowall share |
|---|---|---|---|---|---|---|
| intake | 0.1 / 11.2 | 1.3% | 0.1 / 9.8 | 1.4% | 0.1 / 6.7 | 1.2% |
| plan | 0.0 / 0.0 | 0.2% | 0.0 / 0.0 | 0.1% | 18.7 / 35.6 | 7.1% |
| wall | 73.6 / 90.0 | 23.0% | 90.0 / 90.0 | 29.0% | 0.0 / 0.0 | 0.0% |
| implement | 139.8 / 424.1 | 72.5% | 88.2 / 253.1 | 62.9% | 158.1 / 352.9 | 85.7% |
| verify | 1.7 / 5.3 | 0.8% | 1.5 / 4.3 | 0.9% | 1.7 / 5.4 | 1.1% |
| fix | 0.0 / 18.9 | 1.9% | 0.0 / 0.0 | 5.3% | 0.0 / 35.7 | 4.4% |
| seal + commit | 0.1 / 0.1 | 0.1% | 0.1 / 0.1 | 0.1% | 0.1 / 0.1 | 0.1% |
| unattributed | 1.0 / 1.7 | 0.4% | 0.9 / 1.6 | 0.4% | 0.8 / 1.7 | 0.4% |
| **total** | **209 / 483** | **100%** | **166 / 565** | **100%** | **199 / 357** | **100%** |

"plan" reads near-zero in the two wall-on arms (default, nocascade) not
because planning is free, but because "wall" opens before "plan" closes
(seen directly in the journals: e.g. pub-werkzeug-3271/default-r1, plan
starts and wall starts within 4ms of each other, plan closes 24.96s later
while wall is still running) and self-time attribution charges the overlap
to whichever stage is innermost on the stack (wall). This overlap happens
in both wall-on arms regardless of the cascade knob; it is wall racing
plan, not cascade. nowall's runs, with no wall racing it, show plan's real
cost (18.7s p50). "fix" is 0 at p50 in every arm (most runs need no fix
round) but reaches 18.9-35.7s at p90 when one or two rounds fire.

Slowest stage by aggregate share: **implement** in every arm (72.5%,
62.9%, 85.7%), and per the S41-04 token table above, the stage with by far
the largest token volume (mean cache_read 982K tokens, p50 654K, the most
of any stage).

**Wall meets D42 item 2's own revival bar.** That decision deferred S41-14
(skip implement straight past Wall) with an explicit condition: "It may be
revived only on new evidence that Wall is 15% or more of p50 wall-clock."
This profile is that evidence: wall's aggregate share is 23.0% (default)
and 29.0% (nocascade), both above 15%. Two more facts from the same
journals, not yet in any prior METRICS.md entry: (1) of the 21 wall-opened
runs per arm, wall hits its own timeout (`stage.failed` with
`data.reason=="limit"`, `limit_s`=90) in 9/21 default runs and 11/21
nocascade runs -- wall burns its full 90s budget with nothing to show for
it in roughly half of runs; (2) implement starts within 1ms of wall's
close in every run that has both (p50 and p90 gap 0.0-0.001s across 18
measured pairs per arm) -- wall is not waited-on after the fact, it is
directly on the critical path in front of implement. Whether to actually
revive S41-14 is a HIGH-tier call under D42 item 2's own invariant (Wall
files must stay sealed and proven red on the base tree before implement
exists), not decided here; this section only supplies the measurement that
triggers reconsidering it.

nowall's total p50 (199s) is 10s below default's (209s), the opposite
direction from the completed-only table above (214s vs 209s, nowall
higher); both are inside the noise D43 describes (raw swung 85.7% to
71.4% between two runs on the same 7 tasks), so neither ordering should be
read as a verdict on nowall by itself -- the wall evidence above is the
finding, not the nowall-vs-default total.

Largest unattributed chunk: the internal-gap component (untracked time
between a stage.completed for seal and the next tracked event, chiefly the
post-seal pr.opened/deep.started handoff) at about 0.75s p50 in every arm,
ahead of pre-launch (about 0.1s) and post-push (0.0-0.2s) overhead.
nocascade's post-push reads slightly negative (-0.02s p50): `harness.py`
truncates `time_to_pr_s` to whole seconds (`pushed_at - int(started)`, line
1177), so pre/post carry up to about 1s of rounding residue; only the
internal-gap component has millisecond precision. All three are small
relative to the named stages and do not change where the time goes.

Recommended cut: **wall**, on the strength of meeting D42 item 2's own
15%-of-p50 revival bar with direct evidence (23-29% aggregate share, half
of runs hitting its full timeout, zero wait-gap into implement) -- reopen
S41-14 for a HIGH-tier call rather than starting a new knob. Implement
remains the largest absolute-time consumer in every arm regardless of
wall's fate (72.5-85.7% aggregate share) and stays a second, independent
candidate: the S41-04 token-table evidence points at trimming per-turn
context / cache_read volume during implement, or reducing its turn count;
profiling implement's own internal turn-by-turn timing (not available from
`result-cost-*.json` alone) would be that slice's first step.

Command: `python3 eval/loki10/stage-profile.py
~/loki-ci-logs/eval/e98f-engine/{default,nocascade,nowall}-r{1,2,3}`

## D50 model-lift baseline (small tier)

Measured 2026-09-30 on main c5eaddb0 (harness_sha c5eaddb0, clean; loki-ts deps via `bun install --frozen-lockfile`), claude 2.1.286, 1 rep, 900s cap, EV-3 isolation, provider-reported cost only, hidden tests decide completion. Models from providers/model_catalog.json: claude-haiku-4-5 and claude-sonnet-5. Opus arms not run. The Loki arm is `v10` at default knobs (LOKI_ENGINE=v10, same model pinned via LOKI_EVAL_MODEL).

Subset: the small tier has 29 tasks; 4 arms x 29 would be 116 runs, over the 40-run budget, so the first 10 small-tier tasks by id are used (40 runs total): aiq-52-searchbar, pub-click-2877, pub-click-3059, pub-click-3487, pub-click-3572, pub-humanize-152, pub-humanize-174, pub-humanize-333, pub-jsonschema-1389, pub-markupsafe-417. aiq-52-searchbar is an `expected_outcome: no_change_needed` task. n=10 per arm, 1 rep: every rate has a wide interval (one task is 10 points); this is a baseline, not a gate. Machine load average was 24-37 during the run (more than 2 concurrent arms never ran); wall times are inflated and noisy.

| arm | attempted | completed | rate | median wall, all runs | median wall, completed | total cost | cost per completed | timed out |
|---|---|---|---|---|---|---|---|---|
| raw haiku-4-5 | 10 | 4 | 40% | 103.2s | 100.5s | $2.3124 | $0.5781 | 0 |
| Loki+haiku (v10) | 10 | 7 | 70% | 123.0s | 127.7s | $3.4649 (1 run unmeasured) | $0.4950 | 0 |
| raw sonnet-5 | 10 | 9 | 90% | 111.6s | 118.0s | $4.9239 | $0.5471 | 0 |
| Loki+sonnet (v10) | 10 | 5 | 50% | 92.9s | 128.8s | $3.7278 (1 run unmeasured) | $0.7456 | 0 |

Cost per completed = total spend of all 10 runs (failures included) / completed. The 2 unmeasured v10 runs are the aiq-52-searchbar runs that exited in about 1s before any model call (no spend, no provider cost record).

Model lift (D50 targets):

| comparison | completion | cost per completed | time (median, all runs) | verdict |
|---|---|---|---|---|
| Loki+haiku vs raw haiku | 70% vs 40% (+30 points, 3 tasks) | $0.4950 vs $0.5781 (-14%) | 123.0s vs 103.2s (1.19x) | lift, within 1.2x |
| Loki+sonnet vs raw sonnet | 50% vs 90% (-40 points, 4 tasks) | $0.7456 vs $0.5471 (+36%) | 92.9s vs 111.6s (0.83x) | LOSS: below raw X |
| Loki+haiku vs raw sonnet (cross) | 70% vs 90% (-20 points) | $0.4950 vs $0.5471 (-10%); total $3.46 vs $4.92 (-30%) | 123.0s vs 111.6s | target (>= raw sonnet) NOT met |
| Loki+sonnet vs raw opus | not run | | | |

Failures by category (every failed or non-completed cell listed; no run timed out or was capped; all rows status ok):
- raw haiku (6): hidden tests failed with a PR pushed: pub-click-2877, pub-click-3059, pub-humanize-174, pub-humanize-333, pub-jsonschema-1389. aiq-52-searchbar: hidden regression test passed but it pushed a PR on a no-change task (wrong outcome).
- raw sonnet (1): hidden tests failed with a PR: pub-click-3059.
- Loki+haiku (3): aiq-52-searchbar: engine refused to start in 1.3s, "dirty tracked tree: M frontend/package-lock.json" (task `setup` npm install rewrote a tracked file; no model call). pub-humanize-174: outcome BLOCKED (spec conflict claimed against existing tests), no PR. pub-humanize-333: PR opened, hidden tests failed.
- Loki+sonnet (5): aiq-52-searchbar: same dirty-tree refusal in 0.7s. pub-click-2877: outcome ALREADY_SATISFIED claimed, no PR, hidden tests fail (false already-done). pub-humanize-174: FAILED "empty diff without an already_done marker", no PR. pub-click-3059 and pub-humanize-333: PR opened, hidden tests failed.

Findings: (1) the v10 dirty-tree refusal is a harness-vs-engine defect that costs both Loki arms the aiq task (the `no_change_needed` outcome is unreachable when `setup` dirties a tracked file); not fixed in this slice. (2) Loki+sonnet loses to raw sonnet mainly through no-PR outcomes (ALREADY_SATISFIED false positive, empty diff) and BLOCKED, not through slow runs. (3) Per D50 a slice that lowers lift is dropped; this baseline is the bar.

Reproduce (per arm; a run-owned temp is created by run.sh; needs `cd loki-ts && bun install --frozen-lockfile` for the v10 arm):
`LOKI_NO_BROWSER=1 LOKI_EVAL_MAX_LOAD=80 LOKI_EVAL_MODEL=<claude-haiku-4-5|claude-sonnet-5> eval/loki10/run.sh --arm <raw-claude|v10> --tasks aiq-52-searchbar,pub-click-2877,pub-click-3059,pub-click-3487,pub-click-3572,pub-humanize-152,pub-humanize-174,pub-humanize-333,pub-jsonschema-1389,pub-markupsafe-417 --parallel 1 --out ~/loki-ci-logs/d50-<arm>-<model>`
Raw rows: ~/loki-ci-logs/d50-{raw-haiku,raw-sonnet,v10-haiku,v10-sonnet}/results.jsonl.

### D50 rerun, 2026-10-01T10:25Z (3 reps, sonnet, 4 Loki-specific baseline losses)
| Task | Loki+sonnet | raw sonnet |
|---|---|---|
| pub-click-2877 | 3/3 | 3/3 |
| pub-humanize-333 | 1/3 | 1/3 |
| pub-humanize-174 | 0/3 | 2/3 |
| aiq-52-searchbar (no_change_needed) | 0/3 | 2/3 |
Two of the four baseline losses were noise; two are real. Internal measurement, not for publication until the fixes are re-measured.

## Cost rate re-baseline (MW-1)
| Date | Model | Input $/MTok | Output $/MTok | Cache read | Cache write 5m | Context | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-03 | claude-sonnet-5-5 (and claude-sonnet-5, now the standard price) | 2 (was 3 in loki-ts/data/model-pricing.json) | 10 (was 15) | 0.20 | 2.50 | 1M, standard pricing | platform.claude.com/docs/en/about-claude/pricing, read 2026-10-03 |
Cost per completed task for sonnet arms measured before this date used the old 3/15 table; they overstate by 1.5x and are not comparable without rescaling.


## FireLater#17 rerun gate (real repo, fresh clone, --no-pr)
| Version | Outcome | Cost | Notes |
| --- | --- | --- | --- |
| 10.6.14 | STALLED | $2.66 | |
| 10.7.1 | false ALREADY_SATISFIED, then FAILED | $2.69 | FC-15 class |
| 10.9.1 | BLOCKED | $0.75 | brief handicap, FC-19 class |
| 10.10.3 | PARTIAL | $2.27 | 12m; full migration (83 files); backend 5855/5858 green; implement stopped at a 900s run cap and verify was skipped (FC-21); run e10-20261003T220847Z-78fa, main be0799f, reported by steering 22:08Z |
| 10.10.5 | PARTIAL (CLI and receipt match) | $1.73 | run e10-20261003T233414Z-30ca, defaults, cap_s 2700, 12m05s, 2.42M tokens; implement 6m36s finished with no limit; verify, fix, verify ran; 77 files +4325/-2006; independent check: backend 5914 pass 0 fail 29 skip, tsc 0 errors; PARTIAL only from FC-22 (4 frontend tests over-selected, deps absent, honestly NOT PROVEN) and FC-23 (a Wall file failed the package tsc, TS1470); integration request-approval-race NOT PROVEN (needs DB). Zero false claims. |

## B9 raw vs loki (D91 COST-HALF and 10x metric owner)

`bash scripts/b9-scoreboard.sh --ab [--n 3] [--model M] --version V --json-out F --metrics-out docs/v10/METRICS.md`
runs `claude -p` (raw) and `loki start` (loki) on the same task text. cost_ratio = (loki usd per VERIFIED and hidden-check passing task) /
(raw usd per task solved), failed-run cost included; correctness_ratio = loki solve rate / raw solve rate, both judged by
the same hidden checks; wall_ratio = mean loki wall / mean raw wall; 95% percentile bootstrap over runs within each
(arm, fixture) cell. Raw cost and time come only from the claude SDK result line (`total_cost_usd`, `duration_ms`, cache read/creation tokens); loki cost and time only from the receipt (`cost.usd`, `time.total_s`, `cost.cache_read_tokens`, `cost.cache_creation_tokens`). The old `time.wall_s` and `cost.input_tokens` are never read as totals. A missing field, or `total_s` differing from the sum of `time.stages` by more than 1%, reads NOT RECORDED.

| Date | Run | Fixtures | Result |
|---|---|---|---|
| 2026-10-08T04:58Z | b9-ab n1-plumbing (SUPERSEDED) | trivial-sum | SUPERSEDED, do not cite. Used our own clock for wall and the old receipt fields: its loki wall (43s) was not the receipt `time.wall_s`/`total_s` and `time.wall_s` is invalid as a total (it is a stage sum that excludes boot and seal). Rerun on SDK `duration_ms` and receipt `time.total_s` once RECEIPT-TRUTH ships. Former text: cost_ratio=0.92 wall_ratio=3.07 n=1/1, not significant. |

## Release latency metric (WF-2MIN-3)

Definition: seconds from the Release run's dispatch/push event to the `+ loki-mode@<version>` line of the `npm publish` step in the `release` job. Baseline run 37869841774: 2m46s (gate/required-ci 30s, release 68s, publish-npm 64s). Target: under 2m. npm registry lag is NOT part of this metric; the non-blocking `npm-visible` job records it separately in its job summary (`npm registry lag: ... visible after Ns`, or `NPM-LAG-TIMEOUT`). Post-Release Smoke polls for visibility itself (up to 15 min).

| Version | Release run | Push SHA | Run created (UTC) | `+ loki-mode@` line (UTC) | Dispatch to publish | npm-visible done (UTC) | Registry lag (separate) | Target met |
|---|---|---|---|---|---|---|---|---|
| 11.3.8 | 37875150528 | 80989fdf0 | 02:33:37Z | 02:35:20Z | 1m43s | 02:39:49Z | ~4m29s | yes (under 2m) |

Source: `gh run view 37875150528 --log` (release job "Publish the verified tarball (no rebuild)" printed `+ loki-mode@11.3.8` at 2026-10-09T02:35:20Z), `gh run view 37875150528 --json createdAt` = 02:33:37Z; npm next = 11.3.8 at 436s after push. CTO steering smoke on 11.3.8: PASS (trivial-sum VERIFIED, $0.07, 27s). Prior run 11.3.7 (pre WF-2MIN-3) was 2m32s.
