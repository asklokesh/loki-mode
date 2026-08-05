#!/usr/bin/env bash
# tests/test-self-heal-injection.sh -- SLICE 6c self-heal.
#
# Verifies that build_prompt() (autonomy/run.sh) routes the PRIOR iteration's
# classified error signature (.loki/state/LAST_ERROR.json) into the next
# iteration's prompt as a SELF_HEAL_HINT, gated on LOKI_SELF_HEAL (default 0),
# and that the hint injects exactly ONCE (the record is consumed after injection
# so it does not double-inject on the following iteration).
#
# Assertions:
#   1. LOKI_SELF_HEAL=1 + actionable LAST_ERROR -> hint appears with error_class.
#   2. LOKI_SELF_HEAL=0 (default) -> no hint (opt-in; stock runs unaffected).
#   3. After one injection the record is cleared -> a second render does NOT
#      re-inject (no forever-repeat).
#   4. error_class=unknown is NOT actionable -> no hint.
#   5. LEARN-FORWARD: the consumed record is archived to failure-history.jsonl.
#
# Hermetic: no network, no API calls, no token spend. build_prompt is sourced
# from run.sh in a clean subshell (mirrors test-agents-md-build-prompt.sh).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

NEEDLE='SELF_HEAL_HINT:'
CLASS='provider_empty_output'

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-self-heal-XXXX)

# write_last_error <error_class> <brief> <iteration>
write_last_error() {
    mkdir -p "$TMPROOT/.loki/state"
    printf '{"iteration":%s,"error_class":"%s","brief":"%s","timestamp":"2026-01-01T00:00:00Z"}\n' \
        "$3" "$1" "$2" > "$TMPROOT/.loki/state/LAST_ERROR.json"
}

# render <self_heal 0|1> -- source run.sh and emit build_prompt output.
render() {
    local self_heal="$1"
    (
        cd "$TMPROOT" || exit 1
        export LOKI_PHASE_UNIT_TESTS="false" LOKI_PHASE_API_TESTS="false" \
               LOKI_PHASE_E2E_TESTS="false" LOKI_PHASE_SECURITY="false" \
               LOKI_PHASE_INTEGRATION="false" LOKI_PHASE_CODE_REVIEW="false" \
               LOKI_PHASE_WEB_RESEARCH="false" LOKI_PHASE_PERFORMANCE="false" \
               LOKI_PHASE_ACCESSIBILITY="false" LOKI_PHASE_REGRESSION="false" \
               LOKI_PHASE_UAT="false"
        # shellcheck disable=SC1090
        source "$RUN_SH" >/dev/null 2>&1
        export MAX_PARALLEL_AGENTS=10 MAX_ITERATIONS=1000 TARGET_DIR="." \
               AUTONOMY_MODE="" PERPETUAL_MODE="false" COMPLETION_PROMISE="" \
               LOKI_HUMAN_INPUT="" LOKI_LEGACY_PROMPT_ORDERING="false" \
               PROVIDER_DEGRADED="false"
        export LOKI_SELF_HEAL="$self_heal"
        build_prompt 0 "" 2 2>/dev/null
    )
}

has_hint() { case "$1" in *"$NEEDLE"*) return 0 ;; *) return 1 ;; esac; }
has_class() { case "$1" in *"error_class=$CLASS"*) return 0 ;; *) return 1 ;; esac; }

# --- 1. LOKI_SELF_HEAL=1 + actionable LAST_ERROR -> hint present with class ---
write_last_error "$CLASS" "The provider returned no output." 5
out=$(render 1)
if has_hint "$out" && has_class "$out"; then
    ok "SELF_HEAL=1 injects hint naming error_class=$CLASS"
else
    bad "SELF_HEAL=1 should inject hint with error_class=$CLASS"
fi

# --- 2. LOKI_SELF_HEAL=0 (default) -> no hint even when record present ---
write_last_error "$CLASS" "The provider returned no output." 5
out=$(render 0)
if has_hint "$out"; then
    bad "SELF_HEAL=0 must NOT inject a hint (opt-in)"
else
    ok "SELF_HEAL=0 injects no hint (stock runs unaffected)"
fi

# --- 3. clear-after-injection: second render (record consumed) has no hint ---
write_last_error "$CLASS" "The provider returned no output." 5
out1=$(render 1)   # consumes LAST_ERROR.json
out2=$(render 1)   # record now gone -> no re-inject
if has_hint "$out1" && ! has_hint "$out2"; then
    ok "hint injects exactly once (cleared after injection, no double-inject)"
else
    bad "hint must inject once then clear (out1 hint=$(has_hint "$out1" && echo y || echo n), out2 hint=$(has_hint "$out2" && echo y || echo n))"
fi

# --- 4. error_class=unknown is NOT actionable -> no hint ---
write_last_error "unknown" "Iteration failed (cause not classified)." 5
out=$(render 1)
if has_hint "$out"; then
    bad "unknown error_class must NOT inject a hint"
else
    ok "unknown error_class injects no hint (not actionable)"
fi

# --- 5. LEARN-FORWARD: consumed record archived to failure-history.jsonl ---
rm -f "$TMPROOT/.loki/state/failure-history.jsonl"
write_last_error "$CLASS" "The provider returned no output." 7
render 1 >/dev/null
if [ -f "$TMPROOT/.loki/state/failure-history.jsonl" ] && \
   grep -q "$CLASS" "$TMPROOT/.loki/state/failure-history.jsonl"; then
    ok "consumed record archived to failure-history.jsonl (learn-forward)"
else
    bad "consumed record should be archived to failure-history.jsonl"
fi

printf '\n== self-heal injection: %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
