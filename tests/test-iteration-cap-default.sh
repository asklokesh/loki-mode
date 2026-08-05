#!/usr/bin/env bash
# The runaway ceiling must be bounded, without truncating anyone's real run.
#
# F4 in docs/FIRST-PASS-COMPLETION-PLAN.md.
#
# MEASURED, not chosen. Real per-iteration wall clock across every recorded run
# on this machine: median 718s, max 1746s. So the previous default of 1000 was
# an 8.3-DAY ceiling -- and it was the ONLY backstop, because the other two
# valves ship disabled:
#
#   LOKI_BUDGET_LIMIT  defaults to ""  -> check_budget_limit returns immediately
#   LOKI_MAX_DURATION  defaults to 0   -> check_max_duration "never stop"
#
# It also contradicted our own docs: SETUP.md tells users to RAISE the budget
# for large work with LOKI_MAX_ITERATIONS=40, and the demo uses 10 -- so the
# shipped default was 25x the documented "large" value.
#
# WHAT REAL RUNS USE: 1, 1, 3, 4 iterations. Every one terminated `completed`
# via council approval or a completion promise; NONE hit a cap. 25 is therefore
# 6x the observed maximum -- deliberately generous, because the research is
# explicit that a too-small cap fails runs whose approach was sound (1-2 caps
# fail even when the agent was on track; 5-10 is the recommended range).
#
# THE TWO GUARDS ARE THE POINT, and both are failure directions that matter:
#   - an explicit LOKI_MAX_ITERATIONS must ALWAYS win, or this silently changes
#     behaviour for anyone who already tuned it
#   - PERPETUAL_MODE must be UNTOUCHED: it deliberately ignores every completion
#     signal and relies on max-iterations as its only stop, so lowering the cap
#     there would truncate exactly the runs that opted out of stopping

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: iteration cap default"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-itercap-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Reproduce the resolution chain exactly as run.sh evaluates it. The WIRING
# assertions below pin this to the original, because a re-implementation tests
# the rule and only the source tests the code.
# EXTRACTED FROM run.sh, not hand-copied. A static copy of the resolution chain
# passes even when run.sh's guards are removed -- the mutation that overrode an
# explicit LOKI_MAX_ITERATIONS=200 down to 25 SURVIVED against a copy, because
# the mutation edits run.sh and the copy never changed. Slice the real lines.
_s="$(grep -n '^COMPLETION_PROMISE=' "$RUN_SH" | head -1 | cut -d: -f1)"
_e="$(grep -n 'LOKI_MAX_ITERATIONS_DEFAULT:-' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -z "$_s" ] || [ -z "$_e" ]; then
    bad "could not locate the cap resolution chain in run.sh; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
{ sed -n "${_s},$((_e + 1))p" "$RUN_SH"; echo 'echo "$MAX_ITERATIONS"'; } > "$SCRATCH/probe.sh"
ok "extracted the real cap-resolution chain from run.sh"

cap() { env "$@" bash "$SCRATCH/probe.sh"; }

# --- the ordinary run is bounded ---------------------------------------------
_d="$(cap)"
if [ "$_d" -le 40 ] 2>/dev/null && [ "$_d" -ge 10 ] 2>/dev/null; then
    ok "an ordinary run is bounded ($_d), within the researched 5-40 range"
else
    bad "the default is $_d -- outside a defensible range"
fi

# 1000 at a measured 718s median is 8.3 days. Whatever the number is, it must
# not be that.
[ "$_d" -lt 100 ] 2>/dev/null \
    && ok "the default is not a multi-day runaway ceiling" \
    || bad "the default ($_d) still allows a multi-day runaway"

# --- an explicit setting ALWAYS wins -----------------------------------------
# Both directions: below and above the new default. Someone who tuned this must
# see no change whatsoever.
[ "$(cap LOKI_MAX_ITERATIONS=200)" = "200" ] \
    && ok "an explicit higher value is honoured" \
    || bad "an explicit LOKI_MAX_ITERATIONS=200 was overridden"
[ "$(cap LOKI_MAX_ITERATIONS=2)" = "2" ] \
    && ok "an explicit lower value is honoured" \
    || bad "an explicit LOKI_MAX_ITERATIONS=2 was overridden"

# --- PERPETUAL MODE MUST BE UNTOUCHED ----------------------------------------
# The one that would cause real harm. Perpetual mode ignores every completion
# signal by design and relies on max-iterations as its ONLY stop.
[ "$(cap LOKI_PERPETUAL_MODE=true)" = "1000" ] \
    && ok "perpetual mode keeps the high ceiling (it has no other stop)" \
    || bad "perpetual mode was truncated to $(cap LOKI_PERPETUAL_MODE=true) -- silently ends runs that opted out of stopping"

# --- auto-fix keeps its own tuned value --------------------------------------
[ "$(cap LOKI_AUTO_FIX=true)" = "5" ] \
    && ok "auto-fix keeps its existing 5" \
    || bad "auto-fix default changed to $(cap LOKI_AUTO_FIX=true)"

# --- the new default is itself tunable ---------------------------------------
[ "$(cap LOKI_MAX_ITERATIONS_DEFAULT=40)" = "40" ] \
    && ok "LOKI_MAX_ITERATIONS_DEFAULT retunes it without code changes" \
    || bad "the new default cannot be retuned"

# --- hitting the cap must FAIL honestly, never look like success -------------
# A bounded cap is only safe if reaching it is reported as a failure. If it
# exited 0 the change would convert long runs into fake successes, which is
# strictly worse than the runaway it replaces.
_term="$(grep -A2 'emit_completion_summary max_iterations' "$RUN_SH" | head -3)"
case "$_term" in
    *'save_state'*'max_iterations_reached'*20*)
        ok "hitting the cap records max_iterations_reached with exit 20" ;;
    *) bad "hitting the cap no longer fails honestly -- a bounded cap would fake success" ;;
esac

# --- WIRING ------------------------------------------------------------------
if grep -q 'LOKI_MAX_ITERATIONS_DEFAULT:-25' "$RUN_SH"; then
    ok "WIRING: run.sh carries the bounded default"
else
    bad "WIRING: the bounded default is not in run.sh"
fi
if grep -q '\[ "$PERPETUAL_MODE" != "true" \]' "$RUN_SH"; then
    ok "WIRING: run.sh guards perpetual mode"
else
    bad "WIRING: the perpetual-mode guard is gone -- perpetual runs would be truncated"
fi
if grep -q '\[ -z "${LOKI_MAX_ITERATIONS:-}" \]' "$RUN_SH"; then
    ok "WIRING: run.sh only applies the default when nothing was set"
else
    bad "WIRING: the explicit-setting guard is gone -- user settings would be overridden"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
