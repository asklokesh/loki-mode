#!/usr/bin/env bash
# The user must see the rework split, not just the agent.
#
# The eval trend gave the AGENT its own progress/rework counts to steer on. The
# user's completion summary still reported only "Tasks: pending=.. completed=..",
# which cannot distinguish real work from a gate false positive that forced
# redos.
#
# That distinction is not academic. A measured run had the agent claim done on
# EVERY iteration while a mock-integrity false positive blocked all six: the run
# looked like six iterations of work and was one iteration of work plus five of
# harness bug. Without the split, a user staring at a slow expensive run cannot
# tell whether the model was slow or our own gate was wrong.
#
# THE PROPERTY THAT MUST NOT REGRESS: when the split is UNKNOWN, render nothing.
# A 0-of-0 line reads as "no rework happened", which is a clean bill of health
# we have not earned. Silence is correct; a fabricated zero points the user at
# the wrong culprit. Same rule the stage-timing table already follows.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ATTR="$REPO_ROOT/autonomy/lib/iteration_attribution.py"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: rework attribution in the completion summary"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-rework-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Mirror of the renderer embedded in emit_completion_summary.
render() {
    python3 "$ATTR" --loki-dir "$1" --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
prog, rew = d.get('progress', {}), d.get('rework', {})
pc, rc = prog.get('count', 0), rew.get('count', 0)
if pc + rc == 0:
    sys.exit(0)
cost = rew.get('cost_usd', 0.0) or 0.0
line = 'Rework: %d of %d iteration(s) redid earlier work' % (rc, pc + rc)
if cost > 0:
    line += ' (\$%.2f)' % cost
print(line)
" 2>/dev/null
}

seed() {
    local dir="$SCRATCH/$1"; shift
    rm -rf "$dir"; mkdir -p "$dir/.loki/metrics/efficiency"
    local n=1
    for st in "$@"; do
        printf '{"iteration":%d,"model":"sonnet","duration_ms":60000,"cost_usd":0.4,"status":"%s"}\n' \
            "$n" "$st" > "$dir/.loki/metrics/efficiency/iteration-$n.json"
        n=$((n + 1))
    done
    printf '%s' "$dir/.loki"
}

# --- 1. a real split is reported, with its cost ------------------------------
d="$(seed mixed completed completed completed failed failed)"
out="$(render "$d")"
if [[ "$out" == *"2 of 5"* ]]; then
    ok "a real split reports rework count and total"
else
    ko "a real split reports rework count and total" "got: ${out:-<empty>}"
fi
if [[ "$out" == *"0.80"* ]]; then
    ok "the rework COST is reported (what the user is actually paying for)"
else
    ko "the rework COST is reported" "got: ${out:-<empty>}"
fi

# --- 2. THE PROPERTY. Unknown split renders nothing. -------------------------
d="$(seed unknown ok ok)"
out="$(render "$d")"
if [[ -z "$out" ]]; then
    ok "an unknown split renders NOTHING, not a 0-of-0 clean bill"
else
    ko "an unknown split renders NOTHING, not a 0-of-0 clean bill" \
       "rendered '$out' -- this claims no rework happened without evidence"
fi

# --- 3. absent metrics: silent, no crash -------------------------------------
rm -rf "$SCRATCH/empty"; mkdir -p "$SCRATCH/empty/.loki"
out="$(render "$SCRATCH/empty/.loki")"
[[ -z "$out" ]] \
    && ok "a run with no metrics renders nothing and does not fail" \
    || ko "a run with no metrics renders nothing" "got: $out"

out="$(render "/nonexistent-path-$$/.loki")"
[[ -z "$out" ]] \
    && ok "a missing loki dir renders nothing and does not fail" \
    || ko "a missing loki dir renders nothing" "got: $out"

# --- 4. an all-rework run is reported as such --------------------------------
# The worst case, and the one worth naming: every iteration redid work.
d="$(seed allbad failed failed failed)"
out="$(render "$d")"
[[ "$out" == *"3 of 3"* ]] \
    && ok "an all-rework run is reported as 3 of 3" \
    || ko "an all-rework run is reported as 3 of 3" "got: ${out:-<empty>}"

# --- 5. a clean run reports zero rework, not silence -------------------------
# Distinct from case 2: here the split IS known and rework is genuinely zero.
d="$(seed allgood completed completed)"
out="$(render "$d")"
[[ "$out" == *"0 of 2"* ]] \
    && ok "a genuinely clean run reports 0 of 2 (known, not unknown)" \
    || ko "a genuinely clean run reports 0 of 2" "got: ${out:-<empty>}"

# --- 6. the summary actually emits it ----------------------------------------
# Wiring check: computing the line and never printing it would pass everything
# above while showing the user nothing.
if grep -q '_LOKI_REWORK_LINE' "$RUN_SH"; then
    ok "the summary computes the rework line"
else
    ko "the summary computes the rework line"
fi
if grep -qE 'echo "\$_LOKI_REWORK_LINE"' "$RUN_SH"; then
    ok "the summary PRINTS the rework line"
else
    ko "the summary PRINTS the rework line" "computed but never shown to the user"
fi

# --- 7. one renderer, so agent and user cannot disagree ----------------------
# The prompt-side trend and this line must come from the same source.
if grep -q "iteration_attribution.py" "$RUN_SH"; then
    ok "user line and agent trend share one attribution source"
else
    ko "user line and agent trend share one attribution source" \
       "two renderers will drift and report different numbers for one run"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
