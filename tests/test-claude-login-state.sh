#!/usr/bin/env bash
# tests/test-claude-login-state.sh -- the auth preflight must recognise EVERY
# real Claude login store and never falsely block a logged-in user.
# v7.104.2 fix for the native/Keychain login being misread as "not logged in".
#
# Strategy (mirrors test-iteration-card-plain.sh): extract the real
# _loki_claude_login_state() helper from run.sh, source it, and drive it with a
# fake `claude` on PATH and controlled CLAUDE_CONFIG_DIR so every store/state is
# exercised deterministically without touching the machine's real login.
#
# Asserts:
#   (1) `claude auth status` loggedIn:true -> loggedin (even with NO cred file:
#       the native/Keychain-login case the fix is for).
#   (2) `claude auth status` loggedIn:false -> loggedout (genuine logout caught).
#   (3) no auth-status output, valid cred file -> loggedin (older CLI).
#   (4) no auth-status output, EXPIRED cred file -> expired.
#   (5) FAIL-OPEN: no auth-status, no file, non-macOS-style (no keychain) ->
#       must NOT return loggedout on uncertainty (loggedin/unknown, never a block).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1 (got '$2', expected '$3')"; FAIL=$((FAIL+1)); }

WORKDIR="$(mktemp -d -t loki-loginstate.XXXXXX)"
HARNESS="$WORKDIR/harness.sh"
FAKEBIN="$WORKDIR/bin"
mkdir -p "$FAKEBIN"
trap 'rm -rf "${WORKDIR:-/nonexistent}"' EXIT

# --- Extract the real helper from run.sh --------------------------------------
{
  echo 'log_error() { :; }'
  echo 'log_info() { :; }'
  sed -n '/^_loki_claude_login_state() {/,/^}/p' "$RUN_SCRIPT"
} > "$HARNESS"
if ! grep -q '_loki_claude_login_state() {' "$HARNESS"; then
  echo "FATAL: failed to extract _loki_claude_login_state() from $RUN_SCRIPT (drift?)"
  exit 2
fi

# fake `claude`: prints whatever CLAUDE_FAKE_STATUS is set to for `auth status`.
cat > "$FAKEBIN/claude" <<'EOF'
#!/bin/bash
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s' "${CLAUDE_FAKE_STATUS:-}"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKEBIN/claude"

# fake `security`: `find-generic-password` exits with $FAKE_SECURITY_RC (default 1
# = no keychain entry), so keychain presence is deterministic in the test instead
# of depending on this machine's real login. Only the existence probe is faked.
cat > "$FAKEBIN/security" <<'EOF'
#!/bin/bash
if [ "$1" = "find-generic-password" ]; then exit "${FAKE_SECURITY_RC:-1}"; fi
exit 0
EOF
chmod +x "$FAKEBIN/security"

run_case() {
  # env-overrides... -> echoes the helper result. PATH puts our fake claude AND
  # fake security first so both signals are controlled.
  env "$@" PATH="$FAKEBIN:$PATH" bash -c "source '$HARNESS'; _loki_claude_login_state"
}

EMPTY_CFG="$WORKDIR/empty"; mkdir -p "$EMPTY_CFG"

# (1) auth status loggedIn:true, no cred file -> loggedin
r=$(run_case CLAUDE_FAKE_STATUS='{"loggedIn": true}' CLAUDE_CONFIG_DIR="$EMPTY_CFG" ANTHROPIC_API_KEY=)
[ "$r" = "loggedin" ] && ok "auth-status loggedIn:true (no file) -> loggedin" || bad "auth-status true" "$r" "loggedin"

# (2) auth status loggedIn:false -> loggedout
r=$(run_case CLAUDE_FAKE_STATUS='{"loggedIn": false}' CLAUDE_CONFIG_DIR="$EMPTY_CFG" ANTHROPIC_API_KEY=)
[ "$r" = "loggedout" ] && ok "auth-status loggedIn:false -> loggedout" || bad "auth-status false" "$r" "loggedout"

# (2b) FAIL-OPEN CONTRACT (regression guard, Auth Council R2): valid JSON that
# LACKS an explicit loggedIn boolean (renamed field / error object / schema
# drift) must NOT be trusted as a negative. With a VALID cred file present it must
# fall through to the file and return loggedin, NEVER a hard-blocking loggedout.
VJSON_CFG="$WORKDIR/vjson"; mkdir -p "$VJSON_CFG"
vfut=$(( ($(date +%s) + 99999) * 1000 ))
printf '{"claudeAiOauth":{"expiresAt":%s}}' "$vfut" > "$VJSON_CFG/.credentials.json"
r=$(run_case CLAUDE_FAKE_STATUS='{"foo":"bar"}' CLAUDE_CONFIG_DIR="$VJSON_CFG" ANTHROPIC_API_KEY= FAKE_SECURITY_RC=1)
[ "$r" = "loggedin" ] && ok "auth-status valid-JSON-no-loggedIn + valid file -> loggedin (never false loggedout)" || bad "auth-status missing loggedIn" "$r" "loggedin"

# (3) no auth-status output, valid (future-dated) cred file -> loggedin
VALID_CFG="$WORKDIR/valid"; mkdir -p "$VALID_CFG"
future_ms=$(( ($(date +%s) + 99999) * 1000 ))
printf '{"claudeAiOauth":{"expiresAt":%s}}' "$future_ms" > "$VALID_CFG/.credentials.json"
r=$(run_case CLAUDE_FAKE_STATUS='' CLAUDE_CONFIG_DIR="$VALID_CFG" ANTHROPIC_API_KEY=)
[ "$r" = "loggedin" ] && ok "no auth-status, valid file -> loggedin" || bad "valid file" "$r" "loggedin"

# (4) no auth-status, expired cred file, NO keychain (security exit 1) -> expired
#     (genuine expiry that would 401 mid-build; nothing overrides it).
EXP_CFG="$WORKDIR/expired"; mkdir -p "$EXP_CFG"
past_ms=$(( ($(date +%s) - 100) * 1000 ))
printf '{"claudeAiOauth":{"expiresAt":%s}}' "$past_ms" > "$EXP_CFG/.credentials.json"
r=$(run_case CLAUDE_FAKE_STATUS='' CLAUDE_CONFIG_DIR="$EXP_CFG" ANTHROPIC_API_KEY= FAKE_SECURITY_RC=1)
[ "$r" = "expired" ] && ok "expired file + NO keychain -> expired" || bad "expired file no keychain" "$r" "expired"

# (5) THE REGRESSION GUARD: expired cred file BUT a live keychain login (security
#     exit 0) -> loggedin. A stale expired file must NEVER override a real
#     Keychain login (the native-install case that broke test-prd-reuse-stub).
r=$(run_case CLAUDE_FAKE_STATUS='' CLAUDE_CONFIG_DIR="$EXP_CFG" ANTHROPIC_API_KEY= FAKE_SECURITY_RC=0)
[ "$r" = "loggedin" ] && ok "expired file + LIVE keychain -> loggedin (keychain overrides stale file)" || bad "expired+keychain" "$r" "loggedin"

# (6) keychain-only login (no file at all, security exit 0) -> loggedin
r=$(run_case CLAUDE_FAKE_STATUS='' CLAUDE_CONFIG_DIR="$EMPTY_CFG" ANTHROPIC_API_KEY= FAKE_SECURITY_RC=0)
[ "$r" = "loggedin" ] && ok "no file + keychain -> loggedin" || bad "keychain only" "$r" "loggedin"

# (7) macOS confident logout: no auth-status, no file, no keychain, claude present
#     -> loggedout (the genuine never-logged-in user is still caught).
r=$(run_case CLAUDE_FAKE_STATUS='' CLAUDE_CONFIG_DIR="$EMPTY_CFG" ANTHROPIC_API_KEY= FAKE_SECURITY_RC=1)
[ "$r" = "loggedout" ] && ok "no file + no keychain + claude present -> loggedout" || bad "confident logout" "$r" "loggedout"

echo
echo "-----------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CLAUDE LOGIN-STATE TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$FAIL"
