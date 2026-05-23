#!/usr/bin/env bash
# Test: loki sandbox diagnose emits typed detection codes (v7.6.0)
# Unit test -- invokes `sandbox.sh diagnose --json` without starting any
# container. Asserts JSON shape and a few codes that depend on the
# host state we can deterministically control here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SANDBOX="$ROOT/autonomy/sandbox.sh"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# Run diagnose in --json mode in a scratch project dir with no credentials and
# no docker daemon assumption -- we just check the output structure.
tmp=$(mktemp -d)
trap "rm -rf '$tmp'" EXIT
cd "$tmp"

# Strip caller env to force CRD003 and predictable defaults.
unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GITHUB_TOKEN GH_TOKEN \
      LOKI_SANDBOX_CPUS LOKI_SANDBOX_MEMORY LOKI_SANDBOX_NETWORK \
      LOKI_SANDBOX_VAULT_ENABLED LOKI_SANDBOX_EGRESS_ALLOW \
      LOKI_SANDBOX_EGRESS_DENY 2>/dev/null || true

# Run diagnose; ignore exit code (informational tool).
out=$(bash "$SANDBOX" diagnose --json 2>/dev/null || true)

# 1. Output is non-empty
if [[ -n "$out" ]]; then
    pass "diagnose --json produces output"
else
    fail "diagnose --json produced empty output"
fi

# 2. Output declares the expected schema version
if echo "$out" | grep -q '"schema": "loki.sandbox.diagnose/v1"'; then
    pass "schema field present"
else
    fail "schema field missing or wrong"
    echo "  output:"; echo "$out" | head -20 | sed 's/^/    /'
fi

# 3. CRD003 raised (no credentials in env)
if echo "$out" | grep -q '"code":"CRD003"'; then
    pass "CRD003 raised when no credentials present"
else
    fail "CRD003 not raised"
fi

# 4. RES008 raised (defaults left in place)
if echo "$out" | grep -q '"code":"RES008"'; then
    pass "RES008 raised when defaults active"
else
    fail "RES008 not raised"
fi

# 5. EGR004 NOT raised at bridge network
if ! echo "$out" | grep -q '"code":"EGR004"'; then
    pass "EGR004 silent at default bridge mode"
else
    fail "EGR004 unexpectedly raised at bridge mode"
fi

# 6. EGR004 IS raised when host networking is requested
out_host=$(LOKI_SANDBOX_NETWORK=host bash "$SANDBOX" diagnose --json 2>/dev/null || true)
if echo "$out_host" | grep -q '"code":"EGR004"'; then
    pass "EGR004 raised when LOKI_SANDBOX_NETWORK=host"
else
    fail "EGR004 not raised when host networking requested"
fi

# 7. VLT006 raised when vault enabled but no sidecar reachable
out_vault=$(LOKI_SANDBOX_VAULT_ENABLED=true bash "$SANDBOX" diagnose --json 2>/dev/null || true)
if echo "$out_vault" | grep -q '"code":"VLT006"'; then
    pass "VLT006 raised when vault enabled but unreachable"
else
    fail "VLT006 not raised in vault-enabled / no-sidecar state"
fi

# 8. Non-JSON variant is human-readable and contains 'Detection codes'
out_human=$(bash "$SANDBOX" diagnose 2>/dev/null || true)
if echo "$out_human" | grep -qE 'Detection codes|no detection codes raised'; then
    pass "human-readable diagnose summary renders"
else
    fail "human-readable diagnose missing summary"
fi

# 9. BUG-2 regression: empty fields in egress lists must not inflate the count.
# Pre-fix: "a,,b," reported 4. Post-fix: must report 2.
out_egress=$(LOKI_SANDBOX_EGRESS_ALLOW=",a,,b," LOKI_SANDBOX_EGRESS_DENY="x,,y," \
    bash "$SANDBOX" diagnose --json 2>/dev/null || true)
allow_n=$(echo "$out_egress" | python3 -c "import json,sys; print(json.load(sys.stdin)['egress_allow_count'])" 2>/dev/null || echo "")
deny_n=$(echo "$out_egress" | python3 -c "import json,sys; print(json.load(sys.stdin)['egress_deny_count'])" 2>/dev/null || echo "")
if [[ "$allow_n" == "2" ]] && [[ "$deny_n" == "2" ]]; then
    pass "BUG-2 fix: empty fields excluded from egress counts (allow=$allow_n, deny=$deny_n)"
else
    fail "BUG-2 regression: allow=$allow_n deny=$deny_n (expected 2 each)"
fi

# 10. Empty egress strings report 0 (not 1).
out_empty=$(LOKI_SANDBOX_EGRESS_ALLOW="" LOKI_SANDBOX_EGRESS_DENY="" \
    bash "$SANDBOX" diagnose --json 2>/dev/null || true)
empty_allow=$(echo "$out_empty" | python3 -c "import json,sys; print(json.load(sys.stdin)['egress_allow_count'])" 2>/dev/null || echo "")
if [[ "$empty_allow" == "0" ]]; then
    pass "empty egress allow yields count 0"
else
    fail "empty egress allow yielded $empty_allow"
fi

# 11. FRG002: forge_detector errors.log triggers a code
tmp2=$(mktemp -d)
mkdir -p "$tmp2/.loki/forge"
echo "boom" > "$tmp2/.loki/forge/errors.log"
out_frg=$(cd "$tmp2" && bash "$SANDBOX" diagnose --json 2>/dev/null || true)
if echo "$out_frg" | grep -q '"code":"FRG002"'; then
    pass "FRG002 raised when forge errors.log non-empty"
else
    fail "FRG002 not raised"
fi
rm -rf "$tmp2"

# 12. FRG003: HMAC-XOR vault triggers a code
tmp3=$(mktemp -d)
mkdir -p "$tmp3/.loki/forge"
cat > "$tmp3/.loki/forge/secrets.vault" <<'JSON'
{"version":1,"entries":{"X":{"alg":"HMAC-XOR","nonce":"x","ct":"x","mac":"x"}}}
JSON
out_frg3=$(cd "$tmp3" && bash "$SANDBOX" diagnose --json 2>/dev/null || true)
if echo "$out_frg3" | grep -q '"code":"FRG003"'; then
    pass "FRG003 raised when vault on HMAC-XOR fallback"
else
    fail "FRG003 not raised"
fi
rm -rf "$tmp3"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
