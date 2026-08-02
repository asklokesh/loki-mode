#!/usr/bin/env bash
# Test: quickstart step 1 names the provider a build would ACTUALLY pick.
#
# Regression cover for the v8.64.0 staleness: step 1 re-derived the provider
# list inline as `for _p in claude codex cline aider`, which
#   1. omitted opencode entirely, so an opencode-only machine fell through to
#      the install-offer branch and was told "No provider available", and
#   2. had codex/cline swapped relative to providers/loader.sh
#      auto_detect_provider (claude cline codex aider opencode), so a machine
#      with both was told "Found: codex" while the runner would pick cline.
#
# Everything here RUNS cmd_quickstart against fake-binary PATH fixtures and
# asserts on real stdout, never on the source text.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QS="$REPO_ROOT/autonomy/quickstart.sh"
PO="$REPO_ROOT/autonomy/provider-offer.sh"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-qs-provider.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# The driver: sources quickstart for real, stubs ONLY the interactive predicate
# and the build boundary, then runs the whole interview with empty stdin.
DRIVER="$TMP/driver.sh"
cat > "$DRIVER" <<EOF
#!/usr/bin/env bash
export NO_COLOR=1
export SKILL_DIR="$REPO_ROOT"
source "$PO" 2>/dev/null
source "$QS"
_qs_non_interactive() { return 1; }
cmd_start() { return 0; }
cmd_quickstart </dev/null 2>&1
EOF
chmod +x "$DRIVER"

# make_path <name>...: a PATH containing ONLY the named fake provider binaries
# plus the real system dirs (awk/sed/basename are needed by the interview).
make_path() {
    local bin="$TMP/bin-$*"
    bin="${bin// /-}"
    rm -rf "$bin"; mkdir -p "$bin"
    local p
    for p in "$@"; do
        printf '#!/bin/sh\necho %s\n' "$p" > "$bin/$p"
        chmod +x "$bin/$p"
    done
    printf '%s' "$bin:/usr/bin:/bin"
}

run_step1() {
    PATH="$1" bash "$DRIVER" 2>&1
}

echo "========================================"
echo "Quickstart Provider Detection Tests"
echo "========================================"
echo ""

if [ ! -f "$QS" ]; then
    log_fail "fixture: autonomy/quickstart.sh not found at $QS"
    echo "Results: $PASSED passed, $FAILED failed"; exit 1
fi

# ===========================================
# Test 1: opencode-only machine is USABLE.
# The exact case that regressed: must name opencode, must NOT claim no
# provider, and must NOT push the claude install command.
# ===========================================
log_test "opencode-only PATH resolves opencode and proceeds"
out="$(run_step1 "$(make_path opencode)")"
if printf '%s' "$out" | grep -q "Found: opencode"; then
    log_pass "step 1 names opencode"
else
    log_fail "step 1 did not name opencode. Got: $(printf '%s' "$out" | sed -n '4,6p' | tr '\n' '|')"
fi
if printf '%s' "$out" | grep -qi "No provider available"; then
    log_fail "opencode-only machine was told 'No provider available'"
else
    log_pass "opencode-only machine is not told it lacks a provider"
fi
if printf '%s' "$out" | grep -q "npm install -g @anthropic-ai/claude-code"; then
    log_fail "opencode-only machine was pushed a redundant claude install"
else
    log_pass "no redundant claude install offered when opencode works"
fi
# Proof it got PAST step 1 rather than exiting the gate.
if printf '%s' "$out" | grep -q "Step 2 of 4"; then
    log_pass "interview reaches step 2 on an opencode-only machine"
else
    log_fail "interview never reached step 2 on an opencode-only machine"
fi

# ===========================================
# Test 2: priority matches auto_detect_provider, not the old inline order.
# codex+cline present -> the runner picks cline, so step 1 must say cline.
# ===========================================
log_test "codex+cline PATH names cline (loader priority, not the swapped order)"
out="$(run_step1 "$(make_path codex cline)")"
if printf '%s' "$out" | grep -q "Found: cline"; then
    log_pass "step 1 names cline when both codex and cline are installed"
else
    log_fail "expected 'Found: cline'. Got: $(printf '%s' "$out" | sed -n '4,6p' | tr '\n' '|')"
fi
if printf '%s' "$out" | grep -q "Found: codex"; then
    log_fail "step 1 named codex, contradicting what the runner would pick"
else
    log_pass "step 1 does not name codex over cline"
fi

# Cross-check against the loader itself, so this test tracks the real source of
# truth instead of hardcoding a second copy of the priority list.
expected="$(PATH="$(make_path codex cline)" bash -c "source '$REPO_ROOT/providers/loader.sh' >/dev/null 2>&1; auto_detect_provider" 2>/dev/null)"
if [ "$expected" = "cline" ]; then
    log_pass "loader auto_detect_provider agrees: cline"
else
    log_fail "loader returned '$expected', expected cline"
fi

# ===========================================
# Test 3: claude still wins when present (no regression on the common path).
# ===========================================
log_test "claude present still resolves claude"
out="$(run_step1 "$(make_path claude codex opencode)")"
if printf '%s' "$out" | grep -q "Found: claude"; then
    log_pass "claude keeps top priority"
else
    log_fail "expected 'Found: claude'. Got: $(printf '%s' "$out" | sed -n '4,6p' | tr '\n' '|')"
fi

# ===========================================
# Test 4: THE GUARD MUST STILL FIRE. No provider at all -> the fix must not
# have quietly turned the empty case green.
# ===========================================
log_test "no provider on PATH still blocks with the install hint"
out="$(run_step1 "$(make_path)")"
if printf '%s' "$out" | grep -qi "No provider available"; then
    log_pass "empty PATH still blocks the build"
else
    log_fail "empty PATH did NOT block -- the guard was lost"
fi
if printf '%s' "$out" | grep -q "npm install -g @anthropic-ai/claude-code"; then
    log_pass "empty PATH still shows the install command"
else
    log_fail "empty PATH lost the install hint"
fi
if printf '%s' "$out" | grep -q "Step 2 of 4"; then
    log_fail "empty PATH reached step 2 -- the gate is fail-open"
else
    log_pass "empty PATH never reaches step 2"
fi

# ===========================================
# Test 5: _qs_selected_provider degrades silently, never errors, when the
# loader cannot be found. Guarantees the fallback branch stays reachable.
# ===========================================
log_test "_qs_selected_provider is silent and non-fatal without a loader"
# Copy quickstart.sh somewhere with no sibling providers/loader.sh, so the
# BASH_SOURCE-derived lookup misses and the fallback branch must engage.
cp "$QS" "$TMP/lonely-quickstart.sh"
out="$(bash -c "export NO_COLOR=1; source '$TMP/lonely-quickstart.sh'; _qs_selected_provider; echo \"rc=\$?\"" 2>&1)"
if printf '%s' "$out" | grep -q "rc=1" && ! printf '%s' "$out" | grep -qi "No such file\|error"; then
    log_pass "returns non-zero quietly when providers/loader.sh is absent"
else
    log_fail "expected a quiet rc=1. Got: $out"
fi

echo ""
echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "========================================"
[ "$FAILED" -eq 0 ]
