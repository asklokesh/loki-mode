#!/usr/bin/env bash
# Regression tests for memory functional bugs found in the 2026-05-28 audit:
#  B#1: store_episode_trace passed path as positional `storage` -> crash.
#  B#2: auto_capture_episode reconstructed wrong episode path.
#  B#3: consolidated anti-patterns (category=anti-pattern in patterns.json)
#       were never returned by anti-pattern retrieval.
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# B#1: MemoryEngine must accept the path as base_path without crashing.
RESULT=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-mem-b1-')
try:
    from memory.engine import MemoryEngine
    eng = MemoryEngine(base_path=os.path.join(tmp, '.loki', 'memory'))
    eng.initialize()  # must NOT raise AttributeError
    print("B1_OK")
except Exception as e:
    print(f"B1_FAIL: {type(e).__name__}: {e}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
[ "$RESULT" = "B1_OK" ] && ok "MemoryEngine(base_path=...) initializes (store_episode_trace fix)" || bad "B1: $RESULT"

# B#1 source: the bash heredoc passes base_path= (not a bare positional).
if grep -q "MemoryEngine(base_path=f'{target_dir}/.loki/memory')" autonomy/run.sh; then
    ok "run.sh store_episode_trace uses MemoryEngine(base_path=...)"
else
    bad "run.sh still passes path positionally to MemoryEngine"
fi

# B#2: the reconstructed episode path matches storage layout (date/task-id).
if grep -q "task-{trace.id}.json" autonomy/run.sh \
   && grep -q "_date_str" autonomy/run.sh; then
    ok "run.sh reconstructs episodic/<date>/task-<id>.json (matches storage)"
else
    bad "run.sh episode path does not match storage layout"
fi

# B#3: consolidated anti-patterns are retrievable.
RESULT=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-mem-b3-')
try:
    mem = os.path.join(tmp, '.loki', 'memory'); os.makedirs(mem)
    from memory.storage import MemoryStorage
    from memory.schemas import SemanticPattern
    from memory.retrieval import MemoryRetrieval
    st = MemoryStorage(mem)
    ap = SemanticPattern.create(pattern="using float for money", category="anti-pattern")
    ap.incorrect_approach = "store currency as float causing rounding drift"
    ap.correct_approach = "use integer cents or Decimal"
    ap.description = "float money loses precision"
    st.save_pattern(ap)
    res = MemoryRetrieval(st)._keyword_search_anti_patterns(["money", "float"])
    print("B3_OK" if len(res) >= 1 and res[0].get("_source") == "anti_patterns" else f"B3_FAIL: {len(res)} results")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
[ "$RESULT" = "B3_OK" ] && ok "consolidated anti-patterns are retrievable (anti-pattern bridge)" || bad "B3: $RESULT"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
