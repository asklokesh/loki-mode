#!/usr/bin/env bash
# Test: N-57 bus.history accepts before_ms to walk backwards.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. before_ms filters out newer messages
if run_py "
import tempfile, time
from forge.services.realtime.bus import publish, history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    publish(d, 'room', {'i': 1})
    time.sleep(0.05)
    midpoint = int(time.time() * 1000)
    time.sleep(0.05)
    publish(d, 'room', {'i': 2})
    h = history(d, 'room', before_ms=midpoint)
    payloads = [m['payload']['i'] for m in h]
    assert payloads == [1], payloads
print('OK')" | grep -q '^OK$'; then pass "N-57 before_ms filters newer"; else fail "filter broken"; fi

# 2. since_ms + before_ms combo gives a window
if run_py "
import tempfile, time
from forge.services.realtime.bus import publish, history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    publish(d, 'room', {'i': 1})
    time.sleep(0.05); t1 = int(time.time() * 1000)
    publish(d, 'room', {'i': 2})
    time.sleep(0.05); t2 = int(time.time() * 1000)
    publish(d, 'room', {'i': 3})
    h = history(d, 'room', since_ms=t1, before_ms=t2)
    payloads = [m['payload']['i'] for m in h]
    assert payloads == [2], payloads
print('OK')" | grep -q '^OK$'; then pass "N-57 windowed select"; else fail "window broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
