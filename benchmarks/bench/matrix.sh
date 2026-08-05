#!/usr/bin/env bash
# matrix.sh -- model x harness-config matrix runner for the model-equivalence
# experiment. Sets steering env vars per cell and calls the EXISTING run.sh; no
# adapter or grader change (the grader stays a held-out acceptance exit code).
#
# A cell = (model, config). config in {baseline, full}:
#   baseline = raw model, minimal orchestration (the Replit/Cursor mode)
#   full     = all steering levers on (the harness)
#
# Usage:
#   matrix.sh smoke                  # Stage 0: H.B + O.B on fizzbuzz, N=1 (~$1)
#   matrix.sh pilot                  # Stage 1: H.F vs O.B on 3 hard tasks, N=<TRIALS>
#   matrix.sh cell <model> <config> <task>   # one cell
#
# Env: LOKI_BENCH_TRIALS (default 2), LOKI_BENCH_ISO (isolated engine bin dir on PATH)
# No emojis. No em dashes.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIALS="${LOKI_BENCH_TRIALS:-2}"
# The timeout wraps runner.py run --trials N, i.e. it caps ALL N trials of a cell
# together (not per-trial). A baseline cell (1-2 iterations) fits easily; a FULL
# harness cell (8 iterations + council + code-review + self-heal) on a hard task
# can take 20-40 min PER TRIAL, so 1200s silently killed the full cells before
# runner.py could write a result (the whole reason the first pilot produced no
# haiku-full rows). run_cell() now derives a config-aware default below.
TIMEOUT="${LOKI_BENCH_TIMEOUT:-}"
RESULTS="$SCRIPT_DIR/results"

# hard-2-ledger added 2026-07-31. MEASURED reason: haiku with the harness
# DISABLED passed hard-1-order-api 1/1, and every baseline failure in the whole
# corpus was on simple-2-fizzbuzz. A suite whose only failures are on its
# simplest task cannot separate arms -- more trials buy a tighter interval
# around a ceiling at any spend.
#
# hard-1-order-api states every rule, boundary and worked example, so it
# measures instruction-following. hard-2-ledger withholds them: it says "obey
# the fundamental accounting rule" without naming double-entry, requires
# atomicity without describing rollback, and says money "must not drift"
# without naming Decimal. Verified both directions before adoption -- a
# plausible naive draft fails 6 assertions, a correct implementation passes.
HARD_TASKS="hard-1-order-api hard-2-ledger multifail-1-two-modules tokenheavy-1-crm"

# Baseline (raw model): minimal orchestration -- the giants' "throw the model at it".
baseline_env() {
  # MAX_ITERATIONS=2, not 1: run.sh checks the cap at the TOP of the loop AFTER
  # the post-increment, so a cap of 1 hits before the provider is ever invoked
  # (0 real iterations, null cost). 2 is the minimum for exactly one real
  # provider pass - the honest "raw model, one shot" baseline.
  echo "LOKI_MAX_ITERATIONS=2 LOKI_COUNCIL_ENABLED=false LOKI_PHASE_CODE_REVIEW=false LOKI_SELF_HEAL=0 LOKI_TIER_ROUTING=0 LOKI_AUTO_TUNE=0"
}
# Full harness: every steering lever on.
full_env() {
  echo "LOKI_MAX_ITERATIONS=8 LOKI_COUNCIL_ENABLED=true LOKI_PHASE_CODE_REVIEW=true LOKI_SELF_HEAL=1 LOKI_AUTO_TUNE=1"
}
# Model pin. haiku requires LOKI_ALLOW_HAIKU=true or the router will not drop to it.
model_env() {
  local m="$1"
  case "$m" in
    haiku)  echo "LOKI_SESSION_MODEL=haiku LOKI_ALLOW_HAIKU=true" ;;
    sonnet) echo "LOKI_SESSION_MODEL=sonnet" ;;
    opus)   echo "LOKI_SESSION_MODEL=opus" ;;
    *) echo "LOKI_SESSION_MODEL=$m" ;;
  esac
}

run_cell() {
  local model="$1" config="$2" task="$3"
  local cfg_env cell_timeout
  case "$config" in
    baseline) cfg_env="$(baseline_env)" ;;
    full)     cfg_env="$(full_env)" ;;
    *) echo "unknown config: $config"; return 2 ;;
  esac
  # Config-aware timeout (caps ALL trials of the cell together). An explicit
  # LOKI_BENCH_TIMEOUT always wins; otherwise baseline gets 1200s (1-2 iters is
  # fast) and full gets a generous cap sized for 8 iterations + council +
  # code-review x TRIALS on a hard task. Under-sizing here silently drops the
  # cell (no result written), which is exactly the bug that made the first pilot
  # produce zero haiku-full rows -- so err large.
  if [ -n "$TIMEOUT" ]; then
    cell_timeout="$TIMEOUT"
  elif [ "$config" = "full" ]; then
    cell_timeout=$(( 2400 * (TRIALS > 0 ? TRIALS : 1) ))   # 40 min/trial
  else
    cell_timeout=1200
  fi
  local cell="${model}-${config}"
  echo "==== CELL $cell / $task (trials=$TRIALS, timeout=${cell_timeout}s) ===="
  echo "     env: $(model_env "$model") $cfg_env"
  # Snapshot the newest result file for this task BEFORE the run so we can detect
  # whether this cell actually wrote a NEW one (a timed-out full cell writes none;
  # matrix used to move on silently, hiding the loss).
  local before_newest
  before_newest="$(ls -t "$RESULTS"/"${task}"-loki-*.json 2>/dev/null | head -1)"
  # env -i-free: set only our vars on top of the inherited env; run.sh's adapter
  # merges os.environ so these reach the real loki start.
  # Clear any stray lever vars from a prior cell first, then set this cell's.
  # shellcheck disable=SC2046,SC2086  # model_env/cfg_env emit several VAR=val
  # pairs; the word splitting is exactly what hands them to env as separate
  # assignments. Quoting would pass one string and break every cell.
  env -u LOKI_MAX_ITERATIONS -u LOKI_COUNCIL_ENABLED -u LOKI_PHASE_CODE_REVIEW \
      -u LOKI_SELF_HEAL -u LOKI_TIER_ROUTING -u LOKI_AUTO_TUNE \
      -u LOKI_SESSION_MODEL -u LOKI_ALLOW_HAIKU \
      $(model_env "$model") $cfg_env \
      LOKI_BENCH_TRIALS="$TRIALS" LOKI_BENCH_TIMEOUT="$cell_timeout" \
      LOKI_BENCH_CELL="$cell" \
      bash "$SCRIPT_DIR/run.sh" run "$task" 2>&1 | grep -E "wrote|result:|success|FAIL|error|CELL" | tail -4
  # Verify a NEW result landed for this cell; warn loudly if not (silent cell
  # loss is a fake-completeness failure -- a missing cell must never look "done").
  local after_newest
  after_newest="$(ls -t "$RESULTS"/"${task}"-loki-*.json 2>/dev/null | head -1)"
  if [ -z "$after_newest" ] || [ "$after_newest" = "$before_newest" ]; then
    echo "     WARNING: cell $cell / $task wrote NO new result (likely timed out at ${cell_timeout}s). This cell is MISSING from the report." >&2
    return 1
  fi
}

cmd="${1:-smoke}"
case "$cmd" in
  smoke)
    echo "### STAGE 0 SMOKE: prove the matrix machinery + haiku pin (N=1, ~\$1) ###"
    LOKI_BENCH_TRIALS=1
    run_cell haiku baseline simple-2-fizzbuzz
    run_cell opus  baseline simple-2-fizzbuzz
    echo "### SMOKE DONE ###"
    ;;
  pilot)
    echo "### STAGE 1 PILOT: H.F vs O.B on 3 hard tasks (N=$TRIALS) ###"
    for t in $HARD_TASKS; do run_cell haiku full "$t"; done
    for t in $HARD_TASKS; do run_cell opus baseline "$t"; done
    echo "### PILOT DONE ###"
    ;;
  cell)
    run_cell "$2" "$3" "$4"
    ;;
  *)
    echo "usage: matrix.sh smoke|pilot|cell <model> <config> <task>"; exit 2 ;;
esac
