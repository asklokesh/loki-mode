#!/usr/bin/env bash
# Test: forge.semantic_layer prompt-injection renderer (v7.6.0 Phase F-1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. Returns empty string when no forge state exists
if run_py "
import tempfile, os
from forge.semantic_layer import render_prompt_block
with tempfile.TemporaryDirectory() as d:
    block = render_prompt_block(os.path.join(d, 'forge'))
    assert block == '', repr(block)
print('OK')" | grep -q '^OK$'; then
    pass "empty/missing forge dir -> empty block"
else
    fail "empty forge dir produced non-empty block"
fi

# 2. With tables provisioned, block contains expected header + table names
if run_py "
import tempfile, os
from forge.services.database import open_engine, migrate_apply
from forge.semantic_layer import render_prompt_block
with tempfile.TemporaryDirectory() as d:
    forge_dir = os.path.join(d, 'forge')
    os.makedirs(forge_dir)
    e = open_engine(forge_dir)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    migrate_apply(e, {'operations':[{'add_table':{'name':'posts','columns':['id pk']}}]})
    block = render_prompt_block(forge_dir)
    assert '## Backend (Loki Forge' in block
    assert 'users' in block
    assert 'posts' in block
    assert 'forge_db_introspect' in block
print('OK')" | grep -q '^OK$'; then
    pass "rendered block surfaces tables + MCP-tool hint"
else
    fail "rendered block missing expected content"
fi

# 3. Block stays under MAX_BLOCK_BYTES even with many tables
if run_py "
import tempfile, os
from forge.services.database import open_engine, migrate_apply
from forge.semantic_layer import render_prompt_block, MAX_BLOCK_BYTES
with tempfile.TemporaryDirectory() as d:
    forge_dir = os.path.join(d, 'forge')
    os.makedirs(forge_dir)
    e = open_engine(forge_dir)
    for i in range(50):
        migrate_apply(e, {'operations':[{'add_table':{
            'name':'t%d' % i,'columns':['id pk', 'a text', 'b text', 'c text']}}]})
    block = render_prompt_block(forge_dir)
    assert len(block.encode('utf-8')) <= MAX_BLOCK_BYTES + 64, len(block)
print('OK')" | grep -q '^OK$'; then
    pass "block respects MAX_BLOCK_BYTES cap"
else
    fail "block exceeded MAX_BLOCK_BYTES"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
