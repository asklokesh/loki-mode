#!/usr/bin/env bash
# Test: RANK 15 -- lower the no-claim council convergence floor.
#
# The convergence-detection path (NO explicit completion claim) historically only
# evaluated on the CHECK_INTERVAL boundary (every 5th iteration). A no-promise /
# analysis run that is verifiably done at iteration 2 still ground to iteration 5
# before the council was even allowed to look. The RANK-15 change lets that path
# evaluate as soon as there is AFFIRMATIVE evidence of done (a real test suite
# passed, and the checklist -- if present -- is not failing), gated behind
# MIN_ITERATIONS and the LOKI_COUNCIL_CONVERGENCE_EARLY knob.
#
# This sources the REAL helpers from completion-council.sh so it cannot drift.
# It drives the pure decision helper _council_should_check_now directly (no need
# to spin a 3-member vote): that helper is exactly the WHEN-to-evaluate gate.
#
# Proven directions:
#   POSITIVE : no-claim, iter 2 (off the 5-interval), MIN=1, affirmative test-green
#              -> _council_should_check_now returns 0 (evaluate NOW).
#              RED before the change (no early bypass existed -> returns 1).
#   NEGATIVE-A (unverified): same iter, NO test-results file (no evidence)
#              -> stays 1 (does NOT fast-path). Green before AND after.
#   NEGATIVE-B (inconclusive): test-results present but runner=="none"
#              -> stays 1 (absence of a real suite is not affirmative green).
#              Green before AND after (proves we did not weaken safety).
#   NEGATIVE-C (red tests): test-results present, pass==false
#              -> stays 1. Green before AND after.
#   CADENCE   : no-claim, iter 5 (ON interval), no evidence -> still 0 (unchanged).
#   MIN-GUARD : no-claim, iter 2, MIN=3, affirmative green -> stays 1 (below floor).
#   OPT-OUT   : LOKI_COUNCIL_CONVERGENCE_EARLY=0 + affirmative green + iter 2
#              -> stays 1 (historical interval-only restored).
#   CLAIM     : explicit-claim path timing UNCHANGED (iter 7, claimed) -> 0,
#              and iter 7 unclaimed no-evidence -> 1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find $COUNCIL_SH"
    exit 1
fi

# Quiet, side-effect-free logging stubs so sourcing is silent.
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_debug() { :; }
log_header() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true

if ! type _council_should_check_now >/dev/null 2>&1; then
    echo "FAIL: _council_should_check_now not defined after sourcing $COUNCIL_SH"
    echo "      (RED state: the RANK-15 convergence-floor helper is missing)"
    exit 1
fi
if ! type _council_convergence_evidence_green >/dev/null 2>&1; then
    echo "FAIL: _council_convergence_evidence_green not defined after sourcing"
    exit 1
fi
if ! type _council_effective_min_iter >/dev/null 2>&1; then
    echo "FAIL: _council_effective_min_iter not defined after sourcing"
    echo "      (RED state: the SaaS-#122 tier-aware floor helper is missing)"
    exit 1
fi

PASS=0
FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-conv-floor.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.loki/quality" "$WORK/.loki/checklist"
TARGET_DIR="$WORK"

# Deterministic council config for the decision helper.
COUNCIL_ENABLED=true
COUNCIL_CHECK_INTERVAL=5

# --- evidence fixtures -------------------------------------------------------
write_green_tests() {
    cat > "$WORK/.loki/quality/test-results.json" <<'JSON'
{ "runner": "jest", "pass": true, "total": 12, "passed": 12, "failed": 0 }
JSON
}
write_notests() {
    cat > "$WORK/.loki/quality/test-results.json" <<'JSON'
{ "runner": "none", "pass": true }
JSON
}
write_red_tests() {
    cat > "$WORK/.loki/quality/test-results.json" <<'JSON'
{ "runner": "jest", "pass": false, "total": 12, "passed": 8, "failed": 4 }
JSON
}
clear_tests()  { rm -f "$WORK/.loki/quality/test-results.json"; }
clear_checklist() { rm -f "$WORK/.loki/checklist/verification-results.json"; }
write_passing_checklist() {
    cat > "$WORK/.loki/checklist/verification-results.json" <<'JSON'
{ "categories": [ { "items": [ { "id": "a1", "priority": "critical", "status": "passing" } ] } ] }
JSON
}
write_failing_checklist() {
    cat > "$WORK/.loki/checklist/verification-results.json" <<'JSON'
{ "categories": [ { "items": [ { "id": "a1", "priority": "critical", "status": "failing" } ] } ] }
JSON
}

# check_now <circuit> <claim>: run the pure helper, echo its rc (0=check,1=skip)
check_now() {
    if _council_should_check_now "$1" "$2"; then echo 0; else echo 1; fi
}

# === POSITIVE: no-claim, off-interval, affirmative green -> evaluate NOW =======
clear_checklist
write_green_tests
COUNCIL_MIN_ITERATIONS=1
ITERATION_COUNT=2
LOKI_COUNCIL_CONVERGENCE_EARLY=1
r=$(check_now false false)
[ "$r" = "0" ] && ok "POSITIVE: no-claim iter 2 off-interval + affirmative test-green -> evaluate NOW (the fix)" \
               || bad "POSITIVE: expected evaluate-now (0), got $r"

# affirmative green + a PASSING checklist also present -> still evaluate now
write_passing_checklist
r=$(check_now false false)
[ "$r" = "0" ] && ok "POSITIVE: green tests + passing checklist -> evaluate NOW" \
               || bad "POSITIVE(checklist): expected 0, got $r"
clear_checklist

# DEFAULT-CONFIG headline: stock MIN=3 / INTERVAL=5, a genuinely-done no-promise
# run at iter 3 (off the 5-boundary) now evaluates instead of grinding to iter 5.
# This maps 1:1 to AC #1 ("stop before iteration 5") at the shipped defaults.
# RED before the change: 3 % 5 != 0 and no early bypass -> returns 1 (grinds on).
COUNCIL_MIN_ITERATIONS=3
ITERATION_COUNT=3
r=$(check_now false false)
[ "$r" = "0" ] && ok "POSITIVE(default config): MIN=3/INTERVAL=5, green, iter 3 -> evaluate NOW (was: wait to iter 5)" \
               || bad "POSITIVE(default config): expected 0 at iter 3, got $r"
COUNCIL_MIN_ITERATIONS=1

# === NEGATIVE-A: no evidence at all -> does NOT fast-path (unverified) =========
clear_tests
clear_checklist
r=$(check_now false false)
[ "$r" = "1" ] && ok "NEGATIVE-A: no test-results file (no evidence) -> does NOT fast-path" \
               || bad "NEGATIVE-A: unverified run fast-pathed (got $r) -- SAFETY WEAKENED"

# === NEGATIVE-B: inconclusive (runner==none) -> does NOT fast-path ============
write_notests
r=$(check_now false false)
[ "$r" = "1" ] && ok "NEGATIVE-B: runner==none (no real suite) -> does NOT fast-path (inconclusive != green)" \
               || bad "NEGATIVE-B: no-suite run fast-pathed (got $r) -- SAFETY WEAKENED"

# === NEGATIVE-C: red tests -> does NOT fast-path =============================
write_red_tests
r=$(check_now false false)
[ "$r" = "1" ] && ok "NEGATIVE-C: pass==false (red tests) -> does NOT fast-path" \
               || bad "NEGATIVE-C: red run fast-pathed (got $r) -- SAFETY WEAKENED"

# green tests but FAILING checklist -> does NOT fast-path
write_green_tests
write_failing_checklist
r=$(check_now false false)
[ "$r" = "1" ] && ok "NEGATIVE-C2: green tests + failing checklist -> does NOT fast-path" \
               || bad "NEGATIVE-C2: failing checklist fast-pathed (got $r) -- SAFETY WEAKENED"
clear_checklist

# === CADENCE: on-interval with no evidence still evaluates (unchanged) ========
clear_tests
COUNCIL_MIN_ITERATIONS=3
ITERATION_COUNT=5
r=$(check_now false false)
[ "$r" = "0" ] && ok "CADENCE: no-claim on-interval (iter 5) -> evaluates (interval path unchanged)" \
               || bad "CADENCE: on-interval did not evaluate (got $r)"

# off-interval, no evidence, default cadence -> does NOT evaluate (unchanged)
ITERATION_COUNT=7
r=$(check_now false false)
[ "$r" = "1" ] && ok "CADENCE: no-claim off-interval no-evidence (iter 7) -> does NOT evaluate (unchanged)" \
               || bad "CADENCE: off-interval no-evidence wrongly evaluated (got $r)"

# === MIN-GUARD: affirmative green but below MIN_ITERATIONS -> does NOT fire ====
write_green_tests
COUNCIL_MIN_ITERATIONS=3
ITERATION_COUNT=2
r=$(check_now false false)
[ "$r" = "1" ] && ok "MIN-GUARD: green + iter 2 but MIN=3 -> does NOT fast-path (floor preserved)" \
               || bad "MIN-GUARD: fired below MIN_ITERATIONS (got $r) -- floor bypassed"

# === OPT-OUT: LOKI_COUNCIL_CONVERGENCE_EARLY=0 restores interval-only =========
COUNCIL_MIN_ITERATIONS=1
ITERATION_COUNT=2
LOKI_COUNCIL_CONVERGENCE_EARLY=0
r=$(check_now false false)
[ "$r" = "1" ] && ok "OPT-OUT: EARLY=0 + green + iter 2 -> does NOT fast-path (interval-only restored)" \
               || bad "OPT-OUT: knob did not disable early check (got $r)"
LOKI_COUNCIL_CONVERGENCE_EARLY=1

# === CLAIM: explicit-claim path timing UNCHANGED =============================
# claim off-interval -> evaluate now (this path already bypassed the interval).
clear_tests
COUNCIL_MIN_ITERATIONS=3
ITERATION_COUNT=7
r=$(check_now false true)
[ "$r" = "0" ] && ok "CLAIM: explicit claim off-interval (iter 7) -> evaluate NOW (unchanged)" \
               || bad "CLAIM: explicit-claim timing changed (got $r)"
# unclaimed off-interval no-evidence -> does NOT evaluate (unchanged).
r=$(check_now false false)
[ "$r" = "1" ] && ok "CLAIM: no-claim off-interval no-evidence (iter 7) -> does NOT evaluate" \
               || bad "CLAIM: no-claim off-interval wrongly evaluated (got $r)"

# circuit-breaker path unchanged: always evaluate.
r=$(check_now true false)
[ "$r" = "0" ] && ok "CIRCUIT: circuit_triggered -> evaluate NOW (unchanged)" \
               || bad "CIRCUIT: circuit path changed (got $r)"

# === SaaS #122: tier-aware effective MIN_ITERATIONS floor =====================
# The HARD floor in council_should_stop (ITERATION_COUNT < floor -> not allowed to
# convene) was previously a flat 3, forcing a genuinely-done SIMPLE app through ~2
# idle iterations (~15min) before the council could approve. The floor is now a
# function of DETECTED_COMPLEXITY: simple->1, standard/complex->3, with an explicit
# LOKI_COUNCIL_MIN_ITERATIONS override always winning. floor=1 means the council is
# ALLOWED to convene at iter 1 -- it is NOT auto-approved; every gate still runs.
eff_min() { unset LOKI_COUNCIL_MIN_ITERATIONS; _council_effective_min_iter; }

# Baseline default floor (no override): standard/complex/unset -> COUNCIL_MIN_ITERATIONS.
COUNCIL_MIN_ITERATIONS=3

DETECTED_COMPLEXITY=simple
r=$(eff_min)
[ "$r" = "1" ] && ok "TIER: DETECTED_COMPLEXITY=simple -> effective floor 1 (was forced to 3)" \
               || bad "TIER: simple expected floor 1, got $r"

DETECTED_COMPLEXITY=standard
r=$(eff_min)
[ "$r" = "3" ] && ok "TIER: DETECTED_COMPLEXITY=standard -> effective floor 3 (unchanged)" \
               || bad "TIER: standard expected floor 3, got $r"

DETECTED_COMPLEXITY=complex
r=$(eff_min)
[ "$r" = "3" ] && ok "TIER: DETECTED_COMPLEXITY=complex -> effective floor 3 (unchanged)" \
               || bad "TIER: complex expected floor 3, got $r"

DETECTED_COMPLEXITY=""
r=$(eff_min)
[ "$r" = "3" ] && ok "TIER: DETECTED_COMPLEXITY unset -> effective floor 3 (no-op, standard path preserved)" \
               || bad "TIER: unset expected floor 3, got $r"

# EXPLICIT OVERRIDE wins even on a simple app -- never silently lowered.
DETECTED_COMPLEXITY=simple
LOKI_COUNCIL_MIN_ITERATIONS=3
COUNCIL_MIN_ITERATIONS=3   # resolved value mirrors the env override (as run.sh:90 does)
r=$(_council_effective_min_iter)
[ "$r" = "3" ] && ok "OVERRIDE: simple + explicit LOKI_COUNCIL_MIN_ITERATIONS=3 -> honored (floor 3, not lowered to 1)" \
               || bad "OVERRIDE: explicit floor silently changed on simple (got $r, expected 3)"
unset LOKI_COUNCIL_MIN_ITERATIONS
COUNCIL_MIN_ITERATIONS=3

# END-TO-END through the WHEN gate: on a simple app, a genuinely-done run that
# CLAIMS done at iteration 1 now passes the floor and evaluates NOW. Old flat-3
# floor -> would have to grind to iter 3 first. Proven via _council_should_check_now
# whose min_iter is now tier-derived. NB: check_now's claim path bypasses interval,
# but the SEPARATE hard floor in council_should_stop is what forced the idle iters;
# here we prove the no-claim early check (which reads the same effective floor)
# fires at iter 1 for simple with affirmative green.
clear_checklist
write_green_tests
DETECTED_COMPLEXITY=simple
COUNCIL_MIN_ITERATIONS=3          # stock default; tier logic overrides to 1 for simple
ITERATION_COUNT=1
LOKI_COUNCIL_CONVERGENCE_EARLY=1
r=$(check_now false false)
[ "$r" = "0" ] && ok "E2E-SIMPLE: simple + green + iter 1 -> council MAY convene at iter 1 (no forced idle iters)" \
               || bad "E2E-SIMPLE: simple app still gated below iter 3 (got $r) -- SaaS #122 NOT fixed"

# And the SAME iter 1 on a COMPLEX app stays gated (floor 3 preserved) -> no green.
DETECTED_COMPLEXITY=complex
r=$(check_now false false)
[ "$r" = "1" ] && ok "E2E-COMPLEX: complex + green + iter 1 -> still gated below floor 3 (verification depth preserved)" \
               || bad "E2E-COMPLEX: complex app fast-pathed at iter 1 (got $r) -- floor weakened"
# reset shared globals for any later additions
DETECTED_COMPLEXITY=""
COUNCIL_MIN_ITERATIONS=3

# === DIRECT council_should_stop FLOOR (SaaS #122 exact bug site) ==============
# The forced-idle bug is the HARD floor INSIDE council_should_stop: while
# ITERATION_COUNT < effective_floor it returns 1 (don't stop) BEFORE the council
# can even evaluate a claimed-done run. We drive council_should_stop directly and
# assert ONLY the floor decision, by stubbing every downstream so nothing past the
# floor executes a real vote. If the floor lets us THROUGH, the stubbed
# should_check=false path returns 1 harmlessly (council convened-but-deferred),
# but crucially it is NOT the floor's early return -- we detect the difference by
# instrumenting the floor's own branch via a marker the stub sets only when we get
# past the floor.
if type council_should_stop >/dev/null 2>&1; then
    # Stubs: neutralize everything council_should_stop calls AFTER the floor so the
    # test isolates the floor branch. council_circuit_breaker_triggered=false and
    # convergence-green=false mean should_check stays false -> function returns 1
    # from the post-floor "should_check != true" path, NOT from the floor. We set a
    # global marker inside the circuit-breaker stub (which runs ONLY if the floor is
    # passed) to prove whether execution reached past the floor.
    _PAST_FLOOR=0
    council_managed_should_stop() { return 1; }
    council_augment_from_managed_memory() { return 0; }
    council_circuit_breaker_triggered() { _PAST_FLOOR=1; return 1; }
    _council_convergence_evidence_green() { return 1; }  # keep should_check=false
    COUNCIL_ENABLED=true
    LOKI_EXPERIMENTAL_MANAGED_COUNCIL=false

    # SIMPLE, iter 1: floor is 1, so 1 -lt 1 is false -> execution passes the floor
    # (marker set). Council is ALLOWED to convene (not auto-approved).
    DETECTED_COMPLEXITY=simple
    COUNCIL_MIN_ITERATIONS=3
    ITERATION_COUNT=1
    _PAST_FLOOR=0
    LOKI_COMPLETION_CLAIMED=0
    council_should_stop >/dev/null 2>&1 || true
    [ "$_PAST_FLOOR" = "1" ] && ok "FLOOR(should_stop): simple + iter 1 -> PAST the hard floor (council may convene; no forced idle iters)" \
                            || bad "FLOOR(should_stop): simple + iter 1 blocked by floor (_PAST_FLOOR=$_PAST_FLOOR) -- SaaS #122 bug site NOT fixed"

    # COMPLEX, iter 1: floor is 3, so 1 -lt 3 is true -> early return at the floor,
    # marker NOT set (verification depth preserved for complex apps).
    DETECTED_COMPLEXITY=complex
    ITERATION_COUNT=1
    _PAST_FLOOR=0
    council_should_stop >/dev/null 2>&1 || true
    [ "$_PAST_FLOOR" = "0" ] && ok "FLOOR(should_stop): complex + iter 1 -> BLOCKED at floor 3 (did not reach council; depth preserved)" \
                            || bad "FLOOR(should_stop): complex + iter 1 passed floor (_PAST_FLOOR=$_PAST_FLOOR) -- floor weakened"

    # COMPLEX, iter 3: floor is 3, 3 -lt 3 is false -> passes floor (unchanged).
    ITERATION_COUNT=3
    _PAST_FLOOR=0
    council_should_stop >/dev/null 2>&1 || true
    [ "$_PAST_FLOOR" = "1" ] && ok "FLOOR(should_stop): complex + iter 3 -> PAST floor 3 (standard/complex behavior unchanged)" \
                            || bad "FLOOR(should_stop): complex + iter 3 blocked (_PAST_FLOOR=$_PAST_FLOOR) -- standard path regressed"

    DETECTED_COMPLEXITY=""
    COUNCIL_MIN_ITERATIONS=3
    unset LOKI_COMPLETION_CLAIMED
else
    echo "SKIP: council_should_stop not defined (cannot drive the direct floor test)"
fi

echo
# === WIRING: the runner must actually CONSULT the council ====================
# Everything above tests council_should_stop and its floor directly. That proves
# the DECISION logic and says nothing about whether run.sh still asks it.
#
# Found by mutation probe: replacing the runner's `elif type council_should_stop`
# guard with `elif false` -- so no run can ever be council-approved -- left this
# file and the wider council suite green. The council is the gate that decides a
# run is done; a disconnected one fails open into "never approves", which then
# looks like a model problem rather than a wiring bug.
_RUN_SH="$REPO_ROOT/autonomy/run.sh"

if grep -qE 'elif type council_should_stop &>/dev/null' "$_RUN_SH"; then
    ok "WIRING: run.sh checks for council_should_stop before calling it"
else
    bad "WIRING: run.sh no longer consults the council -- no run can be approved"
fi

if grep -qF 'council_should_stop; then' "$_RUN_SH"; then
    ok "WIRING: run.sh invokes council_should_stop"
else
    bad "WIRING: the council decision is never invoked"
fi

# The FOUR hard gates inside council_should_stop. Each blocks completion for a
# different reason -- unmet checklist, failing held-out evals, missing evidence,
# unresolved assumptions -- and each returns CONTINUE rather than approving.
#
# All four were blind: the council suites test each gate's own logic and none
# asserted that council_should_stop still calls them. Bypassing any one lets a
# run complete while the thing that gate exists to check was never checked, and
# the receipt still reads VERIFIED.
#
# Asserted as a group because they are a group: a future gate added beside them
# without a call-site assertion is the same hole again.
_COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
for _gate in council_checklist_gate council_heldout_gate \
             council_evidence_gate council_assumption_ledger_gate; do
    if grep -qF "if ! $_gate; then" "$_COUNCIL_SH"; then
        ok "WIRING: council_should_stop consults $_gate"
    else
        bad "WIRING: $_gate is bypassed -- completion would skip that check entirely"
    fi

    if grep -qF "$_gate()" "$_COUNCIL_SH"; then
        ok "WIRING: $_gate is defined under the name its caller uses"
    else
        bad "WIRING: $_gate definition and call site have diverged"
    fi
done

# The VOTE itself. council_evaluate runs the hard gates, aggregates votes and
# applies the devil's advocate; a true return prints "PROJECT APPROVED" and
# writes the .loki/COMPLETED marker. Bypassing it approves every run with no
# vote taken at all, which is a stronger failure than any single gate.
#
# The circuit breaker beside it was probed too and is genuinely guarded -- worth
# recording, so nobody re-derives whether it was ever checked.
if grep -qF 'if council_evaluate; then' "$_COUNCIL_SH"; then
    ok "WIRING: the council runs its evaluation before approving"
else
    bad "WIRING: council_evaluate is bypassed -- runs would be approved with no vote"
fi

if grep -qF 'council_evaluate()' "$_COUNCIL_SH"; then
    ok "WIRING: council_evaluate is defined under the name its caller uses"
else
    bad "WIRING: council_evaluate definition and call site have diverged"
fi

# Approval must still be what writes the COMPLETED marker: a marker written
# outside the approved branch would mean "done" without the vote.
if grep -qF 'Council approved at iteration' "$_COUNCIL_SH"; then
    ok "WIRING: the COMPLETED marker is written from the approval path"
else
    bad "WIRING: the completion marker is no longer tied to council approval"
fi

# The SUPERVISED branch of the same conditional. It blocks completion when the
# iteration reported gate failures, so bypassing it makes every supervised run
# report complete with its gates unchecked -- the same fail-open shape, one
# branch over, and also blind before this.
if grep -qF '_loki_supervised_completion_gates_pass "${gate_failures:-}" && _loki_completion_ready=0' "$_RUN_SH"; then
    ok "WIRING: the supervised path still runs its completion gates"
else
    bad "WIRING: supervised completion no longer checks its gates -- it would pass unchecked"
fi

if grep -qF '_loki_supervised_completion_gates_pass()' "$_RUN_SH"; then
    ok "WIRING: the supervised gate is defined under the name its caller uses"
else
    bad "WIRING: supervised gate definition and call site have diverged"
fi

# The function must still exist under the name the runner calls: a rename that
# updates one side leaves the guard permanently false and the council silently
# skipped, with no error anywhere.
if grep -qF 'council_should_stop()' "$REPO_ROOT/autonomy/completion-council.sh"; then
    ok "WIRING: council_should_stop is defined under the name the runner calls"
else
    bad "WIRING: council_should_stop definition and call site have diverged"
fi


echo "-----------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CONVERGENCE-FLOOR TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$FAIL"
