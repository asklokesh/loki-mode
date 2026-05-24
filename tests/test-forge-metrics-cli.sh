#!/usr/bin/env bash
# Test: N-30 `loki forge metrics` renders Prometheus text locally.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. CLI runs and exits 0 even with no forge state
tmp=$(mktemp -d)
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics > "$tmp/out.txt" 2>&1
exit_code=$?
set -e
if [[ "$exit_code" == "0" ]]; then
    pass "N-30 CLI exits 0 on empty"
else
    fail "exit $exit_code"
fi
rm -rf "$tmp"

# 2. With provisioned forge state, output includes Prometheus comments
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
req = ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])])
provision(req, sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics > "$tmp/out.txt" 2>&1
if grep -q '^# HELP forge_tables_total' "$tmp/out.txt" \
   && grep -q '^forge_tables_total' "$tmp/out.txt"; then
    pass "N-30 emits HELP + metric lines"
else
    fail "no prometheus output: $(head -10 "$tmp/out.txt")"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
