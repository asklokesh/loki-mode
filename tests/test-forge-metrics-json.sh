#!/usr/bin/env bash
# Test: N-45 `loki forge metrics --json` returns structured data.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. CLI runs and emits the schema envelope
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/out.json" 2>&1
if grep -q '"schema": "loki.forge.metrics/v1"' "$tmp/out.json" \
   && grep -q '"metrics":' "$tmp/out.json"; then
    pass "N-45 schema envelope"
else
    fail "missing schema: $(head -10 "$tmp/out.json")"
fi
rm -rf "$tmp"

# 2. structured entries have name + labels + value
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/out.json" 2>&1
PYTHONPATH="$ROOT" python3 - <<PY "$tmp/out.json"
import json, sys
data = json.load(open(sys.argv[1]))
ms = data['metrics']
assert all('name' in m and 'labels' in m and 'value' in m for m in ms), ms[:3]
print('OK')
PY
if true; then
    if PYTHONPATH="$ROOT" python3 -c "
import json
d = json.load(open('$tmp/out.json'))
ms = d['metrics']
assert all('name' in m and 'labels' in m and 'value' in m for m in ms)
print('OK')" | grep -q '^OK$'; then
        pass "N-45 entries well-shaped"
    else
        fail "shape wrong"
    fi
fi
rm -rf "$tmp"

# 3. --json + --label still works
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json --label env=prod > "$tmp/out.json" 2>&1
if PYTHONPATH="$ROOT" python3 -c "
import json
d = json.load(open('$tmp/out.json'))
assert any(m['labels'].get('env') == 'prod' for m in d['metrics'] if m['labels'])
print('OK')" | grep -q '^OK$'; then
    pass "N-45 labels flow through to JSON"
else
    fail "labels not present"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
