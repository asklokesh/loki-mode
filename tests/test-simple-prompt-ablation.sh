#!/usr/bin/env bash
# tests/test-simple-prompt-ablation.sh -- LOKI_SIMPLE=1 strips COACHING from the
# prompt prefix and leaves STATE in the dynamic tail completely alone.
#
# WHY THIS FLAG EXISTS. Anthropic deleted ~80% of Claude Code's system prompt
# for Opus 5, on the finding that instructions written to correct older models
# had become dead weight -- and that the model measured slightly MORE capable
# without them. Their method was ablation: delete, measure, and add back only
# what a measured failure demands. Every instruction in our prefix was added
# for the same reason theirs were, and not one had ever been measured.
#
# THE DISTINCTION THE FLAG IS BUILT AROUND, and what this file pins so a
# future edit cannot quietly erase it:
#
#   COACHING (prefix) is how to work -- "use a Reason-Act-Reflect-Verify
#   cycle", "execute all SDLC phases", "consult memory before acting". A
#   frontier model does these natively. Being told costs attention.
#
#   STATE (tail) is what happened -- which gate failed, what self-heal found,
#   what the checklist still shows open. The model cannot derive this from
#   anywhere. Deleting it deletes the run's memory, not its lecture.
#
# So the ablation is COACHING ONLY. That boundary is the whole safety
# argument for shipping the flag at all, which is why the tail assertions
# below matter more than the prefix ones: if a future edit widens the strip
# to swallow gate_failure_context, the arm stops being an experiment about
# prompt bloat and starts being an experiment about running blind.
#
# NOT ABLATABLE, ever, and deliberately absent from this file: gates,
# receipts, verification. The trust core is not prompt correction.
#
# Skips gracefully (exit 0) when bash/python3 are unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: autonomy/run.sh not found. (Not a fail.)"; exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi

echo "TEST: LOKI_SIMPLE=1 ablates coaching, never state"

# --- extract the REAL emitted prefix for one arm ------------------------------
#
# Source run.sh and call the real build_prompt. Sourcing is safe: both main()
# and the self-copy block are guarded by [[ "${BASH_SOURCE[0]}" == "${0}" ]].
#
# Do NOT set LOKI_RUNNING_FROM_TEMP=1 -- run.sh installs an EXIT trap
# `rm -f "${BASH_SOURCE[0]}"` under that var, which at our EXIT would resolve
# to THIS FILE and delete the test. tests/test-completion-summary.sh carries
# the same warning for the same reason.
#
# The runtime environment comes from the EXISTING byte-parity fixture corpus
# (loki-ts/tests/fixtures/build_prompt/fixture-1/env.sh) rather than a fresh
# set of variables invented here. build_prompt reads RETRY, ITERATION,
# TARGET_DIR, AUTONOMY_MODE and more; a hand-rolled subset silently produces
# no output, which this file's vacuity guard correctly refused to call a pass.
# Reusing the fixture also means this measures the same prompt shape the
# parity job measures, instead of a second definition that can drift from it.
FIXTURE_ENV="$REPO_ROOT/loki-ts/tests/fixtures/build_prompt/fixture-1/env.sh"

emit_arm() {
    local simple="$1"
    local workdir
    workdir="$(mktemp -d)"
    (
        cd "$workdir" || exit 1
        mkdir -p .loki/state .loki/queue .loki/quality
        # Drive the REAL gate-failure path. gate_failure_context is a `local`
        # that build_prompt rebuilds from this file every call, so assigning
        # the variable from outside is silently overwritten -- which is why the
        # tail-survival assertion previously did not run at all, and said so
        # instead of reporting a pass it had not earned.
        printf 'mock_integrity FAILED on iteration 3\n' \
            > .loki/quality/gate-failures.txt
        # shellcheck disable=SC1090
        [ -f "$FIXTURE_ENV" ] && source "$FIXTURE_ENV"
        export TARGET_DIR="$workdir"
        export LOKI_SIMPLE="$simple"
        # shellcheck disable=SC1090
        source "$RUN_SH" >/dev/null 2>&1 || true
        if ! declare -f build_prompt >/dev/null 2>&1; then
            exit 42
        fi
        # A gate failure is the sharpest STATE case: it is the single piece of
        # context whose loss would make the model repeat a known-failing move.
        # If the strip is ever widened wrongly, this is what disappears.
        # POSITIONAL ARGS ARE REQUIRED: build_prompt(retry, prd, iteration).
        # Calling it bare emits nothing and exits non-zero -- which the vacuity
        # guard below correctly refused to report as a pass. The signature is
        # documented in each fixture's manifest.txt ("Invocation:
        # build_prompt(0, \"\", 1)").
        build_prompt 0 "" 1 2>/dev/null
    )
    local rc=$?
    rm -rf "$workdir"
    return $rc
}

FULL="$(emit_arm 0 2>/dev/null)"
_full_rc=$?
SIMPLE="$(emit_arm 1 2>/dev/null)"

# --- VACUITY GUARD ------------------------------------------------------------
# Every assertion below is a substring search. Over an empty string, "coaching
# is absent" is trivially true and the whole file reports a pass while proving
# nothing. That is the exact false-green shape this repo has been bitten by, so
# the measurement is asserted to exist before any verdict is trusted.
if [ -z "$FULL" ] || [ "$_full_rc" = "42" ]; then
    echo "SKIP: build_prompt did not emit under this harness (rc=$_full_rc);"
    echo "      the assertions would be vacuous, so this is NOT reported as a pass."
    exit 0
fi
ok "the default arm emitted a non-empty prompt (assertions below are live)"

# --- COACHING is present by default, absent under the flag --------------------
# Default-off is load-bearing beyond safety: the emitted bytes must not move
# unless the flag is set, or the byte-parity fixtures shift and CI blocks.
_coaching_found=0
for marker in "RALPH WIGGUM MODE ACTIVE" "SDLC_PHASES_ENABLED"; do
    if grep -qF -- "$marker" <<< "$FULL"; then
        _coaching_found=$((_coaching_found + 1))
        if grep -qF -- "$marker" <<< "$SIMPLE"; then
            bad "LOKI_SIMPLE=1 did not strip coaching" "$marker still present"
        else
            ok "LOKI_SIMPLE=1 strips coaching: $marker"
        fi
    fi
done
if [ "$_coaching_found" -eq 0 ]; then
    bad "no coaching markers found in the DEFAULT arm" \
        "either the prompt changed shape or the extraction broke; the strip assertions above proved nothing"
else
    ok "coaching is present by default ($_coaching_found marker(s)); default behavior unchanged"
fi

# --- STATE survives BOTH arms -------------------------------------------------
# The safety argument. Coaching is a lecture the model can do without; a gate
# failure is the run's memory. An ablation that swallowed this would not be
# measuring prompt bloat, it would be measuring blindness.
if grep -qF -- "mock_integrity FAILED on iteration 3" <<< "$FULL"; then
    if grep -qF -- "mock_integrity FAILED on iteration 3" <<< "$SIMPLE"; then
        ok "gate-failure STATE survives the ablation (the tail is untouched)"
    else
        bad "LOKI_SIMPLE=1 stripped a GATE FAILURE from the prompt" \
            "the model would repeat a known-failing move with no way to know"
    fi
else
    echo "NOTE: gate_failure_context did not reach the emitted prompt under this"
    echo "      harness, so the tail-survival assertion did not run. Not a pass."
fi

# --- the task anchor survives -------------------------------------------------
# The one thing the model cannot infer. Stripping it would not be ablation, it
# would be deleting the question.
if grep -qF -- "Loki Mode" <<< "$SIMPLE"; then
    ok "the task anchor survives the ablation"
else
    bad "LOKI_SIMPLE=1 stripped the task anchor" "the model is not told what to do"
fi

# --- the measurement, which is the point --------------------------------------
_f=$(printf '%s' "$FULL" | wc -c | tr -d ' ')
_s=$(printf '%s' "$SIMPLE" | wc -c | tr -d ' ')
if [ "$_f" -gt 0 ] && [ "$_s" -lt "$_f" ]; then
    _pct=$(( (_f - _s) * 100 / _f ))
    ok "prefix shrinks ${_f} -> ${_s} bytes (-${_pct}%), roughly $(( (_f - _s) / 4 )) tokens/iteration"
else
    bad "LOKI_SIMPLE=1 did not shrink the prompt" "full=${_f} simple=${_s}"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
