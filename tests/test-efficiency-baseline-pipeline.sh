#!/usr/bin/env bash
# The efficiency baseline pipeline must work end to end, before we spend on it.
#
# WHY THIS EXISTS. `.loki/metrics/efficiency/` was EMPTY in this checkout, which
# means every claim about speed or cost was intuition -- there was no "before" to
# compare an "after" against. That is the gating problem for the entire
# speed-and-cost workstream: you cannot report a delta you never measured.
#
# The obvious move is to run a real build and see what lands. That costs money
# and takes tens of minutes, and if the recording plumbing is broken you have
# spent both and still have nothing. So this proves the pipeline FIRST, with no
# provider, no key and no spend:
#
#   track_iteration_complete()  writes a per-iteration record   (run.sh:7267)
#   collect_efficiency()        folds records into a cost total (efficiency_cost.py)
#
# and asserts the property the whole baseline rests on: an ABSENT record and a
# genuine $0.00 must be distinguishable. A skeptic reading "$0.00" concludes the
# artifact is fake; "cost not recorded" is the honest signal. If those two
# collapse into the same value, every downstream number is unfalsifiable.
#
# This is the same discipline as the Evidence Receipt, applied to our own
# benchmarks: measure, and say plainly when you did not.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-effbase.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "T1 -- the writer produces a complete iteration record"

mkdir -p "$WORK/.loki/state"
printf '%s\n' '{"currentPhase":"development"}' > "$WORK/.loki/state/orchestrator.json"

(
    cd "$WORK" || exit 1
    LOKI_CURRENT_MODEL="claude-haiku-4-5" PROVIDER_NAME=claude bash -c "
        source '$REPO_ROOT/autonomy/run.sh' >/dev/null 2>&1 || true
        track_iteration_complete 1 0 >/dev/null 2>&1
    "
) >/dev/null 2>&1

REC="$WORK/.loki/metrics/efficiency/iteration-1.json"
if [ -f "$REC" ]; then
    ok "track_iteration_complete wrote an iteration record"
else
    bad "no iteration record written -- the baseline can never be collected"
    echo "Results: $PASS passed, $((FAIL)) failed"
    exit 1
fi

if python3 -c "import json,sys; json.load(open('$REC'))" 2>/dev/null; then
    ok "the record is valid JSON"
else
    bad "the record is not valid JSON"
fi

# Every field the speed/cost workstream depends on must be present, or a
# downstream comparison silently drops a dimension.
for field in iteration model phase duration_ms cost_usd input_tokens output_tokens; do
    if python3 -c "
import json,sys
d=json.load(open('$REC'))
sys.exit(0 if '$field' in d else 1)" 2>/dev/null; then
        ok "record carries '$field'"
    else
        bad "record is missing '$field'"
    fi
done

# The model must be the one actually DISPATCHED, not a per-provider default.
# Recording the wrong model made a prior model-equivalence benchmark
# unfalsifiable: a haiku pin was logged as "sonnet" for every iteration.
got_model=$(python3 -c "import json;print(json.load(open('$REC')).get('model',''))" 2>/dev/null)
if [ "$got_model" = "claude-haiku-4-5" ]; then
    ok "records the DISPATCHED model ($got_model), not a provider default"
else
    bad "recorded model is '$got_model', expected the dispatched claude-haiku-4-5"
fi

echo
echo "T2 -- absent cost and a genuine zero are distinguishable"

# This is the honesty property. If they collapse, every published cost figure
# becomes unfalsifiable and the benchmark is worth nothing.
EMPTY="$WORK/empty"; mkdir -p "$EMPTY/metrics/efficiency"
absent=$(python3 -c "
import sys; sys.path.insert(0,'$REPO_ROOT/autonomy/lib')
from efficiency_cost import collect_efficiency
c,_=collect_efficiency('$EMPTY')
print(f\"{c['available']}|{c['usd']}\")" 2>/dev/null)

if [ "$absent" = "False|None" ]; then
    ok "no records -> available=False, usd=None (honest 'not recorded')"
else
    bad "no records reported as '$absent' -- expected False|None"
fi

ZERO="$WORK/zero"; mkdir -p "$ZERO/metrics/efficiency"
printf '%s\n' '{"iteration":1,"model":"haiku","cost_usd":0.0,"input_tokens":100,"output_tokens":50}' \
    > "$ZERO/metrics/efficiency/iteration-1.json"
real=$(python3 -c "
import sys; sys.path.insert(0,'$REPO_ROOT/autonomy/lib')
from efficiency_cost import collect_efficiency
c,m=collect_efficiency('$ZERO')
print(f\"{c['available']}|{c['usd']}|{m}\")" 2>/dev/null)

if [ "$real" = "True|0.0|haiku" ]; then
    ok "a genuine \$0.00 is preserved as available=True, usd=0.0"
else
    bad "genuine zero reported as '$real' -- expected True|0.0|haiku"
fi

echo
echo "T3 -- costs accumulate across iterations"

# A baseline is a SUM over a run, not a single iteration. If accumulation is
# broken the total silently under-reports and every comparison is wrong.
MULTI="$WORK/multi"; mkdir -p "$MULTI/metrics/efficiency"
printf '%s\n' '{"iteration":1,"model":"haiku","cost_usd":0.10,"input_tokens":100,"output_tokens":10}' \
    > "$MULTI/metrics/efficiency/iteration-1.json"
printf '%s\n' '{"iteration":2,"model":"haiku","cost_usd":0.25,"input_tokens":200,"output_tokens":20}' \
    > "$MULTI/metrics/efficiency/iteration-2.json"
total=$(python3 -c "
import sys; sys.path.insert(0,'$REPO_ROOT/autonomy/lib')
from efficiency_cost import collect_efficiency
c,_=collect_efficiency('$MULTI')
print(f\"{c['usd']}|{c['input_tokens']}|{c['output_tokens']}\")" 2>/dev/null)

if [ "$total" = "0.35|300|30" ]; then
    ok "two iterations sum correctly (\$0.35, 300 in, 30 out)"
else
    bad "accumulation produced '$total' -- expected 0.35|300|30"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
