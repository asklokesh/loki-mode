# BUILD-HUD-PLAN.md -- In-Terminal Live Build HUD

## Product Owner scope locks (decided 2026-06-18)
1. ETA: OMIT unless an explicit small LOKI_MAX_ITERATIONS or a LOKI_BUDGET_LIMIT cap is present. Default behavior shows no ETA.
2. Phase wording: show the RARV phase name (REASON/ACT/REFLECT/VERIFY) -- that is what the live loop tracks. Do not add the planning/development tier word.
3. Failure-iteration render: YES, render the HUD on both the success and the retry/failure path (the "is it working" moment matters most when an iteration fails).
4. Opt-out var: LOKI_HUD (default 1 = on; LOKI_HUD=0 disables). TTY-gated.

## 1. Goal
When a user runs `loki start ./prd.md` in a foreground (interactive TTY) terminal, emit a single clean per-iteration status line at each iteration boundary showing: RARV phase, iteration N/max, cumulative cost, files changed (+/-) vs run start_sha, and per-iteration + elapsed time (ETA only when a real target exists per lock #1). Pure additive stdout decoration on the interactive path. Must not change non-TTY/CI/`--bg` output by a single byte, must not touch the stream-json parser, `log_step` lines, or the dashboard, and must degrade cleanly when cost data is unavailable.

## 2. Live route confirmation (re-verified)
- Orchestrator: `autonomy/run.sh`, `set -uo pipefail` (NOT `set -e`).
- Iteration loop body: provider dispatched after the RARV banner (`run.sh:14662`); `rarv_phase` set at `run.sh:14589` via `get_rarv_phase_name "$ITERATION_COUNT"` (in scope for the whole iteration body).
- `ITERATION_COUNT` = `run.sh:620` (init 0); `MAX_ITERATIONS` = `run.sh:619` (default `LOKI_MAX_ITERATIONS:-1000`).
- Provider exit + `duration=$((end_time - start_time))` computed at `run.sh:15279-15280`.
- Success path continues at `log_step "Starting next iteration..."` `run.sh:16026`.
- Bun runner `loki-ts/src/runner/autonomous.ts` `runAutonomous` is dormant for `loki start` (bash route is live).

## 3. Render point -- iteration END boundary (NOT start)
Render once per iteration, after the provider exits and cost/duration are available, before the loop continues. Insert a single call

```
render_build_hud "$ITERATION_COUNT" "$rarv_phase" "$duration" || true
```

immediately after `duration` is computed (`run.sh:15280`) and after the result-cost file for this iteration has been flushed by the embedded stream parser (~`run.sh:15206-15208`). Iteration start is wrong: current iteration cost/files do not exist yet. Per lock #3, also add a second guarded call on the failure/retry path (same region, after the exit-code log_warn).

## 4. Data sources (reuse only -- do not re-implement)
| Field | Source | Notes |
|---|---|---|
| Phase | `$rarv_phase` (already set `run.sh:14589`) | REASON/ACT/REFLECT/VERIFY. |
| Iteration N/max | `$ITERATION_COUNT` / `$MAX_ITERATIONS` | Already in scope. |
| Cumulative cost | `.loki/context/tracking.json` -> `totals.total_cost_usd` (read pattern at `run.sh:4531`) | Cumulative for the run. Do NOT re-sum result-cost-*.json. |
| Files changed (+/-) | `git diff --shortstat "${_LOKI_RUN_START_SHA}..HEAD"` with the exclude pathspec from `build_completion_summary` (`run.sh:2607-2618`) | Reuse `_LOKI_RUN_START_SHA` (exported `run.sh:14157`) + `':(exclude).loki/' ':(exclude).git/'`. |
| Per-iteration time | `$duration` (`run.sh:15280`) | Already computed. |
| Elapsed (run) | In-process epoch var captured once at loop entry (see SS6) | Parity-safe: var assignment emits no output. |
| ETA | Per lock #1: only when explicit small max or budget cap | Default: omit. |

## 5. Env / TTY gate
HUD renders only when ALL hold (first lines of `render_build_hud`, early `return 0` otherwise):
```
[ -t 1 ] && [ "${BACKGROUND_MODE:-false}" != "true" ] && [ "${LOKI_HUD:-1}" != "0" ]
```
- `[ -t 1 ]` is the established idiom (`run.sh:10241, 13929`).
- `BACKGROUND_MODE` guard mirrors the auto-open gate (`run.sh:10241`), covering `--bg`/`--detach`.

## 6. Rendering approach -- append-only clean line, never `\r`
The agent streams provider output to the same TTY during the iteration. A repainting `\r` bar would fight that stream. Therefore: a single append-only log line emitted only at the iteration boundary (after the stream for that iteration ended), styled like `log_step`/`log_info`. No carriage-return repaint, no cursor save/restore, no background thread. Distinct prefix `[HUD]` in `${CYAN}`/`${NC}` (`run.sh:1005`). Run-elapsed source: `: "${_LOKI_RUN_START_EPOCH:=$(date +%s)}"` placed once before the loop (pure assignment, parity-safe; do NOT stat start-sha mtime -- unreliable on resume).

Illustrative line:
```
[HUD] REASON | iter 3/1000 | $0.42 | +180/-24 (4 files) | took 37s | elapsed 2m11s
```

## 7. set -uo pipefail safety + degrade
- Guard every var with defaults: `${ITERATION_COUNT:-0}`, `${MAX_ITERATIONS:-0}`, `${rarv_phase:-?}`, `${_LOKI_RUN_START_SHA:-}`, `${_LOKI_RUN_START_EPOCH:-}`.
- No `((x++))` from unset/zero; arithmetic only on integer-defaulted values.
- Every external read best-effort: `2>/dev/null || true`, matching existing helpers.
- Degrade: cost unavailable -> OMIT the cost field (never print $0.00 as real, never crash). files unavailable -> omit files field. The call site is `render_build_hud ... || true` so the helper can never abort the loop.

## 8. Byte-identical-off-TTY guarantee (two mechanisms)
1. Gate: helper returns before emitting unless TTY + not background + LOKI_HUD != 0.
2. stdout-only, never tee'd: HUD uses plain `echo`/`printf` to stdout, NEVER piped into `tee -a "$log_file" "$agent_log"` (`run.sh:14643, 14662`). The dashboard reads `.loki/logs/agent.log`; the HUD never enters any `tee -a`, so logs + dashboard are untouched by construction. The stream-json parser reads the provider's stdout pipe, not the orchestrator terminal stdout.

## 9. Parity argument (bash-only HUD is safe)
- `runAutonomous` is dormant for `loki start`; the bash loop is the live route -> no live parity gap.
- `tests/test-bash-bun-parity.sh` compares build_prompt output, PHASE_KEYS/SDLC list, the effort matrix, report/stats stdout -- NOT the autonomous loop terminal stdout. A loop HUD line is invisible to every parity invariant. No Bun mirror required (track a follow-up if runAutonomous becomes live).

## 10. Test plan (`tests/test-build-hud.sh`, wired into run-all-tests)
1. HUD appears on a TTY (pty harness): assert `[HUD]` + `iter 1/`; with a fake tracking.json assert cost field; remove it and assert line still appears without cost (degrade).
2. HUD absent off-TTY byte-identical: capture full stdout off-TTY with LOKI_HUD unset and with LOKI_HUD=0; assert `diff` clean (HUD adds nothing off-TTY).
3. Opt-out on TTY: TTY + LOKI_HUD=0 -> no `[HUD]`.
4. Dashboard/log untouched: after a stubbed TTY iteration, assert `.loki/logs/agent.log` has no `[HUD]` (not tee'd).
5. set -u safety: run helper under `bash -u` with all vars unset; assert exit 0, no unbound error.
6. Regression: `tests/test-bash-bun-parity.sh` still green unchanged.

## 11. Step-by-step task list
Agent A -- implementation (`autonomy/run.sh` only):
1. Add `render_build_hud()` near logging helpers (after `run.sh:1005`); first lines = SS5 gate + early `return 0`; body builds line from present fields only; stdout-only echo; `[HUD]` + CYAN/NC; wrapped so it can never abort the loop.
2. Cumulative-cost read reusing the tracking.json totals pattern (`run.sh:4531`), `2>/dev/null || true`.
3. Files-changed read reusing `git diff --shortstat "${_LOKI_RUN_START_SHA}..HEAD"` + exclude pathspec (`run.sh:2607-2618`).
4. `: "${_LOKI_RUN_START_EPOCH:=$(date +%s)}"` once before the loop.
5. Single call after `duration` at `run.sh:15280`; second guarded call on the failure path (lock #3).
6. Confirm NOT inside any `tee -a`; stdout only.

Agent B -- tests + docs:
7. Write `tests/test-build-hud.sh` (all 6 cases); wire into `tests/run-all-tests.sh`.
8. Document `LOKI_HUD` in `.env.example` + env reference docs.
9. Run the new test + parity test; confirm green + off-TTY byte-identical.
