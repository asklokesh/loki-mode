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
ROUTE="${LOKI_BENCH_ROUTE:-bash}"

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --spec) SPEC="$2"; shift 2 ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --timeout-s) TIMEOUT_S="$2"; shift 2 ;;
    # WHICH ROUTE TO MEASURE. Every number in this repo's speed corpus is from
    # the BASH route, because this harness hardcoded run.sh -- and the two
    # routes differ on exactly the axis the agent line measures: loki-ts sends
    # a cache_control:ephemeral prefix (sdk_invoker.ts:54), run.sh pipes one
    # string through `claude -p` and cannot express caching at all.
    --route)     ROUTE="$2"; shift 2 ;;
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

# Route selection. REFUSES an unknown value rather than falling back to bash:
# a silent fallback would label a bash run "bun" and put a wrong number in the
# corpus, which is worse than not running.
case "$ROUTE" in
  bash) ;;
  bun)
    if [ ! -f "$ENGINE/loki-ts/dist/loki.js" ] && [ ! -f "$ENGINE/loki-ts/src/cli.ts" ]; then
      echo "FATAL: --route bun but neither loki-ts/dist/loki.js nor src/cli.ts is in the engine copy" >&2
      exit 2
    fi
    command -v bun >/dev/null 2>&1 || { echo "FATAL: --route bun but bun is not on PATH" >&2; exit 2; }
    ;;
  *) echo "FATAL: unknown --route '$ROUTE' (want: bash|bun)" >&2; exit 2 ;;
esac

# --- Prepare the empty target project dir ------------------------------------
mkdir -p "$WORK/project"
( cd "$WORK/project" && git init -q && git config user.email b@b && git config user.name b )

echo "=== Loki speed benchmark [$LABEL] ==="
echo "spec:    $SPEC"
echo "target:  $WORK/project"
echo "engine:  $ENGINE (isolated copy)"
echo "route:   $ROUTE"
echo "caps:    max_iters=$MAX_ITERS timeout=${TIMEOUT_S}s"
echo "started: $STAMP"

# --kill-after: plain `timeout` signals the DIRECT child only. The engine spawns
# children (provider CLI, gates, app-runner) that can ignore or outlive that
# TERM -- a run was observed alive 18 minutes AFTER the engine had written
# completion.json, stalling the whole A/B matrix behind it. Follow up with KILL
# so the cap is actually enforced.
#
# The LOKI_* assignments below are a command-prefix env list for the `timeout`
# child, so shellcheck's SC2034 ("appears unused") is a false positive here --
# it cannot see they are passed to another process.
# Runner selection as an ARRAY, built before the subshell. A $( ... ) inside
# the command line is expanded to a bare word and was silently producing the
# BASH runner for --route bun: the smoke test reported route=bash with zero bun
# markers. Same class of bug as the ${GRADER:+VAR=val} env-prefix expansion --
# an expanded word is not a command or an assignment.
_runner_argv=(bash "$RUN_SH")
_legacy_bash=1
if [ "$ROUTE" = "bun" ]; then
    _runner_argv=(bash "$ENGINE/bin/loki" start)
    _legacy_bash=0
fi

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
  LOKI_BENCH_ROUTE="$ROUTE" \
  LOKI_LEGACY_BASH="$_legacy_bash" \
  timeout --kill-after=60 "$TIMEOUT_S" \
    "${_runner_argv[@]}" "$SPEC" > "$WORK/build.log" 2>&1 )
BUILD_RC=$?
WALL_END=$(date +%s)
WALL_S=$((WALL_END - WALL_START))

# --- Parse THIS run's timeline from the target's events.jsonl ----------------
EVENTS="$WORK/project/.loki/events.jsonl"
LOKI_BENCH_SPEC_PATH="$SPEC" LOKI_BENCH_ROUTE="$ROUTE" python3 - "$EVENTS" "$WORK/build.log" "$WORK/project" "$OUT_JSON" "$LABEL" "$WALL_S" "$BUILD_RC" "$STAMP" <<'PY'
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

# Sum stage_complete durations per stage. Summed, not last-wins: a gate that
# runs once per iteration should show its TOTAL cost across the build, which is
# what an optimisation decision needs.
stage_durations = {}
for e in sess:
    if e.get('type') != 'stage_complete':
        continue
    d = e.get('data', {}) or {}
    st_name = d.get('stage')
    try:
        st_dur = int(d.get('duration_s', 0))
    except (TypeError, ValueError):
        continue
    if st_name:
        stage_durations[st_name] = stage_durations.get(st_name, 0) + st_dur

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
# Acceptance: FILE-EXISTENCE assertions only. This proves the engine produced the
# artifacts the spec named; it is NOT a judgment of code quality, and must never
# be reported as one. Keyed off the spec so a custom --spec is not scored against
# the default CLI's greet.js (which would always report a meaningless failure).
acc = {}
spec_txt = ''
_spec_path = os.environ.get('LOKI_BENCH_SPEC_PATH', '')
_spec_readable = None          # None = no spec was requested at all
if _spec_path:
    try:
        spec_txt = open(_spec_path).read()
        _spec_readable = True
    except Exception:
        # A REQUESTED SPEC THAT CANNOT BE READ IS NOT A DEFAULT RUN. Falling
        # through with spec_txt='' sends this to the greet branch, which then
        # records greet.js_exists for a build that was never asked to produce
        # greet.js -- a silently WRONG acceptance value on a run that looks
        # completely normal. Caught exactly that way: a --task ablation
        # reported greet.js_exists while claiming to measure hard-1-order-api.
        _spec_readable = False
if 'Task API service' in spec_txt:
    for f in ('server.js','store.js','README.md'):
        acc[f + '_exists'] = os.path.exists(os.path.join(proj,f))
    # at least one test file, whatever the build chose to name it
    acc['test_file_exists'] = any(
        n.endswith('.test.js') or n.startswith('test-') or n.startswith('test_')
        for n in (os.listdir(proj) if os.path.isdir(proj) else []))
_grader = os.environ.get('LOKI_BENCH_GRADER', '')
if _grader and os.path.isfile(_grader):
    # A REAL HELD-OUT GRADER BEATS EVERY HEURISTIC HERE. The file-existence
    # checks below say a build produced something with the right NAME; a
    # grader imports the artifact and asserts the contract. It is copied in
    # AFTER the run, so the agent never sees it and cannot write to satisfy it.
    # Exit 0 is the only pass.
    import shutil, subprocess
    _dst = os.path.join(proj, os.path.basename(_grader))
    try:
        shutil.copy(_grader, _dst)
        _r = subprocess.run([sys.executable, os.path.basename(_grader)],
                            cwd=proj, capture_output=True, text=True, timeout=120)
        acc['graded'] = (_r.returncode == 0)
        if _r.returncode != 0:
            # Kept short: the reason belongs in the row, the transcript does not.
            acc['grader_stderr'] = (_r.stdout or _r.stderr or '')[-300:]
    except Exception as _e:
        # A grader that could not RUN is an absent measurement, not a failure.
        # Recording it as graded=False would blame the build for our harness.
        acc['grader_error'] = str(_e)[:200]
    finally:
        try:
            os.remove(_dst)
        except OSError:
            pass
elif _spec_readable is False:
    # Refuse to score it. The build may have been perfect; we simply do not
    # know what it was asked to do, and any check we pick here is a guess.
    acc['spec_unreadable'] = True
    acc['spec_path'] = _spec_path[-120:]
elif _spec_readable is None or 'greet CLI' in spec_txt:
    acc['greet.js_exists'] = os.path.exists(os.path.join(proj,'greet.js'))
else:
    # A CUSTOM --spec WITH NO MATCHING ACCEPTANCE CHECK. Falling through to
    # greet.js_exists here would be a guaranteed FALSE NEGATIVE: that file can
    # never exist for a spec that does not ask for it, so every trial would
    # record acceptance=False and an ablation would read as a total regression
    # in both arms. An absent measurement must not masquerade as a failed one.
    #
    # The generic checks below are deliberately weak -- they say the build
    # produced SOMETHING and left a test behind, not that it met the spec --
    # and the unmatched flag says so, so no caller can mistake this for a
    # spec-level pass. Add a branch above when you add a spec.
    acc['spec_acceptance_unmatched'] = True
    acc['produced_files'] = bool(
        [n for n in (os.listdir(proj) if os.path.isdir(proj) else [])
         if not n.startswith('.')])
    acc['test_file_exists'] = any(
        n.endswith('.test.js') or n.startswith('test-') or n.startswith('test_')
        for n in (os.listdir(proj) if os.path.isdir(proj) else []))

metrics = {
  'label': label,
  'stamp': stamp,
  # Which prompt arm produced this row. Recorded from the environment the
  # engine actually ran under, NOT from the label, so a mislabelled invocation
  # cannot silently attribute a result to the wrong arm.
  'prompt_arm': 'simple' if os.environ.get('LOKI_SIMPLE') == '1' else 'full',
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
  'route': os.environ.get('LOKI_BENCH_ROUTE', 'bash'),
  # PER-GATE DURATIONS. The engine has emitted stage_complete{stage,duration_s}
  # for 11 gates all along, and this harness parsed the events file and threw
  # them away -- so "84% of a build is overhead" was measurable but not
  # ATTRIBUTABLE, and nobody could say which gate to fix. Preserved here so the
  # next optimisation targets the real cost instead of the first guess.
  'stage_durations_s': stage_durations,
  'stage_total_s': sum(stage_durations.values()),
}
json.dump(metrics, open(out_json,'w'), indent=2)
print(json.dumps(metrics, indent=2))
PY

echo
echo "metrics -> $OUT_JSON"
echo "build log -> (temp, copied below)"
cp "$WORK/build.log" "$RESULTS_DIR/speed-${LABEL}-${STAMP}.build.log" 2>/dev/null || true
echo "build log -> $RESULTS_DIR/speed-${LABEL}-${STAMP}.build.log"
