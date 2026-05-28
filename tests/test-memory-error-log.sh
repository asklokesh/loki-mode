#!/usr/bin/env bash
# v7.7.17 regression test: memory subsystem error log replaces the
# silent-fail (`except Exception: pass`) pattern at autonomy/run.sh:8724,
# 9087, 9136 with structured logging to `.loki/memory/.errors.log`,
# surfaced in `loki doctor --json` as `memory.recent_errors`.
#
# Diagnosis report at ~/git/loki-plan/MEMORY-DIAGNOSIS-2026-05-27.md
# Secondary Issue #1: silent-fail everywhere masks future regressions.
# This test locks in the v7.7.17 fix.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: log_memory_error writes structured records
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil
sys.path.insert(0, '.')
from memory.error_log import log_memory_error, read_recent_errors

tmp = tempfile.mkdtemp(prefix="loki-v7717-")
try:
    try:
        raise ValueError("synthetic error 1")
    except ValueError as e:
        log_memory_error(tmp, "test_func", e)
    try:
        raise KeyError("synthetic key error")
    except KeyError as e:
        log_memory_error(tmp, "another_func", e)
    recent = read_recent_errors(tmp, limit=5)
    if (len(recent) == 2
        and "ValueError" in recent[0]
        and "KeyError" in recent[1]
        and "test_func" in recent[0]
        and "another_func" in recent[1]):
        print("BASIC_OK")
    else:
        print(f"BASIC_FAIL: {recent}")
finally:
    shutil.rmtree(tmp)
PYEOF
)
if [ "$RESULT" = "BASIC_OK" ]; then ok "log_memory_error writes + read_recent_errors reads 2 records"; else bad "basic record write/read: $RESULT"; fi

# Test 2: log_memory_error never raises even on broken target dir
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys
sys.path.insert(0, '.')
from memory.error_log import log_memory_error
# Pass an unwriteable path (root-owned or absurd). Must not raise.
try:
    log_memory_error("/proc/loki-cannot-write-here", "noop", RuntimeError("test"))
    print("NEVER_RAISES_OK")
except Exception as e:
    print(f"RAISED: {type(e).__name__}: {e}")
PYEOF
)
if [ "$RESULT" = "NEVER_RAISES_OK" ]; then ok "log_memory_error never raises on unwriteable path"; else bad "log_memory_error raised: $RESULT"; fi

# Test 3: read_recent_errors returns empty when no log file exists
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil
sys.path.insert(0, '.')
from memory.error_log import read_recent_errors
tmp = tempfile.mkdtemp(prefix="loki-v7717-")
try:
    out = read_recent_errors(tmp)
    print("EMPTY_OK" if out == [] else f"EMPTY_FAIL: {out}")
finally:
    shutil.rmtree(tmp)
PYEOF
)
if [ "$RESULT" = "EMPTY_OK" ]; then ok "read_recent_errors returns [] when no log present"; else bad "expected empty: $RESULT"; fi

# Test 4: rotation happens at 10MB threshold
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
from memory.error_log import log_memory_error, _errors_log_path, MAX_LOG_SIZE_BYTES

tmp = tempfile.mkdtemp(prefix="loki-v7717-")
try:
    # Pre-fill the log file to 10.1MB so the next write triggers rotation
    log_path = _errors_log_path(tmp)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w") as f:
        f.write("x" * (MAX_LOG_SIZE_BYTES + 1024))
    pre_size = log_path.stat().st_size
    # Trigger a log write (which should rotate before appending)
    try:
        raise RuntimeError("trigger rotation")
    except RuntimeError as e:
        log_memory_error(tmp, "rotation_test", e)
    rotated = log_path.with_suffix(".log.1")
    if rotated.exists() and rotated.stat().st_size >= pre_size and log_path.stat().st_size < 1024:
        print("ROTATE_OK")
    else:
        print(f"ROTATE_FAIL: rotated_exists={rotated.exists()} cur_size={log_path.stat().st_size}")
finally:
    shutil.rmtree(tmp)
PYEOF
)
if [ "$RESULT" = "ROTATE_OK" ]; then ok "rotation fires at 10MB threshold (current -> .log.1)"; else bad "rotation: $RESULT"; fi

# Test 5: `loki doctor --json` surfaces memory.recent_errors
# Use the LOCAL source via BUN_FROM_SOURCE=1 so we exercise the v7.7.17 code
TEST_DIR=/tmp/loki-v7717-doctor-test
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/.loki/memory"
# Pre-seed an error record via the same writer used by run.sh
$PY -c "
import sys; sys.path.insert(0, '$REPO_ROOT')
from memory.error_log import log_memory_error
try:
    raise RuntimeError('doctor-test-seed')
except RuntimeError as e:
    log_memory_error('$TEST_DIR/.loki/memory', 'doctor_smoke_seed', e)
"
# Run the bash doctor against that directory (LOKI_DIR forces relative path)
RESULT=$(cd "$TEST_DIR" && LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor --json 2>/dev/null \
    | $PY -c "
import json, sys
d = json.load(sys.stdin)
m = d.get('memory', {})
if (m.get('status') == 'warn'
    and m.get('recent_error_count') == 1
    and m.get('recent_errors')
    and 'doctor_smoke_seed' in m['recent_errors'][0]
    and 'RuntimeError' in m['recent_errors'][0]):
    print('DOCTOR_OK')
else:
    print(f'DOCTOR_FAIL: {m}')
")
if [ "$RESULT" = "DOCTOR_OK" ]; then ok "bash doctor --json surfaces memory.recent_errors with seeded record"; else bad "bash doctor: $RESULT"; fi

# Test 6: Bun route doctor --json mirrors the memory field (parity)
RESULT=$(cd "$TEST_DIR" && LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$REPO_ROOT/bin/loki" doctor --json 2>/dev/null \
    | $PY -c "
import json, sys
d = json.load(sys.stdin)
m = d.get('memory', {})
if (m.get('status') == 'warn'
    and m.get('recent_error_count') == 1
    and m.get('recent_errors')
    and 'doctor_smoke_seed' in m['recent_errors'][0]):
    print('BUN_DOCTOR_OK')
else:
    print(f'BUN_DOCTOR_FAIL: {m}')
")
if [ "$RESULT" = "BUN_DOCTOR_OK" ]; then ok "bun doctor --json surfaces memory.recent_errors (bash/bun parity)"; else bad "bun doctor: $RESULT"; fi

# Test 7 (council fix Opus 2): secret scrubbing on exception messages
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil
sys.path.insert(0, '.')
from memory.error_log import log_memory_error, read_recent_errors
tmp = tempfile.mkdtemp(prefix="loki-v7717-")
try:
    try:
        raise RuntimeError("auth failed: Authorization: Bearer sk-livethisismadeup1234567890ABCDEF")
    except RuntimeError as e:
        log_memory_error(tmp, "scrub_test", e)
    try:
        raise ValueError("Bad API_KEY=hunter2supersecret in config")
    except ValueError as e:
        log_memory_error(tmp, "scrub_keyword_test", e)
    recent = read_recent_errors(tmp)
    joined = "\n".join(recent)
    if ("sk-livethisismadeup" in joined
        or "hunter2supersecret" in joined):
        print(f"SCRUB_FAIL: secret leaked: {joined[:300]}")
    elif "[REDACTED]" in joined:
        print("SCRUB_OK: secrets redacted")
    else:
        print(f"SCRUB_UNCLEAR: {joined[:200]}")
finally:
    shutil.rmtree(tmp)
PYEOF
)
if [ "$RESULT" = "SCRUB_OK: secrets redacted" ]; then ok "scrubber redacts sk- tokens + credential keywords before write"; else bad "scrub: $RESULT"; fi

# Test 8 (council fix Opus 2): tail-only read does not OOM on huge logs
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil
sys.path.insert(0, '.')
from memory.error_log import _errors_log_path, read_recent_errors
tmp = tempfile.mkdtemp(prefix="loki-v7717-")
try:
    log_path = _errors_log_path(tmp)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # 5 MB of dummy data + 3 real records at the tail
    with open(log_path, "wb") as f:
        f.write(b"x" * (5 * 1024 * 1024))
    with open(log_path, "a") as f:
        f.write("\n2026-01-01T00:00:00\trecord_A\tValueError\toldest\tcontext\n")
        f.write("2026-01-01T00:00:01\trecord_B\tKeyError\tmiddle\tcontext\n")
        f.write("2026-01-01T00:00:02\trecord_C\tRuntimeError\tnewest\tcontext\n")
    # tail-only read should still find the 3 real records at end
    recent = read_recent_errors(tmp, limit=5)
    has_a = any("record_A" in r for r in recent)
    has_b = any("record_B" in r for r in recent)
    has_c = any("record_C" in r for r in recent)
    if has_a and has_b and has_c and len(recent) == 3:
        print("TAIL_OK")
    else:
        print(f"TAIL_FAIL: has_a={has_a} has_b={has_b} has_c={has_c} n={len(recent)}")
finally:
    shutil.rmtree(tmp)
PYEOF
)
if [ "$RESULT" = "TAIL_OK" ]; then ok "tail-only read finds last records in a 5MB+ file (no OOM)"; else bad "tail: $RESULT"; fi

# Test 9 (council fix Opus 2): bash + Bun errors_log_path string parity
TEST_DIR=/tmp/loki-v7717-pathparity
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/.loki/memory"
$PY -c "
import sys; sys.path.insert(0, '$REPO_ROOT')
from memory.error_log import log_memory_error
try:
    raise RuntimeError('parity-seed')
except RuntimeError as e:
    log_memory_error('$TEST_DIR/.loki/memory', 'parity_seed', e)
"
BASH_PATH=$(cd "$TEST_DIR" && LOKI_DIR=.loki LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor --json 2>/dev/null | $PY -c "import json,sys; print(json.load(sys.stdin).get('memory',{}).get('errors_log_path',''))")
BUN_PATH=$(cd "$TEST_DIR" && LOKI_DIR=.loki BUN_FROM_SOURCE=1 bash "$REPO_ROOT/bin/loki" doctor --json 2>/dev/null | $PY -c "import json,sys; print(json.load(sys.stdin).get('memory',{}).get('errors_log_path',''))")
if [ "$BASH_PATH" = "$BUN_PATH" ] && [ -n "$BASH_PATH" ]; then
    ok "bash and Bun emit identical errors_log_path string ($BASH_PATH)"
else
    bad "parity: bash='$BASH_PATH' bun='$BUN_PATH'"
fi

rm -rf "$TEST_DIR" /tmp/loki-v7717-*

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
