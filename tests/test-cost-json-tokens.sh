#!/usr/bin/env bash
# `loki cost --json` must say WHY a run cost what it cost.
#
# Fourth instance in this chain of the same shape: a fix lands on one surface
# while a sibling surface keeps the old behaviour, so the feature looks shipped
# and is not.
#
# v8.13.1 taught the economics report to count cache tokens and report the hit
# ratio, after finding the old report described about 1% of a run. `loki cost
# --json` -- the surface CI and dashboards consume -- still emitted a bare
# dollar figure. A consumer could see WHAT a run cost and nothing about why,
# even though cache reads are typically ~98% of input volume and are the single
# biggest lever on that number.
#
# The data was never missing: collect_efficiency (the shared source of truth,
# also used by the proof generator) already sums the full token breakdown. This
# surface took `usd` and discarded the rest.
#
# THE PROPERTY: with no tokens the hit ratio is null, never 0.0. A zero is a
# claim about a COLD cache -- a real and expensive condition -- and reporting it
# for a run with no data would send someone hunting a caching problem that does
# not exist.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: loki cost --json exposes the token breakdown"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-costjson-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# $1=name $2=input $3=output $4=cache_read $5=cache_creation
seed() {
    local d="$SCRATCH/$1"
    rm -rf "$d"; mkdir -p "$d/.loki/metrics/efficiency"
    printf '{"iteration":1,"model":"sonnet","cost_usd":1.2,"status":"completed","input_tokens":%s,"output_tokens":%s,"cache_read_tokens":%s,"cache_creation_tokens":%s}\n' \
        "$2" "$3" "$4" "$5" > "$d/.loki/metrics/efficiency/iteration-1.json"
    printf '%s' "$d"
}

field() {
    (cd "$1" && bash "$LOKI" cost --json 2>/dev/null) | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); raise SystemExit
cur = d
for k in sys.argv[1].split('.'):
    if not isinstance(cur, dict):
        print('MISSING'); raise SystemExit
    cur = cur.get(k)
print('NULL' if cur is None else cur)" "$2"
}

# --- 1. output is still valid JSON with its existing fields ------------------
d="$(seed basic 1000 500 90000 5000)"
[[ "$(field "$d" current_run.cost_usd)" == "1.2" ]] \
    && ok "the JSON still parses and keeps cost_usd" \
    || ko "the JSON still parses and keeps cost_usd" "got: $(field "$d" current_run.cost_usd)"

# --- 2. the cache tokens that dominate the bill are exposed -----------------
[[ "$(field "$d" current_run.tokens.cache_read_tokens)" == "90000" ]] \
    && ok "cache-read tokens are exposed" \
    || ko "cache-read tokens are exposed" "got: $(field "$d" current_run.tokens.cache_read_tokens)"
[[ "$(field "$d" current_run.tokens.cache_creation_tokens)" == "5000" ]] \
    && ok "cache-creation tokens are exposed" \
    || ko "cache-creation tokens are exposed"

# total must be everything billed: 1000+500+90000+5000 = 96500.
tt="$(field "$d" current_run.tokens.total_tokens)"
if [[ "$tt" == "96500" ]]; then
    ok "total_tokens counts every billed token (96500, not 1500)"
else
    ko "total_tokens counts every billed token" \
       "got $tt; 1500 means cache is excluded and the total describes 1.5% of the run"
fi

# --- 3. the hit ratio, the actual lever -------------------------------------
# 90000 / (90000 + 1000) = 0.989
chr="$(field "$d" current_run.tokens.cache_hit_ratio)"
[[ "$chr" == "0.989" ]] \
    && ok "the cache hit ratio is reported (0.989)" \
    || ko "the cache hit ratio is reported" "got: $chr"

# A COLD run must be visibly different from a warm one -- that difference is
# the whole reason the ratio exists.
d_cold="$(seed cold 91000 500 0 0)"
[[ "$(field "$d_cold" current_run.tokens.cache_hit_ratio)" == "0.0" ]] \
    && ok "a cold-cache run reports ratio 0.0, visibly distinct from warm" \
    || ko "a cold-cache run reports ratio 0.0" "got: $(field "$d_cold" current_run.tokens.cache_hit_ratio)"

# --- 4. THE PROPERTY. No tokens -> null ratio, not 0.0. ---------------------
d_zero="$(seed zero 0 0 0 0)"
zr="$(field "$d_zero" current_run.tokens.cache_hit_ratio)"
if [[ "$zr" == "NULL" ]]; then
    ok "a zero-token run reports a null ratio, not a fabricated 0.0"
else
    ko "a zero-token run reports a null ratio, not a fabricated 0.0" \
       "got: $zr -- 0.0 is a claim about a COLD cache and would send someone hunting a caching bug"
fi

# --- 5. no metrics at all must not crash ------------------------------------
d_none="$SCRATCH/none"; rm -rf "$d_none"; mkdir -p "$d_none/.loki"
out="$(field "$d_none" current_run.cost_usd)"
[[ "$out" != "PARSE_ERROR" ]] \
    && ok "a run with no metrics still emits valid JSON" \
    || ko "a run with no metrics still emits valid JSON"

# --- 6. a corrupt record must not break the surface -------------------------
d_bad="$(seed corrupt 100 50 900 10)"
printf 'not json\n' > "$d_bad/.loki/metrics/efficiency/iteration-9.json"
[[ "$(field "$d_bad" current_run.cost_usd)" != "PARSE_ERROR" ]] \
    && ok "a corrupt efficiency record does not break the JSON" \
    || ko "a corrupt efficiency record does not break the JSON"

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
