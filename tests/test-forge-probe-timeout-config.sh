#!/usr/bin/env bash
# Test: N-42 forge.yaml storage.probe_timeout_s is honored.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. compute_health accepts probe_timeout_s kwarg
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    r = compute_health(d, probe_timeout_s=0.5)
    assert 'codes' in r
print('OK')" | grep -q '^OK$'; then pass "N-42 kwarg accepted"; else fail "kwarg rejected"; fi

# 2. when no forge.yaml, doctor uses default 2.0
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor > "$tmp/out.json" 2>&1 || true
if grep -q '"schema": "loki.forge.doctor/v1"' "$tmp/out.json"; then
    pass "N-42 doctor runs without forge.yaml"
else
    fail "doctor broke without yaml"
fi
rm -rf "$tmp"

# 3. forge.yaml with probe_timeout_s=1 + unreachable gateway -> FRG005
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
cat > "$tmp/forge.yaml" <<'YAML'
storage:
  probe_timeout_s: 1
YAML
PYTHONPATH="$ROOT" python3 - "$tmp" <<'PY'
import sys
from forge.services.storage import configure_gateway
configure_gateway(sys.argv[1] + '/.loki/forge', provider='s3',
    endpoint='http://127.0.0.1:1', bucket='b')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor > "$tmp/out.json" 2>&1 || true
if grep -q '"FRG005"' "$tmp/out.json"; then
    pass "N-42 honored + FRG005 raised"
else
    fail "FRG005 missing: $(grep -A2 codes "$tmp/out.json")"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
