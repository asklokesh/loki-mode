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
SPEC=""
GRADER=""
TASK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --trials)    TRIALS="$2"; shift 2 ;;
    --model)     MODEL="$2"; shift 2 ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --timeout-s) TIMEOUT_S="$2"; shift 2 ;;
    # A HARDER SPEC IS THE POINT OF THIS FLAG. The default greet CLI completes
    # in ONE iteration, so a prompt that coaches planning, decomposition and
    # gate recovery has nothing to do -- a null result there says the ablation
    # is safe on a task that exercises none of what the prompt is for.
    --spec)      SPEC="$2"; shift 2 ;;
    # A HELD-OUT GRADER, copied in only AFTER the run so the agent never sees
    # it. This is what makes a harder ablation meaningful: file-existence
    # heuristics say a build produced the right FILENAME, a grader asserts the
    # contract. Verified satisfiable AND strict before use -- a correct
    # order_api.py passes, a naive one that skips validation fails.
    --grader)    GRADER="$2"; shift 2 ;;
    # Shorthand for the two above, from benchmarks/bench/tasks/<id>.json.
    --task)      TASK="$2"; shift 2 ;;
    -h|--help)   sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HISTORY="$REPO_ROOT/benchmarks/results/prompt-ablation.jsonl"

# --task <id> resolves the spec and grader from benchmarks/bench/tasks/<id>.json,
# so an operator does not have to know where either lives. Fails LOUDLY on an
# unknown id or a missing overlay: silently falling back to the greet spec would
# run a whole ablation against the wrong task and look like a valid result.
if [ -n "$TASK" ]; then
  _task_json="$REPO_ROOT/benchmarks/bench/tasks/${TASK}.json"
  if [ ! -f "$_task_json" ]; then
    echo "unknown --task '$TASK' (no $_task_json)" >&2
    echo "available: $(ls "$REPO_ROOT/benchmarks/bench/tasks/" 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
    exit 2
  fi
  # The template MUST end in XXXXXX -- BSD mktemp fails with a suffix after
  # it ("mkstemp failed ... File exists"), which silently left SPEC empty and
  # the guard below then refused the whole run. Renamed to .md afterwards
  # because speed-benchmark.sh reads the spec by path, not by extension.
  SPEC="$(mktemp "${TMPDIR:-/tmp}/loki-taskspec-XXXXXX")" || {
    echo "could not create a temp spec file" >&2; exit 2; }
  python3 - "$_task_json" "$SPEC" <<'TASKPY' || exit 2
import json, sys
d = json.load(open(sys.argv[1]))
open(sys.argv[2], "w").write(d.get("prompt", ""))
TASKPY
  if [ ! -s "$SPEC" ]; then
    echo "--task '$TASK' has an empty prompt; refusing to run" >&2
    exit 2
  fi
  _overlay="$(python3 -c "
import json,sys
print((json.load(open(sys.argv[1])).get('acceptance') or {}).get('overlay',''))" "$_task_json")"
  if [ -n "$_overlay" ]; then
    _g="$REPO_ROOT/benchmarks/bench/tasks/$_overlay/check_acceptance.py"
    if [ -f "$_g" ]; then
      GRADER="$_g"
    else
      echo "--task '$TASK' declares an overlay but $_g is missing; refusing" >&2
      exit 2
    fi
  fi
  echo "task:    $TASK  (spec $(wc -c < "$SPEC" | tr -d ' ') bytes, grader ${GRADER:-none})"
fi
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
import json, os, sys, time
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
# REFUSE A DUPLICATE. _record picks the newest speed-<label>-*.json, so a run
# that produced NO new file silently re-records the previous one -- observed
# when a --task run aborted and appended 6 stale rows, inflating n and faking
# significance. Keyed on (stamp, arm): the stamp is minted per benchmark run,
# so a repeat means no new trial happened.
_key = (d.get('stamp'), d.get('prompt_arm') or d.get('arm'))
if os.path.exists(hist):
    for _line in open(hist):
        _line = _line.strip()
        if not _line:
            continue
        try:
            _prev = json.loads(_line)
        except Exception:
            continue
        if (_prev.get('stamp'), _prev.get('prompt_arm') or _prev.get('arm')) == _key:
            sys.stderr.write(
                "  ERROR: duplicate trial (stamp %s, arm %s) -- the benchmark "
                "produced no new result file. NOT recorded.\n" % _key)
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
    # LOKI_ABL_LOGDIR captures each trial's output. Default /dev/null keeps
    # the run quiet; set it when a trial produces no result file and you need
    # to see WHY, which is otherwise invisible.
    _trial_log=/dev/null
    [ -n "${LOKI_ABL_LOGDIR:-}" ] && { mkdir -p "$LOKI_ABL_LOGDIR"; _trial_log="$LOKI_ABL_LOGDIR/${label}.log"; }
    ( cd "$REPO_ROOT" && \
      LOKI_SIMPLE="$simple_val" \
      LOKI_SESSION_MODEL="$MODEL" LOKI_MAX_TIER="$MODEL" \
      LOKI_BENCH_MAX_ITERS="$MAX_ITERS" LOKI_BENCH_TIMEOUT_S="$TIMEOUT_S" \
      LOKI_BENCH_GRADER="$GRADER" \
      _run_capped "$HARNESS_CAP" bash benchmarks/speed-benchmark.sh --label "$label" \
      ${SPEC:+--spec "$SPEC"} \
      > "$_trial_log" 2>&1 )
    _record "$arm" "$label"
  done
  echo ""
done

echo "=== summary ==="
python3 "$SCRIPT_DIR/report-prompt-ablation.py" "$HISTORY" || true
