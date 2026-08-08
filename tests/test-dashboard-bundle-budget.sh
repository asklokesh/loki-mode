#!/usr/bin/env bash
# The shipped dashboard bundle has a size budget, and it is a MEASURED one.
#
# WHY THIS EXISTS. dashboard/static/index.html is a single self-contained file
# that every user downloads before seeing anything. It grew from 780 KB to
# 788 KB in one session as five panels were added -- proportionate, but nothing
# in the repo would have noticed a change that added 500 KB. A page-weight
# regression is invisible in code review and obvious to a user on a slow link.
#
# THE BUDGET IS NOT A GUESS. It is the measured size at the time of writing plus
# deliberate headroom, recorded here so the next person can see what it was
# based on rather than inheriting an unexplained constant:
#
#   2fa3a2dd  780 KB   before this session's dashboard work
#   8f6740a1  780 KB   after the receipt/learnings/budget panels
#   d2d31551  788 KB   after the pipeline panel
#
# HEADROOM IS DELIBERATE. A budget set at exactly the current size fails on the
# next honest addition and gets raised reflexively, which trains the reader to
# treat it as noise. 1024 KB leaves room for real growth while still catching
# the accidental 5x.
#
# TEST 3 IS THE ONE THAT MATTERS. A budget nobody can breach is not a budget --
# if the file were missing or empty, a size check alone would report success.
# The positive control asserts the file is genuinely present and substantial,
# so this cannot pass vacuously the way a bare "size < N" would.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE="$REPO_ROOT/dashboard/static/index.html"

BUDGET_KB=1024
FLOOR_KB=200

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the shipped dashboard bundle stays within a measured budget"

if [ ! -f "$BUNDLE" ]; then
    bad "the shipped bundle is missing entirely ($BUNDLE)"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi

_bytes="$(wc -c < "$BUNDLE" | tr -d ' ')"
case "$_bytes" in ''|*[!0-9]*) bad "could not measure the bundle"; echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1 ;; esac
_kb=$(( _bytes / 1024 ))

# --- 1. Under budget --------------------------------------------------------
if [ "$_kb" -le "$BUDGET_KB" ]; then
    ok "bundle is ${_kb} KB, within the ${BUDGET_KB} KB budget"
else
    bad "bundle is ${_kb} KB, over the ${BUDGET_KB} KB budget. If this growth is intentional, raise BUDGET_KB in this file AND record what the new number is based on -- do not raise it silently."
fi

# --- 2. POSITIVE CONTROL: the file is real ---------------------------------
# Without this, an empty or truncated bundle would satisfy test 1 perfectly.
if [ "$_kb" -ge "$FLOOR_KB" ]; then
    ok "bundle is substantial (>= ${FLOOR_KB} KB), so the budget check is not vacuous"
else
    bad "bundle is only ${_kb} KB -- it is truncated or was not built. Test 1 would pass on an empty file."
fi

# --- 3. It is the SHIPPED artifact, not a stub -----------------------------
# grep -a with a control: this file has very long lines and grep otherwise
# treats it as binary and prints NOTHING, which reads as a clean zero.
_ctl="$(grep -ac "Inter" "$BUNDLE" 2>/dev/null || echo 0)"
if [ "${_ctl:-0}" -lt 5 ]; then
    bad "control string missing -- cannot measure the bundle's contents"
elif grep -aq "loki" "$BUNDLE" 2>/dev/null; then
    ok "the bundle is the real dashboard (control found ${_ctl} times)"
else
    bad "the bundle does not look like the dashboard"
fi

# --- 4. It is tracked, so the budget guards what SHIPS ---------------------
if git -C "$REPO_ROOT" ls-files --error-unmatch dashboard/static/index.html >/dev/null 2>&1; then
    ok "the bundle is tracked in git (the budget guards the shipped artifact)"
else
    bad "the bundle is not tracked -- users would not receive this file"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
