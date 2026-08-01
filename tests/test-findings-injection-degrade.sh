#!/usr/bin/env bash
# A feedback loop that stops feeding back must SAY SO.
#
# WHY (F2 in docs/FIRST-PASS-COMPLETION-PLAN.md). Findings injection is what
# tells the next iteration WHAT to fix. It defaults ON -- but the call was gated
# on `command -v bun`, so on a machine without bun it degraded with no signal at
# all. The agent was then told only that it failed.
#
# That is the single largest failure shape in the research: "the agent did not
# attempt to recover from an error" accounts for **56%** of agent failures
# (SlopCodeBench, arXiv 2603.24755). A silently-dead feedback loop manufactures
# exactly that, and misattributes it: the next iteration looks like the model
# failing when it was never told what went wrong.
#
# A missing capability must be VISIBLE. A silent one is worse than an absent
# feature, because it sends the diagnosis in the wrong direction.
#
# ASSERTED:
#   - bun present  -> inject (no warning)
#   - bun absent   -> warn AND record capability_degraded
#   - opted out    -> silent (no warning, no event)
#   - the warning names the CONSEQUENCE, not just the missing binary

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: findings injection degrades loudly"

# The branch under test, lifted from run.sh so the three paths can be driven
# without a provider call. The WIRING assertions below pin it to the original.
_block="$(grep -A24 'if \[ "${LOKI_INJECT_FINDINGS:-1}" != "0" \]; then' "$RUN_SH" | head -26)"

if [ -z "$_block" ]; then
    bad "could not locate the findings-injection branch; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "located the findings-injection branch"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-inject-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# A PATH with the shell utilities but deliberately WITHOUT bun. Emptying PATH
# entirely would remove bash itself and the probe would "fail" for the wrong
# reason -- the harness bug that produced a false PASS earlier in this session.
_nobun="$SCRATCH/nobun"
mkdir -p "$_nobun"
for b in bash env sed grep printf command; do
    _r="$(command -v "$b" 2>/dev/null)" || continue
    ln -sf "$_r" "$_nobun/$b" 2>/dev/null || true
done
if command -v bun >/dev/null 2>&1 && [ -e "$_nobun/bun" ]; then
    bad "harness failed to hide bun; the degraded case would prove nothing"
fi

run_case() {
    local inject="$1" path="$2"
    env -i PATH="$path" LOKI_INJECT_FINDINGS="$inject" HOME="$SCRATCH" bash -c '
        log_warn(){ printf "WARN %s\n" "$*"; }
        emit_event_json(){ printf "EVENT %s %s\n" "$1" "$2"; }
        ITERATION_COUNT=1; SCRIPT_DIR=/nonexistent
        if [ "${LOKI_INJECT_FINDINGS:-1}" != "0" ]; then
            if command -v bun >/dev/null 2>&1; then
                printf "INJECTED\n"
            else
                log_warn "Findings injection unavailable (bun not found): the next iteration will be told it failed but NOT what to fix."
                emit_event_json "capability_degraded" "capability=inject_findings"
            fi
        fi
    ' 2>&1
}

# --- bun absent -> loud ------------------------------------------------------
_out="$(run_case 1 "$_nobun")"
case "$_out" in
    *"WARN"*) ok "a missing bun produces a warning" ;;
    *) bad "a missing bun degrades SILENTLY -- the 56% failure shape" ;;
esac
case "$_out" in
    *"capability_degraded"*) ok "the degradation is recorded as an event" ;;
    *) bad "no capability_degraded event; the receipt cannot show it" ;;
esac
case "$_out" in
    *"NOT what to fix"*) ok "the warning names the CONSEQUENCE, not just the binary" ;;
    *) bad "the warning does not say what the user loses" ;;
esac

# --- opted out -> silent -----------------------------------------------------
# A warning for a deliberate choice is noise, and noise trains users to ignore
# the channel that carries the real warning.
_out="$(run_case 0 "$_nobun")"
if [ -z "$_out" ]; then
    ok "LOKI_INJECT_FINDINGS=0 is silent"
else
    bad "opting out still warns: $_out"
fi

# --- bun present -> inject, no warning ---------------------------------------
if command -v bun >/dev/null 2>&1; then
    _out="$(run_case 1 "$PATH")"
    case "$_out" in
        *INJECTED*) ok "with bun present the injection path runs" ;;
        *) bad "bun is present but the injection path did not run: $_out" ;;
    esac
    case "$_out" in
        *WARN*) bad "warns even though bun is present" ;;
        *) ok "no warning when the capability is available" ;;
    esac
else
    echo "  SKIP: bun not installed; present-path assertions not run"
fi

# --- WIRING ------------------------------------------------------------------
# The cases above drive a copy. These pin the original, because a correct rule
# that run.sh does not carry is the gap this codebase has hit repeatedly.
case "$_block" in
    *"command -v bun"*) ok "WIRING: run.sh still probes for bun" ;;
    *) bad "WIRING: the bun probe is gone" ;;
esac
case "$_block" in
    *"log_warn"*) ok "WIRING: run.sh warns on the degraded path" ;;
    *) bad "WIRING: run.sh degrades without warning -- silent again" ;;
esac
# Matches the CALL, not the string. A first version looked for the literal
# "capability_degraded", so a mutation replacing emit_event_json with `false`
# left the argument in place and the assertion still passed -- it was reading
# the payload rather than the thing that emits it.
case "$_block" in
    *'emit_event_json "capability_degraded"'*)
        ok "WIRING: run.sh records the degradation" ;;
    *) bad "WIRING: capability_degraded is no longer EMITTED (string may remain)" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
