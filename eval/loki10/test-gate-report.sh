#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-gate-report.sh
#
# E-33: the gate-report generator for EV-6 (gate_report.py) against the static
# result fixtures in fixtures/gate/. Never runs an arm.
# Legs:
#   1. all-met fixture -> met marker with n and the results sha256 in BOTH
#      files, four MET gate lines, per-arm table, misses listed; text outside
#      the block kept; a rerun is byte-identical (idempotent)
#   2. v10 p90 660s -> missed, the p90 line MISSED, slow tasks listed
#   3. null v10 cost -> missed, cost "not measured"
#   4. 24 evaluated tasks -> missed, "fewer than 25"
#   5. a model mismatch -> missed; arms on different harness_sha -> still met
#   5c. all-met plus one extra row on a second model, sample still 25/25 ->
#       missed on the one-model line alone, not on sample size
#   6. a file with no block gets one appended; a begin with no end is refused
#      and the file is left untouched
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"
export LOKI_NO_BROWSER=1
GEN="$HERE/gate_report.py"
FX="$HERE/fixtures/gate"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

if [ ! -f "$GEN" ]; then
    fail "gate_report.py is missing"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# seed DIR: a METRICS.md and a CHANGELOG.md with text around an old block.
seed() {
    mkdir -p "$1"
    for f in METRICS.md CHANGELOG.md; do
        printf '# %s head\n\n<!-- loki10-gate:begin -->\nstale block\n<!-- loki10-gate:end -->\n\ntail line\n' "$f" >"$1/$f"
    done
}
# gen NAME: run the generator on fixture NAME into its own dir.
gen() {
    seed "$T/$1"
    timeout -k 5 30 python3 "$GEN" "$FX/$1.jsonl" --metrics "$T/$1/METRICS.md" \
        --changelog "$T/$1/CHANGELOG.md" >"$T/$1/out.log" 2>&1
}
has() { grep -qF -- "$2" "$T/$1/METRICS.md"; }

# 1. all met
gen all-met; rc=$?
[ "$rc" = 0 ] && pass "all-met exits 0" || fail "all-met rc=$rc: $(cat "$T/all-met/out.log")"
want="<!-- loki10-gate: met n=25 results_sha256=$(sha "$FX/all-met.jsonl") -->"
for f in METRICS.md CHANGELOG.md; do
    grep -qxF -- "$want" "$T/all-met/$f" && pass "all-met $f carries the met marker" || fail "all-met $f marker missing: $want"
    { grep -qxF '# '"$f"' head' "$T/all-met/$f" && grep -qxF 'tail line' "$T/all-met/$f"; } \
        && pass "all-met $f keeps text outside the block" || fail "all-met $f lost surrounding text"
    grep -qF 'stale block' "$T/all-met/$f" && fail "all-met $f kept the stale block" || pass "all-met $f replaced the stale block"
done
n=$(grep -c ' | MET |' "$T/all-met/METRICS.md")
[ "$n" = 4 ] && pass "all-met has four MET gate lines" || fail "all-met MET gate lines=$n"
has all-met '| v10 | 25/25 | 100.0% | 230s | 330s | $0.5000 | 25/25 |' && pass "v10 table row" || fail "v10 table row wrong"
has all-met '| raw-claude | 20/25 | 80.0% | 300s | 380s | $1.2500 | 25/25 |' && pass "raw-claude table row" || fail "raw-claude table row wrong"
has all-met '- gt-21 / raw-claude: no branch pushed' && pass "misses list task and reason" || fail "miss gt-21 not listed"
cp "$T/all-met/METRICS.md" "$T/m1"; cp "$T/all-met/CHANGELOG.md" "$T/c1"
python3 "$GEN" "$FX/all-met.jsonl" --metrics "$T/all-met/METRICS.md" --changelog "$T/all-met/CHANGELOG.md" >/dev/null 2>&1
cmp -s "$T/m1" "$T/all-met/METRICS.md" && cmp -s "$T/c1" "$T/all-met/CHANGELOG.md" \
    && pass "rerun is byte-identical" || fail "rerun changed a target file"
[ "$(grep -c 'loki10-gate:begin' "$T/all-met/METRICS.md")" = 1 ] && pass "one block after rerun" || fail "block duplicated"

# 2. slow p90
gen v10-p90-slow
has v10-p90-slow '<!-- loki10-gate: missed n=25 ' && pass "p90 660s -> missed marker" || fail "p90 660s marker not missed"
has v10-p90-slow '| v10 p90 time to PR | 660s | <= 600s | MISSED |' && pass "p90 gate line MISSED" || fail "p90 gate line wrong"
for t in gt-23 gt-24 gt-25; do
    has v10-p90-slow "- $t / v10: time to PR 660s over 600s" && pass "slow task $t listed" || fail "slow task $t not listed"
done

# 3. null v10 cost
gen v10-null-cost
has v10-null-cost '<!-- loki10-gate: missed n=25 ' && pass "null cost -> missed marker" || fail "null cost marker not missed"
has v10-null-cost '| v10 | 25/25 | 100.0% | 230s | 330s | not measured | 24/25 |' && pass "null cost table says not measured" || fail "null cost table row wrong"
has v10-null-cost '| Cost per completed task (v10 vs raw-claude) | not measured vs $1.2500 | both measured, v10 <= raw-claude | MISSED |' \
    && pass "cost gate line MISSED with not measured" || fail "cost gate line wrong"

# 4. 24 evaluated
gen n24
has n24 '<!-- loki10-gate: missed n=24 ' && pass "n=24 -> missed marker" || fail "n=24 marker not missed"
has n24 'fewer than 25' && pass "n=24 says fewer than 25" || fail "n=24 lacks 'fewer than 25'"

# 5. model mismatch
gen model-mismatch
has model-mismatch '<!-- loki10-gate: missed ' && pass "model mismatch -> missed marker" || fail "model mismatch marker not missed"
has model-mismatch 'claude-opus-4-6, claude-sonnet-4-6' && pass "model mismatch names both models" || fail "model mismatch models not named"

# 5c. all-met plus one extra raw-claude row on claude-opus-4-6 (26 raw rows):
# the picked group still has 25/25 evaluated per arm, so sample_ok alone
# would read met; only the one-model check catches the second model.
gen model-mismatch-n25
has model-mismatch-n25 '<!-- loki10-gate: missed n=25 ' && pass "second model at n=25 -> missed marker" || fail "second model at n=25 marker not missed"
has model-mismatch-n25 '- Sample: v10 25, raw-claude 25 evaluated (need 25 or more per arm): MET' && pass "second model at n=25 sample line MET" || fail "second model at n=25 sample line not MET"
has model-mismatch-n25 '- One model across all rows: claude-opus-4-6, claude-sonnet-4-6: MISSED' && pass "second model at n=25 one-model line MISSED" || fail "second model at n=25 one-model line not MISSED"

# 5b. the arms ran on different harness commits: informational, not a miss
gen harness-sha-split
has harness-sha-split "<!-- loki10-gate: met n=25 results_sha256=$(sha "$FX/harness-sha-split.jsonl") -->" \
    && pass "harness_sha split across arms -> met n=25" || fail "harness_sha split did not read met n=25"
has harness-sha-split 'harness fixture0, fixture1-dirty.' && pass "harness shas listed" || fail "harness shas not listed"

# 6. append and refuse
mkdir -p "$T/edge"
printf 'no block here\n' >"$T/edge/METRICS.md"
printf '<!-- loki10-gate:begin -->\nhalf\n' >"$T/edge/CHANGELOG.md"
cp "$T/edge/CHANGELOG.md" "$T/edge/cl.before"
python3 "$GEN" "$FX/all-met.jsonl" --metrics "$T/edge/METRICS.md" --changelog "$T/edge/CHANGELOG.md" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && pass "begin without end refused (rc 2)" || fail "begin without end rc=$rc"
cmp -s "$T/edge/cl.before" "$T/edge/CHANGELOG.md" && pass "refused file untouched" || fail "refused file changed"
grep -qxF 'no block here' "$T/edge/METRICS.md" && ! grep -qF 'loki10-gate: met' "$T/edge/METRICS.md" \
    && pass "no write to either file on a refusal" || fail "METRICS written despite the refusal"
printf 'no block here\n' >"$T/edge/CHANGELOG.md"
python3 "$GEN" "$FX/all-met.jsonl" --metrics "$T/edge/METRICS.md" --changelog "$T/edge/CHANGELOG.md" >/dev/null 2>&1
{ head -1 "$T/edge/METRICS.md" | grep -qxF 'no block here' && grep -qF 'loki10-gate: met n=25' "$T/edge/METRICS.md"; } \
    && pass "block appended when absent" || fail "block not appended"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
