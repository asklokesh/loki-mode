#!/usr/bin/env bash
# benchmarks/bench/run.sh -- thin bash wrapper for `loki bench`.
#
# Delegates to the shared python core (runner.py). Mirrors magic-ab/run.sh's
# workdir + timeout + rc(124) handling. The python core does the real work:
# fixture copy -> adapter invoke -> HELD-OUT GRADE (success = acceptance exit 0)
# -> result-row. Bash only parses args, enforces a wall-clock cap, and routes.
#
# Subcommands:
#   run <task>     Run Loki only on <task>. (LOKI adapter)
#   vs <task>      Run all configured tools on <task> (head-to-head).
#   list           List available task-specs.
#   verify <file>  Recompute task_hash + re-check tool versions for a result.
#   report <files> Build results.json + RESULTS.md from per-tool result-rows.
#
# CREDIBILITY: Loki NEVER grades itself. The grader runs the held-out acceptance
# command OUTSIDE the agent and decides success by exit code. No council /
# RARV-C / LLM-judge in scoring.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/runner.py"
REPORT="$SCRIPT_DIR/report.py"
TASKS_DIR="$SCRIPT_DIR/tasks"
RESULTS_DIR="$SCRIPT_DIR/results"
PYTHON="${LOKI_BENCH_PYTHON:-python3}"

TRIALS="${LOKI_BENCH_TRIALS:-3}"
MODEL=""
EMIT_PROOF=false
TIMEOUT_SECS="${LOKI_BENCH_TIMEOUT:-3600}"   # hard wall-clock cap per task run

# Tools used by `vs`. Loki always first; competitors are real adapters that
# EXIST + are mock-tested but are NOT executed for paid runs in R2 unless the
# operator opts in. manual.py records externally-supplied (unverified) numbers.
VS_TOOLS="${LOKI_BENCH_VS_TOOLS:-loki}"

usage() {
    cat <<'EOF'
loki bench - head-to-head benchmark harness (R2)

Usage: loki bench <subcommand> [args] [options]

Subcommands:
  run <task>      Run Loki only on a task-spec
  vs <task>       Run all configured tools on a task-spec (head-to-head)
  list            List available task-specs
  verify <file>   Recompute task_hash + check tool versions for a result.json
  report <files>  Build results.json + RESULTS.md from per-tool result-rows

Options:
  --trials N      Number of trials per tool (default 3)
  --model NAME    Override the model
  --emit-proof    Emit an R1 proof-of-run for the Loki trial(s)
  --out-dir DIR   (report) output dir for results.json + RESULTS.md

Loki NEVER grades its own success. Success is decided by a held-out acceptance
command run by the grader OUTSIDE the agent. See benchmarks/SCHEMA-result.md.
EOF
}

# Parse leading subcommand.
SUB="${1:-}"
[ $# -gt 0 ] && shift || true

# Parse options + positionals. POSITIONAL holds the first positional (run/vs/
# verify take exactly one); POSITIONALS accumulates all of them (report takes
# one or more result files). Branch on $POSITIONALS count to avoid bash 3.2
# empty-array-under-set-u pitfalls.
POSITIONAL=""
POSITIONALS=""
OUT_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --trials)     TRIALS="$2"; shift 2 ;;
        --model)      MODEL="$2"; shift 2 ;;
        --emit-proof) EMIT_PROOF=true; shift ;;
        --timeout)    TIMEOUT_SECS="$2"; shift 2 ;;
        --out-dir)    OUT_DIR="$2"; shift 2 ;;
        -h|--help)    usage; exit 0 ;;
        -*)           echo "unknown option: $1" >&2; exit 2 ;;
        *)            [ -z "$POSITIONAL" ] && POSITIONAL="$1"
                      POSITIONALS="$POSITIONALS $1"; shift ;;
    esac
done

if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "python3 not found on PATH" >&2
    exit 2
fi
[ -f "$RUNNER" ] || { echo "runner not found: $RUNNER" >&2; exit 2; }

ts() { date -u +%Y%m%dT%H%M%SZ; }

# Portable timeout: GNU coreutils `timeout`, then `gtimeout` (brew on macOS),
# else run without a cap (warn once). A bare macOS host lacks `timeout`; the
# harness must still run for a stranger rather than hard-fail.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
fi
with_timeout() {
    # usage: with_timeout <secs> <cmd...>
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" "${secs}s" "$@"
    else
        echo "WARN: no 'timeout'/'gtimeout' on PATH; running without wall-clock cap" >&2
        "$@"
    fi
}

# Resolve a task argument: a bare id maps to tasks/<id>.json, else used as path.
resolve_task() {
    local arg="$1"
    if [ -f "$arg" ]; then
        echo "$arg"; return 0
    fi
    if [ -f "$TASKS_DIR/$arg.json" ]; then
        echo "$TASKS_DIR/$arg.json"; return 0
    fi
    echo "$arg"   # let the runner report the precise error
}

# Run one adapter on one task with a hard wall-clock cap. Writes a result-row.
run_one() {
    local adapter="$1"
    local task_path="$2"
    local stamp; stamp=$(ts)
    mkdir -p "$RESULTS_DIR"
    local base; base="$(basename "$task_path" .json)"
    local resfile="$RESULTS_DIR/${base}-${adapter}-${stamp}.json"

    echo "=== $adapter on $base (trials=$TRIALS) ==="
    # NOTE: avoid empty-array expansion under `set -u` (bash 3.2 on macOS treats
    # "${arr[@]}" as unbound when arr is empty). Branch on $MODEL instead.
    if [ -n "$MODEL" ]; then
        with_timeout "$TIMEOUT_SECS" "$PYTHON" "$RUNNER" run "$task_path" \
            --adapter "$adapter" --trials "$TRIALS" --model "$MODEL" --out "$resfile"
    else
        with_timeout "$TIMEOUT_SECS" "$PYTHON" "$RUNNER" run "$task_path" \
            --adapter "$adapter" --trials "$TRIALS" --out "$resfile"
    fi
    local rc=$?
    if [ $rc -eq 124 ]; then
        echo "TIMEOUT after ${TIMEOUT_SECS}s: $adapter on $base" >&2
        return 124
    elif [ $rc -ne 0 ]; then
        echo "ERROR (rc=$rc): $adapter on $base" >&2
        return "$rc"
    fi
    echo "result: $resfile"

    if [ "$EMIT_PROOF" = "true" ] && [ "$adapter" = "loki" ]; then
        # Best-effort R1 proof emission for the Loki run (non-fatal).
        if command -v loki >/dev/null 2>&1; then
            loki proof list >/dev/null 2>&1 || true
            echo "(--emit-proof) latest Loki proof: run 'loki proof list'"
        fi
    fi
    return 0
}

case "$SUB" in
    ""|-h|--help|help)
        usage
        [ "$SUB" = "" ] && exit 1
        exit 0
        ;;
    run)
        [ -n "$POSITIONAL" ] || { echo "missing task. Usage: loki bench run <task>" >&2; exit 2; }
        TASK_PATH="$(resolve_task "$POSITIONAL")"
        run_one loki "$TASK_PATH"
        exit $?
        ;;
    vs)
        [ -n "$POSITIONAL" ] || { echo "missing task. Usage: loki bench vs <task>" >&2; exit 2; }
        TASK_PATH="$(resolve_task "$POSITIONAL")"
        overall_rc=0
        for tool in $VS_TOOLS; do
            run_one "$tool" "$TASK_PATH" || overall_rc=$?
        done
        exit $overall_rc
        ;;
    list)
        if [ ! -d "$TASKS_DIR" ]; then
            echo "No tasks found. (expected $TASKS_DIR)"
            exit 0
        fi
        found=0
        for tj in "$TASKS_DIR"/*.json; do
            [ -f "$tj" ] || continue
            found=1
            id="$("$PYTHON" -c "import json,sys; print(json.load(open(sys.argv[1])).get('id','?'))" "$tj" 2>/dev/null || echo "?")"
            src="$("$PYTHON" -c "import json,sys; print(json.load(open(sys.argv[1])).get('source','?'))" "$tj" 2>/dev/null || echo "?")"
            printf '%-40s  %-24s  %s\n' "$id" "$src" "$(basename "$tj")"
        done
        [ "$found" = "0" ] && echo "No task-specs in $TASKS_DIR"
        exit 0
        ;;
    verify)
        [ -n "$POSITIONAL" ] || { echo "missing result file. Usage: loki bench verify <result.json>" >&2; exit 2; }
        "$PYTHON" "$RUNNER" verify "$POSITIONAL"
        exit $?
        ;;
    report)
        [ -n "$POSITIONAL" ] || { echo "missing result file(s). Usage: loki bench report <result.json> [more.json ...] [--out-dir DIR]" >&2; exit 2; }
        [ -f "$REPORT" ] || { echo "report generator not found: $REPORT" >&2; exit 2; }
        # POSITIONALS holds every result file (per-tool runner outputs merge into
        # one leaderboard). Default the output dir to RESULTS_DIR.
        out_dir="${OUT_DIR:-$RESULTS_DIR}"
        # shellcheck disable=SC2086 -- intentional word-split of accumulated paths.
        "$PYTHON" "$REPORT" $POSITIONALS --out-dir "$out_dir"
        exit $?
        ;;
    *)
        echo "unknown subcommand: $SUB" >&2
        usage
        exit 2
        ;;
esac
