#!/usr/bin/env bash
# What `loki steer` tells you to set must be what the runner accepts.
#
# THE DEFECT. `loki steer "..."` prints, verbatim:
#     Enable it: export LOKI_PROMPT_INJECTION=1 (then the next iteration
#     ingests the note).
# and when the variable is set it prints "The next iteration will read and
# apply it."
#
# The runner tested `!= "true"` only. So a user who followed that instruction
# EXACTLY -- exported 1, steered, saw a green success line -- had the note moved
# to .loki/logs/human-input-REJECTED-*.md and never read. The CLI reported
# success; the runner silently discarded it; and the only warning went to the
# runner's log rather than to the person who typed the command.
#
# This is a false green in the steering path, which is the one channel a user
# has for correcting a run in flight. Factory's release history is blunt about
# why that matters: their last ~40 releases are disproportionately about
# steering, not capability, because at long horizons the binding constraint is
# the user's ability to intervene without destroying the run.
#
# TEST 3 IS THE LOAD-BEARING ONE. The fix must NOT weaken the default. Prompt
# injection is off unless explicitly enabled, deliberately -- an unset or
# "false" value must still reject, or a security default becomes a security
# hole while looking like a usability fix.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the steer flag the CLI advertises is the one the runner honours"

[ -f "$RUN_SH" ] || { echo "  FAIL: $RUN_SH missing"; exit 1; }

# Extract the REAL guard from run.sh so this cannot drift from the source.
_guard="$(grep -n 'LOKI_PROMPT_INJECTION' "$RUN_SH" | grep -E '!=' | head -1 | cut -d: -f2-)"
[ -n "$_guard" ] || { echo "  FAIL: could not find the injection guard in run.sh"; exit 1; }

# Evaluates the extracted condition: true => the note is REJECTED.
_rejects() {
    LOKI_PROMPT_INJECTION="$1" bash -c "
        if ${_guard#*if }
            exit 0   # rejected
        fi
        exit 1       # accepted
    " 2>/dev/null
}

# --- 1. THE DEFECT: the documented form must be accepted --------------------
if _rejects "1"; then
    bad "LOKI_PROMPT_INJECTION=1 is REJECTED, but that is exactly what loki steer tells users to export"
else
    ok "LOKI_PROMPT_INJECTION=1 is accepted (matches what the CLI advertises)"
fi

# --- 2. The other truthy form keeps working ---------------------------------
if _rejects "true"; then
    bad "LOKI_PROMPT_INJECTION=true is rejected -- the original form regressed"
else
    ok "LOKI_PROMPT_INJECTION=true still accepted"
fi

# --- 3. THE GUARD: the security default must NOT weaken ---------------------
# Injection is off unless explicitly enabled. If a usability fix makes unset or
# "false" accept, a deliberate security default silently becomes a hole.
for v in "" "false" "0" "no" "TRUEISH"; do
    if _rejects "$v"; then
        ok "'${v:-<unset>}' still rejects (security default intact)"
    else
        bad "'${v:-<unset>}' now ACCEPTS injection -- the default was weakened"
    fi
done

# --- 4. The CLI and the runner agree, in both directions --------------------
# The actual bug was a mismatch, so assert the pair rather than each side alone.
_cli_says_1="$(grep -c 'LOKI_PROMPT_INJECTION=1' "$LOKI" || true)"
if [ "${_cli_says_1:-0}" -gt 0 ]; then
    if _rejects "1"; then
        bad "the CLI advertises =1 and the runner rejects it (the original defect)"
    else
        ok "the CLI advertises =1 and the runner honours it"
    fi
else
    ok "the CLI no longer advertises =1 (no mismatch to guard)"
fi

# --- 5. loki steer warns when injection is off ------------------------------
# A green "written" line alone would be a false green: the file is written and
# then discarded unread.
_steer="$(sed -n '/^cmd_steer()/,/^}/p' "$LOKI")"
if printf '%s' "$_steer" | grep -q "prompt injection is OFF"; then
    ok "loki steer warns when the loop will not read the note"
else
    bad "loki steer reports success without saying the note will be discarded"
fi

# --- 6. A rejected note is preserved, not deleted ---------------------------
# If the runner drops the note it must still be recoverable; silently deleting
# a user's directive is worse than ignoring it.
if grep -q "human-input-REJECTED" "$RUN_SH"; then
    ok "a rejected note is moved to a REJECTED log, not destroyed"
else
    bad "a rejected steering note is deleted outright"
fi

# --- 7. Syntax --------------------------------------------------------------
bash -n "$RUN_SH" 2>/dev/null && ok "run.sh parses" || bad "run.sh has a syntax error"
bash -n "$LOKI" 2>/dev/null && ok "autonomy/loki parses" || bad "autonomy/loki has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
