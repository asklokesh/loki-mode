#!/usr/bin/env bash
# The receipt must say what the user PAID FOR, not just what it cost.
#
# WHY. "Paying for your own errors" is a named churn driver in this category --
# users tolerate a bug, but not being billed for the agent's retries while it
# fixes its own mistake. Competitors carry this directly (opencode#35643: content
# filter blocks output, user still billed for the full generation).
#
# The receipt already reported a cost total and iteration count. Neither told a
# user whether they paid for progress or for rework. Splitting them is a
# deterministic FACT derived from records the engine already writes, so it
# belongs with the facts rather than the AI assessments.
#
# The limitation is asserted here on purpose: rework counts FAILED iterations
# only, so an iteration that completed but was forced to repeat by a gate is
# counted as progress. That makes the number a FLOOR. A receipt that implied a
# ceiling would understate what the harness cost the user, which is exactly the
# direction that flatters us.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
W="$(mktemp -d "${TMPDIR:-/tmp}/loki-rework.XXXXXX")"; trap 'rm -rf "$W"' EXIT

_mkrepo() {
  mkdir -p "$1/.loki"
  ( cd "$1" && git init -q && git config user.email t@t.invalid \
      && git config user.name t && git config commit.gpgsign false \
      && echo a > f.txt && git add -A && git commit -q -m init ) >/dev/null 2>&1
}
_gen() { ( cd "$1" && python3 "$GEN" --loki-dir "$1/.loki" --out-dir "$1/out" --quiet ) >/dev/null 2>&1; }

echo "T1 -- a run with a failed iteration reports rework"
D="$W/mixed"; _mkrepo "$D"; mkdir -p "$D/.loki/metrics/efficiency"
printf '{"iteration":1,"status":"completed","cost_usd":0.24,"duration_ms":1000}\n' > "$D/.loki/metrics/efficiency/iteration-1.json"
printf '{"iteration":2,"status":"failed","cost_usd":0.12,"duration_ms":2000}\n'   > "$D/.loki/metrics/efficiency/iteration-2.json"
_gen "$D"
P="$D/out/proof.json"
if [ -f "$P" ]; then ok "receipt generated"; else bad "no receipt"; echo "Results: $PASS passed, $FAIL failed"; exit 1; fi

get() { python3 -c "
import json,sys
a=json.load(open('$P')).get('iterations',{}).get('attribution') or {}
v=a
for k in '$1'.split('.'):
    v = (v or {}).get(k) if isinstance(v,dict) else None
print(v)" 2>/dev/null; }

[ "$(get progress.count)" = "1" ] && ok "1 progress iteration" || bad "progress=$(get progress.count)"
[ "$(get rework.count)"   = "1" ] && ok "1 rework iteration"   || bad "rework=$(get rework.count)"
# The share is what a user acts on; a right split with a wrong share still misleads.
[ "$(get rework_cost_share)" = "0.3333" ] && ok "rework share 33% (0.12 of 0.36)" || bad "share=$(get rework_cost_share)"

echo
echo "T2 -- the floor limitation is stated in the artifact"
python3 -c "
import json,sys
b=(json.load(open('$P')).get('iterations',{}).get('attribution') or {}).get('basis','')
sys.exit(0 if 'floor' in b.lower() else 1)" 2>/dev/null \
  && ok "receipt states rework is a floor, not a ceiling" \
  || bad "the floor caveat is missing -- the receipt overstates its certainty"

echo
echo "T3 -- no records means NO attribution, never a zero-rework claim"
# Claiming "0% rework" for a run we never measured would be a fabricated
# reassurance, the exact false-green this receipt exists to prevent.
E="$W/none"; _mkrepo "$E"; _gen "$E"
python3 -c "
import json,sys
sys.exit(0 if 'attribution' not in json.load(open('$E/out/proof.json')).get('iterations',{}) else 1)" 2>/dev/null \
  && ok "absent records -> attribution omitted (not 0% rework)" \
  || bad "receipt claimed an attribution for a run with no efficiency records"

# Non-vacuity: the receipt must still be a valid, complete artifact in that case.
python3 -c "import json;d=json.load(open('$E/out/proof.json'));assert 'iterations' in d" 2>/dev/null \
  && ok "non-vacuity: receipt still valid without attribution" \
  || bad "omitting attribution broke the receipt"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
