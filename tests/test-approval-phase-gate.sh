#!/usr/bin/env bash
# tests/test-approval-phase-gate.sh -- regression guard for v7.51.0 P3-3
# "approval phase-gate enforcement" (autonomy/run.sh check_policy).
#
# WHAT THIS GUARDS
#   A policy "approval required" result (the policy checker exits 2 ==
#   REQUIRE_APPROVAL) previously logged and proceeded unconditionally. v7.51.0
#   made check_policy honor an approval WAIT, but only opt-in:
#     - DEFAULT (no knob): advisory only -- log + return 0 (PROCEED). This is the
#       must-not-regress contract; existing users see UNCHANGED behavior.
#     - LOKI_POLICY_APPROVAL_ENFORCE=1 (or STAGED_AUTONOMY=true): wait on a file
#       signal -- .loki/signals/POLICY_APPROVED -> return 0 (continue),
#       .loki/signals/POLICY_REJECTED -> return 1 (deny).
#   And a plain DENY (exit 1) still returns 1; ALLOW (exit 0) returns 0.
#
# WHY THE POLICY CHECKER IS STUBBED (not driven via the real engine)
#   check_policy calls `node "${SCRIPT_DIR}/../src/policies/check.js"`. We point
#   SCRIPT_DIR at a stub tree whose check.js exits with LOKI_FAKE_POLICY_RC.
#   This isolates EXACTLY what P3-3 changed -- check_policy's reaction to each
#   checker exit code under each knob -- without coupling to the policy-engine
#   schema (which has its own tests under tests/policies/). The stub ignores its
#   args, so the test stays focused on the exit-code dispatch logic regardless of
#   how context_json is built. (Historical note: an earlier
#   `context_json="${2:-{}}"` brace-eating footgun, fixed in the check_policy
#   region of run.sh, used to make the live check.js receive invalid JSON; this
#   stub-based test was always immune to that since it ignores the context.)
#
#   SAFETY: the enforce arms loop `while [ ! -f sig ]; do sleep 5; done`. We
#   ALWAYS pre-create the signal file BEFORE invoking, so the loop exits at once.
#
#   RUN_SH overridable for the non-vacuity self-check.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v node >/dev/null 2>&1; then
    echo "SKIP: node not installed; check_policy shells out to node. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# Extract ONLY check_policy() from run.sh and eval it.
_fn="$(awk '/^check_policy\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: check_policy not found in run.sh. (Not a fail.)"; exit 0
fi

# Stubs for check_policy's dependencies (defined elsewhere in run.sh).
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
audit_agent_action() { :; }
emit_event_json()    { :; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-approval-gate-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Stub policy checker: exits with LOKI_FAKE_POLICY_RC, ignores args + cwd.
STUB="$WORK/stub"
mkdir -p "$STUB/autonomy" "$STUB/src/policies"
cat > "$STUB/src/policies/check.js" <<'EOF'
'use strict';
// Test stub: emit a minimal result and exit with the requested code, so we can
// drive check_policy's exit-code handling deterministically (0=allow, 1=deny,
// 2=require_approval) without the real policy engine.
process.stdout.write(JSON.stringify({ decision: 'stub', rc: process.env.LOKI_FAKE_POLICY_RC || '0' }));
process.exit(Number(process.env.LOKI_FAKE_POLICY_RC || '0'));
EOF
SCRIPT_DIR="$STUB/autonomy"
STAGED_AUTONOMY="false"

# shellcheck disable=SC1090
eval "$_fn"
if ! type check_policy >/dev/null 2>&1; then
    echo "SKIP: check_policy did not eval cleanly. (Not a fail.)"; exit 0
fi

# Each case runs in a project dir that carries a dummy policies.json so the
# `-f` early-return is bypassed and the stub checker is actually invoked.
mk_proj() {
    local dir="$1"; mkdir -p "$dir/.loki"
    printf '{"version":"1.0","policies":{}}' > "$dir/.loki/policies.json"
}

# ---------------------------------------------------------------------------
# Case 1 (MUST-HAVE): REQUIRE_APPROVAL (exit 2) + no enforce knob
#   -> advisory, rc 0 (proceed, no wait). This is the unchanged default.
# ---------------------------------------------------------------------------
echo "Case 1: exit 2 + no enforce knob -> advisory rc 0 (unchanged default)"
D1="$WORK/default"; mk_proj "$D1"
rc1=0
( cd "$D1"
  unset LOKI_POLICY_APPROVAL_ENFORCE 2>/dev/null || true
  STAGED_AUTONOMY="false"
  LOKI_FAKE_POLICY_RC=2; export LOKI_FAKE_POLICY_RC
  check_policy resource ) || rc1=$?
[ "$rc1" -eq 0 ] && ok "case1 default advisory path returns rc 0 (proceeds, no hang)" \
    || bad "case1 default path changed behavior" "rc=$rc1"

# ---------------------------------------------------------------------------
# Case 2: exit 2 + enforce + POLICY_APPROVED pre-created -> rc 0 (continue).
# ---------------------------------------------------------------------------
echo "Case 2: exit 2 + enforce + POLICY_APPROVED -> rc 0 (approved continue)"
D2="$WORK/approve"; mk_proj "$D2"
mkdir -p "$D2/.loki/signals"; : > "$D2/.loki/signals/POLICY_APPROVED"
rc2=0
( cd "$D2"
  LOKI_POLICY_APPROVAL_ENFORCE=1; export LOKI_POLICY_APPROVAL_ENFORCE
  STAGED_AUTONOMY="false"
  LOKI_FAKE_POLICY_RC=2; export LOKI_FAKE_POLICY_RC
  check_policy resource ) || rc2=$?
[ "$rc2" -eq 0 ] && ok "case2 enforce+approved -> rc 0" || bad "case2 enforce+approved" "rc=$rc2"

# ---------------------------------------------------------------------------
# Case 3: exit 2 + enforce + POLICY_REJECTED pre-created -> rc 1 (deny).
# ---------------------------------------------------------------------------
echo "Case 3: exit 2 + enforce + POLICY_REJECTED -> rc 1 (operator deny)"
D3="$WORK/reject"; mk_proj "$D3"
mkdir -p "$D3/.loki/signals"; : > "$D3/.loki/signals/POLICY_REJECTED"
rc3=0
( cd "$D3"
  LOKI_POLICY_APPROVAL_ENFORCE=1; export LOKI_POLICY_APPROVAL_ENFORCE
  STAGED_AUTONOMY="false"
  LOKI_FAKE_POLICY_RC=2; export LOKI_FAKE_POLICY_RC
  check_policy resource ) || rc3=$?
[ "$rc3" -eq 1 ] && ok "case3 enforce+rejected -> rc 1 (deny)" || bad "case3 enforce+rejected" "rc=$rc3 (want 1)"

# ---------------------------------------------------------------------------
# Case 4: plain DENY (exit 1) -> rc 1 regardless of knob.
# ---------------------------------------------------------------------------
echo "Case 4: exit 1 (plain DENY) -> rc 1"
D4="$WORK/deny"; mk_proj "$D4"
rc4=0
( cd "$D4"
  unset LOKI_POLICY_APPROVAL_ENFORCE 2>/dev/null || true
  STAGED_AUTONOMY="false"
  LOKI_FAKE_POLICY_RC=1; export LOKI_FAKE_POLICY_RC
  check_policy resource ) || rc4=$?
[ "$rc4" -eq 1 ] && ok "case4 plain DENY -> rc 1" || bad "case4 plain DENY" "rc=$rc4 (want 1)"

# ---------------------------------------------------------------------------
# Case 5: ALLOW (exit 0) -> rc 0.
# ---------------------------------------------------------------------------
echo "Case 5: exit 0 (ALLOW) -> rc 0"
D5="$WORK/allow"; mk_proj "$D5"
rc5=0
( cd "$D5"
  unset LOKI_POLICY_APPROVAL_ENFORCE 2>/dev/null || true
  STAGED_AUTONOMY="false"
  LOKI_FAKE_POLICY_RC=0; export LOKI_FAKE_POLICY_RC
  check_policy resource ) || rc5=$?
[ "$rc5" -eq 0 ] && ok "case5 ALLOW -> rc 0" || bad "case5 ALLOW" "rc=$rc5"

# ---------------------------------------------------------------------------
echo
echo "approval-phase-gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
