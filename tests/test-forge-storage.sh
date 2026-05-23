#!/usr/bin/env bash
# Test: forge.services.storage - buckets, signed URLs, transforms (Phase F-2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. create + list + delete bucket
if run_py "
import tempfile
from forge.services.storage import create_bucket, list_buckets, delete_bucket
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'avatars')
    create_bucket(d, 'public-assets', public=True)
    names = sorted(b['name'] for b in list_buckets(d))
    assert names == ['avatars', 'public-assets'], names
    delete_bucket(d, 'public-assets')
    names = [b['name'] for b in list_buckets(d)]
    assert names == ['avatars']
print('OK')" | grep -q '^OK$'; then
    pass "bucket create/list/delete roundtrip"
else
    fail "bucket CRUD broken"
fi

# 2. duplicate bucket rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'dup-test')
    try:
        create_bucket(d, 'dup-test')
    except BucketError:
        print('OK')
        raise SystemExit
    raise AssertionError('duplicate accepted')
" | grep -q '^OK$'; then
    pass "duplicate bucket rejected"
else
    fail "duplicate bucket accepted"
fi

# 3. invalid bucket name rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, BucketError
with tempfile.TemporaryDirectory() as d:
    for bad in ['UPPER', 'has space', 'a', '-leading', 'trailing-', 'with/slash']:
        try:
            create_bucket(d, bad)
        except BucketError:
            continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then
    pass "invalid bucket names rejected"
else
    fail "invalid bucket name accepted"
fi

# 4. upload + download roundtrip
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, download
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'files')
    payload = b'hello, world'
    meta = upload(d, 'files', 'greet.txt', payload, content_type='text/plain')
    assert meta['size'] == len(payload)
    assert meta['ctype'] == 'text/plain'
    blob, meta2 = download(d, 'files', 'greet.txt')
    assert blob == payload
    assert meta2['sha'] == meta['sha']
print('OK')" | grep -q '^OK$'; then
    pass "object upload + download roundtrip"
else
    fail "upload/download broken"
fi

# 5. content addressing dedupes
if run_py "
import os, tempfile
from forge.services.storage import create_bucket, upload
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    upload(d, 'bucket-a', 'a.txt', b'same')
    upload(d, 'bucket-a', 'b.txt', b'same')
    # Both index entries exist, but only one blob file.
    blobs_root = os.path.join(d, 'storage', 'bucket-a', 'blobs')
    blobs = []
    for r, _, files in os.walk(blobs_root):
        for f in files:
            blobs.append(os.path.join(r, f))
    assert len(blobs) == 1, blobs
print('OK')" | grep -q '^OK$'; then
    pass "content addressing dedupes shared payloads"
else
    fail "content dedupe broken"
fi

# 6. unsafe object paths rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    for bad in ['/abs', '../escape', 'a/../b']:
        try:
            upload(d, 'bucket-a', bad, b'x')
        except BucketError:
            continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then
    pass "unsafe object paths rejected"
else
    fail "unsafe object path accepted"
fi

# 7. file size cap enforced
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a', max_file_size=10)
    try:
        upload(d, 'bucket-a', 'x.txt', b'x' * 11)
    except BucketError:
        print('OK')
        raise SystemExit
    raise AssertionError('size cap not enforced')
" | grep -q '^OK$'; then
    pass "file size cap enforced"
else
    fail "size cap leak"
fi

# 8. content-type allowlist enforced
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a', allowed_content_types=['image/png'])
    try:
        upload(d, 'bucket-a', 'x.gif', b'GIF', content_type='image/gif')
    except BucketError:
        print('OK')
        raise SystemExit
    raise AssertionError('content-type allowlist bypassed')
" | grep -q '^OK$'; then
    pass "content-type allowlist enforced"
else
    fail "content-type allowlist bypassed"
fi

# 9. signed URL roundtrip
if run_py "
import tempfile, urllib.parse
from forge.services.storage import create_bucket, upload, sign_url, verify_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    upload(d, 'bucket-a', 'pic.png', b'data')
    url = sign_url(d, 'bucket-a', 'pic.png', expires_in=60)
    qs = dict(urllib.parse.parse_qsl(url.split('?', 1)[1]))
    r = verify_url(d, 'bucket-a', 'pic.png', qs)
    assert r['valid'] == 'true'
print('OK')" | grep -q '^OK$'; then
    pass "signed URL roundtrip"
else
    fail "signed URL broken"
fi

# 10. signed URL rejects tampered signature
if run_py "
import tempfile, urllib.parse
from forge.services.storage import create_bucket, sign_url, verify_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    url = sign_url(d, 'bucket-a', 'x', expires_in=60)
    qs = dict(urllib.parse.parse_qsl(url.split('?', 1)[1]))
    qs['sig'] = '0' * 64
    try:
        verify_url(d, 'bucket-a', 'x', qs)
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('tampered URL accepted')
" | grep -q '^OK$'; then
    pass "signed URL rejects tampered sig"
else
    fail "tampered URL accepted"
fi

# 11. expires_in bounds enforced
if run_py "
import tempfile
from forge.services.storage import create_bucket, sign_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    for bad in [0, -1, 7*24*3600+1, 10**9]:
        try:
            sign_url(d, 'bucket-a', 'x', expires_in=bad)
        except ValueError:
            continue
        raise AssertionError(f'accepted expires_in={bad}')
print('OK')" | grep -q '^OK$'; then
    pass "signed URL expires_in bounds enforced"
else
    fail "expires_in bounds not enforced"
fi

# 12. transform preset registration roundtrip
if run_py "
import tempfile
from forge.services.storage import create_bucket
from forge.services.storage import register_transform_preset, list_transform_presets
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    register_transform_preset(d, 'bucket-a', {
        'name': 'avatar',
        'ops': [{'resize': {'w': 256, 'h': 256, 'fit': 'cover'}}, {'format': 'webp'}],
    })
    items = list_transform_presets(d, 'bucket-a')
    assert len(items) == 1 and items[0]['name'] == 'avatar'
print('OK')" | grep -q '^OK$'; then
    pass "transform preset register + list"
else
    fail "transform preset broken"
fi

# 13. transform preset rejects unsafe ops
if run_py "
import tempfile
from forge.services.storage import create_bucket, register_transform_preset
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    for bad in [
        {'name': 'INVALID', 'ops': [{'format': 'webp'}]},
        {'name': 'ok', 'ops': []},
        {'name': 'ok', 'ops': [{'evil': 1}]},
        {'name': 'ok', 'ops': [{'resize': {'w': 99999, 'h': 1, 'fit': 'cover'}}]},
        {'name': 'ok', 'ops': [{'format': 'tiff'}]},
        {'name': 'ok', 'ops': [{'quality': 200}]},
    ]:
        try:
            register_transform_preset(d, 'bucket-a', bad)
        except ValueError:
            continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then
    pass "transform preset rejects unsafe ops"
else
    fail "transform preset accepted unsafe op"
fi

# 14. list_objects prefix filter
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, list_objects
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    upload(d, 'bucket-a', 'users/a.txt', b'1')
    upload(d, 'bucket-a', 'users/b.txt', b'2')
    upload(d, 'bucket-a', 'posts/c.txt', b'3')
    users = list_objects(d, 'bucket-a', prefix='users/')
    assert len(users) == 2, [o['path'] for o in users]
    all_ = list_objects(d, 'bucket-a')
    assert len(all_) == 3
print('OK')" | grep -q '^OK$'; then
    pass "list_objects prefix filter"
else
    fail "list_objects filter broken"
fi

# 15. X-34: bucket gains region field
if run_py "
import tempfile
from forge.services.storage import create_bucket, list_buckets
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'avatars', region='us-west-2')
    b = list_buckets(d)[0]
    assert b['region'] == 'us-west-2', b
print('OK')" | grep -q '^OK$'; then pass "X-34 storage region field"; else fail "region field missing"; fi

# 16. X-34: bad region rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, BucketError
with tempfile.TemporaryDirectory() as d:
    try: create_bucket(d, 'avatars', region='earth')
    except BucketError: print('OK'); raise SystemExit
    raise AssertionError('earth accepted')
" | grep -q '^OK$'; then pass "X-34 bad region rejected"; else fail "bad region accepted"; fi

# 17. X-34: default region is 'auto'
if run_py "
import tempfile
from forge.services.storage import create_bucket, list_buckets
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'avatars')
    b = list_buckets(d)[0]
    assert b['region'] == 'auto', b
print('OK')" | grep -q '^OK$'; then pass "X-34 default region 'auto'"; else fail "default region wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
