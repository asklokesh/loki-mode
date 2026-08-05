#!/usr/bin/env bash
# benchmarks/run-prompt-ablation.sh -- does deleting the coaching prompt help,
# hurt, or do nothing? N trials per arm, both arms in ONE engine copy.
#
# THE QUESTION. LOKI_SIMPLE=1 cuts the prompt 78% (measured, both routes). That
# is a TOKEN measurement and it licenses no claim at all about outcomes. This
# harness answers the only question that matters: does the stripped arm build
# the same thing, faster or slower, more or less reliably?
#
# WHY BOTH ARMS IN ONE ENGINE COPY. run-ab-trials.sh varies ENGINE VERSION
# across two worktrees, which is right for a release comparison and wrong here:
# it introduces a whole second checkout as a confound. Here the ONLY difference
# between arms is one environment variable read at prompt-assembly time. Same
# binary, same spec, same model, same caps, same machine.
#
# WHY N TRIALS, restated because it is the entire reason this file is not a
# one-liner: a single run of a stochastic agent proves nothing. Iteration count
# and wall clock vary run to run on identical input, so one arm "winning" once
# is indistinguishable from noise. Report MEDIANS WITH SPREAD, never a single
# number, and never a mean over 3 points.
#
# THE FOUR METRICS, as asked for:
#   speed        wall_clock_min, from the engine's own events -- never `ps etime`
#                on a supervising process, which reports the waiter's lifetime.
#   reliability  acceptance (did the built thing actually satisfy the spec)
#                and engine_completed.
#   consistency  the SPREAD across trials at fixed input. Usually skipped, and
#                the most likely place for prompt bloat to show up: bloat tends
#                to add variance before it moves the median.
#   cost         usd + tokens from the receipt. An unmeasured run reads UNKNOWN,
#                never $0.00 -- absent is not zero.
#
# Usage:
#   benchmarks/run-prompt-ablation.sh [--trials N] [--model sonnet|haiku|opus]
#                                     [--max-iters N] [--timeout-s N]
#
# Appends to benchmarks/results/prompt-ablation.jsonl (gitignored).

set -uo pipefail

TRIALS=3
MODEL="sonnet"
MAX_ITERS=8
TIMEOUT_S=1200

while [ $# -gt 0 ]; do
  case "$1" in
    --trials)    TRIALS="$2"; shift 2 ;;
    --model)     MODEL="$2"; shift 2 ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --timeout-s) TIMEOUT_S="$2"; shift 2 ;;
    -h|--help)   sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HISTORY="$REPO_ROOT/benchmarks/results/prompt-ablation.jsonl"
mkdir -p "$(dirname "$HISTORY")"

echo "prompt ablation: ${TRIALS} trials/arm | model=${MODEL} | max_iters=${MAX_ITERS}"
echo "arms: full (default) vs simple (LOKI_SIMPLE=1)"
echo "history -> $HISTORY"
echo ""

# Hard wall ABOVE the engine's own timeout. Observed 2026-07-28: the engine
# finished and wrote its metrics, but the harness wrapper stayed alive with no
# running children and never returned. Without this ceiling one hung wrapper
# stalls the whole matrix.
HARNESS_CAP=$(( TIMEOUT_S + 600 ))

_run_capped() {
  local cap="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$cap" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$cap" "$@"
  else
    "$@"
  fi
}

_record() {
  local arm="$1" label="$2"
  # Find the metrics file this trial just wrote. Newest match wins.
  local f
  f=$(ls -t "$REPO_ROOT/benchmarks/results/speed-${label}"-*.json 2>/dev/null | head -1)
  if [ -z "$f" ] || [ ! -f "$f" ]; then
    # A trial that timed out before its writer ran produces NO result file. A
    # runner that greps stdout would advance silently and the missing cell
    # would look "done". Say so loudly instead.
    echo "  WARNING: arm=$arm label=$label produced NO metrics file." >&2
    echo "           This cell is MISSING, not zero. It is excluded from the" >&2
    echo "           medians below rather than counted as a result." >&2
    return
  fi
  python3 - "$arm" "$f" "$HISTORY" <<'PY'
import json, sys, time
arm, src, hist = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
d['arm'] = arm
d['recorded_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
# Cross-check: the engine stamps prompt_arm from its OWN environment. If the
# harness label and the engine disagree, the attribution is wrong and every
# median built on it is wrong. Fail loud rather than average the two arms.
stamped = d.get('prompt_arm')
if stamped is not None and stamped != arm:
    sys.stderr.write(
        "  ERROR: arm mismatch -- harness says %r, engine stamped %r. "
        "NOT recorded.\n" % (arm, stamped))
    sys.exit(1)
with open(hist, 'a') as fh:
    fh.write(json.dumps(d) + "\n")
sys.stderr.write("  arm=%-6s iters=%-3s wall=%-5s completed=%-5s acceptance=%s\n" % (
    arm, d.get('act_iterations','--'), d.get('wall_clock_min','--'),
    d.get('engine_completed','--'), d.get('acceptance','--')))
PY
}

for i in $(seq 1 "$TRIALS"); do
  echo "=== trial $i / $TRIALS ==="

  for arm in full simple; do
    simple_val=0
    [ "$arm" = "simple" ] && simple_val=1
    label="${arm}-${MODEL}-t${i}"
    echo "-- arm: $arm"
    ( cd "$REPO_ROOT" && \
      LOKI_SIMPLE="$simple_val" \
      LOKI_SESSION_MODEL="$MODEL" LOKI_MAX_TIER="$MODEL" \
      LOKI_BENCH_MAX_ITERS="$MAX_ITERS" LOKI_BENCH_TIMEOUT_S="$TIMEOUT_S" \
      _run_capped "$HARNESS_CAP" bash benchmarks/speed-benchmark.sh --label "$label" \
      >/dev/null 2>&1 )
    _record "$arm" "$label"
  done
  echo ""
done

echo "=== summary ==="
python3 "$SCRIPT_DIR/report-prompt-ablation.py" "$HISTORY" || true
