#!/usr/bin/env bash
# Magic Modules A/B benchmark runner.
#
# Runs `loki start` twice on the same PRD: once with the magic debate gate
# enabled (arm A, the default) and once with it disabled (arm B). Captures
# metrics into benchmarks/magic-ab/results/{A,B}-<ts>.json so compare.py can
# diff them.
#
# This script REQUIRES a real provider (claude CLI logged in by default).
# Each arm consumes real tokens. Do not run in CI.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

PRD="$SCRIPT_DIR/prd.md"
MAX_ITER=8
SKIP_A=false
SKIP_B=false
PROVIDER="${LOKI_PROVIDER:-claude}"
TIMEOUT_SECS=900   # 15 min per arm

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prd)             PRD="$2"; shift 2 ;;
        --max-iterations)  MAX_ITER="$2"; shift 2 ;;
        --skip-a)          SKIP_A=true; shift ;;
        --skip-b)          SKIP_B=true; shift ;;
        --provider)        PROVIDER="$2"; shift 2 ;;
        --timeout)         TIMEOUT_SECS="$2"; shift 2 ;;
        -h|--help)
            grep -E '^# ' "$0" | head -20 | sed 's/^# //'
            exit 0
            ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

[[ -f "$PRD" ]] || { echo "PRD not found: $PRD" >&2; exit 2; }

if ! command -v loki >/dev/null 2>&1; then
    echo "loki CLI not on PATH. Install: npm install -g loki-mode" >&2
    exit 2
fi
if ! command -v "$PROVIDER" >/dev/null 2>&1; then
    echo "provider CLI '$PROVIDER' not on PATH" >&2
    exit 2
fi

ts() { date -u +%Y%m%dT%H%M%SZ; }

run_arm() {
    local arm="$1"          # A or B
    local gate_value="$2"   # true or false
    local label="$3"        # human label
    local stamp; stamp=$(ts)
    local workdir; workdir=$(mktemp -d -t "loki-magic-${arm}-XXXXXX")
    local logfile="$RESULTS_DIR/${arm}-${stamp}.log"
    local resfile="$RESULTS_DIR/${arm}-${stamp}.json"

    echo "=== arm $arm ($label, gate=$gate_value) ==="
    echo "    workdir: $workdir"
    echo "    log:     $logfile"

    cp "$PRD" "$workdir/prd.md"

    local start_ts end_ts duration status="completed"
    start_ts=$(date +%s)
    (
        cd "$workdir" || exit 1
        export LOKI_GATE_MAGIC_DEBATE="$gate_value"
        export LOKI_PROVIDER="$PROVIDER"
        export LOKI_MAX_ITERATIONS="$MAX_ITER"
        export LOKI_AUTO_CONFIRM=true
        # Hard wall-clock cap in addition to the iteration cap.
        timeout "${TIMEOUT_SECS}s" loki start ./prd.md \
            --provider "$PROVIDER" \
            --no-dashboard \
            --yes \
            > "$logfile" 2>&1
    )
    local rc=$?
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    if [[ $rc -eq 124 ]]; then
        status="timeout"
    elif [[ $rc -ne 0 ]]; then
        status="error_rc_$rc"
    fi

    # Collect post-run metrics from the workdir's .loki directory.
    python3 - "$workdir" "$resfile" "$arm" "$gate_value" "$duration" "$status" "$logfile" <<'PY'
import json, os, sys, subprocess
workdir, resfile, arm, gate, dur, status, logfile = sys.argv[1:8]
loki_dir = os.path.join(workdir, ".loki")

def safe_count(path):
    if not os.path.isdir(path): return 0
    return sum(1 for f in os.listdir(path) if not f.startswith("."))

def read_json(path):
    try:
        with open(path) as fh: return json.load(fh)
    except Exception: return None

specs = safe_count(os.path.join(loki_dir, "magic", "specs"))
registry = read_json(os.path.join(loki_dir, "magic", "registry.json")) or {}
components = registry.get("components", [])
if isinstance(components, dict):
    component_count = len(components)
else:
    component_count = len(components)

state = read_json(os.path.join(loki_dir, "session.json")) or read_json(os.path.join(loki_dir, "autonomy-state.json")) or {}
iteration_count = state.get("iteration") or state.get("iterations") or state.get("current_iteration") or 0

# Token cost: scan .loki/metrics/efficiency/*.json if present
tokens_in = tokens_out = 0
eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
if os.path.isdir(eff_dir):
    for fn in os.listdir(eff_dir):
        if fn.endswith(".json"):
            d = read_json(os.path.join(eff_dir, fn)) or {}
            tokens_in += int(d.get("input_tokens", 0) or 0)
            tokens_out += int(d.get("output_tokens", 0) or 0)

# Files modified: anything under workdir that's NOT in .loki/, prd.md, or hidden
modified_files = []
for root, dirs, files in os.walk(workdir):
    dirs[:] = [d for d in dirs if d not in (".loki", ".git", "node_modules")]
    for f in files:
        if f == "prd.md" or f.startswith("."): continue
        rel = os.path.relpath(os.path.join(root, f), workdir)
        modified_files.append(rel)

result = {
    "arm": arm,
    "gate_magic_debate": gate,
    "status": status,
    "duration_seconds": int(dur),
    "iteration_count": iteration_count,
    "magic_specs_count": specs,
    "magic_components_count": component_count,
    "files_modified_count": len(modified_files),
    "files_modified": sorted(modified_files)[:50],
    "tokens_in_total": tokens_in,
    "tokens_out_total": tokens_out,
    "log_file": logfile,
    "workdir": workdir,
}
with open(resfile, "w") as fh:
    json.dump(result, fh, indent=2, sort_keys=True)
print(f"    result:  {resfile}")
print(f"    status={status} duration={dur}s iters={iteration_count} specs={specs} components={component_count} files={len(modified_files)} tokens={tokens_in}/{tokens_out}")
PY
}

if [[ "$SKIP_A" != "true" ]]; then
    run_arm A true "magic gate ON (default)"
fi
if [[ "$SKIP_B" != "true" ]]; then
    run_arm B false "magic gate OFF (control)"
fi

echo
echo "Done. Compare with: python3 $SCRIPT_DIR/compare.py $RESULTS_DIR/A-*.json $RESULTS_DIR/B-*.json"
