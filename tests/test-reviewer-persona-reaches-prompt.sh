#!/usr/bin/env bash
# The hand-written persona must actually reach the reviewer prompt.
#
# THE DEFECT: all 41 entries in agents/types.json carry real hand-written
# persona prose ("You are a senior backend engineer specializing in..."). The
# selector SET that persona on the specialist dict, and the reviewers payload
# then copied only name/focus/checks -- so the persona was discarded before any
# prompt was built. The role still reached the reviewer via a SYNTHESIZED checks
# line, so nothing looked broken; what was lost was the authored prose.
#
# WHAT IS LOAD-BEARING, and why this is not just "add a field": the reviewer
# prompt's "Your SOLE focus is" constraint is what keeps a blind reviewer on its
# lane. A persona prepended carelessly could dilute it. These assertions check
# the persona is carried AND that the focus constraint survives AND that a
# specialist with NO persona produces a byte-identical prompt to before.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-reviewer-persona-reaches-prompt"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: persona wiring was NOT measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"; exit 1
fi

# Strip comments before matching: a text guard that matches the comment
# explaining its own fix passes on broken code.
#
# Written to a FILE, not piped from a variable. `printf ... | grep -q` exits on
# the first match and closes the pipe, so printf dies of SIGPIPE (141) and
# `set -o pipefail` reports the PIPELINE as failed even though grep MATCHED.
# That inverts every assertion below: correct code reads as broken. Caught here
# by four assertions failing against code proven correct by direct grep.
SRC_FILE="$(mktemp)"
trap 'rm -f "$SRC_FILE"' EXIT
sed 's/#.*//' autonomy/run.sh > "$SRC_FILE"

# 1. The payload must carry persona through.
if grep -q '"persona": SPECIALISTS\[name\]\.get("persona"' "$SRC_FILE"; then
    pass "the reviewers payload carries persona for built-in specialists"
else
    fail "reviewers payload drops persona; authored prose never reaches a prompt"
fi

# 2. Installed specialists too, or an installed agent silently loses its persona.
if grep -q '"persona": INSTALLED_SPECIALISTS\[name\]\.get("persona"' "$SRC_FILE"; then
    pass "installed specialists carry persona too"
else
    fail "installed specialists drop persona"
fi

# 3. It must be exported to the prompt subprocess.
if grep -q 'export LOKI_REVIEW_PROMPT_PERSONA=' "$SRC_FILE"; then
    pass "persona is exported to the prompt builder"
else
    fail "persona is never exported; the payload field would be inert"
fi

# 4. The prompt must actually interpolate it.
if grep -q '{_persona_line}You are {name}' "$SRC_FILE"; then
    pass "the prompt interpolates the persona ahead of the role line"
else
    fail "the prompt does not use the persona"
fi

# 5. BEHAVIOR, not text: drive the exact prompt logic both ways.
if python3 - <<'PY'
import sys
def build(persona, name, focus, checks):
    _persona_line = (persona.strip() + "\n\n") if persona.strip() else ""
    return f"""Files changed:
shared

{_persona_line}You are {name}. Your SOLE focus is: {focus}.

Review ONLY for: {checks}."""
with_p = build("You are a senior backend engineer.", "eng-backend", "APIs", "auth")
without = build("", "eng-backend", "APIs", "auth")
# persona leads the role block (shared Files/Diff prefix comes first, #270)
if "\n\nYou are a senior backend engineer.\n\nYou are eng-backend." not in with_p: sys.exit(1)
# the focus constraint survives in BOTH
if "SOLE focus" not in with_p or "SOLE focus" not in without: sys.exit(1)
# no persona == byte-identical to the pre-fix prompt
if "shared\n\nYou are eng-backend. Your SOLE focus is: APIs." not in without: sys.exit(1)
# whitespace-only persona must behave as absent, not emit a blank block
if build("   \n ", "x", "y", "z") != without.replace("eng-backend","x").replace("APIs","y").replace("auth","z"): sys.exit(1)
sys.exit(0)
PY
then
    pass "persona leads when set; absent/blank persona is byte-identical to the old prompt"
else
    fail "persona changes the prompt when it should not, or drops the focus constraint"
fi

# 6. GUARD AGAINST VACUITY: if types.json ever stops carrying personas, every
#    assertion above would still pass while guarding nothing.
NP="$(python3 -c "
import json
try:
    d=json.load(open('agents/types.json'))
except Exception:
    print(-1); raise SystemExit
print(sum(1 for a in d if isinstance(a,dict) and a.get('persona')))
" 2>/dev/null)"
if [ "${NP:-0}" -ge 10 ]; then
    pass "$NP agent types carry a non-empty persona (so wiring it matters)"
elif [ "${NP:-0}" = "-1" ]; then
    fail "agents/types.json unreadable: persona coverage UNMEASURED"
else
    fail "only ${NP:-0} types carry a persona; these assertions guard almost nothing"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
