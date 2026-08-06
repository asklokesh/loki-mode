#!/usr/bin/env bash
# The verification-cost page must stay true, not just exist.
#
# WHY THIS TEST EXISTS. docs/VERIFICATION-COST.md publishes what our verification
# costs and what it does NOT prove. A limits page that rots is worse than no
# limits page: it converts an honest disclosure into a stale claim, and nobody
# notices because nothing checks prose.
#
# The precedent is our own. We shipped a "non-forgeable" claim, later found it
# false on the unsigned path, and removed it in v7.111.0. That is exactly the
# failure this guards -- a true statement that quietly stopped being true.
#
# So these assertions check the LOAD-BEARING admissions specifically. Each one is
# a limit a competitor's marketing would omit, and each is the kind of sentence
# that gets softened during a rewrite by someone who means well.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOC="$REPO_ROOT/docs/VERIFICATION-COST.md"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the verification-cost page stays honest"

[ -f "$DOC" ] || { echo "  FAIL: $DOC missing"; exit 1; }

# --- 1. The admissions that a rewrite would soften first --------------------
if grep -qi "unsigned receipt path is forgeable" "$DOC"; then
    ok "the forgeability of the unsigned path is stated"
else
    bad "the unsigned-path forgeability admission was removed"
fi
if grep -qiE "four of the eight quality gates are agent-independent" "$DOC"; then
    ok "the agent-independent gate count is stated"
else
    bad "the 4-of-8 agent-independence admission was removed"
fi
if grep -qi "cannot prove the spec was right" "$DOC"; then
    ok "the structural limit (a right gate on a wrong spec) is stated"
else
    bad "the spec-was-wrong limit was removed"
fi
if grep -qi "not air-gapped" "$DOC"; then
    ok "generation is disclosed as not air-gapped"
else
    bad "the air-gap disclosure was removed"
fi
if grep -qiE "no independent benchmark placement|no enterprise case studies" "$DOC"; then
    ok "the absence of benchmarks and case studies is stated"
else
    bad "the missing-evidence admission was removed"
fi

# --- 2. Costs are named, not hand-waved -------------------------------------
# "fast" is a claim. "23 to 26 minutes" is a number a reader can falsify.
if grep -qE "2[0-9] (to|-) ?2[0-9] minutes|23 to 26 minutes" "$DOC"; then
    ok "the FULL gate cost is a specific number"
else
    bad "the gate cost was replaced with a vague claim"
fi
if grep -qi "we do not offer a mode that makes that free" "$DOC"; then
    ok "the page refuses to promise a zero-cost verification"
else
    bad "the zero-cost refusal was removed -- that promise is the failure mode 8090 named"
fi

# --- 3. The UNKNOWN admission on our OWN data -------------------------------
# The most uncomfortable number on the page, and the most persuasive.
if grep -qE "0 of 9 receipts are anchored" "$DOC"; then
    ok "the page admits 0 of 9 of our own receipts are measurable"
else
    bad "the self-critical anchoring number was removed or softened"
fi

# --- 4. Every published command must actually exist -------------------------
# A limits page whose verification commands do not run is itself unverifiable.
MISSING=0
for c in "scripts/local-ci.sh" "tests/test-competitor-verify-surface.sh"; do
    [ -f "$REPO_ROOT/$c" ] || { echo "    missing: $c"; MISSING=$((MISSING+1)); }
done
if [ "$MISSING" = "0" ]; then
    ok "every script the page tells you to run exists"
else
    bad "$MISSING referenced script(s) do not exist"
fi
# The signed-receipts doc it points at for non-forgeability must be real.
if [ -f "$REPO_ROOT/docs/SIGNED-RECEIPTS.md" ]; then
    ok "the signed-receipts reference resolves"
else
    bad "the page points at a signed-receipts doc that does not exist"
fi

# --- 5. The refusals stay listed --------------------------------------------
# These are the four things a competitor would ship and we will not. If they
# vanish from the page, they will reappear in the product.
for refusal in "semantic fidelity score" "composite trust score" "readiness percentage"; do
    if grep -qi "$refusal" "$DOC"; then
        ok "the refusal to build a $refusal is on record"
    else
        bad "the refusal to build a $refusal was dropped"
    fi
done

# --- 6. House style ---------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$DOC" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
