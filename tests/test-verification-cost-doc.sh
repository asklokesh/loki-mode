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

# --- 5b. The competitive section refuses the claim it cannot support --------
#
# A goal was set to be "2-10x better than factory.ai, devin, 8090, replit".
# None of those four has a runnable local arm (verified: droid/devin/replit are
# not installed; claude/aider/codex/loki are), so no such benchmark exists. The
# doc must SAY that. A section that quietly omitted it would read as though the
# comparison had been done and merely not printed, which is how an unearned
# multiplier gets laundered into a spec sheet.
#
# THIS IS THE LOAD-BEARING ASSERTION OF THIS FILE. Every other check guards a
# number we published; this one guards a number we refused to publish.
if grep -q "no \"2-10x vs Factory/Devin/8090/Replit\" number here" "$DOC"; then
    ok "the doc explicitly refuses the unmeasurable multiplier"
else
    bad "the doc does not state that the headline comparison was NOT measured"
fi
if grep -q "NOT installed" "$DOC"; then
    ok "the doc shows WHICH competitors have no runnable arm"
else
    bad "the doc asserts the competitors are unbenchmarkable without showing it"
fi
# The measurable claim must be present AND scoped to what it actually checks.
if grep -q "0 expose an output-verification command" "$DOC"; then
    ok "the measurable claim (verify-surface count) is recorded"
else
    bad "the verify-surface measurement is missing"
fi
if grep -q "check for a COMMAND, not for internal" "$DOC"; then
    ok "the verify-surface claim states its own limit (a CLI check, not proof of absence)"
else
    bad "the verify-surface count is published without its limit"
fi
# Every competitor quote must carry the file it came from, or it is hearsay.
for src in "docs.factory.ai_missions_overview.md" "docs.devin.ai_admin_security.md" "www.8090.ai_terms-of-service.md"; do
    if grep -q "$src" "$DOC"; then
        ok "a competitor quote cites its source file ($src)"
    else
        bad "a competitor claim has no source path ($src) -- unverifiable"
    fi
done

# --- 5c. The benchmark section keeps its UNFAVOURABLE result ----------------
#
# The measured harness comparison contains one result that makes us look bad:
# on hard-1-order-api the harness bought nothing and cost ~2.9x more. That line
# is the reason the rest of the table is credible, and it is the first thing a
# later edit would quietly drop.
#
# THIS IS THE LOAD-BEARING ASSERTION HERE. A benchmark table that only survives
# its favourable rows is an advertisement.
# Matched on the PROPERTY (a row where the harness cost more for no gain), not
# on one sentence. The first version keyed on the literal phrase "the harness
# bought nothing" and fired on my own edit -- one that ADDED a second
# unfavourable task and reworded the first. A guard that breaks when the thing
# it protects gets stronger is measuring the wording, not the honesty.
if grep -qE "harness cost [0-9.]+x for nothing|harness bought nothing" "$DOC"; then
    ok "the benchmark keeps at least one task where the harness did NOT help"
else
    bad "no unfavourable benchmark row remains -- the table is now an advertisement"
fi
# And the losing rows must not be outnumbered into invisibility: state the split.
if grep -q "UNFAVOURABLE to the harness" "$DOC"; then
    ok "the doc states how many paired tasks went against us"
else
    bad "the unfavourable tasks are present but their weight is not stated"
fi
# Cells that produced NO data must be named as absent, never as losses.
# Counting a timed-out baseline as a baseline failure would flatter the harness
# on data that does not exist -- the most tempting omission in this whole file,
# because the missing cells are the ones that would have helped us.
if grep -q "produced NO data" "$DOC" && grep -q "not evidence the raw model cannot do the task" "$DOC"; then
    ok "attempted-but-unmeasured cells are recorded as absent, not as losses"
else
    bad "the unmeasured baseline cells were dropped or counted as failures"
fi
# Sample sizes must travel with the numbers, or n=1 reads like n=100.
if grep -q "n=1" "$DOC"; then
    ok "weak sample sizes are stated inline"
else
    bad "the benchmark reports rates without exposing small-n cells"
fi
# The baseline arm must not be labelled as a competitor product.
if grep -q "NOT a\s*measurement of Replit" "$DOC" || grep -q "NOT a" "$DOC"; then
    ok "the baseline arm is explicitly not claimed as a competitor measurement"
else
    bad "the baseline config is presented as if it measured a real competitor"
fi
# The spend interlock must stay documented: a paid benchmark that runs without
# an explicit opt-in is how a surprise bill happens.
if grep -q "LOKI_BENCH_SPEND_APPROVED" "$DOC"; then
    ok "the reproduce command names the spend interlock"
else
    bad "the reproduce instructions omit that this costs money"
fi
# The live exclusion is the strongest evidence in this document that the
# numbers are not curated: a trial the GRADER passed was still thrown out
# because the run did not finish. Dropping it would leave only self-reported
# wins, which is the shape of every benchmark nobody believes.
if grep -q "measured: false" "$DOC" && grep -q "NOT evidence that a run happened" "$DOC"; then
    ok "the live false-green exclusion is recorded with the harness's own words"
else
    bad "the observed exclusion was dropped -- the table loses its strongest honesty signal"
fi
if grep -q "stayed at n=3 instead of being inflated to n=4" "$DOC"; then
    ok "the doc states which number the exclusion made SMALLER"
else
    bad "the exclusion is described without saying what it cost us"
fi

# --- 6. House style ---------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$DOC" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
