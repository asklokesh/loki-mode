# R3: Cost + Observability Dashboard (anti-surprise-cost wedge)

Design note. Verified against live source on 2026-06-03 (v7.8.3 worktree).
No version bumps, no commits to main. This file is a design artifact for the
integrator; cherry-pick the implementation files listed at the bottom.

## Goal

Counter the #1 competitor churn driver (surprise cost) with TRANSPARENT cost:
per-run and per-project cost USD over time, model-routing visibility, token
burn, and budget caps that WARN before the cap (at 80%) rather than surprise
the user, while preserving the existing hard-stop at 100%.

## What already exists (reuse, do NOT duplicate)

| Surface | Location | Has | Missing for R3 |
|---|---|---|---|
| Aggregate cost | `dashboard/server.py` `GET /api/cost` (~4391) | totals, by_phase, by_model, basic budget | per-run history, time-series, warn status |
| Budget status | `dashboard/server.py` `GET /api/budget` (~4498) | limit, used, exceeded, remaining | warn-at-80% status field |
| Pricing | `dashboard/server.py` `GET /api/pricing` (~4575) | model price table | -- |
| Hard cap | `autonomy/run.sh` `check_budget_limit()` (8333) | pause + signal at >=100% | warn at 80% (no pause) |
| Bun cap | `loki-ts/src/runner/budget.ts` `checkBudgetLimit()` | parity of hard cap | warn at 80% |
| Cost lib | `autonomy/lib/efficiency_cost.py` `collect_efficiency` | sum cost_usd + tokens, honest None | (this is the shared lib to reuse) |
| Per-run proof | `.loki/proofs/<run_id>/proof.json` via proof-generator.py | run_id, generated_at, cost.usd, files_changed.count, council.final_verdict, provider.model | (source for per-run history) |
| Productivity CLI | `autonomy/loki` `cmd_metrics()` (17837) | session productivity report | dedicated cost view |
| Estimate CLI | `autonomy/loki` `cmd_plan()` | pre-run cost ESTIMATE | actuals |

## Critical data-source fact (verified)

`autonomy/run.sh:3186` wipes `.loki/metrics/efficiency/iteration-*.json` at the
start of every run. Therefore:

- `.loki/metrics/efficiency/` only ever holds the CURRENT run's iterations. It
  is the source for the INTRA-RUN time-series (per-iteration, now carries a
  `timestamp` field, run.sh:4246).
- Per-RUN and per-PROJECT cost OVER TIME must come from
  `.loki/proofs/<run_id>/proof.json` (persistent, one dir per run, carries
  `cost.usd` + `generated_at` + `provider.model`). This is the real
  "cost over time" series. Using efficiency/ for it would silently show one run.

## Deliverables

### 1. New endpoint: `GET /api/cost/timeline` (dashboard/server.py)

Read-only. Returns two honest series plus a budget block:

```json
{
  "current_run": {
    "iterations": [
      {"iteration": 1, "timestamp": "...", "model": "sonnet",
       "phase": "build", "input_tokens": 1500, "output_tokens": 500,
       "cost_usd": 0.05, "cumulative_usd": 0.05}
    ],
    "total_usd": 0.05,
    "cost_recorded": true
  },
  "runs": [
    {"run_id": "...", "generated_at": "...", "model": "sonnet",
     "cost_usd": 1.84, "files_changed": 3, "final_verdict": "APPROVE"}
  ],
  "project_total_usd": 1.89,
  "runs_count": 1,
  "budget": {
    "limit": 50.0, "used": 1.89, "remaining": 48.11,
    "percent_used": 3.78, "status": "ok",
    "warn_threshold_percent": 80, "exceeded": false
  }
}
```

- `current_run.iterations` from `.loki/metrics/efficiency/iteration-*.json`,
  sorted by iteration, with a running `cumulative_usd`. Cost per record:
  prefer `cost_usd`; if null, price from tokens via the EXISTING
  `_calculate_model_cost` helper (do not add a new pricer).
- `runs` from `.loki/proofs/*/proof.json` (reuse `_proofs_dir` + `_safe_json_read`).
- `project_total_usd` = sum of per-run proof costs (the persistent history).
- `budget.status`: "ok" (<80%), "warn" (>=80% and <100%), "exceeded" (>=100%).
  Computed at read time. No budget.json schema change (avoids the
  byte-identical-JSON parity trap with run.sh heredoc / budget.ts).
- `cost_recorded` distinguishes "recorded but $0" (records exist, sum 0.0) from
  "not recorded" (no records) -- mirrors efficiency_cost.py honesty contract.

`/api/cost` and `/api/budget` are left UNCHANGED (existing frontend + tests
depend on them). The new endpoint is additive.

### 2. Dashboard panel: `dashboard/static/cost.html`

Self-contained, zero-build, all CSS+JS inlined (mirrors `proofs.html`). Fetches
`/api/cost/timeline`. Shows: project total, budget gauge with a colored
warn/exceeded state and an explicit "warns at 80%, hard-stops at 100%" caption,
per-run history table, model-routing breakdown, and a simple inline-SVG
cumulative-cost line for the current run. Linked from "/".

### 3. CLI cost view: `loki cost`

New `cmd_cost()` in `autonomy/loki` (no existing `cost` command -> free to add).
Wired into dispatch + help. Reads the same two sources via a single embedded
python3 block that imports `autonomy/lib/efficiency_cost.collect_efficiency`
for the current-run aggregate (REUSE, not a 5th copy), and reads proofs/ for
per-run history. Flags: `--json`, `--last N` (limit run history). Shows budget
status with the 80% warn line. Honest: prints "cost not recorded for this run"
when efficiency returns usd=None.

`loki cost` is chosen over `loki metrics --cost` because cost is the headline
R3 wedge and deserves a first-class verb; `loki metrics` stays a productivity
report. Bun parity for `loki cost` is OUT of scope for this slice (documented
gap; the bash route is canonical and the budget runtime warn below has Bun
parity which is the load-bearing part).

### 4. Budget warn-at-80% (runtime, both routes)

Add a non-pausing warn when crossing 80%, keep the 100% pause:
- `autonomy/run.sh` `check_budget_limit()`: when `0.80*limit <= cost < limit`,
  `log_warn` + `emit_event_json budget_warning`. Does NOT pause.
- `loki-ts/src/runner/budget.ts` `checkBudgetLimit()`: same warn semantics via
  the returned result (add `warn: boolean` to `CheckBudgetResult`); orchestrator
  logs it. No budget.json schema change.

## Tests

- `tests/dashboard/test_cost_timeline_endpoint.py` (pytest, `_ForceLokiDir`
  pattern): empty dirs -> 200 with honest nulls; current-run aggregation +
  cumulative; per-run history from proofs; budget status thresholds
  (ok/warn/exceeded) at 79/80/100%; recorded-but-zero vs not-recorded; corrupt
  JSON skipped; no-PII (no absolute paths leaked).
- `loki-ts/tests/runner/budget.test.ts` (extended, bun test): warn flag true in
  [80%,100%), false below 80% and at/above 100% (exceeded path), no pause file
  written on warn.

## No-PII / honesty constraints

- Endpoints return only aggregates + run_ids + model names + timestamps. No file
  paths, no prompt text, no token strings. proof.json is already redacted by the
  R1 generator before it lands.
- `$0.00` is never fabricated: uncollected cost surfaces as null / "not recorded".

## Files (for the integrator to cherry-pick)

- `dashboard/server.py` (add `/api/cost/timeline`)
- `dashboard/static/cost.html` (new)
- `autonomy/loki` (add `cmd_cost` + dispatch + help)
- `autonomy/run.sh` (warn-at-80% in `check_budget_limit`)
- `loki-ts/src/runner/budget.ts` (warn flag)
- `tests/dashboard/test_cost_timeline_endpoint.py` (new)
- `loki-ts/tests/runner/budget.test.ts` (extended: warn-at-80% describe block)
- `docs/R3-COST-OBSERVABILITY-DESIGN.md` (this file)
