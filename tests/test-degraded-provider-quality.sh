#!/usr/bin/env bash
# Degraded providers must not get a quietly worse build than Claude.
#
# TWO DEFECTS THIS PINS, both of the same shape: a quality mechanism that
# reached only the strongest provider.
#
# 1. SILENT SPEC TRUNCATION. The degraded path PASTES the spec text (a degraded
#    provider cannot be told "read the file at this path" the way claude/cline/
#    opencode are), and it pasted only the first 4000 bytes with NO notice. A
#    requirement past roughly 600 words was dropped mid-sentence and the model
#    never knew a larger spec existed. Demonstrated on a 4229-byte spec: the
#    requirement on the final line was simply absent from what the model saw.
#    This is the same defect spec-expand.sh:5-7 already names for OpenAPI ("a
#    40-operation file loses 21 of 40 ops") and fixed for contracts only.
#
# 2. FIRST-PASS EXCELLENCE WAS CLAUDE-ONLY. providers/claude.sh:322 injects it
#    via --append-system-prompt, a flag codex and aider do not have. So the one
#    mechanism built specifically to make a WEAKER model land complete on
#    iteration 1 reached only the strongest model. Codex is also the free
#    on-ramp, so the users least able to absorb a bad build got no help.
#
# The assertions below check the SOURCE, because build_prompt needs a full run
# context to execute. That is a real limitation and it is stated rather than
# hidden: these prove the wiring exists and is on the correct side of the cache
# breakpoint, not that a live degraded run emits them.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a degraded provider gets the same spec and the same first-pass push"

[ -f "$RUN_SH" ] || { echo "  FAIL: $RUN_SH missing"; exit 1; }

# --- 1. The 4000-byte silent cap is gone -------------------------------------
if grep -q 'head -c 4000 "\$prd"' "$RUN_SH"; then
    bad "the 4000-byte spec cap is still present"
else
    ok "the 4000-byte spec cap is gone"
fi

# The cap is still bounded -- unbounded would be a different bug (a 5MB spec
# would blow the context window). It must be a variable with a sane default.
if grep -q 'LOKI_DEGRADED_PRD_CAP:-24000' "$RUN_SH"; then
    ok "the spec is still bounded, at a size a large PRD fits inside"
else
    bad "the cap is missing or not configurable"
fi

# --- 2. THE LOAD-BEARING ONE: truncation must be ANNOUNCED -------------------
# A silent cut is worse than a small one. The model treats a partial spec as the
# whole spec and builds confidently against requirements it never saw.
# Checks the GUARD, not just the string. A first version grepped only for the
# message text, which survives inside a dead `if false` -- disabling the notice
# left the test green. The condition that decides whether it prints is the thing
# under test.
if grep -q 'is TRUNCATED at %s bytes' "$RUN_SH" \
   && grep -q '_prd_truncated:-0.*=.*"1"' "$RUN_SH" \
   && grep -q '_prd_truncated=1' "$RUN_SH"; then
    ok "a truncated spec is announced to the model, not cut silently"
else
    bad "truncation is silent -- the model cannot know it saw a partial spec"
fi
# And it must name the file, or the model has no way to recover the remainder.
if grep -A2 'is TRUNCATED at %s bytes' "$RUN_SH" | grep -q '"\$prd"'; then
    ok "the notice names the spec path so the model can read the rest"
else
    bad "the notice does not name the file -- the model cannot recover the rest"
fi

# --- 3. First-pass excellence reaches degraded providers ---------------------
if grep -q 'FIRST-PASS EXCELLENCE' "$RUN_SH"; then
    ok "the first-pass directive reaches the degraded-provider prompt"
else
    bad "degraded providers still get no first-pass directive"
fi

# One switch for both routes. Two env vars would drift, and a user disabling it
# on Claude would silently keep it on for codex.
if grep -q 'LOKI_FIRST_PASS_EXCELLENCE:-1' "$RUN_SH" \
   && grep -q 'LOKI_FIRST_PASS_EXCELLENCE:-1' "$REPO_ROOT/providers/claude.sh"; then
    ok "both routes share one env var and one default (on)"
else
    bad "the two routes do not share the same gate"
fi

# Iteration-1 only. Repeating it every iteration would burn budget re-teaching
# something the model has already acted on, and would bust the prompt cache.
if grep -B2 "FIRST-PASS EXCELLENCE\] Treat THIS pass" "$RUN_SH" | grep -q 'iteration:-1.*-le 1'; then
    ok "the directive fires on iteration 1 only"
else
    bad "the directive is not gated to iteration 1"
fi

# --- 4. Cache discipline: it must be on the VOLATILE side --------------------
# The prompt splits into a cache-stable prefix and a volatile tail at
# [CACHE_BREAKPOINT]. Anything iteration-dependent placed in the prefix busts
# the cache on every single iteration.
#
# Compared against the breakpoint of the DEGRADED block specifically. A first
# version used `tail -1` and picked up the NON-degraded path's breakpoint
# (further down the file), so it reported a placement bug that did not exist --
# the directive was already on the correct side. Anchoring on the nearest
# preceding emitted breakpoint is what the question actually asks.
_fp_line="$(grep -n 'FIRST-PASS EXCELLENCE\] Treat THIS pass' "$RUN_SH" | tail -1 | cut -d: -f1)"
_bp_line="$(grep -n "printf '\[CACHE_BREAKPOINT\]" "$RUN_SH" | cut -d: -f1 \
            | awk -v f="$_fp_line" '$1 < f {last=$1} END {print last}')"
if [ -n "$_bp_line" ] && [ -n "$_fp_line" ] && [ "$_fp_line" -gt "$_bp_line" ]; then
    ok "the directive sits AFTER [CACHE_BREAKPOINT] (volatile side, cache intact)"
else
    bad "the directive is on the cache-stable side and would bust the cache every iteration"
fi

# --- 5. The four load-bearing instructions survived the condensation ---------
# The Claude version is ~4.3KB of system prompt; this one is inline in the user
# turn where budget is tighter, so it is condensed rather than byte-mirrored.
# These four are the ones grounded in the user research and must not be lost.
for k in "BUILD IT FULLY" "WIRE IT" "VERIFY BY RUNNING" "ONE specific design"; do
    if grep -q "$k" "$RUN_SH"; then
        ok "kept: $k"
    else
        bad "dropped from the condensed directive: $k"
    fi
done

# --- 6. Syntax --------------------------------------------------------------
if bash -n "$RUN_SH" 2>/dev/null; then
    ok "run.sh parses"
else
    bad "run.sh has a syntax error"
fi

# --- 7. House style ---------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$RUN_SH" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
