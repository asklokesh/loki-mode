#!/usr/bin/env bash
# Test: N-wave 13 (N-151..N-160)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-151: openapi_cache_ttl_s field present + non-negative
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    h = compute_health(d)
    assert 'openapi_cache_ttl_s' in h, h
    ttl = h['openapi_cache_ttl_s']
    assert ttl is None or (isinstance(ttl, int) and ttl >= 0), ttl
print('OK')" | grep -q '^OK$'; then pass "N-151 ttl_s"; else fail "missing"; fi

# N-152: schedule with multiple tags emits one line per tag
if run_py "
import tempfile
from forge.services.schedules import create
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    create(d, name='h', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'},
           tags=['env-prod', 'tenant-acme'])
    out = render(d)
    lines = [l for l in out.splitlines()
             if l.startswith('forge_schedule_next_fire_ts{')]
    assert len(lines) == 2, lines
print('OK')" | grep -q '^OK$'; then pass "N-152 multi-line tags"; else fail "wrong count"; fi

# N-153: list_dropped_defaults since_ts
if run_py "
import tempfile, time
from forge.services.email import unset_template, list_dropped_defaults
from forge.services.email.templates import DEFAULT_TEMPLATES
name = next(iter(DEFAULT_TEMPLATES))
with tempfile.TemporaryDirectory() as d:
    unset_template(d, name, force=True)
    cutoff = int(time.time()) + 60
    assert list_dropped_defaults(d, since_ts=cutoff) == []
    assert len(list_dropped_defaults(d, since_ts=0)) == 1
print('OK')" | grep -q '^OK$'; then pass "N-153 dropped since_ts"; else fail "filter wrong"; fi

# N-154: list_purges since_ts
if run_py "
import os, tempfile, time
from forge.services.functions import purge_runs, list_purges
with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, 'functions', 'f', 'logs'))
    purge_runs(d, 'f', keep_last_n=1)
    cutoff = int(time.time()) + 60
    assert list_purges(d, 'f', since_ts=cutoff) == []
    assert len(list_purges(d, 'f', since_ts=0)) == 1
print('OK')" | grep -q '^OK$'; then pass "N-154 purges since_ts"; else fail "filter wrong"; fi

# N-155: weak_secrets_count(unused_for_days=N) filters
if run_py "
import json, os, tempfile, time
from forge.services.secrets.vault import (
    set_secret, weak_secrets_count, _vault_path,
)
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['alg'] = 'HMAC-XOR'
    data['entries']['A']['created_at'] = int(time.time()) - 100 * 86400
    with open(p, 'w') as f: json.dump(data, f)
    assert weak_secrets_count(d, unused_for_days=90) == 1
    assert weak_secrets_count(d, unused_for_days=200) == 0
print('OK')" | grep -q '^OK$'; then pass "N-155 weak+stale count"; else fail "wrong"; fi

# N-156: dry_run op carries target_row_count
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}}
    ]}, dry_run=True)
    op = res['ops'][0]
    assert 'target_row_count' in op, op
print('OK')" | grep -q '^OK$'; then pass "N-156 target_row_count"; else fail "missing"; fi

# N-157: --history-stats emits json summary
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge/doctor-history"
touch "$tmp/.loki/forge/doctor-history/doctor-a.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-stats > "$tmp/out.json" 2>&1
if grep -q '"count": 1' "$tmp/out.json" && grep -q '"oldest"' "$tmp/out.json"; then
    pass "N-157 stats summary"
else
    fail "wrong stats"
fi
rm -rf "$tmp"

# N-158: metrics --watch --max-iterations 1 terminates fast
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 3 "$ROOT/bin/loki" forge metrics --watch 1 --max-iterations 1 > "$tmp/out.txt" 2>&1
ec=$?
set -e
if [[ "$ec" != "124" ]] && grep -qE '^---.*Z ---' "$tmp/out.txt"; then
    pass "N-158 max-iter terminates"
else
    fail "didn't stop (exit $ec)"
fi
rm -rf "$tmp"

# N-159: summary starts with mode=summary
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary > "$tmp/out.txt" 2>&1 || true
if grep -q '^mode=summary' "$tmp/out.txt"; then
    pass "N-159 mode prefix"
else
    fail "no prefix"
fi
rm -rf "$tmp"

# N-160: ETag header on /api/forge/openapi
if python3 -c "import fastapi" 2>/dev/null; then
    if run_py "
import tempfile, os
d = tempfile.mkdtemp()
os.chdir(d)
os.makedirs('.loki/forge', exist_ok=True)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get('/api/forge/openapi')
assert r.status_code == 200, r.status_code
assert 'etag' in r.headers, dict(r.headers)
etag = r.headers['etag']
# Second call with If-None-Match returns 304
r2 = c.get('/api/forge/openapi', headers={'if-none-match': etag})
assert r2.status_code == 304, r2.status_code
print('OK')" | grep -q '^OK$'; then pass "N-160 ETag + 304"; else fail "no caching"; fi
else
    pass "N-160 SKIP (fastapi missing)"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
