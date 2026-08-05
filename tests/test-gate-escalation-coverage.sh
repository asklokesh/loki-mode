#!/usr/bin/env bash
# Every gate the escalation writer HANDLES must actually call it.
#
# THE DEAD BRANCH. `write_gate_escalation_guidance` maps four gates to the
# findings artifact that explains their failure:
#
#     code_review        -> quality/reviews/<latest>/
#     mutation_integrity -> quality/mutation-findings.txt
#     mock_integrity     -> quality/mock-findings.txt
#     test_coverage      -> quality/test-results.json
#
# Only `code_review` ever called it. The other three branches could never run,
# so the mapping was decorative -- code that reads as a feature and executes as
# nothing.
#
# MEASURED, not theoretical. On a real run `mock_integrity` failed THREE times
# (more than any other gate) and `.loki/signals/GATE_ESCALATION.json` was never
# written. The agent was told the gate failed and never handed the findings file
# that says WHY -- the 56% "did not attempt to recover from an error" failure
# shape (SlopCodeBench, arXiv 2603.24755), manufactured by our own harness.
#
# WHY THIS IS ASSERTED STRUCTURALLY. The writer embeds a python heredoc, so a
# `sed` slice of it is unbalanced and cannot be executed in isolation (a trap
# this repo has hit before). The contract that matters is the WIRING: a gate the
# writer knows about must have a caller. That is exactly what regressed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: gate escalation coverage"

# --- derive the HANDLED set from the writer itself ---------------------------
# Not hardcoded: a fifth gate added to the mapping is then covered automatically,
# which is the whole class of bug being prevented.
_handled="$(awk '/^write_gate_escalation_guidance\(\)/,/^\}/' "$RUN_SH" \
    | grep -oE '^\s+[a-z_]+\)\s+latest_artifact=' \
    | grep -oE '[a-z_]+\)' | tr -d ')' | sort -u)"
_handled="$_handled
code_review"
_handled="$(printf '%s\n' "$_handled" | grep -v '^$' | sort -u)"

if [ -z "$_handled" ]; then
    bad "could not derive the handled-gate set; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "derived the handled-gate set from the writer ($(printf '%s' "$_handled" | tr '\n' ' '))"

# --- every handled gate must have a caller -----------------------------------
_uncalled=""
for _g in $_handled; do
    if ! grep -q "write_gate_escalation_guidance \"$_g\"" "$RUN_SH"; then
        _uncalled="$_uncalled $_g"
    fi
done
if [ -z "$_uncalled" ]; then
    ok "every handled gate has a call site"
else
    bad "handled but NEVER called (dead mapping):$_uncalled -- the agent is told the gate failed but never handed the findings"
fi

# --- the two gates that actually failed in production ------------------------
# mock_integrity failed 3x and mutation_integrity 2x on the measured run. These
# are named explicitly so a refactor that drops them fails loudly, even if the
# derived set above were to break.
for _g in mock_integrity mutation_integrity code_review; do
    if grep -q "write_gate_escalation_guidance \"$_g\"" "$RUN_SH"; then
        ok "$_g escalates its findings"
    else
        bad "$_g does not escalate -- it failed in production and the agent got no findings"
    fi
done

# --- escalation must not fire when the run is already blocking ---------------
# Guidance for a gate that has already hit its hard limit is noise; the run is
# stopping regardless. Each call site must be behind the disposition check.
_missing_guard=""
for _g in mock_integrity mutation_integrity; do
    _blk="$(grep -B3 "write_gate_escalation_guidance \"$_g\"" "$RUN_SH")"
    case "$_blk" in
        *'gate_failure_disposition'*) ;;
        *) _missing_guard="$_missing_guard $_g" ;;
    esac
done
if [ -z "$_missing_guard" ]; then
    ok "escalation is gated on disposition (no guidance once blocking)"
else
    bad "no disposition guard for:$_missing_guard"
fi

# --- it must never fail the run ----------------------------------------------
# This is best-effort guidance on the hot path; an error here must not abort an
# iteration that was otherwise fine.
_unguarded=""
for _g in mock_integrity mutation_integrity; do
    grep -q "write_gate_escalation_guidance \"$_g\" .*|| true" "$RUN_SH" \
        || _unguarded="$_unguarded $_g"
done
if [ -z "$_unguarded" ]; then
    ok "every new call site is best-effort (|| true)"
else
    bad "a guidance failure could abort the iteration for:$_unguarded"
fi

# --- the writer still maps each gate to a real artifact path -----------------
_w="$(awk '/^write_gate_escalation_guidance\(\)/,/^\}/' "$RUN_SH")"
for _pair in "mock_integrity:mock-findings.txt" "mutation_integrity:mutation-findings.txt"; do
    _g="${_pair%%:*}"; _f="${_pair##*:}"
    case "$_w" in
        *"$_g"*"$_f"*) ok "$_g maps to $_f" ;;
        *) bad "$_g no longer maps to $_f -- escalation would carry no findings" ;;
    esac
done

# --- WRITER and READER must agree on the JSON contract -----------------------
# The chain is: write_gate_escalation_guidance -> signals/GATE_ESCALATION.json
# -> build_gate_escalation_context -> the PROMPT. A key renamed on either side
# breaks it silently: the signal is still written, still read, and simply
# carries nothing -- the agent gets an escalation with no findings attached,
# which looks identical to no escalation at all.
_writer_keys="$(awk '/^write_gate_escalation_guidance\(\)/,/^\}/' "$RUN_SH" \
    | grep -oE '"(action|count|gate|threshold|latest_artifact)":' \
    | tr -d '":' | sort -u)"
_reader_keys="$(awk '/^build_gate_escalation_context\(\)/,/^\}/' "$RUN_SH" \
    | grep -oE 'data\.get\("[a-z_]+"\)' \
    | sed 's/.*("//; s/").*//' | sort -u)"

if [ -z "$_writer_keys" ] || [ -z "$_reader_keys" ]; then
    bad "could not extract the writer/reader key sets; this check is inert"
elif [ "$_writer_keys" = "$_reader_keys" ]; then
    ok "writer and reader agree on every JSON key ($(printf '%s' "$_writer_keys" | tr '\n' ' '))"
else
    bad "writer/reader key mismatch -- escalation would carry no findings. writer=[$(printf '%s' "$_writer_keys" | tr '\n' ' ')] reader=[$(printf '%s' "$_reader_keys" | tr '\n' ' ')]"
fi

# The context builder must actually reach the prompt, or the whole chain is a
# report rather than a feedback loop.
if grep -q 'gate_escalation_context=$(build_gate_escalation_context' "$RUN_SH"; then
    ok "the escalation context is built for the prompt"
else
    bad "nothing calls build_gate_escalation_context -- the signal never reaches the agent"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
