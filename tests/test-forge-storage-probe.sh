#!/usr/bin/env bash
# Test: N-03 storage gateway probe on configure().
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. probe=False (default) skips reachability check; configure succeeds
#    even with an unreachable endpoint
if run_py "
import tempfile
from forge.services.storage import configure_gateway
with tempfile.TemporaryDirectory() as d:
    cfg = configure_gateway(d, provider='s3',
        endpoint='http://127.0.0.1:1',  # nothing listening on port 1
        bucket='b', region='us-east-1')
    assert cfg['provider'] == 's3'
print('OK')" | grep -q '^OK$'; then pass "N-03 probe default off"; else fail "default probe ran"; fi

# 2. probe=True against a reachable local HTTP server returns ok
if run_py "
import tempfile, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from forge.services.storage import configure_gateway, probe_storage_bucket

class H(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200); self.end_headers()
    def log_message(self, *a, **k): pass

srv = HTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()

try:
    r = probe_storage_bucket(endpoint=f'http://127.0.0.1:{port}', bucket='b')
    assert r['ok'] is True, r
    assert r['status'] == 200, r
    with tempfile.TemporaryDirectory() as d:
        cfg = configure_gateway(d, provider='s3',
            endpoint=f'http://127.0.0.1:{port}', bucket='b',
            probe=True, probe_timeout_s=2.0)
        assert cfg['provider'] == 's3'
    print('OK')
finally:
    srv.shutdown()" | grep -q '^OK$'; then pass "N-03 probe success path"; else fail "reachable probe broke"; fi

# 3. probe=True against an unreachable endpoint raises StorageProbeError
if run_py "
import tempfile
from forge.services.storage import configure_gateway, StorageProbeError
with tempfile.TemporaryDirectory() as d:
    try:
        configure_gateway(d, provider='s3',
            endpoint='http://127.0.0.1:1', bucket='b',
            probe=True, probe_timeout_s=1.0)
        print('NO_RAISE')
    except StorageProbeError as e:
        msg = str(e)
        assert 'b' in msg and '127.0.0.1' in msg, msg
        print('OK')" | grep -q '^OK$'; then pass "N-03 unreachable raises StorageProbeError"; else fail "did not raise"; fi

# 4. 403 from the endpoint still counts as reachable (private bucket case)
if run_py "
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from forge.services.storage import probe_storage_bucket

class H(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(403); self.end_headers()
    def log_message(self, *a, **k): pass

srv = HTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
try:
    r = probe_storage_bucket(endpoint=f'http://127.0.0.1:{port}', bucket='b')
    assert r['ok'] is True and r['status'] == 403, r
    print('OK')
finally:
    srv.shutdown()" | grep -q '^OK$'; then pass "N-03 private bucket counts as reachable"; else fail "403 treated as failure"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
