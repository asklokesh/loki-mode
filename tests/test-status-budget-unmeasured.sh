#!/usr/bin/env bash
# S-226r: `loki status` reads "Cost: unmeasured" when budget.json has no
# budget_used, on both the bash route and the bun route.
# shellcheck disable=SC2016
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -u
export LOKI_NO_BROWSER=1
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/status-unmeasured.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/.loki/metrics"

BASH_OUT=""
BUN_OUT=""
strip() { sed -e $'s/\x1b\\[[0-9;]*m//g'; }
run_both() {
    BASH_OUT=$(cd "$T" && LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$REPO_DIR/bin/loki" status 2>&1 | strip)
    BUN_OUT=$(cd "$T" && LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$REPO_DIR/bin/loki" status 2>&1 | strip)
}
check() {
    if printf '%s\n' "$2" | grep -q -- "$3"; then ok "$1: $4"; else bad "$1: $4 (pattern '$3' not found)"; fi
}
check_absent() {
    if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: $4"; else ok "$1: $4"; fi
}

# Case 1: no budget_used, no limit
printf '{"budget_limit": 0}\n' > "$T/.loki/metrics/budget.json"
run_both
check bash "$BASH_OUT" '^Cost: unmeasured$' "missing budget_used reads unmeasured"
check bun "$BUN_OUT" '^Cost: unmeasured$' "missing budget_used reads unmeasured"
check_absent bash "$BASH_OUT" 'Cost: \$0 (no limit)' "no dollar zero for unmeasured cost"
check_absent bun "$BUN_OUT" 'Cost: \$0 (no limit)' "no dollar zero for unmeasured cost"

# Case 2: measured value still prints
printf '{"budget_limit": 0, "budget_used": 2.5}\n' > "$T/.loki/metrics/budget.json"
run_both
check bash "$BASH_OUT" 'Cost: \$2.5 (no limit)' "measured cost prints"
check bun "$BUN_OUT" 'Cost: \$2.5 (no limit)' "measured cost prints"

# Case 3: explicit measured zero stays $0
printf '{"budget_limit": 0, "budget_used": 0}\n' > "$T/.loki/metrics/budget.json"
run_both
check bash "$BASH_OUT" 'Cost: \$0 (no limit)' "measured zero prints"
check bun "$BUN_OUT" 'Cost: \$0 (no limit)' "measured zero prints"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
