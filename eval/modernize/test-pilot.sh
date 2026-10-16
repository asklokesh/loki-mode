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
      and all(r["model_calls"] == 0 and "would_clone" not in r for r in d["repos"])
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

# 6. --execute with a fake --loki-bin that writes real-shaped artifacts (the envelope and data shapes
#    the TS writers emit: v, seq, ts, run, type, stage, data). No network: repos come from --source-dir.
FAKE="$T/fake-loki"
cat >"$FAKE" <<'FAKE_EOF'
#!/usr/bin/env bash
# usage: fake-loki modernize <dest> --to <target> --budget <usd> --no-pr
dest="$2"
echo "$dest" >>"$FAKE_CALLS"
mode="$(cat "$dest/fake-mode")"
id="$(cat "$dest/fake-id")"
[ "$mode" = "bad" ] && exit 1
mid="mod-fake-$id"
d="$dest/.loki/modernize/$mid"
mkdir -p "$d"
n=0
ev() { n=$((n + 1)); printf '{"v":1,"seq":%s,"ts":"2026-10-16T00:00:%02dZ","run":"%s","type":"%s","stage":null,"data":%s}\n' "$n" "$n" "$mid" "$1" "$2" >>"$d/events.jsonl"; }
ev modernize.started '{"repo":"x","to":"python3","budget_usd":1,"workers":4}'
ev unit.started '{"unit":"u1","model":"sonnet","worker":0,"variant":0}'
case "$mode" in
    variant) ev unit.variant '{"unit":"u1","variant":1,"model":"sonnet"}'; ev unit.started '{"unit":"u1","model":"sonnet","worker":0,"variant":1}'; ev unit.equivalence '{"unit":"u1","verdict":"PROVEN","cases":4,"pass":4,"fail":0,"rate":1,"branch_pct":100}' ;;
    lowrate) ev unit.equivalence '{"unit":"u1","verdict":"PROVEN","cases":4,"pass":2,"fail":2,"rate":0.5,"branch_pct":50}' ;;
    np) ev unit.equivalence '{"unit":"u1","verdict":"NOT_PROVEN","cases":0,"pass":0,"fail":0,"rate":0}'; ev unit.not_proven '{"unit":"u1","reasons":["no oracle"]}' ;;
    *) ev unit.equivalence '{"unit":"u1","verdict":"PROVEN","cases":4,"pass":4,"fail":0,"rate":1,"branch_pct":100}' ;;
esac
[ "$mode" = "np" ] || ev unit.completed '{"unit":"u1"}'
if [ -f "$dest/fake-spent" ]; then
    ev budget.hit "{\"budget_usd\":1,\"spent_usd\":$(cat "$dest/fake-spent"),\"in_flight\":0}"
fi
exit 0
FAKE_EOF
chmod +x "$FAKE"
export FAKE_CALLS="$T/calls.txt"

# mksrc DIR DEFAULT_MODE [FIRST_MODE [FIRST_SPENT]]: one source dir per manifest repo id
mksrc() {
    python3 - "$MANIFEST" "$1" "$2" "${3:-}" "${4:-}" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1])); root, dmode, fmode, fspent = sys.argv[2:6]
for i, r in enumerate(m["repos"]):
    d = os.path.join(root, r["id"]); os.makedirs(d)
    ext = ".py" if r["language"] == "py2" else ".java"
    open(os.path.join(d, "a" + ext), "w").write("x = 1\ny = 2\n")
    open(os.path.join(d, "fake-id"), "w").write(r["id"])
    open(os.path.join(d, "fake-mode"), "w").write(fmode if (i == 0 and fmode) else dmode)
    if i == 0 and fspent:
        open(os.path.join(d, "fake-spent"), "w").write(fspent)
PY
}
# resj FILE EXPR: evaluate a python expression over the results doc d
resj() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2"; }
latest() { find "$1" -name 'pilot-execute-*.json' | head -1; }

# 6a. B5: spend cap from real budget.hit.spent_usd; second repo skipped once the cap is reached
mksrc "$T/src-cap" ok ok 12
: >"$FAKE_CALLS"
python3 "$PILOT" --execute --max-spend-usd 10 --manifest "$MANIFEST" --source-dir "$T/src-cap" --loki-bin "$FAKE" --results-dir "$T/r-cap" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
RES="$(latest "$T/r-cap")"
if [ "$rc" -eq 0 ] && [ -n "$RES" ] && [ "$(wc -l <"$FAKE_CALLS" | tr -d ' ')" = "1" ] \
    && resj "$RES" 'd["runs"][0]["cost_usd"]==12.0 and d["runs"][1]["status"]=="skipped_budget_exhausted" and d["aggregate"]["runs_skipped"]==9 and d["calibration"]["action"]=="hold"'; then
    pass "spend cap from budget.hit.spent_usd skips the remaining repos (1 fake call)"
else fail "spend cap: rc=$rc calls=$(wc -l <"$FAKE_CALLS") $(cat "$T/err.txt")"; fi

# 6b. B1 + B2: no spend source means cost null and 'not measured'; units_resliced null, never 0
mksrc "$T/src-ok" ok
python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$T/src-ok" --loki-bin "$FAKE" --results-dir "$T/r-ok" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
RES="$(latest "$T/r-ok")"
if [ "$rc" -eq 0 ] && resj "$RES" 'all(r["cost_usd"] is None and r["cost_per_1k_lines_usd"] is None and r["units_resliced"] is None and r["status"]=="ok" for r in d["runs"]) and d["aggregate"]["cost_per_1k_lines_usd"] is None and d["aggregate"]["units_resliced"] is None and d["runs"][0]["note"].startswith("mid=mod-fake-")' \
    && grep -q "cost per 1K lines: not measured; units re-sliced: not measured" "$T/out.txt"; then
    pass "unmeasured cost and re-slices are null and printed as not measured; mid read from modernize.started"
else fail "not-measured leg rc=$rc $(cat "$T/err.txt")"; fi
if resj "$RES" 'd["calibration"]["action"]=="raise" and d["aggregate"]["first_pass_equivalence"]==1.0'; then pass "events-only artifacts (no report.json) yield units and a raise"; else fail "events-derived calibration"; fi

# 6c. B3 + B4: 9 repos with no artifacts plus 1 ok run: exit non-zero, hold, no 1.0
mksrc "$T/src-bad" bad ok
python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$T/src-bad" --loki-bin "$FAKE" --results-dir "$T/r-bad" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
RES="$(latest "$T/r-bad")"
if [ "$rc" -ne 0 ] && resj "$RES" 'd["aggregate"]["runs_failed"]==9 and d["aggregate"]["runs_valid"]==1 and d["calibration"]["action"]=="hold" and d["calibration"]["first_pass_equivalence"] is None and sum(1 for r in d["runs"] if r["status"]=="no_report")==9'; then
    pass "9 no_report runs plus 1 ok: non-zero exit, hold, no 1.0, runs_failed=9"
else fail "failed-runs leg rc=$rc"; fi
python3 - "$HERE" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import pilot
cfg = pilot.load_manifest(sys.argv[1] + "/pilot-manifest.json")["cap"]
runs = [pilot.make_run("x%d" % i, "execute", "no_artifacts_rc1", 0, 0, 0, 100, None, 0, None, 1.0) for i in range(9)]
runs.append(pilot.make_run("ok", "execute", "ok", 5, 5, 5, 100, None, 0, None, 1.0))
c = pilot.calibrate_cap(runs, cfg)
assert c["action"] == "hold" and c["first_pass_equivalence"] is None, c
a = pilot.aggregate(runs)
assert a["runs_failed"] == 9 and a["runs_skipped"] == 0, a
PY
rc=$?
if [ "$rc" -eq 0 ]; then pass "synthetic 9 x no_artifacts_rc1 + 1 ok holds"; else fail "synthetic no_artifacts hold"; fi

# 6d. N2 and first-pass: PROVEN with rate<1 is not proven; a variant retry is not first pass
mksrc "$T/src-low" lowrate
python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$T/src-low" --loki-bin "$FAKE" --results-dir "$T/r-low" >/dev/null 2>&1
RES="$(latest "$T/r-low")"
if resj "$RES" 'all(r["status"]=="not_proven" and r["units_proven"]==0 for r in d["runs"]) and d["calibration"]["action"]=="lower"'; then pass "PROVEN with rate<1 counts as not proven (provenOk mirror)"; else fail "rate<1 leg"; fi
mksrc "$T/src-var" variant
python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$T/src-var" --loki-bin "$FAKE" --results-dir "$T/r-var" >/dev/null 2>&1
RES="$(latest "$T/r-var")"
if resj "$RES" 'all(r["units_proven"]==1 and r["units_first_pass"]==0 for r in d["runs"]) and d["calibration"]["action"]=="lower"'; then pass "a unit.variant retry is proven but not first-pass"; else fail "variant leg"; fi
mksrc "$T/src-np" np
python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$T/src-np" --loki-bin "$FAKE" --results-dir "$T/r-np" >/dev/null 2>&1
RES="$(latest "$T/r-np")"
if resj "$RES" 'all(r["status"]=="not_proven" and r["not_proven_share"]==1.0 for r in d["runs"])'; then pass "unit.not_proven yields NOT PROVEN share 1.0"; else fail "not_proven leg"; fi

# 7. stub default output goes to the run-owned temp dir and is marked non_evidence
if python3 -m pytest --version >/dev/null 2>&1; then
    python3 "$PILOT" --stub --manifest "$MANIFEST" >/dev/null 2>&1
    RES="$(find "$T/pilot-results" -name 'pilot-stub-*.json' 2>/dev/null | head -1)"
    if [ -n "$RES" ] && resj "$RES" 'd["calibration"]["non_evidence"] is True'; then pass "stub defaults to LOKI_RUN_TMP and is non_evidence"; else fail "stub default dir/non_evidence"; fi
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
