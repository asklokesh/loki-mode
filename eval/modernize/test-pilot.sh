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
PLANNED=1
[ -f "$dest/fake-planned" ] && PLANNED="$(cat "$dest/fake-planned")"
d="$dest/.loki/modernize/$mid"
mkdir -p "$d"
n=0
ev() { n=$((n + 1)); printf '{"v":1,"seq":%s,"ts":"2026-10-16T00:00:%02dZ","run":"%s","type":"%s","stage":null,"data":%s}\n' "$n" "$n" "$mid" "$1" "$2" >>"$d/events.jsonl"; }
ev modernize.started '{"repo":"x","to":"python3","budget_usd":1,"workers":4}'
ev estimate.printed '{"units":'"$PLANNED"',"waves":1,"cost_usd":1,"wall_time_s":1,"risk_high":0,"risk_normal":1}'
WAVEU="$PLANNED"
[ -f "$dest/fake-waveunits" ] && WAVEU="$(cat "$dest/fake-waveunits")"
ev wave.started '{"units":'"$WAVEU"'}'
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
[ "$mode" = "crash" ] && exit 1
[ "$mode" = "nocomplete" ] && exit 0
ev wave.verified '{"wave":1,"verified":true}'
case "$mode" in
    np|lowrate|incompleteverdict) ev modernize.completed '{"verdict":"INCOMPLETE","blocking_units":["u1"],"blocking_waves":[],"report_sha256":"x"}' ;;
    *) ev modernize.completed '{"verdict":"COMPLETE","blocking_units":[],"blocking_waves":[],"report_sha256":"x"}' ;;
esac
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

# 6e. M-27b F1: budget-skipped units and crashed runs are never ok
FIRST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repos"][0]["id"])' "$MANIFEST")"
runone() { python3 "$PILOT" --execute --max-spend-usd 100 --manifest "$MANIFEST" --source-dir "$1" --loki-bin "$FAKE" --only "$FIRST" --results-dir "$2" >"$T/out.txt" 2>&1; }

# planned 10, one PROVEN, rest skipped by budget (no unit.* events), modernize.completed emitted
mksrc "$T/src-bud" ok ok 3
echo 10 >"$T/src-bud/$FIRST/fake-planned"
runone "$T/src-bud" "$T/r-bud"
RES="$(latest "$T/r-bud")"
if resj "$RES" 'd["runs"][0]["units_total"]==10 and d["runs"][0]["units_proven"]==1 and d["runs"][0]["status"]!="ok" and abs(d["runs"][0]["equivalence_rate"]-0.1)<1e-9 and d["calibration"]["action"]!="raise"' \
    && resj "$RES" '"lower bound" in d["runs"][0]["note"]' && grep -q "lower bound" "$T/out.txt"; then
    pass "budget-skipped units count as not proven: 1 of 10 is not ok, no raise, cost labelled lower bound"
else fail "budget-skip leg: $(cat "$T/out.txt")"; fi

# crash after one unit: non-zero exit, no modernize.completed
mksrc "$T/src-crash" crash
runone "$T/src-crash" "$T/r-crash"
RES="$(latest "$T/r-crash")"
if resj "$RES" 'd["runs"][0]["status"] not in ("ok","not_proven") and d["calibration"]["action"]=="hold" and d["aggregate"]["runs_valid"]==0'; then pass "crash after one unit (rc!=0) is not ok and does not calibrate"; else fail "crash leg"; fi

# rc 0, every unit PROVEN, no modernize.completed event (production today): ok
mksrc "$T/src-nocomp" nocomplete
runone "$T/src-nocomp" "$T/r-nocomp"
RES="$(latest "$T/r-nocomp")"
if resj "$RES" 'd["runs"][0]["status"]=="ok" and d["runs"][0]["units_proven"]==1'; then pass "rc 0 with all units proven and no modernize.completed is ok"; else fail "nocomplete leg: $(cat "$T/out.txt")"; fi

# rc 0, all units proven, real-shape modernize.completed says INCOMPLETE: incomplete
mksrc "$T/src-incv" incompleteverdict
runone "$T/src-incv" "$T/r-incv"
RES="$(latest "$T/r-incv")"
if resj "$RES" 'd["runs"][0]["status"]=="incomplete"'; then pass "INCOMPLETE verdict never counts as ok"; else fail "incomplete verdict leg: $(cat "$T/out.txt")"; fi

# F3: wave.started sum (2) below estimate (3): the skipped unit is not proven
mksrc "$T/src-wave" ok
echo 3 >"$T/src-wave/$FIRST/fake-planned"
echo 2 >"$T/src-wave/$FIRST/fake-waveunits"
runone "$T/src-wave" "$T/r-wave"
RES="$(latest "$T/r-wave")"
if resj "$RES" 'd["runs"][0]["units_total"]==3 and d["runs"][0]["units_proven"]==1 and d["runs"][0]["status"]!="ok"'; then pass "planned units = max(estimate, wave sum): skipped unit not proven"; else fail "planned max leg: $(cat "$T/out.txt")"; fi

# F2: unmeasured spend is charged the full allowance for every executed run, any status
python3 - "$HERE" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import pilot
for st in ("ok", "not_proven", "no_report", "incomplete", "failed_rc1", "failed_rc137"):
    r = pilot.make_run("x", "execute", st, 1, 1, 1, 100, None, 0, None, 1.0)
    assert pilot.charge_spend(r, 2.5) == 2.5, st
r = pilot.make_run("x", "execute", "failed_rc1", 1, 1, 1, 100, 0.7, 0, None, 1.0)
assert pilot.charge_spend(r, 2.5) == 0.7
r = pilot.make_run("x", "execute", "skipped_over_max_loc", 0, 0, 0, 100, None, 0, None, 1.0)
assert pilot.charge_spend(r, 2.5) == 0.0
PY
rc=$?
if [ "$rc" -eq 0 ]; then pass "unmeasured cost charges the full allowance for failed and incomplete runs"; else fail "charge_spend"; fi

# 7. M-28 scale.py: dry run first, refusal rules, Calibre fallback. No network, no model:
#    sources are local stub trees, loki is a fake that answers --dry-run and otherwise delegates to FAKE.
SCALE="$HERE/scale.py"
SFAKE="$T/scale-fake-loki"
cat >"$SFAKE" <<'SFAKE_EOF'
#!/usr/bin/env bash
case " $* " in
    *" --dry-run "*)
        echo "$2" >>"$SFAKE_DRYCALLS"
        printf 'units: 12\nwaves: 3\ncost: $9.50\nwall time: 600s\nrisk: 1 high, 11 normal\n'
        exit 0 ;;
esac
exec "$FAKE" "$@"
SFAKE_EOF
chmod +x "$SFAKE"
export FAKE SFAKE_DRYCALLS="$T/drycalls.txt"
mkstub() {
    mkdir -p "$1/pkg" "$1/vendor"
    python3 -c '
import sys
d = sys.argv[1]
open(d + "/pkg/a.py", "w").write("x = 1\n" * 50)
open(d + "/pkg/b.c", "w").write("int y;\n" * 20)
open(d + "/vendor/v.py", "w").write("z = 1\n" * 900)
open(d + "/fake-id", "w").write("scale-stub")
open(d + "/fake-mode", "w").write("ok")' "$1"
}
mkstub "$T/hg-src"
mkstub "$T/calibre-src"
: >"$FAKE_CALLS"; : >"$SFAKE_DRYCALLS"

# 7a. dry run: plan printed, rc 0, zero spend (no paid call, no results written)
python3 "$SCALE" --target hg --dry-run-first --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" --results-dir "$T/s-dry" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$T/s-dry" ] && [ ! -s "$FAKE_CALLS" ] && [ -s "$SFAKE_DRYCALLS" ] \
    && resj "$T/out.txt" 'd["selected_target"]=="hg" and d["fallback_used"] is False and d["lines_by_language"]["python"]==50 and d["lines_by_language"]["c"]==20 and d["total_lines"]==70 and d["units"]==12 and d["waves"]==3 and d["estimated_cost_usd"]==9.5 and d["spend_cap_usd"] is None and d["unit_line_cap"]==1500 and d["model_spend_usd"]==0 and d["paid_run"]=="not started"'; then
    pass "scale dry run prints measured plan, rc 0, zero spend, vendored lines excluded"
else fail "scale dry run rc=$rc $(cat "$T/err.txt") $(head -c 400 "$T/out.txt")"; fi

# 7b. default mode is the dry run even without --dry-run-first
python3 "$SCALE" --target hg --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" --results-dir "$T/s-dry" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$T/s-dry" ] && [ ! -s "$FAKE_CALLS" ]; then pass "scale defaults to the dry run"; else fail "scale default mode rc=$rc"; fi

# 7c. refusals: --execute without --budget-usd, with budget 0, budget without --execute (red-first leg)
python3 "$SCALE" --target hg --execute --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" --results-dir "$T/s-exec" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "budget-usd" "$T/err.txt" && [ ! -e "$T/s-exec" ] && [ ! -s "$FAKE_CALLS" ]; then pass "scale --execute without --budget-usd refused non-zero, no spend"; else fail "scale execute w/o budget rc=$rc"; fi
python3 "$SCALE" --target hg --execute --budget-usd 0 --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" --results-dir "$T/s-exec" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$T/s-exec" ] && [ ! -s "$FAKE_CALLS" ]; then pass "scale --execute with --budget-usd 0 refused"; else fail "scale execute budget 0 rc=$rc"; fi
python3 "$SCALE" --target hg --budget-usd 5 --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ ! -s "$FAKE_CALLS" ]; then pass "scale --budget-usd without --execute refused"; else fail "scale budget w/o execute rc=$rc"; fi

# 7d. fallback: hg source missing selects Calibre and logs it
python3 "$SCALE" --target hg --source "$T/no-such-hg" --fallback-source "$T/calibre-src" --min-lines 50 --loki-bin "$SFAKE" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "falling back to calibre" "$T/err.txt" \
    && resj "$T/out.txt" 'd["selected_target"]=="calibre" and d["fallback_used"] is True and any("hg" in x and "unavailable" in x for x in d["selection_log"])'; then
    pass "scale falls back to Calibre when the hg source is unavailable, and logs it"
else fail "scale fallback rc=$rc $(cat "$T/err.txt")"; fi

# 7e. fallback on the 200K floor: hg under --min-lines falls back too
python3 "$SCALE" --target hg --source "$T/hg-src" --fallback-source "$T/calibre-src" --min-lines 71 --loki-bin "$SFAKE" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "below the 71 line floor" "$T/err.txt"; then pass "scale refuses when no candidate meets the line floor"; else fail "scale floor rc=$rc $(cat "$T/err.txt")"; fi
python3 "$SCALE" --target hg --source "$T/hg-src" --fallback-source "$T/calibre-src" --min-lines 60 --loki-bin "$SFAKE" >"$T/out.txt" 2>/dev/null; rc=$?
if [ "$rc" -eq 0 ] && resj "$T/out.txt" 'd["selected_target"]=="hg"'; then pass "scale keeps hg when it meets the floor"; else fail "scale floor ok rc=$rc"; fi

# 7f. explicit execute with budget runs the fake paid path through pilot.execute_repo and writes results
python3 "$SCALE" --target hg --execute --budget-usd 3 --source "$T/hg-src" --min-lines 50 --loki-bin "$SFAKE" --results-dir "$T/s-exec" >"$T/out.txt" 2>"$T/err.txt"; rc=$?
RES="$(find "$T/s-exec" -name 'pilot-scale-*.json' 2>/dev/null | head -1)"
if [ "$rc" -eq 0 ] && [ -n "$RES" ] && [ "$(wc -l <"$FAKE_CALLS" | tr -d ' ')" = "1" ] \
    && resj "$RES" 'd["runs"][0]["id"]=="scale-hg" and d["runs"][0]["status"]=="ok" and d["runs"][0]["units_total"]==1'; then
    pass "scale --execute --budget-usd runs one fake paid call and writes results"
else fail "scale execute rc=$rc res=$RES out=$(cat "$T/out.txt") run=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runs"][0])' "$RES" 2>&1)"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
