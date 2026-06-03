# R4: Visible Trust Trajectory - Design Note

Status: implemented in worktree (not yet merged). Author: R4 release team.
Verified against live source on 2026-06-03 (v7.8.3 worktree base; R1/R3/R5
already shipped, so the arc is further along than the loki-plan doc states).

## The story no competitor tells

Devin, Cursor, Windsurf, Claude Code, Aider et al. show you a single run.
None show you whether the agent is getting more trustworthy on YOUR repo over
time. Loki already runs a 3-reviewer council + RARV-C closure on every run and
persists the result. R4 makes the resulting TRUST TRAJECTORY visible:

- council approve-rate trending UP
- gate pass-rate trending UP
- iterations-to-completion trending DOWN
- human interventions trending DOWN

If the agent is earning autonomy on this repo, the trajectory shows it. That is
compounding, repo-specific proof of trust -> stickiness.

## Honest-data rule (non-negotiable)

Every number derives from REAL persisted run records. Never fabricate a trend.
With fewer than 2 runs, the trajectory is reported as "not enough history yet"
(insufficient=true), never a fake direction.

## Data source (REUSED, not new)

R3 already established `.loki/proofs/<run_id>/proof.json` as the persistent,
one-per-run history record (written by `autonomy/lib/proof-generator.py` at run
completion, on both success and failure, unless `LOKI_PROOF=0`). The R3 cost
timeline endpoint (`dashboard/server.py` `/api/cost/timeline`) already mines
this exact directory for per-run cost history.

R4 mines the SAME directory for the trust signals already present in each
proof.json:

| Trust signal            | proof.json path                          | Notes |
|-------------------------|------------------------------------------|-------|
| council pass (per run)  | `council.final_verdict`                  | APPROVE/APPROVED/COMPLETE => pass |
| council ratio (per run) | `council.reviewers[].vote` (APPROVE/...) | secondary signal when verdict absent |
| gate pass-rate (per run)| `quality_gates.passed` / `.total`        | already aggregated by generator |
| iterations (per run)    | `iterations` (int or {count})            | iterations-to-completion |
| files changed (per run) | `files_changed.count`                    | context, not a trust axis |
| timestamp               | `generated_at` (ISO 8601)                | ordering axis |

Human interventions: there is no per-run intervention counter persisted in
proof.json today. Rather than fabricate one or add new instrumentation in this
slice, R4 reports interventions as a derived best-effort signal ONLY when the
proof carries it (`council.interventions` or top-level `interventions`), and
otherwise marks that axis `available=false` with an honest note. This keeps the
honest-data rule intact and leaves a clean seam for a future per-run
intervention counter (a one-line add in proof-generator.py).

## Direction calculation (up / down / flat)

For each numeric axis across the time-ordered run series:

1. Split the series into an earlier half and a later half (median split; odd
   counts drop the middle point so the two halves never overlap).
2. Compare the mean of the later half vs the earlier half.
3. delta = later_mean - earlier_mean. Direction:
   - `flat` if |delta| <= epsilon (epsilon scaled per axis; rates use 0.01).
   - `up` / `down` by sign of delta.
4. "Good direction" is axis-specific: higher is better for council/gate pass
   rates; lower is better for iterations + interventions. The `improving`
   boolean encodes whether the direction is the good one, so the UI can color
   green/red without re-encoding the per-axis polarity.

Rationale for half-split vs least-squares slope: half-split is robust to a
single noisy run, needs no float regression in bash, and is trivially testable
with fixtures. A 2-run series degrades to last-vs-first, which is correct.

## Persistence (under .loki/metrics/, REUSED dir)

The aggregated trajectory is persisted to
`.loki/metrics/trust-trajectory.json` (schema_version 1). This is a derived
cache, written by the `loki trust` command and the dashboard endpoint so other
surfaces can read a single source of truth. It is NOT authoritative state: it
is always recomputable from `.loki/proofs/`. Deleting it loses nothing.

## Surfaces

1. CLI: `loki trust [--json]` (NEW Bun-native command, mirrors `loki kpis`
   exactly). Falls through to a bash `cmd_trust` when bun is absent (kpis had
   no bash fallback; R4 adds one because the Python derivation is shared and
   trivial to call from bash, giving real bash+Bun parity).
   - `loki kpis` stays a single-run snapshot. R4 does NOT duplicate it; `trust`
     is the across-runs trajectory view. `loki kpis` output gains a one-line
     pointer to `loki trust` (no behavior change).

2. Dashboard endpoint: `GET /api/trust/trajectory` (NEW, mirrors
   `/api/cost/timeline`). Reads `.loki/proofs/*/proof.json`, returns the
   per-run series + per-axis direction + insufficient flag.

3. Dashboard panel: standalone `dashboard/static/trust.html` + `/trust` route
   (mirrors `cost.html` + `/cost`), plus a nav entry and SPA section in
   `build-standalone.js` (mirrors the cost panel wiring exactly).

4. WS push: the `_push_loki_state_loop` broadcasts a `trust_update` message
   when the trajectory's overall improving-count changes (mirrors the R3
   `budget_status` transition push). No new channel; reuses manager.broadcast.

## Parity + no-duplication audit

- Data: reuses `.loki/proofs/` (R1/R3). No new run-time instrumentation.
- Endpoint: new route, but copies the `/api/cost/timeline` read pattern and
  the `_proofs_dir()` / `_safe_json_read` helpers verbatim in spirit.
- Panel: new `trust.html`, structurally a sibling of `cost.html`.
- CLI: new `trust`, structurally a sibling of `kpis`. `kpis` unchanged except a
  one-line see-also.
- Shared derivation: a single Python module
  (`autonomy/lib/trust_trajectory.py`) is the source of truth; the dashboard
  endpoint imports it, and the bash `cmd_trust` shells out to it. The Bun
  command reimplements the same pure logic in TS (parity-tested), matching how
  `kpis` has both a TS derivation and reads the same JSON the bash side writes.

## Test plan

- Python: `tests/test_trust_trajectory.py` - aggregation from fixture
  proof.json files, direction calc (up/down/flat) per axis polarity, the
  insufficient-history (<2 runs) case, no-PII (only derived numbers + run_id +
  timestamps leave the function), malformed proof.json skipped not fatal.
- TS: `loki-ts/tests/metrics/trust.test.ts` - same aggregation + direction
  parity on identical fixtures, insufficient case, JSON/human formatting.
- All mocked from on-disk fixtures. No provider calls, no paid calls.
