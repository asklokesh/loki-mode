#!/usr/bin/env bash
#==============================================================================
# A5: ALLOWED_PATHS + command-allow enforcement (HONESTLY SCOPED).
# Covers the sandbox.sh enforcement helpers _sandbox_path_within_allowed and
# _sandbox_command_allowed -- the ONLY place ALLOWED_PATHS is consumed.
#
# Honesty boundary under test: these guard run.sh-controlled surfaces (the
# sandbox custom --mount and the operator-supplied `loki sandbox run` argv).
# They do NOT (and cannot) restrict provider-driven agent writes; that is the
# container's job. The tests assert the enforced surfaces only.
#
# NOTE: run.sh has no enforcement helper of its own. A run.sh-local
# loki_path_within_allowed once existed but had zero call sites and was removed;
# this test deliberately does NOT reference it.
#==============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBX="$REPO/autonomy/sandbox.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-a5-XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"   # de-symlink for realpath comparisons
trap 'rm -rf "$WORK"' EXIT

log_warn(){ :; }; log_info(){ :; }; log_error(){ :; }; audit_log(){ :; }

# sandbox.sh helpers: source the file with the trailing `main "$@"` removed.
grep -v '^main "\$@"$' "$SBX" > "$WORK/sandbox_src.sh"
# shellcheck disable=SC1090
source "$WORK/sandbox_src.sh" 2>/dev/null || true
set +e

mkdir -p "$WORK/allowed/sub" "$WORK/forbidden"

pass=0; fail=0
ck(){ if [ "$1" = "$2" ]; then echo "  [PASS] $3"; pass=$((pass+1)); else echo "  [FAIL] $3 (rc=$1 want $2)"; fail=$((fail+1)); fi; }

echo "A5: ALLOWED_PATHS + command-allow enforcement"
echo "============================================="
echo "sandbox.sh _sandbox_path_within_allowed:"
unset LOKI_ALLOWED_PATHS
_sandbox_path_within_allowed "$WORK/forbidden"; ck "$?" "0" "unset allowlist -> allow (default unchanged)"
export LOKI_ALLOWED_PATHS="$WORK/allowed"
_sandbox_path_within_allowed "$WORK/allowed/sub"; ck "$?" "0" "inside allowlist -> allow"
_sandbox_path_within_allowed "$WORK/forbidden"; ck "$?" "1" "outside allowlist -> block (custom --mount would be refused)"
_sandbox_path_within_allowed "$WORK/allowed/../forbidden/x"; ck "$?" "1" "../ traversal escape -> block"
_sandbox_path_within_allowed "$WORK/allowed/not-yet-created"; ck "$?" "0" "not-yet-created path under allowed -> allow"
unset LOKI_ALLOWED_PATHS

echo "sandbox.sh _sandbox_command_allowed:"
_sandbox_command_allowed "npm run build"; ck "$?" "0" "benign command -> allow"
_sandbox_command_allowed "sudo rm -rf / x"; ck "$?" "1" "rm -rf / -> block (default list)"
export LOKI_BLOCKED_COMMANDS="curl evil"
_sandbox_command_allowed "curl evil.example.com"; ck "$?" "1" "custom-blocked pattern -> block"
_sandbox_command_allowed "echo safe"; ck "$?" "0" "not in custom list -> allow"
unset LOKI_BLOCKED_COMMANDS

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
