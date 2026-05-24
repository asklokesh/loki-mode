#!/usr/bin/env bash
# Test: N-33 list_revoked_presets surfaces audit-trail records.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. no revocations -> []
if run_py "
import tempfile
from forge.services.storage import list_revoked_presets
with tempfile.TemporaryDirectory() as d:
    assert list_revoked_presets(d, 'images') == []
print('OK')" | grep -q '^OK$'; then pass "N-33 empty -> []"; else fail "non-empty"; fi

# 2. after revoke -> trail has one entry with name + revoked_at
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    list_revoked_presets,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 100, 'h': 100}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    trail = list_revoked_presets(d, 'images')
    assert len(trail) == 1, trail
    assert trail[0]['name'] == 'thumb'
    assert 'revoked_at' in trail[0]
print('OK')" | grep -q '^OK$'; then pass "N-33 surfaces revoke"; else fail "trail missing"; fi

# 3. multiple revocations preserve order
if run_py "
import tempfile, time
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    list_revoked_presets,
)
with tempfile.TemporaryDirectory() as d:
    for name in ('a', 'b', 'c'):
        register_transform_preset(d, 'images',
            {'name': name, 'ops': [{'resize': {'w': 50, 'h': 50}}]})
        revoke_transform_preset(d, 'images', name)
        time.sleep(0.01)
    trail = list_revoked_presets(d, 'images')
    names = [r['name'] for r in trail]
    assert names == ['a', 'b', 'c'], names
print('OK')" | grep -q '^OK$'; then pass "N-33 chronological order"; else fail "order wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
