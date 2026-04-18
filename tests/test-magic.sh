#!/usr/bin/env bash
#
# Integration tests for `loki magic` command.
#
# Run:
#   bash tests/test-magic.sh
#
# Make executable (integration step):
#   chmod +x tests/test-magic.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
TMPDIR="$(mktemp -d -t loki-magic-test-XXXX)"
PASS=0
FAIL=0

# shellcheck disable=SC2329  # invoked indirectly via `trap`
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

pass() {
    echo "[PASS] $1"
    PASS=$((PASS + 1))
}

fail() {
    echo "[FAIL] $1"
    FAIL=$((FAIL + 1))
}

# Run a command in the sandboxed tmpdir with the CLI and capture combined output.
# Usage: run_loki <args...>
run_loki() {
    LOKI_PROVIDER=none bash "$LOKI" "$@" 2>&1 || true
}

cd "$TMPDIR"

# Minimal git repo fixture so the CLI does not fail on repo checks.
git init -q
echo '{"name":"test","version":"1.0.0"}' > package.json
git add package.json
git -c user.email=test@example.com -c user.name=test \
    commit -q -m "init" --no-gpg-sign 2>/dev/null || true

echo "========================================"
echo "  Magic Modules Integration Tests"
echo "========================================"

# Test 1: magic help lists the generate subcommand.
help_out="$(run_loki magic help)"
if echo "$help_out" | grep -q "generate"; then
    pass "magic help lists generate subcommand"
else
    fail "magic help missing generate subcommand"
fi

# Test 2: magic list on an empty registry returns a sensible message.
list_out="$(run_loki magic list)"
if echo "$list_out" | grep -qiE "no components|empty|0 components|not found|no entries"; then
    pass "magic list on empty registry"
else
    fail "magic list on empty registry"
fi

# Test 3: magic generate with template fallback produces a component or spec.
gen_out="$(run_loki magic generate TestButton --description "A simple button" --target react)"
if echo "$gen_out" | grep -qE "done|generated|created"; then
    pass "magic generate with fallback produces component"
else
    fail "magic generate with fallback"
fi

# Test 4: generated component or spec file exists on disk.
if [ -f ".loki/magic/generated/react/TestButton.tsx" ] \
    || [ -f ".loki/magic/specs/TestButton.md" ]; then
    pass "magic generate creates spec or component file"
else
    fail "magic generate did not create files"
fi

# Test 5: registry.json was created by the generate command.
if [ -f ".loki/magic/registry.json" ]; then
    pass "registry.json created"
else
    fail "registry.json missing after generate"
fi

# Test 6: magic list shows the newly registered component.
list_after="$(run_loki magic list)"
if echo "$list_after" | grep -q "TestButton"; then
    pass "magic list shows registered component"
else
    fail "magic list missing registered component"
fi

echo ""
echo "========================================"
echo "  Magic Modules Test Results"
echo "========================================"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [ "$FAIL" -eq 0 ]; then
    echo "  ALL TESTS PASSED"
    exit 0
else
    echo "  TESTS FAILED"
    exit 1
fi
