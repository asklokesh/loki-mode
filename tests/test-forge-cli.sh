#!/usr/bin/env bash
# Test: loki forge CLI wrappers + rate-limit snapshot (X-35, X-38, X-40).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. `loki forge --help` works
if "$ROOT/bin/loki" forge --help 2>&1 | grep -q 'loki forge <subcommand>'; then
    pass "loki forge help renders"
else
    fail "loki forge help broken"
fi

# 2 + 3. status, backup, restore in one ephemeral dir to keep trap simple.
tmp=$(mktemp -d)
(
    cd "$tmp"
    out=$( "$ROOT/bin/loki" forge status 2>&1 )
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'forge_dir' in d" 2>&1 \
        && echo "__T2_PASS__" || echo "__T2_FAIL__$out"

    PYTHONPATH="$ROOT" python3 -c "
import os
os.makedirs('.loki/forge', exist_ok=True)
from forge.services.database import open_engine, migrate_apply
e = open_engine('.loki/forge')
migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
"
    "$ROOT/bin/loki" forge backup ./backup.tar.gz >/dev/null 2>&1
    if [[ -f ./backup.tar.gz ]]; then echo "__T3_PASS__"; else echo "__T3_FAIL__"; fi

    mv .loki .loki.orig
    "$ROOT/bin/loki" forge restore ./backup.tar.gz >/dev/null 2>&1
    if [[ -f .loki/forge/db.sqlite ]]; then echo "__T4_PASS__"; else echo "__T4_FAIL__"; fi
) > "$tmp/out.log" 2>&1
results=$(cat "$tmp/out.log")
rm -rf "$tmp"
echo "$results" | grep -q '__T2_PASS__' && pass "loki forge status emits JSON" || fail "forge status JSON broken"
echo "$results" | grep -q '__T3_PASS__' && pass "loki forge backup creates tarball" || fail "backup tarball missing"
echo "$results" | grep -q '__T4_PASS__' && pass "loki forge restore re-creates state" || fail "restore failed"

# 4. X-38: /api/forge/gateway/rate-limit declared
if grep -q '"/api/forge/gateway/rate-limit"' "$ROOT/dashboard/forge_router.py"; then
    pass "X-38: /api/forge/gateway/rate-limit declared"
else
    fail "rate-limit endpoint missing"
fi

# 5. X-38: rate_limit.snapshot() returns structured bucket info
if PYTHONPATH="$ROOT" python3 -c "
from forge.services.gateway.rate_limit import check, snapshot, reset
reset()
check('key-a', cost=1.0, capacity=5.0, refill_per_sec=1.0)
check('key-b', cost=2.0, capacity=10.0, refill_per_sec=0.5)
snap = snapshot()
assert isinstance(snap['buckets'], list)
ids = [b['id'] for b in snap['buckets']]
assert 'key-a' in ids and 'key-b' in ids
print('OK')" | grep -q '^OK$'; then
    pass "snapshot() emits bucket state"
else
    fail "snapshot broken"
fi

# 6. promote shorthand dispatches to cmd_forge promote
if grep -q '^        promote)' "$ROOT/autonomy/loki" \
   && grep -q 'cmd_forge promote "\$@"' "$ROOT/autonomy/loki"; then
    pass "X-35: top-level 'promote' dispatches to forge promote"
else
    fail "promote shorthand missing"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
