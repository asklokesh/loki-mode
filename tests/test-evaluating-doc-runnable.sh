#!/usr/bin/env bash
# Every claim in docs/EVALUATING.md must stay runnable.
#
# WHY. docs/COMPARISON.md is the cautionary tale sitting next to it: written
# January 2026 against v2.36.9, still shipping unchanged while the repo reached
# v8.2.0. Roughly six months and thirty releases of drift, in a document whose
# entire job is to be read by someone deciding whether to trust us. Nobody
# noticed because prose has no gate.
#
# EVALUATING.md makes a different bargain -- every claim has a command next to
# it, and the reader is invited to falsify them. That bargain only holds while
# the commands work. A buyer who runs the first command in our evaluation guide
# and gets an error has learned something true about the project, and it is not
# what we wanted them to learn.
#
# So the artifacts and tests it references are asserted to exist here. This does
# not re-run the heavy suites (the gate already runs them); it checks that the
# page is not pointing at something that has been renamed or deleted.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOC="$REPO_ROOT/docs/EVALUATING.md"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

if [ ! -f "$DOC" ]; then
    echo "  [FAIL] docs/EVALUATING.md is missing"
    echo "Results: 0 passed, 1 failed, 1 total"
    exit 1
fi

echo "T1 -- every referenced artifact exists"

for f in \
    "tests/test-airgap-verify.sh" \
    "tests/test-brownfield-assess-readonly.sh" \
    "benchmarks/results/cross-model-eval.json" \
    "autonomy/lib/fast_verify.py"
do
    if grep -q "$f" "$DOC"; then
        if [ -e "$REPO_ROOT/$f" ]; then
            ok "$f is referenced and exists"
        else
            bad "$DOC points at $f which does NOT exist"
        fi
    else
        bad "$DOC no longer references $f (claim dropped without notice?)"
    fi
done

echo
echo "T2 -- the honesty sections are still present"

# The page's credibility rests on stating what we do NOT have. If a future edit
# quietly removes that section, the document becomes ordinary marketing and this
# test should fail loudly rather than let it happen silently.
if grep -q "## What we do not have" "$DOC"; then
    ok "the 'What we do not have' section survives"
else
    bad "the limitations section was removed -- the page is now one-sided"
fi

for phrase in \
    "No published enterprise case studies" \
    "Generation is not air-gapped" \
    "audited"
do
    if grep -qi "$phrase" "$DOC"; then
        ok "limitation stated: '$phrase'"
    else
        bad "limitation removed: '$phrase'"
    fi
done

echo
echo "T3 -- the cross-model claim keeps its own scope limit"

# The JSON carries BOTH what is claimed and what is explicitly not claimed.
# Dropping not_claimed would turn a careful statement into an overclaim.
if python3 -c "
import json,sys
d=json.load(open('$REPO_ROOT/benchmarks/results/cross-model-eval.json'))
sys.exit(0 if d.get('claim') and d.get('not_claimed') else 1)
" 2>/dev/null; then
    ok "cross-model-eval.json still records both claim and not_claimed"
else
    bad "cross-model-eval.json lost its claim/not_claimed scoping"
fi

echo
echo "T4 -- the stale comparison is labelled, not silently served"

if grep -qi "STALE" "$REPO_ROOT/docs/COMPARISON.md" 2>/dev/null; then
    ok "docs/COMPARISON.md is marked stale"
else
    bad "docs/COMPARISON.md is unlabelled -- a six-month-old grid reads as current"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
