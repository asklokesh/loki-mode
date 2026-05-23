#!/usr/bin/env bash
# Test: forge.spec_detector heuristics + write_required_json (v7.6.0 Phase F-1).
# Unit test - no DB, no subprocess. Exercises the Python module directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

run_py() {
    PYTHONPATH="$ROOT" python3 -c "$1" 2>&1
}

# 1. Module imports cleanly
if run_py "import forge; print(forge.__version__)" | grep -qE '^[0-9]'; then
    pass "forge module imports + exposes __version__"
else
    fail "forge module import failed"
fi

# 2. Empty text -> none=True
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('')
assert r.none
print('OK')" | grep -q '^OK$'; then
    pass "empty spec -> none=True"
else
    fail "empty spec did not yield none=True"
fi

# 3. PRD with 'users table' -> detects users
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Build a thing with a users table.')
names = [t.name for t in r.tables]
assert 'users' in names, names
print('OK')" | grep -q '^OK$'; then
    pass "PRD with users table -> detected"
else
    fail "users table not detected"
fi

# 4. PRD with 'Sign in with Google' -> detects google
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Add Sign in with Google for users.')
assert 'google' in r.auth_providers
print('OK')" | grep -q '^OK$'; then
    pass "Google OAuth phrase detected"
else
    fail "Google OAuth not detected"
fi

# 5. PRD with 'user uploads' -> detects user-uploads bucket
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Users can upload their avatar.')
assert 'user-uploads' in r.buckets, r.buckets
print('OK')" | grep -q '^OK$'; then
    pass "user-uploads bucket detected"
else
    fail "user-uploads bucket not detected"
fi

# 6. PRD with 'Stripe' -> payments
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Use Stripe for subscriptions.')
assert 'stripe' in r.payments, r.payments
print('OK')" | grep -q '^OK$'; then
    pass "Stripe payments detected"
else
    fail "Stripe not detected"
fi

# 7. PRD with 'realtime feed' -> realtime channel
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Show a live feed.')
assert 'feed' in r.realtime_channels, r.realtime_channels
print('OK')" | grep -q '^OK$'; then
    pass "realtime feed detected"
else
    fail "realtime feed not detected"
fi

# 8. PRD with 'daily digest' -> schedule
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Send a daily digest at 8am.')
assert 'daily-digest' in r.schedules, r.schedules
print('OK')" | grep -q '^OK$'; then
    pass "daily-digest schedule detected"
else
    fail "daily-digest schedule not detected"
fi

# 9. Pure CLI tool -> none=True
if run_py "
from forge.spec_detector import detect_from_text
r = detect_from_text('Build a CLI tool that converts CSV to JSON.')
assert r.none, (r.none, r.tables, r.auth_providers)
print('OK')" | grep -q '^OK$'; then
    pass "pure CLI tool -> none=True"
else
    fail "CLI tool incorrectly flagged a backend requirement"
fi

# 10. write_required_json round-trips
if run_py "
import json, os, tempfile
from forge.spec_detector import detect_from_text, write_required_json
r = detect_from_text('Build with a users table and posts table.')
with tempfile.TemporaryDirectory() as d:
    p = write_required_json(r, d)
    data = json.load(open(p))
    assert data['schema'] == 'loki.forge.requirements/v1'
    assert len(data['tables']) == 2
print('OK')" | grep -q '^OK$'; then
    pass "write_required_json persists + reloads"
else
    fail "write_required_json round-trip broke"
fi

# 11. Missing file -> none=True (does not raise)
if run_py "
from forge.spec_detector import detect_from_path
r = detect_from_path('/nonexistent/path/PRD.md')
assert r.none
print('OK')" | grep -q '^OK$'; then
    pass "missing spec path -> none=True without exception"
else
    fail "missing spec path raised or wrong result"
fi

# 12. X-37: BMAD workspace detection
if run_py "
import os
from forge import detect_from_bmad_workspace
wd = os.path.join('$ROOT', 'tests', 'fixtures', 'bmad')
req = detect_from_bmad_workspace(wd)
assert not req.none, 'BMAD workspace should detect something'
print('OK')" | grep -q '^OK$'; then pass "X-37 BMAD workspace detect"; else fail "BMAD detect broken"; fi

# 13. X-37: graceful fallback when path missing
if run_py "
from forge import detect_from_bmad_workspace
req = detect_from_bmad_workspace('/nonexistent')
assert req.none
print('OK')" | grep -q '^OK$'; then pass "X-37 BMAD missing path safe"; else fail "BMAD missing path crashes"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
