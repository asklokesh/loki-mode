#!/usr/bin/env bash
# Test: N-31 `loki forge metrics --label` adds static labels.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. render(labels={env:prod}) injects env="prod" on every metric line
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk'])])
    provision(req, d)
    out = render(d, labels={'env': 'prod'})
    for line in out.splitlines():
        if line and not line.startswith('#'):
            assert 'env=\"prod\"' in line, line
print('OK')" | grep -q '^OK$'; then pass "N-31 labels on every metric"; else fail "labels missing"; fi

# 2. existing label is preserved alongside the new one
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk'])])
    provision(req, d)
    out = render(d, labels={'env': 'prod'})
    # forge_rows_estimate already has table=\"items\"
    found = [l for l in out.splitlines() if 'forge_rows_estimate' in l and not l.startswith('#')]
    assert any('table=\"items\"' in l and 'env=\"prod\"' in l for l in found), found
print('OK')" | grep -q '^OK$'; then pass "N-31 merge with existing"; else fail "merge broken"; fi

# 3. CLI --label flag works
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --label env=prod,region=us > "$tmp/out.txt" 2>&1
if grep -q 'env="prod"' "$tmp/out.txt" && grep -q 'region="us"' "$tmp/out.txt"; then
    pass "N-31 CLI flag works"
else
    fail "CLI labels missing: $(head -10 "$tmp/out.txt")"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
