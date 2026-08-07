#!/usr/bin/env bash
# End-to-end check for the failure_memory wire: write side (track_gate_failure)
# and read side (the build_prompt block) must agree on the SAME .loki dir.
# set -u mirrors run.sh:185 -- the one-arg call sites must survive it.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
T="$(mktemp -d)"
cd "$T" || exit 1
mkdir -p .loki/quality
SCRIPT_DIR="$REPO/autonomy"

# Real evidence artifact, in the shape the mock gate actually writes.
printf '# comment line\n\n[HIGH] src/api.test.ts mocks the module under test\n' \
  > .loki/quality/mock-findings.txt

# --- WRITE SIDE (the real function, extracted from run.sh) ---
record_trust_event_bash() { :; }
eval "$(awk '/^track_gate_failure\(\) \{/,/^\}/' "$REPO/autonomy/run.sh")"

out="$(track_gate_failure "mock_integrity" ".loki/quality/mock-findings.txt")"
echo "stdout-is-count: [$out]"
[ "$out" = "1" ] || { echo "FAIL: stdout polluted or wrong count"; exit 1; }
out2="$(track_gate_failure "mock_integrity" ".loki/quality/mock-findings.txt")"
[ "$out2" = "2" ] || { echo "FAIL: count not 2, got [$out2]"; exit 1; }

# A no-evidence call must record NOTHING: the module refuses unfalsifiable lessons.
track_gate_failure "some_gate_without_evidence" >/dev/null

echo "--- failures.jsonl ---"
cat .loki/memory/failures.jsonl
grep -q "some_gate_without_evidence" .loki/memory/failures.jsonl \
  && { echo "FAIL: recorded a lesson with no evidence"; exit 1; }
grep -q "mocks the module under test" .loki/memory/failures.jsonl \
  || { echo "FAIL: evidence is not the real finding line"; exit 1; }
grep -q '# comment' .loki/memory/failures.jsonl \
  && { echo "FAIL: stored the comment line instead of the finding"; exit 1; }

# --- READ SIDE (the exact block now in build_prompt) ---
failure_memory_context=""
if [ -r "${SCRIPT_DIR}/lib/failure_memory.py" ] && [ -d ".loki" ]; then
    failure_memory_context="$(_FM_LIB="${SCRIPT_DIR}/lib" \
        _FM_DIR="${LOKI_DIR:-${TARGET_DIR:-.}/.loki}" python3 -c '
import os, sys
sys.path.insert(0, os.environ["_FM_LIB"])
try:
    from failure_memory import prompt_context
    lines = prompt_context(os.environ["_FM_DIR"]).get("lines") or []
except Exception:
    lines = []
if lines:
    print("KNOWN FAILURE HISTORY IN THIS REPO (measured, from previous runs): "
          + "; ".join(lines) + ".")
' 2>/dev/null || true)"
fi
echo "--- prompt line ---"
echo "[$failure_memory_context]"
echo "$failure_memory_context" | grep -q "mock_integrity gate has failed 2 times" \
  || { echo "FAIL: read side did not see what the write side wrote"; exit 1; }

# An empty store must emit NOTHING (this is what keeps the 60 parity fixtures byte-identical).
mv .loki/memory/failures.jsonl .loki/memory/moved.bak
fmc="$(_FM_LIB="${SCRIPT_DIR}/lib" _FM_DIR=".loki" python3 -c '
import os, sys
sys.path.insert(0, os.environ["_FM_LIB"])
from failure_memory import prompt_context
lines = prompt_context(os.environ["_FM_DIR"]).get("lines") or []
if lines: print("X")
' 2>/dev/null || true)"
[ -z "$fmc" ] || { echo "FAIL: emitted something on an empty store"; exit 1; }

echo "PASS: write->read wired, evidence is real, empty store emits nothing"

# Explicit cleanup, not `trap ... EXIT`: this script uses command substitution,
# and a bare EXIT trap fires in every subshell (it would delete the tmpdir out
# from under the first `$(...)` above). Failure paths exit before here, which is
# deliberate -- a failed run leaves its evidence on disk to inspect.
cd /
rm -rf "$T"
