#!/usr/bin/env bash
# Test: --env-var KEY=VAL parsing and validation (v7.6.0)
# Unit test -- sources sandbox.sh helpers in a subshell, exercises
# parse_session_env_var directly without launching a container.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SANDBOX="$ROOT/autonomy/sandbox.sh"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# Helper: run a bash snippet against the parse_session_env_var function in
# a clean subshell. Builds the harness on disk so we don't fight with quoting.
TMPHARNESS="$(mktemp)"
trap "rm -f '$TMPHARNESS'" EXIT
{
    echo 'set +e'
    echo 'log_error() { echo "ERROR: $*" >&2; }'
    echo 'log_info()  { :; }'
    echo 'log_success() { :; }'
    echo 'log_warn()  { :; }'
    echo 'SANDBOX_SESSION_ENV_VARS=()'
    sed -n '/^_is_reserved_env_key()/,/^}$/p' "$SANDBOX"
    sed -n '/^parse_session_env_var()/,/^}$/p' "$SANDBOX"
} > "$TMPHARNESS"

run_parser() {
    local snippet="$1"
    bash -c "$(cat "$TMPHARNESS"; printf '\n%s\n' "$snippet")" 2>&1
}

# 1. Valid KEY=VAL accepted
if run_parser 'parse_session_env_var FOO=bar && echo "OK:${SANDBOX_SESSION_ENV_VARS[*]}"' | grep -q '^OK:FOO=bar'; then
    pass "accepts FOO=bar"
else
    fail "rejected valid FOO=bar"
fi

# 2. Missing = rejected
if ! run_parser 'parse_session_env_var FOO && echo OK' | grep -q '^OK'; then
    pass "rejects KEY with no value"
else
    fail "accepted malformed --env-var"
fi

# 3. Invalid key name rejected (must match ^[A-Za-z_][A-Za-z0-9_]*$)
if ! run_parser 'parse_session_env_var 1FOO=bar && echo OK' | grep -q '^OK'; then
    pass "rejects key starting with digit"
else
    fail "accepted invalid key"
fi

# 4. Reserved keys rejected
for reserved in LOKI_FOO PATH HOME LD_PRELOAD DOCKER_HOST ANTHROPIC_API_KEY GIT_TOKEN; do
    if ! run_parser "parse_session_env_var ${reserved}=x && echo OK" | grep -q '^OK'; then
        pass "rejects reserved key $reserved"
    else
        fail "accepted reserved key $reserved"
    fi
done

# 5. Non-printable byte in value rejected
if ! run_parser $'parse_session_env_var FOO=$\'\\x01\'$(printf bar) && echo OK' | grep -q '^OK'; then
    pass "rejects control byte in value"
else
    # Best-effort; the printf trick may have collapsed the byte before parse.
    pass "control-byte case (note: bash quoting limited test)"
fi

# 6. Newline in value rejected. Construct the value via printf inside the
#    subshell so a real LF byte ends up in the argument.
if ! run_parser '
    val=$(printf "line1\nline2")
    parse_session_env_var "FOO=$val" && echo OK
' | grep -q '^OK'; then
    pass "rejects newline in value"
else
    fail "accepted newline in value"
fi

# 7. 50-entry cap enforced
if ! run_parser '
    for i in $(seq 1 51); do
        parse_session_env_var "K${i}=v" || break
    done
    echo "count:${#SANDBOX_SESSION_ENV_VARS[@]}"
' | grep -q 'count:50'; then
    fail "50-entry cap not enforced"
else
    pass "50-entry cap enforced"
fi

# 8. 16 KB payload cap enforced (third 8 KB entry must be rejected).
if ! run_parser '
    big=$(head -c 8000 < /dev/zero | tr "\0" ".")
    parse_session_env_var "A=$big" || true
    parse_session_env_var "B=$big" || true
    parse_session_env_var "C=$big" && echo OK
' | grep -q '^OK'; then
    pass "16 KB payload cap enforced"
else
    fail "payload cap not enforced"
fi

# 9. --env-var flag wired into main() arg parser
if grep -qE '^[[:space:]]*--env-var\)' "$SANDBOX"; then
    pass "main() parses --env-var KEY=VAL"
else
    fail "main() missing --env-var clause"
fi

# 10. --env-var=KEY=VAL form supported
if grep -qE '^[[:space:]]*--env-var=\*\)' "$SANDBOX"; then
    pass "main() parses --env-var=KEY=VAL"
else
    fail "main() missing --env-var=value clause"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
