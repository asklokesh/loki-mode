#!/usr/bin/env bash
# Test: loki sandbox resume - tmux-wrapped durable agent sessions (v7.6.0)
# Unit test -- checks function definitions and CLI wire-up. Does not
# launch a container; the resume path requires Docker which is not assumed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SANDBOX="$ROOT/autonomy/sandbox.sh"
DOCKERFILE="$ROOT/Dockerfile.sandbox"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. sandbox.sh still syntax-clean after additions
if bash -n "$SANDBOX" 2>/dev/null; then
    pass "sandbox.sh syntax clean"
else
    fail "sandbox.sh syntax errors"
fi

# 2. sandbox_resume function defined
if grep -q '^sandbox_resume()' "$SANDBOX"; then
    pass "sandbox_resume() defined"
else
    fail "sandbox_resume() missing"
fi

# 3. sandbox_resume_status function defined
if grep -q '^sandbox_resume_status()' "$SANDBOX"; then
    pass "sandbox_resume_status() defined"
else
    fail "sandbox_resume_status() missing"
fi

# 4. _tmux_session_exists helper defined
if grep -q '^_tmux_session_exists()' "$SANDBOX"; then
    pass "_tmux_session_exists() helper defined"
else
    fail "_tmux_session_exists() missing"
fi

# 5. Dispatch case wires 'resume'
if grep -qE '^[[:space:]]+resume\)' "$SANDBOX"; then
    pass "main() dispatches 'resume' subcommand"
else
    fail "main() missing 'resume' subcommand"
fi

# 6. Dispatch case wires 'resume-status'
if grep -qE '^[[:space:]]+resume-status\)' "$SANDBOX"; then
    pass "main() dispatches 'resume-status' subcommand"
else
    fail "main() missing 'resume-status' subcommand"
fi

# 7. resume uses tmux attach-session
if grep -q 'tmux attach-session' "$SANDBOX"; then
    pass "resume uses tmux attach-session"
else
    fail "resume does not use tmux attach-session"
fi

# 8. resume falls back to new-session when none exists
if grep -q 'tmux new-session' "$SANDBOX"; then
    pass "resume falls back to tmux new-session"
else
    fail "resume missing tmux new-session fallback"
fi

# 9. resume-status emits versioned JSON schema
if grep -q 'loki.sandbox.resume/v1' "$SANDBOX"; then
    pass "resume-status emits versioned JSON schema"
else
    fail "resume-status missing versioned schema"
fi

# 10. Help text mentions resume + resume-status
if grep -q 'sandbox resume' "$SANDBOX" && grep -q 'resume-status' "$SANDBOX"; then
    pass "help text documents resume + resume-status"
else
    fail "help text missing resume docs"
fi

# 11. Dockerfile.sandbox installs tmux as a runtime package
if grep -qE '^[[:space:]]+tmux[[:space:]]+\\' "$DOCKERFILE"; then
    pass "Dockerfile.sandbox installs tmux"
else
    fail "Dockerfile.sandbox missing tmux line"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
