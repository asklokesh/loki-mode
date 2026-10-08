#!/usr/bin/env bash
# shellcheck disable=SC2319
# tests/test-b9-ab.sh -- B9-RAW-ARM: the raw-vs-loki arms of scripts/b9-scoreboard.sh. Ratio and bootstrap
# interval math on recorded fixtures, NOT RECORDED for a missing cost, and a --ab --dry end-to-end run.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
B9="$SCRIPT_DIR/../scripts/b9-scoreboard.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1
FAILS=0
check() { # check name rc detail
    if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi
}
jget() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d=d[k]
print(d)' "$1" "$2"; }

# Recorded results. Columns: arm fixture run solved verified wall usd.
# Fixture A: raw 3/3 at $0.10, loki 3/3 verified at $0.30 -> every run identical, so the interval collapses.
{
    for r in 1 2 3; do
        printf 'raw\ttrivial-sum\t%s\t1\t1\t20\t0.10\n' "$r"
        printf 'loki\ttrivial-sum\t%s\t1\t1\t60\t0.30\n' "$r"
    done
} > "$T/a.tsv"
bash "$B9" --ab-report "$T/a.tsv" --json-out "$T/a.json" --metrics-out "$T/a.metrics" --version 9.9.9 > "$T/a.out" 2>&1
check report-rc $? "$(cat "$T/a.out")"
[ "$(jget "$T/a.json" cost_ratio.value)" = "3.0" ]; check cost-ratio-3 $? "$(cat "$T/a.json")"
[ "$(jget "$T/a.json" cost_ratio.ci95)" = "[3.0, 3.0]" ]; check degenerate-interval $? "$(jget "$T/a.json" cost_ratio.ci95)"
[ "$(jget "$T/a.json" correctness_ratio.value)" = "1.0" ]; check correctness-ratio-1 $? "$(cat "$T/a.json")"
[ "$(jget "$T/a.json" wall_ratio.value)" = "3.0" ]; check wall-ratio-3 $? "$(cat "$T/a.json")"
[ "$(jget "$T/a.json" n.raw)" = "3" ] && [ "$(jget "$T/a.json" n.loki)" = "3" ]; check n-recorded $? "$(jget "$T/a.json" n)"
grep -q 'cost_ratio=3.00 ci95=\[3.00,3.00\]' "$T/a.metrics" && grep -q 'n=3/3' "$T/a.metrics" && grep -q '9.9.9' "$T/a.metrics"
check metrics-row $? "$(cat "$T/a.metrics")"

# Fixture B: loki verifies 2 of 3 at $0.30 each: $0.90 / 2 = $0.45 per verified task vs $0.10 -> 4.5; correctness 2/3.
{
    for r in 1 2 3; do printf 'raw\ttwo-bug\t%s\t1\t1\t20\t0.10\n' "$r"; done
    printf 'loki\ttwo-bug\t1\t1\t1\t50\t0.30\n'
    printf 'loki\ttwo-bug\t2\t1\t1\t60\t0.30\n'
    printf 'loki\ttwo-bug\t3\t0\t0\t70\t0.30\n'
} > "$T/b.tsv"
bash "$B9" --ab-report "$T/b.tsv" --json-out "$T/b.json" --version t > /dev/null 2>&1
[ "$(jget "$T/b.json" cost_ratio.value)" = "4.5" ]; check cost-per-verified-not-per-run $? "$(cat "$T/b.json")"
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["correctness_ratio"]["value"])' "$T/b.json" | grep -q '^0.6666'
check correctness-ratio-two-thirds $? "$(cat "$T/b.json")"
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]))["cost_ratio"];sys.exit(0 if d["ci95"][0]<=d["value"]<=d["ci95"][1] else 1)' "$T/b.json"
check interval-brackets-point $? "$(cat "$T/b.json")"
bash "$B9" --ab-report "$T/b.tsv" --json-out "$T/b2.json" --version t > /dev/null 2>&1
[ "$(jget "$T/b.json" cost_ratio)" = "$(jget "$T/b2.json" cost_ratio)" ]; check deterministic-seeded-bootstrap $? "differs between runs"

# A missing cost reads NOT RECORDED, never 0 (and never a ratio computed from the rest).
{
    for r in 1 2 3; do printf 'raw\ttrivial-sum\t%s\t1\t1\t20\t0.10\n' "$r"; done
    printf 'loki\ttrivial-sum\t1\t1\t1\t60\t0.30\n'
    printf 'loki\ttrivial-sum\t2\t1\t1\t60\tNOT RECORDED\n'
    printf 'loki\ttrivial-sum\t3\t1\t1\t60\t0.30\n'
} > "$T/m.tsv"
bash "$B9" --ab-report "$T/m.tsv" --json-out "$T/m.json" --metrics-out "$T/m.metrics" --version t > "$T/m.out" 2>&1
[ "$(jget "$T/m.json" cost_ratio.value)" = "NOT RECORDED" ]; check missing-cost-not-recorded $? "$(cat "$T/m.json")"
grep -q 'cost_ratio=NOT RECORDED' "$T/m.metrics" && ! grep -Eq 'cost_ratio=0([^.0-9]|$)' "$T/m.metrics"; check missing-cost-row $? "$(cat "$T/m.metrics")"
[ "$(jget "$T/m.json" correctness_ratio.value)" = "1.0" ]; check missing-cost-keeps-other-metrics $? "$(cat "$T/m.json")"
# an explicit zero is also not a cost
sed 's/NOT RECORDED/0/' "$T/m.tsv" > "$T/z.tsv"
bash "$B9" --ab-report "$T/z.tsv" --json-out "$T/z.json" --version t > /dev/null 2>&1
[ "$(jget "$T/z.json" cost_ratio.value)" = "NOT RECORDED" ]; check zero-cost-not-recorded $? "$(cat "$T/z.json")"
# n<3 per arm is labelled, never presented as significant
{ printf 'raw\ttrivial-sum\t1\t1\t1\t20\t0.10\n'; printf 'loki\ttrivial-sum\t1\t1\t1\t60\t0.30\n'; } > "$T/n1.tsv"
bash "$B9" --ab-report "$T/n1.tsv" --json-out "$T/n1.json" --metrics-out "$T/n1.metrics" --version t > /dev/null 2>&1
[ "$(jget "$T/n1.json" significant)" = "False" ] && grep -q 'n=1 not significant' "$T/n1.metrics"; check n1-labelled-not-significant $? "$(cat "$T/n1.metrics")"

[ "$(jget "$T/n1.json" cost_ratio.ci95)" = "NOT COMPUTABLE" ]; check n1-no-false-point-interval $? "$(cat "$T/n1.json")"

# --ab --dry: recorded stubs, both arms on both generated fixtures, then the report.
env -u LOKI_RUN_TMP bash "$B9" --ab --dry --n 3 --version dry --results-out "$T/d.tsv" --json-out "$T/d.json" --metrics-out "$T/d.metrics" > "$T/d.out" 2>&1
check ab-dry-rc $? "$(cat "$T/d.out")"
[ "$(wc -l < "$T/d.tsv" | tr -d ' ')" = "12" ]; check ab-dry-12-runs $? "$(cat "$T/d.tsv")"
[ "$(awk -F '\t' '$4==1' "$T/d.tsv" | wc -l | tr -d ' ')" = "12" ]; check ab-dry-hidden-checks-pass $? "$(cat "$T/d.tsv")"
[ "$(jget "$T/d.json" n.raw)" = "6" ] && [ "$(jget "$T/d.json" n.loki)" = "6" ]; check ab-dry-n $? "$(cat "$T/d.json")"
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if isinstance(d["cost_ratio"]["value"],float) else 1)' "$T/d.json"
check ab-dry-cost-ratio-numeric $? "$(cat "$T/d.json")"
grep -q 'b9-ab' "$T/d.metrics"; check ab-dry-metrics-row $? "$(cat "$T/d.metrics")"

[ "$FAILS" -eq 0 ]
