#!/usr/bin/env bash
# tests/test-doc-scope-build-prompt.sh -- verifies the DOC_SCOPE instruction
# emitted by the bash build_prompt() (autonomy/run.sh) scales to the detected
# project complexity (F52: a trivial one-file app must not get a nine-file
# architecture documentation suite).
#
#   DETECTED_COMPLEXITY=simple   -> minimal-doc instruction (SIMPLE needle)
#   DETECTED_COMPLEXITY=standard -> full-suite instruction  (FULL needle)
#   DETECTED_COMPLEXITY=complex  -> full-suite instruction  (FULL needle)
#   DETECTED_COMPLEXITY unset    -> full-suite instruction  (parity with the
#                                   bash default ${DETECTED_COMPLEXITY:-standard})
#
# Asserted across the static-first, legacy, and degraded layouts, in PRD and
# no-PRD modes. The instruction strings are parity-locked byte-identical to
# DOC_SCOPE_INSTRUCTION_{SIMPLE,FULL} in loki-ts/src/runner/build_prompt.ts
# (the Bun-route equivalents are covered by build_prompt_units.test.ts).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

# Stable fragments unique to each tier variant (not the whole string).
SIMPLE_NEEDLE='This is a small, simple project. Keep documentation minimal and proportional'
SIMPLE_GUARD='Do NOT generate a multi-file architecture documentation suite'
FULL_NEEDLE='Scale documentation to what a reader of THIS project actually needs'

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-doc-scope-bp-XXXX)

# render <retry> <prd> <iteration> <legacy> <degraded> <complexity>
render() {
    local retry="$1" prd="$2" iteration="$3"
    local legacy="$4" degraded="$5" complexity="$6"
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
               LOKI_HUMAN_INPUT=""
        export LOKI_LEGACY_PROMPT_ORDERING="$legacy"
        export PROVIDER_DEGRADED="$degraded"
        # build_prompt reads the DETECTED_COMPLEXITY global (set once per run by
        # run_autonomous). Set it directly here, or leave unset for the default.
        if [ -n "$complexity" ]; then
            DETECTED_COMPLEXITY="$complexity"
        else
            DETECTED_COMPLEXITY=""
        fi
        build_prompt "$retry" "$prd" "$iteration" 2>/dev/null
    )
}

assert_simple() {
    local label="$1" out="$2"
    case "$out" in
        *"$SIMPLE_NEEDLE"*"$SIMPLE_GUARD"*)
            case "$out" in
                *"$FULL_NEEDLE"*) bad "$label: SIMPLE present but FULL also leaked in" ;;
                *) ok "$label: SIMPLE doc_scope present, FULL absent" ;;
            esac ;;
        *) bad "$label: SIMPLE doc_scope MISSING" ;;
    esac
}

assert_full() {
    local label="$1" out="$2"
    case "$out" in
        *"$FULL_NEEDLE"*)
            case "$out" in
                *"$SIMPLE_NEEDLE"*) bad "$label: FULL present but SIMPLE also leaked in" ;;
                *) ok "$label: FULL doc_scope present, SIMPLE absent" ;;
            esac ;;
        *) bad "$label: FULL doc_scope MISSING" ;;
    esac
}

# A PRD file for the with-PRD cases.
printf '%s\n' '# Sample PRD' > "$TMPROOT/prd.md"

# --- simple tier: minimal docs across layouts ----------------------------
assert_simple "static default no-PRD (simple)"   "$(render 0 ""               1 "false" "false" "simple")"
assert_simple "static default with-PRD (simple)" "$(render 0 "$TMPROOT/prd.md" 1 "false" "false" "simple")"
assert_simple "legacy no-PRD (simple)"           "$(render 0 ""               1 "true"  "false" "simple")"
assert_simple "legacy with-PRD (simple)"         "$(render 0 "$TMPROOT/prd.md" 1 "true"  "false" "simple")"
assert_simple "legacy resume no-PRD (simple)"    "$(render 1 ""               2 "true"  "false" "simple")"
assert_simple "degraded no-PRD (simple)"         "$(render 0 ""               1 "false" "true"  "simple")"
assert_simple "degraded with-PRD (simple)"       "$(render 0 "$TMPROOT/prd.md" 1 "false" "true"  "simple")"

# --- standard / complex tier: full suite ---------------------------------
assert_full "static default no-PRD (standard)"   "$(render 0 ""               1 "false" "false" "standard")"
assert_full "static default with-PRD (complex)"  "$(render 0 "$TMPROOT/prd.md" 1 "false" "false" "complex")"
assert_full "legacy no-PRD (complex)"            "$(render 0 ""               1 "true"  "false" "complex")"
assert_full "degraded with-PRD (standard)"       "$(render 0 "$TMPROOT/prd.md" 1 "false" "true"  "standard")"

# --- unset tier: defaults to full (parity with ${DETECTED_COMPLEXITY:-standard}) ---
assert_full "static default no-PRD (unset)"      "$(render 0 ""               1 "false" "false" "")"

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
