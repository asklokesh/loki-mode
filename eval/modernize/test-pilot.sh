#!/usr/bin/env bash
#===============================================================================
# eval/modernize/test-pilot.sh -- M-27 hermetic test for pilot.py.
# No network, no model. Legs: manifest validation, dry-run plan, stub run with
# every metric key, calibration raise and lower, --execute refusal rules.
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=eval/loki10/lib-tmp.sh
. "$REPO/eval/loki10/lib-tmp.sh"
PILOT="$HERE/pilot.py"
MANIFEST="$HERE/pilot-manifest.json"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

if [ ! -f "$PILOT" ]; then
    fail "pilot.py is missing"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

# 1. manifest validation: real manifest valid, broken variants rejected
OUT="$(python3 "$PILOT" --dry-run --manifest "$MANIFEST" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "real manifest validates and dry-run exits 0"; else fail "dry-run rc=$rc: $OUT"; fi

python3 - "$MANIFEST" "$T" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); t = sys.argv[2]
def dump(name, mm): json.dump(mm, open(t + "/" + name, "w"))
a = json.loads(json.dumps(m)); a["repos"][0]["commit"] = "main"; dump("bad-sha.json", a)
b = json.loads(json.dumps(m)); b["repos"] = b["repos"][:9]; dump("nine.json", b)
c = json.loads(json.dumps(m)); c["repos"][1]["suite"] = ""; dump("nosuite.json", c)
d = json.loads(json.dumps(m)); d["repos"][2]["max_loc"] = 50000; dump("bigloc.json", d)
e = json.loads(json.dumps(m)); e["repos"][3]["id"] = e["repos"][0]["id"]; dump("dupid.json", e)
f = json.loads(json.dumps(m)); f["repos"][6]["target"] = "python3"; dump("badtarget.json", f)
PY
for v in bad-sha nine nosuite bigloc dupid badtarget; do
    python3 "$PILOT" --dry-run --manifest "$T/$v.json" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
    if [ "$rc" -eq 2 ] && [ -s "$T/err.txt" ]; then pass "invalid manifest ($v) rejected rc=2"; else fail "invalid manifest ($v) rc=$rc"; fi
done

# 2. dry-run plan: 10 repos, no model calls, no clone, nothing written
PLAN="$(python3 "$PILOT" --dry-run --manifest "$MANIFEST" --results-dir "$T/dry-results" 2>&1)"
echo "$PLAN" | python3 -c '
import json, sys
d = json.load(sys.stdin)
ok = (len(d["repos"]) == 10 and d["path_taken"] in ("public", "fallback")
      and all(r["model_calls"] == 0 and r["would_clone"] is False for r in d["repos"])
      and d["start_cap_lines"] == 1500 and d["public_set_url"] and d["public_set_license"])
sys.exit(0 if ok else 1)'
rc=$?
if [ "$rc" -eq 0 ]; then pass "dry-run plan lists 10 repos, 0 model calls, no clones"; else fail "dry-run plan wrong: $PLAN"; fi
if [ ! -e "$T/dry-results" ]; then pass "dry-run writes no results"; else fail "dry-run wrote results"; fi

# 3. stub run: results file with every metric key
if python3 -m pytest --version >/dev/null 2>&1; then
    OUT="$(python3 "$PILOT" --stub --manifest "$MANIFEST" --results-dir "$T/results" 2>&1)"; rc=$?
    RES="$(find "$T/results" -name 'pilot-stub-*.json' 2>/dev/null | head -1)"
    if [ "$rc" -eq 0 ] && [ -n "$RES" ]; then pass "stub run exits 0 and writes a results file"; else fail "stub run rc=$rc res=$RES out=$OUT"; fi
    python3 - "$RES" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
keys = ["equivalence_rate", "not_proven_share", "human_touches", "cost_per_1k_lines_usd", "wall_time_s", "units_resliced"]
r = d["runs"][0]
assert all(k in r for k in keys), "missing metric key"
assert r["equivalence_rate"] == 1.0 and r["not_proven_share"] == 0.0 and r["units_total"] >= 1, r
assert r["cost_usd"] == 0.0 and r["mode"] == "stub"
assert d["calibration"]["action"] == "raise" and d["calibration"]["recommended_cap"] > d["calibration"]["current_cap"]
PY
    rc=$?
    if [ "$rc" -eq 0 ]; then pass "stub results hold every metric key and a raise calibration"; else fail "stub results content"; fi
    if echo "$OUT" | grep -q "recommended cap: "; then pass "stub run prints the recommended cap"; else fail "no recommended cap printed"; fi
else
    echo "SKIP: stub legs need python3 with pytest"
fi

# 4. calibration rule on synthetic inputs
python3 - "$HERE" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import pilot
cfg = pilot.load_manifest(sys.argv[1] + "/pilot-manifest.json")["cap"]
def run(total, first):
    return pilot.make_run("x", "stub", "ok", total, total, first, 1000, 1.0, 0, 0, 1.0)
hi = pilot.calibrate_cap([run(10, 10), run(10, 9)], cfg)       # 95%
assert hi["action"] == "raise" and hi["recommended_cap"] == 1900, hi
edge = pilot.calibrate_cap([run(10, 9)], cfg)                    # exactly 90% raises
assert edge["action"] == "raise", edge
lo = pilot.calibrate_cap([run(10, 8), run(10, 8)], cfg)         # 80%
assert lo["action"] == "lower" and lo["recommended_cap"] == 1100, lo
floor = pilot.calibrate_cap([run(10, 0)], cfg, current=cfg["min_lines"])
assert floor["recommended_cap"] == cfg["min_lines"] and floor["action"] == "hold", floor
ceil = pilot.calibrate_cap([run(10, 10)], cfg, current=cfg["max_lines"])
assert ceil["recommended_cap"] == cfg["max_lines"] and ceil["action"] == "hold", ceil
none = pilot.calibrate_cap([], cfg)
assert none["action"] == "hold" and none["recommended_cap"] == cfg["start_lines"], none
PY
rc=$?
if [ "$rc" -eq 0 ]; then pass "calibration raises at >=90%, lowers below, clamps, holds on no data"; else fail "calibration rule"; fi

# 5. --execute refusals (all before any network or model use)
python3 "$PILOT" --execute --manifest "$MANIFEST" --results-dir "$T/exec" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "max-spend-usd" "$T/err.txt" && [ ! -e "$T/exec" ]; then pass "--execute without --max-spend-usd refused"; else fail "--execute w/o spend rc=$rc"; fi
python3 "$PILOT" --execute --max-spend-usd 0 --manifest "$MANIFEST" --results-dir "$T/exec" >/dev/null 2>"$T/err.txt"; rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$T/exec" ]; then pass "--execute with --max-spend-usd 0 refused"; else fail "--execute spend 0 rc=$rc"; fi
python3 "$PILOT" --stub --max-spend-usd 5 --manifest "$MANIFEST" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then pass "--max-spend-usd without --execute refused"; else fail "spend flag accepted outside execute"; fi
python3 "$PILOT" --manifest "$MANIFEST" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then pass "no mode flag refused"; else fail "no-mode accepted"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
