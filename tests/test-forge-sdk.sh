#!/usr/bin/env bash
# Test: forge.sdk codegen (Phase F-5).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. targets list
if run_py "
from forge.sdk import list_targets
ts = list_targets()
assert 'typescript' in ts and 'python' in ts
print('OK')" | grep -q '^OK$'; then pass "list_targets"; else fail "list_targets broken"; fi

# 2. unsupported target rejected
if run_py "
import tempfile
from forge.sdk import generate, GenError
with tempfile.TemporaryDirectory() as d:
    try: generate(d, 'cobol', '/tmp/out')
    except GenError: print('OK'); raise SystemExit
    raise AssertionError('cobol accepted')
" | grep -q '^OK$'; then pass "unsupported target rejected"; else fail "unsupported accepted"; fi

# 3. typescript: generates types.ts + client.ts + index.ts + package.json
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users',
        'columns':['id pk','email text unique notnull']}}]})
    out_dir = os.path.join(d, 'out')
    res = generate(d, 'typescript', out_dir)
    names = sorted(os.path.basename(f['path']) for f in res['files'])
    assert names == ['client.ts','index.ts','package.json','types.ts'], names
print('OK')" | grep -q '^OK$'; then pass "typescript files emitted"; else fail "typescript codegen broken"; fi

# 4. typescript: types.ts has the table interface
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'posts',
        'columns':['id pk','title text notnull','body text']}}]})
    out_dir = os.path.join(d, 'out')
    generate(d, 'typescript', out_dir)
    text = open(os.path.join(out_dir, 'types.ts')).read()
    assert 'export interface Posts' in text, text[:200]
    assert 'id: number' in text
    assert 'title: string' in text
print('OK')" | grep -q '^OK$'; then pass "typescript types.ts shape"; else fail "types.ts shape wrong"; fi

# 5. typescript: client.ts has table accessors
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'tasks',
        'columns':['id pk','title text']}}]})
    out_dir = os.path.join(d, 'out')
    generate(d, 'typescript', out_dir)
    text = open(os.path.join(out_dir, 'client.ts')).read()
    assert 'tasks = {' in text
    assert 'GET' in text and 'POST' in text
print('OK')" | grep -q '^OK$'; then pass "typescript client.ts accessors"; else fail "client.ts accessors missing"; fi

# 6. python: emits types.py + client.py + __init__.py
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'orders',
        'columns':['id pk','amount integer notnull']}}]})
    out_dir = os.path.join(d, 'out')
    res = generate(d, 'python', out_dir)
    names = sorted(os.path.basename(f['path']) for f in res['files'])
    assert names == ['__init__.py','client.py','types.py'], names
print('OK')" | grep -q '^OK$'; then pass "python files emitted"; else fail "python codegen broken"; fi

# 7. python: types.py is a parseable Python module with dataclass
if run_py "
import ast, os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'orders',
        'columns':['id pk','amount integer notnull','note text']}}]})
    out_dir = os.path.join(d, 'out')
    generate(d, 'python', out_dir)
    src = open(os.path.join(out_dir, 'types.py')).read()
    ast.parse(src)  # parse must succeed
    assert 'class Orders' in src and 'amount: int' in src
print('OK')" | grep -q '^OK$'; then pass "python types.py parses + dataclass"; else fail "python types.py broken"; fi

# 8. python: client.py parses + exposes table methods
if run_py "
import ast, os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'orders',
        'columns':['id pk']}}]})
    out_dir = os.path.join(d, 'out')
    generate(d, 'python', out_dir)
    src = open(os.path.join(out_dir, 'client.py')).read()
    ast.parse(src)
    assert 'def orders_list' in src and 'def orders_insert' in src
print('OK')" | grep -q '^OK$'; then pass "python client.py parses + methods"; else fail "python client.py broken"; fi

# 9. typescript+buckets+functions emit storage_ and fn_ helpers
if run_py "
import base64, os, tempfile
from forge.services.storage import create_bucket
from forge.services.functions import deploy as fdeploy
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'avatars')
    fdeploy(d, 'send-email', 'bun', base64.b64encode(b'x').decode())
    out_dir = os.path.join(d, 'out')
    generate(d, 'typescript', out_dir)
    text = open(os.path.join(out_dir, 'client.ts')).read()
    assert 'storage_avatars' in text
    assert 'fn_send_email' in text
print('OK')" | grep -q '^OK$'; then pass "typescript bucket+function helpers"; else fail "ts bucket/fn helpers missing"; fi

# 10. deterministic output (same state -> same bytes)
if run_py "
import os, tempfile, hashlib
from forge.services.database import open_engine, migrate_apply
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'a','columns':['id pk']}}]})
    out_a = os.path.join(d, 'a')
    out_b = os.path.join(d, 'b')
    generate(d, 'typescript', out_a)
    generate(d, 'typescript', out_b)
    for fn in ['types.ts','client.ts','index.ts','package.json']:
        a = open(os.path.join(out_a, fn), 'rb').read()
        b = open(os.path.join(out_b, fn), 'rb').read()
        assert a == b, fn
print('OK')" | grep -q '^OK$'; then pass "codegen is deterministic"; else fail "non-deterministic codegen"; fi

# 11. python: identifier safety for kebab-cased function names
if run_py "
import base64, os, tempfile
from forge.services.functions import deploy as fdeploy
from forge.sdk import generate
with tempfile.TemporaryDirectory() as d:
    fdeploy(d, 'send-newsletter-digest', 'bun', base64.b64encode(b'x').decode())
    out_dir = os.path.join(d, 'out')
    generate(d, 'python', out_dir)
    src = open(os.path.join(out_dir, 'client.py')).read()
    # Hyphens forbidden in Python identifiers; codegen must sanitize.
    assert 'fn_send_newsletter_digest' in src
print('OK')" | grep -q '^OK$'; then pass "python identifier sanitization"; else fail "python kebab-case unsafe"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
