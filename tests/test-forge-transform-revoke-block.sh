#!/usr/bin/env bash
# Test: N-28 register_transform_preset rejects revoked names unless force.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. registering a name that was revoked fails by default
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    try:
        register_transform_preset(d, 'images',
            {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]})
        print('NO_RAISE')
    except ValueError as e:
        assert 'previously revoked' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-28 revoked name blocked"; else fail "block missed"; fi

# 2. force=True bypasses the block
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    list_transform_presets,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]}, force=True)
    names = [p['name'] for p in list_transform_presets(d, 'images')]
    assert 'thumb' in names, names
print('OK')" | grep -q '^OK$'; then pass "N-28 force bypasses"; else fail "force ignored"; fi

# 3. name never revoked: register works as before
if run_py "
import tempfile
from forge.services.storage import register_transform_preset, list_transform_presets
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    assert any(p['name'] == 'thumb' for p in list_transform_presets(d, 'images'))
print('OK')" | grep -q '^OK$'; then pass "N-28 fresh name unaffected"; else fail "regression"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
