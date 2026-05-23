#!/usr/bin/env bash
# Test: forge.backup (X-26).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. backup tars the forge tree
if run_py "
import os, tempfile, tarfile
from forge.services.database import open_engine, migrate_apply
from forge.backup import backup
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    out = os.path.join(d, 'forge.tar.gz')
    rep = backup(d, out)
    assert rep['out_path'] == os.path.abspath(out)
    assert any('db.sqlite' in f for f in rep['files'])
    assert os.path.exists(out)
print('OK')" | grep -q '^OK$'; then pass "backup tars forge tree"; else fail "backup broken"; fi

# 2. backup excludes .master.key by default
if run_py "
import os, tempfile, tarfile
from forge.services.secrets import set_secret
from forge.backup import backup
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'X', 'y')  # creates .master.key
    assert os.path.exists(os.path.join(d, '.master.key'))
    out = os.path.join(d, 'forge.tar')
    rep = backup(d, out, gzip=False)
    with tarfile.open(out) as tf:
        names = tf.getnames()
    assert '.master.key' not in names, names
print('OK')" | grep -q '^OK$'; then pass "backup excludes master key by default"; else fail "master key leaked"; fi

# 3. backup includes master key when asked
if run_py "
import os, tempfile, tarfile
from forge.services.secrets import set_secret
from forge.backup import backup
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'X', 'y')
    out = os.path.join(d, 'forge.tar')
    backup(d, out, gzip=False, include_master_key=True)
    with tarfile.open(out) as tf:
        names = tf.getnames()
    assert '.master.key' in names, names
print('OK')" | grep -q '^OK$'; then pass "backup includes master key when requested"; else fail "include_master_key flag broken"; fi

# 4. restore happy path
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply, introspect
from forge.backup import backup, restore
with tempfile.TemporaryDirectory() as base:
    src = os.path.join(base, 'src')
    e = open_engine(src)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    bk = os.path.join(base, 'b.tar.gz')
    backup(src, bk)
    dst = os.path.join(base, 'dst')
    restore(bk, dst)
    names = sorted(t['name'] for t in introspect(open_engine(dst))['tables'])
    assert names == ['users'], names
print('OK')" | grep -q '^OK$'; then pass "restore happy path"; else fail "restore broken"; fi

# 5. restore refuses to overwrite non-empty without force
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.backup import backup, restore
with tempfile.TemporaryDirectory() as base:
    src = os.path.join(base, 'src')
    e = open_engine(src)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    bk = os.path.join(base, 'b.tar.gz')
    backup(src, bk)
    dst = os.path.join(base, 'dst')
    os.makedirs(dst); open(os.path.join(dst, 'x'), 'w').close()
    try: restore(bk, dst)
    except RuntimeError: print('OK'); raise SystemExit
    raise AssertionError('overwrite without force')
" | grep -q '^OK$'; then pass "restore refuses overwrite without force"; else fail "overwrite happened"; fi

# 6. restore with force overwrites
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.backup import backup, restore
with tempfile.TemporaryDirectory() as base:
    src = os.path.join(base, 'src')
    e = open_engine(src)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    bk = os.path.join(base, 'b.tar.gz')
    backup(src, bk)
    dst = os.path.join(base, 'dst')
    os.makedirs(dst); open(os.path.join(dst, 'x'), 'w').close()
    restore(bk, dst, force=True)
    assert os.path.exists(os.path.join(dst, 'db.sqlite'))
print('OK')" | grep -q '^OK$'; then pass "restore force overwrites"; else fail "force flag broken"; fi

# 7. restore rejects tarball with path-escape members
if run_py "
import os, tarfile, tempfile
from forge.backup import restore
with tempfile.TemporaryDirectory() as base:
    bk = os.path.join(base, 'evil.tar')
    with tarfile.open(bk, 'w') as tf:
        # Build an in-memory tarinfo pointing outside the dest dir.
        info = tarfile.TarInfo(name='../../etc/passwd')
        info.size = 4
        import io
        tf.addfile(info, io.BytesIO(b'root'))
    dst = os.path.join(base, 'dst')
    try: restore(bk, dst)
    except RuntimeError: print('OK'); raise SystemExit
    raise AssertionError('escape accepted')
" | grep -q '^OK$'; then pass "restore rejects path-escape tar member"; else fail "path traversal accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
