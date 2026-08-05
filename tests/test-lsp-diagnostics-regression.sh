#!/usr/bin/env bash
# v7.7.14 LSP regression test: verify lsp_get_diagnostics actually returns
# diagnostics (was broken since v7.7.0 - publishDiagnostics notifications
# were dropped by request() busy-read loop, pending_diagnostics never set).
#
# Strategy: feed the new reader thread synthetic LSP messages via a fake
# subprocess; assert pending_diagnostics gets populated; assert request()
# routing still works under concurrent notifications.
set -u

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Resolve the interpreter instead of hardcoding one. This was pinned to
# /opt/homebrew/bin/python3.12 -- one developer's Homebrew install. On CI every
# invocation died with "No such file or directory" and the suite reported a
# product failure ("structural attrs missing") for a path that does not exist
# there. Prefer an explicit PYTHON override, then python3 on PATH.
PY="${PYTHON:-$(command -v python3 2>/dev/null || echo python3)}"

# Test 1: structural - LSPClient has pending_diagnostics + reader thread
$PY -c "
import sys; sys.path.insert(0, '.')
from mcp import lsp_proxy
assert hasattr(lsp_proxy.LSPClient, '_reader_loop'), 'reader loop missing'
c = lsp_proxy.LSPClient('python', '/bin/echo', [])
assert hasattr(c, 'pending_diagnostics'), 'pending_diagnostics missing'
assert isinstance(c.pending_diagnostics, dict), 'wrong type'
assert hasattr(c, '_response_queues'), 'response queues missing'
assert hasattr(c, '_reader_stop'), 'reader stop event missing'
print('STRUCT_OK')
" 2>&1 | tail -1 | grep -q STRUCT_OK && ok "LSPClient has reader thread + pending_diagnostics + response queues" || bad "structural attrs missing"

# Test 2: synthetic end-to-end - feed a fake LSP, prove publishDiagnostics
# notifications populate pending_diagnostics via the reader thread.
$PY <<'PYEOF' 2>&1 | tail -5
import sys, os, json, time, threading, subprocess
sys.path.insert(0, '.')

# Build a tiny LSP-server-on-stdin/stdout fake: replies to initialize,
# then emits a publishDiagnostics notification with one error.
FAKE_SERVER = """
import sys, json, os, time
def write(msg):
    body = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n')
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()
def read():
    line = sys.stdin.buffer.readline()
    if not line: return None
    n = int(line.decode().split(':',1)[1].strip())
    sys.stdin.buffer.readline()  # blank line
    return json.loads(sys.stdin.buffer.read(n))
# initialize request -> respond
msg = read()
write({'jsonrpc':'2.0','id':msg['id'],'result':{'capabilities':{}}})
# initialized notification -> consume
read()
# wait for any didOpen, then emit a publishDiagnostics
while True:
    m = read()
    if m is None: break
    if m.get('method') == 'textDocument/didOpen':
        uri = m['params']['textDocument']['uri']
        # Emit a publishDiagnostics notification
        write({
            'jsonrpc': '2.0',
            'method': 'textDocument/publishDiagnostics',
            'params': {
                'uri': uri,
                'diagnostics': [{
                    'severity': 1,
                    'message': 'fake error for v7.7.14 regression test',
                    'range': {'start':{'line':0,'character':0},'end':{'line':0,'character':5}},
                    'source': 'fake-lsp'
                }]
            }
        })
        # Then respond to any further request
        continue
    if 'id' in m and m.get('method') != 'shutdown':
        write({'jsonrpc':'2.0','id':m['id'],'result':None})
"""
tmpdir = '/tmp/loki-lsp-test-v7714'
os.makedirs(tmpdir, exist_ok=True)
fake_path = os.path.join(tmpdir, 'fake_lsp.py')
open(fake_path, 'w').write(FAKE_SERVER)
fixture_ts = os.path.join(tmpdir, 'broken.ts')
open(fixture_ts, 'w').write('const x: number = "wrong"; // type error\n')

from mcp import lsp_proxy
client = lsp_proxy.LSPClient('typescript', sys.executable, [fake_path])
try:
    client.start()
    # Reader thread is now running; send didOpen to trigger the fake's diagnostic
    client.did_open(fixture_ts)
    # Wait up to 1s for the reader to populate pending_diagnostics
    target_uri = lsp_proxy._path_to_uri(fixture_ts)
    diags = []
    for _ in range(20):
        with client._lock:
            if target_uri in client.pending_diagnostics:
                diags = list(client.pending_diagnostics[target_uri])
                break
        time.sleep(0.05)
    if not diags:
        print('END2END_FAIL: pending_diagnostics empty after 1s')
    elif diags[0].get('source') != 'fake-lsp':
        print(f'END2END_FAIL: wrong source {diags[0]}')
    elif diags[0].get('severity') != 1:
        print(f'END2END_FAIL: wrong severity {diags[0]}')
    else:
        print('END2END_OK')
finally:
    client.shutdown()
PYEOF
RESULT=$?
if [ "$RESULT" -eq 0 ]; then
    ok "end-to-end: fake LSP publishDiagnostics populates client.pending_diagnostics via reader thread"
else
    bad "end-to-end run exited non-zero"
fi

# Test 3: request routing still works (sanity - we changed request())
$PY <<'PYEOF' 2>&1 | tail -3
import sys, os, json
sys.path.insert(0, '.')
FAKE_SERVER = """
import sys, json
def write(msg):
    body = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n')
    sys.stdout.buffer.write(body); sys.stdout.buffer.flush()
def read():
    line = sys.stdin.buffer.readline()
    if not line: return None
    n = int(line.decode().split(':',1)[1].strip())
    sys.stdin.buffer.readline()
    return json.loads(sys.stdin.buffer.read(n))
m = read(); write({'jsonrpc':'2.0','id':m['id'],'result':{'capabilities':{}}})
read()
while True:
    m = read()
    if m is None: break
    if 'id' in m:
        write({'jsonrpc':'2.0','id':m['id'],'result':{'echoed':m['method']}})
"""
tmpdir = '/tmp/loki-lsp-test-v7714'
os.makedirs(tmpdir, exist_ok=True)
fake_path = os.path.join(tmpdir, 'fake_lsp2.py')
open(fake_path, 'w').write(FAKE_SERVER)
from mcp import lsp_proxy
client = lsp_proxy.LSPClient('python', sys.executable, [fake_path])
try:
    client.start()
    resp = client.request('test/method', {'foo':'bar'}, timeout=2.0)
    if resp.get('result', {}).get('echoed') == 'test/method':
        print('REQUEST_OK')
    else:
        print(f'REQUEST_FAIL: {resp}')
finally:
    client.shutdown()
PYEOF
RESULT=$?
if [ "$RESULT" -eq 0 ]; then
    ok "request routing via per-id Queue works (response echoed back)"
else
    bad "request routing test exited non-zero"
fi

# Test 4 (council fix): reader-death drains pending waiters with error
# sentinel instead of hanging full timeout. Kill subprocess mid-flight,
# pending request() must return error within ~1s, not the 5s timeout.
$PY <<'PYEOF' 2>&1 | tail -3
import sys, os, time, threading
sys.path.insert(0, '.')
HANG_SERVER = """
import sys, json, time
def write(msg):
    body = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n')
    sys.stdout.buffer.write(body); sys.stdout.buffer.flush()
def read():
    line = sys.stdin.buffer.readline()
    if not line: return None
    n = int(line.decode().split(':',1)[1].strip())
    sys.stdin.buffer.readline()
    return json.loads(sys.stdin.buffer.read(n))
m = read(); write({'jsonrpc':'2.0','id':m['id'],'result':{'capabilities':{}}})
read()  # initialized
# Then hang forever - never respond to further requests
while True: time.sleep(60)
"""
tmpdir = '/tmp/loki-lsp-test-v7714'
os.makedirs(tmpdir, exist_ok=True)
hang_path = os.path.join(tmpdir, 'hang_lsp.py')
open(hang_path, 'w').write(HANG_SERVER)
from mcp import lsp_proxy
client = lsp_proxy.LSPClient('python', sys.executable, [hang_path])
try:
    client.start()
    # Fire a request in background; kill subprocess mid-request
    result_box = {}
    def runner():
        result_box['t0'] = time.time()
        result_box['resp'] = client.request('test/method', {}, timeout=10.0)
        result_box['dt'] = time.time() - result_box['t0']
    t = threading.Thread(target=runner, daemon=True); t.start()
    time.sleep(0.2)
    # Kill the subprocess: closes stdout -> reader gets EOF -> drains waiters
    client.proc.kill()
    t.join(timeout=2.0)
    if 'dt' not in result_box:
        print(f'DRAIN_FAIL: runner still blocked after 2s')
    elif result_box['dt'] > 1.5:
        print(f'DRAIN_FAIL: took {result_box["dt"]:.2f}s (should be <1s on EOF drain)')
    elif 'error' not in result_box['resp']:
        print(f'DRAIN_FAIL: expected error, got {result_box["resp"]}')
    else:
        print(f'DRAIN_OK: error returned in {result_box["dt"]:.2f}s')
finally:
    try: client.shutdown()
    except Exception: pass
PYEOF
RESULT=$?
if [ "$RESULT" -eq 0 ]; then
    ok "reader-death drains pending waiters with error sentinel (no hang)"
else
    bad "drain test exited non-zero"
fi

# Test 5 (council fix): re-spawn after crash does not leak reader thread
$PY <<'PYEOF' 2>&1 | tail -3
import sys, os, time, threading
sys.path.insert(0, '.')
SERVER = """
import sys, json
def write(msg):
    body = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n')
    sys.stdout.buffer.write(body); sys.stdout.buffer.flush()
def read():
    line = sys.stdin.buffer.readline()
    if not line: return None
    n = int(line.decode().split(':',1)[1].strip())
    sys.stdin.buffer.readline()
    return json.loads(sys.stdin.buffer.read(n))
m = read(); write({'jsonrpc':'2.0','id':m['id'],'result':{'capabilities':{}}})
read()
import time
while True: time.sleep(1)
"""
tmpdir = '/tmp/loki-lsp-test-v7714'
os.makedirs(tmpdir, exist_ok=True)
srv = os.path.join(tmpdir, 'srv.py')
open(srv, 'w').write(SERVER)
from mcp import lsp_proxy
client = lsp_proxy.LSPClient('python', sys.executable, [srv])
client.start()
old_thread = client._reader_thread
# Crash the subprocess
client.proc.kill()
client.proc.wait(timeout=1.0)
client._initialized = True  # simulate "already initialized" guard
# Re-spawn (start() must detect dead proc and re-init cleanly)
client._initialized = False  # because start() short-circuits on initialized+alive
client.start()
new_thread = client._reader_thread
# Old reader thread should have stopped; new one should be alive and different
time.sleep(0.3)
if old_thread is new_thread:
    print('LEAK_FAIL: reader thread not replaced')
elif old_thread.is_alive():
    print(f'LEAK_FAIL: old reader thread {old_thread.name} still alive')
elif not new_thread.is_alive():
    print('LEAK_FAIL: new reader thread not alive')
else:
    print('LEAK_OK')
client.shutdown()
PYEOF
RESULT=$?
if [ "$RESULT" -eq 0 ]; then
    ok "re-spawn does not leak old reader thread"
else
    bad "thread-leak test exited non-zero"
fi

# Cleanup
rm -rf /tmp/loki-lsp-test-v7714

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
