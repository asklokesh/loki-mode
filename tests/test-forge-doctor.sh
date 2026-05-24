#!/usr/bin/env bash
# Test: N-06 `loki forge doctor` combined CLI report.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. compute_health on empty forge_dir returns ok
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    r = compute_health(d)
    assert r['ok'] is True
    assert r['status'] == 'ok'
    assert r['codes'] == []
print('OK')" | grep -q '^OK$'; then pass "N-06 empty forge clean"; else fail "false codes"; fi

# 2. compute_health detects FRG001 (required.json without db.sqlite)
if run_py "
import os, tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    open(os.path.join(d, 'required.json'), 'w').write('{}')
    r = compute_health(d)
    codes = [c['code'] for c in r['codes']]
    assert 'FRG001' in codes, codes
print('OK')" | grep -q '^OK$'; then pass "N-06 FRG001 detected"; else fail "FRG001 missed"; fi

# 3. doctor CLI runs and emits a doctor/v1 envelope
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
out=$(TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor 2>&1 || true)
if echo "$out" | grep -q '"schema": "loki.forge.doctor/v1"' \
   && echo "$out" | grep -q '"health"'; then
    pass "N-06 doctor CLI envelope"
else
    fail "doctor missing fields: $out"
fi
rm -rf "$tmp"

# 4. doctor CLI exit code reflects critical-code presence (0 if no
#    critical codes, 2 if any). DKR001 from sandbox diagnose is
#    environmental, so we test the contract not the value: exit must
#    match the "critical" count in the JSON output.
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor > "$tmp/out.json" 2>&1
exit_code=$?
set -e
if grep -q '"status": "critical"' "$tmp/out.json"; then
    [[ "$exit_code" == "2" ]] && pass "N-06 doctor exits 2 on critical" \
        || fail "critical but exit $exit_code"
else
    [[ "$exit_code" == "0" ]] && pass "N-06 doctor exits 0 when not critical" \
        || fail "non-critical but exit $exit_code"
fi
rm -rf "$tmp"

# 5. /api/forge/health route still works after refactor
if run_py "
import tempfile
from forge.health import compute_health
# Sanity: the route now delegates to compute_health, so this same
# function must continue to produce the existing schema.
with tempfile.TemporaryDirectory() as d:
    r = compute_health(d)
    assert r['schema'] == 'loki.forge.health/v1'
print('OK')" | grep -q '^OK$'; then pass "N-06 health schema preserved"; else fail "schema drift"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
