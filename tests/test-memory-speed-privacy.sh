#!/usr/bin/env bash
# v7.7.23 regression test: speed bench (bar 7) + privacy opt-out (bar 6)
# + secret-scrub-in-memory.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1 (bar 7): bench runs + reports percentiles + p95 under threshold
OUT=$($PY tools/bench_memory_retrieval.py --episodes 150 --runs 30 --json 2>&1 | tail -20)
RESULT=$(echo "$OUT" | $PY -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    ok = (d['runs'] == 30 and d['episodes_seeded'] == 150
          and d['p95_ms'] >= 0 and 'p95_under_threshold' in d)
    print('BENCH_OK' if ok else f'BENCH_FAIL: {d}')
except Exception as e:
    print(f'BENCH_PARSE_FAIL: {e}')")
if [ "$RESULT" = "BENCH_OK" ]; then ok "bench reports p50/p95/p99 + threshold verdict (JSON)"; else bad "bench: $RESULT"; fi

# Test 2 (bar 7): bench exit code reflects p95 vs threshold
# With a 0ms threshold it must FAIL (exit 1); with 100000ms it must PASS (exit 0).
$PY tools/bench_memory_retrieval.py --episodes 50 --runs 10 --threshold-ms 100000 >/dev/null 2>&1
PASS_CODE=$?
$PY tools/bench_memory_retrieval.py --episodes 50 --runs 10 --threshold-ms 0 >/dev/null 2>&1
FAIL_CODE=$?
if [ "$PASS_CODE" = "0" ] && [ "$FAIL_CODE" = "1" ]; then
    ok "bench exit code: 0 under threshold, 1 over (CI-gateable)"
else
    bad "bench exit codes: under=$PASS_CODE over=$FAIL_CODE"
fi

# Test 2b (council fix Opus 1 -- honesty): the bench must NOT claim to
# meet the 500ms bar at a scale where it doesn't. The docstring states
# the measured reality (10k NOT met). Verify the docstring is honest
# (mentions 10k NOT met) rather than overclaiming.
if grep -q "NOT MET" tools/bench_memory_retrieval.py \
   && grep -q "10,000 episodes" tools/bench_memory_retrieval.py; then
    ok "bench docstring honestly states 10k does NOT meet 500ms bar (no fabrication)"
else
    bad "bench docstring overclaims bar 7 at 10k"
fi

# Test 3 (bar 6): privacy opt-out via .loki/config.json memory.disabled
# blocks ingest at the engine level.
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_summary, _capture_disabled
tmp = tempfile.mkdtemp(prefix='loki-v7723-')
try:
    loki = os.path.join(tmp, '.loki')
    mem = os.path.join(loki, 'memory')
    os.makedirs(mem)
    # Without config: capture allowed
    allowed = not _capture_disabled(mem)
    # With config memory.disabled=true: capture blocked
    with open(os.path.join(loki, 'config.json'), 'w') as f:
        json.dump({'memory': {'disabled': True}}, f)
    blocked = _capture_disabled(mem)
    # And ingest_from_summary returns None when disabled
    path = ingest_from_summary(mem, goal='should not write')
    if allowed and blocked and path is None:
        print('OPTOUT_OK')
    else:
        print(f'OPTOUT_FAIL: allowed={allowed} blocked={blocked} path={path}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "OPTOUT_OK" ]; then ok ".loki/config.json memory.disabled blocks ingest (privacy opt-out)"; else bad "opt-out: $RESULT"; fi

# Test 4 (bar 6): load_memory_context honors config.json opt-out (bash side)
if grep -q "memory.*disabled\|_mem_disabled" autonomy/loki \
   && grep -q "config.json" autonomy/loki; then
    ok "load_memory_context wires .loki/config.json memory.disabled opt-out"
else
    bad "load_memory_context missing config.json opt-out gate"
fi

# Test 4b (council fix Opus 2): FAIL-CLOSED on malformed config.json.
# A config that exists but cannot be parsed must SUPPRESS capture (a JSON
# typo on a sensitive project should not silently re-enable capture).
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
from memory.ingest import _capture_disabled
tmp = tempfile.mkdtemp(prefix='loki-v7723-')
try:
    loki = os.path.join(tmp, '.loki'); mem = os.path.join(loki, 'memory')
    os.makedirs(mem)
    # Malformed JSON config
    with open(os.path.join(loki, 'config.json'), 'w') as f:
        f.write('{ this is not valid json ')
    blocked = _capture_disabled(mem)  # must be True (fail closed)
    # No config at all -> capture proceeds (fail open / default)
    os.remove(os.path.join(loki, 'config.json'))
    allowed = not _capture_disabled(mem)
    print('FAILCLOSED_OK' if (blocked and allowed) else f'FAILCLOSED_FAIL: blocked={blocked} allowed={allowed}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "FAILCLOSED_OK" ]; then ok "malformed config.json fails CLOSED (suppress capture); no config fails open"; else bad "fail-closed: $RESULT"; fi

# Test 4c: bash load_memory_context gate fails closed on malformed config too
if grep -q "fail closed (suppress memory)" autonomy/loki; then
    ok "bash load_memory_context gate fails closed on malformed config"
else
    bad "bash gate missing fail-closed handling"
fi

# Test 5: secret scrub in captured episode (bar 6 -- secrets never persisted)
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
from memory.ingest import ingest_from_summary
tmp = tempfile.mkdtemp(prefix='loki-v7723-')
try:
    mem = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(mem)
    path = ingest_from_summary(
        mem,
        goal='deploy with API_KEY=hunter2supersecret and Bearer sk-livethismadeup1234567890ABCDEF',
        outcome='success',
        files_modified=['/Users/me/.aws/credentials', '/safe/app.py'],
        tool_calls_summary='set token=ghp_aaaaaaaaaaaaaaaaaaaa and ran deploy',
    )
    blob = json.dumps(json.load(open(path)), default=str)
    leaked = any(s in blob for s in ('hunter2supersecret', 'sk-livethismadeup', 'ghp_aaaaaaaaaa', '.aws/credentials'))
    redacted = '[REDACTED' in blob
    if not leaked and redacted:
        print('SCRUB_OK')
    else:
        print(f'SCRUB_FAIL: leaked={leaked} redacted={redacted}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "SCRUB_OK" ]; then ok "captured episode scrubs secrets (keyword + sk-/ghp_ token + sensitive path)"; else bad "scrub: $RESULT"; fi

# Cleanup
bash -c 'for d in /tmp/loki-v7723-* /tmp/loki-mem-bench-*; do rm -rf "$d" 2>/dev/null; done'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
