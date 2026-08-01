#!/usr/bin/env bash
# The iteration cap must consider evidence, and must still be a cap.
#
# The cap was a bare counter: it consulted no gate, no council, and no evidence.
# A run one step from finishing was cut off identically to a run thrashing in
# circles, and both reported the same terminal failure.
#
# An iteration count is a PROXY for "is this converging". Where real evidence
# exists on disk, prefer it: when the agent has requested completion AND no gate
# is failing, the run gets ONE extra iteration to land the work.
#
# THE PROPERTY THAT MATTERS MOST is that this cannot become an unbounded loop.
# Published measurements put automated-verifier false-negative rates near 24%,
# so a purely verifier-driven terminal would burn real money re-doing work that
# was already correct. The grace is therefore:
#   - granted at most ONCE per run (marker file)
#   - requires POSITIVE evidence, never the mere absence of a failure signal
#   - extends by exactly one iteration
#
# Case "grace is not granted twice" is the load-bearing assertion. If it ever
# goes green-by-accident, the cap has stopped being a cap.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: evidence-aware iteration cap"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-grace-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# NOTE: TARGET_DIR must be assigned AFTER sourcing run.sh -- sourcing sets it,
# so exporting it beforehand is silently overwritten (that cost a debug cycle).
probe() {
    local dir="$1" extra="${2:-}"
    bash -c "source '$REPO_ROOT/autonomy/run.sh' 2>/dev/null
             TARGET_DIR='$dir'; ITERATION_COUNT=5; MAX_ITERATIONS=5; $extra
             if check_max_iterations; then echo STOP; else echo \"CONTINUE:\$MAX_ITERATIONS\"; fi" \
        2>/dev/null | tail -1
}

mk() {
    local dir="$SCRATCH/$1"; shift
    rm -rf "$dir"; mkdir -p "$dir/.loki/state" "$dir/.loki/signals" "$dir/.loki/quality"
    for f in "$@"; do
        case "$f" in
            done)    touch "$dir/.loki/signals/COMPLETION_REQUESTED" ;;
            failing) echo "code_review," > "$dir/.loki/quality/gate-failures.txt" ;;
            empty_gate) : > "$dir/.loki/quality/gate-failures.txt" ;;
        esac
    done
    printf '%s' "$dir"
}

# --- 1. no evidence: the cap behaves exactly as before ------------------------
d="$(mk plain)"
[[ "$(probe "$d")" == STOP ]] \
    && ok "no completion signal: the cap still stops the run" \
    || ko "no completion signal: the cap still stops the run"

# --- 2. positive evidence earns exactly one more iteration --------------------
d="$(mk ready done)"
out="$(probe "$d")"
if [[ "$out" == "CONTINUE:6" ]]; then
    ok "agent reports done with clean gates: one extra iteration granted"
else
    ko "agent reports done with clean gates: one extra iteration granted" "got: $out"
fi

# --- 3. THE BOUND. The same run cannot be granted grace twice. ----------------
# $d already has the marker written by case 2.
if [[ "$(probe "$d")" == STOP ]]; then
    ok "grace is granted at most once per run"
else
    ko "grace is granted at most once per run" \
       "the cap is no longer a cap -- a run claiming done forever would never stop"
fi

# --- 4. a failing gate defeats the claim --------------------------------------
# "I am done" on top of a real gate failure is exactly what the cap should stop.
d="$(mk claims_done_but_broken done failing)"
[[ "$(probe "$d")" == STOP ]] \
    && ok "a failing gate overrides the agent's done claim" \
    || ko "a failing gate overrides the agent's done claim"

# --- 5. an EMPTY gate file is not a failure -----------------------------------
# Gate files are commonly touched empty; treating that as failure would make the
# grace unreachable in practice.
d="$(mk empty_gatefile done empty_gate)"
out="$(probe "$d")"
[[ "$out" == "CONTINUE:6" ]] \
    && ok "an empty gate-failures file does not block the grace" \
    || ko "an empty gate-failures file does not block the grace" "got: $out"

# --- 6. the opt-out restores the pure counter ---------------------------------
d="$(mk optout done)"
[[ "$(probe "$d" "LOKI_ITERATION_GRACE=0")" == STOP ]] \
    && ok "LOKI_ITERATION_GRACE=0 restores the pure counter" \
    || ko "LOKI_ITERATION_GRACE=0 restores the pure counter"

# --- 7. below the cap nothing changes -----------------------------------------
d="$(mk below done)"
out="$(bash -c "source '$REPO_ROOT/autonomy/run.sh' 2>/dev/null
                TARGET_DIR='$d'; ITERATION_COUNT=2; MAX_ITERATIONS=5
                if check_max_iterations; then echo STOP; else echo \"CONTINUE:\$MAX_ITERATIONS\"; fi" \
        2>/dev/null | tail -1)"
if [[ "$out" == "CONTINUE:5" ]]; then
    ok "below the cap the ceiling is untouched (no silent inflation)"
else
    ko "below the cap the ceiling is untouched (no silent inflation)" "got: $out"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
