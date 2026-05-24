#!/usr/bin/env bash
# Test: N-17 forge doctor probes the storage gateway when non-fs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. fs gateway: no storage probe attempted (no FRG005)
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    r = compute_health(d)
    codes = [c['code'] for c in r['codes']]
    assert 'FRG005' not in codes, codes
print('OK')" | grep -q '^OK$'; then pass "N-17 fs skips probe"; else fail "fs probed"; fi

# 2. unreachable non-fs gateway: FRG005 critical
if run_py "
import tempfile
from forge.services.storage import configure_gateway
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    configure_gateway(d, provider='s3',
        endpoint='http://127.0.0.1:1', bucket='b')
    r = compute_health(d)
    frg005 = [c for c in r['codes'] if c['code'] == 'FRG005']
    assert frg005, r['codes']
    assert frg005[0]['severity'] == 'critical'
    assert 'b' in frg005[0]['message']
print('OK')" | grep -q '^OK$'; then pass "N-17 unreachable -> FRG005"; else fail "no FRG005"; fi

# 3. reachable non-fs gateway: no FRG005
if run_py "
import tempfile, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from forge.services.storage import configure_gateway
from forge.health import compute_health

class H(BaseHTTPRequestHandler):
    def do_HEAD(self): self.send_response(200); self.end_headers()
    def log_message(self, *a, **k): pass

srv = HTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
import threading
t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
try:
    with tempfile.TemporaryDirectory() as d:
        configure_gateway(d, provider='s3',
            endpoint=f'http://127.0.0.1:{port}', bucket='b')
        r = compute_health(d)
        codes = [c['code'] for c in r['codes']]
        assert 'FRG005' not in codes, codes
    print('OK')
finally:
    srv.shutdown()" | grep -q '^OK$'; then pass "N-17 reachable clean"; else fail "false probe failure"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
