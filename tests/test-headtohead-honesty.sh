#!/usr/bin/env bash
# The head-to-head corpus states what it does NOT measure.
#
# WHY THIS EXISTS. The corpus now contains a 0/3 row for Factory's droid. That
# number is a HEADLESS-INVOCATION failure -- droid aborts before any model call,
# with num_turns 0 and no assistant message in its own session transcript -- and
# it says nothing whatsoever about Factory's build quality or speed. A reader
# who finds "0/3" beside codex's "4/5" and draws a ranking has been misled by
# our artifact, which is worse than publishing nothing: a competitive claim we
# cannot support, in a repository whose entire thesis is verifiable evidence.
#
# TEST 3 IS THE LOAD-BEARING ONE. Every trial row must carry a POSITIVE CONTROL
# or a documented reason it cannot. A 0/N with no control is indistinguishable
# from a broken harness -- and that exact thing happened here: the first droid
# run scored 0/3 while codex ALSO scored 0/3 in the same harness, because codex
# needed --skip-git-repo-check and was blocking on stdin. Both zeros were
# measurement artifacts. The control is what separates a result from a bug.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORPUS="$REPO_ROOT/benchmarks/results/cross-cli-headtohead.json"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the head-to-head corpus cannot imply an unmeasured ranking"

[ -f "$CORPUS" ] || { echo "  FAIL: $CORPUS missing"; exit 1; }
python3 -c "import json" 2>/dev/null || { echo "  FAIL: python3 json unavailable"; exit 1; }

_q() { python3 -c "
import json,sys
d=json.load(open('$CORPUS'))
$1" 2>/dev/null; }

# --- 0. Valid JSON with trial rows (guards against a vacuous pass) ---------
_rows="$(_q "print(len([k for k,v in d.items() if isinstance(v,dict) and 'trials' in v]))")"
if [ "${_rows:-0}" -ge 1 ]; then
  ok "the corpus parses and contains $_rows measured row(s)"
else
  bad "no trial rows found -- every assertion below would be vacuous"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

# --- 1. not_claimed exists and names the tools with NO local CLI -----------
# Absence from this corpus is not evidence of absence in a product.
_nc="$(_q "print(d.get('not_claimed',''))")"
if [ -n "$_nc" ]; then
  ok "the corpus records what it does NOT claim"
else
  bad "no not_claimed section -- a reader would infer a complete ranking"
fi
_missing=0
for _v in Devin Replit 8090; do
  printf '%s' "$_nc" | grep -qi "$_v" || _missing=$((_missing+1))
done
if [ "$_missing" -eq 0 ]; then
  ok "not_claimed names every vendor that ships no local CLI"
else
  bad "$_missing vendor(s) with no local CLI are unmentioned -- their absence reads as a loss"
fi

# --- 2. A ZERO-SUCCESS row must explain itself ----------------------------
# This is the row most likely to be misread as "this tool is bad".
_zero_unexplained="$(_q "
bad=[]
for k,v in d.items():
    if not (isinstance(v,dict) and 'trials' in v): continue
    sr=str(v.get('success_rate',''))
    if sr.startswith('0/'):
        note=str(v.get('note',''))
        # Must say the tool never reached a model, not merely that it failed.
        if not note or 'before any model call' not in note:
            bad.append(k)
print(','.join(bad))")"
if [ -z "$_zero_unexplained" ]; then
  ok "every zero-success row explains that the tool never reached a model"
else
  bad "row(s) [$_zero_unexplained] show 0/N with no explanation -- reads as a capability verdict"
fi

# --- 3. THE LOAD-BEARING ONE: a zero row needs a POSITIVE CONTROL ---------
# A 0/N without a control is indistinguishable from a broken harness, and that
# is not hypothetical: codex scored 0/3 in this same harness until two harness
# bugs were fixed.
_no_control="$(_q "
bad=[]
for k,v in d.items():
    if not (isinstance(v,dict) and 'trials' in v): continue
    if str(v.get('success_rate','')).startswith('0/') and not v.get('positive_control'):
        bad.append(k)
print(','.join(bad))")"
if [ -z "$_no_control" ]; then
  ok "every zero-success row carries a positive control"
else
  bad "row(s) [$_no_control] report 0/N with no control -- could be a broken harness"
fi

# --- 4. The method is recorded and artifact-verified ----------------------
# "It ran" is not a result; the artifact has to be checked.
_m="$(_q "print(d.get('method',''))")"
if printf '%s' "$_m" | grep -qi "artifact"; then
  ok "the method records that success is artifact-verified, not exit-code-verified"
else
  bad "the method does not mention artifact verification -- an exit code alone green-washes a missing file"
fi

# --- 5. No overall ranking is asserted anywhere ---------------------------
# The one sentence that would turn honest rows into a false claim.
if printf '%s' "$_nc" | grep -qi "no overall ranking"; then
  ok "the corpus explicitly disclaims an overall ranking"
else
  bad "no ranking disclaimer -- side-by-side rows imply one"
fi

# --- 6. Reported success rates match the recorded trials ------------------
# A hand-edited summary that drifts from its own data is the quietest way for a
# corpus like this to start lying.
_mismatch="$(_q "
bad=[]
for k,v in d.items():
    if not (isinstance(v,dict) and 'trials' in v): continue
    t=v.get('trials') or []
    got=sum(1 for x in t if x.get('artifact') is True)
    sr=str(v.get('success_rate',''))
    if sr and sr != '%d/%d' % (got,len(t)):
        bad.append('%s(%s vs %d/%d)' % (k,sr,got,len(t)))
print(','.join(bad))")"
if [ -z "$_mismatch" ]; then
  ok "every success_rate matches its own recorded trials"
else
  bad "success_rate drifted from the trials: $_mismatch"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
