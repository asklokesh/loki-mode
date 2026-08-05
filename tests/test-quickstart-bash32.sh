#!/usr/bin/env bash
# The quickstart template scorer must work on macOS stock bash 3.2.
#
# WHY THIS SLIPPED, and why a normal test would not have caught it. The scorer
# used `declare -A scores`, a bash 4 associative array. macOS ships bash 3.2.57
# as /bin/bash -- frozen since 2007 for GPLv2 reasons, and Apple will not update
# it -- so on the stock shell of the most common developer platform the function
# printed "declare: -A: invalid option" and returned ZERO templates.
#
# Three things conspired to hide it:
#   1. The function BODY parses fine under 3.2. Only CALLING it fails, so
#      `bash -n` and sourcing both look healthy.
#   2. The test harness runs under homebrew bash 5, where it works perfectly.
#   3. It degrades to empty rather than erroring, so the interview just showed
#      no templates instead of crashing.
#
# `loki quickstart` is the guided first build we point new users at from the
# welcome screen and from doctor, so this was a first-run failure on Macs.
#
# This test therefore runs the scorer under /bin/bash EXPLICITLY. Testing it
# under $SHELL would reproduce exactly the blind spot that let the bug ship.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QS="$REPO_ROOT/autonomy/quickstart.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

if [ ! -x /bin/bash ]; then
    echo "  [SKIP] /bin/bash not present"
    echo "Results: 0 passed, 0 failed, 0 total"
    exit 0
fi

_bash32_ver=$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || echo "?")

echo "T1 -- the scorer returns templates under /bin/bash (major version $_bash32_ver)"

out=$(/bin/bash -c "source '$QS' >/dev/null 2>&1; _qs_score_templates 'a todo app with auth'" 2>&1)
n=$(printf '%s\n' "$out" | grep -c . || true)

# The specific symptom of the bug, asserted by name so a regression is obvious.
if printf '%s' "$out" | grep -q "declare: -A"; then
    bad "bash 4 associative array reintroduced (declare -A) -- returns nothing on macOS"
else
    ok "no bash-4-only construct reached at call time"
fi

if [ "$n" -ge 1 ]; then
    ok "scorer returned $n template(s) under /bin/bash"
else
    bad "scorer returned ZERO templates under /bin/bash (the original bug)"
fi

# simple-todo-app is documented as the guaranteed default and must always be
# reachable, or a user with an unmatched brief gets an empty picker.
if printf '%s' "$out" | grep -q "simple-todo-app"; then
    ok "the guaranteed default (simple-todo-app) is present"
else
    bad "guaranteed default missing -- an unmatched brief would show nothing"
fi

echo
echo "T2 -- /bin/bash and the harness shell agree exactly"

# The real invariant: a Mac user on the stock shell must see the SAME ranking a
# developer on bash 5 sees. Identical output, not merely non-empty output.
mismatch=0
for brief in \
    "a chrome extension for tabs" \
    "multi tenant saas billing" \
    "ai chatbot with rag" \
    "rest api only"
do
    a=$(/bin/bash -c "source '$QS' >/dev/null 2>&1; _qs_score_templates '$brief'" 2>/dev/null | tr '\n' ',')
    b=$(bash -c "source '$QS' >/dev/null 2>&1; _qs_score_templates '$brief'" 2>/dev/null | tr '\n' ',')
    if [ "$a" = "$b" ] && [ -n "$a" ]; then
        ok "'$brief' ranks identically: $a"
    else
        bad "'$brief' DIFFERS: /bin/bash=[$a] harness=[$b]"
        mismatch=1
    fi
done

# Non-vacuity: if BOTH shells returned nothing, every comparison above would
# "match" while the feature was completely broken.
if [ "$mismatch" -eq 0 ] && [ "$n" -ge 1 ]; then
    ok "non-vacuity: comparisons ran against non-empty output"
fi

echo
echo "T3 -- ranking is semantically right, not just non-empty"

# A scorer that returned the same three templates for every brief would pass
# everything above. Assert it actually discriminates.
chrome=$(/bin/bash -c "source '$QS' >/dev/null 2>&1; _qs_score_templates 'a chrome extension for tabs'" 2>/dev/null | head -1)
saas=$(/bin/bash -c "source '$QS' >/dev/null 2>&1; _qs_score_templates 'multi tenant saas billing'" 2>/dev/null | head -1)
if [ "$chrome" = "chrome-extension" ]; then
    ok "'chrome extension' ranks chrome-extension first"
else
    bad "'chrome extension' ranked '$chrome' first"
fi
if [ "$saas" = "saas-starter" ]; then
    ok "'saas billing' ranks saas-starter first"
else
    bad "'saas billing' ranked '$saas' first"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
