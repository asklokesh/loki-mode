#!/usr/bin/env bash
# Test: every terminal outcome tells the user what to do next.
#
# THE PROBLEM (measured on the PRD benchmark, 2026-07-28)
#   COMPLETION.txt's next-step guidance was reachable only when
#   files_changed == 0 AND outcome was complete|max_iterations. A run that ends
#   `intervention`, `failed`, `stopped`, `force_stopped`, or
#   `inconclusive_spec_contradiction` fell through and got nothing -- exactly the
#   outcomes where a user is stuck and most needs a next step.
#
#   The nesting made it worse than it looks. Fixing the greenfield file count
#   (a run that built 9 files now reports 9, not 0) means such a run no longer
#   enters the files_changed==0 branch AT ALL. Guidance keyed on an empty diff
#   would therefore be silent for precisely the run that motivated it: the PRD
#   build that produced 9 files, passed 28/28 tests, stopped on a gate, and told
#   the user nothing.
#
#   So the per-outcome guidance must be INDEPENDENT of the file count.
#
# Proven directions:
#   POSITIVE  : each non-complete outcome emits guidance naming a concrete next
#               command. RED before the fix (nothing was emitted).
#   GATE      : when a GATE_ESCALATION signal exists, `intervention` names the
#               blocking gate rather than a generic pointer.
#   DEGRADE   : with no signal (or a corrupt one), it still emits guidance --
#               just the generic form. It must never abort or go silent.
#   INDEPENDENT: guidance fires when files_changed is NON-zero, which is the
#               regression the greenfield fix would otherwise have introduced.
#   NO-VERDICT: this is a reporting change. It must not alter any outcome value.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-outguide-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== per-outcome next-step guidance ==="

# Extract the REAL helper + the REAL case block from run.sh. Testing a mirror
# would not catch a wrong variable name in the source.
HELPER="$TMP/helper.sh"
python3 - "$RUN_SH" > "$HELPER" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
st = s.index("_loki_summary_gate_reason() {")
en = s.index("\n}\n", st) + 3
sys.stdout.write(s[st:en])
PYEOF

GUIDE="$TMP/guide.sh"
python3 - "$RUN_SH" > "$GUIDE" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
marker = "        # Per-outcome next step."
st = s.index(marker)
en = s.index("\n        esac\n", st) + len("\n        esac\n")
sys.stdout.write(s[st:en])
PYEOF

if [ ! -s "$HELPER" ] || [ ! -s "$GUIDE" ]; then
    bad "could not extract the helper or the guidance block from run.sh"
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi
ok "extracted the real helper and guidance block from run.sh"

# Drive the extracted block for one outcome.
render() {
    local outcome="$1" loki_dir="$2"
    {
        echo 'set -u'
        cat "$HELPER"
        printf 'outcome=%q\n' "$outcome"
        printf 'loki_dir=%q\n' "$loki_dir"
        cat "$GUIDE"
    } > "$TMP/drive.sh"
    bash "$TMP/drive.sh" 2>/dev/null || true
}

# Fixture WITH a gate escalation signal.
GD="$TMP/withgate"
mkdir -p "$GD/signals"
printf 'ESCALATE\n' > "$GD/signals/GATE_ESCALATION"
cat > "$GD/signals/GATE_ESCALATION.json" <<'JSON'
{"action":"escalate","gate":"code_review","count":3,"threshold":3}
JSON

# Fixture with NO signal.
ND="$TMP/nogate"
mkdir -p "$ND/signals"

# ---- POSITIVE: every non-complete outcome says something -------------------
for o in intervention failed stopped force_stopped inconclusive_spec_contradiction; do
    out="$(render "$o" "$ND")"
    if [ -n "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
        ok "outcome '$o' emits next-step guidance"
    else
        bad "outcome '$o' emits NOTHING (user is left with no next step)"
    fi
done

# ---- Guidance must name a runnable command, not just prose ----------------
out="$(render intervention "$ND")"
if printf '%s' "$out" | grep -qE '\.loki/(PAUSE|STOP)'; then
    ok "intervention guidance names concrete resume/stop actions"
else
    bad "intervention guidance has no actionable command"
fi
out="$(render failed "$ND")"
if printf '%s' "$out" | grep -q 'loki why'; then
    ok "failed guidance points at 'loki why'"
else
    bad "failed guidance does not point at a diagnostic command"
fi

# ---- GATE: with a signal, intervention names the blocking gate ------------
out="$(render intervention "$GD")"
if printf '%s' "$out" | grep -q 'code_review (failed 3 times, threshold 3)'; then
    ok "intervention names the blocking gate when the signal exists"
else
    bad "intervention did not name the gate despite a GATE_ESCALATION signal"
fi

# ---- DEGRADE: corrupt signal still yields guidance, never a crash ---------
BD="$TMP/badgate"
mkdir -p "$BD/signals"
printf 'ESCALATE\n' > "$BD/signals/GATE_ESCALATION"
printf 'not json {{{\n'  > "$BD/signals/GATE_ESCALATION.json"
out="$(render intervention "$BD")"
if [ -n "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
    ok "corrupt gate signal degrades to generic guidance (no crash, no silence)"
else
    bad "corrupt gate signal produced no guidance at all"
fi

# ---- INDEPENDENT: guidance is NOT nested under files_changed==0 -----------
# The regression the greenfield fix would otherwise cause. Assert on structure:
# the per-outcome case must not sit inside the empty-diff case.
if grep -q '# Per-outcome next step' "$RUN_SH"; then
    # The guidance block must appear AFTER the closing esac of the files_changed case.
    _fc_line="$(grep -n 'case "\$files_changed" in' "$RUN_SH" | head -1 | cut -d: -f1)"
    _pg_line="$(grep -n '# Per-outcome next step' "$RUN_SH" | head -1 | cut -d: -f1)"
    _esac_line="$(awk -v s="$_fc_line" 'NR>s && /^        esac$/{print NR; exit}' "$RUN_SH")"
    if [ -n "$_esac_line" ] && [ "$_pg_line" -gt "$_esac_line" ]; then
        ok "per-outcome guidance sits OUTSIDE the files_changed==0 branch"
    else
        bad "guidance is nested under files_changed==0 -- silent for runs that built files"
    fi
else
    bad "run.sh has no per-outcome guidance block"
fi

# ---- NO-VERDICT: the block must not assign an outcome --------------------
if grep -A40 '# Per-outcome next step' "$RUN_SH" | grep -qE '^\s*outcome='; then
    bad "the guidance block assigns outcome= (reporting must not change verdicts)"
else
    ok "guidance block never assigns an outcome (reporting only)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
