#!/usr/bin/env bash
# Test: N-58 list_runs(outcome='error'|'ok') filters by run outcome.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# Setup: write fake run logs with mixed outcomes via the logs dir.
mk_run() {
    cat <<JSON
{"run_id":"$1","function":"f","version":1,"started_at":"2026-01-01T00:00:00Z","duration_ms":10,"ok":$2,"exit_code":$3,"stderr_head":"","error":null}
JSON
}

# 1. outcome filter rejects unknown -> still returns all (default behaviour)
if run_py "
import json, os, tempfile
from forge.services.functions.logs import list_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i, ok in enumerate([True, False, True, False, False]):
        with open(os.path.join(logs, f'r{i}.json'), 'w') as fp:
            json.dump({'run_id': f'r{i}', 'ok': ok}, fp)
    all_r = list_runs(d, 'f')
    assert len(all_r) == 5
    errs = list_runs(d, 'f', outcome='error')
    assert len(errs) == 3, errs
    oks = list_runs(d, 'f', outcome='ok')
    assert len(oks) == 2, oks
print('OK')" | grep -q '^OK$'; then pass "N-58 filter ok/error"; else fail "filter wrong"; fi

# 2. limit applies after filter (returns N actual matches)
if run_py "
import json, os, tempfile
from forge.services.functions.logs import list_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    # 10 ok + 3 errors
    for i in range(10):
        with open(os.path.join(logs, f'a{i}.json'), 'w') as fp:
            json.dump({'run_id': f'a{i}', 'ok': True}, fp)
    for i in range(3):
        with open(os.path.join(logs, f'b{i}.json'), 'w') as fp:
            json.dump({'run_id': f'b{i}', 'ok': False}, fp)
    errs = list_runs(d, 'f', limit=10, outcome='error')
    assert len(errs) == 3, errs
print('OK')" | grep -q '^OK$'; then pass "N-58 limit applies post-filter"; else fail "limit pre-filter"; fi

# 3. no outcome arg returns everything (back-compat)
if run_py "
import json, os, tempfile
from forge.services.functions.logs import list_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i in range(3):
        with open(os.path.join(logs, f'r{i}.json'), 'w') as fp:
            json.dump({'run_id': f'r{i}', 'ok': i % 2 == 0}, fp)
    assert len(list_runs(d, 'f')) == 3
print('OK')" | grep -q '^OK$'; then pass "N-58 default back-compat"; else fail "default broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
