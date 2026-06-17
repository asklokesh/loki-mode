#!/usr/bin/env bash
# tests/test-council-da-veto.sh -- regression guard for the anti-sycophancy
# (devil's-advocate) override in autonomy/completion-council.sh:council_vote().
#
# WHAT THIS GUARDS
#   council_vote() runs N members; on a UNANIMOUS APPROVE it convenes a devil's
#   advocate (DA). If the DA does NOT return a clean canonical "VOTE: APPROVE",
#   the round MUST be forced to CONTINUE (return 1) and recorded as REJECTED.
#
#   THE BUG (fixed): the veto path did `approve_count=$((approve_count - 1))`.
#   The completion threshold is ceil(2/3 * COUNCIL_SIZE). For the DEFAULT
#   COUNCIL_SIZE=3 the threshold is 2, and a unanimous 3 decremented by 1 is
#   still 2 >= 2, so council_vote returned 0 (DONE) anyway -- the entire
#   anti-sycophancy check was a silent no-op for every council of size >= 3
#   (it only happened to work for a size-2 council). The fix drives approve_count
#   to threshold-1 on a veto so the decision returns CONTINUE.
#
# HOW WE TEST IT
#   Extract _council_parse_vote() (real, pure) and council_vote() (real) from the
#   source via awk -- the exact extract-the-function style used by
#   tests/test-approval-phase-gate.sh -- then stub every collaborator so we drive
#   the votes deterministically:
#     - council_member_review prints "VOTE: APPROVE" for every member -> unanimous
#     - council_devils_advocate prints a NON-confirming verdict ("VOTE: REJECT")
#   We assert the function returns 1 (CONTINUE) and the recorded state.json
#   verdict is REJECTED, at the DEFAULT COUNCIL_SIZE=3 (the size the bug hit).
#
#   NON-VACUITY: a second arm runs the SAME harness but with a DA that DOES
#   confirm ("VOTE: APPROVE"); that arm must return 0 (DONE) / APPROVED. If the
#   extraction silently failed (empty function), both arms would behave
#   identically and the contrast assertion below would catch it.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
SRC="${LOKI_COUNCIL_SH_OVERRIDE:-$REPO_ROOT/autonomy/completion-council.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; council_vote records state via python3. (Not a fail.)"; exit 0
fi
if [ ! -f "$SRC" ]; then
    echo "SKIP: $SRC not found. (Not a fail.)"; exit 0
fi

# Extract the two real functions under test.
PARSE_FN="$(awk '/^_council_parse_vote\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$SRC" 2>/dev/null || true)"
VOTE_FN="$(awk '/^council_vote\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$SRC" 2>/dev/null || true)"
if [ -z "$PARSE_FN" ] || [ -z "$VOTE_FN" ]; then
    echo "SKIP: could not extract _council_parse_vote/council_vote from source. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-council-da-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# run_round <da_verdict>  -> echoes "<rc>|<recorded_result>"
# Each call runs in a fresh subshell so the eval'd functions/stubs don't leak.
run_round() {
    local da_verdict="$1"
    local state_dir="$WORK/state-$RANDOM"
    mkdir -p "$state_dir/votes"
    (
        set -uo pipefail
        # --- config the function reads (defaults mirror the source) ---
        COUNCIL_SIZE=3
        COUNCIL_STATE_DIR="$state_dir"
        COUNCIL_SEVERITY_THRESHOLD="low"   # disable error-budget override path
        COUNCIL_ERROR_BUDGET="0.0"
        ITERATION_COUNT=7
        TARGET_DIR="$state_dir"
        COUNCIL_PRD_PATH=""
        LOKI_COUNCIL_VERSION=1

        # --- stub every collaborator council_vote calls ---
        log_header() { :; }
        log_info()   { :; }
        log_warn()   { :; }
        log_error()  { :; }
        log_debug()  { :; }
        emit_event_json() { :; }
        council_gather_evidence() { printf '' > "$1" 2>/dev/null || true; }
        # Unanimous APPROVE from every member.
        council_member_review() { printf 'VOTE: APPROVE\nREASON: looks done\n'; }
        # The devil's advocate verdict is the variable under test.
        council_devils_advocate() { printf '%s\n' "$DA_VERDICT"; }
        council_write_transcript() { :; }

        export DA_VERDICT="$da_verdict"

        eval "$PARSE_FN"
        eval "$VOTE_FN"

        council_vote >/dev/null 2>&1
        rc=$?

        # Read back the recorded verdict from state.json.
        local result="MISSING"
        if [ -f "$state_dir/state.json" ]; then
            result=$(_SF="$state_dir/state.json" python3 -c "
import json, os
d = json.load(open(os.environ['_SF']))
v = d.get('verdicts', [])
print(v[-1]['result'] if v else 'NOVERDICT')
" 2>/dev/null || echo "PARSEERR")
        fi
        printf '%s|%s\n' "$rc" "$result"
    )
}

# --- Arm 1: DA does NOT confirm -> MUST be vetoed to CONTINUE/REJECTED ---
out_veto="$(run_round 'VOTE: REJECT')"
rc_veto="${out_veto%%|*}"
res_veto="${out_veto##*|}"

if [ "$rc_veto" = "1" ]; then
    ok "DA veto forces CONTINUE (council_vote returns 1) at COUNCIL_SIZE=3"
else
    bad "DA veto forces CONTINUE" "expected rc=1, got rc=$rc_veto (THE BUG: -1 decrement left approve at threshold)"
fi
if [ "$res_veto" = "REJECTED" ]; then
    ok "DA veto recorded as REJECTED in state.json"
else
    bad "DA veto recorded as REJECTED" "expected REJECTED, got '$res_veto'"
fi

# --- Arm 2 (non-vacuity contrast): DA confirms -> DONE/APPROVED ---
out_ok="$(run_round 'VOTE: APPROVE')"
rc_ok="${out_ok%%|*}"
res_ok="${out_ok##*|}"

if [ "$rc_ok" = "0" ]; then
    ok "DA confirmation allows DONE (council_vote returns 0)"
else
    bad "DA confirmation allows DONE" "expected rc=0, got rc=$rc_ok"
fi
if [ "$res_ok" = "APPROVED" ]; then
    ok "DA confirmation recorded as APPROVED in state.json"
else
    bad "DA confirmation recorded as APPROVED" "expected APPROVED, got '$res_ok'"
fi

# Contrast guard: the two arms MUST differ. If they are identical the harness is
# vacuous (e.g. extraction produced an inert function) and the veto assertion
# above proves nothing.
if [ "$out_veto" != "$out_ok" ]; then
    ok "non-vacuity: veto and confirm arms produce different outcomes ($out_veto vs $out_ok)"
else
    bad "non-vacuity: veto and confirm arms differ" "both produced '$out_veto'"
fi

echo "----------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
