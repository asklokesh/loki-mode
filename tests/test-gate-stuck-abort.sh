#!/usr/bin/env bash
# A gate that keeps failing for the SAME reason must stop the run, not iterate.
#
# F0 in docs/FIRST-PASS-COMPLETION-PLAN.md, and the item that would have saved
# the founder's FireLater run.
#
# MEASURED: FireLater spent 3 iterations against mutation_integrity, which failed
# in 0-1 SECONDS each time with the identical line:
#
#   [HIGH] mutation detector unavailable: .../tests/detect-test-mutations.sh
#
# The detector was never packaged (fixed v8.38.0), so the gate could NEVER pass.
# The run was doomed at iteration 1, and the loop just kept going -- burning
# paid provider calls to re-derive the same verdict.
#
# THE DISTINCTION THIS TURNS ON. "Failed 3 times" is not the signal; a gate
# failing three times for three DIFFERENT reasons is the loop WORKING -- the
# agent fixes one thing and finds the next. Only an UNCHANGING reason means no
# progress is possible. Both directions are asserted, and the "changed reason
# keeps iterating" case is the one that protects healthy runs.
#
# FAIL-SAFE DIRECTION: on any doubt (missing file, unreadable, first sighting,
# below threshold) the helper returns "not stuck" and the run continues exactly
# as before. It can only ever SHORTEN a doomed run, never stop a healthy one,
# and it never declares success -- it maps to a terminal FAILURE exit.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: a stuck gate aborts instead of grinding"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-stuck-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Extract the real helper. Self-contained, so a bounded slice is safe.
HARNESS="$SCRATCH/fn.sh"
sed -n '/^_loki_gate_stuck()/,/^}/p' "$RUN_SH" > "$HARNESS"
if ! grep -q '_loki_gate_stuck()' "$HARNESS"; then
    bad "could not extract _loki_gate_stuck; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "extracted the real helper from run.sh"

# probe <count> <reason> [env...] -> "STUCK" | "CONTINUE"
probe() {
    local count="$1" reason="$2"; shift 2
    env "$@" TARGET_DIR="$SCRATCH" bash -c '
        . "$1"
        R="$2/.loki/quality/r.txt"
        mkdir -p "$(dirname "$R")"
        printf "%s\n" "$3" > "$R"
        if _loki_gate_stuck testgate "$R" "$4"; then echo STUCK; else echo CONTINUE; fi
    ' _ "$HARNESS" "$SCRATCH" "$reason" "$count"
}

reset_state() { rm -f "$SCRATCH/.loki/quality/gate-stuck-testgate.last" 2>/dev/null || true; }

# --- below threshold: always continue ---------------------------------------
reset_state
[ "$(probe 1 'SAME')" = "CONTINUE" ] \
    && ok "count below threshold keeps iterating" \
    || bad "aborted on a first failure -- would kill healthy runs"

# --- first sighting at threshold: continue (no prior to compare) -------------
reset_state
[ "$(probe 3 'SAME')" = "CONTINUE" ] \
    && ok "the first sighting of a reason keeps iterating" \
    || bad "aborted without ever having seen the reason before"

# --- identical reason repeats: ABORT ----------------------------------------
# probe() above already recorded 'SAME'; a second identical call is the real
# stuck signal.
[ "$(probe 3 'SAME')" = "STUCK" ] \
    && ok "an identical repeated reason aborts" \
    || bad "a gate failing 3x for the SAME reason still iterates -- the FireLater bug"

# --- THE PROTECTIVE CASE: a changed reason keeps iterating ------------------
# This is what separates "no progress possible" from "the loop is working".
[ "$(probe 4 'A DIFFERENT CAUSE')" = "CONTINUE" ] \
    && ok "a CHANGED reason keeps iterating (progress is being made)" \
    || bad "aborted although the failure reason changed -- kills a working loop"

# --- THE REAL SEQUENCE: abort must land ON the threshold iteration -----------
# Regression from the first implementation. The reason was recorded only AFTER
# the threshold check, so the first comparison could not happen until
# count == threshold+1: with threshold 3 the abort fired at iteration 4.
#
# The FireLater run that motivated this whole feature ended at iteration 3, so
# the valve would have missed the exact case it was built for -- by one
# iteration. Caught only by replaying the preserved artifact; the synthetic
# unit cases above drove counts out of order and never saw it.
reset_state
_fired=""
for _i in 1 2 3; do
    if [ "$(probe "$_i" 'UNFIXABLE CAUSE')" = "STUCK" ]; then _fired="$_i"; break; fi
done
if [ "$_fired" = "3" ]; then
    ok "abort fires ON the threshold iteration (3), not one past it"
elif [ -z "$_fired" ]; then
    bad "never aborted across the real 3-iteration sequence -- FireLater would still grind"
else
    bad "aborted at iteration $_fired, expected 3"
fi

# --- JSON artifacts: compare the CAUSE, not the whole file -------------------
# static_analysis records its reason in static-analysis.json, which also carries
# a timestamp that differs on EVERY run. A whole-file compare would therefore
# never match and the valve would be silently dead on this gate -- passing every
# test that only exercises the plain-text shape.
#
# Verified against the real FireLater static-analysis.json: the extracted cause
# is the `summary` field ("Syntax error: docker-stop.sh. shellcheck ...").
_j="$SCRATCH/.loki/quality/sa.json"
mkjson() { printf '{"timestamp":"%s","summary":"%s","pass":false}\n' "$1" "$2" > "$_j"; }
jprobe() {
    env TARGET_DIR="$SCRATCH" bash -c '
        . "$1"
        if _loki_gate_stuck sagate "$2" "$3"; then echo STUCK; else echo CONTINUE; fi
    ' _ "$HARNESS" "$_j" "$1"
}
rm -f "$SCRATCH/.loki/quality/gate-stuck-sagate.last" 2>/dev/null || true

mkjson 2026-08-01T01:00:00Z "Syntax error: a.sh."; jprobe 1 >/dev/null
mkjson 2026-08-01T02:00:00Z "Syntax error: a.sh."; jprobe 2 >/dev/null
mkjson 2026-08-01T03:00:00Z "Syntax error: a.sh."
[ "$(jprobe 3)" = "STUCK" ] \
    && ok "a churning timestamp does not defeat the JSON cause compare" \
    || bad "the JSON compare is defeated by the timestamp -- the valve is dead on this gate"

mkjson 2026-08-01T04:00:00Z "A DIFFERENT error: b.sh."
[ "$(jprobe 4)" = "CONTINUE" ] \
    && ok "a changed JSON cause keeps iterating" \
    || bad "aborted although the JSON cause changed"

# --- THE HEADER TRAP: compare a real finding, never the banner ---------------
# Found by a REAL run, not by these tests. mutation-findings.txt and
# mock-findings.txt both open with a static banner ("# Test mutation findings
# (HIGH blocks this iteration)") that is byte-identical every run. The first
# implementation compared head -1, so it recorded the BANNER as the cause --
# meaning two completely different findings compared equal and the valve would
# abort a run that was making real progress. That is the one direction this
# valve must never fail in.
reset_state
_hdr="$SCRATCH/.loki/quality/hdr.txt"
hwrite() { printf '# Test mutation findings (HIGH blocks this iteration)\n%s\n' "$1" > "$_hdr"; }
hprobe() {
    env TARGET_DIR="$SCRATCH" bash -c '
        . "$1"
        if _loki_gate_stuck hgate "$2" "$3"; then echo STUCK; else echo CONTINUE; fi
    ' _ "$HARNESS" "$_hdr" "$1"
}
rm -f "$SCRATCH/.loki/quality/gate-stuck-hgate.last" 2>/dev/null || true

hwrite "[HIGH] fileA.ts:1 - problem A"; hprobe 3 >/dev/null
hwrite "[HIGH] fileB.ts:9 - a COMPLETELY different problem"
[ "$(hprobe 3)" = "CONTINUE" ] \
    && ok "different findings under the same banner keep iterating" \
    || bad "the banner is being compared, not the finding -- aborts a progressing run"

hwrite "[HIGH] fileB.ts:9 - a COMPLETELY different problem"
[ "$(hprobe 3)" = "STUCK" ] \
    && ok "an identical finding under the banner still aborts" \
    || bad "a genuinely repeated finding no longer aborts"

# --- fail-safe: missing/unreadable inputs never abort ------------------------
reset_state
_missing="$(env TARGET_DIR="$SCRATCH" bash -c '
    . "$1"
    if _loki_gate_stuck testgate "$2/nope.txt" 9; then echo STUCK; else echo CONTINUE; fi
' _ "$HARNESS" "$SCRATCH")"
[ "$_missing" = "CONTINUE" ] \
    && ok "a missing reason file never aborts" \
    || bad "aborted on a missing reason file -- fail-safe direction inverted"

reset_state
: > "$SCRATCH/.loki/quality/empty.txt"
_empty="$(env TARGET_DIR="$SCRATCH" bash -c '
    . "$1"
    if _loki_gate_stuck testgate "$2/.loki/quality/empty.txt" 9; then echo STUCK; else echo CONTINUE; fi
' _ "$HARNESS" "$SCRATCH")"
[ "$_empty" = "CONTINUE" ] \
    && ok "an empty reason file never aborts" \
    || bad "aborted on an empty reason -- cannot know the cause is unchanged"

# --- the opt-out must win ----------------------------------------------------
reset_state
probe 3 'SAME' >/dev/null                       # prime the prior
[ "$(probe 3 'SAME' LOKI_GATE_STUCK_ABORT=0)" = "CONTINUE" ] \
    && ok "LOKI_GATE_STUCK_ABORT=0 disables the abort" \
    || bad "the opt-out does not work"

# --- WIRING ------------------------------------------------------------------
if grep -q '_loki_gate_stuck "mutation_integrity"' "$RUN_SH"; then
    ok "WIRING: the mutation gate consults the stuck check"
else
    bad "WIRING: nothing calls _loki_gate_stuck -- FireLater would still grind"
fi

# The check must be wired to EVERY gate that has caused an extra iteration
# here, not just the first one it was built for. Measured: mutation_integrity
# (FireLater x3) and static_analysis (FireLater x1) both did. code_review also
# did (FireLater x2, anonima x1) but persists no single comparable cause, so it
# is deliberately not wired -- see the plan.
for _g in mutation_integrity static_analysis; do
    if grep -q "_loki_gate_stuck \"$_g\"" "$RUN_SH"; then
        ok "WIRING: $_g consults the stuck check"
    else
        bad "WIRING: $_g does not consult the stuck check -- it can still grind"
    fi
done

# It must be a TERMINAL FAILURE, never a success. A stuck gate that exits 0
# would report a doomed run as done -- strictly worse than grinding.
_call="$(grep -A12 '_loki_gate_stuck "mutation_integrity"' "$RUN_SH")"
case "$_call" in
    *"return 20"*) ok "a stuck gate returns the terminal-failure code (20)" ;;
    *) bad "a stuck gate does not return 20 -- it must never look like success" ;;
esac
case "$_call" in
    *'save_state'*'gate_stuck_mutation_integrity'*)
        ok "the terminal status names the stuck gate" ;;
    *) bad "the run stops without recording WHY" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
