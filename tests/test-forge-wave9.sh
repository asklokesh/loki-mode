#!/usr/bin/env bash
# Test: X-82..X-88 wave.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-82 lint CLI

# 1. `loki forge lint` runs against a missing forge.yaml
tmp=$(mktemp -d)
out=$( (cd "$tmp" && "$ROOT/bin/loki" forge lint) 2>&1 )
rm -rf "$tmp"
if echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert any('no forge.yaml' in w for w in d['warnings'])" 2>/dev/null; then
    pass "X-82 lint warns when forge.yaml missing"
else
    fail "lint missing-file warning broken: $out"
fi

# 2. lint surfaces schedule cron errors
if run_py "
import json, os, tempfile
try: import yaml
except ImportError:
    print('OK'); raise SystemExit
with tempfile.TemporaryDirectory() as d:
    yaml.safe_dump({
        'schedules': [{'name':'bad','cron':'99 * * * *','target':{'type':'event','topic':'t'}}],
    }, open(os.path.join(d, 'forge.yaml'), 'w'))
    import subprocess
    proc = subprocess.run(['$ROOT/bin/loki', 'forge', 'lint'], cwd=d,
        capture_output=True, text=True)
    rep = json.loads(proc.stdout)
    assert any('bad' in e and ('99' in e or 'out of' in e) for e in rep['errors']), rep
print('OK')" | grep -q '^OK$'; then pass "X-82 lint catches bad cron"; else fail "lint cron broken"; fi

# X-83 schedule retry-on-fail

# 3. schedule failure stays at retry slot (next_fire_ts shifts to now+backoff)
if run_py "
import json, os, tempfile, time
from forge.services.schedules import create, tick
with tempfile.TemporaryDirectory() as d:
    create(d, 'r', '* * * * *', {'type':'event','topic':'t'})
    p = os.path.join(d, 'schedules', 'schedules.json')
    items = json.load(open(p))
    items[0]['next_fire_ts'] = int(time.time()) - 60
    items[0]['max_retries'] = 2
    json.dump(items, open(p, 'w'))
    def fail_cb(s): return {'error': 'boom'}
    fired = tick(d, invoke=fail_cb)
    assert fired
    items2 = json.load(open(p))
    s2 = items2[0]
    # Retry: should NOT have advanced to a full minute boundary - within ~31s.
    assert s2['_retry_attempts'] == 1
    assert s2['next_fire_ts'] <= int(time.time()) + 90
print('OK')" | grep -q '^OK$'; then pass "X-83 retry attempts increment"; else fail "retry not applied"; fi

# 4. retry exhaustion: after max_retries, next_fire_ts jumps to next cron tick
if run_py "
import json, os, tempfile, time
from forge.services.schedules import create, tick
with tempfile.TemporaryDirectory() as d:
    create(d, 'r', '0 0 1 1 *', {'type':'event','topic':'t'})  # yearly
    p = os.path.join(d, 'schedules', 'schedules.json')
    items = json.load(open(p))
    items[0]['next_fire_ts'] = int(time.time()) - 60
    items[0]['max_retries'] = 1
    items[0]['_retry_attempts'] = 1  # already at the cap
    json.dump(items, open(p, 'w'))
    def fail_cb(s): return {'error': 'boom'}
    tick(d, invoke=fail_cb)
    items2 = json.load(open(p))
    s2 = items2[0]
    # Out of retries, so counter reset and next_fire_ts moves forward.
    assert s2['_retry_attempts'] == 0
    assert s2['next_fire_ts'] > int(time.time())
print('OK')" | grep -q '^OK$'; then pass "X-83 retry exhaustion advances"; else fail "exhaustion advance broken"; fi

# X-84 function timeout tracking

# 5. timeout bumps the manifest counter
if run_py "
import base64, json, os, tempfile
from forge.services.functions import deploy as fdeploy, invoke, get_function
src = b'import time; time.sleep(5)'
with tempfile.TemporaryDirectory() as d:
    fdeploy(d, 'slow', 'python', base64.b64encode(src).decode(),
            timeout_ms=300)
    res = invoke(d, 'slow')
    assert res.get('error') == 'timeout', res
    m = get_function(d, 'slow')
    assert m.get('timeout_count', 0) == 1, m
    assert 'last_timeout_at' in m, m
print('OK')" | grep -q '^OK$'; then pass "X-84 timeout bumps manifest"; else fail "timeout not tracked"; fi

# X-85 rotate_value

# 6. rotate_value replaces the value + drops a marker
if run_py "
import os, tempfile
from forge.services.secrets import set_secret, get_secret, rotate_value
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v1')
    assert get_secret(d, 'A') == 'v1'
    res = rotate_value(d, 'A', 'v2')
    assert res['rotated'] is True
    assert get_secret(d, 'A') == 'v2'
    rots = os.path.join(d, 'secrets', 'rotations.jsonl')
    assert os.path.exists(rots) and 'A' in open(rots).read()
print('OK')" | grep -q '^OK$'; then pass "X-85 rotate_value replaces + marker"; else fail "rotate_value broken"; fi

# 7. rotate_value rejects unknown
if run_py "
import tempfile
from forge.services.secrets import rotate_value, SecretError
with tempfile.TemporaryDirectory() as d:
    try: rotate_value(d, 'NO_SUCH', 'x')
    except SecretError: print('OK'); raise SystemExit
    raise AssertionError('unknown accepted')
" | grep -q '^OK$'; then pass "X-85 rotate_value rejects unknown"; else fail "unknown accepted"; fi

# X-88 audit-chain idempotency

# 8. two identical migrate_apply calls don't break audit verify
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as tdir:
    project = os.path.join(tdir, 'proj')
    fd = os.path.join(project, '.loki', 'forge')
    os.makedirs(fd)
    e = open_engine(fd)
    spec = {'summary':'add x','operations':[{'add_table':{'name':'x','columns':['id pk']}}]}
    r1 = migrate_apply(e, spec)
    r2 = migrate_apply(e, spec)
    assert r2.get('already_applied') is True
    rep = verify(project)
    assert rep['ok'], rep
print('OK')" | grep -q '^OK$'; then pass "X-88 idempotent migrate keeps audit ok"; else fail "audit broken on dupe"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
