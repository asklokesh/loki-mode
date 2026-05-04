#!/usr/bin/env bash
# Test: loki sentrux setup hints (BUG-004)
# Verifies that when sentrux binary is absent, gate/baseline/status all
# show actionable install commands instead of pointing to sibling subcommands.
# Also verifies init-rules does NOT require the binary (writes a plain-text
# TOML template) and must NOT show an install hint.
#
# All assertions run with a PATH that excludes any sentrux binary.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAIL++)); }
log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# Build a PATH that provably has no sentrux on it.
# We keep bash, standard coreutils etc. by keeping the real PATH minus any
# directory that contains a sentrux binary.
_SAFE_PATH=""
IFS=: read -ra _dirs <<< "$PATH"
for _d in "${_dirs[@]}"; do
    if [ -x "$_d/sentrux" ]; then
        log_info "Stripping '$_d' from PATH (contains sentrux)"
        continue
    fi
    _SAFE_PATH="${_SAFE_PATH:+$_SAFE_PATH:}$_d"
done
unset _dirs _d

INSTALL_PATTERN="brew install|install\.sh"

# Create a tmp dir for init-rules output so we do not litter the repo.
TMP_DIR="$(mktemp -d /tmp/test-sentrux-hints-XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "================================================"
echo "Loki sentrux setup-hints tests (BUG-004)"
echo "================================================"
echo ""

# -- gate: must show install hint, exit 2 --
log_info "Testing: loki sentrux gate (no sentrux on PATH)"
out=$(PATH="$_SAFE_PATH" "$LOKI" sentrux gate "$TMP_DIR" 2>&1) || true
exit_code=0
PATH="$_SAFE_PATH" "$LOKI" sentrux gate "$TMP_DIR" >/dev/null 2>&1 || exit_code=$?

if echo "$out" | grep -qE "$INSTALL_PATTERN"; then
    log_pass "sentrux gate: output contains install instructions"
else
    log_fail "sentrux gate: output does NOT mention brew install or install.sh -- got: $out"
fi

if [ "$exit_code" -eq 2 ]; then
    log_pass "sentrux gate: exits with code 2 when sentrux absent"
else
    log_fail "sentrux gate: expected exit 2, got $exit_code"
fi

if echo "$out" | grep -qi "loki sentrux baseline"; then
    log_fail "sentrux gate: output still points to 'loki sentrux baseline' (old bug text present)"
else
    log_pass "sentrux gate: does not point user to 'loki sentrux baseline'"
fi

echo ""

# -- baseline: must show install hint, exit 2 --
log_info "Testing: loki sentrux baseline (no sentrux on PATH)"
out=$(PATH="$_SAFE_PATH" "$LOKI" sentrux baseline "$TMP_DIR" 2>&1) || true
exit_code=0
PATH="$_SAFE_PATH" "$LOKI" sentrux baseline "$TMP_DIR" >/dev/null 2>&1 || exit_code=$?

if echo "$out" | grep -qE "$INSTALL_PATTERN"; then
    log_pass "sentrux baseline: output contains install instructions"
else
    log_fail "sentrux baseline: output does NOT mention brew install or install.sh -- got: $out"
fi

if [ "$exit_code" -eq 2 ]; then
    log_pass "sentrux baseline: exits with code 2 when sentrux absent"
else
    log_fail "sentrux baseline: expected exit 2, got $exit_code"
fi

echo ""

# -- status: must show install hint, exit 0 (informational, not a hard error) --
log_info "Testing: loki sentrux status (no sentrux on PATH)"
out=$(PATH="$_SAFE_PATH" "$LOKI" sentrux status "$TMP_DIR" 2>&1) || true
exit_code=0
PATH="$_SAFE_PATH" "$LOKI" sentrux status "$TMP_DIR" >/dev/null 2>&1 || exit_code=$?

if echo "$out" | grep -qE "$INSTALL_PATTERN"; then
    log_pass "sentrux status: output contains install instructions"
else
    log_fail "sentrux status: output does NOT mention brew install or install.sh -- got: $out"
fi

if [ "$exit_code" -eq 0 ]; then
    log_pass "sentrux status: exits 0 when sentrux absent (informational)"
else
    log_fail "sentrux status: expected exit 0, got $exit_code"
fi

echo ""

# -- init-rules: must NOT show install hint; must succeed without sentrux binary --
# init-rules only writes a plain-text TOML template. No binary required.
log_info "Testing: loki sentrux init-rules (no sentrux on PATH)"
RULES_DIR="$TMP_DIR/project-a"
mkdir -p "$RULES_DIR"
out=$(PATH="$_SAFE_PATH" "$LOKI" sentrux init-rules "$RULES_DIR" 2>&1) || true
exit_code=0
PATH="$_SAFE_PATH" "$LOKI" sentrux init-rules "$RULES_DIR" --force >/dev/null 2>&1 || exit_code=$?

if [ "$exit_code" -eq 0 ]; then
    log_pass "sentrux init-rules: exits 0 without sentrux binary"
else
    log_fail "sentrux init-rules: expected exit 0, got $exit_code (should not need binary)"
fi

RULES_FILE="$RULES_DIR/.sentrux/rules.toml"
if [ -f "$RULES_FILE" ]; then
    log_pass "sentrux init-rules: rules.toml was written"
else
    log_fail "sentrux init-rules: rules.toml was NOT created at $RULES_FILE"
fi

if echo "$out" | grep -qE "$INSTALL_PATTERN"; then
    log_fail "sentrux init-rules: output mentions install hint (it should NOT -- init-rules needs no binary)"
else
    log_pass "sentrux init-rules: does not show install hint (correct: no binary required)"
fi

echo ""
echo "================================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
