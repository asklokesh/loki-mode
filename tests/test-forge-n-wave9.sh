#!/usr/bin/env bash
# Test: N-wave 9 (N-111..N-120)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-111: health surfaces openapi_generated_at
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    h = compute_health(d)
    assert 'openapi_generated_at' in h, h
print('OK')" | grep -q '^OK$'; then pass "N-111 health surfaces openapi ts"; else fail "missing"; fi

# N-112: 9 tags rejected
if run_py "
import tempfile
from forge.services.schedules import create, ScheduleError
with tempfile.TemporaryDirectory() as d:
    try:
        create(d, name='h', cron='0 * * * *',
               target={'type': 'event', 'topic': 'noop'},
               tags=['t' + str(i) for i in range(9)])
        print('NO_RAISE')
    except ScheduleError as e:
        assert 'at most 8' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-112 tag cap"; else fail "cap missed"; fi

# N-113: load_channel_caps preserves dict-form for actor entries
if run_py "
import tempfile
from forge.services.realtime.bus import set_channel_cap, load_channel_caps, _RING
with tempfile.TemporaryDirectory() as d:
    set_channel_cap('r', 7, forge_dir=d, actor='ops')
    set_channel_cap('legacy', 9, forge_dir=d)  # no actor
    _RING.clear()
    caps = load_channel_caps(d)
    assert isinstance(caps['r'], dict), caps
    assert caps['r']['actor'] == 'ops'
    assert isinstance(caps['legacy'], int)
print('OK')" | grep -q '^OK$'; then pass "N-113 shape preserved"; else fail "shape lost"; fi

# N-114: unset_template refuses built-in default
if run_py "
import tempfile
from forge.services.email import unset_template
from forge.services.email.templates import EmailError, DEFAULT_TEMPLATES
default_name = next(iter(DEFAULT_TEMPLATES))
with tempfile.TemporaryDirectory() as d:
    try:
        unset_template(d, default_name)
        print('NO_RAISE')
    except EmailError as e:
        assert 'built-in default' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-114 built-in protected"; else fail "default droppable"; fi

# N-115: keep_last_n > 10000 rejected
if run_py "
import tempfile
from forge.services.functions import purge_runs
with tempfile.TemporaryDirectory() as d:
    try:
        purge_runs(d, 'f', keep_last_n=20000)
        print('NO_RAISE')
    except ValueError as e:
        assert 'capped' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-115 keep cap"; else fail "no cap"; fi

# N-116: list_rotations parses jsonl
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, rotate_value, list_rotations
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v1')
    rotate_value(d, 'A', 'v2')
    rotate_value(d, 'A', 'v3', rotated_by_user_id='u_alice')
    rs = list_rotations(d)
    assert len(rs) == 2, rs
    assert rs[-1]['rotated_by_user_id'] == 'u_alice'
print('OK')" | grep -q '^OK$'; then pass "N-116 list_rotations"; else fail "wrong"; fi

# N-117: applied/v2 includes total_ops
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}},
        {'add_table': {'name': 'o', 'columns': [{'name': 'id', 'type': 'id'}]}},
    ]}, dry_run=True)
    assert res['total_ops'] == 2, res
print('OK')" | grep -q '^OK$'; then pass "N-117 total_ops"; else fail "missing"; fi

# N-118: doctor --once + --history rotates one snapshot
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
TARGET_DIR="$tmp" timeout 5 "$ROOT/bin/loki" forge doctor --once --history 3 > /dev/null 2>&1 || true
count=$(ls "$tmp/.loki/forge/doctor-history" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$count" == "1" ]]; then
    pass "N-118 --once honors --history"
else
    fail "got $count files"
fi
rm -rf "$tmp"

# N-119: --filter exclude= drops the matching prefix
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --filter exclude=forge_secrets_ > "$tmp/out.txt" 2>&1
if grep -q "^forge_tables_total" "$tmp/out.txt" \
   && ! grep -q "^forge_secrets" "$tmp/out.txt"; then
    pass "N-119 exclude drops match"
else
    fail "exclude wrong"
fi
rm -rf "$tmp"

# N-120: help lists short alias forms
help=$("$ROOT/bin/loki" forge help 2>&1)
if echo "$help" | grep -q "Short aliases" \
   && echo "$help" | grep -q "doc = doctor"; then
    pass "N-120 aliases in help"
else
    fail "aliases not documented"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
