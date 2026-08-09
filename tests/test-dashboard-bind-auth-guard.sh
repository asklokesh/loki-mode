#!/usr/bin/env bash
# An exposed dashboard bind requires authentication (issue #188).
#
# THE GAP. dashboard/auth.py returns True -- allow -- when neither
# LOKI_ENTERPRISE_AUTH nor OIDC is configured, which makes all 166
# Depends(require_scope) endpoints open. On loopback that is defensible: the
# trust boundary is the machine. Bound to 0.0.0.0 it is not, and
# `Dockerfile:196` is EXPOSE 57374 with ENTRYPOINT ["loki"], so
# `docker run -p 57374:57374 <img> dashboard start` reaches exactly that state.
#
# TEST 1 IS THE POSITIVE CONTROL AND IT COMES FIRST ON PURPOSE. A guard that
# refuses EVERYTHING passes every negative assertion here while making the
# dashboard unusable. Loopback must still start without auth, or the guard is
# not a guard, it is an outage.
#
# TEST 5 IS THE OTHER LOAD-BEARING ONE. The check must run AFTER argument
# parsing. If it only covered the container-detected default, an explicit
# `--host 0.0.0.0` on a laptop would walk straight past it -- which is the more
# likely way a person reaches this state than a container is.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: an exposed dashboard bind is refused without auth"

[ -f "$LOKI_BIN" ] || { echo "  FAIL: $LOKI_BIN missing"; exit 1; }

# Counts the refusal, never starts a server: every invocation below either
# refuses (and exits) or is stopped by the timeout before binding.
_refused() {
    timeout 25 env "$@" bash "$LOKI_BIN" dashboard start --host "$_HOST" 2>&1 \
        | grep -c "Refusing to start" | tr -d ' '
}

# --- 1. POSITIVE CONTROL: loopback still starts without auth ---------------
# Without this, "refuse everything" would score 4/4 below.
_HOST=127.0.0.1
if [ "$(_refused NOAUTH=1)" = "0" ]; then
    ok "loopback is NOT refused (the guard is not a blanket outage)"
else
    bad "loopback was refused -- the guard broke the common case it was not aimed at"
fi

# --- 2. THE GAP: exposed + no auth is refused ------------------------------
_HOST=0.0.0.0
if [ "$(_refused NOAUTH=1)" = "1" ]; then
    ok "0.0.0.0 with auth disabled is refused"
else
    bad "0.0.0.0 started with every endpoint open and no credential"
fi

# --- 3. Each documented escape actually works ------------------------------
# A guard whose override is broken is worse than no guard: the operator follows
# the printed instruction, it does not work, and they reach for --host or a
# fork instead.
if [ "$(_refused LOKI_ENTERPRISE_AUTH=true)" = "0" ]; then
    ok "LOKI_ENTERPRISE_AUTH=true satisfies the guard"
else
    bad "token auth does not satisfy the guard -- the printed fix does not work"
fi

if [ "$(_refused LOKI_OIDC_ISSUER=https://example.invalid LOKI_OIDC_CLIENT_ID=probe)" = "0" ]; then
    ok "OIDC issuer + client id satisfies the guard"
else
    bad "OIDC does not satisfy the guard"
fi

if [ "$(_refused LOKI_DASHBOARD_ALLOW_INSECURE_BIND=1)" = "0" ]; then
    ok "the explicit insecure override is honoured"
else
    bad "the documented override does not work"
fi

# --- 4. A HALF-configured OIDC must NOT satisfy the guard ------------------
# Issuer without client id is not a working OIDC setup. Accepting it would be a
# fail-open dressed as configuration.
if [ "$(_refused LOKI_OIDC_ISSUER=https://example.invalid)" = "1" ]; then
    ok "OIDC issuer alone does not satisfy the guard (half-config is not auth)"
else
    bad "a partial OIDC config was accepted as authentication"
fi

# --- 5. The check runs AFTER argument parsing ------------------------------
# Asserted on the property: an explicit --host must be covered. Verified above
# by the fact every case here passes --host rather than relying on detection.
_guard_line="$(grep -n "_loki_dashboard_bind_is_safe \"\$host\"" "$LOKI_BIN" | head -1 | cut -d: -f1)"
_parse_end="$(awk '/^cmd_dashboard_start\(\)/{f=1} f&&/^    done$/{print NR; exit}' "$LOKI_BIN")"
if [ -n "$_guard_line" ] && [ -n "$_parse_end" ] && [ "$_guard_line" -gt "$_parse_end" ]; then
    ok "the guard runs after argument parsing (line $_guard_line after $_parse_end)"
else
    bad "the guard runs before parsing -- an explicit --host 0.0.0.0 would bypass it"
fi

# --- 6. Syntax --------------------------------------------------------------
bash -n "$LOKI_BIN" 2>/dev/null && ok "autonomy/loki parses" || bad "autonomy/loki has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
