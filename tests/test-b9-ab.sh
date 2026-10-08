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

# Delivered = VERIFIED AND solved: a false VERIFIED (hidden checks failed) must not earn COST-HALF.
{
    for r in 1 2 3; do printf 'raw\tt\t%s\t1\t1\t10\t1.0\t0\t0\n' "$r"; done
    for r in 1 2 3; do printf 'loki\tt\t%s\t0\t1\t10\t0.5\t0\t0\n' "$r"; done
} > "$T/fv.tsv"
bash "$B9" --ab-report "$T/fv.tsv" --json-out "$T/fv.json" --version t > /dev/null 2>&1
[ "$(jget "$T/fv.json" cost_ratio.value)" = "NOT COMPUTABLE" ]; check false-verified-not-delivered $? "$(cat "$T/fv.json")"
# one of three truly delivered: $1.5 / 1 = 1.5 vs 1.0 -> 1.5 (the two false VERIFIED runs add cost, not deliveries)
{
    for r in 1 2 3; do printf 'raw\tt\t%s\t1\t1\t10\t1.0\t0\t0\n' "$r"; done
    printf 'loki\tt\t1\t1\t1\t10\t0.5\t0\t0\n'
    printf 'loki\tt\t2\t0\t1\t10\t0.5\t0\t0\n'
    printf 'loki\tt\t3\t0\t1\t10\t0.5\t0\t0\n'
} > "$T/fv2.tsv"
bash "$B9" --ab-report "$T/fv2.tsv" --json-out "$T/fv2.json" --version t > /dev/null 2>&1
[ "$(jget "$T/fv2.json" cost_ratio.value)" = "1.5" ]; check false-verified-excluded-from-denominator $? "$(cat "$T/fv2.json")"

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

# --- CTO: cost and time come only from SDK result totals / RECEIPT-TRUTH fields -------------------------------
ab_one() { # ab_one tag [env assignments...]: --ab --dry, one trivial-sum run per arm; rows land in $T/<tag>.tsv
    local tag="$1"; shift
    env -u LOKI_RUN_TMP "$@" bash "$B9" --ab --dry --fixtures trivial-sum --n 1 --results-out "$T/$tag.tsv" --json-out "$T/$tag.json" > "$T/$tag.out" 2>&1
}
col() { awk -F '\t' -v a="$2" -v c="$3" '$1==a{print $c}' "$T/$1.tsv"; } # col tag arm column
NRS='NOT RECORDED'
# default stubs: raw wall is the SDK duration_ms (14000 ms -> 14.0 s), loki wall is receipt time.total_s (42)
ab_one ok
[ "$(col ok raw 6)" = "14.0" ] && [ "$(col ok loki 6)" = "42" ]; check wall-from-sdk-duration-and-receipt-total $? "$(cat "$T/ok.tsv")"
[ "$(col ok raw 8)" = "500" ] && [ "$(col ok raw 9)" = "100" ] && [ "$(col ok loki 8)" = "1000" ] && [ "$(col ok loki 9)" = "200" ]; check cache-fields-recorded $? "$(cat "$T/ok.tsv")"
# the old fields are never a total: a receipt with only time.wall_s and cost.input_tokens is NOT RECORDED
OLD='{"verdict":"VERIFIED","cost":{"usd":0.5,"input_tokens":999},"time":{"wall_s":777,"stages":{"plan":777}}}'
ab_one old B9_STUB_RECEIPT="$OLD"
[ "$(col old loki 6)" = "$NRS" ] && [ "$(col old loki 7)" = "$NRS" ] && [ "$(col old loki 5)" = "1" ]; check old-receipt-fields-not-recorded $? "$(cat "$T/old.tsv")"
! grep -q '777' "$T/old.tsv"; check wall_s-never-read-as-total $? "$(cat "$T/old.tsv")"
# receipt lacking one cache field is NOT RECORDED
NOCC='{"verdict":"VERIFIED","cost":{"usd":0.5,"cache_read_tokens":1},"time":{"total_s":40,"stages":{"plan":40}}}'
ab_one nocc B9_STUB_RECEIPT="$NOCC"
[ "$(col nocc loki 6)" = "$NRS" ] && [ "$(col nocc loki 7)" = "$NRS" ]; check missing-cache-creation-not-recorded $? "$(cat "$T/nocc.tsv")"
# cross-check: total_s must equal the sum of stages within 1%
mkrec() { printf '{"verdict":"VERIFIED","cost":{"usd":0.5,"cache_read_tokens":1,"cache_creation_tokens":1},"time":{"total_s":%s,"stages":{"plan":40,"implement":60}}}' "$1"; }
ab_one in1 B9_STUB_RECEIPT="$(mkrec 100.9)"
[ "$(col in1 loki 6)" = "100.9" ]; check crosscheck-within-1pct-recorded $? "$(cat "$T/in1.tsv")"
ab_one out1 B9_STUB_RECEIPT="$(mkrec 101.5)"
[ "$(col out1 loki 6)" = "$NRS" ] && [ "$(col out1 loki 7)" = "$NRS" ]; check crosscheck-over-1pct-not-recorded $? "$(cat "$T/out1.tsv")"
ab_one big B9_STUB_RECEIPT="$(mkrec 150)"
[ "$(col big loki 6)" = "$NRS" ]; check crosscheck-total-far-from-stages $? "$(cat "$T/big.tsv")"
# a receipt without stages cannot be reconciled: NOT RECORDED (same rule as the engine's reconciledTotalS)
NOST='{"verdict":"VERIFIED","cost":{"usd":0.5,"cache_read_tokens":1,"cache_creation_tokens":1},"time":{"total_s":33}}'
ab_one nost B9_STUB_RECEIPT="$NOST"
[ "$(col nost loki 6)" = "$NRS" ]; check no-stages-not-recorded $? "$(cat "$T/nost.tsv")"
# raw: a result line without duration_ms or without a cache field is NOT RECORDED
ab_one rnd B9_STUB_CLAUDE_JSON='{"type":"result","total_cost_usd":0.2,"usage":{"cache_read_input_tokens":1,"cache_creation_input_tokens":1}}'
[ "$(col rnd raw 6)" = "$NRS" ] && [ "$(col rnd raw 7)" = "$NRS" ]; check raw-missing-duration-not-recorded $? "$(cat "$T/rnd.tsv")"
ab_one rnc B9_STUB_CLAUDE_JSON='{"type":"result","total_cost_usd":0.2,"duration_ms":5000,"usage":{"cache_read_input_tokens":1}}'
[ "$(col rnc raw 6)" = "$NRS" ] && [ "$(col rnc raw 7)" = "$NRS" ]; check raw-missing-cache-not-recorded $? "$(cat "$T/rnc.tsv")"
# the report then says NOT RECORDED for cost and wall, never a number
[ "$(jget "$T/old.json" cost_ratio.value)" = "$NRS" ] && [ "$(jget "$T/old.json" wall_ratio.value)" = "$NRS" ]; check report-not-recorded-when-fields-missing $? "$(cat "$T/old.json")"

[ "$FAILS" -eq 0 ]
