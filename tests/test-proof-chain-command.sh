#!/usr/bin/env bash
# The buyer's verification command must have a front door.
#
# THE DEFECT: tools/verify-chain.py runs the whole verification chain and
# reports one verdict. It shipped in package.json files[] and NO loki command
# surfaced it, so the command a buyer runs to check our output without trusting
# us was undiscoverable. Our entire wedge is "a receipt you verify yourself";
# a verifier nobody can invoke does not deliver it.
#
# WHAT IS LOAD-BEARING HERE is the exit contract:
#   0 PASSED   1 FAILED   2 UNAVAILABLE   3 NOTHING
# Collapsing 2 or 3 into 1 would destroy the distinction that makes the verdict
# worth anything. A chain that could NOT be checked is not a chain that failed,
# and zero receipts is not a passing audit. These tests assert the codes
# individually rather than asserting "it exits non-zero on problems", which
# would pass while the distinction was being destroyed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-proof-chain-command"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: the chain command was not measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# 1. The tool the command fronts must exist and ship. Either half missing means
#    npm users get a command that cannot work.
if [ -f tools/verify-chain.py ]; then
    pass "tools/verify-chain.py exists"
else
    fail "tools/verify-chain.py is missing; the command has nothing to front"
fi

if python3 -c "
import json,sys
f=json.load(open('package.json')).get('files',[])
sys.exit(0 if any(e.rstrip('/')=='tools' or e.startswith('tools/') for e in f) else 1)
" 2>/dev/null; then
    pass "tools/ ships to npm users"
else
    fail "tools/ is not in package.json files[]; the verifier would not reach users"
fi

# 2. The command must be dispatched. Asserted on the case arm, not on a comment
#    mentioning it: a grep for the bare word matches the explanation above it.
if grep -q '^        chain)' autonomy/loki; then
    pass "loki proof chain is dispatched"
else
    fail "no chain) arm in the proof dispatcher; the verifier stays undiscoverable"
fi

# 3. BEHAVIOUR: an empty workspace must report NOTHING (3), never PASSED (0).
#    This is the vacuity case and the one most likely to be got wrong: a
#    verifier that reports success over zero receipts is worse than no verifier.
mkdir -p "$WORK/empty/.loki"
timeout -k 10 60 bash autonomy/loki proof chain "$WORK/empty" >/dev/null 2>&1
rc=$?
case "$rc" in
    3) pass "empty workspace exits 3 NOTHING (zero receipts is not a pass)" ;;
    0) fail "empty workspace exited 0 PASSED: a vacuous audit reported as success" ;;
    *) fail "empty workspace exited $rc; expected 3 NOTHING" ;;
esac

# 4. The human output must SAY so, not only encode it in an exit code. An
#    operator reading the terminal must not see something that looks like a pass.
out="$(timeout -k 10 60 bash autonomy/loki proof chain "$WORK/empty" 2>&1)"
if printf '%s' "$out" | grep -qi 'not a passing audit\|NOTHING'; then
    pass "the human output states that nothing was audited"
else
    fail "empty-workspace output does not say nothing was audited: $(printf '%s' "$out" | tr '\n' ' ' | head -c 140)"
fi

# 5. --json must pass through, since automation gates on it.
jout="$(timeout -k 10 60 bash autonomy/loki proof chain "$WORK/empty" --json 2>&1)"
if printf '%s' "$jout" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if 'stages' in d and 'workspace' in d else 1)
" 2>/dev/null; then
    pass "--json passes through and emits a parseable record"
else
    fail "--json did not produce a parseable record: $(printf '%s' "$jout" | head -c 140)"
fi

# 6. A missing python3 must report UNAVAILABLE (2), never a pass and never a
#    FAILED verdict it did not measure.
NODELESS="$WORK/nopy"
mkdir -p "$NODELESS"
# `timeout` MUST be on this PATH too. Omitting it made the harness itself exit
# 127 (command not found), which looked like the product failing to report
# UNAVAILABLE. The probe was broken, not the guard -- the same trap as reading a
# failed exploit as a secure target.
for b in sh bash cat grep sed awk timeout dirname basename uname tr head; do
    src="$(command -v "$b" 2>/dev/null)" && ln -sf "$src" "$NODELESS/$b" 2>/dev/null
done
PATH="$NODELESS" timeout -k 10 60 bash autonomy/loki proof chain "$WORK/empty" >/dev/null 2>&1
rc=$?
case "$rc" in
    2) pass "no python3 exits 2 UNAVAILABLE (could not check, not a failure)" ;;
    0) fail "no python3 exited 0: an unmeasured chain reported as a pass" ;;
    *) fail "no python3 exited $rc; expected 2 UNAVAILABLE" ;;
esac

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
