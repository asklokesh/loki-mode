#!/usr/bin/env bash
# benchmarks/run-ab-trials.sh -- N trials per engine version, appended to a
# persistent history file so improvements stay visible over time.
#
# WHY N TRIALS: a single run of a stochastic agent proves nothing. Iteration
# count varies run to run on identical input, so one arm "winning" once is
# indistinguishable from noise. Medians over >=3 trials, with the spread shown,
# is the minimum that supports a claim.
#
# HELD CONSTANT: same spec, same model, same tier ceiling, same caps, same
# machine. ONLY the engine version differs. Each arm uses its own engine copy
# and target dir, so arms cannot contaminate each other.
#
# Usage:
#   benchmarks/run-ab-trials.sh [--trials N] [--model sonnet|haiku|opus]
#                               [--v7-dir <path>] [--max-iters N] [--timeout-s N]
#
# Appends to benchmarks/results/ab-history.jsonl (gitignored).
# Render with: python3 benchmarks/render-ab-dashboard.py

set -uo pipefail

TRIALS=3
MODEL="sonnet"
V7_DIR="$HOME/loki-bench-v7"
MAX_ITERS=8
TIMEOUT_S=1200
START_AT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --trials)    TRIALS="$2"; shift 2 ;;
    --model)     MODEL="$2"; shift 2 ;;
    --v7-dir)    V7_DIR="$2"; shift 2 ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --timeout-s) TIMEOUT_S="$2"; shift 2 ;;
    --start-at)  START_AT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# NOTE on waiting for a benchmark: never `pgrep -f speed-benchmark`. This
# script's own command line contains that string, so the pattern matches the
# waiter itself and the loop never exits. Match the invocation form instead
# ("bash benchmarks/speed-benchmark.sh"), or just run the benchmark in the
# foreground as this script does.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HISTORY="$REPO_ROOT/benchmarks/results/ab-history.jsonl"
mkdir -p "$(dirname "$HISTORY")"

if [ ! -d "$V7_DIR" ]; then
  echo "v7 worktree not found at $V7_DIR" >&2
  echo "create it with: git worktree add $V7_DIR 0bcd9110 --detach" >&2
  exit 1
fi

echo "A/B trials: ${TRIALS} per arm | model=${MODEL} | max_iters=${MAX_ITERS} | timeout=${TIMEOUT_S}s"
echo "history -> $HISTORY"
echo ""

# Run a command with a hard wall-clock ceiling. macOS ships no GNU `timeout`,
# so this is a watchdog: background the command, sleep the cap, kill the process
# GROUP if it is still alive (the harness spawns children that outlive a bare
# kill on the parent).
_run_capped() {
  local cap="$1"; shift
  set -m
  "$@" >/dev/null 2>&1 &
  local pid=$!
  ( sleep "$cap"; kill -0 "$pid" 2>/dev/null && kill -9 -"$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watchdog" 2>/dev/null
  set +m
  return $rc
}

# Append one run's metrics to history, tagged with its arm.
# Reads the NEWEST file matching the label so a re-run cannot pick up a stale
# result from a previous invocation.
_record() {
  local arm="$1" label="$2" root="$3"
  local f
  f=$(ls -t "$root"/benchmarks/results/speed-"$label"-*.json 2>/dev/null | head -1)
  if [ -z "$f" ]; then
    # Record the miss rather than dropping the cell. A run that timed out or
    # crashed before its writer ran leaves NO file; a runner that stayed silent
    # here would make the missing cell look like it never ran.
    echo "  WARN: no metrics file for $label -- run produced no result" >&2
  fi
  # Build the row in a temp file, then append only once it is known-complete.
  # Appending python's stdout straight to $HISTORY would leave a half-written
  # line if serialization raised -- the renderer skips unparseable lines, so
  # that trial would vanish silently, defeating the whole point of the
  # 'missing' marker.
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/ab-row.XXXXXX") || return
  if python3 -c "
import json,sys,time
arm,label,model,src=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
d=json.load(open(src)) if src else {'label':label,'missing':True}
d['arm']=arm; d['model']=model
d['recorded_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
sys.stdout.write(json.dumps(d)+chr(10))
sys.stderr.write('  iters=%s wall=%s completed=%s acceptance=%s%s' % (
    d.get('act_iterations','--'), d.get('wall_clock_min','--'),
    d.get('engine_completed','--'), d.get('acceptance','--'), chr(10)))
" "$arm" "$label" "$MODEL" "$f" > "$tmp"; then
    cat "$tmp" >> "$HISTORY"
  else
    echo "  ERROR: could not serialize row for $label" >&2
  fi
  rm -f "$tmp"
}

_end=$((START_AT + TRIALS - 1))
for i in $(seq "$START_AT" "$_end"); do
  echo "=== trial $i ==="

  # Hard wall on the HARNESS, above the engine's own timeout. Observed
  # 2026-07-28: the engine finished and wrote completion.json, but the harness
  # wrapper stayed alive indefinitely with no running children and never wrote
  # metrics. Without this ceiling one hung wrapper stalls the whole matrix.
  HARNESS_CAP=$(( TIMEOUT_S + 600 ))

  echo "-- v8.0.0"
  ( cd "$REPO_ROOT" && \
    LOKI_SESSION_MODEL="$MODEL" LOKI_MAX_TIER="$MODEL" \
    LOKI_BENCH_MAX_ITERS="$MAX_ITERS" LOKI_BENCH_TIMEOUT_S="$TIMEOUT_S" \
    _run_capped "$HARNESS_CAP" bash benchmarks/speed-benchmark.sh --label "v8-${MODEL}-t${i}" )
  _record v8 "v8-${MODEL}-t${i}" "$REPO_ROOT"

  echo "-- v7.129.5"
  ( cd "$V7_DIR" && \
    LOKI_SESSION_MODEL="$MODEL" LOKI_MAX_TIER="$MODEL" \
    LOKI_BENCH_MAX_ITERS="$MAX_ITERS" LOKI_BENCH_TIMEOUT_S="$TIMEOUT_S" \
    _run_capped "$HARNESS_CAP" bash benchmarks/speed-benchmark.sh --label "v7-${MODEL}-t${i}" )
  _record v7 "v7-${MODEL}-t${i}" "$V7_DIR"

  echo ""
  python3 "$REPO_ROOT/benchmarks/render-ab-dashboard.py" >/dev/null 2>&1 || true
done

echo "done. dashboard: benchmarks/results/ab-dashboard.html"
