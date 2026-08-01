#!/usr/bin/env bash
# Iteration 1 must be told which gates will judge it.
#
# F3 in docs/FIRST-PASS-COMPLETION-PLAN.md.
#
# WHY. Measured across every recorded run on this machine:
#
#   FireLater  3 iters   static_analysis 2, mutation_integrity 3, code_review 2
#   anonima    4 iters   code_review 1
#   engine     1 iter    none
#   loki-mode  1 iter    none
#
# Perfect correlation -- every multi-iteration run had a failing gate, every
# single-iteration run had none. Iterations are gates REJECTING work, not the
# model failing to finish. So the agent has to clear the gates during pass 1,
# and it cannot aim at gates nobody named.
#
# The first-pass directive already said "self-verify by running". That is the
# right instruction and it named ZERO of the gates that actually block. Only
# three gates have ever failed here, so those three are named explicitly.
#
# ITERATION-1 ONLY, and that is load-bearing beyond token cost: the prompt is
# split at [CACHE_BREAKPOINT] into a cache-stable prefix and a volatile tail.
# Text that appears on some iterations and not others must never drift into the
# stable half, or it busts the prompt cache every iteration.
#
# BYTE-MIRRORED. The same directive ships on the bash route
# (providers/claude.sh) and the Bun route (loki-ts/src/providers/claude_flags.ts).
# Editing one alone silently diverges the two runtimes.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
CLAUDE_TS="$REPO_ROOT/loki-ts/src/providers/claude_flags.ts"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: iteration 1 names the gates that will judge it"

emit() {
    ITERATION_COUNT="$1" bash -c '
        source "$1" 2>/dev/null
        _loki_autonomy_override_text 2>/dev/null
    ' _ "$CLAUDE_SH" 2>/dev/null
}

_it1="$(emit 1)"
if [ -z "$_it1" ]; then
    bad "the override text is empty; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "the iteration-1 system prompt is produced"

# --- the three gates that have actually blocked must be named ----------------
# Not an arbitrary list: these are every gate that has failed in recorded runs.
for _g in "STATIC ANALYSIS" "TEST SUITE" "MUTATION/MOCK INTEGRITY" "CODE REVIEW"; do
    case "$_it1" in
        *"$_g"*) ok "iteration 1 names: $_g" ;;
        *) bad "iteration 1 does not name $_g -- the agent cannot aim at it" ;;
    esac
done

# --- the directive must be actionable, not just a label ----------------------
# "satisfy code review" is not guidance. The measured failure modes are.
case "$_it1" in
    *"tautological assertions"*) ok "mock-integrity guidance is concrete" ;;
    *) bad "mock/mutation guidance names no actual failure mode" ;;
esac
case "$_it1" in
    *"scope creep"*) ok "code-review guidance is concrete" ;;
    *) bad "code-review guidance names no actual failure mode" ;;
esac
case "$_it1" in
    *"Run them; do not assume"*) ok "the test directive demands running, not reading" ;;
    *) bad "the test directive can be satisfied by reading" ;;
esac

# --- the framing must survive too --------------------------------------------
# The four gate names above are the substance, and removing any one is caught.
# But the header is what makes the list MANDATORY rather than a hint: reword it
# to "do your best" and the names remain while the instruction stops being one.
# That mutation survived until this assertion existed.
case "$_it1" in
    *"SATISFY THE GATES THAT WILL JUDGE THIS PASS"*)
        ok "the gate list is framed as a requirement" ;;
    *) bad "the gate list lost its imperative framing -- it reads as a hint" ;;
esac

# --- ITERATION-1 ONLY --------------------------------------------------------
# Repeating it every iteration would both waste tokens and risk drifting into
# the cache-stable prefix.
_it3="$(emit 3)"
case "$_it3" in
    *"SATISFY THE GATES"*)
        bad "the directive repeats on iteration 3 -- wastes tokens and risks the prompt cache" ;;
    *) ok "the directive is iteration-1 only" ;;
esac

# The autonomy preamble must still be present on later iterations: only the
# first-pass half is conditional.
case "$_it3" in
    *"LOKI-AUTONOMY-AGENT"*) ok "the autonomy preamble still ships on later iterations" ;;
    *) bad "later iterations lost the autonomy preamble" ;;
esac

# --- opt-out -----------------------------------------------------------------
_off="$(ITERATION_COUNT=1 LOKI_FIRST_PASS_EXCELLENCE=0 bash -c '
    source "$1" 2>/dev/null; _loki_autonomy_override_text 2>/dev/null' _ "$CLAUDE_SH" 2>/dev/null)"
case "$_off" in
    *"SATISFY THE GATES"*) bad "LOKI_FIRST_PASS_EXCELLENCE=0 does not suppress the directive" ;;
    *) ok "LOKI_FIRST_PASS_EXCELLENCE=0 suppresses it" ;;
esac

# --- BYTE PARITY with the Bun route -----------------------------------------
# The same text ships from claude_flags.ts. A divergence means the two runtimes
# prompt differently, which is invisible until someone compares outputs.
if [ -f "$CLAUDE_TS" ]; then
    _missing=""
    for _g in "STATIC ANALYSIS" "TEST SUITE" "MUTATION/MOCK INTEGRITY" \
              "CODE REVIEW" "tautological assertions" "scope creep"; do
        grep -qF "$_g" "$CLAUDE_TS" || _missing="$_missing [$_g]"
    done
    if [ -z "$_missing" ]; then
        ok "the Bun route carries the identical gate directive"
    else
        bad "the Bun route is missing:$_missing -- the runtimes now prompt differently"
    fi
else
    echo "  SKIP: $CLAUDE_TS not present"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
