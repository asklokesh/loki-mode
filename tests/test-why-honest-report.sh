#!/usr/bin/env bash
# Test: `loki why` must not lie about a run it is asked to explain.
#
# WHY THIS MATTERS MORE THAN AN ORDINARY REPORT BUG
#   v8.0.1 shipped per-outcome guidance that points users at `loki why` after a
#   failure. So every defect below was reached by following our own advice.
#
# MEASURED on a preserved real run (9 files, 1300 insertions, paused on a gate):
#   Changes     : 0 files (+0/-0)          <- the run built 9 files
#   What to do  : Resume with: loki resume. <- the pause notice warns this
#                                             stops at the same gate again
#   ...and the blocking gate (code_review, 3 failures) was never named at all.
#
# Proven directions:
#   REDERIVE  : a recorded 0 with real commits present is re-derived from git,
#               never printed as a flat "0 files". RED before the fix.
#   GATE      : with a GATE_ESCALATION signal, the gate/count/threshold are
#               named and the action says to read the findings, not just resume.
#   RELATIVE  : the findings pointer is workspace-relative, so it resolves. The
#               recorded value is an absolute path from the build machine -- on
#               the preserved run it names a temp dir that no longer exists.
#   MAPPED    : inconclusive_spec_contradiction has a GUIDE entry instead of
#               "No diagnosis mapping for this status".
#   NO-NOISE  : a clean completed run with a real count is untouched -- the fix
#               must not add re-derivation noise where the record is already good.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-why-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== loki why: honest reporting ==="

# A run that committed real work but recorded files_changed: 0 -- the exact
# greenfield shape that produced the false "0 files" claim.
W="$TMP/run"
mkdir -p "$W/.loki/state" "$W/.loki/signals" "$W/.loki/quality/reviews/review-X"
git init -q "$W"
git -C "$W" config user.email t@t
git -C "$W" config user.name t
printf 'a\nb\nc\n' > "$W/server.js"
printf 'x\ny\n'     > "$W/store.js"
git -C "$W" add server.js store.js
git -C "$W" commit -qm build
cat > "$W/.loki/state/completion.json" <<'JSON'
{"outcome":"paused","files_changed":0,"insertions":0,"deletions":0,"branch":"loki/test"}
JSON
cat > "$W/.loki/signals/GATE_ESCALATION.json" <<JSON
{"action":"escalate","gate":"code_review","count":3,"threshold":3,
 "latest_artifact":"/nonexistent/machine/path/.loki/quality/reviews/review-X"}
JSON

out="$(cd "$W" && timeout 60 bash "$LOKI" why 2>&1 || true)"

# ---- REDERIVE ------------------------------------------------------------
if printf '%s' "$out" | grep -qE 'Changes.*0 files \(\+0/-0\)'; then
    bad "printed a flat '0 files' for a run with real commits"
elif printf '%s' "$out" | grep -qE 'Changes.*2 files changed'; then
    ok "re-derives the real diff when the record says 0"
else
    bad "Changes line unexpected: $(printf '%s' "$out" | grep -i 'Changes' | head -1)"
fi

# ---- GATE ----------------------------------------------------------------
if printf '%s' "$out" | grep -q 'code_review (failed 3 times, threshold 3)'; then
    ok "names the blocking gate, its count and threshold"
else
    bad "did not name the blocking gate despite a GATE_ESCALATION signal"
fi
if printf '%s' "$out" | grep -qi 'stop at the same gate again'; then
    ok "action warns that resuming unchanged repeats the block"
else
    bad "action does not warn about resuming unchanged"
fi

# ---- RELATIVE ------------------------------------------------------------
if printf '%s' "$out" | grep -q 'Findings: .loki/quality/reviews/review-X'; then
    ok "findings pointer is workspace-relative (resolves for the reader)"
elif printf '%s' "$out" | grep -q 'Findings: /nonexistent'; then
    bad "findings pointer is the build machine's absolute path (leads nowhere)"
else
    bad "no findings pointer emitted"
fi

# ---- MAPPED --------------------------------------------------------------
C="$TMP/contradiction"
mkdir -p "$C/.loki/state"
git init -q "$C"
printf '{"outcome":"inconclusive_spec_contradiction","files_changed":1}\n' \
    > "$C/.loki/state/completion.json"
cout="$(cd "$C" && timeout 60 bash "$LOKI" why 2>&1 || true)"
if printf '%s' "$cout" | grep -qi 'No diagnosis mapping'; then
    bad "inconclusive_spec_contradiction still has no GUIDE entry"
else
    ok "inconclusive_spec_contradiction has a real diagnosis"
fi
if printf '%s' "$cout" | grep -q 'assumptions/ledger.md'; then
    ok "points at the assumptions ledger where the contradictions are"
else
    bad "does not point at the ledger"
fi

# ---- NO-NOISE ------------------------------------------------------------
# A record with a real non-zero count must be printed as-is. The re-derivation
# path is a repair for an untrustworthy zero, not a replacement for good data.
G="$TMP/good"
mkdir -p "$G/.loki/state"
git init -q "$G"
printf '{"outcome":"complete","files_changed":3,"insertions":10,"deletions":0}\n' \
    > "$G/.loki/state/completion.json"
gout="$(cd "$G" && timeout 60 bash "$LOKI" why 2>&1 || true)"
if printf '%s' "$gout" | grep -qE 'Changes.*3 files \(\+10/-0\)'; then
    ok "a trustworthy non-zero record is printed unchanged (no added noise)"
else
    bad "clean record altered: $(printf '%s' "$gout" | grep -i 'Changes' | head -1)"
fi
if printf '%s' "$gout" | grep -q 'Blocked by'; then
    bad "invented a blocking gate with no GATE_ESCALATION signal present"
else
    ok "no gate signal -> no 'Blocked by' line invented"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
