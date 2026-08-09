#!/usr/bin/env bash
# The A/B analyser reports significance honestly at tiny n.
#
# WHY THIS EXISTS. Eleven recorded trials sat unanalysed, and eyeballing the
# medians produces two opposite errors that this tool -- and this test -- exist
# to prevent.
#
# TEST 2 IS THE FALSE-POSITIVE GUARD. Wall clock shows v7 791s vs v8 524s, a
# 1.51x gap that looks decisive. The ranges OVERLAP and the exact permutation
# p is 0.057 at n=3/4. If this tool ever reports that as significant it is
# manufacturing a multiplier, which is the single claim this repository must
# never make.
#
# TEST 3 IS THE FALSE-NEGATIVE GUARD, and it is the subtler one. Act iterations
# are perfectly separated (v7 always 7, v8 always 1). A median-difference
# permutation test gives p = 0.486 on that -- effectively "no effect" -- because
# on separated constant data nearly every permutation reproduces a similar
# median gap, so the statistic has almost no power. A rank-sum statistic gives
# p = 0.0286, the smallest value achievable at this design. A real effect
# hidden by the wrong test is as damaging as an invented one.
#
# TEST 5 guards the reason the two above can coexist: the tool must report BOTH
# statistics and name which to believe, rather than silently picking whichever
# one favours the newer engine.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$REPO_ROOT/benchmarks/analyze-ab-history.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the A/B analyser reports significance honestly at tiny n"

[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }
python3 -c "import json,statistics,itertools" 2>/dev/null || {
  echo "  SKIP: python3 stdlib unavailable"; echo ""
  echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

# A CRASH IS A FAILURE, NOT A SKIP. Mutation testing caught this: making the
# analyser count harness-failure rows crashed it, the harness saw empty output
# and SKIPPED -- reporting 0/0 for a tool that was broken. A skip must mean the
# input is genuinely absent, never that the tool died, or a regression here
# would pass CI silently.
# ab-history.jsonl is a LOCAL artifact and is not tracked in git, so it is
# absent on every CI runner. That is an absent input, not a broken tool, and it
# must SKIP -- an earlier version of this guard failed the whole shard on it.
# The distinction is the same one the analyser itself makes and I failed to
# mirror here: check whether the input exists BEFORE interpreting the exit code.
if [ ! -f "$REPO_ROOT/benchmarks/results/ab-history.jsonl" ]; then
  echo "  SKIP: no ab-history.jsonl on this machine (local artifact, untracked) -- nothing measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

# With the input present, a nonzero exit IS a crash and must fail loudly.
_rc=0
OUT="$(python3 "$TOOL" --json 2>/tmp/ab-analyse.err)" || _rc=$?
if [ "$_rc" -ne 0 ]; then
  bad "the analyser exited $_rc with a readable history (crash, not an absent input)"
  sed -n '1,3p' /tmp/ab-analyse.err 2>/dev/null | sed 's/^/        /'
  rm -f /tmp/ab-analyse.err
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi
rm -f /tmp/ab-analyse.err
if [ -z "$OUT" ]; then
  if [ -f "$REPO_ROOT/benchmarks/results/ab-history.jsonl" ]; then
    bad "the history exists but the analyser emitted nothing -- the tool is broken"
    echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
  fi
  echo "  SKIP: no ab-history.jsonl on this machine -- nothing measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

_q() { printf '%s' "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
$1" 2>/dev/null; }

# --- 1. It parses and actually ran tests (guards a vacuous pass) -----------
_n="$(_q "print(len(d.get('tests',[])))")"
if [ "${_n:-0}" -ge 2 ]; then
  ok "the analyser emits $_n test result(s) as valid JSON"
else
  bad "fewer than 2 tests emitted -- assertions below would be vacuous"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

# --- 2. FALSE-POSITIVE GUARD: an overlapping metric is NOT significant -----
_wall="$(_q "
t=[x for x in d['tests'] if x['metric']=='wall_clock_s']
print(t[0]['verdict'] if t else 'MISSING')")"
if [ "$_wall" = "NOT SIGNIFICANT" ]; then
  ok "a 1.51x median gap with overlapping ranges is NOT called significant"
else
  bad "wall_clock verdict is '$_wall' -- a manufactured multiplier"
fi

# --- 3. FALSE-NEGATIVE GUARD: separated arms ARE detected ------------------
_iter="$(_q "
t=[x for x in d['tests'] if x['metric']=='act_iterations']
print('%s|%s' % (t[0]['verdict'], t[0]['believe']) if t else 'MISSING|')")"
if [ "$_iter" = "SIGNIFICANT|p_rank_sum" ]; then
  ok "perfectly separated arms are detected, via the rank statistic"
else
  bad "act_iterations reported '$_iter' -- a real effect hidden by the wrong test"
fi

# --- 4. Harness failures are EXCLUDED, not counted as slow trials ----------
# A hung harness recorded as a data point would masquerade as a slow arm.
_skip="$(_q "print(d.get('rows_skipped_as_harness_failures',-1))")"
if [ "${_skip:-0}" -ge 1 ]; then
  ok "harness-failure rows are excluded from the arms ($_skip skipped)"
else
  bad "no rows excluded -- a hung harness would be counted as a slow trial"
fi

# --- 5. BOTH statistics are reported, with a stated choice ----------------
# Reporting only the favourable one is how an honest tool becomes a dishonest
# one without anybody editing a number.
_both="$(_q "
t=d['tests']
print(all('p_median_diff' in x and 'p_rank_sum' in x and 'reason' in x for x in t))")"
if [ "$_both" = "True" ]; then
  ok "every test reports both statistics and why one was believed"
else
  bad "a test omits a statistic or its reason -- the disagreement would be hidden"
fi

# --- 6. The design floor is reported ---------------------------------------
# "Not significant" at n=3/4 can mean the design could never have succeeded.
# Saying so is the difference between an honest null and a discouraging one.
_floor="$(_q "print(all('p_floor_at_this_n' in x for x in d['tests']))")"
if [ "$_floor" = "True" ]; then
  ok "the smallest achievable p is reported alongside each result"
else
  bad "no design floor -- a null result cannot be told from an underpowered one"
fi

# --- 7. No multiplier is asserted -----------------------------------------
_nc="$(_q "print(d.get('not_claimed',''))")"
if printf '%s' "$_nc" | grep -qi "no multiplier"; then
  ok "the report explicitly declines to state a multiplier"
else
  bad "no multiplier disclaimer -- a median ratio invites one"
fi
if printf '%s' "$_nc" | grep -qi "another vendor\|other vendor"; then
  ok "the report states these arms are engine versions, not vendors"
else
  bad "nothing distinguishes an internal A/B from a competitive claim"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
