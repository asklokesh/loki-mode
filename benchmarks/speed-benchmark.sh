#!/usr/bin/env bash
# benchmarks/speed-benchmark.sh -- reproducible build speed + completion benchmark.
#
# Purpose: produce the ONE number we cannot fake -- wall-clock, ACT iteration count,
# and completion verdict for building a FIXED spec from scratch. Used to capture
# before/after when changing the loop (convergence fix) or the council/RARV-C, so any
# "faster" or "more accurate" claim is backed by a real, repeatable measurement.
#
# Design:
#  - Builds a FIXED spec (default: a tiny deterministic CLI spec) from an EMPTY target
#    dir, so the run is reproducible and acceptance is checkable.
#  - Runs the engine from an ISOLATED copy of the source (NEVER the live worktree --
#    the run.sh self-delete/self-mutate hazards). The target dir is separate from the
#    engine copy.
#  - Parses the target's .loki/events.jsonl for the real per-session timeline (splitting
#    on session_start, taking THIS run's session) so numbers are not contaminated by
#    prior runs.
#  - Emits a metrics JSON (benchmarks/results/speed-<label>-<stamp>.json) that is
#    diffable before/after.
#
# Usage:
#   benchmarks/speed-benchmark.sh [--label before|after] [--spec <path>] [--max-iters N] [--timeout-s N]
#
# Honesty: this measures wall-clock and the engine's own completion verdict. It does
# NOT itself judge product correctness beyond the acceptance grep hooks below; extend
# ACCEPTANCE_CHECKS per spec. A run that times out or never completes is reported as
# completed=false with the reason, never silently as success.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="run"
SPEC=""
MAX_ITERS="${LOKI_BENCH_MAX_ITERS:-20}"
TIMEOUT_S="${LOKI_BENCH_TIMEOUT_S:-3600}"

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --spec) SPEC="$2"; shift 2 ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --timeout-s) TIMEOUT_S="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="$REPO_ROOT/benchmarks/results"
mkdir -p "$RESULTS_DIR"
OUT_JSON="$RESULTS_DIR/speed-${LABEL}-${STAMP}.json"

# --- Fixed spec: a tiny, deterministic, fast-to-build CLI so the benchmark is quick
# and its acceptance is checkable. Overridable with --spec for larger specs.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-bench-work-XXXXXX")"
ENGINE="$(mktemp -d "${TMPDIR:-/tmp}/loki-bench-engine-XXXXXX")"
cleanup() { rm -rf "$WORK" "$ENGINE"; }
trap cleanup EXIT INT TERM

if [ -z "$SPEC" ]; then
  SPEC="$WORK/BENCH-SPEC.md"
  cat > "$SPEC" <<'SPECEOF'
# Bench spec: greet CLI

Build a tiny Node.js CLI named `greet`.

## Requirements
1. `node greet.js <name>` prints exactly `Hello, <name>!` and exits 0.
2. `node greet.js` with no argument prints `Hello, world!` and exits 0.
3. Include a test (node --test) that asserts both behaviors.

## Acceptance
- `node greet.js Ada` outputs `Hello, Ada!`
- `npm test` passes.
Keep it minimal. No web server, no dependencies beyond Node built-ins.
SPECEOF
fi

# --- Isolate the engine (copy source; never run from the live worktree) ------
# Copy only what run.sh needs to execute. Fastest: a shallow file copy of the repo
# minus heavy/irrelevant dirs.
( cd "$REPO_ROOT" && \
  rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'benchmarks/results' \
        --exclude '.loki' --exclude 'dashboard-ui/node_modules' --exclude 'web-app/node_modules' \
        ./ "$ENGINE/" 2>/dev/null ) || cp -R "$REPO_ROOT/." "$ENGINE/"

RUN_SH="$ENGINE/autonomy/run.sh"
[ -f "$RUN_SH" ] || { echo "FATAL: run.sh not found in engine copy"; exit 2; }

# --- Prepare the empty target project dir ------------------------------------
mkdir -p "$WORK/project"
( cd "$WORK/project" && git init -q && git config user.email b@b && git config user.name b )

echo "=== Loki speed benchmark [$LABEL] ==="
echo "spec:    $SPEC"
echo "target:  $WORK/project"
echo "engine:  $ENGINE (isolated copy)"
echo "caps:    max_iters=$MAX_ITERS timeout=${TIMEOUT_S}s"
echo "started: $STAMP"

WALL_START=$(date +%s)
# Run the build. Non-interactive, hermetic-ish, no dashboard/app-runner to isolate the
# reason-act-verify loop timing. Council + gates STAY ON (they are the product; we are
# measuring the real pipeline, not a stripped one).
( cd "$WORK/project" && \
  PATH="$PATH" \
  LOKI_TARGET_DIR="$WORK/project" \
  LOKI_PROVIDER=claude \
  LOKI_MAX_ITERATIONS="$MAX_ITERS" \
  LOKI_AUTO_CONFIRM=true \
  LOKI_DASHBOARD=false \
  LOKI_APP_RUNNER=false \
  LOKI_NO_NEW_SESSION=1 \
  CI=true \
  timeout "$TIMEOUT_S" bash "$RUN_SH" "$SPEC" > "$WORK/build.log" 2>&1 )
BUILD_RC=$?
WALL_END=$(date +%s)
WALL_S=$((WALL_END - WALL_START))

# --- Parse THIS run's timeline from the target's events.jsonl ----------------
EVENTS="$WORK/project/.loki/events.jsonl"
python3 - "$EVENTS" "$WORK/build.log" "$WORK/project" "$OUT_JSON" "$LABEL" "$WALL_S" "$BUILD_RC" "$STAMP" <<'PY'
import json, sys, os
from datetime import datetime
events_path, log_path, proj, out_json, label, wall_s, build_rc, stamp = sys.argv[1:9]

def load_events(p):
    if not os.path.exists(p): return []
    out=[]
    for line in open(p):
        line=line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except: pass
    return out

ev = load_events(events_path)
# take only the LAST session (this run)
sess=[]
for e in ev:
    if e.get('type')=='session_start': sess=[e]
    else: sess.append(e)

def ts(e):
    try: return datetime.fromisoformat(e['timestamp'].replace('Z','+00:00'))
    except: return None

iters = [e for e in sess if e.get('type')=='iteration_start']
completes = [e for e in sess if e.get('type')=='iteration_complete']
claims = [e for e in sess if e.get('type')=='task_completion_claim']
ended = any(e.get('type')=='session_end' for e in sess)

# per-iteration real work (start->complete)
starts={}; work=[]
for e in sess:
    d=e.get('data',{}); it=d.get('iteration')
    if e.get('type')=='iteration_start': starts[it]=ts(e)
    elif e.get('type')=='iteration_complete' and starts.get(it):
        w=(ts(e)-starts[it]).total_seconds(); work.append({'iteration':it,'work_s':round(w,1)})

# completion: did the engine reach an honest done? build log signals
log = open(log_path).read() if os.path.exists(log_path) else ''
completed = ('VERIFIED' in log or 'completion' in log.lower()) and build_rc=='0'
# acceptance grep (spec-specific hooks; default greet CLI)
acc = {}
greet = os.path.join(proj,'greet.js')
acc['greet.js_exists'] = os.path.exists(greet)

metrics = {
  'label': label,
  'stamp': stamp,
  'wall_clock_s': int(wall_s),
  'wall_clock_min': round(int(wall_s)/60,1),
  'build_exit_code': int(build_rc),
  'act_iterations': len(iters),
  'iteration_completes': len(completes),
  'completion_claims': len(claims),
  'session_ended': ended,
  'engine_completed': completed,
  'per_iteration_work_s': work,
  'total_iteration_work_min': round(sum(w['work_s'] for w in work)/60,1),
  'max_iteration_work_min': round(max((w['work_s'] for w in work), default=0)/60,1),
  'acceptance': acc,
  'events_total': len(sess),
}
json.dump(metrics, open(out_json,'w'), indent=2)
print(json.dumps(metrics, indent=2))
PY

echo
echo "metrics -> $OUT_JSON"
echo "build log -> (temp, copied below)"
cp "$WORK/build.log" "$RESULTS_DIR/speed-${LABEL}-${STAMP}.build.log" 2>/dev/null || true
echo "build log -> $RESULTS_DIR/speed-${LABEL}-${STAMP}.build.log"
