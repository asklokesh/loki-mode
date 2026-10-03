#!/usr/bin/env bash
# S-226r: an unmeasured cost reads "unmeasured" in `loki stats`, never $0.00,
# on both the bash route and the bun route.
# shellcheck disable=SC2016
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -u
export LOKI_NO_BROWSER=1
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/stats-unmeasured.XXXXXXXX")" || exit 1
# loki appends events.jsonl from a detached writer, so retry the removal once.
trap 'rm -rf -- "$T" 2>/dev/null || { sleep 1; rm -rf -- "$T"; }' EXIT
mkdir -p "$T/.loki/metrics/efficiency"

BASH_OUT=""
BUN_OUT=""
run_both() {
    BASH_OUT=$(cd "$T" && LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$REPO_DIR/bin/loki" stats 2>&1)
    BUN_OUT=$(cd "$T" && LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$REPO_DIR/bin/loki" stats 2>&1)
}
check() {
    # check <route> <output> <pattern> <label>
    if printf '%s\n' "$2" | grep -q -- "$3"; then ok "$1: $4"; else bad "$1: $4 (pattern '$3' not found)"; fi
}
check_absent() {
    if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: $4"; else ok "$1: $4"; fi
}

# Case 1: iteration records without cost_usd
printf '{"input_tokens": 100, "output_tokens": 50, "duration_seconds": 5}\n' > "$T/.loki/metrics/efficiency/iteration-1.json"
run_both
check bash "$BASH_OUT" 'Estimated cost: unmeasured' "no cost_usd reads unmeasured"
check bun "$BUN_OUT" 'Estimated cost: unmeasured' "no cost_usd reads unmeasured"
check_absent bash "$BASH_OUT" 'Estimated cost: \$0.00' "no dollar zero for unmeasured cost"
check_absent bun "$BUN_OUT" 'Estimated cost: \$0.00' "no dollar zero for unmeasured cost"

# Case 2: a measured cost still prints the dollar figure
printf '{"input_tokens": 100, "output_tokens": 50, "duration_seconds": 5, "cost_usd": 1.5}\n' > "$T/.loki/metrics/efficiency/iteration-1.json"
run_both
check bash "$BASH_OUT" 'Estimated cost: \$1.50' "measured cost prints"
check bun "$BUN_OUT" 'Estimated cost: \$1.50' "measured cost prints"

# Case 3: an explicit measured zero stays $0.00
printf '{"input_tokens": 1, "output_tokens": 1, "duration_seconds": 1, "cost_usd": 0}\n' > "$T/.loki/metrics/efficiency/iteration-1.json"
run_both
check bash "$BASH_OUT" 'Estimated cost: \$0.00' "measured zero prints"
check bun "$BUN_OUT" 'Estimated cost: \$0.00' "measured zero prints"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
