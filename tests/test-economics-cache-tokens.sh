#!/usr/bin/env bash
# The token report must count the tokens the run was actually billed for.
#
# `loki memory economics` summed input and output tokens only. Cache tokens
# DOMINATE real traffic: a measured iteration carried 797,496 cache-read tokens
# against 10,272 of plain input. On that shape the report described roughly 1%
# of the run and called it total_tokens.
#
# Two consequences, both bad for a user trying to control spend:
#   - the headline token count was wrong by two orders of magnitude
#   - the cache hit ratio, which is the single biggest lever a user has on
#     cost, was not reported at all, so a run with a COLD cache (paying full
#     input rate on every token) looked identical to one with a warm cache
#
# The engine has recorded cache_read_tokens and cache_creation_tokens per
# iteration since v6.82.0. The data was there the whole time; the report threw
# it away.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: cache tokens in the economics report"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-econ-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# $1=dir $2=input $3=output $4=cache_read $5=cache_creation
seed() {
    local dir="$SCRATCH/$1"
    rm -rf "$dir"; mkdir -p "$dir/.loki/metrics/efficiency"
    printf '{"iteration":1,"model":"sonnet","phase":"dev","duration_ms":60000,"cost_usd":0.5,"input_tokens":%s,"output_tokens":%s,"cache_read_tokens":%s,"cache_creation_tokens":%s}\n' \
        "$2" "$3" "$4" "$5" > "$dir/.loki/metrics/efficiency/iteration-1.json"
    printf '%s' "$dir"
}

econ() { (cd "$1" && bash "$LOKI" memory economics 2>/dev/null); }
field() { python3 -c "
import json,sys
try: d=json.loads(sys.stdin.read())
except Exception: print('PARSE_ERROR'); raise SystemExit
print(d.get(sys.argv[1], 'MISSING'))" "$2" <<<"$1"; }

# --- 1. the measured real-world shape ----------------------------------------
d="$(seed real 10272 6164 797496 79769)"
out="$(econ "$d")"

[[ "$(field "$out" total_cache_read_tokens)" == "797496" ]] \
    && ok "cache-read tokens are counted" \
    || ko "cache-read tokens are counted" "got: $(field "$out" total_cache_read_tokens)"

[[ "$(field "$out" total_cache_creation_tokens)" == "79769" ]] \
    && ok "cache-creation tokens are counted" \
    || ko "cache-creation tokens are counted" "got: $(field "$out" total_cache_creation_tokens)"

# total_tokens must be everything billed: 10272+6164+797496+79769 = 893701.
# The old behaviour reported 16436, which is 1.8% of the real figure.
tt="$(field "$out" total_tokens)"
if [[ "$tt" == "893701" ]]; then
    ok "total_tokens counts every billed token (893701, not 16436)"
else
    ko "total_tokens counts every billed token" \
       "got $tt; 16436 means cache is still excluded and the headline is 1.8% of reality"
fi

# --- 2. the cache hit ratio, the actual cost lever ---------------------------
# 797496 / (797496 + 10272) = 0.9873
chr="$(field "$out" cache_hit_ratio)"
if [[ "$chr" == "0.9873" ]]; then
    ok "cache hit ratio is reported (0.9873 on the measured shape)"
else
    ko "cache hit ratio is reported" "got: $chr"
fi

# --- 3. a COLD cache must look different from a warm one ---------------------
# This is the whole point: without the ratio these two runs were indistinguishable
# in the report, while costing very different amounts.
d_cold="$(seed cold 800000 6000 0 0)"
cold="$(econ "$d_cold")"
ccr="$(field "$cold" cache_hit_ratio)"
if [[ "$ccr" == "0.0" || "$ccr" == "0" ]]; then
    ok "a cold-cache run reports a 0 hit ratio (visibly different from warm)"
else
    ko "a cold-cache run reports a 0 hit ratio" "got: $ccr"
fi

# --- 4. no divide-by-zero on an empty run ------------------------------------
d_zero="$(seed zero 0 0 0 0)"
zout="$(econ "$d_zero")"
zr="$(field "$zout" cache_hit_ratio)"
if [[ "$zr" == "PARSE_ERROR" || "$zr" == "MISSING" ]]; then
    ko "a zero-token run does not crash the report" "got: $zr"
else
    ok "a zero-token run reports a ratio without dividing by zero"
fi

# --- 5. records predating the cache fields still work ------------------------
# Back-compat: an old record has no cache keys at all and must not become
# MISSING or crash.
d_old="$SCRATCH/old"; rm -rf "$d_old"; mkdir -p "$d_old/.loki/metrics/efficiency"
printf '{"iteration":1,"model":"sonnet","input_tokens":100,"output_tokens":50,"cost_usd":0.1}\n' \
    > "$d_old/.loki/metrics/efficiency/iteration-1.json"
oout="$(econ "$d_old")"
if [[ "$(field "$oout" total_tokens)" == "150" && "$(field "$oout" total_cache_read_tokens)" == "0" ]]; then
    ok "a pre-cache record still totals correctly (150, cache 0)"
else
    ko "a pre-cache record still totals correctly" \
       "tokens=$(field "$oout" total_tokens) cache=$(field "$oout" total_cache_read_tokens)"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
