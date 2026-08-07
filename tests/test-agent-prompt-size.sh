#!/usr/bin/env bash
# The call that costs 93% of the run must report its own input size.
#
# W3. Measured on a real run: the agent call is 1814s of 1941s wall clock. Every
# code REVIEWER logs its prompt bytes ("Reviewer security-sentinel: prompt
# 160074 bytes"). The dominant call logged nothing -- `agent_prompt_bytes`
# appeared zero times in run.sh.
#
# WHY PROMPT SIZE AND NOT SOMETHING ELSE. We cannot make the provider faster and
# we cannot train a model; the market's own finding is that the HARNESS is worth
# 10-15 points on an identical model. Prompt size is the input side of that 93%
# and one of the few levers we actually hold: send less, pay less, wait less.
#
# WITHOUT THE NUMBER THE REGRESSION IS INVISIBLE. A prompt that grows 40% shows
# up only as latency and cost with no attributable cause -- the same shape as
# the cost work, where four surfaces reported $0.00 because nothing measured
# tokens.
#
# ALSO ASSERTED: an unmeasurable size emits NOTHING rather than 0. A fabricated
# zero would be averaged into any later analysis as a real observation, which is
# worse than an absent one.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
MEASURE="$REPO_ROOT/scripts/measure-run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: agent prompt size measurement"

# --- the emitter exists and brackets the agent call --------------------------
if grep -q 'emit_event_json "agent_prompt"' "$RUN_SH"; then
    ok "run.sh emits an agent_prompt event"
else
    bad "the agent prompt size is never measured -- the 93% call has no input metric"
fi

# CO-LOCATION IS ASSERTED BY ENCLOSING FUNCTION, NOT BY LINE DISTANCE.
#
# This was a -B26/-A6 window, and it went red on main for a reason that had
# nothing to do with the measurement: unrelated work inserted lines between
# `emit_stage_complete "agent"` and this emit, pushing the gap to 88 lines. The
# code was correct the whole time -- both calls live in run_autonomous() and the
# emit reads the same $prompt and $duration the completed call just set.
#
# A line-distance heuristic asserts "nobody edited nearby", which is not the
# property we care about and breaks on every insertion. Extracting the enclosing
# function and asserting both markers appear inside it tests the actual
# invariant: the measurement happens in the same scope as the call it measures,
# so it cannot be reading some other invocation's prompt.
_fn_body="$(awk '/^run_autonomous\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$RUN_SH")"
if [ -z "$_fn_body" ]; then
    bad "could not extract run_autonomous() -- the emit's scope is unverifiable"
# `printf | grep -q` is deliberately avoided here: under `set -o pipefail`
# grep -q exits on first match, printf dies of SIGPIPE, and the pipeline reports
# non-zero even though the pattern MATCHED. That inverts the assertion and is
# how this check first read red against correct code. Match on the string with
# case, no pipeline, no exit status to misread.
elif case "$_fn_body" in *'emit_event_json "agent_prompt"'*) true ;; *) false ;; esac \
   && case "$_fn_body" in *'emit_stage_complete "agent"'*) true ;; *) false ;; esac; then
    ok "the measurement shares run_autonomous() with the agent stage"
else
    bad "the emit left the agent call's function -- it may measure the wrong prompt"
fi

# Scope alone is not enough: it must read the variables the completed call set.
# A copy that measured some other string would still sit in the right function.
_blk="$(grep -B26 -A6 'emit_event_json "agent_prompt"' "$RUN_SH")"
case "$_blk" in
    *'printf '\''%s'\'' "$prompt" | wc -c'*)
        ok "it measures \$prompt, the string actually sent to the provider" ;;
    *) bad "the emit does not measure \$prompt -- it may be sizing something else" ;;
esac

# It must carry the duration too: bytes alone cannot show a size/latency
# relationship, which is the entire reason to record it.
case "$_blk" in
    *'duration_s=$duration'*) ok "the event carries duration alongside bytes" ;;
    *) bad "no duration on the event -- size cannot be correlated with latency" ;;
esac

# --- unmeasurable must emit NOTHING, never 0 ---------------------------------
case "$_blk" in
    *'''''|*[!0-9]*) ;;'''*) ok "a non-numeric size emits nothing (no fabricated 0)" ;;
    *)
        # Fall back to a looser check: the guard must reject non-numeric input.
        case "$_blk" in
            *'[!0-9]'*) ok "a non-numeric size emits nothing (no fabricated 0)" ;;
            *) bad "no numeric guard -- an unmeasurable size could record as 0" ;;
        esac ;;
esac

# --- it must not fail the run ------------------------------------------------
case "$_blk" in
    *'|| true'*) ok "the emit cannot abort the iteration" ;;
    *) bad "an emit failure could abort the run on the hot path" ;;
esac

# --- RENDERED, not merely recorded -------------------------------------------
# The half-shipped pattern this repo has paid for repeatedly: a fact recorded
# and never surfaced influences nothing.
if grep -q 'agent prompt' "$MEASURE"; then
    ok "measure-run.sh renders the prompt size"
else
    bad "recorded but never rendered -- the number cannot inform anything"
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-promptsize-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.loki"
cat > "$SCRATCH/.loki/events.jsonl" <<'JSONL'
{"type":"stage_complete","data":{"stage":"agent","status":"pass","duration_s":1730,"iteration":1}}
{"type":"agent_prompt","data":{"bytes":163840,"iteration":1,"duration_s":1730}}
{"type":"agent_prompt","data":{"bytes":204800,"iteration":2,"duration_s":900}}
{"type":"iteration_complete","data":{"iteration":1}}
JSONL

_out="$(bash "$MEASURE" "$SCRATCH" 2>&1)"
case "$_out" in
    *"agent prompt"*"KB"*) ok "the rendered report shows a KB figure" ;;
    *) bad "prompt size missing from the report: $(printf '%s' "$_out" | tail -3)" ;;
esac
case "$_out" in
    *"160-200 KB"*) ok "the range reflects both recorded calls" ;;
    *) bad "the min/max range is wrong or absent" ;;
esac

# --- a run WITHOUT the event says so, rather than showing 0 ------------------
mkdir -p "$SCRATCH/nodata/.loki"
printf '{"type":"stage_complete","data":{"stage":"agent","status":"pass","duration_s":10,"iteration":1}}\n' \
    > "$SCRATCH/nodata/.loki/events.jsonl"
_none="$(bash "$MEASURE" "$SCRATCH/nodata" 2>&1)"
case "$_none" in
    *"agent prompt      : not recorded"*)
        ok "a run without the event reports 'not recorded', not 0 KB" ;;
    *"agent prompt"*"0 KB"*)
        bad "a run with no data rendered 0 KB -- that is a claim, not an absence" ;;
    *) bad "the no-data case is unhandled" ;;
esac

# --- machine-readable output carries it too ----------------------------------
_json="$(bash "$MEASURE" --json "$SCRATCH" 2>&1)"
if printf '%s' "$_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d.get('agent_prompt_bytes') else 1)" 2>/dev/null; then
    ok "--json exposes agent_prompt_bytes"
else
    bad "--json omits the prompt size, so no tool can consume it"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
