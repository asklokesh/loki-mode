#!/usr/bin/env bash
# Startup must be measurable, not a silent gap before the user sees anything.
#
# MEASURED ON A REAL RUN. Between `session_start` and `iteration_start`:
#
#     +   0s  session
#     +  17s  session_start
#     + 128s  iteration_start      <-- 111 seconds unaccounted for
#     + 872s  iteration_complete
#
# Over two minutes in which the user sees nothing and NO agent work has begun,
# and `.loki/events.jsonl` recorded not one stage for any of it. `grep -c
# 'emit_stage_complete "(startup|preflight|init)'` returned 0.
#
# WHY IT MATTERS. This is the felt-latency surface: time-to-first-signal on the
# same real run was 744s, against Replit's ~2 minutes to a visible preview. You
# cannot shorten an interval you cannot attribute -- the same gap W1 fixed for
# cost, on the surface a user notices first.
#
# `spec_interrogation_run` calls the PROVIDER during startup, making it the
# prime suspect for the bulk of that window. Naming it turns "startup is slow"
# into a number, exactly as stage timings turned "the run is slow" into "the
# agent call is 93% of wall clock".
#
# This asserts the instrumentation exists and emits through the EXISTING
# channel, so measure-run.sh and every other consumer pick it up with no new
# plumbing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: startup instrumentation"

# --- the slow startup step is timed -------------------------------------------
if grep -q 'emit_stage_complete "spec_interrogation"' "$RUN_SH"; then
    ok "spec interrogation emits a stage timing"
else
    bad "spec interrogation is untimed -- the startup window stays unattributable"
fi

# The timer must be started BEFORE the call, or the duration is meaningless.
_blk="$(grep -B4 'emit_stage_complete "spec_interrogation"' "$RUN_SH")"
case "$_blk" in
    *'_si_t0=$(date +%s'*) ok "the start epoch is captured before the call" ;;
    *) bad "no start epoch before spec_interrogation_run -- duration would be wrong" ;;
esac
case "$_blk" in
    *'spec_interrogation_run "$prd_path"'*)
        ok "the timing brackets the real call, not something else" ;;
    *) bad "the timing does not wrap spec_interrogation_run" ;;
esac

# --- it must not break the run ------------------------------------------------
# Startup instrumentation that can abort startup is worse than none. The
# existing emitter already returns 0 on any failure; the call site adds
# `|| true` on top.
case "$_blk" in
    *'|| true'*) ok "the emit cannot fail the startup path" ;;
    *) bad "an emit failure could abort startup" ;;
esac

# --- the emitter really produces a duration ----------------------------------
# Drive the REAL function rather than trusting its shape.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-startup-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
sed -n '/^emit_stage_complete()/,/^}/p' "$RUN_SH" > "$SCRATCH/fn.sh"
cat >> "$SCRATCH/fn.sh" <<'EOF'
emit_event_json(){ local t="$1"; shift; printf '%s %s\n' "$t" "$*"; }
emit_stage_complete "spec_interrogation" "pass" "$(( $(date +%s) - 42 ))"
EOF
_out="$(bash "$SCRATCH/fn.sh" 2>&1)"
case "$_out" in
    *"stage=spec_interrogation"*) ok "the stage name reaches the event" ;;
    *) bad "stage name missing from the emitted event: $_out" ;;
esac
# 42 OR 43, and the second value is not slack -- it is the only correct
# answer when the clock ticks mid-test.
#
# `$(date +%s) - 42` is evaluated when the heredoc line runs;
# emit_stage_complete reads `now` a moment later. If the second rolls over
# between those two points the true elapsed time IS 43, and pinning 42 makes
# the test fail for being right. Rare on an idle laptop, likely on a loaded
# CI runner -- which is exactly where it fired: shard 2 reported the
# mutation-probe BASELINE failing (rc67) while this suite passed 8/8 locally.
#
# Reproduced deterministically before changing anything, by forcing the tick:
#   _t0=$(( $(date +%s) - 42 ))
#   while [ "$(date +%s)" = "$(( _t0 + 42 ))" ]; do sleep 0.05; done
#   emit_stage_complete ... "$_t0"   ->  duration_s=43, every time
#
# THE INVARIANT IS UNCHANGED. This still asserts that a real start epoch
# produces a real elapsed duration. It does NOT widen toward zero: a
# fabricated duration_s=0 from a missing epoch still fails here, and the
# separate "missing start epoch emits NOTHING" case below is untouched.
case "$_out" in
    *"duration_s=42"*|*"duration_s=43"*)
        ok "the elapsed seconds are computed correctly" ;;
    *) bad "duration not computed (expected 42 or 43): $_out" ;;
esac

# A missing start epoch must emit NOTHING rather than a fabricated 0. An
# invented duration is worse than an absent one -- it would be averaged into
# any later analysis as real data.
cat > "$SCRATCH/fn2.sh" <<'EOF'
emit_event_json(){ local t="$1"; shift; printf '%s %s\n' "$t" "$*"; }
EOF
sed -n '/^emit_stage_complete()/,/^}/p' "$RUN_SH" >> "$SCRATCH/fn2.sh"
echo 'emit_stage_complete "spec_interrogation" "pass" ""' >> "$SCRATCH/fn2.sh"
_empty="$(bash "$SCRATCH/fn2.sh" 2>&1)"
if [ -z "$_empty" ]; then
    ok "a missing start epoch emits nothing (no fabricated duration)"
else
    bad "emitted a duration with no start epoch: $_empty"
fi

# --- the consumer picks it up with no new plumbing ---------------------------
if grep -q 'stage_complete' "$REPO_ROOT/scripts/measure-run.sh"; then
    ok "measure-run.sh reads the same channel (no new plumbing needed)"
else
    bad "measure-run.sh does not read stage_complete -- the timing is invisible"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
