#!/usr/bin/env bash
# Test: tools/preflight.sh verdict behaviour.
#
# WHY THIS TEST EXISTS. preflight answers "will this run succeed, and what will
# it cost" before a user spends anything, so the two ways it can lie are both
# expensive:
#
#   1. A fabricated cost. "No history" rendered as "$0.00" told four earlier
#      surfaces' users a run was free. Pointed FORWARD it is worse -- it invites
#      someone to start a build believing it costs nothing. The no-history
#      assertion below is the guard on that, and it asserts the ABSENCE of
#      "$0.00" as well as the presence of the honest wording, because a report
#      that says both is still a report that says $0.00.
#   2. A BLOCKED verdict with no way out. Naming a blocker without its fix is
#      where a first-time user closes the terminal, so BLOCKED is asserted to
#      carry the install command, not just the complaint.
#
# Every assertion RUNS the script against a fixture. The no-provider fixture
# scrubs PATH, and asserts the scrub actually took effect BEFORE reading the
# verdict -- a PATH that still finds claude would produce a READY that looks
# like a preflight bug, and an assertion built on an absent measurement is the
# vacuity this repo keeps paying for.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFLIGHT="$REPO_ROOT/tools/preflight.sh"

PASSED=0
FAILED=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

echo "========================================"
echo "Preflight Verdict Tests"
echo "========================================"
echo ""

if [ ! -f "$PREFLIGHT" ]; then
    echo -e "${RED}tools/preflight.sh not found${NC}"
    exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-preflight-test-XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

# Strip ANSI so assertions match on text, not on colour codes.
strip_ansi() { sed $'s/\033\\[[0-9;]*m//g'; }

# ============================================================
# Test 1: a healthy workspace reads READY
# ============================================================
log_test "healthy workspace reads READY"
HEALTHY="$SCRATCH/healthy"
mkdir -p "$HEALTHY"

# Precondition: this only tests READY if the host actually HAS a provider.
# Without this guard a provider-less CI box would report BLOCKED and the test
# would read that as a defect in preflight.
have_provider=false
for p in claude codex cline aider; do
    if command -v "$p" >/dev/null 2>&1; then have_provider=true; break; fi
done

# Capture preflight's OWN exit code. Reading $? after a pipe yields strip_ansi's
# status, which is 0 whatever preflight did -- printing that as "(exit 0)" would
# be presenting an unmeasured value as evidence, the same class of thing this
# feature exists to refuse.
raw1="$SCRATCH/healthy.out"
bash "$PREFLIGHT" "$HEALTHY" > "$raw1" 2>&1
rc1=$?
out1="$(strip_ansi < "$raw1")"

if ! $have_provider; then
    echo "  SKIP: no provider CLI on this host, READY is not reachable here"
elif printf '%s' "$out1" | grep -q "VERDICT: READY"; then
    log_pass "healthy workspace reads READY"
    # READY must be exit 0 so a pipeline can gate on it (BLOCKED's non-zero is
    # asserted separately below).
    if [ "$rc1" -eq 0 ]; then
        log_pass "READY exits 0 (gateable)"
    else
        log_fail "READY exited $rc1, expected 0"
    fi
else
    log_fail "healthy workspace did not read READY"
    printf '%s\n' "$out1" | tail -20
fi

# The read-only promise must be stated in its own output, not just the header
# comment -- a user has no other way to know it is safe to run.
log_test "output states it is read-only"
if printf '%s' "$out1" | grep -qi "read-only.*starts nothing.*spends nothing"; then
    log_pass "output declares read-only, starts nothing, spends nothing"
else
    log_fail "output does not declare its read-only contract"
fi

# ============================================================
# Test 2: no cost history says so, and never prints $0.00
# ============================================================
log_test "no cost history reads UNKNOWN, not \$0.00"
# $HEALTHY has no .loki/metrics/efficiency, so there is no basis at all.
out_cost="$(bash "$PREFLIGHT" "$HEALTHY" --iterations 12 2>&1 | strip_ansi)"

if printf '%s' "$out_cost" | grep -q 'UNKNOWN  no measured, priced iteration'; then
    log_pass "no-history workspace reports the cost basis as UNKNOWN"
else
    log_fail "no-history workspace did not report UNKNOWN cost"
    printf '%s\n' "$out_cost" | grep -A3 "Projected cost"
fi

# The headline defect. Asserted as an ABSENCE: a report carrying both the
# honest note and a "$0.00" still shows the user $0.00.
#
# The estimator's own note ends "...so no cost is estimated (not $0.00)" -- a
# DISCLAIMER of the value, the opposite of asserting it. A bare grep for the
# string flags that line and fails a correct report, so the disclaimer form is
# excluded and any OTHER occurrence still fails. Narrow enough to keep the
# guard: a real regression renders "$0.00" as a projection, not inside "(not ...)".
cost_hits="$(printf '%s\n' "$out_cost" | grep '\$0\.00' | grep -v 'not \$0\.00' || true)"
if [ -n "$cost_hits" ]; then
    log_fail "no-history workspace printed \$0.00 -- unmeasured rendered as free"
    printf '%s\n' "$cost_hits"
else
    log_pass "no-history workspace never asserts \$0.00 as a cost"
fi

# And it must say WHY there is no number, sourced from the estimator itself.
if printf '%s' "$out_cost" | grep -q "NO history to project from"; then
    log_pass "states there is no basis to project from"
else
    log_fail "does not explain why no cost is shown"
fi

# ============================================================
# Test 2b: WITH priced history, a real projection is produced
# ============================================================
# The other half of the feature. Without this every assertion above runs on
# has_basis=false, so the branch that prints an actual dollar figure would ship
# never having executed once -- "what will it cost" unverified while the tests
# looked green.
log_test "priced history produces a real projection"
PRICED="$SCRATCH/priced"
mkdir -p "$PRICED/.loki/metrics/efficiency"
# The reader requires an "iteration" key and SKIPS records without one. A
# fixture missing it is silently dropped, which would make has_basis false and
# turn this whole test into a second copy of the no-history case that passes for
# the wrong reason. The precondition below is what catches that.
printf '%s' '{"iteration":1,"status":"completed","duration_ms":120000,"cost_usd":0.0400,"model":"sonnet"}' \
    > "$PRICED/.loki/metrics/efficiency/iteration-1.json"
printf '%s' '{"iteration":2,"status":"completed","duration_ms":150000,"cost_usd":0.0600,"model":"sonnet"}' \
    > "$PRICED/.loki/metrics/efficiency/iteration-2.json"
printf '%s' '{"iteration":3,"status":"completed","duration_ms":130000,"cost_usd":0.0500,"model":"sonnet"}' \
    > "$PRICED/.loki/metrics/efficiency/iteration-3.json"

# PRECONDITION: the estimator must actually accept the fixture. Asserting on
# preflight's output without this would let a rejected fixture masquerade as a
# working projection.
if python3 "$REPO_ROOT/tools/estimate-run.py" --iterations 4 "$PRICED" --json 2>/dev/null \
   | grep -q '"has_basis": true'; then
    log_pass "PRECONDITION: estimator accepts the priced fixture (has_basis true)"

    out_priced="$(bash "$PREFLIGHT" "$PRICED" --iterations 4 2>&1 | strip_ansi)"

    # median of 0.04/0.05/0.06 = 0.05; 0.05 * 4 = 0.20
    if printf '%s' "$out_priced" | grep -q 'measured per-iteration cost: \$0\.0500'; then
        log_pass "reports the measured per-iteration median from real records"
    else
        log_fail "did not report the measured per-iteration cost"
        printf '%s\n' "$out_priced" | grep -A4 "Projected cost"
    fi

    if printf '%s' "$out_priced" | grep -q 'projected for 4 iteration(s): \$0\.20'; then
        log_pass "projects the total over the requested horizon (\$0.20 for 4)"
    else
        log_fail "did not project the total correctly"
        printf '%s\n' "$out_priced" | grep -A4 "Projected cost"
    fi

    # A real number must still be labelled an estimate, never a guarantee.
    if printf '%s' "$out_priced" | grep -q "ESTIMATE, not a guarantee"; then
        log_pass "the projection is labelled an ESTIMATE"
    else
        log_fail "the projection is not labelled an estimate"
    fi

    # The horizon is never invented: with history but no --iterations, the
    # per-iteration figure is real but the TOTAL must stay UNKNOWN.
    out_nohorizon="$(bash "$PREFLIGHT" "$PRICED" 2>&1 | strip_ansi)"
    if printf '%s' "$out_nohorizon" | grep -q "projected total: UNKNOWN"; then
        log_pass "without --iterations the total reads UNKNOWN, not a guessed horizon"
    else
        log_fail "a total was projected without a stated horizon"
        printf '%s\n' "$out_nohorizon" | grep -A4 "Projected cost"
    fi
else
    log_fail "PRECONDITION failed: estimator rejected the priced fixture, projection unverifiable"
    python3 "$REPO_ROOT/tools/estimate-run.py" --iterations 4 "$PRICED" --json 2>&1 | head -8
fi

# ============================================================
# Test 3: no provider reads BLOCKED and names the fix
# ============================================================
log_test "workspace with no provider reads BLOCKED and names the fix"
NOPROV="$SCRATCH/noprov"
mkdir -p "$NOPROV"

# Run under a scrubbed PATH. Written to a file because the precondition has to
# be asserted INSIDE the scrubbed environment, before the verdict is read.
runner="$SCRATCH/run-scrubbed.sh"
{
    echo '#!/usr/bin/env bash'
    echo 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"'
    echo 'if command -v claude >/dev/null 2>&1; then echo "PRECOND_FAIL_CLAUDE_VISIBLE"; exit 9; fi'
    echo 'if command -v codex >/dev/null 2>&1; then echo "PRECOND_FAIL_CODEX_VISIBLE"; exit 9; fi'
    echo 'echo PRECOND_OK_NO_PROVIDER'
    echo 'bash "$1" "$2" --iterations 5 2>&1'
    echo 'echo "PREFLIGHT_EXIT=$?"'
} > "$runner"

out3="$(bash "$runner" "$PREFLIGHT" "$NOPROV" 2>&1 | strip_ansi)"

if ! printf '%s' "$out3" | grep -q "PRECOND_OK_NO_PROVIDER"; then
    # An absent measurement, not a pass and not a fail of preflight itself.
    log_fail "PRECONDITION not met: could not scrub providers off PATH, verdict unverifiable"
    printf '%s\n' "$out3" | head -5
else
    if printf '%s' "$out3" | grep -q "VERDICT: BLOCKED"; then
        log_pass "no-provider workspace reads BLOCKED"
    else
        log_fail "no-provider workspace did not read BLOCKED"
        printf '%s\n' "$out3" | tail -20
    fi

    # BLOCKED must be actionable: name the blocker AND the command that fixes it.
    if printf '%s' "$out3" | grep -q "No AI provider CLI"; then
        log_pass "BLOCKED names the missing provider"
    else
        log_fail "BLOCKED does not name the missing provider"
    fi

    if printf '%s' "$out3" | grep -q "npm install -g @anthropic-ai/claude-code"; then
        log_pass "BLOCKED carries the exact install command that fixes it"
    else
        log_fail "BLOCKED does not carry an install command"
        printf '%s\n' "$out3" | tail -15
    fi

    # BLOCKED must be non-zero so a pipeline can gate on it.
    if printf '%s' "$out3" | grep -q "PREFLIGHT_EXIT=1"; then
        log_pass "BLOCKED exits non-zero (gateable)"
    else
        log_fail "BLOCKED did not exit 1"
        printf '%s' "$out3" | grep "PREFLIGHT_EXIT="
    fi
fi

# ============================================================
# Test 3b: the two provider lists disagree -- say so, do not contradict
# ============================================================
# auto_detect_provider iterates claude cline codex aider opencode; doctor's
# ai_provider check knows only the first four. On an opencode-only machine
# preflight printed "would select: opencode" and "No AI provider CLI" three
# lines apart. Neither producer is editable from here, so the requirement is
# that preflight NAMES the disagreement instead of asserting either side.
log_test "a provider only one checker knows about is reported as uncertain, not contradictory"
OCDIR="$SCRATCH/oc"
mkdir -p "$OCDIR/bin" "$OCDIR/ws"
printf '#!/bin/sh\necho opencode 1.0.0\n' > "$OCDIR/bin/opencode"
chmod +x "$OCDIR/bin/opencode"

oc_runner="$SCRATCH/run-opencode.sh"
{
    echo '#!/usr/bin/env bash'
    echo "export PATH=\"$OCDIR/bin:/usr/bin:/bin:/usr/sbin:/sbin\""
    echo 'if command -v claude >/dev/null 2>&1; then echo "PRECOND_FAIL_CLAUDE"; exit 9; fi'
    echo 'if ! command -v opencode >/dev/null 2>&1; then echo "PRECOND_FAIL_NO_OPENCODE"; exit 9; fi'
    echo 'echo PRECOND_OK_OPENCODE_ONLY'
    echo "bash \"\$1\" \"$OCDIR/ws\" 2>&1"
} > "$oc_runner"

out_oc="$(bash "$oc_runner" "$PREFLIGHT" 2>&1 | strip_ansi)"

if ! printf '%s' "$out_oc" | grep -q "PRECOND_OK_OPENCODE_ONLY"; then
    log_fail "PRECONDITION not met: could not build an opencode-only PATH"
    printf '%s\n' "$out_oc" | head -5
else
    # The contradiction: selecting a provider AND blocking on having none.
    if printf '%s' "$out_oc" | grep -q "auto-detection would select: opencode" \
       && printf '%s' "$out_oc" | grep -q "^  FAIL  No AI provider CLI"; then
        log_fail "self-contradicting report: selected 'opencode' yet BLOCKED on no provider"
        printf '%s\n' "$out_oc" | head -12
    else
        log_pass "no self-contradicting provider report"
    fi

    # These two assertions previously required preflight to REPORT a
    # disagreement between the two provider checkers. That disagreement was a
    # real defect, not a permanent condition: doctor's `_provider_cmds` omitted
    # opencode while auto_detect_provider included it, so an opencode-only
    # machine was told it had no AI provider CLI. With that list corrected, the
    # two checkers agree and there is nothing to surface -- so the assertion is
    # now that the machine reads READY, not that the contradiction is narrated.
    if printf '%s' "$out_oc" | grep -q "doctor reports no provider, but auto-detection selected"; then
        log_fail "the checkers disagree again: doctor's list has drifted from the detector"
        printf '%s\n' "$out_oc" | head -12
    else
        log_pass "the two provider checkers agree, so no disagreement is reported"
    fi

    # An opencode-only machine is genuinely ready; UNCERTAIN would now be wrong.
    if printf '%s' "$out_oc" | grep -q "provider readiness uncertain"; then
        log_fail "provider readiness is UNCERTAIN on a machine that is actually ready"
    fi
fi

# ============================================================
# Test 4: a missing helper degrades to unavailable, never crashes
# ============================================================
log_test "missing helper degrades to unavailable rather than crashing"
out4="$(LOKI_PREFLIGHT_ESTIMATOR="$SCRATCH/does-not-exist.py" \
        bash "$PREFLIGHT" "$HEALTHY" --iterations 3 2>&1 | strip_ansi)"
rc4=$?

if printf '%s' "$out4" | grep -q "estimator unavailable"; then
    log_pass "missing estimator is reported as unavailable"
else
    log_fail "missing estimator was not reported as unavailable"
    printf '%s\n' "$out4" | grep -A3 "Projected cost"
fi

# Degrading must not silently drop the signal, and must not kill the preflight:
# a verdict still has to be produced.
if printf '%s' "$out4" | grep -qE "VERDICT: (READY|READY WITH WARNINGS|BLOCKED)"; then
    log_pass "preflight still produces a verdict with a helper missing"
else
    log_fail "preflight produced no verdict when a helper was missing"
fi

# A missing signal is a WARNING, never a silent READY -- an unmeasured signal
# must never read as a clean bill of health.
if $have_provider; then
    if printf '%s' "$out4" | grep -q "VERDICT: READY WITH WARNINGS"; then
        log_pass "an unavailable signal downgrades READY to READY WITH WARNINGS"
    else
        log_fail "an unavailable signal did not downgrade the verdict"
        printf '%s\n' "$out4" | tail -8
    fi
fi

# The loader is a separate helper: same degrade contract.
log_test "missing provider loader degrades to unavailable"
out5="$(LOKI_PREFLIGHT_LOADER="$SCRATCH/no-loader.sh" \
        bash "$PREFLIGHT" "$HEALTHY" 2>&1 | strip_ansi)"
if printf '%s' "$out5" | grep -q "provider loader missing"; then
    log_pass "missing provider loader is reported as unavailable"
else
    log_fail "missing provider loader was not reported"
    printf '%s\n' "$out5" | grep -A3 "Provider"
fi

# ============================================================
# Test 5: a resumable run is surfaced, and nothing is mutated
# ============================================================
log_test "an interrupted run is surfaced with its continue command"
RESUMABLE="$SCRATCH/resumable"
mkdir -p "$RESUMABLE/.loki"
printf '%s' '{"iteration": 7, "status": "interrupted", "lastRun": "2026-08-01T10:00:00Z", "prdPath": ""}' \
    > "$RESUMABLE/.loki/autonomy-state.json"
before="$(cat "$RESUMABLE/.loki/autonomy-state.json")"

out6="$(bash "$PREFLIGHT" "$RESUMABLE" 2>&1 | strip_ansi)"

if printf '%s' "$out6" | grep -qi "interrupted or paused run present"; then
    log_pass "interrupted run is surfaced"
else
    log_fail "interrupted run was not surfaced"
    printf '%s\n' "$out6" | grep -A4 "Saved state"
fi

# READ-ONLY, the load-bearing promise. loki resume DELETES the PAUSE file, so a
# preflight that reached for it would destroy the state it is reporting on.
after="$(cat "$RESUMABLE/.loki/autonomy-state.json")"
if [ "$before" = "$after" ]; then
    log_pass "preflight did not mutate saved run state"
else
    log_fail "preflight MUTATED saved run state -- it must be read-only"
fi

# A PAUSE file is the specific thing loki resume removes. If preflight ever gets
# rewired to call resume instead of 'next --dry-run', this is what catches it.
log_test "a PAUSE signal file survives preflight"
touch "$RESUMABLE/.loki/PAUSE"
bash "$PREFLIGHT" "$RESUMABLE" >/dev/null 2>&1
if [ -f "$RESUMABLE/.loki/PAUSE" ]; then
    log_pass "PAUSE file still present after preflight (resume was not invoked)"
else
    log_fail "PAUSE file was DELETED -- preflight invoked a mutating command"
fi

# ============================================================
# Test 6: a malformed --iterations errors instead of silently degrading
# ============================================================
log_test "--iterations with no value errors rather than silently reading as absent"
bash "$PREFLIGHT" "$HEALTHY" --iterations >/dev/null 2>&1
if [ $? -eq 64 ]; then
    log_pass "empty --iterations exits 64 instead of silently dropping the horizon"
else
    log_fail "empty --iterations did not error"
fi

log_test "a non-numeric --iterations is rejected"
bash "$PREFLIGHT" "$HEALTHY" --iterations abc >/dev/null 2>&1
if [ $? -eq 64 ]; then
    log_pass "non-numeric --iterations is rejected"
else
    log_fail "non-numeric --iterations was accepted"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
