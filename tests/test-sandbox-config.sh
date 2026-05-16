#!/usr/bin/env bash
# Test: .loki/config.yaml sandbox.* keys parse into LOKI_SANDBOX_* env vars (v7.6.0)
# Unit test -- parses sandbox.sh / run.sh declarations, optionally exercises
# load_config_file when yq is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SANDBOX="$ROOT/autonomy/sandbox.sh"
RUN="$ROOT/autonomy/run.sh"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. sandbox.sh syntax
if bash -n "$SANDBOX" 2>/dev/null; then pass "sandbox.sh syntax"; else fail "sandbox.sh syntax"; fi

# 2. run.sh syntax
if bash -n "$RUN" 2>/dev/null; then pass "run.sh syntax"; else fail "run.sh syntax"; fi

# 3. Every new sandbox.* mapping appears in BOTH the simple parser block and
#    the yq mappings array.
for key in \
    "sandbox.image:LOKI_SANDBOX_IMAGE" \
    "sandbox.network:LOKI_SANDBOX_NETWORK" \
    "sandbox.cpus:LOKI_SANDBOX_CPUS" \
    "sandbox.memory:LOKI_SANDBOX_MEMORY" \
    "sandbox.readonly:LOKI_SANDBOX_READONLY" \
    "sandbox.egress.allow:LOKI_SANDBOX_EGRESS_ALLOW" \
    "sandbox.egress.deny:LOKI_SANDBOX_EGRESS_DENY" \
    "sandbox.vault.enabled:LOKI_SANDBOX_VAULT_ENABLED"
do
    yaml_path="${key%%:*}"
    env_name="${key##*:}"

    if grep -qF "set_from_yaml \"\$file\" \"$yaml_path\" \"$env_name\"" "$RUN"; then
        pass "simple parser maps $yaml_path -> $env_name"
    else
        fail "simple parser missing $yaml_path -> $env_name"
    fi

    if grep -qF "\"$yaml_path:$env_name\"" "$RUN"; then
        pass "yq parser maps $yaml_path -> $env_name"
    else
        fail "yq parser missing $yaml_path -> $env_name"
    fi
done

# 4. sandbox.sh consumes the new env vars at top of script.
# Match the pattern: SANDBOX_FOO="${LOKI_SANDBOX_FOO:-...}"  (quoted form)
# or                 SANDBOX_FOO=${LOKI_SANDBOX_FOO:-...}    (unquoted).
for env_name in \
    LOKI_SANDBOX_EGRESS_ALLOW \
    LOKI_SANDBOX_EGRESS_DENY \
    LOKI_SANDBOX_VAULT_ENABLED
do
    if grep -qE "=\"?\\\$\\{${env_name}:-" "$SANDBOX"; then
        pass "sandbox.sh consumes $env_name"
    else
        fail "sandbox.sh does not consume $env_name"
    fi
done

# 5. SANDBOX_SESSION_ENV_VARS array initialised for A4.
if grep -q '^SANDBOX_SESSION_ENV_VARS=()' "$SANDBOX"; then
    pass "SANDBOX_SESSION_ENV_VARS initialised"
else
    fail "SANDBOX_SESSION_ENV_VARS not initialised"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
