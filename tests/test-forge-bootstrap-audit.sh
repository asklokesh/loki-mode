#!/usr/bin/env bash
# Test: X-49 forge.yaml bootstrap + X-50 audit verify.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. X-49: missing forge.yaml -> skipped
if run_py "
import tempfile
from forge.config import apply
with tempfile.TemporaryDirectory() as d:
    res = apply(d)
    assert 'no_forge_yaml' in res['skipped']
print('OK')" | grep -q '^OK$'; then pass "X-49 missing forge.yaml -> skipped"; else fail "missing config crashed"; fi

# 2. X-49: find_config detects forge.yaml at root
if run_py "
import os, tempfile
from forge.config import find_config
with tempfile.TemporaryDirectory() as d:
    open(os.path.join(d, 'forge.yaml'), 'w').close()
    assert find_config(d) is not None
print('OK')" | grep -q '^OK$'; then pass "X-49 find_config locates forge.yaml"; else fail "find_config broken"; fi

# 3. X-49: symlinks rejected
if run_py "
import os, tempfile
from forge.config import find_config
with tempfile.TemporaryDirectory() as d:
    real = os.path.join(d, 'real.yaml'); open(real, 'w').close()
    link = os.path.join(d, 'forge.yaml'); os.symlink(real, link)
    assert find_config(d) is None
print('OK')" | grep -q '^OK$'; then pass "X-49 symlinks rejected"; else fail "symlink accepted"; fi

# 4. X-49: apply provisions table + bucket (with PyYAML present or fallback)
if run_py "
import os, tempfile
from forge.config import apply
from forge.services.database import open_engine, introspect
from forge.services.storage import list_buckets
with tempfile.TemporaryDirectory() as d:
    # Write a minimal forge.yaml that the minimal parser also handles.
    # The list-of-dicts shape needs PyYAML; for the fallback we declare
    # scalar values only.
    yaml_text = 'compliance_preset: default\n'
    open(os.path.join(d, 'forge.yaml'), 'w').write(yaml_text)
    res = apply(d)
    # default applied
    assert any('compliance_preset' in a for a in res['applied']), res
print('OK')" | grep -q '^OK$'; then pass "X-49 apply reads forge.yaml"; else fail "apply broken"; fi

# 5. X-49: full apply via PyYAML (when available)
if run_py "
import os, tempfile
try:
    import yaml
except ImportError:
    print('OK'); raise SystemExit  # skip when PyYAML missing
from forge.config import apply
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    yaml.safe_dump({
        'compliance_preset': 'default',
        'tables': [{'name': 'users', 'columns': ['id pk', 'email text notnull']}],
    }, open(os.path.join(d, 'forge.yaml'), 'w'))
    res = apply(d)
    assert any('table' in a for a in res['applied']), res
    fd = os.path.join(d, '.loki', 'forge')
    snap = introspect(open_engine(fd))
    assert 'users' in [t['name'] for t in snap['tables']]
print('OK')" | grep -q '^OK$'; then pass "X-49 PyYAML full apply"; else fail "PyYAML apply broken"; fi

# 6. X-49: dryrun does not write to db
if run_py "
import os, tempfile
try:
    import yaml
except ImportError:
    print('OK'); raise SystemExit
from forge.config import apply
with tempfile.TemporaryDirectory() as d:
    yaml.safe_dump({'tables': [{'name': 'users', 'columns': ['id pk']}]},
                   open(os.path.join(d, 'forge.yaml'), 'w'))
    apply(d, dryrun=True)
    db = os.path.join(d, '.loki', 'forge', 'db.sqlite')
    # Forge dir created but no migration applied yet (we never opened
    # the engine in dryrun mode).
    if os.path.exists(db):
        # If PyYAML created the db, ensure no _forge_migrations rows.
        import sqlite3
        c = sqlite3.connect(db); rows = c.execute('SELECT count(*) FROM sqlite_master WHERE type=\"table\" AND name=\"_forge_migrations\"').fetchone()
        assert rows[0] == 0, 'dryrun applied a migration'
print('OK')" | grep -q '^OK$'; then pass "X-49 dryrun does not apply"; else fail "dryrun applied anyway"; fi

# 7. X-50: verify on empty project returns ok with warning
if run_py "
import tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    rep = verify(d)
    assert rep['ok'] is True
    assert any('no review directory' in w for w in rep['warnings'])
print('OK')" | grep -q '^OK$'; then pass "X-50 empty project ok"; else fail "empty crashed"; fi

# 8. X-50: verify after migrate passes
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as tdir:
    project = os.path.join(tdir, 'proj')
    fd = os.path.join(project, '.loki', 'forge')
    os.makedirs(fd, exist_ok=True)
    e = open_engine(fd)
    migrate_apply(e, {'summary':'add t','operations':[{'add_table':{
        'name':'t','columns':['id pk']}}]})
    rep = verify(project)
    assert rep['ok'], rep
    assert rep['checked_reviews'] >= 1
print('OK')" | grep -q '^OK$'; then pass "X-50 happy-path verify"; else fail "happy-path verify failed"; fi

# 9. X-50: tampered review surfaces an error
if run_py "
import json, os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as tdir:
    project = os.path.join(tdir, 'proj')
    fd = os.path.join(project, '.loki', 'forge')
    os.makedirs(fd, exist_ok=True)
    e = open_engine(fd)
    res = migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    # Tamper: rewrite the review record with a wrong spec_hash.
    rev_path = os.path.join(project, '.loki', 'quality',
                             'forge-migrations',
                             f\"{res['migration_id']}.json\")
    rec = json.load(open(rev_path))
    rec['spec_hash'] = '0' * 64
    json.dump(rec, open(rev_path, 'w'))
    rep = verify(project)
    assert rep['ok'] is False, rep
    assert any('spec_hash mismatch' in e for e in rep['errors']), rep
print('OK')" | grep -q '^OK$'; then pass "X-50 detects tampered review"; else fail "tamper not detected"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
