#!/usr/bin/env bash
# Test: N-wave 12 (N-141..N-150)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-141: cached_until_iso field
if run_py "
import re, tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    h = compute_health(d)
    assert 'openapi_cached_until_iso' in h, h
    iso = h['openapi_cached_until_iso']
    if iso is not None:
        assert re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', iso), iso
print('OK')" | grep -q '^OK$'; then pass "N-141 cached_until_iso"; else fail "missing"; fi

# N-142: leading colon rejected
if run_py "
import tempfile
from forge.services.schedules import create, ScheduleError
with tempfile.TemporaryDirectory() as d:
    try:
        create(d, name='h', cron='0 * * * *',
               target={'type': 'event', 'topic': 'noop'},
               tags=[':tenant'])
        print('NO_RAISE')
    except ScheduleError as e:
        print('OK')" | grep -q '^OK$'; then pass "N-142 leading colon"; else fail "accepted"; fi

# N-143: list_dropped_defaults
if run_py "
import tempfile
from forge.services.email import unset_template, list_dropped_defaults
from forge.services.email.templates import DEFAULT_TEMPLATES
name = next(iter(DEFAULT_TEMPLATES))
with tempfile.TemporaryDirectory() as d:
    unset_template(d, name, force=True)
    rows = list_dropped_defaults(d)
    assert len(rows) == 1 and rows[0]['name'] == name, rows
print('OK')" | grep -q '^OK$'; then pass "N-143 list_dropped"; else fail "wrong"; fi

# N-144: list_purges returns records
if run_py "
import os, tempfile
from forge.services.functions import purge_runs, list_purges
with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, 'functions', 'f', 'logs'))
    purge_runs(d, 'f', keep_last_n=1)
    rs = list_purges(d, 'f')
    assert len(rs) == 1 and rs[0]['mode'] == 'keep_last_n', rs
print('OK')" | grep -q '^OK$'; then pass "N-144 list_purges"; else fail "missing"; fi

# N-145: weak_secrets_count int shortcut
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, weak_secrets_count, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['alg'] = 'HMAC-XOR'
    with open(p, 'w') as f: json.dump(data, f)
    n = weak_secrets_count(d)
    assert isinstance(n, int) and n == 1, n
print('OK')" | grep -q '^OK$'; then pass "N-145 weak count"; else fail "wrong type"; fi

# N-146: dry_run preview_sql key present
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}}
    ]}, dry_run=True)
    op = res['ops'][0]
    assert 'preview_sql' in op, op
print('OK')" | grep -q '^OK$'; then pass "N-146 preview_sql key"; else fail "missing"; fi

# N-147: --history-list --tail N caps lines
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge/doctor-history"
for i in 1 2 3 4 5; do
    touch -d "$i minutes ago" "$tmp/.loki/forge/doctor-history/doctor-$i.json"
done
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-list --tail 2 > "$tmp/out.txt" 2>&1
n=$(wc -l < "$tmp/out.txt" | tr -d ' ')
if [[ "$n" == "2" ]]; then
    pass "N-147 tail N"
else
    fail "got $n lines"
fi
rm -rf "$tmp"

# N-148: metrics --watch polls (timeout terminates the loop)
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 3 "$ROOT/bin/loki" forge metrics --watch 1 > "$tmp/out.txt" 2>&1
set -e
n_blocks=$(grep -cE '^---.*Z ---' "$tmp/out.txt")
if [[ "$n_blocks" -ge 2 ]]; then
    pass "N-148 watch polls"
else
    fail "only $n_blocks blocks"
fi
rm -rf "$tmp"

# N-149: audit --summary --color wraps line with ANSI
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary --color > "$tmp/out.txt" 2>&1 || true
if grep -qP '\x1b\[3[12]m' "$tmp/out.txt"; then
    pass "N-149 color ANSI present"
else
    fail "no ANSI: $(cat "$tmp/out.txt" | od -c | head -3)"
fi
rm -rf "$tmp"

# N-150: x-generated-at ends with Z (UTC)
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    assert spec['info']['x-generated-at'].endswith('Z'), spec['info']
print('OK')" | grep -q '^OK$'; then pass "N-150 UTC Z"; else fail "not UTC"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
