#!/usr/bin/env bash
# Test: N-52 list_revoked_presets includes still_revoked boolean.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. revoke + not re-registered -> still_revoked True
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    list_revoked_presets,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    trail = list_revoked_presets(d, 'images')
    assert trail[0]['still_revoked'] is True, trail
print('OK')" | grep -q '^OK$'; then pass "N-52 still_revoked True"; else fail "False unexpectedly"; fi

# 2. revoke + force re-register -> still_revoked False
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    list_revoked_presets,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]},
        force=True)
    trail = list_revoked_presets(d, 'images')
    assert trail[0]['still_revoked'] is False, trail
print('OK')" | grep -q '^OK$'; then pass "N-52 force re-register flips"; else fail "still True after force"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
