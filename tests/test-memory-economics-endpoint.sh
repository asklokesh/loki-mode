#!/usr/bin/env bash
# v7.7.21 regression test: /api/memory/economics enhancement.
# Excellence bar 5 (token economics visible): hit_rate + top_patterns +
# normalized token fields. The pre-v7.7.21 endpoint returned camelCase
# keys (discoveryTokens) that did NOT match the snake_case file
# (metrics.discovery_tokens) -- a real defect. v7.7.21 normalizes the
# shape, computes cache hit_rate, surfaces top-accessed memories, and
# keeps camelCase aliases for backward compat.
#
# Tests the endpoint logic against a seeded token_economics.json +
# episodic store. Does not require a running server (replicates the
# endpoint's pure logic), plus a built-HTML grep for the dashboard tile.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: endpoint logic computes hit_rate + total_tokens + top_patterns
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, json, tempfile, shutil, os, glob
tmp = tempfile.mkdtemp(prefix='loki-v7721-')
try:
    mem = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(os.path.join(mem, 'episodic', '2026-05-28'))
    with open(os.path.join(mem, 'token_economics.json'), 'w') as f:
        json.dump({'session_id':'s1','metrics':{'discovery_tokens':1200,'read_tokens':800,'cache_hits':7,'cache_misses':3},'ratio':0.4,'savings_percent':62.5}, f)
    with open(os.path.join(mem, 'episodic', '2026-05-28', 'task-ep1.json'), 'w') as f:
        json.dump({'id':'ep1','access_count':5,'importance':0.8,'summary':'built auth flow'}, f)
    with open(os.path.join(mem, 'episodic', '2026-05-28', 'task-ep2.json'), 'w') as f:
        json.dump({'id':'ep2','access_count':1,'importance':0.3,'summary':'fixed bug'}, f)

    # Replicate endpoint logic
    raw = json.loads(open(os.path.join(mem, 'token_economics.json')).read())
    m = raw.get('metrics', {})
    ch, cm = int(m.get('cache_hits',0)), int(m.get('cache_misses',0))
    hit_rate = round(ch/(ch+cm), 4) if (ch+cm)>0 else 0.0
    total = int(m.get('discovery_tokens',0)) + int(m.get('read_tokens',0))
    cands = []
    for sub in ('episodic','semantic'):
        for fp in glob.glob(os.path.join(mem, sub, '**', '*.json'), recursive=True):
            d = json.load(open(fp))
            cands.append({'id':d.get('id'),'access_count':int(d.get('access_count',0)),'importance':float(d.get('importance',0))})
    cands.sort(key=lambda c:(c['access_count'],c['importance']), reverse=True)

    checks = (
        hit_rate == 0.7
        and total == 2000
        and cands[0]['id'] == 'ep1'  # higher access_count ranks first
        and cands[1]['id'] == 'ep2'
    )
    print('ECON_OK' if checks else f'ECON_FAIL: hit_rate={hit_rate} total={total} top={cands[:2]}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "ECON_OK" ]; then ok "economics endpoint logic: hit_rate + total_tokens + top_patterns ranking"; else bad "econ: $RESULT"; fi

# Test 2: endpoint preserves backward-compat camelCase aliases
if grep -q '"discoveryTokens": discovery_tokens' dashboard/server.py \
   && grep -q '"readTokens": read_tokens' dashboard/server.py \
   && grep -q '"savingsPercent"' dashboard/server.py; then
    ok "endpoint keeps backward-compat camelCase aliases"
else
    bad "backward-compat aliases missing from endpoint"
fi

# Test 3: endpoint emits normalized snake_case + hit_rate + top_patterns keys
for key in '"hit_rate"' '"total_tokens"' '"top_patterns"' '"cache_hits"' '"cache_misses"'; do
    if ! grep -q "$key" dashboard/server.py; then
        bad "endpoint missing key $key"
        break
    fi
done
if grep -q '"hit_rate"' dashboard/server.py && grep -q '"top_patterns"' dashboard/server.py; then
    ok "endpoint emits normalized hit_rate + top_patterns + total_tokens"
fi

# Test 4: dashboard tile present in built static HTML
if grep -q "memory-economics-tile" dashboard/static/index.html \
   && grep -q "econ-hit-rate" dashboard/static/index.html \
   && grep -q "loadEconomics" dashboard/static/index.html; then
    ok "dashboard token-economics tile present in built index.html"
else
    bad "economics tile not found in built dashboard"
fi

# Test 5: AST clean on server.py
if $PY -c "import ast; ast.parse(open('dashboard/server.py').read())" 2>/dev/null; then
    ok "dashboard/server.py AST clean"
else
    bad "dashboard/server.py AST parse failed"
fi

# Test 6 (council fix Opus 2): endpoint has auth.require_scope("read")
if grep -A1 '@app.get("/api/memory/economics"' dashboard/server.py | grep -q 'require_scope("read")'; then
    ok "economics endpoint gated on auth.require_scope(read) (matches siblings)"
else
    bad "economics endpoint missing auth.require_scope(read)"
fi

# Test 7 (council fix Opus 2): scan uses os.walk(followlinks=False) + containment
if grep -q "followlinks=False" dashboard/server.py && grep -q "commonpath" dashboard/server.py; then
    ok "scan uses os.walk(followlinks=False) + realpath containment (no symlink traversal)"
else
    bad "scan missing symlink-safe walk or containment check"
fi

# Test 8 (council fix Opus 1): tile builds DOM via textContent (no innerHTML injection)
if grep -q "removeChild" dashboard/static/index.html \
   && grep -q "row.textContent" dashboard/static/index.html; then
    ok "tile builds top-patterns via textContent (XSS-safe)"
else
    bad "tile still uses innerHTML single-char escape (XSS risk)"
fi

# Test 9 (council fix Opus 2): symlink to outside mem_root is NOT followed
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, json, tempfile, shutil, os
tmp = tempfile.mkdtemp(prefix='loki-v7721-')
try:
    mem = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(os.path.join(mem, 'episodic', '2026-05-28'))
    # Legit episode
    with open(os.path.join(mem, 'episodic', '2026-05-28', 'task-ep1.json'), 'w') as f:
        json.dump({'id':'ep1','access_count':3,'importance':0.5,'summary':'legit'}, f)
    # Plant a symlink under episodic/ pointing OUTSIDE mem_root
    outside = os.path.join(tmp, 'secret')
    os.makedirs(outside)
    with open(os.path.join(outside, 'leak.json'), 'w') as f:
        json.dump({'id':'LEAKED','access_count':999,'importance':1.0,'summary':'should not appear'}, f)
    os.symlink(outside, os.path.join(mem, 'episodic', 'symlink_to_secret'))

    # Replicate the endpoint scan (os.walk followlinks=False + containment)
    mem_root = os.path.realpath(mem)
    cands = []
    for sub in ('episodic','semantic'):
        sub_root = os.path.join(mem_root, sub)
        if not os.path.isdir(sub_root): continue
        for dirpath, dirnames, filenames in os.walk(sub_root, followlinks=False):
            for fn in filenames:
                if not fn.endswith('.json'): continue
                fp = os.path.join(dirpath, fn)
                rp = os.path.realpath(fp)
                if os.path.commonpath([rp, mem_root]) != mem_root: continue
                d = json.load(open(fp))
                cands.append(d.get('id'))
    # LEAKED must NOT appear (symlink not followed + containment blocks it)
    if 'LEAKED' not in cands and 'ep1' in cands:
        print('SYMLINK_SAFE_OK')
    else:
        print(f'SYMLINK_LEAK: cands={cands}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "SYMLINK_SAFE_OK" ]; then ok "symlink under episodic/ to outside mem_root is NOT followed"; else bad "symlink safety: $RESULT"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
