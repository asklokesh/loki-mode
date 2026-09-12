#!/usr/bin/env bash
# `loki next` and `loki resume` must not contradict each other.
#
# THE DEFECT, reproduced before the fix: cmd_next maps max_iterations_reached
# and budget_exceeded to "Will run: loki resume", but the resume hint helper
# accepted ONLY status "interrupted". So `loki next` told the user to run
# `loki resume`, and `loki resume` answered "No session to resume. Start a
# session with: loki start" -- and exited 0, so nothing anywhere went red.
# The two commands whose entire job is "do the right next thing" disagreed on
# every run that stopped at a limit.
#
# WHAT IS LOAD-BEARING, and why this suite drives BOTH commands rather than
# asserting on either one: a test that only checked `loki resume` prints
# something useful would stay green if cmd_next later drifted to a different
# verb. The agreement is the property under test, so the announced command is
# READ OUT of `loki next` and that exact command is then run.
#
# THE OVER-CORRECTION THIS ALSO GUARDS: widening the helper to accept a
# VERDICT status (council_approved) would send an approved, shipped build back
# into the iteration loop. That is worse than the silence it replaces, so the
# refusal is asserted as explicitly as the acceptance.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-next-resume-agree"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: agreement was NOT measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# Build a project dir whose only state is a finished-run status.
mk_state() {
    local dir="$WORK/$1" status="$2" prd="${3:-}"
    mkdir -p "$dir/.loki"
    _S="$status" _P="$prd" python3 -c "
import json, os
json.dump({'status': os.environ['_S'], 'iteration': 9,
           'lastRun': '2026-09-12T10:00:00Z',
           'prdPath': os.environ['_P']},
          open(os.path.join(os.environ['_D'], '.loki', 'autonomy-state.json'), 'w'))
" _D="$dir" 2>/dev/null || _D="$dir" _S="$status" _P="$prd" python3 -c "
import json, os
json.dump({'status': os.environ['_S'], 'iteration': 9,
           'lastRun': '2026-09-12T10:00:00Z',
           'prdPath': os.environ['_P']},
          open(os.path.join(os.environ['_D'], '.loki', 'autonomy-state.json'), 'w'))
"
    printf '%s\n' "$dir"
}

# The literal dead-end string the defect produced. Kept in one place so a
# reworded message updates every assertion at once.
DEAD_END="No session to resume"

# --- The resumable-limit statuses: next and resume must AGREE -----------------
for status in max_iterations_reached budget_exceeded interrupted; do
    dir="$(mk_state "ok_$status" "$status")"

    next_out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" next --dry-run 2>&1)"
    # Read the verb cmd_next actually announces rather than hardcoding it here.
    announced="$(printf '%s' "$next_out" | sed -n 's/.*Will run *: *//p' | tr -d '\r' | head -1)"

    if [ "$announced" = "loki resume" ]; then
        pass "$status: loki next announces 'loki resume'"
    else
        fail "$status: loki next announced '$announced', not 'loki resume' (map drifted)"
        continue
    fi

    # Run the command it announced. It must not dead-end.
    resume_out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    case "$resume_out" in
        *"$DEAD_END"*)
            fail "$status: next said 'loki resume' but resume printed '$DEAD_END'" ;;
        *)
            pass "$status: the announced command does not dead-end" ;;
    esac

    # Vacuity guard: an empty output would pass the case above while telling the
    # user nothing at all.
    if [ -n "${resume_out//[[:space:]]/}" ]; then
        pass "$status: resume produced actual guidance"
    else
        fail "$status: resume printed nothing; the assertion above was vacuous"
    fi
done

# --- A capped run must be told to RAISE THE LIMIT, not just re-run ------------
# Resuming a capped run unchanged hits the same wall on the next iteration, so
# advice that omits the cap has moved the contradiction rather than closed it.
dir="$(mk_state "cap_advice" "max_iterations_reached")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if printf '%s' "$out" | grep -q 'LOKI_MAX_ITERATIONS'; then
    pass "an iteration-capped run is told to raise LOKI_MAX_ITERATIONS"
else
    fail "capped run advice omits the cap; resuming as-is hits the same limit"
fi

dir="$(mk_state "budget_advice" "budget_exceeded")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if printf '%s' "$out" | grep -q 'LOKI_BUDGET_LIMIT'; then
    pass "a budget-capped run is told to raise LOKI_BUDGET_LIMIT"
else
    fail "budget run advice omits the budget; resuming as-is hits the same limit"
fi

# --- A CAPPED RUN MUST NOT PROMISE A RESUMED ITERATION ------------------------
# My first version of this fix printed "Stopped at iteration N ... It picks up
# from iteration N" for capped runs. That is FALSE: load_state resets
# ITERATION_COUNT=0 for max_iterations_reached and budget_exceeded (the
# failure-terminals case arm in autonomy/run.sh), so a fresh `loki start` is a
# NEW session from 0. The number promised a continuation the runtime does not
# honour. tests/test-resume-discoverability.sh caught it in CI, not here --
# this suite passed the wrong implementation, so the assertion is added now.
#
# Only `interrupted` genuinely resumes its count.
for status in max_iterations_reached budget_exceeded; do
    dir="$(mk_state "noiter_$status" "$status")"
    out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    # mk_state writes iteration 9; it must not appear as a promised pick-up.
    if printf '%s' "$out" | grep -q 'picks up from iteration'; then
        fail "$status: promises to pick up from an iteration that load_state resets to 0"
    else
        pass "$status: does not promise a resumed iteration count"
    fi
done

# Positive control: `interrupted` MUST still promise the pick-up, or the
# assertion above would pass on an implementation that dropped it everywhere.
dir="$(mk_state "iter_interrupted" "interrupted")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if printf '%s' "$out" | grep -q 'picks up from iteration'; then
    pass "interrupted: still promises the pick-up (it genuinely resumes)"
else
    fail "interrupted lost its pick-up line; the assertion above was vacuous"
fi

# --- THE OVER-CORRECTION: a VERDICT status must still refuse ------------------
# council_approved routes to `loki ship`. If the hint helper ever accepts it,
# an approved build gets invited back into the iteration loop.
for status in council_approved council_force_approved completion_promise_fulfilled; do
    dir="$(mk_state "verdict_$status" "$status")"
    out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
    if printf '%s' "$out" | grep -q "$DEAD_END"; then
        pass "$status: resume correctly refuses (it routes to loki ship)"
    else
        fail "$status: resume offered to continue an APPROVED build -- worse than silence"
    fi
done

# --- A stale spec path must not produce a command that fails on paste ---------
dir="$(mk_state "stale_prd" "max_iterations_reached" "/nonexistent/definitely-gone.md")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if printf '%s' "$out" | grep -q 'definitely-gone.md'; then
    fail "a stale prdPath was interpolated; the printed command fails on paste"
else
    pass "a stale prdPath degrades to bare 'loki start'"
fi

# A LIVE spec path must still be interpolated, or the command resumes a
# different run than the one being reported. This is the positive control for
# the assertion above: without it, a helper that never interpolates would pass.
mkdir -p "$WORK/live_prd"
printf 'spec\n' > "$WORK/live_prd/spec.md"
dir="$(mk_state "live_prd" "max_iterations_reached" "$WORK/live_prd/spec.md")"
out="$(cd "$dir" && LOKI_LEGACY_BASH=1 bash "$LOKI_BIN" resume 2>&1)"
if printf '%s' "$out" | grep -q 'spec.md'; then
    pass "a live prdPath is interpolated into the resume command"
else
    fail "a live prdPath was dropped; the command would resume a different run"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
