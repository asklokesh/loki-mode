#!/usr/bin/env bash
# Test: Provider flag placement and model-catalog freshness (v7.110.0)
#
# Regression coverage for two provider bugs fixed in v7.110.0:
#   BUG 1 (codex.sh): the top-level `codex --search` flag was placed AFTER the
#     `exec` subcommand. On codex 0.141.0 `codex exec ... --search` aborts with
#     "unexpected argument '--search' found", silently breaking the documented
#     LOKI_CODEX_WEB_SEARCH feature. --search must appear BEFORE `exec`.
#   BUG 2 (models.sh): a stale hardcoded model id `claude-opus-4-7` (not in the
#     catalog; current catalog opus id is claude-opus-4-8).
#
# These tests do NOT invoke the real codex CLI: `codex` is stubbed as a shell
# function that echoes its argv, so the built command string can be asserted.
# They self-skip if `providers/codex.sh` / `providers/models.sh` are absent.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }

echo "========================================"
echo "Provider Flag Placement Tests (v7.110.0)"
echo "========================================"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# Self-skip if the files under test are absent.
if [ ! -f "$PROVIDERS_DIR/codex.sh" ] || [ ! -f "$PROVIDERS_DIR/models.sh" ]; then
    log_skip "providers/codex.sh or providers/models.sh not found; skipping"
    exit 0
fi

# ===========================================
# BUG 1: build the codex command with a stub and assert --search placement.
#
# The build runs in a subshell so the `codex` stub function and the sourced
# provider globals do not leak into the rest of the suite.
# ===========================================
build_codex_cmd() {
    # $1 = value for LOKI_CODEX_WEB_SEARCH
    (
        # Stub `codex`: echo the full argv so we can assert on it. This shadows
        # the real binary for the duration of the subshell only.
        codex() { echo "codex $*"; }
        # Keep the loop deterministic and avoid the exec-flag noise: no log file
        # means --output-last-message is not added.
        unset LOKI_LOG_FILE
        export LOKI_CODEX_WEB_SEARCH="$1"
        # shellcheck disable=SC1090
        source "$PROVIDERS_DIR/codex.sh"
        provider_invoke_with_tier development "PROMPT_TOKEN"
    )
}

log_test "codex --search is placed BEFORE the exec subcommand (BUG 1)"
cmd_on="$(build_codex_cmd true)"
echo "  built: $cmd_on"
# Correct: '--search' appears and comes before 'exec'.
if printf '%s\n' "$cmd_on" | grep -q -- '--search'; then
    # Everything left of the first 'exec' token.
    before_exec="${cmd_on%%exec*}"
    if printf '%s\n' "$before_exec" | grep -q -- '--search'; then
        log_pass "--search precedes exec: $cmd_on"
    else
        log_fail "--search present but placed AFTER exec (breaks codex 0.141.0): $cmd_on"
    fi
else
    log_fail "--search missing entirely when LOKI_CODEX_WEB_SEARCH=true: $cmd_on"
fi

log_test "no --search when LOKI_CODEX_WEB_SEARCH is unset/false (BUG 1 guard)"
cmd_off="$(build_codex_cmd false)"
echo "  built: $cmd_off"
if printf '%s\n' "$cmd_off" | grep -q -- '--search'; then
    log_fail "--search leaked in when web search disabled: $cmd_off"
else
    log_pass "no --search when disabled: $cmd_off"
fi

# ===========================================
# BUG 2: no stale claude-opus-4-7 reference in the in-scope provider files.
#
# Scoped to codex.sh + models.sh ONLY. Other provider files (claude.sh,
# cline.sh, aider.sh) still carry claude-opus-4-7 and are owned by other
# agents; widening this grep would red-flag on code outside this fix's mandate.
# ===========================================
log_test "no stale claude-opus-4-7 in codex.sh / models.sh (BUG 2)"
stale_hits="$(grep -rn 'claude-opus-4-7' "$PROVIDERS_DIR/codex.sh" "$PROVIDERS_DIR/models.sh" 2>/dev/null)"
if [ -n "$stale_hits" ]; then
    log_fail "stale claude-opus-4-7 reference found:"
    printf '%s\n' "$stale_hits"
else
    log_pass "no claude-opus-4-7 in codex.sh / models.sh"
fi

echo ""
echo "========================================"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo "========================================"

[ "$FAILED" -eq 0 ]
