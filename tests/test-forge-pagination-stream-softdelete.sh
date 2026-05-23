#!/usr/bin/env bash
# Test: X-52 pagination + X-53 streaming + X-54 soft delete.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. X-52: query_page paginates a SELECT
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'items','columns':['id pk','name text']}}]})
    # Bulk insert 25 rows
    for i in range(25):
        e.execute(f\"INSERT INTO items (name) VALUES ('item-{i}')\", allow_writes=True)
    page = e.query_page('SELECT id, name FROM items ORDER BY id', limit=10)
    assert len(page['rows']) == 10
    assert page['has_more'] is True and page['next_cursor'] == 10
    page2 = e.query_page('SELECT id, name FROM items ORDER BY id', limit=10, cursor=page['next_cursor'])
    assert len(page2['rows']) == 10 and page2['next_cursor'] == 20
    page3 = e.query_page('SELECT id, name FROM items ORDER BY id', limit=10, cursor=20)
    assert len(page3['rows']) == 5 and page3['has_more'] is False
print('OK')" | grep -q '^OK$'; then pass "X-52 cursor pagination"; else fail "pagination broken"; fi

# 2. X-52: rejects write SQL
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    try: e.query_page('DELETE FROM t')
    except PermissionError: print('OK'); raise SystemExit
    raise AssertionError('DELETE accepted')
" | grep -q '^OK$'; then pass "X-52 rejects writes"; else fail "writes accepted"; fi

# 3. X-52: rejects multi-statement
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try: e.query_page('SELECT 1; SELECT 2')
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('multi-statement accepted')
" | grep -q '^OK$'; then pass "X-52 rejects multi-statement"; else fail "multi accepted"; fi

# 4. X-53: streaming upload happy path
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload_stream, download
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    def chunks():
        yield b'hello, '
        yield b'world'
    meta = upload_stream(d, 'bucket-a', 'greet.txt', chunks())
    assert meta['size'] == 12
    blob, _ = download(d, 'bucket-a', 'greet.txt')
    assert blob == b'hello, world'
print('OK')" | grep -q '^OK$'; then pass "X-53 stream upload + download"; else fail "stream upload broken"; fi

# 5. X-53: streaming caps file size
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload_stream, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a', max_file_size=10)
    def big():
        for _ in range(20):
            yield b'\\x00' * 100  # 2000 bytes total
    try: upload_stream(d, 'bucket-a', 'x.bin', big())
    except BucketError: print('OK'); raise SystemExit
    raise AssertionError('over-cap stream accepted')
" | grep -q '^OK$'; then pass "X-53 stream size cap"; else fail "size cap leak"; fi

# 6. X-53: streaming dedupes
if run_py "
import os, tempfile
from forge.services.storage import create_bucket, upload_stream
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    def c(): yield b'identical'
    upload_stream(d, 'bucket-a', 'a.txt', c())
    upload_stream(d, 'bucket-a', 'b.txt', c())
    blobs = []
    for r, _, files in os.walk(os.path.join(d, 'storage', 'bucket-a', 'blobs')):
        blobs.extend(files)
    # Should be exactly 1 (dedup by sha256).
    assert len(blobs) == 1, blobs
print('OK')" | grep -q '^OK$'; then pass "X-53 stream dedupes"; else fail "dedup broken"; fi

# 7. X-54: soft_delete adds deleted_at column
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','title text'],
        'soft_delete': True}}]})
    snap = introspect(e)
    cols = [c['name'] for c in snap['tables'][0]['columns']]
    assert 'deleted_at' in cols, cols
print('OK')" | grep -q '^OK$'; then pass "X-54 soft_delete adds deleted_at"; else fail "soft delete broken"; fi

# 8. X-54: idempotent when user supplies deleted_at
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','deleted_at timestamp'],
        'soft_delete': True}}]})
    snap = introspect(e)
    cols = [c['name'] for c in snap['tables'][0]['columns']]
    # No duplicates.
    assert cols.count('deleted_at') == 1, cols
print('OK')" | grep -q '^OK$'; then pass "X-54 idempotent when explicit"; else fail "duplicate column emitted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
