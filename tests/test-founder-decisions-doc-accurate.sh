#!/usr/bin/env bash
# The open-decisions document must stay true to the code.
#
# docs/FOUNDER-DECISIONS-TRUST-SEMANTICS-2026-08-01.md records two trust-semantics
# questions that were deliberately NOT answered, each with the measurement that
# raised it. A decision document is read once, months later, by someone deciding
# on the strength of what it says -- so a claim that has quietly stopped being
# true is worse than no document at all.
#
# This asserts every load-bearing claim in it against the source. If someone
# ANSWERS one of the decisions, this test goes red and the document has to be
# updated to match, which is the correct outcome: the doc describes an open
# question, and closing it should not leave a stale record behind.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$REPO_ROOT/docs/FOUNDER-DECISIONS-TRUST-SEMANTICS-2026-08-01.md"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
VERIFY="$REPO_ROOT/autonomy/lib/proof-verify.py"
GEN_TESTS="$REPO_ROOT/tests/test_proof_generator.py"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: the founder-decisions document is accurate"

[[ -f "$DOC" ]] || { echo "  FAIL: decision document missing"; exit 1; }

# --- the document quotes source; those quotes must still exist ---------------
if grep -q "trust-semantics product decision (council + founder)" "$GEN"; then
    ok "the quoted record-first rule still exists in the generator"
else
    ko "the quoted record-first rule still exists in the generator" \
       "the document cites a comment that is no longer there"
fi

if grep -q "rather than inferring it from silence" "$GEN"; then
    ok "the quoted honesty-ledger rationale still exists"
else
    ko "the quoted honesty-ledger rationale still exists"
fi

if grep -q "Absence of a scan is not a security gap" "$GEN_TESTS"; then
    ok "the test the document cites still asserts that wording"
else
    ko "the test the document cites still asserts that wording" \
       "decision 2 may have been answered; update the document"
fi

# --- decision 1 is still OPEN: the headline must not move on a disabled gate --
# If this fails, someone decided. That is fine -- but the doc now lies.
probe_headline() {
    python3 - "$REPO_ROOT" <<'PY'
import importlib.util, json, os, sys
root = sys.argv[1]
def load(n, p):
    s = importlib.util.spec_from_file_location(n, p)
    m = importlib.util.module_from_spec(s)
    try:
        s.loader.exec_module(m)
    except SystemExit:
        pass
    return m
tpg = load("tpg", os.path.join(root, "tests", "test_proof_generator.py"))

class _H(tpg.IncludeDiffsTests):
    def runTest(self):
        pass

t = _H(); t.setUp()
proj = t._git_repo_with_change()
loki = os.path.join(proj, ".loki")
os.makedirs(os.path.join(loki, "quality"), exist_ok=True)
json.dump({"status": "verified", "command": "npm test", "exit_code": 0},
          open(os.path.join(loki, "quality", "test-results.json"), "w"))
json.dump({"ran": True, "status": "passed", "exit_code": 0},
          open(os.path.join(loki, "quality", "build-results.json"), "w"))
base = tpg._run_generator(loki, os.path.join(t.tmp, "a"),
                          env_extra={"_LOKI_RUN_START_SHA": "HEAD~1"})
off = tpg._run_generator(loki, os.path.join(t.tmp, "b"),
                         env_extra={"_LOKI_RUN_START_SHA": "HEAD~1",
                                    "LOKI_PHASE_CODE_REVIEW": "false"})
print("%s|%s" % (base["honesty"]["headline"], off["honesty"]["headline"]))
PY
}

_out="$(probe_headline 2>/dev/null | tail -1)"
_base="${_out%%|*}"
_off="${_out##*|}"
if [[ -n "$_base" && "$_base" == "$_off" ]]; then
    ok "decision 1 is still open: a disabled gate does not move the headline"
else
    ko "decision 1 is still open: a disabled gate does not move the headline" \
       "base=$_base off=$_off -- if this was decided deliberately, update the document"
fi

# --- the document must name where the change would go ------------------------
# A decision doc that says "this is your call" without saying where the lever is
# leaves the reader no better off than the commit log.
for anchor in "_compute_headline" "_recorded_degraded_raw" "test_no_security_file_is_not_a_gap"; do
    if grep -q "$anchor" "$DOC"; then
        ok "the document names $anchor"
    else
        ko "the document names $anchor" "the reader cannot find the lever"
    fi
done

# --- and it must state BOTH sides ---------------------------------------------
# A one-sided decision doc is a recommendation wearing a decision's clothes.
if grep -qi "case against" "$DOC"; then
    ok "the document argues both sides"
else
    ko "the document argues both sides" \
       "a one-sided decision doc is a recommendation in disguise"
fi

# --- the three-tier claim must still hold ------------------------------------
# The document asserts that functional, healthcheck and security are all kept
# out of the ledger when unrun, and that all three now say so in their own
# docstring. If someone gates one of them, the document is stale.
for _fact in functional healthcheck security; do
    if grep -A 14 "def _collect_${_fact}" "$GEN" \
        | grep -qiE "NOT read by _compute_headline|founder-gated|record-half|record half"; then
        ok "$_fact documents its record-half behaviour in place"
    else
        ko "$_fact documents its record-half behaviour in place" \
           "the document claims all three are documented; a reader would have to infer this one"
    fi
done

# --- the verifier filter it references must still exist ----------------------
if grep -q "post_headline" "$VERIFY"; then
    ok "the verifier filter the document warns about still exists"
else
    ko "the verifier filter the document warns about still exists"
fi

# --- the OLDER decision doc must carry its staleness note --------------------
# A month-old decision list with no status header reads as current. Sections of
# it concern a separate repository and cannot be actioned where it is read,
# which is the failure mode this whole file exists to prevent -- so the note
# itself is load-bearing, not decoration.
OLD_DOC="$REPO_ROOT/docs/FOUNDER-STATUS-AND-DECISIONS-2026-07-01.md"
if [[ -f "$OLD_DOC" ]]; then
    if grep -q "partly stale" "$OLD_DOC"; then
        ok "the older decision list is marked stale"
    else
        ko "the older decision list is marked stale" \
           "it reads as current while parts of it cannot be actioned from this repo"
    fi

    # Its central claim: the verify package is not here. If someone vendors it
    # in, the note becomes wrong and must be revisited.
    _hits="$(find "$REPO_ROOT" -name package.json -not -path "*/node_modules/*" \
             -exec grep -l "@autonomi/verify" {} \; 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$_hits" == "0" ]]; then
        ok "the staleness note is right: no @autonomi/verify package here"
    else
        ko "the staleness note is right: no @autonomi/verify package here" \
           "found $_hits -- the note now misdirects the reader"
    fi

    # And it must point at the current one, or a reader stops at the stale page.
    if grep -q "FOUNDER-DECISIONS-TRUST-SEMANTICS-2026-08-01" "$OLD_DOC"; then
        ok "the older list points at the current decisions"
    else
        ko "the older list points at the current decisions"
    fi
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
