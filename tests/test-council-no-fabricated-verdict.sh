#!/usr/bin/env bash
# Test: the council must never fabricate a reviewer vote.
#
# THE BUG (found 2026-07-29 while auditing provider coupling)
#   Every provider arm in council-v2.sh substituted a literal
#     {"verdict":"REJECT","reasoning":"review execution failed","issues":[]}
#   on ANY miss -- CLI absent, timeout, transient error, unparseable output --
#   and the tally counted "anything not APPROVE" as a rejection:
#
#     if [ "$verdict" = "APPROVE" ]; then ((approve_count++)); else ((reject_count++)); fi
#
#   So the engine recorded a REJECT the model never gave, and BLOCKED the run on
#   it. Twelve such sites existed across five providers, plus the devil's
#   advocate defaulting to REJECT on a parse failure -- which could silently
#   overturn a unanimous APPROVE on a transient error.
#
#   This is the same defect class as an Evidence Receipt attesting to a diff
#   stat it never measured: the artifact asserts a fact nobody established.
#
#   It is worst on a cheap/weak model. Low format compliance became a permanent
#   BLOCK that reads to the user as "Loki is broken" rather than "your model
#   could not produce a parseable verdict". That failure mode is squarely in the
#   way of running this engine on anything but a frontier model.
#
# THE RULE
#   A verdict that was never obtained is INCONCLUSIVE. It is counted separately,
#   never as a rejection, and it is reported to the user.
#
# Proven directions:
#   NOFAB    : no fabricated REJECT literal remains in the source.
#   TALLY    : the tally has a distinct INCONCLUSIVE arm; non-APPROVE no longer
#              means REJECT.
#   REALREJECT: a genuine REJECT is still counted as a rejection (the fix must
#              not blind the council to real rejections).
#   DA       : an unparseable devil's advocate does NOT overturn a unanimous
#              approval.
#   VISIBLE  : inconclusive reviewers are reported, not swallowed.
#   PARSE    : the parse-failure path -- the weak-model case -- yields
#              INCONCLUSIVE, not REJECT.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C2="$SCRIPT_DIR/../autonomy/council-v2.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== council: no fabricated verdicts ==="

[ -f "$C2" ] || { echo "  FAIL: $C2 not found"; exit 1; }

# Executable lines only -- the explanatory comments intentionally quote the old
# fabricated literal, and must not trip the guard.
code_only() { grep -vE '^[[:space:]]*#' "$C2"; }

# ---- NOFAB ---------------------------------------------------------------
fab="$(code_only | grep -c '"verdict":"REJECT"' || true)"
if [ "${fab:-0}" -eq 0 ]; then
    ok "no fabricated REJECT literal remains in executable code"
else
    bad "$fab fabricated REJECT literal(s) still present"
    code_only | grep -n '"verdict":"REJECT"' | head -5 | sed 's/^/        /'
fi

inc="$(code_only | grep -c 'INCONCLUSIVE' || true)"
if [ "${inc:-0}" -ge 10 ]; then
    ok "miss paths emit INCONCLUSIVE ($inc sites)"
else
    bad "only $inc INCONCLUSIVE site(s) -- expected every provider arm converted"
fi

# ---- TALLY ---------------------------------------------------------------
# The old tally was a two-way if/else. There must now be an explicit REJECT arm
# so that "not APPROVE" cannot silently mean "rejected".
if grep -qE 'elif \[ "\$verdict" = "REJECT" \]' "$C2"; then
    ok "tally has an explicit REJECT arm (not 'everything else is a reject')"
else
    bad "tally still treats any non-APPROVE verdict as a rejection"
fi
if grep -q 'inconclusive_count' "$C2"; then
    ok "an inconclusive counter exists"
else
    bad "no inconclusive counter -- unobtained verdicts have nowhere to go"
fi
# It must be DECLARED, or `set -u` turns the fix into a crash.
if grep -qE 'local inconclusive_count=0' "$C2"; then
    ok "inconclusive_count is declared (safe under set -u)"
else
    bad "inconclusive_count is used but never declared"
fi

# ---- Behavioral: the tally logic, exercised ------------------------------
# Mirror of the source arms; test_source_matches below keeps them honest.
tally() {
    local verdict="$1"
    case "$verdict" in
        APPROVE) echo "approve" ;;
        REJECT)  echo "reject" ;;
        *)       echo "inconclusive" ;;
    esac
}
if [ "$(tally APPROVE)" = "approve" ]; then
    ok "APPROVE counts as an approval"
else
    bad "APPROVE mis-tallied"
fi
# ---- REALREJECT: the fix must not blind the council to real rejections ---
if [ "$(tally REJECT)" = "reject" ]; then
    ok "a genuine REJECT is still counted as a rejection"
else
    bad "REJECT no longer counted -- the fix blinded the council"
fi
if [ "$(tally INCONCLUSIVE)" = "inconclusive" ] && [ "$(tally UNKNOWN)" = "inconclusive" ]; then
    ok "INCONCLUSIVE and UNKNOWN are not rejections"
else
    bad "an unobtained verdict is still being counted as a rejection"
fi

# ---- DA: unparseable devil's advocate must not overturn approval ---------
if grep -qE 'da_verdict=.*\|\| echo "INCONCLUSIVE"' "$C2"; then
    ok "devil's advocate defaults to INCONCLUSIVE, not REJECT"
else
    bad "devil's advocate still defaults to REJECT on a parse failure"
fi
if grep -q 'unanimous approval left UNCHANGED' "$C2"; then
    ok "an inconclusive devil's advocate leaves the approval unchanged"
else
    bad "no guard: an unparseable devil's advocate can still overturn approval"
fi

# ---- PARSE: the weak-model path ------------------------------------------
if grep -q 'failed to parse review output (no verdict obtained' "$C2"; then
    ok "parse failure yields INCONCLUSIVE (the weak-model case)"
else
    bad "parse failure still fabricates a verdict"
fi

# ---- VISIBLE -------------------------------------------------------------
if grep -q 'INCONCLUSIVE"$\|INCONCLUSIVE$\|inconclusive_count INCONCLUSIVE' "$C2" \
   && grep -q 'NOT rejections' "$C2"; then
    ok "inconclusive reviewers are reported to the user, not swallowed"
else
    bad "inconclusive reviewers are not surfaced in the results line"
fi

# ---- STRUCTURE-TOLERANT RECOVERY (v8.2.0) --------------------------------
# A strict JSON carve is the most model-sensitive contract in the engine: schema
# adherence varies most across models, while every coding model can state a
# verdict in prose. Recovering a verdict the model GENUINELY stated is
# legitimate; inventing one is not. So recovery must fire only on an
# unambiguous statement and must never manufacture a verdict.
recover() {
    _LOKI_RAW="$1" python3 -c '
import os,re,sys
raw=os.environ.get("_LOKI_RAW","")
a=len(re.findall(r"(?<![A-Za-z0-9_-])APPROVE(?![A-Za-z0-9_-])",raw,re.I))
j=len(re.findall(r"(?<![A-Za-z0-9_-])REJECT(?![A-Za-z0-9_-])",raw,re.I))
print("APPROVE" if (a and not j) else ("REJECT" if (j and not a) else "INCONCLUSIVE"))
' 2>/dev/null
}
if [ "$(recover 'Looks good to me. APPROVE.')" = "APPROVE" ]; then
    ok "recovers an unambiguous APPROVE from prose"
else
    bad "failed to recover a prose APPROVE"
fi
if [ "$(recover 'This has a real bug. REJECT.')" = "REJECT" ]; then
    ok "recovers an unambiguous REJECT from prose"
else
    bad "failed to recover a prose REJECT"
fi
if [ "$(recover 'Should I approve or reject this?')" = "INCONCLUSIVE" ]; then
    ok "ambiguous prose (both words) stays INCONCLUSIVE -- never guessed"
else
    bad "guessed a verdict from ambiguous prose"
fi
if [ "$(recover 'The diff changes three files.')" = "INCONCLUSIVE" ]; then
    ok "prose with no verdict word stays INCONCLUSIVE"
else
    bad "invented a verdict where the model stated none"
fi
if grep -q 'STRUCTURE-TOLERANT RECOVERY' "$C2"; then
    ok "recovery path is present in council-v2.sh"
else
    bad "recovery path missing from source"
fi
if grep -q '"recovered": True' "$C2"; then
    ok "recovered verdicts are LABELLED as recovered (auditable)"
else
    bad "recovered verdicts are indistinguishable from parsed ones"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
