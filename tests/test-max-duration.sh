#!/usr/bin/env bash
# LOKI_MAX_DURATION must stop a run that has exceeded its wall-clock cap.
#
# WHY A THIRD BOUND EXISTS. Spend was capped (LOKI_BUDGET_LIMIT) and iterations
# were capped (LOKI_MAX_ITERATIONS), but a run that STALLS is bounded by
# neither: a hung provider call or a wedged subprocess burns hours while
# spending almost nothing and completing no iteration, so neither existing
# breaker trips. This project has already paid for that shape once -- a run
# burned $34 to an external timeout because the safety valve was watching a
# signal the default path no longer emitted.
#
# An external kill (activeDeadlineSeconds, a CI job timeout) does stop the
# process, but it SIGKILLs it: no terminal status is written, so the receipt
# cannot say what happened and the platform sees a crash rather than a
# deliberate stop. This cap stops the loop cleanly at an iteration boundary.
#
# TESTED WITHOUT A PAID RUN. check_max_duration is a pure function of two
# values -- the cap and the run's start epoch -- so it is exercised directly by
# setting those. Starting a real build and waiting for a timeout would cost
# money and take as long as the cap.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Extract the function under test. Sourcing all of run.sh would execute the
# runner; this repo's quoted heredocs also make arbitrary slices unbalanced, so
# the slice is bounded to this one self-contained function.
probe() {
    local cap="$1" start="$2"
    env LOKI_MAX_DURATION="$cap" _LOKI_RUN_START_EPOCH="$start" bash -c '
        log_warn() { printf "WARN %s\n" "$*"; }
        eval "$(sed -n "/^check_max_duration()/,/^}/p" "$0")"
        if check_max_duration; then echo "STOP"; else echo "CONTINUE"; fi
    ' "$RUN_SH" 2>&1
}

now="$(date +%s)"

# No cap configured: today's behavior, never stops. This is the default, so
# getting it wrong would halt every existing run.
case "$(probe "" "$now")" in
    *CONTINUE*) ok "no cap set -> never stops (default behavior preserved)" ;;
    *) bad "an unset cap stopped the run -- every existing build would break" ;;
esac

case "$(probe 0 "$now")" in
    *CONTINUE*) ok "cap of 0 means unlimited, not 'stop immediately'" ;;
    *) bad "a cap of 0 stopped the run; 0 must mean no cap" ;;
esac

# A non-numeric value must not silently become a cap. Fail open here: a typo in
# a pipeline config should not halt builds at an arbitrary time.
case "$(probe "abc" "$now")" in
    *CONTINUE*) ok "a non-numeric cap is ignored rather than guessed at" ;;
    *) bad "a non-numeric cap was interpreted as a real limit" ;;
esac

# Under the cap: keep going.
case "$(probe 3600 "$((now - 60))")" in
    *CONTINUE*) ok "60s elapsed against a 3600s cap -> continues" ;;
    *) bad "stopped well under the cap" ;;
esac

# Over the cap: stop. The assertion this whole file exists for.
out="$(probe 300 "$((now - 400))")"
case "$out" in
    *STOP*) ok "400s elapsed against a 300s cap -> stops" ;;
    *) bad "the cap did NOT fire when exceeded -- a stalled run would still be unbounded" ;;
esac

# Exactly at the cap counts as reached, not as one second short.
case "$(probe 300 "$((now - 300))")" in
    *STOP*) ok "elapsed exactly equal to the cap stops (>= not >)" ;;
    *) bad "a run exactly at its cap kept going" ;;
esac

# The operator has to be able to tell WHY it stopped. A silent halt costs the
# investigation the cap was supposed to prevent.
case "$out" in
    *"Wall-clock cap reached"*) ok "the stop is explained in the log" ;;
    *) bad "the run stopped without saying why" ;;
esac

# The terminal status must be distinct. Reusing max_iterations_reached would
# tell the operator to raise the wrong limit.
if grep -q 'save_state "$retry" "max_duration_reached" 20' "$RUN_SH"; then
    ok "writes a distinct max_duration_reached terminal status"
else
    bad "no distinct terminal status -- the receipt cannot say the run ran out of TIME"
fi

# ...and that status must map to exit 20 in the ENT-3 contract, or the platform
# treats a deliberate stop as a retryable crash and re-runs it into the same wall.
if grep -qE '^\s+failed\|max_iterations_reached\|.*max_duration_reached.*\)' "$RUN_SH"; then
    ok "max_duration_reached maps to exit 20 (deterministic, do not retry)"
else
    bad "max_duration_reached is missing from the terminal-failure arm -- k8s would retry it"
fi

# Both routes must agree; a status only bash knows is a parity gap.
if grep -q '"max_duration_reached"' "$REPO_ROOT/loki-ts/src/runner/autonomous.ts"; then
    ok "the Bun route maps max_duration_reached identically"
else
    bad "the Bun route does not know max_duration_reached -- routes disagree"
fi

# CLI surface: suffixes are accepted because an operator thinks in minutes and
# hours, and forcing them to compute 7200 invites an off-by-3600 error.
help_out="$("$LOKI" start --help </dev/null 2>&1 || true)"
case "$help_out" in
    *"--max-duration"*) ok "start --help documents --max-duration" ;;
    *) bad "--max-duration is undocumented" ;;
esac

bad_out="$("$LOKI" start --max-duration 0 </dev/null 2>&1 || true)"
case "$bad_out" in
    *"positive duration"*) ok "--max-duration 0 is rejected with a usable message" ;;
    *) bad "--max-duration 0 was accepted silently" ;;
esac

bad_out="$("$LOKI" start --max-duration nonsense </dev/null 2>&1 || true)"
case "$bad_out" in
    *"positive duration"*) ok "a non-numeric --max-duration is rejected" ;;
    *) bad "a non-numeric --max-duration was accepted" ;;
esac

# === WIRING: the safety valves must stay connected to the loop ===============
# Everything above tests check_max_duration's own logic. That proves the
# FUNCTION and says nothing about whether the iteration loop still calls it.
#
# All three valves were blind to disconnection, found by mutation probe. They
# are the only things that stop a run on its own: without them a build spends
# and runs until something external kills it. Asserted as a group because they
# are one family, and a fourth valve added without a call-site assertion is this
# hole again.
for _valve in check_budget_limit check_max_iterations check_max_duration; do
    # Count, do not just detect. check_max_iterations is called TWICE -- once
    # before the loop and once inside it -- and a grep that passes on either one
    # left the in-loop site disconnectable while reporting green. Pin the exact
    # count so removing one occurrence fails.
    _want=1
    [ "$_valve" = "check_max_iterations" ] && _want=2
    _got="$(grep -cE "if $_valve; then" "$RUN_SH")"
    if [ "${_got:-0}" -eq "$_want" ]; then
        ok "WIRING: the loop consults $_valve at all $_want call site(s)"
    else
        bad "WIRING: $_valve has $_got of $_want call sites -- a run may not stop on its own"
    fi

    if grep -qF "$_valve()" "$RUN_SH"; then
        ok "WIRING: $_valve is defined under the name the loop calls"
    else
        bad "WIRING: $_valve definition and call site have diverged"
    fi
done

# Each valve must still record its OWN terminal status, or a run that stopped on
# time reports as one that stopped on cost, and `loki why` misdiagnoses it.
for _pair in "budget_exceeded" "max_iterations_reached" "max_duration_reached"; do
    if grep -qF "\"$_pair\"" "$RUN_SH"; then
        ok "WIRING: $_pair is still a distinct terminal status"
    else
        bad "WIRING: $_pair no longer recorded -- stop reasons would be indistinguishable"
    fi
done


printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
