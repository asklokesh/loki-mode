#!/usr/bin/env bash
# Iterations must be EXPLAINED, not just counted.
#
# WHY. Iterations multiply both wall clock and cost, and the Evidence Receipt
# reports only {count, succeeded, failed}. A user seeing "6 iterations" cannot
# tell real work from a gate false-positive forcing five redos -- and neither can
# we, which is worse, because it means we cannot tell an expensive run caused by
# a slow model from one caused by our own harness being wrong.
#
# That has already happened here: a measured run had the agent claim done on
# EVERY iteration while a mock-integrity false positive blocked all six, and a
# start-sha bug made the council see a permanently empty diff so it could never
# vote done. Both were harness defects billed to the user as model cost.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTR="$REPO_ROOT/autonomy/lib/iteration_attribution.py"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
W="$(mktemp -d "${TMPDIR:-/tmp}/loki-attr.XXXXXX")"; trap 'rm -rf "$W"' EXIT

echo "T1 -- progress and rework are separated"
D="$W/mixed"; mkdir -p "$D/metrics/efficiency"
for i in 1 2 3; do
  st=completed; [ "$i" = "2" ] && st=failed
  printf '{"iteration":%d,"status":"%s","cost_usd":0.1%d,"duration_ms":%d}\n' \
    "$i" "$st" "$i" "$((i*1000))" > "$D/metrics/efficiency/iteration-$i.json"
done
out=$(python3 "$ATTR" --loki-dir "$D" --json 2>/dev/null)
p=$(printf '%s' "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['progress']['count'])" 2>/dev/null)
r=$(printf '%s' "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['rework']['count'])" 2>/dev/null)
[ "$p" = "2" ] && ok "2 progress iterations" || bad "progress=$p, expected 2"
[ "$r" = "1" ] && ok "1 rework iteration" || bad "rework=$r, expected 1"

# The share is the number a user acts on. Getting the split right but the share
# wrong would still send someone optimising the wrong thing.
sh=$(printf '%s' "$out" | python3 -c "import json,sys;print(json.load(sys.stdin).get('rework_cost_share'))" 2>/dev/null)
[ "$sh" = "0.3333" ] && ok "rework cost share is 33% (0.12 of 0.36)" || bad "share=$sh, expected 0.3333"

echo
echo "T2 -- unrecorded cost is null, never a fabricated zero"
# The honesty property the Evidence Receipt also depends on. A skeptic reading
# "\$0.00" concludes the artifact is fake; "not recorded" is the true signal.
Z="$W/zero"; mkdir -p "$Z/metrics/efficiency"
printf '{"iteration":1,"status":"completed","cost_usd":0,"duration_ms":500}\n' \
  > "$Z/metrics/efficiency/iteration-1.json"
tc=$(python3 "$ATTR" --loki-dir "$Z" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['total_cost_usd'])" 2>/dev/null)
[ "$tc" = "None" ] && ok "all-zero cost reports null, not 0.0" || bad "total_cost_usd=$tc, expected None"

E="$W/empty"; mkdir -p "$E/metrics/efficiency"
python3 "$ATTR" --loki-dir "$E" 2>/dev/null | grep -q "not recorded" \
  && ok "no records reports 'not recorded'" || bad "no-records case did not say 'not recorded'"

echo
echo "T3 -- the floor limitation is stated, not hidden"
# An attribution that overstated its own certainty would send someone chasing
# the wrong cause. The tool must say what it cannot see.
python3 "$ATTR" --loki-dir "$D" 2>/dev/null | grep -qi "FLOOR" \
  && ok "output states rework is a floor, not a ceiling" \
  || bad "the floor caveat is missing -- the number overstates its certainty"

# Non-vacuity: a malformed record must be skipped, not defaulted to zero, or the
# total silently understates and flatters us.
M="$W/bad"; mkdir -p "$M/metrics/efficiency"
printf 'not json\n' > "$M/metrics/efficiency/iteration-1.json"
printf '{"iteration":2,"status":"completed","cost_usd":0.5,"duration_ms":10}\n' \
  > "$M/metrics/efficiency/iteration-2.json"
n=$(python3 "$ATTR" --loki-dir "$M" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['iterations'])" 2>/dev/null)
[ "$n" = "1" ] && ok "malformed record skipped, not counted as a zero-cost iteration" \
  || bad "iterations=$n, expected 1 (malformed skipped)"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
