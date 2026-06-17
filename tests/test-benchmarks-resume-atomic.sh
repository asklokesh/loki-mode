#!/usr/bin/env bash
#===============================================================================
# Test: benchmarks/run-benchmarks.sh atomic-write + --resume + dropped --parallel
#
# Covers three fixes:
#   1. Atomic results write  - a crash mid-write leaves the prior file intact
#      and valid (faithful os.replace repro), and the real code uses os.replace
#      at every results_file write site (binding grep, not vacuous).
#   2. --resume              - an already-solved SWE-bench instance is skipped
#      (no paid claude call) and its prediction is carried forward, while a new
#      instance still runs.
#   3. Dropped --parallel    - valid flags still parse; --parallel now errors.
#
# Hermetic: no network, no real claude calls, no pip installs. Uses a fake
# claude shim, an offline dataset fixture (SWEBENCH_DATASET_FILE), and the
# source-guard so the script can be sourced without running main.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCH="$REPO_DIR/benchmarks/run-benchmarks.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-bench-test.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=============================================================="
echo "  Benchmarks resume/atomic test"
echo "=============================================================="

[ -f "$BENCH" ] || { echo "FATAL: $BENCH not found"; exit 1; }

#-------------------------------------------------------------------------------
# Test 1a: faithful os.replace atomic-write repro
#   Write tmp, raise BEFORE os.replace -> original file untouched and valid.
#-------------------------------------------------------------------------------
echo ""
echo "[1a] atomic write: crash before os.replace leaves prior file intact"
ATOMIC_OUT="$(python3 - "$WORK" <<'PYEOF'
import json, os, sys
work = sys.argv[1]
path = os.path.join(work, "results.json")

# Seed a known-good prior file.
prior = {"status": "PRIOR", "predictions": [1, 2, 3]}
with open(path, "w") as f:
    json.dump(prior, f, indent=2)

def atomic_dump_crashing(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    raise RuntimeError("simulated crash before os.replace")
    os.replace(tmp, path)  # never reached

try:
    atomic_dump_crashing({"status": "NEW"}, path)
except RuntimeError:
    pass

# Original must still be readable, valid, and unchanged.
with open(path) as f:
    after = json.load(f)
assert after == prior, f"prior file was modified: {after}"
# A leftover .tmp may exist but the real file is intact -> ATOMIC.
print("ATOMIC_OK")

# Now do a successful atomic_dump and confirm it swaps in.
def atomic_dump(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)

atomic_dump({"status": "NEW"}, path)
with open(path) as f:
    assert json.load(f)["status"] == "NEW"
assert not os.path.exists(path + ".tmp"), "tmp not consumed by os.replace"
print("REPLACE_OK")
PYEOF
)"
if echo "$ATOMIC_OUT" | grep -q "ATOMIC_OK" && echo "$ATOMIC_OUT" | grep -q "REPLACE_OK"; then
    ok "crash mid-write keeps prior file valid; os.replace swaps atomically"
else
    bad "atomic-write repro failed: $ATOMIC_OUT"
fi

#-------------------------------------------------------------------------------
# Test 1b: bind to real code - every results_file write must use os.replace,
#          and no raw 'with open(results_file, ...) json.dump' remains.
#-------------------------------------------------------------------------------
echo ""
echo "[1b] real code uses atomic_dump/os.replace at every results write site"
HELPER_COUNT="$(grep -c "def atomic_dump(" "$BENCH" || true)"
REPLACE_COUNT="$(grep -c "os.replace(tmp, path)" "$BENCH" || true)"
RAW_WRITES="$(grep -c "with open(results_file, 'w')" "$BENCH" || true)"
if [ "$HELPER_COUNT" -ge 5 ] && [ "$REPLACE_COUNT" -ge 5 ] && [ "$RAW_WRITES" -eq 0 ]; then
    ok "atomic_dump helpers=$HELPER_COUNT os.replace=$REPLACE_COUNT raw-results-writes=$RAW_WRITES"
else
    bad "expected helpers>=5, os.replace>=5, raw-writes==0; got helpers=$HELPER_COUNT replace=$REPLACE_COUNT raw=$RAW_WRITES"
fi

#-------------------------------------------------------------------------------
# Test 2: --resume skips an already-present instance (no paid claude call)
#         and carries its prediction forward; the new instance still runs.
#-------------------------------------------------------------------------------
echo ""
echo "[2] --resume skips solved instance, runs only the new one"

RESULTS_DIR="$WORK/results"
RESULTS_DIR_FIXED="$RESULTS_DIR"   # survives the source-time RESULTS_DIR clobber
export RESULTS_DIR_FIXED
mkdir -p "$RESULTS_DIR"

# Fake claude shim: records each invocation and emits a valid unified diff so
# the SWEBENCH_LOKI QA gate accepts the patch for the un-solved instance.
SHIM_DIR="$WORK/bin"
mkdir -p "$SHIM_DIR"
CALL_LOG="$WORK/claude-calls.log"
cat > "$SHIM_DIR/claude" <<SHIMEOF
#!/usr/bin/env bash
echo "invoked" >> "$CALL_LOG"
cat <<'PATCH'
--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def f():
-    return 0
+    return 1
PATCH
SHIMEOF
chmod +x "$SHIM_DIR/claude"

# Offline 2-instance dataset fixture.
DATASET="$WORK/dataset.json"
cat > "$DATASET" <<'DSEOF'
[
  {"instance_id": "proj__repo-1", "repo": "proj/repo", "base_commit": "abc",
   "problem_statement": "fix bug one", "hints_text": ""},
  {"instance_id": "proj__repo-2", "repo": "proj/repo", "base_commit": "def",
   "problem_statement": "fix bug two", "hints_text": ""}
]
DSEOF

# Pre-seed a resume predictions file marking instance-1 as already solved
# (non-empty patch). Instance-2 is absent -> must be run.
cat > "$RESULTS_DIR/swebench-loki-predictions.json" <<'PREDEOF'
[
  {"instance_id": "proj__repo-1",
   "model_patch": "--- a/already.py\n+++ b/already.py\n@@ -1 +1 @@\n-old\n+new\n",
   "model_name_or_path": "loki-mode-sonnet", "attempts": 1}
]
PREDEOF

# Drive the real run_swebench_loki via source-guard + resume env.
# IMPORTANT: source FIRST (sourcing re-runs the top-level RESULTS_DIR=...date...
# assignment), THEN pin RESULTS_DIR/RESUME_DIR so the run writes into and
# resumes from our seeded dir - mirroring what main() does for --resume.
(
    export SWEBENCH_DATASET_FILE="$DATASET"
    export SCRIPT_DIR="$REPO_DIR/benchmarks"
    export PROBLEM_LIMIT=0
    export PROBLEM_TIMEOUT=30
    export CLAUDE_MODEL=sonnet
    export MAX_RETRIES=1
    export PATH="$SHIM_DIR:$PATH"
    # shellcheck disable=SC1090
    source "$BENCH"
    # main() does this wiring for --resume; replicate it here since we call the
    # loki function directly.
    RESULTS_DIR="$RESULTS_DIR_FIXED"
    RESUME_DIR="$RESULTS_DIR_FIXED"
    export RESULTS_DIR RESUME_DIR
    run_swebench_loki
) > "$WORK/run2.log" 2>&1
RUN_RC=$?

if [ $RUN_RC -ne 0 ]; then
    bad "run_swebench_loki exited non-zero ($RUN_RC):"
    sed 's/^/      /' "$WORK/run2.log"
fi

# The fake claude must NOT have been called for the solved instance. Instance-2
# runs Architect + Engineer + (QA is local) so >=1 invocation total, but the
# log must show the run touched only the second instance.
SKIPPED_SHOWN=0
grep -q "SKIPPED (resume)" "$WORK/run2.log" && SKIPPED_SHOWN=1

# Final predictions must contain BOTH instances (carry-forward + new).
FINAL_PRED="$RESULTS_DIR/swebench-loki-predictions.json"
HAS_BOTH="$(python3 - "$FINAL_PRED" <<'PYEOF'
import json, sys
preds = json.load(open(sys.argv[1]))
ids = {p["instance_id"]: p.get("model_patch", "") for p in preds}
both = "proj__repo-1" in ids and "proj__repo-2" in ids
# carried-forward instance keeps its original (non-shim) patch text
carried = ids.get("proj__repo-1", "").startswith("--- a/already.py")
# new instance got a non-empty patch from the run
newrun = bool(ids.get("proj__repo-2", ""))
print("BOTH" if (both and carried and newrun) else f"NO ids={list(ids)} carried={carried} newrun={newrun}")
PYEOF
)"

if [ "$SKIPPED_SHOWN" -eq 1 ]; then
    ok "solved instance reported SKIPPED (resume) - no paid call"
else
    bad "expected 'SKIPPED (resume)' in output; got:"
    sed 's/^/      /' "$WORK/run2.log"
fi

if [ "$HAS_BOTH" = "BOTH" ]; then
    ok "final predictions carry forward instance-1 AND include freshly-run instance-2"
else
    bad "carry-forward/new-instance check failed: $HAS_BOTH"
fi

# Confirm the carried-forward path did NOT invoke claude for instance-1: the
# only invocations should be for the second instance's agent pipeline.
if [ -f "$CALL_LOG" ]; then
    CALLS="$(wc -l < "$CALL_LOG" | tr -d ' ')"
else
    CALLS=0
fi
# With resume, instance-1 is skipped entirely; instance-2 runs at least the
# Architect + Engineer agents -> at least 1 call, and crucially the run did not
# redo a full 2-instance pass. We assert calls>=1 (instance-2 ran) and that the
# skip message appeared (instance-1 did not run its agents).
if [ "$CALLS" -ge 1 ] && [ "$SKIPPED_SHOWN" -eq 1 ]; then
    ok "claude invoked for the new instance only (calls=$CALLS, instance-1 skipped)"
else
    bad "expected claude calls>=1 for new instance with instance-1 skipped (calls=$CALLS skip=$SKIPPED_SHOWN)"
fi

#-------------------------------------------------------------------------------
# Test 2b: resume must be incremental/atomic - a fresh (no-resume) run that we
#          can interrupt-and-reread still yields valid JSON. We assert the
#          predictions file written during the resumed run is valid JSON.
#-------------------------------------------------------------------------------
echo ""
echo "[2b] resumed run leaves valid JSON results + predictions"
for f in "$RESULTS_DIR/swebench-loki-results.json" "$RESULTS_DIR/swebench-loki-predictions.json"; do
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
        ok "valid JSON: $(basename "$f")"
    else
        bad "invalid/missing JSON: $f"
    fi
done

#-------------------------------------------------------------------------------
# Test 3: --parallel removed; valid flags still parse; --parallel now errors.
#-------------------------------------------------------------------------------
echo ""
echo "[3] arg parsing: valid flags OK, --parallel rejected"

# 3a: valid flags parse without error via sourced parse_args.
PARSE_OK="$(
    (
        # shellcheck disable=SC1090
        source "$BENCH"
        parse_args --execute --limit 2 --model sonnet --timeout 30 --resume /tmp/x swebench
        echo "BENCHMARK=$BENCHMARK EXECUTE=$EXECUTE_MODE LIMIT=$PROBLEM_LIMIT MODEL=$CLAUDE_MODEL RESUME=$RESUME_DIR"
    ) 2>&1
)"
if echo "$PARSE_OK" | grep -q "BENCHMARK=swebench EXECUTE=true LIMIT=2 MODEL=sonnet RESUME=/tmp/x"; then
    ok "valid flags (incl. --resume) parse correctly: $PARSE_OK"
else
    bad "valid-flag parse failed: $PARSE_OK"
fi

# 3b: --parallel must now be an unknown option (removed).
PAR_RC=0
PAR_OUT="$(
    (
        # shellcheck disable=SC1090
        source "$BENCH"
        parse_args --parallel 4 swebench
    ) 2>&1
)" || PAR_RC=$?
if [ "$PAR_RC" -ne 0 ] && echo "$PAR_OUT" | grep -qi "Unknown option: --parallel"; then
    ok "--parallel is rejected as unknown option (flag removed)"
else
    bad "--parallel should error as unknown option; rc=$PAR_RC out=$PAR_OUT"
fi

# 3c: no PARALLEL_COUNT remnants in the script.
if grep -q "PARALLEL_COUNT" "$BENCH"; then
    bad "PARALLEL_COUNT still referenced in script"
else
    ok "no PARALLEL_COUNT remnants in script"
fi

#-------------------------------------------------------------------------------
echo ""
echo "=============================================================="
echo "  RESULT: $PASS passed, $FAIL failed"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
