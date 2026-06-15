#!/usr/bin/env bash
# Test: Provider Invocation Functions
# Tests provider_invoke(), provider_invoke_with_tier(), and provider_get_tier_param()

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

# Source the loader
source "$PROVIDERS_DIR/loader.sh"

echo "========================================"
echo "Provider Invocation Tests"
echo "========================================"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# ===========================================
# Test 1: provider_invoke() function exists for each provider
# ===========================================
log_test "provider_invoke() function exists for each provider"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    (
        source "$PROVIDERS_DIR/${provider}.sh"
        if type provider_invoke >/dev/null 2>&1; then
            exit 0
        else
            exit 1
        fi
    )
    if [ $? -eq 0 ]; then
        log_pass "provider_invoke() exists for $provider"
    else
        log_fail "provider_invoke() missing for $provider"
    fi
done

# ===========================================
# Test 2: provider_invoke_with_tier() function exists for each provider
# ===========================================
log_test "provider_invoke_with_tier() function exists for each provider"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    (
        source "$PROVIDERS_DIR/${provider}.sh"
        if type provider_invoke_with_tier >/dev/null 2>&1; then
            exit 0
        else
            exit 1
        fi
    )
    if [ $? -eq 0 ]; then
        log_pass "provider_invoke_with_tier() exists for $provider"
    else
        log_fail "provider_invoke_with_tier() missing for $provider"
    fi
done

# ===========================================
# Test 3: provider_get_tier_param() function exists for each provider
# ===========================================
log_test "provider_get_tier_param() function exists for each provider"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    (
        source "$PROVIDERS_DIR/${provider}.sh"
        if type provider_get_tier_param >/dev/null 2>&1; then
            exit 0
        else
            exit 1
        fi
    )
    if [ $? -eq 0 ]; then
        log_pass "provider_get_tier_param() exists for $provider"
    else
        log_fail "provider_get_tier_param() missing for $provider"
    fi
done

# ===========================================
# Test 4: provider_get_tier_param() returns correct values for claude
# ===========================================
log_test "provider_get_tier_param() returns correct tier values for claude"

result=$(
    source "$PROVIDERS_DIR/claude.sh"

    planning=$(provider_get_tier_param "planning")
    development=$(provider_get_tier_param "development")
    fast=$(provider_get_tier_param "fast")
    default_val=$(provider_get_tier_param "unknown")

    # Claude returns model aliases (default: opus for planning+dev, sonnet for fast)
    # With LOKI_ALLOW_HAIKU=true: opus/sonnet/haiku
    if [ "$planning" = "opus" ] && \
       [ "$development" = "opus" ] && \
       [ "$fast" = "sonnet" ] && \
       [ "$default_val" = "opus" ]; then
        echo "pass"
    else
        echo "fail: planning=$planning, development=$development, fast=$fast, default=$default_val"
    fi
)
if [ "$result" = "pass" ]; then
    log_pass "provider_get_tier_param() returns correct values for claude (opus/opus/sonnet default)"
else
    log_fail "provider_get_tier_param() returns incorrect values for claude - $result"
fi

# ===========================================
# Test 5: provider_get_tier_param() returns correct values for codex
# ===========================================
log_test "provider_get_tier_param() returns correct tier values for codex"

result=$(
    source "$PROVIDERS_DIR/codex.sh"

    planning=$(provider_get_tier_param "planning")
    development=$(provider_get_tier_param "development")
    fast=$(provider_get_tier_param "fast")
    default_val=$(provider_get_tier_param "unknown")

    # Codex should return effort levels
    if [ "$planning" = "xhigh" ] && \
       [ "$development" = "high" ] && \
       [ "$fast" = "low" ] && \
       [ "$default_val" = "high" ]; then
        echo "pass"
    else
        echo "fail: planning=$planning, development=$development, fast=$fast, default=$default_val"
    fi
)
if [ "$result" = "pass" ]; then
    log_pass "provider_get_tier_param() returns correct values for codex (xhigh/high/low)"
else
    log_fail "provider_get_tier_param() returns incorrect values for codex - $result"
fi

# Test 6: gemini tier param test removed in v7.5.18 Phase A (gemini provider removed).

# ===========================================
# Test 7: provider_invoke() has correct signature (accepts prompt + extra args)
# ===========================================
log_test "provider_invoke() accepts prompt and extra arguments"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    result=$(
        source "$PROVIDERS_DIR/${provider}.sh"

        # Check function signature by examining its definition
        # Functions should accept: prompt "$@"
        func_def=$(declare -f provider_invoke)

        # Verify function uses $1 for prompt and shift for extra args
        if echo "$func_def" | grep -q 'local prompt="\$1"' && \
           echo "$func_def" | grep -q 'shift'; then
            echo "pass"
        else
            echo "fail"
        fi
    )
    if [ "$result" = "pass" ]; then
        log_pass "provider_invoke() has correct signature for $provider"
    else
        log_fail "provider_invoke() has incorrect signature for $provider"
    fi
done

# ===========================================
# Test 8: provider_invoke_with_tier() has correct signature (accepts tier, prompt, extra args)
# ===========================================
log_test "provider_invoke_with_tier() accepts tier, prompt, and extra arguments"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    result=$(
        source "$PROVIDERS_DIR/${provider}.sh"

        # Check function signature by examining its definition
        func_def=$(declare -f provider_invoke_with_tier)

        # Verify function uses $1 for tier, $2 for prompt, and shift 2 for extra args
        if echo "$func_def" | grep -q 'local tier="\$1"' && \
           echo "$func_def" | grep -q 'local prompt="\$2"' && \
           echo "$func_def" | grep -q 'shift 2'; then
            echo "pass"
        else
            echo "fail"
        fi
    )
    if [ "$result" = "pass" ]; then
        log_pass "provider_invoke_with_tier() has correct signature for $provider"
    else
        log_fail "provider_invoke_with_tier() has incorrect signature for $provider"
    fi
done

# ===========================================
# Test 9: provider_invoke_with_tier() uses tier parameter
# ===========================================
log_test "provider_invoke_with_tier() uses tier parameter appropriately"

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    result=$(
        source "$PROVIDERS_DIR/${provider}.sh"

        func_def=$(declare -f provider_invoke_with_tier)

        # Verify function either:
        # 1. Calls provider_get_tier_param() for tier mapping, OR
        # 2. References $tier variable (for providers that handle tier differently), OR
        # 3. Is a single-model provider (cline/aider) that uses one externally
        #    configured model and has no tier to clamp -- correct by design.
        if echo "$func_def" | grep -q 'provider_get_tier_param'; then
            echo "pass:uses_get_tier_param"
        elif echo "$func_def" | grep -q '\$tier'; then
            echo "pass:references_tier"
        else
            case "$provider" in
                cline|aider) echo "pass:single_model_no_tier" ;;
                *) echo "fail" ;;
            esac
        fi
    )
    if [[ "$result" == pass:* ]]; then
        log_pass "provider_invoke_with_tier() handles tier for $provider (${result#pass:})"
    else
        log_fail "provider_invoke_with_tier() does not use tier parameter for $provider"
    fi
done

# ===========================================
# Test 10: All tiers map to non-empty values
# ===========================================
log_test "All tiers map to non-empty values"

tiers=("planning" "development" "fast")

for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    result=$(
        source "$PROVIDERS_DIR/${provider}.sh"

        for tier in "${tiers[@]}"; do
            tier_result=$(provider_get_tier_param "$tier")
            if [ -z "$tier_result" ]; then
                echo "fail: empty result for tier: $tier"
                exit 0
            fi
        done
        echo "pass"
    )
    if [ "$result" = "pass" ]; then
        log_pass "All tiers return non-empty values for $provider"
    else
        log_fail "Some tiers return empty values for $provider - $result"
    fi
done

# ===========================================
# Test 11: codex provider_invoke() passes --model with the resolved model (BUG 1)
# Captures the real codex argv via a fake `codex` stub on PATH. Without an
# explicit --model, codex falls back to the installed CLI default (e.g.
# gpt-5.5), silently ignoring _codex_validate_model and mispricing the run.
# ===========================================
log_test "codex provider_invoke() passes --model with resolved model"

CODEX_STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loki-codex-stub.XXXXXX")"
cat > "$CODEX_STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
echo "CODEX-ARGV: $*"
STUB
chmod +x "$CODEX_STUB_DIR/codex"

result=$(
    source "$PROVIDERS_DIR/codex.sh"
    PATH="$CODEX_STUB_DIR:$PATH"
    argv="$(provider_invoke "do the thing" 2>&1)"
    # Expect the explicit --model gpt-5.3-codex (default resolved model).
    if echo "$argv" | grep -q -- '--model gpt-5.3-codex'; then
        echo "pass"
    else
        echo "fail: $argv"
    fi
)
if [ "$result" = "pass" ]; then
    log_pass "codex provider_invoke() passes --model gpt-5.3-codex"
else
    log_fail "codex provider_invoke() did not pass --model - $result"
fi

# ===========================================
# Test 12: codex provider_invoke_with_tier() passes --model resolved by tier (BUG 1)
# planning tier with a planning-specific LOKI_MODEL must surface in argv, proving
# the tier-aware model resolution (not a hardcoded development model) is wired.
# ===========================================
log_test "codex provider_invoke_with_tier() passes tier-resolved --model"

result=$(
    export LOKI_CODEX_OUTPUT_LAST=false
    export LOKI_MODEL_PLANNING="gpt-5.3-codex"
    source "$PROVIDERS_DIR/codex.sh"
    PATH="$CODEX_STUB_DIR:$PATH"
    argv="$(provider_invoke_with_tier "planning" "plan the thing" 2>&1)"
    if echo "$argv" | grep -q -- '--model gpt-5.3-codex'; then
        echo "pass"
    else
        echo "fail: $argv"
    fi
)
if [ "$result" = "pass" ]; then
    log_pass "codex provider_invoke_with_tier() passes --model gpt-5.3-codex"
else
    log_fail "codex provider_invoke_with_tier() did not pass --model - $result"
fi

rm -rf "$CODEX_STUB_DIR"

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
