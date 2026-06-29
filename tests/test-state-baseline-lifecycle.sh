#!/usr/bin/env bash
# tests/test-state-baseline-lifecycle.sh -- Two-run lifecycle: a fresh
# invocation after a TERMINAL run must start with a fresh baseline (W3-FIX1,
# v7.19.1). This is the REJECT-closing regression test for the verified-
# completion evidence gate.
#
# The bug: load_state restored ITERATION_COUNT from the prior session's
# persisted state and only reset it for the FAILURE-terminal states
# (failed|max_iterations_reached|max_retries_exceeded|exited). After a
# SUCCESSFUL completion (council_approved / council_force_approved /
# completion_promise_fulfilled) or a crash (running), ITERATION_COUNT stayed
# >0 on the next `loki start`. The run-start SHA recapture in run_autonomous
# is gated on `ITERATION_COUNT==0`, so a stale count left the evidence gate
# diffing the new run's work against the PRIOR run's start SHA: the gate
# became toothless exactly on run 2+.
#
# Strategy: extract the real load_state() from run.sh and the real start-sha
# recapture block, source them with minimal log_* stubs, and assert BOTH:
#   (1) ITERATION_COUNT == 0 after load_state on a terminal prior status
#   (2) the recapture fires so start-sha == run2 HEAD (not run1's SHA)
# Resume states (paused/interrupted) MUST preserve the count (negative cases).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }

# --- Extract the real load_state() function from run.sh -----------------------
HARNESS="$(mktemp -t loki-baseline-harness.XXXXXX.sh)"
trap 'rm -f "$HARNESS"' EXIT

{
  echo 'log_info() { :; }'
  echo 'log_warn() { :; }'
  echo 'log_warning() { :; }'
  echo 'log_error() { :; }'
  # _loki_state_file() resolves the (optionally session-namespaced) state-file
  # path; load_state() calls it (added with multi-build state isolation, A6), so
  # it MUST be extracted too or load_state's "$(_loki_state_file)" expands empty
  # and the whole load/reset block is silently skipped.
  sed -n '/^_loki_state_file() {/,/^}/p' "$RUN_SCRIPT"
  # Real load_state(), verbatim from run.sh.
  sed -n '/^load_state() {/,/^}/p' "$RUN_SCRIPT"
} > "$HARNESS"

# Sanity: did we actually capture BOTH functions?
if ! grep -q '_loki_state_file() {' "$HARNESS"; then
  echo "FATAL: failed to extract _loki_state_file() from $RUN_SCRIPT (line drift?)"
  exit 2
fi
if ! grep -q 'prev_status' "$HARNESS"; then
  echo "FATAL: failed to extract load_state() from $RUN_SCRIPT (line drift?)"
  exit 2
fi
# shellcheck source=/dev/null
source "$HARNESS"

# Replicate the EXACT recapture guard from run_autonomous (the gate baseline).
# Kept in lockstep with run.sh:~11424. If run.sh changes the guard, this test
# should be updated alongside; the assertion below proves the guard fires.
recapture_start_sha() {
    local _start_sha_file=".loki/state/start-sha"
    mkdir -p ".loki/state"
    if [ "${ITERATION_COUNT:-0}" -eq 0 ] || [ ! -s "$_start_sha_file" ]; then
        (cd "${TARGET_DIR:-.}" && git rev-parse HEAD 2>/dev/null) > "$_start_sha_file" 2>/dev/null || true
    fi
    _LOKI_RUN_START_SHA="$(cat "$_start_sha_file" 2>/dev/null || echo "")"
}

# --- Helper: a throwaway git repo simulating a completed run 1 ---------------
# Writes an autonomy-state.json with the given status + iterationCount, and a
# start-sha pinned to run1's HEAD. Then advances HEAD (run 2's new commits) so
# a fresh baseline must differ from run1's SHA.
setup_repo() {
    local status="$1" itercount="$2"
    local d; d="$(mktemp -d -t loki-baseline.XXXXXX)"
    cd "$d" || return 1
    git init -q
    git config user.email t@t.t; git config user.name t
    git config commit.gpgsign false
    echo "v1" > f.txt; git add f.txt; git commit -qm c1
    local run1_sha; run1_sha="$(git rev-parse HEAD)"
    mkdir -p .loki/state
    cat > .loki/autonomy-state.json <<JSON
{"status": "$status", "retryCount": 3, "iterationCount": $itercount}
JSON
    # run1 left its baseline pinned to run1 HEAD.
    printf '%s\n' "$run1_sha" > .loki/state/start-sha
    # run 2 makes new commits (HEAD advances past run1_sha).
    echo "v2" > f.txt; git add f.txt; git commit -qm c2
    echo "v3" > g.txt; git add g.txt; git commit -qm c3
    REPO_DIR="$d"
    RUN1_SHA="$run1_sha"
    RUN2_HEAD="$(git rev-parse HEAD)"
}

cleanup_repo() { cd /; rm -rf "$REPO_DIR" 2>/dev/null || true; }

# --- Terminal states that MUST reset (fresh baseline on run 2) ---------------
for st in council_approved council_force_approved completion_promise_fulfilled reuse_already_satisfied max_iterations_reached failed running; do
    setup_repo "$st" 8 || { fail "setup $st"; continue; }
    ITERATION_COUNT=999; RETRY_COUNT=999; TARGET_DIR="$REPO_DIR"
    load_state
    if [ "${ITERATION_COUNT}" -eq 0 ]; then
        ok "$st: ITERATION_COUNT reset to 0"
    else
        fail "$st: ITERATION_COUNT=$ITERATION_COUNT (expected 0 -- stale baseline bug)"
    fi
    # Fact 2: the gate baseline recaptures to run2 HEAD, not run1's SHA.
    recapture_start_sha
    if [ "$_LOKI_RUN_START_SHA" = "$RUN2_HEAD" ]; then
        ok "$st: start-sha recaptured to run2 HEAD (gate not toothless)"
    elif [ "$_LOKI_RUN_START_SHA" = "$RUN1_SHA" ]; then
        fail "$st: start-sha still pinned to RUN1 ($RUN1_SHA) -- gate would diff against prior run"
    else
        fail "$st: start-sha unexpected value '$_LOKI_RUN_START_SHA'"
    fi
    cleanup_repo
done

# --- Resume states that MUST preserve the count (negative cases) -------------
for st in paused interrupted; do
    setup_repo "$st" 8 || { fail "setup $st"; continue; }
    ITERATION_COUNT=999; RETRY_COUNT=999; TARGET_DIR="$REPO_DIR"
    load_state
    if [ "${ITERATION_COUNT}" -eq 8 ]; then
        ok "$st: ITERATION_COUNT preserved at 8 (resume semantics intact)"
    else
        fail "$st: ITERATION_COUNT=$ITERATION_COUNT (expected 8 -- resume must NOT reset)"
    fi
    # On a genuine resume the baseline must NOT move mid-run (stays run1 SHA).
    recapture_start_sha
    if [ "$_LOKI_RUN_START_SHA" = "$RUN1_SHA" ]; then
        ok "$st: start-sha preserved at run1 SHA (resume diff window intact)"
    else
        fail "$st: start-sha moved to '$_LOKI_RUN_START_SHA' (resume baseline must not move)"
    fi
    cleanup_repo
done

echo ""
echo "===================================="
echo "Lifecycle baseline tests: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
