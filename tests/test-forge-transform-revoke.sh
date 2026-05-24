#!/usr/bin/env bash
# Test: N-14 revoke_transform_preset removes + audits a preset.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. revoke removes the preset from list_transform_presets
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, list_transform_presets,
    revoke_transform_preset,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    assert any(p['name'] == 'thumb' for p in list_transform_presets(d, 'images'))
    assert revoke_transform_preset(d, 'images', 'thumb') is True
    assert not any(p['name'] == 'thumb' for p in list_transform_presets(d, 'images'))
print('OK')" | grep -q '^OK$'; then pass "N-14 revoke removes preset"; else fail "preset stuck"; fi

# 2. revoke returns False on unknown name
if run_py "
import tempfile
from forge.services.storage import revoke_transform_preset
with tempfile.TemporaryDirectory() as d:
    assert revoke_transform_preset(d, 'images', 'ghost') is False
print('OK')" | grep -q '^OK$'; then pass "N-14 unknown -> False"; else fail "unknown true"; fi

# 3. revocation appends a .revoked.jsonl audit line
if run_py "
import json, os, tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    audit_path = os.path.join(d, 'storage', 'images', '.revoked.jsonl')
    assert os.path.isfile(audit_path), os.listdir(os.path.dirname(audit_path))
    with open(audit_path) as f:
        rec = json.loads(f.readline())
    assert rec['name'] == 'thumb'
    assert 'revoked_at' in rec
print('OK')" | grep -q '^OK$'; then pass "N-14 audit line written"; else fail "no audit"; fi

# 4. revoke does not touch sibling presets
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, list_transform_presets,
    revoke_transform_preset,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images', {'name': 'thumb',
        'ops': [{'resize': {'w': 50, 'h': 50}}]})
    register_transform_preset(d, 'images', {'name': 'small',
        'ops': [{'resize': {'w': 100, 'h': 100}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    names = [p['name'] for p in list_transform_presets(d, 'images')]
    assert 'small' in names and 'thumb' not in names, names
print('OK')" | grep -q '^OK$'; then pass "N-14 sibling preserved"; else fail "sibling dropped"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
