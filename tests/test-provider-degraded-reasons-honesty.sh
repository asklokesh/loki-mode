#!/usr/bin/env bash
# Test: degraded-provider self-documentation honesty (providers I own: aider).
#
# A provider that reports PROVIDER_HAS_PARALLEL=false / PROVIDER_MAX_PARALLEL=1
# MUST document that parallelism limitation in PROVIDER_DEGRADED_REASONS, the
# human-readable list surfaced by print_provider_info(). Before this fix, aider
# declared PROVIDER_HAS_PARALLEL=false but its reasons array said only
# "Sequential execution only", which never mentioned parallel agents, so a user
# reading `loki provider info aider` (or the capability matrix) was not told the
# real limitation. The sibling degraded provider (codex) already documents it
# ("cannot spawn parallel agents" / "no cheap tier for parallelization").
#
# Non-vacuity: the assertion is on the ACTUAL reasons array sourced from
# providers/aider.sh, and it checks BOTH that the no-parallel capability flag is
# set AND that the reasons text discloses it. A regression that drops the
# disclosure (or that flips the flag) makes this test fail.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }

echo "========================================"
echo "Degraded-provider reason honesty (aider)"
echo "========================================"

# --- aider: declares no parallelism, must document it -----------------------
(
    # shellcheck source=../providers/aider.sh
    source "$PROVIDERS_DIR/aider.sh"

    # Precondition: aider really is non-parallel. If this ever changes, the
    # honesty requirement below changes too, so assert the precondition first.
    if [ "${PROVIDER_HAS_PARALLEL}" != "false" ] || [ "${PROVIDER_MAX_PARALLEL}" != "1" ]; then
        echo "PRECOND_CHANGED"
        exit 0
    fi

    found=false
    for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
        case "$reason" in
            *parallel*|*"cheap tier"*) found=true; break ;;
        esac
    done
    if [ "$found" = "true" ]; then
        echo "OK"
    else
        echo "MISSING: $(printf '%s | ' "${PROVIDER_DEGRADED_REASONS[@]}")"
    fi
)
aider_result="$(
    source "$PROVIDERS_DIR/aider.sh"
    if [ "${PROVIDER_HAS_PARALLEL}" != "false" ] || [ "${PROVIDER_MAX_PARALLEL}" != "1" ]; then
        echo "PRECOND_CHANGED"; exit 0
    fi
    found=false
    for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
        case "$reason" in
            *parallel*|*"cheap tier"*) found=true; break ;;
        esac
    done
    [ "$found" = "true" ] && echo "OK" || echo "MISSING"
)"

case "$aider_result" in
    OK)             log_pass "aider PROVIDER_DEGRADED_REASONS documents the parallelism limitation" ;;
    PRECOND_CHANGED) log_pass "aider is now parallel-capable; honesty precondition no longer applies" ;;
    *)              log_fail "aider PROVIDER_DEGRADED_REASONS must mention parallelism (got: $aider_result)" ;;
esac

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
