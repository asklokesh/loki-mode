#!/usr/bin/env bash
# v7.7.22 regression test: loki memory replay <episode-id> (wow feature).
# READ-ONLY deterministic replay -- renders a past episode's action
# timeline + current state of touched files. Does NOT re-execute.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: replay_episode on a synthetic episode with action_log + files
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, json, tempfile, shutil, os
sys.path.insert(0, '.')
from memory.replay import replay_episode, render_markdown
tmp = tempfile.mkdtemp(prefix='loki-v7722-')
try:
    mem = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(os.path.join(mem, 'episodic', '2026-05-28'))
    # A real file (exists) + a missing file
    real = os.path.join(tmp, 'real.py'); open(real, 'w').write('x=1')
    missing = os.path.join(tmp, 'gone.py')
    ep = {
        'id': 'ep-test-1', 'agent': 'claude-code', 'outcome': 'success',
        'timestamp': '2026-05-28T00:00:00Z',
        'context': {'goal': 'replay unit test'},
        'action_log': [
            {'action': 'Read', 'target': real, 't': 0},
            {'action': 'Edit', 'target': real, 't': 5},
        ],
        'files_modified': [real, missing],
    }
    with open(os.path.join(mem, 'episodic', '2026-05-28', 'task-ep-test-1.json'), 'w') as f:
        json.dump(ep, f)

    r = replay_episode('ep-test-1', mem, repo_root=tmp)
    md = render_markdown(r)
    checks = (
        r['found'] is True
        and r['summary']['steps'] == 2
        and r['summary']['files_touched'] == 2
        and r['summary']['files_missing'] == 1
        and len(r['timeline']) == 2
        and r['timeline'][0]['tool'] == 'Read'
        and any(f['state'] == 'missing' for f in r['files'])
        and 'read-only' in r['mode']
        and '# Replay' in md
    )
    print('REPLAY_OK' if checks else f'REPLAY_FAIL: {r["summary"]} timeline={r["timeline"]}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "REPLAY_OK" ]; then ok "replay_episode renders timeline + file-state + markdown"; else bad "replay: $RESULT"; fi

# Test 2: replay of a non-existent episode returns found=false gracefully
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
from memory.replay import replay_episode
tmp = tempfile.mkdtemp(prefix='loki-v7722-')
try:
    os.makedirs(os.path.join(tmp, '.loki', 'memory', 'episodic'))
    r = replay_episode('does-not-exist', os.path.join(tmp, '.loki', 'memory'))
    print('NOTFOUND_OK' if (r['found'] is False and 'error' in r) else f'NOTFOUND_FAIL: {r}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "NOTFOUND_OK" ]; then ok "replay of missing episode returns found=false + error gracefully"; else bad "notfound: $RESULT"; fi

# Test 3: CLI end-to-end -- capture an episode then replay it
TEST=/tmp/loki-v7722-cli
rm -rf "$TEST"; mkdir -p "$TEST"
EPID=$(cd "$TEST" && echo '{"goal":"cli replay","outcome":"success","files_modified":["'"$TEST"'/a.py","/tmp/missing-zzz.py"]}' \
    | LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" memory ingest --from-stdin 2>/dev/null \
    | $PY -c "import json,sys,os; d=json.load(sys.stdin); print(os.path.basename(d['episode_path']).replace('task-','').replace('.json',''))")
echo "x" > "$TEST/a.py"
OUT=$(cd "$TEST" && LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" memory replay "$EPID" --json 2>/dev/null)
RESULT=$(echo "$OUT" | $PY -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print('CLI_OK' if (d['found'] and d['summary']['files_touched'] == 2 and d['summary']['files_missing'] == 1) else f'CLI_FAIL: {d.get(\"summary\")}')
except Exception as e:
    print(f'CLI_PARSE_FAIL: {e}')")
if [ "$RESULT" = "CLI_OK" ]; then ok "loki memory replay CLI round-trip (capture then replay)"; else bad "cli replay: $RESULT"; fi
rm -rf "$TEST"

# Test 4: replay does NOT mutate files (read-only invariant)
TEST=/tmp/loki-v7722-readonly
rm -rf "$TEST"; mkdir -p "$TEST"
echo "original-content" > "$TEST/file.py"
HASH_BEFORE=$($PY -c "import hashlib; print(hashlib.sha256(open('$TEST/file.py','rb').read()).hexdigest())")
EPID=$(cd "$TEST" && echo '{"goal":"readonly check","outcome":"success","files_modified":["'"$TEST"'/file.py"]}' \
    | LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" memory ingest --from-stdin 2>/dev/null \
    | $PY -c "import json,sys,os; d=json.load(sys.stdin); print(os.path.basename(d['episode_path']).replace('task-','').replace('.json',''))")
cd "$TEST" && LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" memory replay "$EPID" >/dev/null 2>&1
HASH_AFTER=$($PY -c "import hashlib; print(hashlib.sha256(open('$TEST/file.py','rb').read()).hexdigest())")
if [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then ok "replay is read-only (touched file unchanged after replay)"; else bad "replay MUTATED a file"; fi
cd "$REPO_ROOT" || exit 1; rm -rf "$TEST"

# Cleanup
bash -c 'for d in /tmp/loki-v7722-*; do rm -rf "$d" 2>/dev/null; done'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
