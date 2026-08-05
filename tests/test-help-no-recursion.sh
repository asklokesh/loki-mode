#!/usr/bin/env bash
# `loki help --help` must not fork bomb.
#
# WHAT HAPPENED. The help router delegates `loki help <cmd>` to the command's
# own help:
#
#     local _help_target="$1"; shift
#     LOKI_HELP_ONLY=1 "$0" "$_help_target" --help "$@"
#
# When the target is itself help-shaped, `loki help --help` becomes
# `"$0" --help --help`, which re-enters the SAME case, and "$@" accumulates one
# more --help on every pass. The recursion is unbounded and costs one process
# per level. On this machine it reached 3,788 chained
# `bash autonomy/loki --help --help` processes out of 4,172 total, after which
# the fork table was exhausted and even `pkill` could not start.
#
# THE PART WORTH REMEMBERING, because the code already carried a comment
# claiming this delegation was "safe by construction": LOKI_HELP_ONLY does make
# it safe against SIDE EFFECTS -- asking for help never starts or modifies
# anything. It says nothing about SELF-REFERENCE. Those are different hazards,
# and the guard for one reads exactly like the guard for the other. The danger
# was never that a delegated command DOES something; it is that the help router
# asks itself for help forever.
#
# A fork bomb is also uniquely bad for THIS repo's failure modes: once the
# process table is full, `grep` and `echo` return EMPTY WITH NO ERROR, which is
# indistinguishable from "no matches". Every measurement taken during that
# window is an absent measurement wearing the costume of a clean result.
#
# WHY THE ULIMIT IS NOT OPTIONAL. Without a cap, a regression here does not
# fail this test -- it takes down the machine running it, including CI. The
# subshell cap means the worst case is a bounded failure with a readable
# message.
#
# WHY THE CAP IS RELATIVE AND NOT AN ABSOLUTE 400. `ulimit -u` is RLIMIT_NPROC,
# which counts every process owned by the UID -- not just this subshell's
# descendants. An absolute cap is therefore an absolute bound on a quantity we
# only partly control. On a busy macOS host the user baseline measured 453
# against a cap of 400, so the subshell could not fork its FIRST child: every
# assertion below failed for want of a process, and none of them were about
# `loki`. Budget from the measured baseline instead, so the headroom is what
# stays fixed.
#
# The headroom is what does the discriminating, and it is not a close call: the
# original bomb reached 3,788 chained processes. A budget of 150 stops a real
# regression more than an order of magnitude early while leaving an idle host
# untouched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: loki help does not recurse into itself"

if [ ! -f "$LOKI" ]; then
    echo "SKIP: autonomy/loki not found. (Not a fail.)"; exit 0
fi

# Processes already owned by this UID. `ulimit -u` counts these too, so the
# cap has to be measured from here rather than assumed.
_uid_procs() { ps -u "$(id -u)" 2>/dev/null | wc -l | tr -d ' '; }

_PROC_BUDGET=150
_baseline=$(_uid_procs)
_CAP=$(( ${_baseline:-0} + _PROC_BUDGET ))
echo "  process budget: baseline ${_baseline} + ${_PROC_BUDGET} = cap ${_CAP}"

# A cap we failed to SET is worse than no cap: the subshell would run the fork
# bomb unbounded. `ulimit -u` can refuse when the value exceeds a low hard limit
# (containers), so prove settability on a throwaway subshell BEFORE running
# anything. Kept separate from _run_capped so that function's exit status stays
# a clean signal about `loki`, never about the harness failing to budget.
if ! ( ulimit -u "$_CAP" ) 2>/dev/null; then
    echo "SKIP: cannot set ulimit -u to $_CAP (hard limit $(ulimit -Hu 2>/dev/null))."
    echo "      Refusing to run an unbounded fork-bomb probe. (Not a fail.)"
    exit 0
fi

# Bound BOTH axes. The process cap stops a regression from exhausting the
# machine; the timeout stops a non-forking hang. Either alone leaves a hole.
#
# The subshell's OWN stderr must land in "$out" as well. When the cap bites, it
# is the SHELL that reports "fork: Resource temporarily unavailable", not the
# command -- and that message went to the harness's terminal while "$out" stayed
# empty, so the fork-exhaustion grep below was searching a file that could never
# contain what it looked for. Truncate once on the outside, append within.
_run_capped() {
    local out="$1"; shift
    : > "$out"
    ( ulimit -u "$_CAP" 2>/dev/null || exit 125
      if command -v timeout >/dev/null 2>&1; then
          timeout 20 "$@" >> "$out" 2>&1
      elif command -v gtimeout >/dev/null 2>&1; then
          gtimeout 20 "$@" >> "$out" 2>&1
      else
          "$@" >> "$out" 2>&1
      fi ) >> "$out" 2>&1
}

_before=$(ps -e 2>/dev/null | wc -l | tr -d ' ')

# --- the exact invocation that bombed --------------------------------------
_out="$(mktemp "${TMPDIR:-/tmp}/loki-helprec-XXXXXX")"
_run_capped "$_out" bash "$LOKI" help --help
_rc=$?

if [ "$_rc" -eq 124 ] || [ "$_rc" -eq 137 ]; then
    bad "loki help --help TIMED OUT (rc=$_rc) -- it is recursing"
elif [ "$_rc" -ne 0 ]; then
    bad "loki help --help exited $_rc; asking for help is not a failure"
else
    ok "loki help --help exits 0"
fi

# A bombing run dies before printing the front page, so it emits almost
# nothing. Requiring real output distinguishes "printed help" from "died
# quietly", which a bare exit-code check cannot.
_lines=$(wc -l < "$_out" 2>/dev/null | tr -d ' ')
if [ "${_lines:-0}" -ge 20 ]; then
    ok "loki help --help printed the front page ($_lines lines)"
else
    bad "loki help --help printed only ${_lines:-0} lines -- it died instead of printing"
fi

# Fail closed on an ABSENT measurement. A substring search over an empty file
# reports nothing wrong, which reads exactly like a clean run -- and did, on the
# very host that motivated this fix: the cap blocked the first fork, "$_out" was
# empty, and this assertion PASSED while the command had produced no output at
# all. No output is not evidence of no forking.
if [ ! -s "$_out" ]; then
    bad "loki help --help produced NO output -- cannot judge fork exhaustion (absent measurement)"
elif grep -qE "fork failed|fork: retry|Resource temporarily unavailable" "$_out" 2>/dev/null; then
    bad "loki help --help hit the process cap (budget $_PROC_BUDGET) -- still forking"
else
    ok "loki help --help did not exhaust the process cap"
fi

# --- other help-shaped spellings reach the same guard ----------------------
for _spelling in "-h" "help"; do
    _o2="$(mktemp "${TMPDIR:-/tmp}/loki-helprec2-XXXXXX")"
    _run_capped "$_o2" bash "$LOKI" help "$_spelling"
    _rc2=$?
    if [ "$_rc2" -eq 124 ] || [ "$_rc2" -eq 137 ]; then
        bad "loki help $_spelling TIMED OUT -- that spelling still recurses"
    elif grep -qE "fork failed|fork: retry|Resource temporarily unavailable" "$_o2" 2>/dev/null; then
        bad "loki help $_spelling hit the process cap -- that spelling still recurses"
    else
        ok "loki help $_spelling terminates"
    fi
    rm -f "$_o2"
done

# --- delegation still WORKS, which is the point of the router --------------
# A fix that simply disabled `loki help <cmd>` would pass every assertion
# above while removing the feature. This is the anti-overfit check.
_o3="$(mktemp "${TMPDIR:-/tmp}/loki-helprec3-XXXXXX")"
_run_capped "$_o3" bash "$LOKI" help verify
if [ -s "$_o3" ] && ! grep -qE "fork failed" "$_o3" 2>/dev/null; then
    ok "loki help <command> still delegates and prints something"
else
    bad "loki help verify printed nothing -- the fix broke real delegation"
fi
rm -f "$_o3" "$_out"

# --- the machine is no worse off than when we started ----------------------
_after=$(ps -e 2>/dev/null | wc -l | tr -d ' ')
_delta=$(( _after - _before ))
if [ "$_delta" -lt 50 ]; then
    ok "process count stable across the run (${_before} -> ${_after})"
else
    bad "process count grew by $_delta (${_before} -> ${_after}) -- something is still spawning"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
