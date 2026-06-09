#!/usr/bin/env bash
# tests/test-agents-md-build-prompt.sh -- verifies the AGENTS.md conventions
# instruction line is emitted by the bash build_prompt() (autonomy/run.sh) in
# every relevant block:
#   - static-first default layout (LOKI_LEGACY_PROMPT_ORDERING unset/false)
#   - legacy single-echo layout (LOKI_LEGACY_PROMPT_ORDERING=true)
#   - degraded-provider layout (PROVIDER_DEGRADED=true)
# and in both PRD and no-PRD modes.
#
# The instruction string is parity-locked byte-identical to AGENTS_MD_INSTRUCTION
# in loki-ts/src/runner/build_prompt.ts (see test-parity-agents-md.sh).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

# The exact instruction substring (a stable fragment, not the whole string).
NEEDLE='read AGENTS.md in the repository root for build, test, and style conventions. If AGENTS.md is absent, read CLAUDE.md instead. The nearest such file to the code you are editing takes precedence.'

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-agents-md-bp-XXXX)

# render <retry> <prd> <iteration> with the given env overrides, captured from a
# clean subshell that sources run.sh in the fixture cwd (mirrors run-bash.sh).
render() {
    local retry="$1" prd="$2" iteration="$3"
    local legacy="$4" degraded="$5"
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
        build_prompt "$retry" "$prd" "$iteration" 2>/dev/null
    )
}

assert_has() {
    local label="$1" out="$2"
    case "$out" in
        *"$NEEDLE"*) ok "$label: AGENTS.md instruction present" ;;
        *) bad "$label: AGENTS.md instruction MISSING" ;;
    esac
}

# A PRD file for the with-PRD cases.
printf '%s\n' '# Sample PRD' > "$TMPROOT/prd.md"

# 1. static-first default, no PRD (also carries CODEBASE_ANALYSIS_MODE).
out=$(render 0 "" 1 "false" "false")
assert_has "static default no-PRD" "$out"
# Regression guard: the prior ANALYSIS parity fix must not be lost.
case "$out" in
    *"CODEBASE_ANALYSIS_MODE"*) ok "static default no-PRD: CODEBASE_ANALYSIS_MODE still present (no regression)" ;;
    *) bad "static default no-PRD: CODEBASE_ANALYSIS_MODE missing (analysis regression)" ;;
esac

# 2. static-first default, with PRD.
out=$(render 0 "$TMPROOT/prd.md" 1 "false" "false")
assert_has "static default with-PRD" "$out"

# 3. legacy ordering, no PRD.
out=$(render 0 "" 1 "true" "false")
assert_has "legacy ordering no-PRD" "$out"

# 4. legacy ordering, with PRD.
out=$(render 0 "$TMPROOT/prd.md" 1 "true" "false")
assert_has "legacy ordering with-PRD" "$out"

# 5. legacy ordering, resume (retry > 0), no PRD.
out=$(render 1 "" 2 "true" "false")
assert_has "legacy ordering resume no-PRD" "$out"

# 6. degraded provider, static-first, no PRD.
out=$(render 0 "" 1 "false" "true")
assert_has "degraded static no-PRD" "$out"

# 7. degraded provider, static-first, with PRD.
out=$(render 0 "$TMPROOT/prd.md" 1 "false" "true")
assert_has "degraded static with-PRD" "$out"

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
