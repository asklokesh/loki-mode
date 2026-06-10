# SWE-bench Pro Pilot - Pre-Registered Methodology

Status: PRE-REGISTRATION. Written BEFORE the paid generation run (Hard Rule 3).
Results land in a SEPARATE later artifact, never in this file.

Prepared: 2026-06-09. Machine: Apple Silicon Mac, Docker 29.5.2,
Python 3.12.13 (`/opt/homebrew/bin/python3.12`).

This is the binding methodology for the Loki Mode pilot against the public
SWE-bench Pro set. It is governed by the Hard Rules in
`internal/BENCHMARK-PROGRAM-2026-06.md`: never publish a generation rate as a
score; Loki never grades itself; pre-register before results; lead with the
conservative figure; the absolute score is an upper bound under contamination;
publish failures; cost is raw and never blended.

---

## 1. Pinned configuration (the pre-registered run definition)

| Item | Pinned value |
|---|---|
| Generator | Loki Mode v7.27.0 (`/Users/lokesh/.bun/bin/loki`) |
| Provider | claude (Claude Code CLI v2.1.170) |
| Model policy | Loki internal RARV tier policy (Opus = planning/architecture only; Sonnet = implementation; Haiku = unit tests/simple). Not overridden. |
| Per-instance iteration cap | `LOKI_MAX_ITERATIONS=8` |
| Per-instance budget cap | `LOKI_BUDGET_LIMIT=8` (USD; enforced by `check_budget_limit()` in run.sh from `.loki/metrics/efficiency/*.json`) |
| Per-instance wall timeout | 5400 s (90 min) host cap in the adapter |
| Retries | None beyond Loki's own internal RARV-C loop. 1 trial per instance. |
| Trials | 1 (de-risk / calibration run) |
| Grading | Official `swe_bench_pro_eval.py`, out-of-container, `--use_local_docker --docker_platform=linux/amd64`. Loki never grades itself. |

## 2. Dataset and subset (pinned)

- Source of truth: `helper_code/sweap_eval_full_v2.jsonl` bundled in the harness
  repo (731 public-set instances).
- Dataset sha256 (the bundled jsonl): `b5b2462bfbf5aeb2cb7ba7d215778a1768b85f9d7ad7f748546c7f80a0ad1510`
  (see `DATASET-SHA256.txt`).
- Harness commit (`scaleapi/SWE-bench_Pro-os`): `ca10a60a5fcae51e6948ffe1485d4153d421e6c5`
  (see `HARNESS-COMMIT.txt`).
- Pinned subset: `pilot-subset-119.json`. 119 instances, proportional stratified
  sample across all 11 repos, seed 42, deterministic (`Random("42:<repo>").sample`
  over sorted ids, quota = round(120 * repo_size / 731), min 1; final set sorted,
  de-duped). Subset sha256 (newline-joined sorted ids):
  `69dda7c1b313761dd0832d3ad32b36e20f09d0fe01523eabba30af750c1145bb`.
- SMOKE BATCH scope: the FIRST 10 instances of `pilot-subset-119.json`
  (7 NodeBB + 3 ansible). This is calibration, NOT a publishable result.

## 3. Adapter (instance -> Loki -> graded patch)

Agent-on-host (runbook Section 3 path b). Chosen because Loki's multi-agent
fleet under QEMU amd64 emulation is too slow for a calibration batch; the
instance container is needed only for grading, which resets to base_commit.

Fidelity guarantee: the host workdir is the repo's `/app` tree extracted from
the SAME instance image the grader uses, checked out at `base_commit`, so the
host diff base equals the grader's `git reset --hard base_commit` base exactly.

Per instance (`run_instance.py`):
1. Compute image URI via `helper_code/image_uri.py`; `docker pull --platform
   linux/amd64`.
2. `docker cp` the image's `/app` to a host workdir; `git checkout -f
   base_commit`; `git clean -fd`.
3. Write `problem_statement` to `ISSUE.md` (the spec the agent sees). The agent
   NEVER sees held-out tests (they are baked into the image, not the checkout).
4. Run `loki start ISSUE.md --provider claude --no-dashboard --yes` with the
   pinned caps.
5. Extract `git diff base_commit` EXCLUDING: `.loki/`, `ISSUE.md`, and every
   held-out test path (`selected_test_files_to_run` + paths enumerated in
   `test_patch`). Emit `{instance_id, patch, prefix}`.
6. Collect cost from `.loki/metrics/efficiency/*.json`; record wall time.

The adapter reports ONLY what the run did (patch produced yes/no, cost, wall
time, exit). It NEVER reports resolved/success/quality.

## 4. Grading shim (REQUIRED, pinned)

`eval_shim.py` coerces the bundled jsonl into what the evaluator expects:
lowercase `fail_to_pass`/`pass_to_pass`, every list field as a repr-STRING
(native lists get `repr()`-d, existing strings pass through). Without it the
evaluator KeyErrors on column case and mangles repr-strings into per-character
regexes (a false-negative bug caught in dry-run 1).

## 5. Pre-run validation evidence (zero LLM spend)

The grading pipeline was proven to DISCRIMINATE before any paid run:
- Dry-run control (navidrome/Go): gold patch -> True, empty patch -> False.
  Evidence: `gold-smoke-evidence/navidrome-{gold,empty}-eval_results.json`.
- Gold round-trip on the ACTUAL smoke-batch repos (NodeBB/JS + ansible/Python):
  both gold patches -> True (100%). Evidence:
  `gold-smoke-evidence/nodebb-ansible-gold-eval_results.json`.

This proves: the environment builds, the runner runs, the parser parses, the
pass/fail logic is wired, the shim coercion is correct for JS and Python, and
the host-clone base matches the grader base, all before spending a cent.

## 6. Grading command (pinned)

```
cd <harness>/SWE-bench_Pro-os
/opt/homebrew/bin/python3.12 swe_bench_pro_eval.py \
  --raw_sample_path=<coerced subset jsonl via eval_shim.py> \
  --patch_path=<loki_predictions.json> \
  --output_dir=<results dir> \
  --scripts_dir=run_scripts --num_workers=2 \
  --dockerhub_username=jefzda --use_local_docker --docker_platform=linux/amd64
```

## 7. Pledges (pre-registered, binding)

- Publish everything including failures. Failures score 0 (image pull failure,
  unappliable patch, emulation timeout) and are never silently dropped.
- Loki never grades itself; grading is the official out-of-container evaluator.
- Lead with the conservative figure. The generation rate (patch produced) is
  NOT a score; only the official resolved rate is.
- Cost is raw, never blended.
- 1 trial, no retries beyond Loki's internal RARV-C loop.

## 8. Contamination caveat (pre-registered, must sit next to any number)

The public SWE-bench Pro set is public GPL code. Treat the absolute resolved
score as an UPPER BOUND under possible training-data contamination. The value
is the relative gap to other tools on the same frozen set, not the absolute
number. The contamination guarantee lives in the COMMERCIAL set, which this
pilot does NOT run.

## 9. Honest framing line (required next to any published number)

"Loki resolved X percent of the <N> pinned public SWE-bench Pro instances,
graded by the official out-of-container evaluator. The public set is public GPL
code, so treat the absolute score as an upper bound under possible
contamination; the value is the relative gap to other tools on the same frozen
set."

---

## 10. Amendment 2026-06-10 (recorded BEFORE batch instances 2-10 ran)

Stage 2 (single-instance adapter validation, NodeBB instance 1 of the smoke
batch) produced two measured facts that forced a config change BEFORE the
batch:

1. Measured cost was ~$14.55 for one instance at `LOKI_MAX_ITERATIONS=8`
   (per-iteration: 4.73, 3.03, 0.77, 0.95, 1.10, 2.98, 0.99 USD from the
   claude stream-log result records), vs the $3-8/instance planning estimate.
   10 instances at that rate (~$145) would exceed the authorized $30-80.
2. DEFECT: Loki's `.loki/metrics/efficiency/*.json` files all recorded
   cost_usd=0 / tokens=0 (`.loki/context/tracking.json` never populated on
   this host), which leaves the in-product `LOKI_BUDGET_LIMIT` USD breaker
   inert. The iteration cap was the breaker that actually fired.

Amended config for smoke-batch instances 2-10 (instance 1 already ran at
max_iter=8 and is documented as such in the results):
- `LOKI_MAX_ITERATIONS=4` (instance 1's first-4-iteration cost: $9.48).
- Host-side cumulative hard cap: the batch aborts when total measured spend
  (including instance 1's $14.55) reaches USD 78. Instances not run are
  reported explicitly as "not run (budget exhausted)", never silently dropped.
- Cost accounting source of record: `total_cost_usd` from `result` records in
  `.loki/logs/autonomy-*.log` (authoritative claude CLI accounting), not the
  zeroed efficiency files.
- Adapter strip rule extended: newly-added .md files and new files under
  memory/ are dropped from the extracted patch (Loki self-artifacts found
  outside .loki/ in Stage 2: USAGE.md, memory/*.md). Files existing at
  base_commit are always kept.

No grading results for instances 2-10 existed when this amendment was written;
instance 1's graded result existed (it doubled as the adapter apply-validation
gate) and is reported with its pre-amendment config.

---

## 11. Outage note 2026-06-10 (provider session-limit during batch instances 4-10)

Recorded 2026-06-10 after the first batch run, BEFORE the re-run of the
affected instances. This documents an infrastructure failure, not a Loki
result.

What happened: the smoke batch (instances 1-10 of `pilot-subset-119.json`)
ran overnight. The Claude Code CLI hit its account session limit partway
through. From that point every Loki iteration's underlying `claude -p` call
returned a `result` record with `is_error=true`,
`total_cost_usd=0`, and `result="You've hit your session limit . resets
4:20am (America/New_York)"`. No tokens were spent and no agent work occurred
on those iterations.

Per-instance classification from the `result` records in each run's
`.loki/logs/autonomy-*.log` (authoritative claude CLI accounting):

| # | Instance (repo) | result records | session-limit errors | real iters | log cost | classification |
|---|---|---|---|---|---|---|
| 1 | NodeBB 05f22361 | 7 | 0 | 7 | $14.5514 | real attempt (pre-amendment max_iter=8) |
| 2 | NodeBB 087e6020 | 1 | 0 | 1 | $7.1715 | real attempt |
| 3 | NodeBB 4327a09d | 3 | 1 | 2 | $4.3587 | real attempt (patch produced in 2 real iters at 00:51-00:55; a 3rd iteration at 00:56 hit the limit AFTER the patch already existed) |
| 4 | NodeBB 6489e9fd | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:07) |
| 5 | NodeBB 8ca65b0c | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:17) |
| 6 | NodeBB a917210c | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:27) |
| 7 | NodeBB b398321a | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:38) |
| 8 | ansible 12734fa2 | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:48) |
| 9 | ansible 1a4644ff | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (01:58) |
| 10 | ansible 34db57a4 | 3 | 3 | 0 | $0.0000 | provider-down, never attempted (02:08) |

Window: the provider was session-limited from roughly 00:56 EDT (instance 3's
final iteration) through the batch end at 02:08 EDT. The stated reset was
4:20am America/New_York. The re-run below was started after that reset (session
availability re-confirmed with a one-line probe that returned a real,
non-error result).

Decision (binding):
- Instances 4-10 were provider-down and produced ZERO real iterations. They
  were never genuinely attempted. Under the 1-trial rule, an infrastructure
  failure does not consume the instance's single trial. Their re-runs are
  therefore FIRST REAL TRIALS, not retries.
- Instance 3 keeps its result. It hit a session-limit error only on a 3rd
  iteration that ran AFTER its patch had already been produced by two real
  paid iterations. The 1-trial rule is honored: instance 3 was genuinely
  attempted and is NOT re-run.
- Instances 1 and 2 keep their results unchanged.
- The re-run uses the amended config (Section 10): `LOKI_MAX_ITERATIONS=4`,
  cumulative host hard cap $78 inclusive of instances 1-3's $26.08.

Re-run mechanics (recorded for reproducibility): `run_batch.py` resume skips
any instance already present in `batch_records.json`. To re-run 4-10 as fresh
trials, their stale `patch_produced=false`, `cost=0` records were removed from
`batch_records.json` (and their empty `.patch` files and stale run dirs
cleared) so the resume loop treats them as not-yet-done. Records for instances
1-3 were left untouched; `spent()` re-counts their $26.08 from the retained
records, so the $78 cumulative cap remains correct across the resume.

---

Pre-registration note: this methodology, the pinned subset, the shim, and the
gold-smoke evidence constitute the pre-registration bundle. Per Hard Rule 3 they
are committed BEFORE any paid run; the smoke-batch results land in a separate
internal artifact (`internal/SWEBENCH-PRO-SMOKE-RESULTS.md`) and stay internal
until the founder approves the full run + publication.
