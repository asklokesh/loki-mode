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

[ "$FAILS" -eq 0 ]
