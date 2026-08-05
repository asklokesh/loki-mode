#!/usr/bin/env bash
# Aider Cloud Model Tests (v6.7.0)
# Tests Aider provider with cloud model configurations

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: $2"; FAIL=$((FAIL + 1)); }

echo "Aider Cloud Model Tests"
echo "======================="
echo ""

# Test 1: Aider CLI exists
echo "Test 1: Aider CLI availability"
if command -v aider &>/dev/null; then
    version=$(aider --version 2>/dev/null | head -1 || echo "unknown")
    pass "aider found (version: $version)"
else
    # Aider is an OPTIONAL Tier-3 provider. Its absence on a machine says
    # nothing about loki's aider support, which is what the other 8 assertions
    # in this file actually verify (config sources, model default, env vars,
    # invoke functions, stdin redirect). Hard-failing here made the whole suite
    # red on any runner without `pip install aider-chat` -- including CI, where
    # it was one of the failures hidden while the workflow was not starting.
    # Report it as a skip so a genuine regression in the assertions below is not
    # buried under an environment difference.
    echo "  SKIP  aider not on PATH (optional Tier-3 provider; install: pip install aider-chat)"
fi

# Test 2: Provider config file exists
echo "Test 2: Provider config file"
if [ -f "$PROJECT_DIR/providers/aider.sh" ]; then
    pass "providers/aider.sh exists"
else
    fail "providers/aider.sh" "missing"
fi

# Test 3: Provider config sources cleanly
echo "Test 3: Provider config sources"
if bash -c "source '$PROJECT_DIR/providers/aider.sh'" 2>/dev/null; then
    pass "providers/aider.sh sources without error"
else
    fail "providers/aider.sh" "source error"
fi

# Test 4: Default model is current (not deprecated)
echo "Test 4: Default model is current"
local_default=$(grep -o 'LOKI_AIDER_MODEL:-[^}]*' "$PROJECT_DIR/autonomy/run.sh" | head -1 | sed 's/LOKI_AIDER_MODEL:-//')
if [[ "$local_default" == *"claude-3.7"* ]] || [[ "$local_default" == *"claude-3.5"* ]]; then
    fail "default model" "uses deprecated model: $local_default"
else
    pass "default model: $local_default"
fi

# Test 5: LOKI_AIDER_MODEL is consumed by invoke_aider in run.sh
echo "Test 5: Model override"
if grep -A20 "invoke_aider()" "$PROJECT_DIR/autonomy/run.sh" | grep -q "LOKI_AIDER_MODEL"; then
    pass "LOKI_AIDER_MODEL consumed by invoke_aider()"
else
    fail "LOKI_AIDER_MODEL" "not referenced in invoke_aider() body"
fi

# Test 6: LOKI_AIDER_FLAGS passthrough
echo "Test 6: Extra flags passthrough"
export LOKI_AIDER_FLAGS="--architect --no-git"
if grep -q 'LOKI_AIDER_FLAGS' "$PROJECT_DIR/autonomy/run.sh"; then
    pass "LOKI_AIDER_FLAGS recognized in run.sh"
else
    fail "LOKI_AIDER_FLAGS" "not found in run.sh"
fi
unset LOKI_AIDER_FLAGS

# Test 7: invoke_aider function exists
echo "Test 7: invoke_aider defined"
if grep -q "invoke_aider()" "$PROJECT_DIR/autonomy/run.sh" 2>/dev/null; then
    pass "invoke_aider() found"
else
    fail "invoke_aider()" "not found"
fi

# Test 8: invoke_aider_capture function exists
echo "Test 8: invoke_aider_capture defined"
if grep -q "invoke_aider_capture()" "$PROJECT_DIR/autonomy/run.sh" 2>/dev/null; then
    pass "invoke_aider_capture() found"
else
    fail "invoke_aider_capture()" "not found"
fi

# Test 9: stdin redirect prevents blocking
echo "Test 9: Non-interactive mode (stdin redirect)"
if grep -A10 "invoke_aider()" "$PROJECT_DIR/autonomy/run.sh" | grep -q "< /dev/null"; then
    pass "stdin redirect in invoke_aider"
else
    fail "stdin redirect" "< /dev/null not found in invoke_aider"
fi

# Test 10: Cloud API key detection (informational -- does not affect pass/fail)
echo "Test 10: Cloud API key availability"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  INFO  ANTHROPIC_API_KEY set"
else
    echo "  SKIP  ANTHROPIC_API_KEY not set (optional for cloud testing)"
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
    echo "  INFO  OPENAI_API_KEY set"
else
    echo "  SKIP  OPENAI_API_KEY not set (optional for cloud testing)"
fi

echo ""
echo "======================="
echo "Results: $PASS passed, $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
