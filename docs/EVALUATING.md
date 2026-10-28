# Evaluating Loki Mode

For someone deciding whether to trust an autonomous coding agent with a real
codebase. Every claim below has a command next to it. Run them; do not take our
word for it.

We have deliberately not written a feature grid scoring ourselves against ten
competitors. Those grids are written by the vendor being scored, the criteria
are chosen by the vendor, and no reader can check a single cell. This page only
makes claims you can falsify in a terminal.

---

## 1. The agent hands you a receipt, and it admits what it did not verify

```bash
npx loki-mode tour     # no install, no API key, no spend, no network
```

Output includes:

```
Headline: VERIFIED WITH GAPS

| Files changed | 8                                        |
| Diff sha256   | c2be6fff3e774c387f276277b25fc424f07b667… |
| Tests         | verified (node-test)                     |
| Build         | not_run                                  |
| Security      | findings                                 |
| Cost          | $10.3218                                 |
```

**What to notice:** the headline is not "SUCCESS". Build was not run. Security
has findings. The receipt says so on its own front page.

**Why that is the product.** Every coding agent reports its own completion, and
self-reporting is the thing they are structurally worst at. The receipt
separates deterministic FACTS (diff hash, test result, cost) from AI
ASSESSMENTS, because only four of our eight quality gates are agent-independent
and a receipt implying otherwise would be marketing.

**Check it yourself:** recompute the diff sha256 over the same range and confirm
it matches. If it does not, the receipt is worthless and you should not use us.

---

## 2. Verification runs air-gapped

Deterministic verification makes zero network calls, so it runs inside a
perimeter on code that may never leave the building.

```bash
bash tests/test-airgap-verify.sh
```

That test blackholes every proxy variable, strips the environment, and asserts a
real verdict still comes back. Measured: **8.43 ms**.

**Scope, stated honestly:** verification is air-gapped. **Generation is not.**
Every provider we ship calls a hosted API, and local-weight generation needs
models you would supply. We are not claiming the generation half, and any vendor
who claims a fully air-gapped LLM agent without shipping weights is worth a
second question.

---

## 3. On an existing codebase, the read-only path is genuinely read-only

Brownfield is the harder problem, and the reason to distrust an agent near it is
obvious. So the entry point writes nothing:

```bash
loki modernize heal ./your-repo --assess
git status        # clean. no scratch files, no .loki/, no commits.
```

**Enforced, not promised:**

```bash
bash tests/test-brownfield-assess-readonly.sh
```

That test hashes every file before and after, compares HEAD, and requires a
clean working tree. It is content-addressed, so it does not care *how* a write
might happen.

---

## 4. The harness is model-invariant (and we do not overclaim it)

```bash
cat benchmarks/results/cross-model-eval.json
```

- **Claimed:** the same gates run, the same acceptance is checked, and the same
  receipt semantics apply regardless of which model is behind it.
- **Explicitly NOT claimed:** identical quality or identical speed across
  models. That is not deliverable and we do not assert it.

Measured runs are in that file with wall-clock and iteration counts. Two runs is
two runs; it is not a benchmark suite, and the file says so.

---

## 5. Verification is fast enough to embed

```bash
python3 autonomy/lib/fast_verify.py --path . --diff-base HEAD~1
```

Measured on this repository, 1,932 tracked source files: **11,040 ms before,
19 ms diff-scoped** (298 ms cold, 87 ms warm). That is the difference between a
check you run at the end and a check something else can call as a dependency.

---

## 6. Head to head, on this machine, in ten seconds

The one competitive comparison we will publish, because you can rerun it:

```bash
bash tests/test-competitor-verify-surface.sh
```

It runs `--help` on whatever agent CLIs are installed and checks whether any of
them exposes a command that verifies the agent's OWN output.

Measured 2026-07-30 against every one of the six named competitors that ships
a local CLI:

| CLI | Verifies its own output |
| --- | --- |
| opencode 1.18.9 | no |
| aider 0.86.2 | no |
| codex-cli 0.146.0 | no |
| Claude Code 2.1.220 | no |
| cursor-agent 2026.05.24 | no |
| loki-mode 8.3.3 | yes (`loki proof verify`) |

Devin and Replit Agent ship no local CLI, so they are not covered and no claim
is made about them.

**The detail that makes this honest.** aider matches eight times on
verify/proof/attest terms. All eight are `--verify-ssl` (TLS certificate
validation) and `--git-commit-verify` (git pre-commit hooks). Neither verifies
the agent's output. A count-based comparison would have scored aider 8 against
our 2 and concluded the opposite of the truth, so the test reads every hit
instead of counting them.

**Scope.** This inspects the CLI surface of locally installed tools. Devin and
Replit Agent ship no local CLI and are not covered. Absence from a `--help`
listing is also not proof of absence from a product: a web UI or an API could
expose something the CLI does not. If a competitor does ship output
verification, this test is how we would find out, and the claim above would be
corrected rather than defended.

## 7. Headless latency, five trials per tool

Same task, same machine, artifact verified by content, five trials each:

| CLI | Success | Median | Range |
| --- | --- | --- | --- |
| opencode 1.18.9 | 5/5 | 11s | 4s to 265s |
| codex-cli 0.146.0 | 4/5 | 69s | 48s to 80s (one 300s timeout) |

**Read the range, not just the median.** opencode's first trial took 265
seconds and the next four took 4 to 12. A new user experiences the 265, not the
11. Reporting only the median would hide the thing they will actually feel.

**The timeout is kept in.** Dropping codex's one failure would turn 4-of-5 into
an implied 5-of-5 and overstate reliability.

**Five trials, not one, and that is the point.** An earlier single-shot run of
this same codex command timed out, and publishing it would have recorded
"codex: timeout" as a fact about a competitor when the identical command
completed in 51 seconds minutes later. The spread is the finding.

**What this does not measure.** One trivial file-creation task is not a proxy
for build quality, multi-iteration work, or brownfield capability. It measures
headless invocation latency and nothing else. aider, Claude Code and
cursor-agent have not been run on this task; Devin and Replit Agent ship no
local CLI. Cost is not compared: codex ran on a free tier and opencode's
per-call cost was not recorded.

---

## 8. Harness attribution: what Loki adds to the same model

Question: what does Loki add to the same underlying coding agent, and is the benefit worth its cost? Status: pilot. Six tasks, small n. A pilot reports variance; it is not proof of superiority. Running it is a separate, paid step.

```bash
loki bench attribution --dry-run                       # validate task set, print plan, no model call
loki bench attribution --model <model-id> --execute    # run, spends API budget
loki bench attribution --report <result.json>          # re-render the markdown report
```

Source checkout only. Implementation: `benchmarks/bench/attribution.py`, reusing `runner._apply_overlay`, `report._median` and `benchmarks/bench/adapters` (process-tree reaping, the Claude JSON parser, the Loki adapter and its cost collection). Options: `--tasks id,id`, `--repeats N` (default 1), `--model ID` (default `claude-sonnet-5`, or `LOKI_BENCH_MODEL`), `--budget-usd X` (default 5), `--timeout SECONDS` (default 900, capped by each task's `agent_timeout_s`), `--out-dir DIR`, `--tasks-dir DIR`. Without `--execute` it only prints the plan and never spawns `claude` or `loki`.

Arms and controls: `raw-configured` runs `claude -p <prompt> --output-format json --model M --dangerously-skip-permissions --max-budget-usd B`; `loki` runs `loki start <prompt-file> --provider claude --no-dashboard --yes` with `LOKI_SESSION_MODEL=M` and `LOKI_BUDGET_LIMIT=B`. Both get a byte-identical seed in a fresh git repo with one fixed "seed" commit, the same prompt text (the PRD file for Loki is kept outside the workspace), the same wall-clock cap with the process tree reaped on timeout, separate scratch directories, a scoped child environment and `LOKI_NO_BROWSER=1`. The arm that goes first alternates per task and repeat. Every result JSON pins `claude --version`, `loki version`, the Loki commit SHA, Python version, model, budget, timeout, repeats, and per task the sha256 of the seed tree, acceptance tree and prompt. Disclosed difference: Loki runs its own planning, review and verification loop; that overhead is what is measured. Provider comparisons are out of scope so model and harness effects are not mixed.

Tasks live under `benchmarks/attribution/tasks/<id>/` (2 bug fixes, 2 features, 1 refactor, 1 integration): `task.json`, `prompt.md` (the only instruction either arm sees), `seed/` (workspace), `acceptance/` (hidden test, copied in only after the run, overwriting same-named files) and `reference/` (known-good overlay, used only by tests). Exit code 0 from `acceptance.cmd` means accepted. The loader rejects a task whose acceptance test also appears in the seed. Neither arm grades itself: no council, RARV-C or LLM judge takes part in scoring.

Metrics, per arm and per task class, computed by `compute_metrics`; failures, timeouts and harness errors stay in every denominator:

- Acceptance rate: accepted / assigned, with a 95% Wilson interval.
- False-completion rate: (reported success and not accepted) / reported success; null when nothing reported success. Reported success means `claude -p` exits 0 with `is_error` false, or `loki start` exits 0.
- Cost per accepted task: total measured spend across all attempts / accepted. Null (`undefined_no_accepted`) when none accepted. A run with no cost figure is `unmeasured`, never zero: some unmeasured gives `partial_lower_bound` (per-accepted null, lower bound only), all unmeasured gives `unmeasured`. Cost is API-dollar accounting; subscription use is not converted.
- Elapsed time: median over accepted runs, with completion rate, timeout count and error count; median over all runs is also given.

Not measured: human effort, recovery success, review quality. Output: `--out-dir` (default `benchmarks/attribution/results/`) receives `attribution-<UTC stamp>.json` and the matching `.md`. Publish failures, timeouts and exclusions with the report; do not drop rows. Do not claim superiority from overlapping intervals on a handful of runs; use the pilot to size a larger run with `--repeats` above 1. Tests: `python3 benchmarks/bench/tests/test_attribution.py` (no model call).

Cost proof run: the exact command, the five arms (`raw-configured`, `raw-lean`, `raw-bare`, `loki`, `loki-lean`), the verdict rule, the report-against-every-floor requirement and the loki-version validity rule are in the "Cost proof (C-F1)" section of [docs/v10/METRICS.md](v10/METRICS.md).

---

## 9. Factory-vs-Loki task set (reproducible, partly unmeasured)

`benchmarks/attribution/tasks/coord-1-api-web/` (multi-repo coordination) and `benchmarks/attribution/tasks/longspec-1-three-units/` (long spec, three units) ship with held-out acceptance kept outside the workspace. `benchmarks/bench/attribution.py` has four arms: `raw-configured`, `raw-bare` (`claude --bare`, needs ANTHROPIC_API_KEY, else UNMEASURED with a reason), `loki` and an optional `droid` arm. `--max-spend-usd N` aborts before the next run once true spend (max of reported cost and the Loki child-session ledger) reaches N. The droid arm probes `droid exec --help`; when `droid exec` is unavailable every droid cell is recorded UNMEASURED with a reason, never zero. `python3 benchmarks/bench/attribution.py --dry-run` lists the tasks and arms and makes no model call. No Factory result is published: Factory publishes no Missions benchmark and no droid run has been measured here. Axis where Loki is ahead on documented features: offline-recheckable signed receipts, now composite receipts for multi-repo change sets; Factory documents none.

---

## Outcome analytics

One set of definitions for the effort and honesty numbers, used by the bench report (`benchmarks/bench/attribution.py`) and by real-run reports (`loki trust`, `.loki/state/interventions.json`, HANDOFF.md). It answers the Factory comparison gate "metrics include failures and measure user effort" (FACTORY_VS_LOKI section 8, P2). Failures are counted, never dropped.

- Term accepted outcome: bench, a run whose held-out acceptance check passed. Real runs, a proof with verdict VERIFIED that was not later contradicted by a FAILED outcome.
- Term misleading completion: Loki or the agent claimed done and was wrong. Bench name `false_completion` = (reported success and not accepted) / reported success. `loki trust` name `false_verified` = VERIFIED claims later FAILED / VERIFIED claims. Same idea, same denominator (claims of success). Null when nothing claimed success.
- Term cost per accepted: total spend across ALL attempts, failures included, divided by accepted. Null when nothing was accepted, and null when any run's cost is unmeasured (a partial sum is not a total; the bench also reports a lower bound). Never zero for an unknown.
- Interventions by type: counts of blocking pauses that waited on a person, split into `steer`, `input`, `authorization` and `repair` (a fixed enum, no free text). Written to `.loki/state/interventions.json` at the pause site; shown in `loki trust`, HANDOFF.md and the proof as `interventions_detail`. Absent means not recorded, not zero.
- Waited versus active minutes: `waited_s` is the wall-clock seconds a run sat blocked on a person, an upper bound on human attention. `active_s` (in `interventions.json` and `interventions_detail`) is the measured time a person actually worked on steer, input, authorization and repair events, recorded only when both timestamps were measured. `loki trust` shows "Active minutes per accepted" only when every run measured it, otherwise "n/a (not measured)"; an unmeasured value is never reported as 0. Status: the runner does not yet write `active_s` (nothing calls `recordActiveSeconds`), so `loki trust` shows n/a until the writer slice lands. Only non-negative integers are accepted; a float or negative value is dropped as unmeasured.
- Retries: iterations to completion, taken from the proof `iterations.count` (`loki trust` iterations axis). A retry is not an intervention.

### PostHog insight definitions

Reproducible definitions for the product-analytics dashboard. Every event and property below is an entry in `autonomy/lib/telemetry-schema.json`, the single allowlist for every sender: events `cli_command` (line 18), `installed` (15), `session_start` (21), `session_end` (26), `first_start_attempted` (33), `first_run_blocked` (36), `build_verified` (39); common properties `os_family`, `arch`, `version`, `channel`, `traffic`, `introspective` (lines 5-10); the `command` enum on `cli_command` (line 19). None of these carry an IP, a prompt, a path or any content; the payload cannot, because a key outside the schema is dropped at send. Dashboard settings are outside the repo: confirm the PostHog project has "Discard client IP data" on.

Internal-noise filter, applied to every usage insight (HogQL fragment, called NOISE below):

```
properties.traffic = 'user' AND properties.introspective = false AND properties.command NOT IN ('version', '--version', '-v', 'help', '--help', '-h', 'other')
```

`traffic` and `introspective` are absent on events from older releases, so a clean insight over a long window silently drops them. Use the NOISE filter only for releases that send both properties, and read pre-property history through the version query below. Not yet expressible from the schema, therefore not defined here: resume accept rate, verification tax (stage seconds), run-level verdict mix beyond `build_verified`, and an ephemeral-home filter. Add the insight when the event or property enters the schema, not before.

1. Clean daily and weekly active users. Trends, unique users, event `cli_command`, filter NOISE, interval day and week. Introspection and automation are excluded, so a Docker healthcheck calling `loki version` never counts as a user.
2. Usage by command. Trends, event `cli_command`, filter NOISE, breakdown `command`. Reads which commands real users run.
3. Provider mix. Trends, unique users, event `session_start`, breakdown `provider` (claude, codex, cline, aider, opencode). Filter `traffic = 'user'`.
4. Verdict mix. Trends, event `build_verified`, breakdown `headline` (VERIFIED, VERIFIED WITH GAPS, NOT VERIFIED), filter `route = 'engine10'` and `traffic = 'user'`. `build_verified` fires only on a completed run, so this is the mix among reported runs, not among all starts.
5. Gate pass rate. Trends, event `build_verified`, formula average of `gate_pass_rate`, filter `gates_total > 0`, breakdown `headline`.
6. Time to first VERIFIED. HogQL, median seconds from the first `installed` to the first VERIFIED `build_verified` per user:

```
SELECT quantile(0.5)(dateDiff('second', i.t0, v.t1)) AS median_seconds, count() AS users
FROM (SELECT distinct_id, min(timestamp) AS t0 FROM events WHERE event = 'installed' GROUP BY distinct_id) AS i
JOIN (SELECT distinct_id, min(timestamp) AS t1 FROM events
      WHERE event = 'build_verified' AND properties.headline = 'VERIFIED' GROUP BY distinct_id) AS v
  ON i.distinct_id = v.distinct_id
WHERE v.t1 >= i.t0
```

7. Failure Pareto. Bar chart, event `first_run_blocked`, breakdown `blocker` (no_provider, not_logged_in, not_a_repo, git_identity, node, python3, jq, git, curl, disk, skill_symlink, other), sorted descending. Pair with `build_verified` where `headline = 'NOT VERIFIED'` broken down by `evidence_gate_verdict`.
8. Activation funnel. Funnel, ordered steps `installed`, `first_start_attempted`, `session_start`, `build_verified` with `headline = 'VERIFIED'`, conversion window 14 days, unique users. The `entry` property on `first_start_attempted` gives the entry command for a breakdown.

Version-event hypothesis: the high volume of `version` events is automated healthcheck traffic that predates the v7.89.0 non-interactive auto-off (2026-06-20), not user behaviour. Status: unproven until this query is run on the live project. Run it as HogQL over a window that spans the cutover:

```
SELECT
  properties.version AS version,
  properties.channel AS channel,
  count() AS version_events,
  uniq(distinct_id) AS users,
  round(count() / uniq(distinct_id), 1) AS events_per_user
FROM events
WHERE event = 'cli_command'
  AND properties.command = 'version'
  AND timestamp >= now() - INTERVAL 365 DAY
GROUP BY version, channel
ORDER BY version_events DESC
LIMIT 100
```

Read it with these decision rules, fixed before the data so the result cannot be bent to fit:

- Supported: `version_events` is concentrated in releases below 7.89.0 and in `channel = 'docker'`, with events_per_user far above any plausible human rate (a healthcheck every 30 seconds is 2,880 per container per day), and releases at or above 7.89.0 show a small events_per_user. Then `version` is noise, and the NOISE filter above is correct to drop it.
- Refuted: events_per_user is comparable across the cutover, or the volume sits in `channel` values npm, homebrew or source at releases at or above 7.89.0. Then `version` is real human behaviour (or a different automation source), and the filter must be revisited before any user count is quoted.
- Split by cutover: repeat the query with an added filter on the `version` property below 7.89.0, then at or above it, using PostHog semver comparison (`semver_lt` and `semver_gte`), and compare totals.
- Check the residual: at releases at or above 7.89.0, compare `traffic IN ('ci', 'internal')` against `'user'`; a nonzero `user` share with a very high events_per_user in `docker` means a container with telemetry forced on still emits.

Until this query is run, do not quote a usage number from the raw event stream as user behaviour.

---

## What we do not have

Stating this plainly, because you will find it out anyway and it is cheaper for
both of us if you find it here.

- **No published enterprise case studies.** We have adoption signal (fork ratio
  well above the norm for a tool this size) but no named enterprise references.
- **No independent third-party benchmark placement.** Public leaderboards are
  self-reported, and ours would be too.
- **Only the CLI surface is audited, not whole products.** Section 6 measures
  every named competitor that ships a local CLI (opencode, aider, codex, Claude
  Code, cursor-agent) and none exposes output verification. That is a real
  measurement you can rerun, but it is a measurement of `--help`, not of a
  product: a web UI or an API could expose something the CLI does not. Devin and
  Replit Agent ship no local CLI and are not covered at all. Treat this as
  "unclaimed on every surface we can reach", which is stronger than the earlier
  "unclaimed as far as we can verify" and still short of a proven first.
- **No scale measurement for multi-repo runs.** No test covers dozens of repos, so none is claimed.
- **No Factory comparison run.** The droid arm is UNMEASURED until a run exists (section 9).
- **Generation is not air-gapped.** See section 2.

---

## The one question worth asking any agent vendor

> When your agent says it finished, what artifact can I check that does not come
> from the agent's own narrative?

Ours is the Evidence Receipt, and section 1 is a two-minute test of whether the
answer holds up. Ask the same question everywhere else.
