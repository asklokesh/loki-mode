#!/usr/bin/env bash
# shellcheck disable=SC2319
# tests/test-scoreboard-40x.sh -- D92: scripts/scoreboard-40x.sh factors and EFFICIENCY on recorded fixtures,
# NOT RECORDED for a missing human-minutes field, the mass-10 declared slot, and a hand-built case.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SB="$SCRIPT_DIR/../scripts/scoreboard-40x.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
FAILS=0
check() { if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi; }
jget() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d=d[k]
print(d)' "$1" "$2"; }

bash "$SB" --dry --version v --json-out "$T/d.json" --metrics-out "$T/d.metrics" > "$T/d.out" 2>&1
check dry-rc $? "$(cat "$T/d.out")"
# trivial-sum: cost/verified 0.40 -> 0.20, wall 1.0 -> 0.5 min, human 4 -> 2; efficiency 0.625 -> 5.0 (8x)
[ "$(jget "$T/d.json" tasks.trivial-sum.cost_factor)" = "2.0" ]; check cost-factor $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.trivial-sum.wall_factor)" = "2.0" ]; check wall-factor $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.trivial-sum.human_factor)" = "2.0" ]; check human-factor $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.trivial-sum.efficiency_factor)" = "8.0" ]; check efficiency-factor-8 $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.two-bug.efficiency_factor)" = "27.0" ]; check efficiency-factor-27 $? "$(cat "$T/d.out")"
# medium: cost/verified 4.00 -> 1.50 (2 of 3 verified); human minutes unrecorded in the current release
[ "$(jget "$T/d.json" tasks.medium.cost_factor)" = "2.6667" ]; check cost-per-verified-not-per-run $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.medium.human_factor)" = "NOT RECORDED" ]; check human-missing-not-recorded $? "$(cat "$T/d.out")"
[ "$(jget "$T/d.json" tasks.medium.efficiency_factor)" = "NOT RECORDED" ]; check efficiency-missing-not-recorded $? "$(cat "$T/d.out")"
! grep -Eq 'human_x=0(\.00)?( |$)' "$T/d.metrics"; check no-zero-leak $? "$(cat "$T/d.metrics")"
grep -q '^mass-10 .*NOT RUN' "$T/d.out"; check mass-slot-declared-not-run $? "$(cat "$T/d.out")"
grep -q 'scoreboard-40x v vs 11.3.1' "$T/d.metrics"; check metrics-row $? "$(cat "$T/d.metrics")"

# recorded human_min of 0 is not divisible: NOT COMPUTABLE, never an invented floor
printf 'trivial-sum\t1\t1\t1\t60\t0.40\t4\n' > "$T/b.tsv"
printf 'trivial-sum\t1\t1\t1\t30\t0.20\t0\n' > "$T/c.tsv"
bash "$SB" --current "$T/c.tsv" --baseline "$T/b.tsv" --version v --json-out "$T/z.json" > /dev/null 2>&1
[ "$(jget "$T/z.json" tasks.trivial-sum.efficiency_factor)" = "NOT COMPUTABLE" ]; check zero-human-not-computable $? "$(cat "$T/z.json")"
bash "$SB" --current "$T/c.tsv" > /dev/null 2>&1; [ $? -eq 2 ]; check usage-rc2 $? ""

# --human-floor-min: lifts a recorded 0 (baseline 4 min, floor 1 min -> current 1 min: human 4x, efficiency 0.625 -> 10 = 16x)
bash "$SB" --current "$T/c.tsv" --baseline "$T/b.tsv" --version v --human-floor-min 1 --json-out "$T/f.json" --metrics-out "$T/f.metrics" > "$T/f.out" 2>&1
[ "$(jget "$T/f.json" tasks.trivial-sum.efficiency_factor)" = "16.0" ]; check floor-makes-efficiency-computable $? "$(cat "$T/f.out")"
[ "$(jget "$T/f.json" tasks.trivial-sum.human_factor)" = "4.0" ]; check floor-human-factor $? "$(cat "$T/f.out")"
[ "$(jget "$T/f.json" tasks.trivial-sum.floor_note)" = "(floor 1 min applied)" ]; check floor-json-label $? "$(cat "$T/f.json")"
grep -q '^trivial-sum .*(floor 1 min applied)' "$T/f.out" && grep -q 'trivial-sum:.*(floor 1 min applied)' "$T/f.metrics"; check floor-row-labels $? "$(cat "$T/f.out" "$T/f.metrics")"
# a floor that no recorded value falls under leaves the row unlabelled
bash "$SB" --dry --version v --human-floor-min 0.5 --json-out "$T/g.json" > "$T/g.out" 2>&1
! grep -q floor "$T/g.out"; check floor-unused-no-label $? "$(cat "$T/g.out")"
# never applied to NOT RECORDED: medium stays NOT RECORDED even with a huge floor, labelled rows are only those lifted
bash "$SB" --dry --version v --human-floor-min 100 --json-out "$T/h.json" > "$T/h.out" 2>&1
[ "$(jget "$T/h.json" tasks.medium.human_factor)" = "NOT RECORDED" ] && [ "$(jget "$T/h.json" tasks.medium.efficiency_factor)" = "NOT RECORDED" ]; check floor-never-fills-not-recorded $? "$(cat "$T/h.out")"
# a VERIFIED run that failed the hidden checks is not delivered: cost_per_verified and EFFICIENCY count verified AND solved
printf 'trivial-sum\t1\t1\t1\t60\t0.40\t4\ntrivial-sum\t2\t1\t0\t60\t0.40\t4\n' > "$T/fb.tsv"
printf 'trivial-sum\t1\t1\t1\t60\t0.20\t4\ntrivial-sum\t2\t1\t1\t60\t0.20\t4\n' > "$T/fc.tsv"
bash "$SB" --current "$T/fc.tsv" --baseline "$T/fb.tsv" --version v --json-out "$T/fv.json" > /dev/null 2>&1
# per delivered task: baseline 0.80/1, current 0.40/2 -> cost factor 4 (counting the false VERIFIED would give 2)
[ "$(jget "$T/fv.json" tasks.trivial-sum.cost_factor)" = "4.0" ]; check false-verified-not-delivered-40x $? "$(cat "$T/fv.json")"
# unset floor keeps today's behavior
[ "$(jget "$T/d.json" human_floor_min)" = "None" ]; check floor-unset-default $? ""

# a legacy 6-column TSV (no solved column) exits 2 with a message, never a silent NOT RUN
printf 'trivial-sum\t1\t1\t30\t0.20\t2\n' > "$T/legacy.tsv"
bash "$SB" --current "$T/legacy.tsv" --baseline "$T/legacy.tsv" --version v --json-out "$T/legacy.json" > "$T/legacy.out" 2>&1
RC=$?
[ "$RC" -eq 2 ] && grep -q 'solved' "$T/legacy.out"; check legacy-6-column-exits-2 $? "rc=$RC $(cat "$T/legacy.out")"

# wrong-pass column: one hermetic stub-verifier run of benchmarks/seeded-defects/measure.py (no model call, no key)
# feeds the scoreboard as five per-category rows. Stub seals every logic-bug and security defect only.
cat > "$T/stub-verifier.sh" <<'STUB'
#!/usr/bin/env bash
case "$SD_CATEGORY" in logic-bug|security) echo SEALED ;; *) echo NOT_SEALED ;; esac
STUB
python3 -I "$SCRIPT_DIR/../benchmarks/seeded-defects/measure.py" --setup top --model stub --verifier "bash $T/stub-verifier.sh" \
    --out "$T/wp.json" > "$T/wp.run" 2>&1
check wrong-pass-stub-run $? "$(cat "$T/wp.run")"
bash "$SB" --dry --version v --wrong-pass "$T/wp.json" --json-out "$T/w.json" > "$T/w.out" 2>&1
check wrong-pass-rc $? "$(cat "$T/w.out")"
NCAT="$(python3 -I -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["wrong_pass"]["top"]["categories"]))' "$T/w.json" 2>&1)"
[ "$NCAT" = "5" ]; check wrong-pass-five-categories $? "got $NCAT"
for c in logic-bug mock-abuse security spec-miss test-fitting; do
    grep -q "^wrong_pass top .*$c" "$T/w.out"; check "wrong-pass-row-$c" $? "$(cat "$T/w.out")"
done
[ "$(jget "$T/w.json" wrong_pass.top.categories.mock-abuse.wrong_pass)" = "0" ]; check wrong-pass-unsealed-zero $? "$(cat "$T/w.json")"
LB="$(jget "$T/w.json" wrong_pass.top.categories.logic-bug.wrong_pass)"
LN="$(jget "$T/w.json" wrong_pass.top.categories.logic-bug.n)"
[ -n "$LN" ] && [ "$LB" = "$LN" ] && [ "$LN" -gt 0 ]; check wrong-pass-sealed-counted $? "wrong_pass=$LB n=$LN"
bash "$SB" --dry --version v --wrong-pass "$T/wp.json" --json-out "$T/w2.json" --metrics-out "$T/wm.metrics" > /dev/null 2>&1
grep -q 'wrong_pass:top:.*logic-bug=' "$T/wm.metrics"; check wrong-pass-metrics-cell $? "$(cat "$T/wm.metrics" 2>&1)"
# without --wrong-pass the report has no wrong_pass key (existing consumers unchanged)
[ "$(python3 -I -c 'import json,sys;print("wrong_pass" in json.load(open(sys.argv[1])))' "$T/d.json")" = "False" ]; check wrong-pass-absent-by-default $? ""
# malformed wrong-pass inputs fail loudly (rc 2, named on stderr), never a silent empty column
wpbad() { printf '%s' "$1" > "$T/bad.json"; bash "$SB" --dry --version v --wrong-pass "$T/bad.json" --json-out "$T/bad-out.json" > "$T/bad.out" 2>&1; RC=$?; }
wpbad '{"runs":[{"setup":"s","outcomes":{"zzz":"SEALED"}}]}'
[ "$RC" -eq 2 ] && grep -q 'zzz' "$T/bad.out"; check wrong-pass-unknown-id-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpbad '{}'
[ "$RC" -eq 2 ]; check wrong-pass-empty-object-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpbad '{"runs":[]}'
[ "$RC" -eq 2 ]; check wrong-pass-empty-runs-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpbad '[1,2]'
[ "$RC" -eq 2 ] && ! grep -q Traceback "$T/bad.out"; check wrong-pass-toplevel-list-rc2 $? "rc=$RC $(cat "$T/bad.out")"
# lost or unmeasured wrong pass must not read as a clean 0
# variants of the full-coverage stub run, so each guard is the only thing that can fire
wpmut() {
    python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1])); r=d["runs"][0]; ids=sorted(r["outcomes"]); m=sys.argv[2]
if m=="dup": d["runs"].append(json.loads(json.dumps(r)))
elif m=="bogus": r["outcomes"][ids[0]]="BOGUS"
elif m=="null": r["outcomes"][ids[0]]=None
elif m=="nosetup": del r["setup"]
json.dump(d,open(sys.argv[3],"w"))' "$T/wp.json" "$1" "$T/bad.json"
    bash "$SB" --dry --version v --wrong-pass "$T/bad.json" --json-out "$T/bad-out.json" > "$T/bad.out" 2>&1; RC=$?
}
wpmut dup
[ "$RC" -eq 2 ] && grep -q 'duplicate setup' "$T/bad.out"; check wrong-pass-duplicate-setup-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpmut bogus
[ "$RC" -eq 2 ] && grep -q 'BOGUS' "$T/bad.out"; check wrong-pass-bogus-verdict-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpmut null
[ "$RC" -eq 2 ] && grep -q 'None' "$T/bad.out"; check wrong-pass-null-verdict-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpmut nosetup
[ "$RC" -eq 2 ] && grep -q 'setup' "$T/bad.out"; check wrong-pass-missing-setup-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpbad '{"runs":[{"setup":"top","outcomes":{}}]}'
[ "$RC" -eq 2 ] && grep -q 'empty outcomes' "$T/bad.out"; check wrong-pass-empty-outcomes-rc2 $? "rc=$RC $(cat "$T/bad.out")"
wpbad '{"runs":[{"setup":"top","outcomes":{"SD-0001":"SEALED"}}]}'
[ "$RC" -eq 2 ] && grep -q 'unmeasured' "$T/bad.out" && grep -q 'mock-abuse' "$T/bad.out"; check wrong-pass-partial-coverage-rc2 $? "rc=$RC $(cat "$T/bad.out")"
# a malformed manifest fails loudly too (python entry point: the shell wrapper does not forward --wrong-pass-manifest)
wpman() {
    printf '%s' "$1" > "$T/man.json"
    python3 -I "$SCRIPT_DIR/../scripts/scoreboard-40x.py" \
        --current "$SCRIPT_DIR/../scripts/b9-fixtures/recorded-40x/current.tsv" \
        --baseline "$SCRIPT_DIR/../scripts/b9-fixtures/recorded-40x/baseline-11.3.1.tsv" \
        --version v --wrong-pass "$T/wp.json" --wrong-pass-manifest "$T/man.json" --json-out "$T/man-out.json" > "$T/man.out" 2>&1
    RC=$?
}
wpman '{"defects":[{"id":"SD-0001"}]}'
[ "$RC" -eq 2 ] && grep -q 'without id and category' "$T/man.out" && ! grep -q Traceback "$T/man.out"; check wrong-pass-manifest-defect-no-category-rc2 $? "rc=$RC $(cat "$T/man.out")"
wpman '{"defects":[]}'
[ "$RC" -eq 2 ] && grep -q 'declares no categories' "$T/man.out"; check wrong-pass-manifest-no-categories-rc2 $? "rc=$RC $(cat "$T/man.out")"
# a missing results file exits 2, never a silent empty column
bash "$SB" --dry --version v --wrong-pass "$T/nope.json" --json-out "$T/x.json" > /dev/null 2>&1; [ $? -eq 2 ]; check wrong-pass-missing-file-rc2 $? ""

[ "$FAILS" -eq 0 ]
