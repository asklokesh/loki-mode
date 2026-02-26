#!/usr/bin/env bash
# Test: Docker credential presets in sandbox.sh (v6.2.0)
# Validates mount presets, env presets, and flag support.
# Pure unit test -- uses grep/awk on sandbox.sh, does not start containers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$SCRIPT_DIR/../autonomy/sandbox.sh"

PASS=0; FAIL=0; TOTAL=0
pass() { ((PASS++)); ((TOTAL++)); echo "PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "FAIL: $1"; }

# --- Tests ---

# 1. sandbox.sh passes bash -n syntax check
if bash -n "$SANDBOX" 2>/dev/null; then
    pass "sandbox.sh passes bash -n syntax check"
else
    fail "sandbox.sh fails bash -n syntax check"
fi

# 2. DOCKER_MOUNT_PRESETS has 9 entries
# Count lines between DOCKER_MOUNT_PRESETS=( and the closing )
mount_count=$(awk '/^DOCKER_MOUNT_PRESETS=\(/,/^\)/' "$SANDBOX" | grep -c '\[' || true)
if [[ "$mount_count" -eq 9 ]]; then
    pass "DOCKER_MOUNT_PRESETS has 9 entries (found $mount_count)"
else
    fail "DOCKER_MOUNT_PRESETS expected 9 entries, found $mount_count"
fi

# 3. DOCKER_MOUNT_PRESETS[gh] contains .config/gh
if grep -A1 '\[gh\]=' "$SANDBOX" | grep -q '\.config/gh'; then
    pass "DOCKER_MOUNT_PRESETS[gh] contains .config/gh"
else
    fail "DOCKER_MOUNT_PRESETS[gh] missing .config/gh"
fi

# 4. DOCKER_MOUNT_PRESETS[aws] contains .aws
if grep '\[aws\]=' "$SANDBOX" | head -1 | grep -q '\.aws'; then
    pass "DOCKER_MOUNT_PRESETS[aws] contains .aws"
else
    fail "DOCKER_MOUNT_PRESETS[aws] missing .aws"
fi

# 5. DOCKER_ENV_PRESETS[aws] contains AWS_REGION
if awk '/^DOCKER_ENV_PRESETS=\(/,/^\)/' "$SANDBOX" | grep '\[aws\]=' | grep -q 'AWS_REGION'; then
    pass "DOCKER_ENV_PRESETS[aws] contains AWS_REGION"
else
    fail "DOCKER_ENV_PRESETS[aws] missing AWS_REGION"
fi

# 6. DOCKER_ENV_PRESETS[terraform] contains TF_VAR_*
if awk '/^DOCKER_ENV_PRESETS=\(/,/^\)/' "$SANDBOX" | grep '\[terraform\]=' | grep -q 'TF_VAR_\*'; then
    pass "DOCKER_ENV_PRESETS[terraform] contains TF_VAR_*"
else
    fail "DOCKER_ENV_PRESETS[terraform] missing TF_VAR_*"
fi

# 7. resolve_docker_mounts function is defined
if grep -q '^resolve_docker_mounts()' "$SANDBOX"; then
    pass "resolve_docker_mounts function is defined in sandbox.sh"
else
    fail "resolve_docker_mounts function not found in sandbox.sh"
fi

# 8. start_sandbox accepts --no-mounts flag
if grep -q 'no-mounts' "$SANDBOX"; then
    pass "start_sandbox supports --no-mounts flag"
else
    fail "start_sandbox missing --no-mounts flag support"
fi

# 9. start_sandbox accepts --mount flag (custom_mounts variable)
if grep -q 'custom_mounts' "$SANDBOX"; then
    pass "start_sandbox supports --mount flag (custom_mounts)"
else
    fail "start_sandbox missing --mount flag support (custom_mounts)"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
